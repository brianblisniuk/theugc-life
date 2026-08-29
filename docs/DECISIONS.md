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
Status: Accepted — pricing/duration hypothesis superseded by **D051**

The product rationale below still stands. The `$29–39 / 90 days` figure was a
hypothesis; the V1 commercial contract is fixed at **USD 39 / 30 days / one
destination** in D051.

A destination-specific, time-limited paid product is an acquisition/paid-trial mechanism.
Initial hypothesis: $29–39 / 90 days.

Reason:
Reduces commitment for creators planning one trip, creates high-intent destination landing pages, and creates a natural upgrade path to Pro.

Public abbreviation “CDP” is avoided because it commonly means Customer Data Platform.

## D005 — Creator Pro pricing
Status: Accepted hypothesis — launch price confirmed by **D052**

The reference and later prices below remain future hypotheses. **USD 199/year is
the V1 launch price**, fixed in D052.

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

## D023 — Pipeline relationship-cycle closure rule
Status: Accepted

A `pipeline_items` row represents one creator↔hotel relationship cycle. A cycle
is "active" (open) in every status except `closed`. In particular, `won` remains
an active/non-closed cycle — a won collaboration is still an open relationship
until the creator explicitly closes it.

Only `closed` frees the `(creator_id, hotel_id)` pair for a NEW cycle. This is
enforced by the partial unique index
`pipeline_items_single_active_cycle_uidx (creator_id, hotel_id) WHERE status <> 'closed'`,
which permits at most one non-closed cycle per creator+hotel while still allowing
multiple historical (closed) cycles.

Reason:
Preserves the two-layer model (a won deal and its collaboration lifecycle stay
attached to the live cycle) and prevents duplicate concurrent cycles, while
supporting repeat partnerships as sequential cycles. This finalizes the
"exact active definition" left open in DATABASE.md §8. No schema change was
required — the index already implements this rule.

## D024 — Destination Pass default pricing hypothesis
Status: Accepted hypothesis — **duration superseded by D051**

The price held: USD 39. The **90-day duration did not** — V1 is **30 days**
(D051). The reasoning below is preserved as the historical record of what was
assumed before the owner review.

Within the D004 range (USD 29–39 / 90 days), the default launch hypothesis is
fixed at **USD 39 / 90 days**. This lives in the typed config source
(`src/lib/config.ts`), is not hardcoded in UI logic, and remains subject to
cohort validation. Checkout is not implemented.

## D025 — Canonical research contract drives imports
Status: Accepted

Future hotel/contact research conforms to `HOTEL_DATA_CONTRACT.md`.
Legacy spreadsheets do not define product schema.

Reason:
The durable system should be optimized for clean scalable data collection, not historical spreadsheet accidents.

## D026 — Raw -> staging -> review -> canonical
Status: Accepted

External seed data never writes blindly into canonical hotel/contact tables.
All imports preserve raw lineage, validation and entity-resolution evidence before promotion.

Reason:
Auditability, deduplication, idempotency and safe correction.

## D027 — Seed research is editorial, not creator intelligence
Status: Accepted

Research that a property has worked with creators/influencers is `editorial_evidence` only.
It never creates outreach events or live creator metrics.

Reason:
Protects credibility and keeps observed creator outcomes epistemically separate from research claims.

## D028 — Conservative entity resolution
Status: Accepted

Only deterministic approved matches auto-resolve. Fuzzy similarity creates review candidates.
The same email, brand, chain domain, agency or city never identifies a hotel by itself.

Reason:
False merges can corrupt multiple contacts and creator histories; temporary duplicates are safer.

## D029 — Organizations are first-class but minimal
Status: Accepted

Hotel groups, operators, management companies and PR agencies may be represented as organizations rather than fake hotel rows. Brands remain a separate concept.

Reason:
Corporate/agency relationships are normal hospitality structure and can cover many properties.

## D030 — Legacy import logic is isolated
Status: Accepted

Current messy files are handled by one-time adapters under an isolated legacy import namespace. Their quirks must not leak into canonical tables or durable importer behavior.

Reason:
Once migrated, the product must no longer depend on historical file structure.

## D031 — Real raw datasets stay out of Git
Status: Accepted

Real hotel/contact source files and generated reports containing real contact data are stored locally/admin-side and gitignored. Tests use synthetic fixtures only.

Reason:
Data minimization, repository hygiene and protection of proprietary contact research.

## D032 — Sprint 1A stops before bulk promotion
Status: Accepted

Sprint 1A ends with staging/dry-run reports and human review. It does not automatically bulk-promote real legacy data into canonical production tables.

Reason:
The first import establishes the long-term data foundation and warrants a deliberate review gate.

## D033 — Sprint 1A review corrections (F1–F4)
Status: Accepted (see SPRINT_1A_REVIEW_FIXES.md)

- F1: Organization identity is explicit. The canonical contact contract carries
  `organization_name`; organizations are recognized only from an explicit
  organization name (or explicit relationship evidence), never inferred from a
  person's name, email, or property key. Missing org identity on a broader-than-
  property scope is flagged `organization_identity_missing`, not invented.
- F2: Country-aware fuzzy matching is genuinely country-scoped. Canonical hotels
  carry `country_code`; when a destination is unresolved, fuzzy candidates are
  limited to hotels sharing the same non-null country code. No global fuzzy match.
- F3: Import-batch idempotency has a database backstop — a partial unique index on
  `(file_sha256, parser_name, parser_version)` for non-failed batches. Failed
  batches may still be retried. Application-level detection remains for CLI UX.
- F4: Physical source-row uniqueness is deterministic for non-sheet sources via a
  unique index over `(import_batch_id, coalesce(sheet_name,'__root__'), source_row_number)`.

Reason:
Protect identity/data integrity and idempotency before the first real import.

## D042 — Free-plan limit semantics: open relationships vs engaged CRM
Status: Accepted

`FREE_LIMITS` carries two distinct numbers that answer two different questions.
They are not interchangeable, and neither replaces the database's relationship-
cycle rule.

**`savedHotels = 10` — open relationship allowance.**
The maximum number of OPEN (non-closed) creator↔hotel relationships a Free
creator may maintain at once. `saved` counts toward this limit. Closed cycles
are history and do not count.

**`activePipelineItems = 5` — engaged workflow allowance.**
The maximum number of relationships a Free creator may advance beyond the
passive `saved` state into engaged CRM workflow. The engaged statuses are
`planned`, `pitched`, `replied`, `follow_up`, `negotiating`, `won`.

`saved` does NOT consume the engaged allowance of 5. A Free creator may hold up
to 10 open relationships, of which at most 5 may be engaged.

**Relationship to D023.** D023 is unchanged and remains the database invariant:
for cycle uniqueness, every status except `closed` is an open/non-closed cycle,
enforced by `pipeline_items_single_active_cycle_uidx`. That is a storage rule
about how many cycles may exist per creator+hotel. D042 is a commercial rule
about how many relationships a Free plan may hold and how many may be engaged.
Both apply independently; neither weakens the other.

**Enforcement.** Limits are enforced server-side from typed configuration
(`FREE_LIMITS` in `src/lib/config.ts`), never from client input, and race-safely
inside the same transaction that creates the row. Premium coverage (active Pro,
or an active destination entitlement covering the hotel's destination
hierarchy) exempts a creator from the Free limits for that hotel; a destination
creator acting outside their entitlement falls back to Free behavior.

Sprint 2B implements only the `savedHotels = 10` open-relationship limit,
because it only creates `saved` items. The `activePipelineItems = 5` engaged
limit is enforced when status transitions ship.

## D043 — Close event classification: abandonment vs deal loss
Status: Accepted

Closing a relationship emits one of two canonical events, chosen by whether
outreach had actually begun.

**Closed from `saved` or `planned` → `creator_closed_pipeline`.**
No pitch was ever sent. The creator researched or intended a target and then
moved on. Metadata carries the supplied `reason`.

**Closed from `pitched`, `follow_up` or `replied` → `deal_lost`.**
Outreach happened and the cycle ended without a collaboration. Metadata carries
the supplied `reason`.

Allowed reasons are the same in both cases: `no_reply`, `rejected`,
`not_a_fit`, `timing`, `other`.

Reason:
A creator abandoning a target before any outreach is not a lost deal. Treating
it as one would inflate deal-loss counts with planning churn and quietly
corrupt every future funnel metric derived from the ledger — reply rate,
pitch-to-deal, and hotel responsiveness all depend on `deal_lost` meaning "an
outreach cycle that actually happened and did not convert". Once a pitch has
been sent, closing unsuccessfully genuinely is a lost outreach cycle.

Scope: Sprint 2C defines close behavior for `saved`, `planned`, `pitched`,
`follow_up` and `replied` only. Close semantics for `negotiating` and `won`
(including the collaboration lifecycle they imply) are deliberately left to the
sprint that introduces those transitions.

## D044 — Hotel intelligence metric semantics
Status: Accepted

Hotel intelligence is DERIVED from `outreach_events` and is fully rebuildable.
Raw creator events remain authoritative (D008); nothing in the workflow is ever
modified to make an aggregate look better.

**The unit of observation is a relationship cycle, not an event.**
Every metric below counts distinct `pipeline_item_id` values, so one creator
pitching, following up three times and recording a reply is one data point, not
five. Counting events would let a single busy relationship masquerade as market
demand.

**Pitch count.** Distinct cycles with at least one `pitch_sent`. The EARLIEST
`pitch_sent` in a cycle is its initial pitch.

**Reply count.** Distinct pitched cycles with at least one `reply_received`
whose `event_at` is at or after that cycle's initial pitch. The first such reply
is the qualifying reply. A reply that predates its pitch is not evidence the
pitch worked; a reply in a cycle with no pitch never enters the funnel at all.

**Positive / negative reply count.** Distinct qualifying replied cycles whose
classification event references the qualifying reply through
`metadata.reply_event_id`. A classification carrying no reference (an admin
correction, say) falls back to "same cycle, at or after the qualifying reply".
Classification events are never counted as replies in their own right.

**Collaboration count.** Distinct cycles with `deal_won`. This is the canonical
observed-deal signal; editorial evidence and pipeline status alone are never
used.

**Reply rate.** `reply_count / pitch_count` when `pitch_count > 0`, otherwise
NULL.

NULL and 0 are different answers and must not be collapsed. NULL means "not
measurable": there is no qualifying pitch sample, so there is no denominator and
no claim to make. A numeric 0 means "measured, and nobody replied" — a real
finding about a hotel that was pitched. A hotel with `pitch_count > 0` and
`reply_count = 0` therefore has `reply_rate = 0`, not NULL.

Public exposure of the value is still gated by confidence: 0 is no more
publishable at low N than any other rate.

**Median reply hours.** Per qualifying replied cycle, the hours between the
initial pitch and the qualifying reply, then the median across those cycles.
Always `event_at`, never `created_at`, so backfilled outreach measures from when
it actually happened. Negative durations are excluded.

**Qualifying primary activity events.** `pitch_sent`, `followup_sent`,
`reply_received`, `negotiation_started`, `deal_won`, `deal_lost`,
`collaboration_started`, `collaboration_completed`.

