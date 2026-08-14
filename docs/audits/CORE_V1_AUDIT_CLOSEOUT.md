# Core V1 Audit Closeout

Date: 2026-08-14

Status: **CORE V1 — AUDITED AND CLOSED**

This document is the final closeout record for the pre-Sprint-3 audit and Sprint 2G hardening. It supplements, rather than rewrites, `PRE_SPRINT3_CORE_AUDIT.md`.

## Final implementation baseline

- Core implementation main SHA before this documentation-only closeout: `9fd843184e1113626f652004f687e6bccf0373a0`.
- PR #14 merged the audited hardening work.
- PR #15 added immutable migration `0025` after hosted production revealed one relation-ACL difference that a clean replay did not reproduce.
- PR #16 corrected the undeployed `0025` before its successful production deployment, after a fully transactional failed attempt showed that application-role `postgres` cannot alter platform-owned `supabase_admin` default privileges.

## Production migration state

Production migration ledger is exact through:

- `0023` — `collaboration_lifecycle`
- `0024` — `explicit_acl_contract`
- `0025` — `service_role_view_acl_convergence`

Migrations `0001`–`0023` remain unchanged.

## Production verification

After `0024` + `0025`:

- Declared relation ACL matrix vs production: **0 differences**.
- `public` application tables: **36**.
- Tables with RLS enabled: **36/36**.
- Public RLS policies: **51**.
- `postgres` default ACL entries that would automatically grant future objects to `anon` or `authenticated`: **0**.
- `hotel_public_intelligence` for `service_role`: **SELECT only**; INSERT/UPDATE/DELETE/TRUNCATE are false.
- Critical workflow/intelligence RPCs remain non-executable by `anon` and `authenticated`, executable by `service_role`, with pinned `search_path`.
- `save_hotel_to_pipeline` remains the intentional SECURITY DEFINER exception; the later workflow/intelligence RPCs remain SECURITY INVOKER.

Persistent data counts were unchanged by the hardening deployment:

- hotels: 30
- users: 0
- creator_profiles: 0
- pipeline_items: 0
- outreach_events: 0
- collaborations: 0
- hotel_intelligence: 0
- destination_intelligence: 0

No synthetic production user or workflow data was created for verification.

## Post-deploy convergence note

`0024` successfully normalized all current client relation ACLs and revoked automatic `anon`/`authenticated` defaults for application objects created by the `postgres` migration role.

Hosted production additionally retained an older broad `service_role` grant on `hotel_public_intelligence`. A clean replay did not have that inherited grant, so the first production comparison found one mismatch. Because `0024` had already been deployed, it was not rewritten. `0025` immutably resets that view to the declared SELECT-only contract.

Production also exposes platform-owned `pg_default_acl` entries under `supabase_admin`. These are Supabase internals, are not modifiable by the application migration role, and do not govern application objects created by the repository's migrations. The application default-privilege contract is therefore scoped to the role that owns/creates application objects (`postgres`).

## Security advisor

Post-deploy advisor produced no new Sprint 2G / `0024` / `0025` finding.

The previously accepted findings remain unchanged:

- `hotel_public_intelligence` definer-rights view warning/error — intentional current public privacy projection.
- `citext` extension in `public`.
- Self-scoped SECURITY DEFINER helper wrappers from 0010 callable by client roles, as required by current RLS architecture.

These are recorded debt/accepted architecture, not newly introduced findings.

## Remaining non-blocking debt

The audit recommendation remains **B — CORE AUDIT PASSED WITH NON-BLOCKING DEBT**.

Notable deferred items include:

- Some cross-table deal/collaboration invariants are enforced by the trusted RPC mutation boundary rather than structural database constraints.
- Account deletion remains blocked until intelligence recomputation-on-deletion is designed.
- Intelligence refresh remains best-effort and in-band.
- Discover exact counts may need scale work later.
- `users.status` has no product-defined session-blocking semantics yet.

None of these blocks Sprint 3 product-experience work.

## Final gate

No P0 is open.

No P1 is open.

The Core V1 engine is approved as the stable functional foundation for the next phase:

**Visual Direction Gate → Sprint 3 Product Experience.**
