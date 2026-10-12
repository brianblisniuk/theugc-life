# Launch checklist

**Status:** Not a launch candidate. E05 records the gate. None of the owner steps below are done. Each one needs Brian’s approval before anyone treats a deployment as production.

This checklist does not deploy, does not change a production database, does not send email, and does not turn on Rebill.

## What this repository already checks

- `verify` is green on the exact pull-request head (ruleset `24915605`).
- Playwright, against local Supabase and `next start`, covers signup through a revoked hotel share link. Gmail and Maps are mocked. A missing Maps key draws no map and no error.
- A second creator’s direct trip URL is not found. That creator’s pipeline, inbox, collaborations, and profile do not show the first creator’s private rows. An anonymous session is sent to login for `/app` and `/admin`, and a creator who opens `/admin` is sent back to `/app`.
- A revoked Gmail token is an inbox error, not an empty inbox. A retry of that sync does not open another run and does not store a second copy of mail.
- Empty and error stay distinct on Discover, trips, pipeline, inbox, collaborations, and profile.
- `/api/health` returns `{ "status": "ok" }` and nothing else.
- Server logs redact emails, tokens, message bodies, and share tokens. Responses send a request id, a Content-Security-Policy that allows the Maps script origins, `frame-ancestors 'none'`, and `Referrer-Policy: no-referrer`.
- Every public table has row level security enabled. The repo pattern does not force it. Every `SECURITY DEFINER` function is in `tests/security/privileged-function-acl.json`.
- The client bundle scan rejects server secret names. `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` is the one allowed name. The scan does not print its value.

## Owner steps — not done

These stay undone until Brian approves each one. Automation must not perform them.

| Step | State | Approval |
|---|---|---|
| Production Netlify site and environment variables | **NOT done** | Brian |
| Supabase production migrations | **NOT done.** The hosted project has never had these files applied. `0044` failed on that layout while `digest()` could not see pgcrypto in `extensions`. The source now resolves `digest()` for both `extensions` and `public`. Applying the chain to production still needs Brian’s approval. | Brian |
| Google OAuth verification and authorized domain | **NOT done** | Brian |
| Maps key restricted to the production domain | **NOT done** | Brian |
| Rebill | **NOT done** | Brian |

No production site is configured by this block. No production migration has been applied by this block. The end-to-end job applies the same files on local Supabase and does not move pgcrypto out of `extensions`. No Google verification, no Maps key restriction, and no Rebill account are part of this block.
