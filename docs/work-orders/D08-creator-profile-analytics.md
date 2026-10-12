# D08 — Creator profile and private personal analytics

**Status:** Binding work order for PR #61. Awaiting independent audit. Do not merge.  
**Base:** `main` `fc2dfbd32bf1063dec17d4db16ad84b6311f400c` (merge of PR #60, E03).  
**Branch:** `cursor/d08-creator-profile-analytics-ba2d`  
**Decisions:** D086, D087, D088 — Proposed, not Accepted. D083–D085 are reserved by parallel blocks and are not used.  
**Migration:** `0052_creator_profile_personal_analytics.sql`. `0051` is reserved by E04 and is not used.

One PR for the whole block. Do not merge.

## Principal question

How does a creator see and edit their own profile, and reuse their own recorded history when opening the next pipeline cycle, without a public portfolio and without treating a machine reading as an outcome?

## Sources

PRD §7.6 and §9.2 (private profile fields already on `creator_profiles`). D081 (Profile stays the primary item at `/app/profile`). D072, D078, D080, D045, D01 trip summary (unknown is not zero; `follow_up` is not a reply; cancelled is not a lost deal). ANALYTICS.md: domain counts are not PostHog, and analytics must not copy private CRM data. D077 is Proposed and is not used.

## Locked reading used by this implementation

- The editor writes display name, username, bio, home city, home country, primary language, languages, niches, content formats, social links and handles, website, and an https photo link. Niches and formats are free text. The write does not include `public_profile_enabled` or `portfolio_visibility`.
- Counts are cycles or rows the creator recorded: outreach (`manual_creator` pitch or follow-up), replies (`reply_received` only), agreements (collaboration rows, including later cancelled), completed collaborations (`completed` only), and approved deliverable rows (not quantity). A second event on the same cycle does not raise outreach or replies.
- A missing profile is JSON null, not zero. A zero is a successful read of an empty bucket.
- A B07 or D06 machine state is not a count. Redirect is not a decline. Silence is not ghosting. Negotiation is not an agreement. Unknown compensation is not selected, so it is not unpaid and not zero. No rate is returned or shown.
- Past collaborations are `completed` and `cancelled` only. Each links to the hotel in the pipeline. The link does not copy the row onto a new cycle. `would_work_again` null is not “no”. `terms_matched` unknown is not shown.

## In scope

- Profile editor on the existing Profile page.
- Security-invoker count and past-collaboration reads. No new table.
- The same past list, filtered to the hotel, above the activity panel when any exist.
- Tests: User A versus User B for profile read/insert/update/delete and for counts; anon cannot execute the functions; machine readings do not count; unknown compensation does not become a number; ACL entries for the two invoker functions.

## Out of scope

Public or shareable profile URL, portfolio assets, verified-proof badges, network aggregates, AI, new providers, secrets, real sends, payments, price changes, Rebill, and any change to D072 machine meanings.

## Open question

PRD §7.6 describes a public portfolio at `/creators/[username]`. This block does not build it. The existing `public_profile_enabled` select policy is unchanged, and this block does not set the flag.
