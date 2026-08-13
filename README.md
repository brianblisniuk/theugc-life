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

| Script                   | Purpose                                      |
| ------------------------ | -------------------------------------------- |
| `npm run dev`            | Start the dev server                         |
| `npm run build`          | Production build (Vercel-compatible)         |
| `npm run start`          | Serve the production build                   |
| `npm run lint`           | ESLint (Next core-web-vitals + TypeScript)   |
| `npm run typecheck`      | `tsc --noEmit` (strict)                      |
| `npm run test`           | Vitest (unit + RLS suites)                   |
| `npm run db:migrate`     | Apply SQL migrations to `DATABASE_URL`       |
| `npm run import:inspect` | Inspect a source file's structure (no DB)    |
| `npm run import:stage`   | Parse/normalize/validate into staging tables |
| `npm run import:dry-run` | Stage + resolve + write review reports       |
| `npm run import:report`  | Regenerate reports for a staged batch        |

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

## Seed data import (Sprint 1A)

A secure, auditable seed-import pipeline turns hotel/contact research into
reviewable staging data — it never writes canonical hotels/contacts and never
seeds creator intelligence (see [`docs/IMPORT_SPEC.md`](docs/IMPORT_SPEC.md),
[`docs/HOTEL_DATA_CONTRACT.md`](docs/HOTEL_DATA_CONTRACT.md)).

- **Standard importer** (durable): CSV/XLSX in the canonical contract
  (`properties` / `contacts` / optional `evidence`). This is the format all
  future research should use.
- **Legacy adapters** (one-time, isolated under `scripts/import/legacy/`):
  translate the current messy spreadsheets/Markdown into the same canonical
  staging. Their quirks never reach canonical schema.
- **Pipeline**: raw → staging → validation → conservative, explainable entity
  resolution → dry-run JSON/Markdown reports. No canonical promotion in 1A.

```bash
# Look at a file's structure (no DB)
npm run import:inspect -- --file data/imports/raw/research.xlsx

# Stage + dry-run a canonical workbook (writes gitignored reports)
DATABASE_URL="postgres://…" npm run import:dry-run -- --file data/imports/raw/research.xlsx

# Dry-run a legacy file through its isolated adapter
DATABASE_URL="postgres://…" npm run import:dry-run -- \
  --file data/imports/raw/dubai.xlsx --adapter dubai-broad
```

Real source files and reports live under `data/imports/{raw,reports}/` and are
**gitignored**. Automated tests use synthetic fixtures only.

## Status

Sprint 0/0.1 (foundation + hardening) and **Sprint 1A** (import foundation) are
in place. Sprint 1A stops before canonical bulk promotion — do not promote seed
data or build discovery/CRM/payment surfaces without review. See
[`docs/SPRINT_1_PROMPT.md`](docs/SPRINT_1_PROMPT.md) for the Definition of Done.