Deliberately excluded: `hotel_saved` (creator intent, not hotel interaction),
`positive_reply` / `negative_reply` / `offer_received` (classifications or
enrichment of an event already counted), `creator_closed_pipeline` (can precede
any outreach), and `contact_bounced`.

**Rolling counts.** `interaction_count_30d/90d/365d` are counts of qualifying
primary events by `event_at`.

**Activity level** is computed from DISTINCT cycles with at least one qualifying
primary event in the last 90 days — not from the event count, for the same
reason the funnel metrics use cycles:

| Active cycles (90d) | activity_level |
|---|---|
| 0 | NULL |
| 1 | emerging |
| 2–4 | low |
| 5–9 | medium |
| 10+ | high |

Zero recent cycles is NULL, never `low`. No label is better than a false
negative statement about a hotel. These thresholds are an initial product
hypothesis, to be revisited once real distribution data exists.

**Confidence** uses the existing D012 vocabulary, computed from pitch count —
the sample supporting the funnel metrics:

| Pitched cycles | confidence_level |
|---|---|
| 0–4 | insufficient |
| 5–14 | emerging |
| 15–49 | moderate |
| 50+ | strong |

**No-data semantics.** A hotel with no qualifying primary activity has NO
`hotel_intelligence` row. A row of zeros would read as a claim ("0% reply rate",
"low activity") about a hotel nobody has contacted. If a recompute finds an
existing row's source events no longer qualify, the derived row is DELETED.

**Public exposure** is progressive, and suppression yields NULL rather than
`false` or `0`:

| Confidence | Exposed by `hotel_public_intelligence` |
|---|---|
| insufficient | `confidence_level` only |
| emerging | + `activity_level`, collaboration presence *(both re-gated on contributor diversity by D058; the field is now `has_observed_collaboration`)* |
| moderate | + `recency_band` (coarse) |
| strong | + `reply_rate` |

Contributor identifiers are never exposed at any level. Cycles are also not
creators: the product must never render a count of cycles as a number of people.

Reason:
These are the first metrics theugc.life asserts about someone else's business.
An inflated or fabricated one is not a rounding error — it is a false public
claim about a hotel, made from data its subject cannot see or correct.

## D045 — Collaboration lifecycle and won-cycle closure
Status: Accepted

`won` describes the DEAL, not the collaboration. A cycle therefore stays open
while the collaboration runs, and closes only when the collaboration reaches a
terminal state.

**Lifecycle.**

```
won + agreed  →  scheduled (optional)  →  active  →  completed | cancelled  →  pipeline closed
```

The pipeline cycle remains `won` while the collaboration is `agreed`,
`scheduled` or `active`. It becomes `closed` only on `completed` or
`cancelled`.

Reason:
Before this, a won cycle stayed open forever — it held a Free engaged slot and
permanently blocked the creator↔hotel pair from a second relationship, because
the database allows only one non-closed cycle per pair (D023). Winning a deal
should not cost a creator a slot for the rest of time. Only the end of the
collaboration should free the relationship and the capacity.

**A cancelled collaboration is not a lost deal.**

Cancellation never emits `deal_lost` and never erases or rewrites `deal_won`.
The deal really was won; the collaboration later failed to complete. Those are
two different facts about two different moments, and collapsing them would
corrupt every funnel metric derived from the ledger (D044 counts a cycle's
`deal_won` exactly once) while destroying the distinction Experience
Intelligence will need — "agreed then cancelled" is a materially different
signal from "never agreed at all".

`collaborations.status = 'cancelled'` is the first-class collaboration fact.
The cycle's closure is recorded with the existing `creator_closed_pipeline`
event, whose meaning is already "closed without a deal-loss classification",
carrying `reason = 'collaboration_cancelled'`, the `cancellation_reason`
(`creator_cancelled` | `hotel_cancelled` | `mutual` | `other`) and the
`collaboration_id`. No new event type is added to finish this slice.

**Per-action semantics.**

- **Schedule** (`agreed → scheduled`) records planned `start_date` and optional
  `end_date`. It emits no domain event: scheduling is the creator's own
  planning state, not a creator↔hotel interaction, so future dates are valid
  and it contributes nothing to intelligence.
- **Start** (`agreed | scheduled → active`) emits `collaboration_started`,
  stores `start_date`, and preserves any scheduled `end_date`.
- **Complete** (`active → completed`) emits `collaboration_completed` carrying
  `collaboration_id`, `terms_matched` and `would_work_again`, stores the end
  date and both answers, and closes the cycle.
- **Cancel** (`agreed | scheduled | active → cancelled`) closes the cycle as
  described above. Cancelling an ACTIVE collaboration sets `end_date` to the
  supplied cancellation day when none is recorded yet; cancelling before it
  started leaves `end_date` untouched, because there was no period to end.

**`would_work_again` is three-valued.** `yes` → true, `no` → false, "not sure"
→ NULL. Recording uncertainty as "no" would invent a negative judgement about a
hotel that the creator did not make.

**Rescheduling and editing are out of scope.** Retries are idempotent and
report the ORIGINAL stored values rather than overwriting them with whatever
was posted again, so a double-clicked form cannot silently rewrite a recorded
date, reason or answer.

**Terminal states are terminal.** Once closed, the lifecycle offers nothing
further; the creator starts a NEW cycle through Save, which increments
`cycle_number` and leaves all previous history — including the completed or
cancelled collaboration — intact.

## D046 — Database privileges are an explicit migration contract

**Hosted default privileges are not part of the application security model.**

Decision:
The final privilege state of every application relation, view and function in
`public` is established **explicitly by migrations**. Nothing in the security
model may depend on a grant that a hosting platform happened to create, on a
`GRANT` inherited from `PUBLIC`, or on the default privileges attached to the
role that ran a migration. If a privilege is required, a migration in this
repository grants it by name. If a privilege is not required, a migration in
this repository revokes it by name.

Reason:
The pre-Sprint-3 audit replayed `0001 → 0023` into an empty database and read
the resulting privilege matrix. External verification then read the same matrix
from the deployed project and got a **different answer**: hosted Supabase had
left broader default grants in place, including client-role write privileges on
relations no migration ever intended to be client-writable. Two consequences
follow, and both are unacceptable:

1. **Replay stopped being a rehearsal.** The test suite, every DB-backed
   security assertion and every review of "what the migrations do" were all
   reasoning about a schema that is not the schema in production. A privilege
   test that passes locally proves nothing about the deployed system if the two
   privilege states are allowed to diverge.
2. **The contract was unwritten.** The intended matrix existed only in
   `PERMISSIONS.md` and in reviewers' heads. Nothing in the database asserted
   it, so nothing could detect drift from it.

Boundaries this decision does **not** move:

- **RLS remains the authorization mechanism.** Row-level policies decide *which
  rows* a caller may see or change. Normalizing table ACLs does not replace a
  single policy, and no policy may be widened to compensate for a revoked
  privilege.
- **Table ACLs remain the capability and exposure control.** A privilege decides
  whether a caller may attempt an operation at all. Defence in depth means both
  layers hold independently: RLS must be correct even if a grant is too wide,
  and the grant must be correct even if a policy is too permissive.
- **`TRUNCATE` is never a client capability.** For every relation reachable by
  `anon` or `authenticated`, `TRUNCATE` is false. `TRUNCATE` bypasses row-level
  security entirely, so a client-role `TRUNCATE` grant is an unconditional
  data-loss primitive no policy can restrain.
- **Supabase-owned schemas are out of scope.** `auth.*`, `storage.*` and
  `supabase_migrations.*` are the platform's, not the application's. This
  decision governs `public` only.

Consequence:
A fresh replay of the full migration set and a deployed production database must
converge on the **same** privilege matrix. `0024_explicit_acl_contract.sql`
establishes that matrix, and a DB-backed assertion fails the build if a future
migration reintroduces a dependency on inherited defaults.

## D047 — Visual Direction V1 is A2 — Sunlit Creator OS
Status: Accepted

The approved visual direction for theugc.life is **A2 — Sunlit Creator OS**, a
synthesis of the three explorations produced for the Visual Direction Gate:

- ~70% Direction A — Sunlit Editorial Utility
- ~20% Direction B — Creator Command Center
- ~10% Direction C — Visual Opportunity Network

Product principle:

**Lifestyle aspiration + professional creator infrastructure.**

For travel: *Bright travel ambition. Serious creator infrastructure.*

Discover must produce "I want to be there", then "this tool can help me get
there" — in that order.

Reason:
Direction A alone risked becoming a beautiful travel publication that is slow to
work in. Direction B alone was credible software with no reason to want it.
Direction C alone made the map the substrate and the product a layer on top of
it. The 20% from B is what preserves density, state language and comparison
velocity; the 10% from C is what keeps the map and the intelligence signals
functional rather than decorative. Those proportions are the decision — not
merely "Direction A won".

Consequence:
Two principles become binding for implementation. **Containers are earned**:
hierarchy comes from thin rules, typography, restrained geometry and real
content, not from putting every fact in its own rounded card. **The master brand
must outlive travel**: Sun yellow, ink, paper, typography, thin rules and
restrained geometry carry the identity, while travel aspiration comes from
product content and photography — so the brand extends to beauty, fashion, food,
fitness, lifestyle and tech without depending on maps, hotels, airplanes,
passport stamps, palms or beaches.

Not decided here:
Typography remains open (Archivo is a recommendation, not an approval), and the
prototype's specific dimensions are implementation references rather than
tokens. See `VISUAL_DIRECTION.md` §7 and §22.

## D048 — Primary brand accent is Sun `#FFE01B`
Status: Accepted

The primary brand accent is **Sun `#FFE01B`**. The yellow exploration is closed;
the warmer and brighter alternatives considered alongside it are rejected.

Yellow must read bright, sunlit, contemporary and energetic. It must never read
as mustard, ochre, beige, terracotta, rustic or bohemian.

**Yellow is a brand / accent / selection / action color. It must never become a
semantic success, warning or error color.**

Reason:
A single locked value removes an open question that would otherwise be
re-litigated on every surface, and it lets tokens be built once. Keeping it out
of the semantic palette is not a stylistic preference: A2's selection language
depends on yellow meaning "this is the active thing" and "this is the primary
action". A yellow that also means "warning" cannot carry either meaning
reliably, and status would end up encoded by color alone — which the
accessibility rules already forbid.

Consequence:
`--accent` becomes `#FFE01B` when Sprint 3A replaces the current placeholder
blue. `--success`, `--warning` and `--danger` remain an independent system, and
the warning color must be chosen so it cannot be mistaken for the accent.

## D049 — One canonical hotel inventory; there is no "premium hotels" class
Status: Accepted

There is **one** canonical hotel inventory. Every publishable hotel is
discoverable worldwide by every user, including anonymous visitors and Free
creators. No plan unlocks a separate, larger or better hotel dataset, and no
hotel record is duplicated per plan or per destination.

**Discoverable ≠ fully unlocked.** A Free creator may discover a hotel, open it,
see its basic information, and see the Public Intelligence layer where
confidence and privacy thresholds allow — and see clearly that richer
intelligence and actionable contacts are locked.

