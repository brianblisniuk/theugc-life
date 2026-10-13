# F04 — Home next actions

**Status:** Binding work order for this PR. Awaiting CI. Do not merge.
**Base:** `main` `b8752e31ee4e51971390ebbf260062186f689a92` (merge of PR #70).
**Branch:** `cursor/f04-home-next-actions-39db`.
**PR:** #73. Do not merge.
**Migration:** `0066_home_next_actions.sql`. No new table. `0063`–`0065` are not this file. `0061` and `0062` are not edited.
**Decision:** D112.

One PR for canon v1.1 F04. Agency F04 stays planned and is a different block.

## Principal question

Which of the creator's own pipeline rows, due follow-ups, due deliverables, credit balance, and pending Gmail suggestions should Home show first, without a score and without a new table?

## Sources

Canon v1.1 F04 and §2.5. PRD §7.1. D095, D100, D101, D105, D107, D108.

## In scope

- A fixed order over rows the signed-in creator owns.
- Gmail suggestions only through `list_own_pending_gmail_collaboration_suggestions`. Free returns `paused` and no ids. Pro and an active Destination Pass use the D107 predicate.
- The credit balance, including the D105 sentence when it is below the unlock cost. No billing link.
- Catalog samples for the next trip, or the onboarding destination when there is no upcoming trip. Labeled as the published catalog, not a ranking.
- User A / User B tests for the order and for the list function.

## Out of scope

Sending mail. An AI vendor. Confirming or dismissing a suggestion. Hotel ranking (F03, H01). Pitch templates (F02). A new table. Credit amounts (D101). Changing the D107 paid predicate. Merging this PR.

## Invariants

- Authentication is not authorization.
- A failed read is not an empty list and not zero credits.
- A paused Gmail read contributes no suggestion id.
- Home does not write pipeline status, outreach events, or suggestion rows.
