# G02 — Deliverable tracking and in-app reminders

**Status:** Binding work order for this PR. Awaiting independent audit. Do not merge.  
**Base:** `main` `f4f0bb7ebafa72ac46bfe78b29267016e6d85235` (merge of PR #74, G01, migration `0068`, D114). F02 is PR #72, migration `0064`, D110.  
**Branch:** `cursor/g02-deliverables-reminders-65ab`  
**Decision:** D115. D116 is not used.  
**Migration:** `0069_deliverable_deadlines.sql`. `0070` is reserved for this block and is not used.

`0068` is on main from G01 (PR #74) and is not edited. `0065`–`0067` stay outside this PR. F04 home files (`src/lib/home/*`, migration `0066`) and G01 contract files (`src/lib/contracts/*`, `src/components/pipeline/contract-drafts.tsx`) are not edited.

One PR for the whole block. Do not merge.

## Principal question

How does a creator see and manage deadlines on their own deliverables, and get an in-app reminder, without sending a message and without inventing a lead time the decisions do not state?

## Sources

D078 (deliverable `due_on` and status on a collaboration the creator owns). D112's UTC-day comparison for deliverables: `pending` or `rejected` with `due_on` at or before the UTC day of the clock is due; `submitted`, `approved`, and a missing date are not due. D098: owner-private at every tier. The existing deliverable form is how a date or a status changes. Canon v1.1 G02: deadlines and reminders. PRD §27 says transactional reminders may be sent later. This block does not send them.

## Locked reading used by this implementation

- The clock is the UTC calendar day of the read instant. `due_on` is compared as `YYYY-MM-DD`. It is not a local-timezone date.
- `overdue` is strictly before that day. `due_soon` is that day. `upcoming` is strictly after it. No N-day lead is stated anywhere this block may use, so due soon is not a multi-day warning.
- A reminder is `overdue` or `due_soon` (the D112 due set). Upcoming stays visible and is not a reminder.
- Submitted, approved, and a missing date have no deadline state. A date that is not a real calendar day fails the read. It is not "not due".
- A failed read is a notice, not an empty list and not zero. A successful empty reminder set is a sentence. A read past 80 rows says the list is not the whole table.
- There is no dismiss and no snooze. Nothing in the decisions defines what hiding a reminder means. The reminder leaves when the deliverable leaves the D112 due set.
- Lifecycle status does not freeze the row (D078) and does not remove the reminder.
- The read function takes no user id, runs as the caller, and relies on RLS. No email, push, SMS, model, or vendor.

## In scope

- `list_own_deliverable_deadlines` and an index on the existing deliverable table.
- Deadline states on the hotel activity checklist, a reminders panel on the pipeline and collaborations pages, and a due-state indicator on pipeline rows when the read succeeded.
- Tests: UTC boundaries, unknown is not an empty list, User A versus User B, anon denied, the read cap.
- D115, this work order, the tracker, autopilot state, the database note, and the entitlements inventory.

## Out of scope

External messages, a model or vendor call, a stored dismiss or snooze, an N-day lead, a change to compensation math, Home integration, G01 contracts, and migration `0070`.

## Follow-up

After F04 merges, Home can call `classifyDeadline` so the UTC day lives in one function. This PR does not edit `src/lib/home/*` or migration `0066`.