Plan differentiation happens through **access**, never through inventory:

- Premium Intelligence (D050);
- actionable/verified hotel contacts;
- workflow scope and capacity;
- geographic scope of that access.

Reason:
"Premium hotels" was language, not architecture — the database has never had two
hotel datasets, and building one would duplicate records, fracture canonical
identity, break the staging → review → promotion contract, and make every
intelligence aggregate ambiguous about which copy it describes. It would also
sell the wrong thing. A hotel's name and address are not scarce; knowing that
creators get replies there, and being able to act on it, is.

Consequence:
Remove "premium hotels", "premium hotel records" and "premium database" wherever
they imply a gated inventory. Access remains expressed through
`access_entitlements` / purchases / subscriptions (D050, D051, D052); there is
no per-destination application instance and no duplicated hotel row.

## D050 — Two intelligence layers: Public and Premium, with identical privacy
Status: Accepted — supersedes the interim framing in PR #18 (PRD §12.8.1)

**Premium Intelligence is required in V1.** The pre-Sprint-3 contract sync
recorded that no premium intelligence tier existed and listed "drop the promise"
as one option; the owner chose to build the split instead. This decision
replaces that interim framing.

There are exactly **two deliberately designed, browser-safe intelligence
projections**:

**Public Intelligence** — purpose: show that theugc.life has proprietary
creator-network knowledge, and make Discover useful before payment. Coarse, safe
signals: creator activity level, a broad activity/freshness signal, a safe
collaboration-presence signal where supported, and confidence/data-availability
state where useful.

**Premium Intelligence** — purpose: help a paying creator decide whether and how
to pursue an opportunity. Richer actionable signals, where derivable from real
data: reply rate, typical reply-time range, richer recency of qualifying creator
activity, collaboration types observed, stronger network signals, and
data-strength context.

Exact field projections are designed in the implementation PR, not here. No
field may be invented that is not derivable from real qualifying creator
workflow data.

### Privacy does not change by plan — non-negotiable

Free, Destination Pass and Pro obey **the same** contributor anonymity, minimum
observation thresholds, confidence thresholds, suppression rules, NULL-vs-zero
semantics, and protection of raw creator events. Premium buys *more of the safe
aggregate*, never *less privacy*.

A Pro subscription must never expose raw creator workflow data or base
intelligence tables. Premium Intelligence must **never** be implemented by
granting a browser role access to `hotel_intelligence`,
`destination_intelligence`, `outreach_events`, `collaborations`, or any
creator-level/raw aggregate source. Those remain trusted/server-only (D046,
migration 0022). Premium Intelligence gets its own scoped projection with its
own suppression rules, entitlement-gated in the database.

Reason:
The two-layer split is what makes the free tier honest and the paid tier worth
buying: Public proves the asset exists, Premium makes it actionable. Tying the
split to privacy instead would sell contributors' exposure, which destroys the
willingness to contribute that the whole flywheel depends on. Contributors must
be able to trust that no price unlocks them.

Consequence:
Reply rate moves from the public projection to the premium one — it is currently
disclosed to every browser role at `strong` confidence, which the implementation
PR must correct. Editorial/research evidence still may not manufacture creator
network metrics (D027): reply rate, response time and interaction recency derive
only from qualifying real creator workflow data, at every tier.

## D051 — Creator Destination Pass V1: USD 39 / 30 days / one destination
Status: Accepted — supersedes the 90-day duration in D024 and the range in D004

| Term | V1 |
|---|---|
| Price | **USD 39** |
| Duration | **30 days** (was 90 — D024) |
| Scope | **one destination** |

Job to be done: *"I'm going to Bali and I want to get collaborations."*

Inside the entitled destination the Pass unlocks Premium Intelligence, premium/
actionable hotel contacts, and the approved full destination workflow/CRM scope
including follow-ups and pipeline behaviour under the existing product rules.

Hotel **discovery remains worldwide** (D049). Outside the entitled destination
the user falls back to the Free discovery + Public Intelligence experience.

On expiry: Premium Intelligence and premium contacts for that destination lock
again. **Creator-owned historical pipeline, outreach and collaboration data does
not disappear** and remains readable, per the existing permissions contract.

Reason:
30 days matches the actual job. The Pass is bought by someone with a trip
already booked, and pitching for one trip is a weeks-long task, not a quarter.
A 90-day window priced the same was mostly idle time, weakened the upgrade path
to Pro, and made the product look like a cheap subscription rather than a
low-friction acquisition product for a specific trip.

Consequence:
`PRICING.destinationPass.durationDays` moves 90 → 30 in the typed config, and
every surface that renders it follows. Entitlement expiry semantics are
unchanged in the database — only the granted duration differs.

## D052 — Creator Pro V1: USD 199/year, worldwide
Status: Accepted — confirms the launch price in D005 as the V1 decision

Creator Pro is the full creator operating system. **V1 launch price: USD 199 per
year. Scope: worldwide.**

Job to be done: *"I'm a travel creator and I want theugc.life to be my operating
system."*

Pro unlocks Premium Intelligence worldwide, premium/actionable hotel contacts
worldwide, full CRM/workflow scope, Trips, Portfolio, and other approved Pro
capabilities **that actually exist**.

The USD 299 reference and USD 249 later prices from D005 remain future pricing
hypotheses, not commitments.

Future AI and community capabilities may become Pro benefits when they are
genuinely built and separately approved. **Do not promise "all future features
forever."**

Reason:
Fixing the launch number removes an open variable from every commercial surface,
and stating that Pro includes only what exists keeps the upgrade honest as the
product grows.

## D053 — Archivo is the primary product typeface V1
Status: Accepted — closes the open item in VISUAL_DIRECTION.md §7

**Archivo** is approved as the primary product typeface for Visual Direction V1
(A2 — Sunlit Creator OS, D047), preferred over Schibsted Grotesk. Typography
exploration for V1 is closed.

Reason:

- high legibility at the dense product-UI sizes A2's result rows require;
- strong numeric rendering, which the product needs constantly for dates,
  counts, rates and confidence;
- enough editorial personality to avoid an enterprise-SaaS default, without
  becoming a display-only magazine face;
- variable-width capability, which supports A2's no-photo and editorial
  typographic treatments where an image cannot carry the row;
- suitable for the master brand beyond travel (D047), so a vertical expansion
  does not force a type change.

Scope of this approval:
It fixes the **typeface**. It does **not** promote any A2 prototype font size,
weight, width or line-height to a token — those remain implementation references
until validated on a real surface (VISUAL_DIRECTION.md §22). Production font
loading is unchanged until the implementation PR.

## D054 — Map coverage V1: 100% of publishable inventory
Status: Accepted — supersedes the "partial coverage is acceptable" position in
VISUAL_DIRECTION.md §21B

**Every publishable hotel in Discover must have canonical latitude/longitude and
must appear on the map. The V1 coverage target for publishable inventory is
100%.**

Coordinates are a **publishability precondition**, not an enrichment that
catches up later. A hotel may not enter the publishable Discover inventory
without them.

Internal, staging and research records may temporarily lack coordinates while
they are being enriched or reviewed — that is the normal state of the pipeline
before promotion. The rule binds at the promotion boundary, not before it.

Coordinates remain **provenance-backed and are never fabricated** (D025, D027).
An unlocated hotel is held back from publication; it is not given a plausible
point.

### The unmapped state is a fallback, not a plan

The unmapped state described in VISUAL_DIRECTION.md §20 remains in the UI as a
**defensive data-integrity fallback**, so the surface degrades honestly instead
of failing if bad data ever escapes validation. It is **not** an acceptable
planned state of production inventory and does not satisfy this contract.

The A2 prototype showed unmapped hotels because it was demonstrating incomplete
demo data. That was a property of the prototype's fixtures, not a product
target.

Reason:
A map with holes in it is worse than no map. The creator cannot tell whether a
destination genuinely has nothing in that area or whether the product simply
does not know, and every gap silently understates the inventory the product is
selling. Treating "unmapped" as a normal condition also removes the pressure
that keeps coverage complete: a first-class empty state is a permanent excuse.
Making coordinates a precondition of publishing puts the cost where it belongs —
in enrichment and review — instead of on the creator's ability to trust the map.

Consequence:
The promotion path must reject or hold publishable candidates without valid
coordinates, and Discover's map is a complete view of what Discover lists.
Choosing a geocoding source remains an open decision (VISUAL_DIRECTION.md §21B);
this decision fixes the target, not the supplier.

## D055 — Destination inventory is complete, not capped
Status: Accepted

There is **no arbitrary property cap per destination**. A Destination Pass is
not "the best 30 hotels", not "100 curated hotels", not a sample, and not any
other capped subset.

For every supported destination the goal is **all unique in-scope hospitality
properties in the defined coverage universe for that destination**. A
destination may naturally hold 40 properties, or 150, or 500. **The number is
determined by the destination, not by the product packaging.**

The coverage universe is assembled from approved property inventory sources and
the existing research pipeline, then passed through conservative identity
resolution and deduplication (D028).

### Exclusions must be explicit and auditable

A property may be excluded only for a stated, reviewable reason:

- duplicate;
- permanently closed or inactive;
- corporate/group HQ rather than a property;
- agency or other non-property organization (D029);
- property type explicitly outside product scope.

A property must **NOT** be excluded because:

- no premium contact has been found yet;
- creator-network intelligence is still insufficient;
- photography is not yet available.

Those are **field states, not existence states**. A hotel with an unknown
contact is a hotel with an unknown contact; pretending it does not exist makes
the product lie about the destination.

Reason:
Completeness is the actual product promise of a Destination Pass. A creator
going to Bali is asking "who could I pitch here?", and any answer that silently
omits properties is wrong in the one way the buyer cannot detect. A capped
"curated" set also destroys the flywheel's denominator: reply rates and activity
levels only mean something relative to a known universe. And a cap creates a
permanent editorial argument about which hotels deserve to exist, which is not a
question the product should be answering.

Consequence:
Coverage is measured against the destination's universe, not against a target
count. Excluded properties carry a recorded reason, so coverage can be audited
rather than asserted. The external inventory sources are **not** chosen here —
that is the next Property Content contract.

## D056 — Destination Pass workflow scope
Status: Accepted — makes the "full workflow" of D051 explicit; confirms and
extends D042's premium-coverage exemption

While a Creator Destination Pass is active:

**Inside the entitled destination** (including valid descendant destinations per
the existing hierarchy rules):

- the creator receives the full approved pipeline/workflow;
- all existing pipeline states and transitions are available;
- the follow-up / outreach lifecycle is available;
- the collaboration lifecycle is available;
- **those relationships are not constrained by the Free saved/open/engaged
  workspace limits** (`FREE_LIMITS`).

**Outside the entitled destination:**

- worldwide discovery remains available (D049);
- Public Intelligence remains available (D050);
- the creator keeps the normal Free-tier workspace capabilities and limits;
- the Pass provides no Premium Intelligence and no premium contacts there.

