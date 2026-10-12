# E05 — E2E, observability, security/privacy QA, launch checklist

**Status:** Binding work order. D092–D094 are Proposed. Do not merge.  
**Base:** `main` `1fc15658fc69acaa799860f8340736e15e1f5728` (merge of PR #63, D09).  
**Branch:** `cursor/e05-e2e-observability-launch-f88c`  
**PR:** #64  
**Decisions:** D092, D093, D094 — Proposed. D089–D091 stay Accepted. D082 stays Proposed.  
**Migration:** `0054_grant_handle_new_user_to_auth_admin.sql`. When `supabase_auth_admin` exists, it grants that role `USAGE` on `public` and `EXECUTE` on `handle_new_user()`. No new table and no new security-definer function.

One PR for the whole block, including this work order and the state files. Do not merge.

## Principal question

What has to be true, in an automated run and on a written gate, before anyone calls this a launch candidate?

## Sources

Tracker E05 row. PRD. D079–D091. `docs/PERMISSIONS.md`, `docs/ENTITLEMENTS_INVENTORY.md`, `docs/ROUTES.md`, `docs/EVENTS.md`. The block prompt.

## Locked reading

- Playwright runs in CI against local Supabase and `next start`. The browser may talk only to this machine. Gmail is a seeded fixture thread. Maps has no key, so Hotel Detail renders no map and no error.
- The journey is signup, onboarding, Discover, hotel detail, a trip, a pipeline item, a linked fixture thread, an agreement, a deliverable, a profile, a hotel share link, and a revoke. A revoked `/p/[token]` shows the same not-available page as an unknown token.
- User B opening User A’s trip URL gets not found. User B’s pipeline, inbox, collaborations, and profile do not show User A’s private rows. Anonymous sessions get nothing on protected routes. The share page shows only the field the creator turned on.
- A revoked Gmail token with no links is an inbox error, not an empty list. A second sync while that token is revoked does not insert another sync run and does not store mail. Empty and error stay distinct on the lists D082 already separated.
- Logs are structured JSON. Emails, bearer tokens, message bodies, and share tokens are redacted. `/api/health` is `{ "status": "ok" }` only.
- Public tables have RLS enabled and not forced, matching the existing migrations. Every security-definer function is in the ACL matrix. No new security-definer function is added.
- `docs/LAUNCH_CHECKLIST.md` lists production Netlify, production Supabase migrations, Google OAuth verification, Maps key domain restriction, and Rebill as **not done** and requiring Brian’s approval.

## In scope

The journey, the two-creator and anonymous checks, the revoked-token retry, the log helper, health, headers, the ACL and RLS checks, the client-bundle scan, and the launch checklist. Migration `0054` only grants the existing signup trigger to `supabase_auth_admin`.

## Out of scope

Sentry or any other monitoring vendor. Production deploy. Production database changes. Real Gmail or email. Payments. A UI redesign. New OAuth scopes. A new secret. A new security-definer function. Forcing row level security.
