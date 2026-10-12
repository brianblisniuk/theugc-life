# E04 — Pass/Pro entitlement and access audit

**Status:** Binding work order. One PR. Do not merge.  
**Base:** `main` `d030cd0329c8b1e30afcdd14a72485174edcd9f5` (merge of PR #61, D08).  
**Branch:** `cursor/e04-entitlement-inventory-3a73`  
**PR:** #62  
**Migration:** `0051_outside_free_allowance.sql`. Merged migrations are not edited.  
**Decisions:** D083–D085 are not used. No written tier was missing in a way this block had to close. Undecided features are questions, not proposed tiers.

## Question

Is there one canonical inventory that maps every existing module, route, and server action to Free, Destination Pass, or Creator Pro using only rules already written, with server-side enforcement and no cross-user access?

## What this block does

- Adds `src/lib/entitlements/inventory.ts` and `docs/ENTITLEMENTS_INVENTORY.md`.
- Routes the premium hotel helper and the Free workspace limits through that inventory.
- Proves each entry against real Postgres: tier, missing/expired falls back to Free, a Pro row does not open another creator's rows, anon gets nothing, a purchase is not access.
- Names D08's `updateCreatorProfile` on the existing owner profile write. Personal counts, past collaborations, and field opt-ins stay UNDECIDED. Current behavior is unchanged.

## What it does not do

- No prices, no Rebill, no new limit, no new tier, no UI redesign.
- No new scope, provider, or secret. No model call. No production deploy or production database write.
- No change to D072. No new tier. Merged migrations `0019`, `0021`, and `0046` are not edited.

## Invariants

Authentication is not authorization. Premium reads and workspace limits are enforced in the database from entitlement rows. A failed read is not Free.

## Contradictory gates fixed

`0051_outside_free_allowance.sql`. Outside-coverage Free counters for save, engage, and active trips counted in-destination rows, so a Destination Pass removed the outside Free allowance (D056, PRD §5.2, PERMISSIONS.md §8). They now count only outside-coverage rows.

## Acceptance

- Every app `page.tsx` and `route.ts` is named by the inventory.
- Every server action is named by the inventory.
- Table-driven tests cover every entry.
- User A with Pro cannot read or alter User B's entitlement rows or other private rows.
- Lint, typecheck, full Vitest, and build pass. CI `verify` is green on the PR head.