**A paid Destination Pass must never remove a right the account would have had
as Free.** Paying is strictly additive.

**Creator Pro** applies the full premium and workflow scope worldwide (D052).

**After expiry:** Premium Intelligence re-locks, premium contacts re-lock, and
creator-owned historical workflow remains readable under the existing contract
(PERMISSIONS.md §8, PRD §11.10). Expiry removes access to premium data, never
the creator's own records.

Reason:
"Full workflow for the entitled destination" was the last piece of D051 that a
reader could interpret two ways, and the two readings price very differently. A
Pass that still capped the creator at 10 open and 5 engaged relationships would
be unusable for its stated job — a creator pitching a destination works through
far more than five hotels — so the limits have to lift inside the entitlement or
the product does not do what it sells.

Relationship to D042:
D042 already states that "premium coverage (active Pro, or an active destination
entitlement covering the hotel's destination hierarchy) exempts a creator from
the Free limits for that hotel", and that "a destination creator acting outside
their entitlement falls back to Free behavior". D056 **confirms** that rule and
names the workflow surface it applies to. Nothing in D042 is superseded; the
exemption is per-hotel and resolved through the destination hierarchy, which is
what makes "inside the entitled destination" checkable in the database rather
than in the UI.

## D057 — Three intelligence provenance domains, permanently separated
Status: Accepted

The product holds three kinds of fact about a hotel. They may be shown near each
other; they must **never be statistically mixed** or presented as though they
mean the same thing.

### A. Research / editorial intelligence
What theugc.life researches or verifies itself: contact verification, target
contact vs contact route, source and provenance, freshness, public evidence that
a hotel has worked with creators, property and contact quality control.

This is a **trust layer**. It may say "Direct marketing contact", "Verified 12
days ago", "Creator collaboration evidence verified". It may **never** create
Creator Network events or metrics.

### B. Hotel-confirmed intelligence — *future, not built*
What an authorized hotel representative explicitly supplies or confirms: whether
the hotel currently considers creator proposals, its preferred outreach channel,
the correct marketing/PR/partnerships contact, the collaboration types it says
it considers, official photography, the date of confirmation.

Internally this must be distinguishable as **HOTEL CONFIRMED**, not merely
"verified by theugc.life" — with who confirmed it, when, from what source, and
its freshness/review state. **Nothing of this is implemented.** The schema and
the outreach system belong to the future Hotel Outreach / Property Content
block; this decision fixes only the architecture.

### C. Creator Network intelligence
Derived **exclusively** from qualifying real creator workflow and outcome data:
creator activity, reply rate, reply timing, collaboration outcomes,
collaboration types observed.

Research evidence and hotel declarations never create these. **"The hotel says it
accepts paid UGC" and "creators have actually received paid collaborations here"
are two different facts**, and the second is the one nobody else can scrape.

Reason:
Mixing them would destroy the only defensible asset the product has. A hotel
that answers a survey enthusiastically and ignores every creator who pitches it
must not out-rank a hotel that quietly replies to everyone. Editorial evidence
is also easy to acquire and easy to game; the outcome graph is neither. Keeping
the domains separate is what lets the product show all three honestly —
"verified contact", "the hotel says it works with creators", "creators get
replies here" — without any one of them borrowing the credibility of another.

Consequence:
`recompute_hotel_intelligence` reads `outreach_events` and `collaborations` and
nothing else — not `editorial_evidence`, not `hotel_contacts`, not
`verification_events` (D027 already forbids the first; this generalizes it). A
reply from a hotel **to theugc.life** is not a creator reply and must never
enter reply-rate data. When domain B ships, it gets its own storage and its own
display language.

## D058 — V1 Creator Network Intelligence: the exact Public/Premium contract
Status: Accepted — implements D050; supersedes the D044 disclosure table for
reply rate

Two browser-safe projections. Both are aggregates; neither is a base table.

### Public — everyone, including anonymous

| Signal | Gate |
|---|---|
| Creator activity level | confidence >= `emerging` **and 3 distinct creators in 90 days** |
| Observed-collaboration presence (`has_observed_collaboration`) | **3 distinct collaborating creators in 365 days**; positive-presence only |
| Coarse recency band (`past_month` / `past_quarter` / `older`) | confidence >= `moderate`; the two RECENT bands additionally require **3 distinct creators in 90 days** |
| Confidence / data-availability state | always |

**Suppressed is not negative.** Below any public floor the field is NULL. NULL
means "not disclosed", never `low` and never `false`. `has_observed_collaboration`
is therefore `true` or NULL and never `false`: the absence of three collaborating
creators is the absence of a disclosable observation, not evidence that creators
do not collaborate here. Payment changes none of these gates — the public
projection is byte-identical for anonymous, Free, Destination Pass and Pro (D050).

**"Observed", not "confirmed" (D057).** The public boolean is derived only from
qualifying Creator Network collaboration outcomes — never from research
evidence, hotel declarations, editorial evidence or hotel outreach. "Confirmed by
hotel" language is reserved for the Hotel-Confirmed Intelligence domain, which
does not exist in V1.

Public **must not** expose: reply rate, typical reply time, exact or raw pitch
counts, exact or raw reply counts, the distinct-creator counts backing any public
gate, raw event timestamps, collaboration compensation, creator identities,
creator-level data, or premium collaboration-pattern detail.

**Discover list cards are public-only.** A premium field must never leak onto a
list card because the viewer happens to be entitled.

### Premium — Destination Pass inside its destination hierarchy, Pro worldwide, admin per PERMISSIONS.md §11

Each metric has **metric-specific publication thresholds**. Reply metrics require
both qualifying-cycle volume and contributor diversity; recency and
collaboration-type signals rely on their approved distinct-creator population
floor. Analysis window is a trailing **365 days**, measured on `event_at`, never
`created_at`.

| Metric | Sample floor | Contributor floor | Output |
|---|---|---|---|
| Reply rate | 15 qualifying pitched cycles | 5 distinct creators | whole percent |
| Typical reply time | 10 qualifying replied cycles | 5 distinct creators who received one | band |
| Recent creator activity | — | 3 distinct creators in the band | `within_7_days` / `within_30_days` / `within_90_days` |
| Collaboration types observed | — | 3 distinct creators **per type** | type list |
| Contributor sample | — | 5 distinct creators | "Based on activity from N creators" |

**Reply rate** answers "how often do creators who pitch this hotel receive a
qualifying human reply?" over qualifying outreach **cycles**, not raw events. A
follow-up never becomes another denominator; a creator's repeat cycle with the
same hotel counts once each time. It does not count autoresponders,
out-of-office replies, delivery or bounce notifications, duplicate
classification events, or synthetic activity — a qualifying `reply_received`
represents an actual human hotel-side response.

**Typical reply time** is the median from initial qualifying pitch to first
qualifying reply within the same cycle, published as one of: Under 24h · 1–3
days · 3–7 days · 1–2 weeks · 2+ weeks. Never "83.6 hours", never "10 replies".

**What premium never exposes is raw outreach volume**, not counting as such:
pitch counts, reply counts, event counts, cycle denominators and raw event
timestamps stay server-side. The **contributor sample** is the deliberate
exception — a threshold-protected distinct-creator count published only at >= 5
creators, because "based on activity from 7 creators" is what makes a percentage
interpretable, and above that floor it identifies nobody.

**Reply rate leaves the public projection.** D044's table disclosed it at
`strong` confidence to everyone; migration 0026 removes the column entirely.

### Not in V1

**No composite "Creator Friendly Score". No 0–100 hotel reputation score.** A
metric must remain interpretable on its own.

Reason:
Reply metrics carry two floors because volume and diversity fail differently. A
hotel with fifty pitched cycles from three creators has a large sample and no
population; publishing a reply rate for it describes those three people, and at
that size a creator could recognise their own exchange in the number. Bands
rather than point values exist for the same reason — a precise median over ten
replies is reverse-engineerable, and precision the sample cannot carry is a lie
told confidently.

A composite score is rejected because it cannot be argued with. "62% reply rate"
is checkable and improvable; "Creator Friendliness 71" is a verdict whose recipe
becomes the product's real contract, and every hotel would optimise the recipe
instead of their behaviour toward creators.

Consequence:
Migration 0026 implements this. Thresholds live in the projections, so changing
one is a migration and a test change — never a UI edit. Payment lowers no
threshold on any plan (D050).

## D059 — Locked, building and error are three distinct product states
Status: Accepted

A premium intelligence surface has four outcomes, and three of them are easy to
confuse and damaging to confuse:

- **available** — entitled, and at least one metric cleared its floors;
- **locked** — the capability exists; this viewer is not entitled. Show the
  locked treatment, leak no protected value;
- **building** — the viewer IS entitled, but qualifying network evidence is
  insufficient;
- **error** — an entitlement lookup, database query or loader failed. Never
  reported as "not entitled", "no data" or "building".

### The building state

> **Creator intelligence is building**
> Track your outreach here and help make this hotel's insights more useful for
> the creator community.

**Unknown ≠ zero. Unknown ≠ negative. Insufficient evidence ≠ bad hotel.**

Intelligence accrues as a by-product of the creator's normal workflow. There is
**no "submit data" or "submit report" mechanic**, and no economic reward, points,
XP or gamification to manufacture contribution (D001, D002).

Reason:
Each confusion costs something different. Rendering `error` as `locked` tells a
paying creator to buy what they already own. Rendering `error` as `building`
tells them a hotel has no history when the product simply failed. Rendering
`building` as an empty or broken panel makes a quiet hotel look like a bad one,
which is a false claim about a business — and the same claim a "0% reply rate"
would make. The distinction is enforced by resolving entitlement independently
of the data load, so a failed check can never masquerade as a denial.

## D060 — V1 inventory scope is 4/5-star hospitality classification, provenance-backed
Status: Accepted — defines the property scope D055 measures completeness against

**V1 inventory is every unique, in-scope, physical hospitality property with a
resolved canonical hotel star classification of 4 or 5 stars, in each supported
destination.**

### Stars means hospitality classification

"4-star" / "5-star" is the property's **hotel/hospitality star classification**.
It is **never** a Google review score, a Booking guest review score, an Expedia
review score, a TripAdvisor rating, or any other user-review or guest
satisfaction score.

A property with a 4.7 guest-review average and no hospitality classification has
**no resolved star classification**. That is a review state, not a 4-star hotel
and not an exclusion.

### Property type does not decide eligibility

Type alone neither admits nor excludes. Hotels, resorts, boutique hotels,
aparthotels/hotel apartments, lodges, residences, villa-style hospitality
operations and other physical hospitality property types may all qualify. The
`hotel_type` taxonomy remains descriptive metadata, not the gate.

Corporate/group headquarters, agencies and other non-property organizations
remain excluded from hotel inventory (D029).

### The classification must be justifiable

`hotels.star_rating` as an unexplained number is not sufficient. The system must
be able to answer *"why does theugc.life consider this a 4- or 5-star property?"*,
so the model is **canonical star classification + source evidence/provenance**.

