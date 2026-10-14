# D03 — AI assistant and email composer

**Status:** Binding work order for this PR. Awaiting CI. Do not merge.
**Base:** `main` `4c8eecde65cc537e71131914343751207d2d7f6d` (merge of PR #82).
**Branch:** `cursor/d03-ai-composer-1361`.
**Migration:** `0082_ai_assistant.sql`, `0083_ai_draft_credit.sql`.
**Decisions:** D141–D145. D04 stays open.

## Question

Can a Pro or Max creator draft one hotel email from their profile, the hotel's
public intelligence, and their own CRM context, in their language, without the
product sending the message?

## In this block

- Server-only Claude client. Timeouts, two retries, a 3-second per-user gap,
  daily caps, and a monthly dollar cap that refuses the call.
- One model id for Pro and Max. Default `claude-sonnet-5-5`. Max gets more
  context and a higher token cap.
- Free and a Destination Pass keep the template fill. No model call.
- One credit on success, through the existing ledger.
- Selected Gmail plain text only. Token counts in logs and `ai_usage`.
- Anthropic listed as an owner-approved subprocessor.

## Not in this block

- Sending mail (D04).
- A second model for Max.
- Charging a failed call.
- Storing prompts.
