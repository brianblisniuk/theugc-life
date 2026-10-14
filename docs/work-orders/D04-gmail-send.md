# D04 — Gmail send from the OS

**Status:** Binding work order for the draft PR. Awaiting audit. Do not merge.
**Base:** `main` `414b9805497a2210dd0ddebb592991331e7221d2` (merge of PR #85, DEC-DEL).
**Branch:** `cursor/d04-gmail-send-db05`.
**Migration:** `0089_gmail_send.sql`. `0001`–`0088` are not edited.
**Decisions:** D156–D158 and D160–D161 Accepted. D159 Proposed.

## Question

Can a Pro or Max creator send one pitch or reply from inside TheUGC.life
through their own connected Gmail, and have that send recorded as an exact
event linked to the hotel, contact, trip, and pipeline item?

## In this block

- `gmail.send` only through `grant_send`, the first time the creator chooses
  Send. Connect and reconnect stay on `gmail.readonly`.
- The send is an explicit button. Templates, copies, mailto, and AI drafts
  are not sent. No scheduler (D05).
- Pro and Max only, checked in the database. Free, Destination Pass, and
  admin are refused.
- One idempotency key, one outcome. A 10-second gap and a daily cap that
  defaults to 20 and clamps to 1–40.
- A private sent event with Gmail's message id and thread id. D06 binds the
  thread once it is stored. Pipeline status and outreach events stay as
  they were.
- Allowlist on outside production. Unset list is `hello@theugc.life`.
  `GMAIL_SEND_DISABLED` stops every send. Tests never call Gmail.
- Account deletion erases the new rows.

## Not in this block

- Follow-up scheduling (D05).
- Charging credits for a send (D159, Proposed).
- Adding `gmail.send` on the Google Cloud OAuth consent screen. That is a
  human action outside the repo.
- Changing CRM status when a message is sent.

## Required human action

EXTERNAL ACTION APPROVAL REQUIRED — Add `gmail.send` (sensitive) to the
Google Cloud OAuth consent screen for TheUGC.life, and set
`GMAIL_SEND_ALLOWLIST=hello@theugc.life` on staging. Do not do this from
the repository.