- never infer stars from review scores;
- never average conflicting classifications — 4 and 5 do not make 4.5;
- never fabricate a missing classification;
- unknown classification → REVIEW / not yet publishable;
- a conflict that could mean out-of-scope → REVIEW;
- retain source-specific observations after canonical resolution.

The **authority hierarchy among sources is deliberately not chosen here**; it
belongs to the source-evaluation block, which will have evidence for it.

### Out-of-scope research is preserved

Existing research on 1/2/3-star properties is not deleted. It stays valuable for
future scope expansion, organization/contact research and historical provenance,
and should become a durable `OUT_OF_V1_PRODUCT_SCOPE` classification with a
reason such as `star_rating_below_v1_scope`.

Reason:
"All hotels in a destination" is unbuildable without a scope predicate, and the
predicate has to be one that a reviewer can check and a hotel could contest.
Classification is issued by someone and can be cited; a guest-review average is a
popularity measurement that changes weekly and belongs to a different question
entirely. The two are both "out of five", which is exactly why the prohibition
has to be written down rather than assumed. Averaging conflicting classifications
would invent a rating no authority ever issued, and defaulting an unknown one
would publish a claim the product cannot defend.

Consequence:
Star eligibility becomes a hard publishability condition (D062), and star
provenance becomes a required field rather than an optional nicety. The full
contract is `PROPERTY_CONTENT_COVERAGE_CONTRACT.md` §2 and §8.

## D061 — Destination inventory is an output; coverage completeness is not enrichment completeness
Status: Accepted — operational clarification of D055, which is unchanged

### The no-cap rule in operational terms

There is no target hotel count per destination, no top-N, no curated subset, no
representative sample, no package cap, no "enough hotels" threshold and no
commercial maximum.

If a destination's resolved coverage universe holds 724 eligible properties, the
canonical inventory is 724. If it holds 79, it is 79.

> **The inventory count is an OUTPUT of destination reality and the coverage
> process. It is never an INPUT chosen by product packaging.**

Wording such as "top 100", "selected hotels", "curated hotels", "initial 50" or
"representative inventory" is prohibited for destination coverage, in product
copy and internal reporting alike. The one exception is an explicitly named
technical test fixture that is not coverage.

**The 30-property Dubai set is a technical pilot only** and must never be
described as complete Dubai inventory.

### "All" is measurable

The coverage universe is the union of approved inventory-source records, existing
canonical/research inventory, and other approved authoritative inputs when
adopted. Identity resolution, deduplication, scope filtering, active-status
filtering and 4/5-star eligibility resolution then produce the canonical V1
destination inventory.

**A provider is not truth, and no single provider is assumed complete.**

### Two different completeness problems

- **Inventory/coverage completeness** — do we have every eligible property in the
  universe? Measured against the universe, never a target count.
- **Enrichment/field completeness** — how much do we know about each canonical
  property? Coordinates, photography, website, Instagram, any contact, target
  contact, contact verification, hotel-confirmed and Creator Network Intelligence.

A missing optional field must never silently remove an eligible hotel from
inventory. **Missing data is work to do, not a reason to pretend the hotel does
not exist**, and missingness should be measurable as operational queues
(`hotels_without_any_contact`, `hotels_without_photo`, …) rather than as
exclusion filters.

### Coverage closure

**A destination must not be declared "coverage complete", "100% inventory
complete" or any equivalent while ANY candidate from its defined coverage
universe remains unresolved on a coverage-critical eligibility dimension.**

Coverage-critical unresolved states include at minimum: canonical identity
unresolved, duplicate/entity resolution unresolved, physical-hospitality-property
status unresolved, destination membership unresolved, active/permanently-closed
status unresolved, star classification unresolved, and any other state required
to decide whether the candidate belongs in V1 inventory.

Every candidate must eventually resolve to exactly one of: **(A)** canonical
eligible V1 property, **(B)** duplicate/matched to a canonical property, or
**(C)** final exclusion / out of V1 scope with an explicit durable reason. Hold
and review states are legitimate during processing, not at closure.

```
COVERAGE COMPLETE  requires  coverage_critical_unresolved_count = 0
```

A destination with unresolved candidates is **coverage incomplete** regardless of
how many hotels are already published, or of coordinate, photo or contact
coverage among them.

Inventory completeness is therefore measured **only after the full defined source
universe has been processed and every candidate's eligibility resolved**; the
eligible inventory count is the number of unique canonical properties resolved as
eligible. A progress metric (`resolved_coverage_candidates /
total_coverage_candidates`) may be retained, but **process resolution is not the
eligible inventory count**. Coverage reporting always carries both the resolved
eligible count and the unresolved coverage-critical count / closure status.

**Do not construct a denominator that excludes unresolved records.**

### Coverage runs and exclusion kinds

A destination coverage run must be able to explain, per destination and per
source: raw records seen, source identities, candidate properties, cross-source
matches, duplicates, review candidates, new canonical candidates, closed/inactive
exclusions, non-property exclusions, below-star-scope exclusions, unresolved-star
candidates, and the canonical eligible inventory count.

Exclusions must distinguish **final exclusions** (duplicate, permanently closed,
HQ, agency, not a hospitality property) from **hold/review states** (star
classification unresolved, identity unresolved).

> **"Star classification unknown" is not the same fact as "confirmed 3-star
> hotel."** The first may later enter inventory. The second is outside V1 scope.

Reason:
D055 already forbids caps, but a rule that lives only as a principle gets eroded
by operational convenience — a sprint plan that says "start with the top 50" does
not feel like a violation while it is being written. Naming the output/input
distinction, and banning the specific vocabulary, makes the erosion visible.
Separating coverage from enrichment matters for the opposite reason: they will
never be complete at the same time, and reporting them as one number would make
the product's own operators believe a destination was finished when only its
coordinates were. Collapsing unknown into below-scope silently deletes eligible
properties; collapsing below-scope into unknown silently pollutes inventory.

The closure rule exists because the obvious metric is wrong in a way nobody
notices. With 700 resolved-eligible properties and 24 candidates still
unresolved, a fraction whose denominator holds only *known eligible* properties
reads 700/700 = 100% — while some of those 24 may themselves be eligible 4/5-star
hotels. The destination would be certified complete by arithmetic that defined
the missing hotels out of existence, and the creator who bought that destination
is the one person who cannot detect it. "We resolved some known eligible hotels"
is not the promise; "we resolved the complete coverage universe and retained
every property that qualifies" is.

Consequence:
Coverage is measured over the **defined coverage universe**, never over the
already-qualifying subset; a destination reports both its resolved eligible count
and its unresolved coverage-critical count; enrichment is measured per field; and
coordinate coverage at 100% (D054) is never reported as total data completeness.
Full contract in `PROPERTY_CONTENT_COVERAGE_CONTRACT.md` §3–§6, §9, §15.

## D062 — The canonical publishability contract
Status: Accepted — makes D054's coordinate precondition part of a complete rule

A **research/staging property** may legitimately be incomplete; that is the
normal state of the pipeline and `HOTEL_DATA_CONTRACT.md` continues to allow it.
A **canonical publishable hotel** is a stricter thing.

### Promotion into `hotels` IS the publication boundary

For V1 there is no canonical-but-unpublished state:

> **PROMOTED PROPERTY = CANONICAL PUBLISHABLE PROPERTY.**
> **D062 is a promotion precondition.**

```
source → staging → audit/review → promotion preview → human review
       → promotion/apply → canonical publishable hotel
```

A candidate that fails any condition below is **not promoted**. It stays in
staging/review to be enriched, resolved or finally excluded — never deleted, and
never given a fabricated coordinate or an invented star classification to make it
pass. **No `publication_status` column, unpublished-canonical tier or draft-hotel
state is introduced.** A future product decision may create such a layer if a
concrete need appears.

**Existing canonical pilot rows are not retroactively claimed compliant.** They
were promoted before D054, D060 and D062 existed; the implementation block must
audit, enrich and re-evaluate them.

A canonical hotel is publishable in V1 only when at minimum:

1. canonical property identity is resolved;
2. it belongs to a supported canonical destination;
3. it is a physical hospitality property;
4. it is not known permanently closed/inactive;
5. its V1 scope status is resolved;
6. canonical hotel star classification is exactly 4 or 5;
7. star-classification provenance exists;
8. canonical latitude exists;
9. canonical longitude exists;
10. coordinate/location provenance exists;
11. no unresolved entity-resolution conflict prevents us from knowing what
    property it is.

Publication **must not** require photography, any contact, a target contact, a
premium contact, Creator Network Intelligence, Hotel-Confirmed Intelligence, or
creator-collaboration evidence.

> **Contact completeness is not publishability. Photo completeness is not
> publishability. Intelligence completeness is not publishability.**

Reason:
Every one of the seven non-requirements has been treated as a prerequisite at
least once, and each time the effect is the same: the destination silently
shrinks to the subset we happen to know most about, which is precisely the
failure D055 exists to prevent. The eleven requirements are the opposite case —
each is something without which the product cannot honestly say *what* the hotel
is or *where* it is, and a creator cannot use a listing that fails them.
Provenance appears twice on purpose: a value nobody can trace is not a canonical
value, it is a number we would have to defend by assertion.

One boundary is chosen over two deliberately. A second state would immediately
raise questions this block has no reason to answer — who sees it, what RLS
applies, whether a creator can save it, whether it counts toward coverage — and
each unanswered one is a place where an unpublishable hotel leaks into a surface.
A row in `hotels` is a row a creator can see, and that is easier to verify than
any status column.

Consequence:
The promotion path gains a publishability gate covering stars and provenance as
well as D054's coordinates. A candidate failing any of the eleven is held in
staging, not promoted, not published and not deleted. A candidate failing only
the non-requirements is promoted and published with known enrichment work
outstanding.

## D063 — Source-agnostic canonical property identity
Status: Accepted

**theugc.life owns the canonical property identity. External providers supply
source identities.**

```
canonical hotel
  ├─ Booking source identity
  ├─ Expedia source identity
  ├─ official website identity
  ├─ other approved provider identity
  └─ future hotel-confirmed identity
```

**An external provider ID must never become the canonical hotel primary key.** A
future `hotel_source_identities` concept holds the mapping, with source property
id/url/name/address, source coordinates, star classification and type when
supplied, first/last seen, last synced, match method, match confidence, match
status and provenance.

### Entity resolution is conservative

Resolution uses several signals — normalized name, brand, official
website/domain, address, coordinates, phone, destination, known provider
mappings — and produces **MATCHED**, **REVIEW** or **NEW PROPERTY**.

A false merge can corrupt contacts, photos, coordinates, intelligence and live
creator workflows, and is therefore **strategically worse than temporarily
retaining a duplicate candidate**. Never merge because the names look similar.
Universal numeric match thresholds are not specified until real source data
exists.

### Coordinates from a source are observations

External source coordinates are not automatically canonical truth. A future
location-evidence concept retains source lat/long, source address, observed time
and resolution provenance; `hotels.latitude`/`hotels.longitude` remain the
resolved canonical values. Never fabricate coordinates, never use prototype
positions, and send unresolved conflicts to review. D054's 100% map coverage of
publishable inventory is unchanged.

