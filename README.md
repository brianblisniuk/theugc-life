# theugc.life

The operating system for travel UGC creators.

**Core V1 is built, audited and closed.** The repository contains a working
product, not a foundation: a canonical hotel/contact/evidence data architecture
with a staging → review → promotion workflow, a 30-property Dubai canonical
pilot in production, Discover and Hotel Detail, Save to Pipeline, the full
outreach CRM (transitions, event ledger, negotiation, deal won, collaboration
lifecycle), rebuildable hotel intelligence with a privacy-safe public
projection, and an explicit database privilege contract that replay and
production both satisfy.

**The current phase is Product Experience.** The Visual Direction Gate has
passed: Visual Direction V1 is **A2 — Sunlit Creator OS**, with **Sun `#FFE01B`**
as the approved primary accent. Sprint 3A implements it on Discover + map.
Typography is still open, and photography and map coordinates each need a
product/data decision before they can ship — see
[`docs/VISUAL_DIRECTION.md`](docs/VISUAL_DIRECTION.md).

| Question                                       | Where it is answered                                                                                                 |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| What is the product?                           | [`docs/PRD.md`](docs/PRD.md) §1                                                                                      |
| What is already built?                         | [`docs/PRD.md`](docs/PRD.md) §30.0, [`docs/audits/CORE_V1_AUDIT_CLOSEOUT.md`](docs/audits/CORE_V1_AUDIT_CLOSEOUT.md) |
| What phase are we entering?                    | [`docs/PRD.md`](docs/PRD.md) §30.0 — **Sprint 3 = Product Experience**                                               |
| What does A2 mean, and what is locked vs open? | [`docs/VISUAL_DIRECTION.md`](docs/VISUAL_DIRECTION.md)                                                               |
| What is explicitly out of Sprint 3A scope?     | [`docs/VISUAL_DIRECTION.md`](docs/VISUAL_DIRECTION.md) §23                                                           |
| Why is a decision the way it is?               | [`docs/DECISIONS.md`](docs/DECISIONS.md)                                                                             |

> The product specification in [`docs/`](docs/) is the source of truth.
> `docs/PRD.md` is the master; the other docs add implementation detail and must
> not contradict it. Where the PRD's original sprint plan disagrees with what was
> actually built, [`docs/PRD.md`](docs/PRD.md) §30.0 describes reality.

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

| Script                        | Purpose                                      |
| ----------------------------- | -------------------------------------------- |
| `npm run dev`                 | Start the dev server                         |
| `npm run build`               | Production build (Vercel-compatible)         |
| `npm run start`               | Serve the production build                   |
| `npm run lint`                | ESLint (Next core-web-vitals + TypeScript)   |
| `npm run typecheck`           | `tsc --noEmit` (strict)                      |
| `npm run test`                | Vitest (unit + RLS suites)                   |
| `npm run db:migrate`          | Apply SQL migrations to `DATABASE_URL`       |
| `npm run import:inspect`      | Inspect a source file's structure (no DB)    |
| `npm run import:stage`        | Parse/normalize/validate into staging tables |
| `npm run import:dry-run`      | Stage + resolve + write review reports       |
| `npm run import:report`       | Regenerate reports for a staged batch        |
| `npm run import:review-apply` | Apply a reviewed manifest to a staged batch  |
| `npm run import:promote`      | Promote reviewed rows to canonical records   |
| `npm run destination:*`       | Destination catalog list/upsert/alias        |

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
  components/             Shells, nav, forms, primitives, hotel + pipeline UI
  lib/                    supabase clients, auth guards, hotels, pipeline,
                          intelligence, billing, import, analytics, logger, config
  env.ts                  Zod-validated environment (client/server split)
  middleware.ts           Session refresh + route protection
scripts/
  apply-migrations.ts     Dependency-light migration applier
  import/                 Import + destination-catalog CLIs
tests/
  db/                     DB harness + Supabase-compat bootstrap
  auth/ rls/              Session role resolution, RLS, ACL contract
  hotels/ pipeline/ intelligence/ billing/ import/   Feature suites
  smoke/                  Non-DB unit tests
```

## Seed data import

A secure, auditable import pipeline turns hotel/contact research into reviewable
staging data, and promotes it to canonical records only after explicit human
review. It never seeds creator intelligence (see
[`docs/IMPORT_SPEC.md`](docs/IMPORT_SPEC.md),
[`docs/HOTEL_DATA_CONTRACT.md`](docs/HOTEL_DATA_CONTRACT.md),
[`docs/CANONICAL_PROMOTION_SPEC.md`](docs/CANONICAL_PROMOTION_SPEC.md)).

- **Standard importer** (durable): CSV/XLSX in the canonical contract
  (`properties` / `contacts` / optional `evidence`). This is the format all
  future research should use.
- **Legacy adapters** (one-time, isolated under `scripts/import/legacy/`):
  translate the current messy spreadsheets/Markdown into the same canonical
  staging. Their quirks never reach canonical schema.
- **Pipeline**: raw → staging → validation → conservative, explainable entity
  resolution → dry-run JSON/Markdown reports → reviewed manifest → idempotent
  canonical promotion.

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

**Core V1 — audited and closed.** No P0 or P1 is open; remaining debt is recorded
in [`docs/audits/CORE_V1_AUDIT_CLOSEOUT.md`](docs/audits/CORE_V1_AUDIT_CLOSEOUT.md).
Production migrations are exact through `0025`.

Built: foundation and hardening (Sprint 0/0.1) · import foundation, destination
catalog, canonical promotion and the Dubai pilot (Sprint 1A–1C) · Discover,
Hotel Detail, Save to Pipeline, pipeline transitions and the outreach event
ledger, negotiation → won → collaboration, hotel intelligence aggregation,
collaboration lifecycle, and the explicit ACL contract (Sprint 2A–2G).

Next: **Sprint 3 — Product Experience**, starting with Sprint 3A (Discover +
map) against Visual Direction V1. Two prerequisites are unresolved and must not
be improvised: the hotel **media/photography** data and provenance contract, and
**canonical coordinate coverage** for the map
([`docs/VISUAL_DIRECTION.md`](docs/VISUAL_DIRECTION.md) §21).

One product contract is open and needs an owner decision before it is sold or
rendered: commercial copy promises _premium intelligence_ to paid plans, but the
built system exposes one privacy-safe projection to every browser role and gates
**contacts**, not intelligence ([`docs/PRD.md`](docs/PRD.md) §12.8.1).
