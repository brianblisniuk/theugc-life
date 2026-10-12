# E04 — Pass/Pro entitlement and access audit

**Status:** Binding work order. One PR. Do not merge.  
**Base:** `main` `fc2dfbd32bf1063dec17d4db16ad84b6311f400c` (merge of PR #60).  
**Branch:** `cursor/e04-entitlement-inventory-3a73`  
**Migration:** none. `0051` is not taken.  
**Decisions:** D083–D085 are not used. No written tier was missing in a way this block had to close. Undecided features are questions, not proposed tiers.

## Question

Is there one canonical inventory that maps every existing module, route, and server action to Free, Destination Pass, or Creator Pro using only rules already written, with server-side enforcement and no cross-user access?

## What this block does

- Adds `src/lib/entitlements/inventory.ts` and `docs/ENTITLEMENTS_INVENTORY.md`.
- Routes the premium hotel helper and the Free workspace limits through that inventory.
- Proves each entry against real Postgres: tier, missing/expired falls back to Free, a Pro row does not open another creator's rows, anon gets nothing, a purchase is not access.

## What it does not do

- No prices, no Rebill, no new limit, no new tier, no UI redesign.
- No new scope, provider, or secret. No model call. No production deploy or production database write.
- No change to D072. No migration.

## Invariants

Authentication is not authorization. Premium reads and workspace limits are enforced in the database from entitlement rows. A failed read is not Free.

## Contradictory gates fixed

None.

## Acceptance

- Every app `page.tsx` and `route.ts` is named by the inventory.
- Every server action is named by the inventory.
- Table-driven tests cover every entry.
- User A with Pro cannot read or alter User B's entitlement rows or other private rows.
- Lint, typecheck, full Vitest, and build pass. CI `verify` is green on the PR head.
