# E03 — Onboarding and empty/error states

**Status:** Binding work order for this PR. Awaiting independent audit. Do not merge.  
**Base:** `main` `6b59318bbe33897a5204f42fa2292eccaf6d13a7` (merge of PR #58, D06)  
**Branch:** `cursor/e03-onboarding-empty-states-c2d6`  
**Migration:** none. Progress is derived. `0051` is not used. D081 is reserved for parallel E02.

One PR for the whole block, including the tracker and autopilot state. Do not merge.

## Principal question

How does a new creator reach a first useful flow — connect Gmail, create a trip, save a hotel, open the pipeline — and how does every main page tell an empty list from a failure?

## Locked reading used by this implementation

D082 is **Proposed**, not Accepted. It is the simplest reading of the block:

- Profile onboarding stays display name and username, then redirects to `/app`.
- The checklist on Home is derived from `mail_accounts.connection_state = connected`, a trip row, and a pipeline item. Saving a hotel is the pipeline row, so those two steps complete together.
- Gmail stays on `/app/account`. This block does not start OAuth itself and does not request `gmail.send`.
- A failed probe blocks the checklist. It does not say the creator has not connected or has no trip.
- A missing creator profile is a failed read, not an empty trip list.
- When Gmail OAuth is not configured, the Gmail step is omitted.
- Follow-ups are pipeline items with `next_followup_at`. A failed follow-up read is not “nothing is due”.
- `/app/inbox` lists `pipeline_inbox_bindings` for the caller. No message body, no thread id on the page, no send.
- `/app/collaborations` lists `collaborations` for the caller. `private_value_*` is not selected.
- User A’s derived progress and lists drop User B’s rows even if a payload contains them. The database policies are covered by `tests/onboarding/activation-rls.test.ts`.
- Primary navigation is unchanged. E02 owns the shell.

## Out of scope

New OAuth scopes, sending mail, a new provider, a progress table, navigation changes, entitlement changes, and accepting D082.
