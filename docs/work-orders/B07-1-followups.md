# B07.1 — B07 slice 1 non-blocking audit follow-ups

**Status:** Binding work order for this PR.
**Base:** `main` `161e4c0d7694b3e12b3b496c1393037b2d0e57a5`
**Branch:** `fix/b07-1-followups`
**Migration:** `0045_gmail_commercial_meaning_followups.sql` (next free number on that base). `0044` is not edited.
**One PR. Do not merge.**

Sources of truth, in order: D072, D074, `docs/B07_GMAIL_COMMERCIAL_MEANING_CONTRACT.md`, the PR #50 re-audit of `7abad11d231132f7e33cf5f158d43db155dca647`. This work order does not add product semantics.

## Principal question

Can a service-role commit store `agreement_observed` for a one-sided accept, and can a creator read keep presenting a machine interpretation after the B06 classification it was bound to has changed in place?

## Locked semantics

D072 is unchanged.

- `agreement_observed` requires both-party evidence. A one-sided accept stays `negotiating`.
- The database does not trust a caller boolean. The stored eligible body must match the same explicit booking-confirmation phrases the rules engine uses, together with an `agreement` signal, an earlier creator-sent message, and no later eligible rejection. Otherwise the commit raises `check_violation` and writes nothing.
- A quoted booking phrase is not authored confirmation.
- An in-place B06 classification or chronology change (class, classification version, relation version, text-transform version, observation identity, or loss of B06 currentness), with no new B07 commit, makes the bound machine interpretation stale on creator read. The read persists `stale` on the message and thread current rows. Historical attempts and creator decisions stay.
- Machine interpretation is not human truth. `redirect` is not rejection. Unknown compensation is not unpaid.

## In scope

- `supabase/migrations/0045_gmail_commercial_meaning_followups.sql` replacing the commit and creator-read functions
- Regression tests that fail on `0044` alone
- Tracker, autopilot state, and this work order, in this PR

## Out of scope

- Any other B07 behavior, B08, UI, model inference, provider calls, price changes, Rebill, production deploy, production database mutation

## Invariants preserved

- Authentication is not authorization. Existing A/B isolation and the privileged-function ACL matrix stay green.
- New helpers are not `SECURITY DEFINER`. Execute is revoked from `public`, `anon`, `authenticated`, and `service_role`.
- Replaced public functions keep `search_path = public, private, pg_temp` and the existing role split.
- Human decision rows are not deleted or rewritten when a B06 fingerprint drifts.
