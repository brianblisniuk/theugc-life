# D05 — Follow-up scheduling

**Status:** Binding work order for this draft PR. Awaiting audit. Do not merge.
**Base:** `main` `f892d6e37cd7b606e4b5c663dc002e0503d0145b` (merge of PR #87, D04b).
**Branch:** `cursor/d05-followup-scheduling-dd31`.
**Migration:** `0092_gmail_followups.sql`. `0088`–`0091` are not edited.
**Decisions:** D171–D177 are **Proposed**, not Accepted.

## Question

Can a creator schedule a follow-up on a hotel pitch they already sent
from their own Gmail, have it leave through the existing spaced send
queue, and have it stop when the hotel replies, the message bounces, the
deal is won or closed, or they cancel, with the page saying what will
send, when, and why it stopped?

## In this block

- One explicit opt-in per follow-up, on a pitch sent event the creator
  owns. At most two per thread. The stored subject and body are the text
  they submitted. A draft is not a schedule, and a schedule is not a send.
- Follow-up 1 waits three business days after the pitch. Follow-up 2
  waits four business days after follow-up 1 was sent. Both become
  eligible at 09:00 in the creator's timezone. Weekends are skipped.
- The due row is inserted into the existing send queue as
  `kind = 'follow_up'`. Claim, spacing, business hours, daily caps, the
  bounce pause, the allowlist, and the kill switch are unchanged.
  `gmail_send_reserve` still rejects this kind.
- Stop order: qualifying or ambiguous inbound reply, then a bounce on
  that thread, then pipeline `won` or `closed`, then the creator's
  cancel. An automated reply does not stop it.
- The recipient is copied from the original pitch and checked again with
  the D166 hotel-contact rule. Free has no Gmail outreach.
- An AI follow-up uses the existing composer, a fixed prompt, and the
  follow-up output check. It spends the AI budget and credits the same
  way a pitch draft does. It does not save a pitch draft and it does not
  send. Sending still costs no credits (D159).
- The pitch page shows the next action for each sent pitch on that hotel.

## Not in this block

- Accepting D171–D177. They stay Proposed until the owner decides.
- Adding `gmail.send` on the Google Cloud OAuth consent screen, or
  setting `GMAIL_SEND_ENV=production`. That remains an external action
  from D04.
- Calling Gmail or Claude from tests. Both are mocked.
- Applying `0092` to staging or to the Supabase project `theugc-life`.

## Required human action

PRODUCT DECISION REQUIRED — D171–D177 are Proposed. Confirm the
follow-up defaults before they are Accepted: at most two per thread,
three then four business days, an explicit opt-in, and no send of text
the creator has not submitted.
