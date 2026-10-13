# F01 — Gmail-assisted collaboration detection

**Status:** Binding work order for this PR. Awaiting CI. Do not merge.
**Base:** `main` `85186fdc18f65db9233c5df9155a65674740e551` (merge of PR #68).
**Branch:** `cursor/f01-gmail-collaboration-detection-e7ba`.
**Migration:** `0061_gmail_collaboration_detection.sql`. `0060` is not edited.
**Decision:** D107.

One PR for canon v1.1 F01. Agency F01–F04 stay planned and are a different block.

## Principal question

When a creator has already linked a stored Gmail thread, which pitch, human reply, and collaboration readings may be offered, and what may be written only after that creator confirms?

## Sources

Canon v1.1 F01. D076, D077, D080, D099, D102. B05 outreach status, B06 reply observation, B07 commercial state. The existing manual pipeline transitions.

## In scope

- Suggestion rows for `pitch_sent`, `human_reply`, and `collaboration` on an existing inbox binding.
- Heuristic adapter only. A non-heuristic classifier throws before the database is called.
- Confirm of a pitch or a human reply through the existing manual transition, with the creator's sentiment on a reply.
- Confirm of a collaboration that writes no event, no collaboration, and no hotel fact.
- Manual events win. Dismissed and confirmed rows stay closed.
- The same paid gate as migration 0060. Free refresh, confirm, and read stay paused.
- RLS so User A cannot read or confirm User B's suggestions.
- Deletion purge of suggestions with the mailbox's other Gmail-derived rows.

## Out of scope

Sending mail. A new OAuth scope. An AI vendor (D03 stays undecided). Credits (F05). Agency tenancy. Rewriting `recompute_hotel_intelligence`. Auto-creating `collaborations` or `deal_won`. Changing 0060's Pass behavior. Merging this PR.

## Invariants

- Authentication is not authorization. RLS and the revoked grants are the boundary.
- The service-role key is not in client code.
- Nothing becomes a hotel fact without the creator's confirmation. A collaboration confirmation still does not publish one.
- A `source = 'gmail'` outreach event is not written. Confirmed pitch and reply events are `manual_creator`.
- An automatic reply is not a human reply. A redirect is not a collaboration.
- Disconnect does not purge. Deletion does. Manual facts and manual events stay.
- `gmail.readonly` stays the requested scope.
