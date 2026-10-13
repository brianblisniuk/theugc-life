# F02 — Pitch templates

**Status:** Binding work order for this PR. Awaiting CI. Do not merge.
**Base:** `main` `12630bb9d616fdb63ad97d2e61fe5668723eac67` (merge of PR #71).
**Branch:** `cursor/f02-pitch-templates-ad1c`.
**PR:** #72. Do not merge.
**Migration:** `0064_pitch_templates.sql`. `0060` and `0061` are not edited.
**Decision:** D110. D03 and D04 stay open.

Canon v1.1 Outreach Assisted Engine. This is not the agency F02 row in the
tracker.

## Question

Can a creator prepare a hotel pitch from facts they already have, edit it,
and take it to their own mail client, without a model vendor and without
this product sending the message?

## In this block

- Owner-private templates and drafts (migration `0064`, D110).
- Suggestion from hotel, public intelligence, the creator's portfolio, and
  an optional trip. Missing facts are omitted.
- Personalization goes through one adapter. The wired provider is `template`.
- Copy to the clipboard, or open a mailto draft.
- User A cannot read or change User B's rows.

## Not in this block

- Sending mail (D04 stays open). Copy and mailto do not write a sent pitch.
- An external AI vendor (D03 stays open). Any other personalizer name is refused.
- Gmail detection (F01) and the contact-unlock pipeline save (F05b).
- A credit debit. A draft does not unlock a contact.
- A new primary navigation item.
