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
confirmed-deal signal; editorial evidence and pipeline status alone are never
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
| emerging | + `activity_level`, `has_confirmed_collaboration` |
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
