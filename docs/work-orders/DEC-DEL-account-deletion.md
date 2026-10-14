# DEC-DEL — Account deletion

**Status:** Binding work order for this PR. Awaiting audit. Do not merge.
**Base:** `main` `4b9f70aaa2d15d955e6633581eae8a2c5833f33a` (merge of PR #83).
**Branch:** `cursor/dec-del-account-deletion-8e3c`.
**PR:** #85. Do not merge.
**Migrations:** `0088_account_deletion.sql`. `0080`–`0087` are not edited.
**Decisions:** D151–D155.

## Principal question

How does an authenticated creator ask for account deletion so that personal data is gone within 30 days, while identifier-free aggregates that the product already stores stay, and User A's deletion cannot touch User B?

## Sources

Brian, 2026-10-14. D151–D155. The existing Gmail deletion request, purge functions, share-link revoke, and credit ledger. PRD §11.13.

## In scope

- A confirm step on `/app/account` for a creator. The phrase is `DELETE`.
- `deletion_requested_at` and `delete_after`, with `delete_after` exactly 30 days later.
- A hard-delete function and `npm run account:erase-due`. The job removes that creator's personal rows.
- Immediate stop of Gmail sync, stored OAuth material, share links, assistant drafts, and a positive credit balance.
- Real-Postgres proof that User B's rows remain and that a stored hotel counter is not rewritten.
- RLS and `SECURITY DEFINER` functions with `search_path = ''`, revoked from `public` and `anon`.
- The existing deferred Gmail credential check runs as its owner so a creator's request can commit. The check still does not return a token.

## Out of scope

Production deploy, production Supabase, real charges, and real email. Hunter. Gmail send and follow-ups. Credit prices, Rebill live mode, and plan entitlements. Rewriting network intelligence SQL. Calling Google to revoke a token. A user-facing cancel of a scheduled deletion. Merging this PR.

## Invariants

- Authentication is not authorization. The request function takes no user id. Erasure refuses a signed-in `auth.uid()`.
- Unknown is not zero. A zero credit balance does not invent a ledger row. Personal compensation is not copied into an anonymous total.
- Identifier-free counters stay at the numbers they already hold.
- Editorial append-only reviewer evidence is not rewritten.
- No secrets in the repository. The operator script prints a result and a count.
