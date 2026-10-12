#!/usr/bin/env bash
# Local Supabase + next start + Playwright. No external network from the browser.
# This script does not print API keys, the service role, or the encryption key.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Starting local Supabase. Migrations apply on this image. pgcrypto stays in extensions."
npx supabase start \
  --exclude studio,imgproxy,edge-runtime,logflare,vector,mailpit,storage-api,postgres-meta,supavisor \
  --yes

status_file="$(mktemp)"
npx supabase status -o env >"$status_file"
set -a
# shellcheck disable=SC1090
source "$status_file"
set +a
rm -f "$status_file"

: "${API_URL:?API_URL missing from supabase status}"
: "${ANON_KEY:?ANON_KEY missing from supabase status}"
: "${SERVICE_ROLE_KEY:?SERVICE_ROLE_KEY missing from supabase status}"
: "${DB_URL:?DB_URL missing from supabase status}"

echo "Seeding the published catalog."
DB_URL="$DB_URL" node --input-type=module <<'EOF'
import { readFileSync } from "node:fs";
import pg from "pg";
const client = new pg.Client({ connectionString: process.env.DB_URL });
await client.connect();
await client.query(readFileSync("e2e/seed.sql", "utf8"));
await client.end();
EOF

echo "Rebuilding Next against local Supabase. The Maps key stays unset."
# The verify job already built with the dummy Supabase URL. Drop that output
# so NEXT_PUBLIC_* is inlined from this environment.
rm -rf .next
export NEXT_PUBLIC_SUPABASE_URL="$API_URL"
export NEXT_PUBLIC_SUPABASE_ANON_KEY="$ANON_KEY"
export NEXT_PUBLIC_SITE_URL="http://127.0.0.1:3000"
export SUPABASE_SERVICE_ROLE_KEY="$SERVICE_ROLE_KEY"
unset NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || true
npm run build

echo "Installing Playwright Chromium."
npx playwright install --with-deps chromium

enc_key="$(openssl rand -base64 32)"
export GOOGLE_OAUTH_CLIENT_ID="e2e-oauth-client"
export GOOGLE_OAUTH_CLIENT_SECRET="e2e-oauth-secret"
export GOOGLE_OAUTH_REDIRECT_URI="http://127.0.0.1:3000/auth/callback"
export GMAIL_TOKEN_ENCRYPTION_KEY_V1="$enc_key"
unset enc_key

npm run start -- --hostname 127.0.0.1 --port 3000 >/tmp/e2e-next.log 2>&1 &
next_pid=$!
cleanup() {
  kill "$next_pid" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Waiting for /api/health."
ready=0
for _ in $(seq 1 60); do
  if curl -sf "http://127.0.0.1:3000/api/health" >/dev/null; then
    ready=1
    break
  fi
  sleep 2
done
if [[ "$ready" -ne 1 ]]; then
  echo "next start did not become healthy"
  exit 1
fi

export E2E_DATABASE_URL="$DB_URL"
npx playwright test

echo "Scanning the rebuilt client bundle."
export CLIENT_BUNDLE_EXTRA_FORBIDDEN="$SERVICE_ROLE_KEY"
npm run security:client-bundle
