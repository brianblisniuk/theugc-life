# D05 — Follow-up scheduling

**Status:** Binding work order for draft PR #89. Owner accepted D171–D177 on 14 Oct 2026. Awaiting audit. Do not merge.
**Base:** `main` `f892d6e37cd7b606e4b5c663dc002e0503d0145b` (merge of PR #87, D04b).
**Branch:** `cursor/d05-followup-scheduling-dd31`.
**PR:** https://github.com/brianblisniuk/theugc-life/pull/89
**Migration:** `0092_gmail_followups.sql`. `0088`–`0091` are not edited.
**Decisions:** D171–D177 are **Accepted**.

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
- Follow-up 1 defaults to 3 days after the pitch. Follow-up 2 defaults
  to 5 days after follow-up 1 was sent. The creator chooses another
  whole-day delay for each follow-up. The server and the database
  accept only 1 to 30 days. A day is 24 hours. Weekends are not skipped,
  and the time is not moved to 09:00. The send queue still sends only
  from 09:00 to 18:00 local.
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
  follow-up output check. That draft spends the AI budget and credits
  the same way a pitch draft does. It does not save a pitch draft and it
  does not send. Scheduling a follow-up spends no credits. Sending still
  costs no credits (D159).
- The pitch page shows the next action for each sent pitch on that hotel.

## Not in this block

- Adding `gmail.send` on the Google Cloud OAuth consent screen, or
  setting `GMAIL_SEND_ENV=production`. That remains an external action
  from D04.
- Calling Gmail or Claude from tests. Both are mocked.
- Applying `0092` to staging or to the Supabase project `theugc-life`.

## Required human action

EXTERNAL ACTION APPROVAL REQUIRED remains open from D04: add `gmail.send`
to the Google consent screen, and set `GMAIL_SEND_ENV=production` only on
the production site. Do not do either from this repository. Do not merge
this PR until audit and exact-head CI pass and the owner approves the merge.
