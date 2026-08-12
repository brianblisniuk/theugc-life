# theugc.life

The operating system for travel UGC creators.

This repository is at **Sprint 0 — Foundation**. It contains a secure,
reproducible base: Next.js App Router + TypeScript (strict), Supabase schema +
Row Level Security, authentication, application shells, an analytics/logging
foundation, and tests. Product surfaces (discovery, CRM, intelligence, payments,
etc.) arrive in later sprints — see [`docs/PRD.md`](docs/PRD.md) §30.

> The product specification in [`docs/`](docs/) is the source of truth.
> `docs/PRD.md` is the master; the other docs add implementation detail and must
> not contradict it.

## Stack

- **Next.js** (App Router) + **React 19** + **TypeScript** (strict)
- **Tailwind CSS v4** with semantic design tokens
- **Supabase** (PostgreSQL, Auth, RLS) via `@supabase/ssr`
- **PostHog** (or an approved equivalent) behind a provider abstraction
- **Vitest** for unit + RLS/permission tests

## Prerequisites

- Node.js ≥ 20
- A Supabase project (for running the app), or just PostgreSQL 16 (for tests)

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env.local
# then fill in NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
# SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SITE_URL

# 3. Run the dev server
npm run dev
# http://localhost:3000
```

## Database migrations

Migrations are versioned SQL in [`supabase/migrations/`](supabase/migrations),
applied in filename order and reproducible from an empty database.

**Option A — Supabase CLI (canonical):**

```bash
supabase start           # local stack (requires Docker)
supabase db reset        # applies all migrations to the local database
```

**Option B — direct applier (no Docker/CLI needed):**

```bash
# Apply to any Postgres reachable via DATABASE_URL
DATABASE_URL="postgres://…" npm run db:migrate

# Against a plain (non-Supabase) Postgres, add the Supabase-compat bootstrap
# (auth schema, roles, auth.uid()) first:
DATABASE_URL="postgres://…" npm run db:migrate -- --bootstrap
```

The signup trigger (`handle_new_user`) provisions a `public.users` row (role
forced to `creator`) and a `creator_profiles` row for every new auth user, so a
client can never assign itself a privileged role.

## Scripts

| Script               | Purpose                                    |
| -------------------- | ------------------------------------------ |
| `npm run dev`        | Start the dev server                       |
| `npm run build`      | Production build (Vercel-compatible)       |
| `npm run start`      | Serve the production build                 |
| `npm run lint`       | ESLint (Next core-web-vitals + TypeScript) |
| `npm run typecheck`  | `tsc --noEmit` (strict)                    |
| `npm run test`       | Vitest (unit + RLS suites)                 |
| `npm run db:migrate` | Apply SQL migrations to `DATABASE_URL`     |

## Testing

- **Unit/smoke tests** always run: route protection, role gating, analytics
  sanitization, log redaction, confidence gating.
- **RLS/permission tests** run against a real Postgres. Set `TEST_DATABASE_URL`;
  the harness resets the schema, applies the Supabase-compat bootstrap + all
  migrations, then probes policies by impersonating roles/users. When
  `TEST_DATABASE_URL` is unset, these suites skip cleanly.

```bash
# Example: run the full suite against a local Postgres
TEST_DATABASE_URL="postgres://postgres:postgres@localhost:5432/postgres" npm test
```

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs lint,
typecheck, build, and the full test suite (with a Postgres service) on every
push/PR.

## Security foundations

- RLS enabled on every application table; ownership/entitlement enforced in the
  database, not the UI ([`docs/PERMISSIONS.md`](docs/PERMISSIONS.md)).
- The service-role key is server-only (`server-only` guard) and never bundled
  for the browser.
- Clients cannot assign their own role or create paid entitlements.
- `/admin` is gated by a server-side role check (not hidden UI).
- Structured logs and analytics payloads redact secrets and private notes.

## Project layout

```
docs/                     Product spec (source of truth)
supabase/
  config.toml             Supabase project config
  migrations/             Versioned SQL (reproducible from empty DB)
src/
  app/                    App Router: (public) (auth) (app) admin
  components/             Shells, nav, forms, primitives
  lib/                    supabase clients, auth guards, analytics, logger, config
  env.ts                  Zod-validated environment (client/server split)
  middleware.ts           Session refresh + route protection
scripts/apply-migrations.ts   Dependency-light migration applier
tests/
  db/                     RLS harness + Supabase-compat bootstrap
  rls/                    RLS/permission tests
  smoke/                  Non-DB unit tests
```

## Status

Sprint 0 only. Do not proceed to Sprint 1 without review. See
[`docs/SPRINT_0_PROMPT.md`](docs/SPRINT_0_PROMPT.md) for the Definition of Done.