Reason:
A canonical hotel outlives any provider relationship. Keying it on a provider
would make the inventory unownable, make a multi-source coverage universe
structurally impossible — one property would need one PK per source — and turn a
provider change into a data migration of every creator's pipeline history. The
conservatism about merging is asymmetric on purpose: a duplicate is visible and
fixable, while a bad merge silently attributes one hotel's outreach history to
another and the creator whose pipeline it corrupts has no way to see it happened.

Consequence:
Provider identity, provider coordinates and provider star claims are all
*evidence attached to* a canonical hotel, never the hotel itself. Dropping a
provider means dropping its source identities, not rebuilding inventory. Full
contract in `PROPERTY_CONTENT_COVERAGE_CONTRACT.md` §11–§13.

## D064 — Hotel media is a first-class, provenance-backed child resource
Status: Accepted — closes the media half of VISUAL_DIRECTION.md §21A

Media is a child resource of a canonical hotel, not a column on the hotel and
never a provider-specific photo URL wired into the hotel identity contract.

A future `hotel_media` concept supports at least: hotel id, source/provider,
source identity and media id, source url, asset/remote url, media type, category,
cover vs gallery role, dimensions when known, sort order, provenance, usage/rights
basis, attribution where required, source updated time, last verified time,
status, and whether the asset is property/provider/official media or
user-generated.

### Product rules

**The hotel gallery uses property/hotel imagery.** Guest-generated or
user-generated photos are not deliberately selected as canonical editorial
property imagery. Never ship Envato preview/watermarked exploration images, fake
demo photography as production data, or an asset of unknown provenance
represented as "official". Provider licensing and usage rules are source-specific
and must be evaluated before production ingestion.

### Source priority is a direction, not a provider choice

Conceptually a cover candidate may later prefer hotel-supplied/hotel-confirmed
official media, then approved structured provider property media, then approved
official hotel/brand media, then another approved eligible source, then a
first-class no-photo state. **Booking vs Expedia precedence is not hard-coded.**
The frontend asks *"what is this hotel's best eligible cover?"*, never *"what is
this hotel's Expedia image?"*.

### No-photo is a valid field state

D055 means a missing photo must not remove an eligible hotel, so **photo coverage
may legitimately be below 100%** and the product needs a real no-photo state. It
must not be confused with unmapped, unpublished or unknown identity. **Map
coverage stays mandatory at 100% of published inventory; photography does not.**

Reason:
An image is a claim about a place, and a claim needs the same provenance as every
other canonical fact (D025, D027) — an unattributed photograph is a rights
liability and a truth liability at once. Modelling media as a child resource is
what allows a hotel to have several images from several sources with different
rights bases, and what allows the supplier question to be answered later without
touching the hotel contract. Keeping provider precedence behind the data layer
means swapping a provider is a data-layer change rather than a UI rewrite, and
asking the data layer for "best eligible cover" is the only version of the
question that survives that swap.

Consequence:
Discover continues to render the approved no-photo state, and no `image_url`
column, media table or hotlinked third-party image is added as an interim
measure. Full contract in `PROPERTY_CONTENT_COVERAGE_CONTRACT.md` §14.

## D065 — Provider source data is isolated, bounded and never canonical by default
Status: Accepted — implemented by migration `0027`

The property-content source infrastructure (`source_runs`,
`source_property_identities`, `source_property_observations`,
`source_match_candidates`, `hotel_source_identities`,
`source_property_reviews`) carries five boundaries that are decisions rather
than schema details, because a later block could plausibly relax any of them by
accident.

### 1. Evaluation-environment data can never become canonical evidence

`source_environment` (`evaluation` | `production`) participates in the source
identity's unique key, and `hotel_source_identities` CHECKs
`source_environment = 'production'`. An evaluation record therefore cannot be
linked to a canonical hotel **at all** — not by a bug, not by a careless
script, not by a reviewer.

The CHECK alone would not have delivered that. It reads a denormalised column
the *linking row* supplies, so a link could point at an evaluation identity while
writing `production` and pass. A composite foreign key on
`(source_property_identity_id, source, source_environment, source_property_id)`
makes those labels the identity's own values, which turns the guarantee from
"the mismatch is detectable in a join" into "the INSERT fails". The same key
rejects a link that misstates the identity's provider or provider id.

The Hotelbeds *test* environment holds 3,275 Bali and 835 Dubai records that are
perfectly good evidence and are not production inventory. Distinguishing them by
convention would work until the first ingestion script that forgot.

### 2. Raw provider payloads do not live in Postgres

An observation stores typed, queryable columns plus a `source_payload_digest`
(sha256) and a nullable, opaque `source_payload_uri`. `source_attributes jsonb`
exists for unmodelled provider fields and is bounded to 8 KB **by trigger**,
because a documented rule with no mechanism is one the first convenient script
breaks.

**No object-storage product is chosen and none is required.** Every constraint,
index and query works with `source_payload_uri` NULL, so the storage decision
stays open without blocking ingestion.

### 3. Source facts are observations, and invalid ones are kept

Source coordinates carry **no range constraint**. The Bali evaluation returned
one out-of-range coordinate; a CHECK would have made that row unstorable and
forced the ingestion to drop, null or crash on it. `source_latitude` is an
observation, `source_coordinates_plausible` is the audit verdict, and
`hotels.latitude` remains the resolved canonical value (D063).

Likewise `source_classification_simple_code` is **text**, not numeric: Hotelbeds
`simpleCode 5` covers 5 STARS, 5 KEYS, aparthotel and hostel alike, and a
numeric column invites `where simple_code >= 4` — the one query that must never
produce inventory (D060).

And `source_classification_evidence_kind` admits **exactly one** value,
`provider_classification_evidence`. Allowing a `canonical_` value "subject to a
future product decision" would have let any ingestion script appoint its own
provider as star authority, with Postgres accepting it, while no
issuing-authority hierarchy exists to say otherwise. That judgement belongs to
the pre-publication star-resolution layer, not to the row being ingested.

### 4. Source observations are append-only

A future canonical star or coordinate cites `source_property_observations.id` as
its provenance. If the cited row can be edited or deleted, that provenance is a
promise the database does not keep — and `ON DELETE RESTRICT` on the parents
stops the *run* being deleted, not the observation.

So no client role holds UPDATE or DELETE on that table (`service_role` included —
the trusted boundary is not exempt from an invariant that exists to keep evidence
citable), and a trigger refuses both operations for the table owner as well, so
the guarantee survives a future migration that grants ALL for convenience. A
corrected fact is a new observation in a new run.

### 5. Provenance alignment is structural, and terminal states cost something

Run, identity and observation must agree on `source` and `source_environment`,
enforced by composite FKs rather than by application convention: with id-only
keys a Hotelbeds-evaluation identity could name a Nuitee-production run as the
run that saw it, and every individual row would still exist.

The same rule covers every run reference: a match candidate's `source_run_id` and
a review's `decided_in_run_id` are provenance, so they are composite-keyed too. A
citation that names an unrelated provider's run reads as evidence and is not,
which is worse than no citation.

For the same reason a resolution state must cost something the database checks.
`resolved_eligible` requires `promoted_hotel_id`, and that hotel must be **this
identity's own active canonical link** — under D062 a canonical property *is* a
published row, so the label cannot be typed ahead of the fact, and naming an
arbitrary existing hotel is not evidence that this identity produced it.

`duplicate_matched` requires a canonical hotel — deliberately **not** another
source identity. A source-to-source terminal target lets coverage close on a
cycle: A matched to B while B is matched to A leaves nothing `unresolved` and no
published property anywhere. Cross-source equivalence is real and is kept, as
pre-publication evidence in `source_match_candidates`, where accepting it
resolves nothing on its own.

And `agreeing_dimensions` is generated from the evidence columns rather than
supplied. A count stored beside the evidence it summarises is duplicate truth,
and duplicate truth drifts. It is a **summary of evidence, not a matching rule**:
there is no `agreeing_dimensions >= n` constraint and there must not be one,
because D063 §12.2 refuses a universal entity-resolution threshold and an integer
floor is still a threshold.

### What this does NOT establish

`0027` enforces that a terminal state is **structurally impossible to fake**. It
does not, and cannot, establish that the D062 conditions were met — no star
resolution, no location resolution, no promotion preview, no apply authorization
and no resolution engine exists yet.

So the boundary is:

> **Migration 0027 prevents structurally false terminal states and provides the
> integrity boundary the future resolution/promotion engine will use. That future
> block remains responsible for authorizing the semantic transition into those
> states.**

Concretely: the schema guarantees that an identity claiming `resolved_eligible`
really does have its own active canonical link to the hotel it names. It does not
guarantee that the hotel should have been published. Those are different claims,
and conflating them would be the same category of error this decision exists to
prevent — so no placeholder D062 columns are added to imply otherwise.

Reason:
Each of these protects against a failure that is invisible in the output. Test
data reaching creators, a payload column quietly costing storage forever, a
range check silently deleting the bad values most worth auditing, and a numeric
cast turning a category code into a star rating are all mistakes that look like
working systems.

Consequence:
Provider ingestion, the D062 promotion gate, Coverage Engine and `hotel_media`
all build on these tables without relaxing the boundaries. A future block that
needs evaluation data promoted, or payloads in Postgres, is making a new product
decision and should say so. Full model in
`PROPERTY_CONTENT_IMPLEMENTATION_SPEC.md`.

## D066 — Canonical star classification is PRODUCT truth, resolved from an approved provider policy
Status: Accepted — amends the *interpretation* of D060. D060 itself stands.

D060 said the classification must be justifiable, and deliberately did not choose
an authority hierarchy. Implementation work then read "canonical" as "certified by
a government or tourism registry", and locked Hotelbeds out of D060 resolution on
the grounds that no issuing authority was established.

**That interpretation is superseded.** It does not scale: it would make V1
inventory depend on building country-by-country hotel-classification compliance
pipelines, and that is not the product.

### What "canonical" means

> **Canonical classification is theugc.life's resolved PRODUCT truth, backed by
> accepted source evidence — not a fact that must have been independently
> certified by a government authority.**

Official registries stay valuable evidence, especially for resolving a conflict
or auditing a decision. They are **optional**, never a precondition.

### One approved provider is sufficient

A single approved provider observation **can** resolve a property's canonical
classification, when a reviewed provider-specific policy maps that exact
field/code to an unambiguous exact hospitality classification.

**There is no two-source minimum and no government-authority requirement.**

### The unit of review is the PROVIDER, not the property

This is the part that makes it scale. We do not research 4,110 hotels; we review
one mapping:

```
provider + field/code + semantics + version
  → exact_four | exact_five | classified_not_v1_scope | unresolved
```

The mapping is reviewed once, versioned, and applies to every property carrying
that code. Approving a provider's *classification policy* is a product decision;
applying it is mechanical.

### A provider still never declares itself canonical

```
provider observation → reviewed provider classification policy → star resolver
  → canonical product classification + provenance
```

The observation stays source evidence (D065 §3). The policy is ours, not the
provider's. The resolver — a future block — owns canonical truth. So the
source-agnostic architecture is unchanged: what moved is *how much evidence a
resolution needs*, not *who gets to decide*.

