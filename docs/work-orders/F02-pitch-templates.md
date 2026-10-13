# F02 — Pitch templates

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
