# Privacy subprocessors

Owner-approved processors that receive creator or hotel data from this
product. A name on this list is not permission to send a new field. The
block that calls the processor names the fields.

Retrieved 2026-10-14.

## Anthropic — Claude API

Status: **Approved for D03 (owner, 2026-10-14).** Decision D144.

| | |
|---|---|
| Product | Claude API, `https://api.anthropic.com/v1/messages` |
| Model | Configurable. Default `claude-sonnet-5-5` for Pro and Max |
| Role | Drafts one outreach email. The draft is not sent |
| Data sent | The minimum outreach facts in D144, plus a message body only when the creator selects that message |
| Data not sent | Email addresses, private notes, compensation, other creators' rows, unselected mailbox bodies, prompts in our logs |
| Retention | Anthropic's API data-retention page says conversation content is not retained by default, and is not used for training without express permission. Sonnet 5.5 is not listed as a Covered Model. This product does not claim a zero-data-retention addendum |
| Secret | `ANTHROPIC_API_KEY`, server only |

Source: `https://platform.claude.com/docs/en/build-with-claude/api-and-data-retention`
and `https://platform.claude.com/docs/en/models/sonnet-5-5/overview`.