### Second sources: corroboration, and exception handling

- **Agreement** → keep the canonical value, add corroborating provenance.
- **Conflict** → do **not** average, do **not** silently flip. Mark a
  classification conflict and send it to REVIEW, resolvable by another approved
  provider, an official source, hotel-owned evidence, or manual research.

That is exception handling. It is **not** a mandatory second lookup per hotel.

Existing published properties are not deleted or mutated merely because a later
conflicting source appears; post-publication conflict lifecycle remains a future
concern and is not invented here.

### Classification ≠ coverage

Removing the two-source rule for *classification* says nothing about whether one
provider contains every real property. Coverage remains a separate dimension: a
Provider B may later expand the destination universe (union → identity resolution
→ coverage), and Provider B is **not** required to re-check the classification of
every Hotelbeds property.

### What D060 keeps, unchanged

Exactly 4 or exactly 5 · guest-review scores are never classification evidence ·
never average conflicts · unknown stays REVIEW/unresolved · source observations
survive resolution · property type neither admits nor excludes, so resorts,
aparthotels, lodges, residences and villa-style hospitality properties may
qualify on their own classification.

Reason:
The old reading confused *provenance* with *certification*. D060 asks the system
to answer "why does theugc.life consider this a 4-star property?", and "an
approved provider published the code `4EST`, whose semantics we reviewed and
accepted on this date under this policy version" is a complete, checkable,
contestable answer. Demanding a registry entry as well answers a question the
product never asked, and answers it in 190 different legal regimes.

Consequence:
The star-resolution block builds against reviewed provider policies rather than
per-property research. Hotelbeds becomes usable for D060 resolution through an
explicit reviewed code mapping — see
`docs/PROPERTY_SOURCE_CLASSIFICATION_POLICY.md` — and the PR #21 finding that
`simpleCode` alone is unusable is **preserved**, because the mapping is on the
category code, never on `simpleCode`.

## D067 — Gmail is a private communication plane with two separate consents
Status: Accepted — closes the primary-source Gmail/OAuth/privacy contract
MASTER_PLAN §5.7 required before historical import

Phase B connects creator mailboxes. That data is not provider inventory and must
not be modelled as if it were.

### Scopes are a contract, not a preference

Historical intelligence requires
`https://www.googleapis.com/auth/gmail.readonly`, a Google **restricted** scope.
`gmail.metadata` is rejected: it exposes no message body, it disables the
`q` search parameter the import depends on, and it is *also* restricted — it
would buy the same verification burden and deliver a product that cannot answer
the question.

Sending, when it exists, uses `https://www.googleapis.com/auth/gmail.send`
(**sensitive**), requested **later through incremental authorization**, never
bundled into the initial connection. `mail.google.com`, `gmail.modify`,
`gmail.compose`, `gmail.insert` and the settings scopes are **not requested**
without a new decision; they trade a marginally simpler implementation for the
ability to alter and delete a human's mail.

Restricted-scope verification, Limited Use, the applicable security assessment,
deletion capability and accurate public disclosures are **product constraints**,
not implementation details.

### Limited Use follows the data, including what is derived from it

Google's Limited Use rules apply to data aggregated, anonymized or derived from
Gmail. A reply classification, response time, offer value or negotiation outcome
**remains Gmail-derived** when Gmail was its origin. Discarding the body does not
launder the obligation, and no code path may model
`raw Gmail → extracted fact → ordinary global data`.

### Two consents, and the second is optional

