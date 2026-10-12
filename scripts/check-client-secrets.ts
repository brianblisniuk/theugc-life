/**
 * Fail when a server secret name, or the CI service-role sentinel, is in the
 * client bundle. NEXT_PUBLIC_GOOGLE_MAPS_API_KEY is the one allowed name.
 * This script never prints a secret value.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FORBIDDEN_CLIENT_IDENTIFIERS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "GOOGLE_OAUTH_CLIENT_SECRET",
  "GOOGLE_OAUTH_CLIENT_ID",
  "GMAIL_TOKEN_ENCRYPTION_KEY_V1",
  "GMAIL_TOKEN_ENCRYPTION_KEY",
  "BILLING_WEBHOOK_SECRET",
  "DATABASE_URL",
  "TEST_DATABASE_URL",
] as const;

export const ALLOWED_PUBLIC_SECRET_NAME = "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY";

const SENTINEL = "ci-service-role-key";

export interface BundleFinding {
  file: string;
  identifier: string;
}

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) walk(full, out);
    else if (name.endsWith(".js")) out.push(full);
  }
}

export function scanClientBundle(
  staticDir: string,
  extraForbidden: readonly string[] = [],
): BundleFinding[] {
  const files: string[] = [];
  walk(staticDir, files);
  const extras = extraForbidden.filter((value) => value.length >= 20);
  const findings: BundleFinding[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const identifier of FORBIDDEN_CLIENT_IDENTIFIERS) {
      if (source.includes(identifier)) findings.push({ file, identifier });
    }
    if (source.includes(SENTINEL)) findings.push({ file, identifier: "service_role_sentinel" });
    for (const value of extras) {
      if (source.includes(value)) findings.push({ file, identifier: "extra_forbidden_value" });
    }
    if (source.includes(ALLOWED_PUBLIC_SECRET_NAME)) {
      // The public Maps key name may appear. Its value is never printed.
    }
  }
  return findings;
}

function extraFromEnv(): string[] {
  const raw = process.env.CLIENT_BUNDLE_EXTRA_FORBIDDEN ?? "";
  return raw
    .split("\n")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function main(): void {
  const staticDir = path.join(process.cwd(), ".next", "static");
  let findings: BundleFinding[];
  try {
    findings = scanClientBundle(staticDir, extraFromEnv());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      console.error("client bundle scan: .next/static is missing");
      process.exit(process.env.CI ? 1 : 0);
    }
    throw error;
  }
  if (findings.length > 0) {
    for (const finding of findings) {
      console.error(
        `client bundle contains forbidden identifier ${finding.identifier} in ${finding.file}`,
      );
    }
    process.exit(1);
  }
}

const invoked = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) main();
