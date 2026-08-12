# theugc.life — DECISIONS.md
Version: 1.0
Purpose: Architecture/Product Decision Records (ADR-lite).

## D001 — No economic incentive for contribution
Status: Accepted

Creators receive no cash, renewal discount, credits, or equivalent for reporting outreach outcomes.

Reason:
Contribution should be a by-product of managing their own work. Direct payment can bias data quality, create gaming/fraud, and add operational cost.

Exception:
Referral/affiliate rewards for acquiring paying customers are allowed because they purchase growth, not data.

## D002 — CRM workflow replaces “Submit Report”
Status: Accepted

There is no creator-facing reporting workflow.
Creators update their own pipeline. Structured events are captured contextually.

Reason:
Immediate creator utility, lower friction, better data quality, stronger retention.

## D003 — Worldwide inventory, concentrated intelligence growth
Status: Accepted

Launch may expose worldwide hotel inventory because an initial global database exists.
Marketing/community density can be concentrated in selected destinations to create stronger live intelligence.

Reason:
Preserves global wow factor without spreading network-effect efforts too thin.

## D004 — Creator Destination Pass
Status: Accepted

A destination-specific, time-limited paid product is an acquisition/paid-trial mechanism.
Initial hypothesis: $29–39 / 90 days.

Reason:
Reduces commitment for creators planning one trip, creates high-intent destination landing pages, and creates a natural upgrade path to Pro.

Public abbreviation “CDP” is avoided because it commonly means Customer Data Platform.

## D005 — Creator Pro pricing
Status: Accepted hypothesis

Reference/original price: $299/year.
Launch: $199/year.
Later discounted: $249/year.
Final pricing is validated by cohort data.

## D006 — Hotels and contacts are separate
Status: Accepted

Reason:
Contacts rotate and can become stale without invalidating hotel entity/history.

## D007 — Payments and entitlements are separate
Status: Accepted

Reason:
Refunds, cancellations, grace periods, passes, manual grants and annual subscriptions are commercial states; authorization needs a clean, deterministic source of truth.

## D008 — Preserve raw structured outreach events
Status: Accepted

Reason:
Future metrics cannot be recovered from a single score. Raw events allow recalculation of reply rate, reply time, conversion, follow-up effectiveness, seasonality and future indices.

## D009 — Public intelligence is aggregated
Status: Accepted

Public/premium collective pages never expose contributors or query raw creator rows directly.

Reason:
Privacy, trust, defensibility.

## D010 — Signals are not truth
Status: Accepted

A creator reporting a bounced email creates a signal, not an immediate edit of the master contact.

Reason:
Protect database integrity and handle conflicting observations.

## D011 — Readable metrics before opaque scores
Status: Accepted

V1 favors:
- reply rate
- typical reply time
- last creator activity
- collaboration types
- confidence

over a single Access Score.

Reason:
More interpretable and less likely to imply false precision.

## D012 — Confidence gating
Status: Accepted

Precise intelligence is shown only at sufficient sample sizes. Initial configurable hypothesis:
0–4 insufficient, 5–14 emerging, 15–49 moderate, 50+ strong.

Reason:
Statistical credibility and contributor privacy.

## D013 — Destination is hierarchical, not equal to city
Status: Accepted

Reason:
Commercial travel destinations include islands/regions such as Bali, Ibiza and Amalfi Coast.

## D014 — Subscription expiry never deletes creator work
Status: Accepted

Creators keep their pipeline/trips/history when premium access expires.

Reason:
Trust, retention, ethical product behavior. Premium data access is revoked, not user-owned work.

## D015 — Milestones represent real career progress
Status: Accepted

No XP/coins/leaderboards. Shareable milestones and annual recap use real pitches, replies, collaborations, countries, etc.

Reason:
Status and viral sharing without artificial game mechanics or revealing competitive hotel targets.

## D016 — Public hotel/destination outputs are growth channels
Status: Accepted

Public pages show safe aggregate activity and lead into premium contacts.

Reason:
SEO, social content, creator acquisition and future hotel claim loop.

## D017 — Marketplace is post-MVP
Status: Accepted

Reason:
First validate database, workflow, data flywheel and retention. Schema should not block future marketplace, but marketplace features are not built now.

## D018 — Connected email uses OAuth
Status: Accepted for future phase

Gmail/Outlook connection uses provider OAuth/API. Never ask for raw mailbox passwords.
Outbound creator email remains creator-approved; no autonomous mass outreach.

## D019 — Dataset is a strategic asset
Status: Accepted

Long-term product can answer market questions such as hotel response speed, pitch-to-deal conversion, destination openness, channel effectiveness, repeat partnerships and seasonality.

Reason:
Potential creator benchmarking, B2B intelligence, PR, enterprise revenue and fundraising narrative.

## D020 — Core moat statement
Status: Accepted

“Anyone can scrape hotel contact data. Nobody can scrape what happens after the creator presses Send.”

This is strategic positioning, not necessarily final public marketing copy.

## D021 — Claude Code is primary implementation agent
Status: Accepted

Use Claude Code for repository implementation because the work is codebase-, migration-, test- and git-centric.
Claude Cowork may be used for planning/review/document work, but it should not become a second autonomous source of product decisions.

## D022 — Agent does not invent product behavior
Status: Accepted

If a required decision is absent from PRD/docs, implementation stops and reports:
1. unresolved decision
2. why it blocks
3. 2–3 options
4. recommendation

No silent product invention.