`private_gmail_processing` ("process my mailbox to provide MY OWN workflow and
intelligence") is required for the product to function at all.

`network_intelligence_contribution` ("let eligible privacy-safe derived signals
contribute to aggregated features") is **separate, explicit, revocable and
default NOT granted**. Connecting a mailbox must deliver real private value with
it false, or the second consent is a dark pattern. The absence of a receipt is
never consent.

D019's dataset moat and D009/D050's aggregation privacy rules are unchanged —
this decides *how a contribution becomes eligible*, not whether aggregates are
valuable.

### Staff hold no private mail access by role

`public.is_admin_or_editor()` governs editorial and provider evidence because
reviewing hotel data is staff work. It governs **nothing** in the private
communication plane. Support inspection, abuse investigation and legal
compulsion require a separately contracted, audited mechanism.

### Consent state is the LATEST decision, and the database owns the order

"May we?" is answered by the most recent thing the human decided, which requires
the database to know which decision is most recent. `decided_at` is supplied by
the caller and can be back-dated; `created_at` is transaction start time and is
identical for two receipts written together; a random UUID's lexical order is not
chronology. So consent receipts carry a database-generated monotonic ordinal, the
current-consent projection names the receipt holding the greatest one, and the
projection may never move backwards. Re-granting after a withdrawal happens ONLY
through a new granted decision — never by pointing at the old one again.

A recorded withdrawal that does not take effect is the failure this closes, and
it is worse than a withdrawal that was never offered: the receipt makes the
product look compliant while the permission stays on.

### Consent is scoped to the access that actually existed

A consent receipt records the scopes in force when the human decided, and that
snapshot is checked against the mailbox rather than accepted from the writer.
Incremental authorization can widen access later; Google's screen asks about
ACCESS, not about what this product may do with the data. So a change to the
scope set — widening or narrowing — requires a new `private_gmail_processing`
receipt naming the new set before the mailbox may be `connected` again.

### A durable provider identity has one app owner

`(provider, provider_account_subject)` — Google's stable subject, never the email
address — identifies a real Google account. It belongs to exactly ONE app user
for as long as any of its mail-account history exists in the product, retired
records included. Shared inboxes, agency delegation and cross-tenant transfer are
not implemented, and none of them is reachable by editing a column.

The subtlety is that this cannot be a uniqueness rule on the mailbox table.
Making it full forbids the same-owner reconnection that terminal deletion
requires; restricting it to live rows permits that reconnection but stops the
database seeing retired ones, so a second app user could claim a Google account
whose previous owner's consent receipts and deletion record are still on file.
Ownership therefore lives in its own registry keyed by the durable identity,
spanning a mailbox's whole history, while a separate live-row rule keeps a single
usable connection at a time.

Two consequences are decisions, not details. A creator may always reconnect their
own Google account, as a NEW mail account inheriting no consent and no history.
And erasing an app user releases the reservation along with the rest of their
private plane — a reservation that outlived its human would ban a Google account
permanently with nothing left in the product to protect. That erasure is the
ONLY release: while the owning user exists the reservation cannot be removed by
anyone, including the trusted server role and the database owner, whether or not
any mailbox still references it. Otherwise deleting a mailbox row and then its
reservation would move a Google account between app users with the owner
untouched, which is the transfer this decision refuses.

### Disconnect is not delete, and deletion is terminal

Stopping provider access and deleting stored data are different acts with
different consequences, and the model represents both. `deleted` requires a
completed deletion request **that asked for the record to be retired** — a
completed `gmail_derived_data` request means the opposite, that derived data goes
and the account record is kept so the connection stays auditable.

`deleted` is terminal. The record asserts that stored Gmail data was removed; a
revived row would make that assertion false while still carrying the completed
deletion as its evidence. A returning creator reconnects as a NEW mail account
with a new authorization and a new consent, which is the honest record of a
second, separate grant of access.

### Deletion must stay addressable

Every Gmail-origin or Gmail-derived row must be traceable to its mail account AND
its owner. A derived record whose owner provenance is lost cannot be deleted on
request, which is an obligation rather than a preference.

Reason:
Gmail data is the one place where a modelling shortcut is simultaneously a
compliance failure, a trust failure and a product failure. The boundary is
therefore fixed before the first message is stored, rather than discovered during
verification.

Consequence:
B01 implements the boundary (`docs/B01_GMAIL_DATA_BOUNDARY_CONTRACT.md`,
migration `0035`). B02 implements OAuth against it, B03/B04 import and normalize
under it, and the C-phase intelligence may consume only what G3 admits.

B02 external audit amendment #7 (2026-08-28) settled that **an operation that
spans a network call needs a compare-and-swap on the thing it operated on, and
that the result of that swap must be checked rather than assumed.**

Disconnect is prepare → revoke at Google → finalize, and the two database steps
are separate transactions. Amendment #6 made the window between them one in which
the credential can legitimately CHANGE: a superseded OAuth callback replaces the
stored token with the fresh one representing a newer grant, precisely so that
grant can still be revoked. Finalize checked only that a Disconnect was
outstanding, so an older finalizer could delete a credential it had never sent to
Google — and with `invalid_token` on the old token, which proves nothing about a
newer one, the end state was `disconnected` locally, no credential anywhere, and
the newer grant still live with nothing able to revoke it. That is the state
amendment #6 existed to make impossible, reached one step further along.

So the unit of a provider operation is now "credential generation G under
Disconnect intent I", not "something for mailbox A". Finalization compares both
under the row lock and refuses with `stale_disconnect_intent` or
`newer_revocation_material`, mutating nothing. A NULL expected generation is
information — there was nothing to revoke when this was prepared — so a credential
appearing since is newer material this caller never sent anywhere. A NULL
expected intent is refused outright. Both parameters are required, so the
unqualified two-argument finalizer does not exist: `service_role` is a
capability, not proof that a caller followed the protocol, and this is the third
time that sentence has had to be enforced rather than written down.

Two consequences worth stating as decisions. The provider's answer applies to the
token the provider was given, and the database is the only thing that knows
whether that token is still the one this operation is responsible for — so
`invalid_token` never overrides the CAS. And "we asked" is not "it happened":
both callers check the transport error AND the RPC's own result, and neither
reports a disconnection it did not complete.

The same amendment corrected two user-facing claims. `provider_unavailable` said
"nothing was changed", which stopped being true when prepare moved before the
network call — the mailbox is already `disconnecting` and its in-flight OAuth is
already cancelled; what is missing is Google's confirmation, and the copy now
says that. And `deletion_in_progress` was falling through to "that mailbox was
not found", which is a different and misleading thing to tell someone whose
deletion is running.

B02 external audit amendment #6 (2026-08-28) settled that **a lifecycle fence
must cover every OAuth flow, including the ones with no target, and that the
protocol steps are enforced by the database rather than remembered by callers.**

FIRST, **ordering of checks is a security property.** Amendment #5's
supersession test ran after the "is this state reconnectable?" refusal, and that
refusal answers `account_mismatch` for `disconnecting` — so the `disconnecting`
half of the condition was unreachable, in exactly the window where a live,
freshly-created grant is most likely to exist. The refusal that discards
information cannot run before the question that needs it. The order is now
identity, then supersession, then the ordinary lifecycle refusals. No state was
made writable that was not writable before; they simply get a truthful answer
about why they are refused.

SECOND, **the fence has to work before the Google account is known.** A revision
is a version of one known mailbox, so only a flow with a target can pin one. A
generic CONNECT has no target and nothing for a Disconnect to cancel, so a
"Connect another Gmail" begun before a Disconnect could come back with the
disconnected identity, exchange its code, and be waved through as an ordinary
refusal while Google's grant was active again. B02 therefore keeps two clocks
with two jobs: `authorization_revision` for the exact-version CAS on a known
target, and a shared monotonic `mail_account_lifecycle_intent_seq` drawn by every
OAuth transaction at its start and by every Disconnect at prepare, which makes
"did this flow begin before that Disconnect?" a single comparison available to
targeted and generic flows alike. A sequence, not a timestamp.

THIRD, **the one revocation B02 performs on a refused callback must be durable.**
It is a network call, and the only thing that can remove the grant is the token
that callback just received. Losing it on a transient failure could leave the
mailbox `disconnected`, no credential anywhere, and the authorization ACTIVE
forever. So the fresh credential is stored first — sealed, in `disconnecting`,
where no read path will use it — and revoked second, with the mailbox returning
to `disconnecting` if a Disconnect had already reported completion. A newer
successful Reconnect refuses both the store and the revoke: the human changed
their mind, and an older callback does not get to overrule that.

FOURTH, **`invalid_token` is evidence about one token.** On the token a
superseded callback just received it proves that grant's newest artifact is
unusable. On an older stored token it proves nothing about a newer concurrent
grant, and B02 does not infer otherwise — the newer grant is handled by the flow
that created it.

FIFTH, **a protocol is only a protocol if the database enforces its steps.**
`gmail_disconnect_finalize` now consumes only `disconnecting`, so nothing can go
from `connected` to `disconnected` without a recorded intent and a provider call;
and `gmail_grant_private_processing_consent` may connect only from
`consent_required`, so a consent form submitted before a Disconnect cannot land
after it and undo the newer decision. Both were reachable precisely because
amendment #5 deliberately retains the credential while `disconnecting`.
`service_role` is a capability, not proof that a caller followed the protocol.

B02 external audit amendment #5 (2026-08-28) settled that **Disconnect dominates
the provider, and a deletion owns the lifecycle while it runs.**

Amendment #3 made a stale callback lose, and amendment #4 made it lose reliably —
but it lost too late. The refusal happened at the persist step, AFTER the
authorization code had been exchanged, so a Reconnect flow that came back after a
Disconnect created a fresh live grant at Google that nothing then removed. The
mailbox read `disconnected` while the person's Google account had just been
reauthorized. That was reproduced at the audited head: one exchange performed,
zero revocations, the grant active again. B02's promise is Disconnect, not
"forget our copy of the token while Google may remain authorized".

The decision has three parts. FIRST, **the human's intent is recorded before the
network call, not after it**: a decision made only once Google answers cannot beat
a callback already in flight. `gmail_disconnect_prepare` cancels the mailbox's
outstanding OAuth transactions, moves the row to a new `disconnecting` state and
records the revision that request was made at — all in one transaction, before
anything is sent to Google. In the ordinary sequential case the stale callback
then resolves to no transaction at all and no code is ever exchanged.

SECOND, **`disconnecting` is a state, not a synonym.** Naming the row
`disconnected` before revocation resolved would be the application asserting
something it does not know, and naming it `connected` would contradict the person
who just pressed the button. It is the one state whose credential invariant is a
range — zero or one — because the credential is retained on purpose until the
revocation it is the only instrument for has resolved, and destroyed immediately
after. No read path treats it as usable, and Disconnect accepts it so a failed
revocation can be retried.

THIRD, **the one refusal that DOES revoke.** Amendment #2's rule stands
everywhere except one case: a callback that is stale specifically because a newer
explicit Disconnect of the same mailbox, aimed at the same verified Google
subject, superseded it. There the project-wide revocation is precisely what was
asked for. `account_mismatch`, `owned_by_other_user`, `reconnect_required`,
`already_connected`, an unrelated `state_changed` and a newer successful Reconnect
all still revoke nothing. These two cases must not be collapsed again: one is
discarding a token we did not want, the other is a person ending an authorization
while it was being created.

The same amendment stopped a user-facing Disconnect from reaching into a deletion
it does not own. `deletion_pending` names a specific request that is running and
the account surface says so; rewriting the row would clear the pointer that claim
rests on. Prepare and finalize both refuse it as `deletion_in_progress`, and
`deleted` as `account_retired`. B01's row-local CHECK had been catching the write
incidentally — as an unhandled `check_violation` rather than an answer — and the
new `disconnecting` state is exactly the kind of change that turns an incidental
protection into a crash at a worse moment.

B02 external audit amendment #4 (2026-08-28) made the lifecycle revision an
actual reservation rather than an observation. A plpgsql function is VOLATILE and
takes a fresh snapshot per statement, so comparing a revision without locking the
row is evidence about a row rather than a hold on it — reproducibly, a callback
could read revision N, a Disconnect could commit N+1, and the callback's later
writes would still land. The reconnect target is now loaded `for no key update`
before anything is compared, and that lock is held through the credential write.

The same amendment established that a SUCCESSFUL RECONNECT CONSUMES THE REVISION
IT USED, even when it changes neither state nor scopes: landing a fresh Google
credential is itself a provider-authorization event, and without it two flows
begun against the same version could both land, the second silently replacing the
first's credential. The persist function requests the bump and the trigger
chooses the number, because a revision the application could pick would not be
database-owned — and for the same reason the trigger now fires on INSERT as well
as UPDATE. Background refresh rotation deliberately does not bump: it is not a
human authorization event, and `credential_generation` is already the clock for
it.

Two product-truth corrections went with it. The consent prompt now follows the
STATE rather than the consent projection: `consent_required` with a `granted`
consent for a NARROWER scope set is a real and correct combination, and keying on
the projection left it unreachable — "Awaiting your permission" with no way to
give it. And the B02 contract's remaining sentences instructing a refused
callback to revoke the grant were removed; that document is an implementation
input, and one stale line is how the project-wide revocation defect closed in
amendment #2 gets reintroduced.

B02 external audit amendment #3 (2026-08-28) extended the causality reasoning
from credentials to AUTHORIZATION. Amendment #2 established that a refresh spans
a network call and therefore needs a generation; OAuth spans a much longer one —
we hand the browser to Google and the callback arrives whenever the human returns
— and had no equivalent. So an intention could outlive the decision that replaced
it: a Reconnect started before an explicit Disconnect landed afterwards, stored a
fresh credential, and put the mailbox back to `connected`.

`mail_accounts.authorization_revision` is the fix, and the important part of it
is that it is a REVISION rather than a state check. A mailbox can leave a
reconnectable state and come back to one, so a callback that verifies only the
state name finds the word it expects while knowing nothing about the decisions in
between. The revision is database-owned, advanced by trigger on lifecycle change,
and never caller-settable — which also means a direct SQL change invalidates
in-flight OAuth exactly as a server action does. A reconnect pins it at start and
must match it exactly at the callback; a flow cannot even begin against a mailbox
that is not reconnectable right now.

The same amendment narrowed B01's CASE B: a generic CONNECT may no longer revive
an existing live mailbox. It cannot pin a revision for an identity it does not
learn until the callback, so it would be the one door with no snapshot to check.
It answers `reconnect_required` and persists nothing; the human uses the explicit
Reconnect action, which does pin one. And the migration guard was completed to
cover every invariant that can already be false — a `pending_authorization` row
with a non-empty scope set is valid under 0035 and forbidden by 0036, so 0036 now
refuses to install on one rather than finishing incoherent.

B02 external audit amendment #2 (2026-08-28) settled that **the Google Cloud
project used for the Gmail integration is an authorization domain**. Google's
programmatic token revocation removes every OAuth 2.0 scope previously granted to
the PROJECT for that user and invalidates the issued tokens for all clients under
it — so revocation is an operation on the (user, project) grant, and there is no
per-token call. Two rules follow, and both are decisions rather than
implementation notes.

FIRST: revocation is not a rollback primitive. B02 used it as callback cleanup,
which meant a refused authorization destroyed whatever else that person had
authorized this project to do. The worst case was reproducible: a stranger
authorizing a Google account they do not own was correctly refused by B01's
ownership rule, and the refusal disconnected the legitimate owner. A refused
callback now persists nothing and revokes nothing, and the contract states the
honest cost — the application may still appear in the person's Google account
although we hold no usable token. Explicit Disconnect still revokes, because
there the project-wide operation is exactly what was asked for.

SECOND: unrelated Google integrations may not share this OAuth project. Calendar,
Drive, any other Google OAuth integration, and application login flows whose
grants must survive a Gmail disconnect all need a separate project and a new
security contract — otherwise "disconnect Gmail" silently signs someone out or
breaks their calendar. `gmail.readonly` and a future incremental `gmail.send`
belong to the same integration and may share the domain deliberately.

The same amendment made credential mutation causal rather than last-write-wins: a
refresh spans a network call, so every mutation derived from a loaded credential
names the generation it came from and is refused if that is no longer current. A
stale worker can no longer overwrite a newer token, delete one it never saw, or
undo a Disconnect. And 0036 now REFUSES TO INSTALL rather than completing while
the invariant it establishes is already false.

B02 external audit amendment #1 (2026-08-28) added `consent_required` to the
connection-state vocabulary. D067's state words were written before any
credential existed anywhere in this system, so `pending_authorization` was
defined as "the human has not completed Google's consent screen; no access" — a
sentence B02 made false, because after a successful authorization we hold a
verified `sub`, the approved scope set and a usable refresh token while still not
having asked the product question. The addition is deliberately ADDITIVE:
`pending_authorization` keeps its merged meaning exactly, migration `0035` is
untouched, and `0036` ALTERs the CHECK it created. Reusing the old word would
have left the database asserting "no access" about a mailbox that could be read
that second, and every later reader — support, an export, a deletion routine, an
auditor — would have inherited it.

The same amendment fixed what a state word is allowed to assert on its own: the
correspondence between the state and the stored credential is now a deferred
database invariant (`connected`/`consent_required` ⇒ exactly one credential;
every other state ⇒ none), and only `invalid_grant` may destroy a credential —
`invalid_client`, `unauthorized_client` and `invalid_request` are errors about
OUR client and OUR request, and treating them as proof that a creator's token
died would delete credentials to punish a mistyped environment variable.

External audit amendment #3 (2026-08-27) added the release rule above, after the
same cross-owner transfer proved reachable at amendment #2's head by deleting a
mailbox row and then its ownership reservation, with the owning user untouched.

External audit amendment #2 (2026-08-27) added the durable-provider-identity
paragraphs above. Amendment #1's terminality work had traded the full uniqueness
on `(provider, provider_account_subject)` for a live-rows-only index in order to
permit same-owner reconnection, and that silently allowed one Google account to
move between app owners; it too was reproduced as a real committed state before
being closed.

External audit amendment #1 (2026-08-27) added the event-ordering, scope-snapshot
and deletion-terminality paragraphs above after all four were reproduced as real
committed states on PostgreSQL using nothing but direct SQL. They are stated as
decisions, not implementation notes, because each one changes what a writer is
allowed to do: B02 must record a mailbox's scopes and its consent in one
transaction, must renew private-processing consent when it adds `gmail.send`, and
must treat a retired mail account as gone rather than reusable, and must handle a
refused connection when the Google account is already owned by a different app
user.
