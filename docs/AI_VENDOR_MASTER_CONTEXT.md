# TheUGC.life — Master Business, Product, Technical & AI Context

**Purpose:** self-contained handoff for any AI, engineer, technical advisor, investor, implementation agent, or vendor evaluator that needs to understand what TheUGC.life is, what has already been built, what remains before launch, and what AI architecture the company actually needs.

**Snapshot date:** 2026-09-11  
**Repository:** `brianblisniuk/theugc-life`  
**Main at this snapshot:** `c6cd180ea27a3901a365526a29371121f8cedc5c`  
**Implementation frontier:** B06 merged (PR #38); D072/B07 contract accepted; B07 implementation is next  
**Payment provider:** Rebill (`rebill.com`) — accepted  
**Initial market:** travel UGC creators  
**Long-term company:** Creator Operating System across multiple verticals

> If this file ever conflicts with a later accepted decision, the repository source hierarchy at §24 wins.

---

# 0. The shortest possible explanation

TheUGC.life is not intended to be just a hotel database, email finder, AI email writer, or CRM.

> **It is intended to become the operating system that helps creators find, win, manage, complete, and learn from commercial opportunities.**

Travel is the first vertical.

The simplest comparison with a basic outreach tool is:

```text
Yukolab:
find hotel
→ find email
→ send email

TheUGC.life:
find hotel
→ decide if it is worth the effort
→ identify the best available contact
→ build the pitch
→ send
→ follow the conversation
→ negotiate
→ record whether it worked
→ manage the collaboration
→ record deliverables/value/outcome
→ use that history to improve the next decision
```

The moat is not “AI writes emails.”

The long-term advantage should come from:

1. a complete creator workflow;
2. integrated context across modules;
3. proprietary longitudinal operating history;
4. personal intelligence;
5. privacy-safe network intelligence;
6. creator-specific decision support;
7. high-quality canonical target/contact data;
8. eventually agency and multi-vertical network effects.

Core flywheel:

```text
TARGET
→ CONTACT
→ OUTREACH
→ REPLY
→ NEGOTIATION
→ OUTCOME
→ STRUCTURED EVIDENCE
→ PERSONAL + NETWORK INTELLIGENCE
→ BETTER NEXT TARGET / CONTACT / PITCH
→ MORE USAGE
→ MORE OUTCOMES
```

---

# 1. Company vision

The long-term product should be the place a creator opens to:

- find opportunities;
- decide which opportunities deserve effort;
- understand the target/business;
- find the right route/person to contact;
- generate and personalize a pitch;
- send from their own mailbox;
- manage replies and follow-ups;
- negotiate terms;
- manage collaborations;
- manage deliverables;
- track cash, hosted value, hybrid value, or other compensation;
- record final outcomes;
- reuse completed work as portfolio/proof;
- understand what works personally;
- benefit from privacy-safe collective intelligence;
- make better decisions next time.

Long-term loop:

```text
OPPORTUNITY
→ TARGET / BRAND / BUSINESS
→ CONTACT
→ OUTREACH
→ CONVERSATION
→ DEAL
→ DELIVERABLES
→ COMPENSATION / VALUE
→ OUTCOME
→ INTELLIGENCE
→ BETTER NEXT DECISION
```

## 1.1 Travel is the wedge, not the final market

Travel is first because:

- creators plan around destinations;
- a destination contains many possible commercial targets;
- contacting the wrong properties wastes meaningful time;
- hotel/agency contacts are fragmented;
- collaboration outcomes can be high value;
- creators repeat the workflow across multiple trips per year;
- the target universe is structured;
- historical inboxes can potentially bootstrap proprietary outcome data.

Future verticals may include:

- restaurants;
- tourism boards;
- experiences/tours;
- airlines;
- cruises;
- beauty;
- fashion;
- food and beverage;
- fitness;
- technology/apps;
- ecommerce;
- other UGC-heavy categories.

**Architecture rule:** do not prematurely replace the travel schema with one giant generic `business` table. Finish travel well, then extract only concepts proven shared by a second vertical.

Likely long-term shared concepts:

```text
WORKSPACE
CREATOR
TARGET
CONTACT
OPPORTUNITY
OUTREACH
THREAD
DEAL
DELIVERABLE
OUTCOME
```

Vertical-specific target data remains vertical-specific.

---

# 2. Commercial thesis and moat

Users are not fundamentally paying for “a list of emails.”

They are paying to reduce the time, uncertainty, and failure rate involved in creator business development.

Travel promise:

> **I am planning a trip. Show me the properties worth my time, help me reach the right people, manage the entire collaboration process, and help me improve each time.**

## 2.1 Commodity vs proprietary

### Buy/integrate commodity inputs

- hotel inventory/content;
- generic contact discovery;
- email verification;
- maps/geocoding;
- foundation AI models;
- billing rails.

### Build/own

- canonical identity and provenance;
- creator workflow/context;
- historical operating record;
- privacy and permission boundaries;
- target/contact/outreach semantics;
- reply/outcome taxonomy;
- personal intelligence;
- network intelligence;
- confidence/freshness;
- ranking/prioritization;
- deal/collaboration/deliverable workflow;
- human correction/audit history;
- integrated UX.

Rule:

> **Buy/integrate commodity inputs; own workflow context, event history, intelligence, trust boundaries, and high-value product logic.**

## 2.2 Potential data moat

Public hotel/contact data can be reproduced. Longitudinal creator outcome data is harder to reproduce.

Potential long-term graph:

```text
target/property/brand
× creator archetype
× niche
× audience geography
× contact role
× outreach characteristics
× send date
× reply/no reply
× reply delay
× number/timing of creator touches
× negotiation path
× collaboration type
× compensation/value
× final outcome
× freshness
```

Potential questions:

- Which targets actually respond to creators?
- Which contact roles perform best?
- How long do targets usually take to reply?
- Does a second creator touch correlate with response?
- Which collaboration types occur most often?
- What works for creators similar to this creator?
- What works specifically for this creator?
- Which destinations/target types are highest ROI?
- Which outreach patterns correlate with outcomes?

This is a hypothesis to validate with real data, not permission to fake predictive precision.

---

# 3. Commercial model

## 3.1 Free

Purpose:

- acquisition;
- prove the opportunity universe exists;
- demonstrate public intelligence;
- let creators experience the workflow.

Current documented direction:

- all publishable hotels remain discoverable;
- public/basic hotel information;
- safe Public Intelligence where privacy/confidence permits;
- save up to 10 hotels;
- 5 active pipeline items;
- 1 active trip;
- basic creator profile.

Free does not receive:

- Premium Intelligence;
- premium/actionable contacts;
- AI outreach.

Limits should remain configuration-driven.

## 3.2 Creator Destination Pass

Accepted V1 contract:

- **USD 39**;
- **30 days**;
- **one destination**;
- price/duration configurable.

Job:

> “I am going to Bali and I want to get collaborations.”

Inside entitled destination:

- Premium Intelligence;
- premium/actionable contacts;
- full workflow;
- Trips;
- creator profile/portfolio;
- no artificial hotel cap.

Outside destination:

- worldwide discovery remains;
- public intelligence remains;
- premium intelligence/contacts lock;
- normal Free limits apply.

Expiry must never delete creator-owned history.

## 3.3 Creator Pro

Accepted V1 launch price:

- **USD 199/year**;
- worldwide.

Job:

> “I am a travel creator and I want TheUGC.life to be my operating system.”

Includes worldwide:

- Premium Intelligence;
- premium/actionable contacts;
- full workflow;
- Trips;
- portfolio/profile;
- later approved AI/outreach capabilities when actually built.

## 3.4 Agency / Manager

Future commercial product.

Strategic reasons:

- higher ARPU;
- potentially lower churn;
- more workflow events per account;
- denser outcome history;
- substantial multi-creator operational pain.

Expected capabilities:

- organization/workspace;
- multiple managed creators;
- seats/roles;
- assignments;
- shared pipeline/contact context;
- private creator boundaries;
- calendar;
- reporting;
- creator performance;
- agency analytics;
- agency billing/limits.

Pricing is not yet accepted.

## 3.5 Payment rail

Accepted decision:

> **Use Rebill (`rebill.com`) as payment provider.**

Provider selection is closed. Integration details remain pending.

## 3.6 Future commercial branches — not MVP commitments

Potential later branches:

- hotel/brand/business accounts;
- business-side creator discovery;
- inbound campaign opportunities;
- creator relationship management;
- business-side collaboration administration;
- creator↔brand marketplace;
- business analytics;
- second verticals.

The product may monetize access to intelligence as a feature, but must never sell creators’ raw private mailbox data. Businesses must not be able to pay to alter behavioral metrics.

---

# 4. Product branches/modules

## 4.1 Discover

User job: find relevant commercial opportunities without manually searching the web.

Travel direction:

- destination search;
- hotel list/map;
- 4/5-star V1 scope;
- filters;
- save/shortlist;
- public intelligence;
- premium intelligence;
- freshness/data-strength visibility.

Strategic role: acquisition surface + table stakes.

## 4.2 Target / Property Detail

User job: decide if a target deserves effort.

Eventually combines:

- identity/location/classification;
- property media;
- creator activity;
- reply behavior;
- reply-time band;
- observed collaboration types;
- confidence/freshness;
- contacts;
- personal history;
- trip/pipeline state.

## 4.3 Contacts

User job: reach the best available person/route, not merely any email.

Needed:

- generic contact route;
- named marketing/PR/partnership/social/management contacts;
- role;
- provenance;
- verification;
- freshness;
- alternate route;
- later role-performance intelligence.

Critical distinction:

```text
CONTACT ROUTE
!= TARGET CONTACT
!= COMMERCIAL TARGET
```

Email must never become business identity.

Snov.io is a plausible future contact/enrichment provider but is not an accepted exclusive provider.

Useful shorthand:

> **Snov.io can help us know WHO to contact. TheUGC.life owns the knowledge of WHAT HAPPENS AFTER.**

Never give a contact provider raw Gmail bodies, private replies/negotiations, or reconstructable creator→business outcome histories without a new privacy contract.

## 4.4 Trips

- destination;
- dates;
- saved targets;
- priorities;
- outreach state;
- deadlines;
- confirmed collaborations;
- calendar;
- generated value;
- trip outcomes.

Trips convert a generic CRM into a travel-native workflow and create repeat-use context.

## 4.5 Pipeline / CRM

Canonical direction:

```text
SAVED
→ CONTACTED
→ WAITING
→ REPLIED
→ NEGOTIATING
→ WON / LOST / GHOSTED
→ COLLABORATION
→ COMPLETED
```

Existing repo foundations include pipeline/event-ledger/negotiation/collaboration logic. Extend; do not rebuild casually.

Needed:

- one current state source of truth;
- immutable/auditable event history;
- next action;
- follow-up due;
- notes;
- trip/thread/deal links;
- later assignment/ownership for agencies.

## 4.6 Gmail / Inbox

Historical purpose:

- find pre-existing commercial outreach;
- identify targets;
- reconstruct reply chronology;
- classify outcomes later;
- bootstrap historical outcome density;
- test whether the intelligence thesis has enough data.

Ongoing sync later:

- detect new sends/replies;
- compute response timing;
- stop/adjust follow-ups;
- update operational state;
- capture outcome evidence without manual reporting.

## 4.7 AI Assistance

AI is a **service layer across the OS**, not the positioning of the company.

Potential tasks:

- pitch drafting;
- personalization;
- follow-up drafting;
- reply summarization;
- reply/outcome classification;
- offer extraction;
- deliverable extraction;
- negotiation assistance;
- offer comparison;
- collaboration-type extraction;
- contact-role inference;
- creator-fit recommendations;
- recommendation explanations.

AI output must never silently become verified truth.

## 4.8 Outreach Composer / Sending

Later loop:

- select target/contact;
- use creator/target/trip context;
- compose/personalize;
- send through creator mailbox;
- record exact sent event;
- schedule/manual follow-up;
- safe sending limits;
- reply-aware sequence stop.

## 4.9 Negotiation / Deal Workspace

- incoming request;
- creator proposal;
- offer history;
- deliverables;
- dates;
- cash compensation;
- hosted value;
- hybrid structures;
- rights/usage notes;
- next action;
- agreement/rejection reason.

## 4.10 Collaboration Workspace

- target;
- participants;
- dates;
- collaboration type;
- agreed value;
- deliverables;
- deadlines;
- links;
- approvals;
- notes;
- completion;
- final outcome.

## 4.11 Deliverables

- type;
- quantity;
- platform;
- due date;
- status;
- file/link;
- approval;
- revisions;
- usage rights;
- completed timestamp.

## 4.12 Creator Profile / Context

Potential context:

- creator type;
- niches;
- platforms;
- audience-size bands;
- audience geography;
- languages;
- portfolio categories;
- preferred collaboration types;
- travel style;
- history.

Collect only what improves decisions.

## 4.13 Personal Intelligence

Answers: **what works for this creator?**

Potential outputs:

- reply rate by target type;
- best contact roles;
- best outreach/follow-up patterns;
- destinations with strongest results;
- collaboration mix;
- time-to-deal;
- value per trip;
- repeat relationships;
- personal funnel.

## 4.14 Creator Network Intelligence

Answers: **what usually works across privacy-safe cohorts?**

Potential outputs:

- creator activity;
- reply-rate band;
- reply-time band;
- recency;
- collaboration types;
- confidence/data strength;
- contact-role performance;
- creator-fit signals;
- deal/value patterns.

Rules:

- unknown ≠ zero;
- no fake precision;
- freshness matters;
- confidence/sample context visible;
- no opaque magic score;
- no pay-to-improve behavioral metrics;
- higher-level cohorts only after predictive value is proven.

## 4.15 Portfolio / Proof

Do not build a generic Canva clone. Generate proof from verified operating history:

- completed collaborations;
- deliverables;
- content links;
- brands/properties;
- selected outcome/value context;
- testimonials/performance later.

## 4.16 Agency Workspace

Explicit organization tenancy, RBAC, creator assignments, shared operations, creator-private boundaries, reporting, billing, analytics.

## 4.17 Billing / Entitlements

One canonical inventory, different data/feature access. Do not create a separate “paid hotel inventory.”

## 4.18 Admin / DataOps

Provider runs, unresolved identity, publication reviews, enrichment/media queues, freshness, anomalies, corrections, policy versions, experiment monitoring.

---

# 5. Current technical architecture

## 5.1 Core stack

Current repository stack:

- Next.js 15 App Router;
- React 19;
- strict TypeScript;
- Node >=20;
- Supabase;
- PostgreSQL;
- Supabase Auth;
- PostgreSQL RLS;
- Tailwind CSS v4;
- Zod;
- Vitest;
- real PostgreSQL DB/permission/concurrency tests;
- PostHog as current analytics implementation/approved equivalent;
- GitHub Actions CI.

Relevant dependencies include `@supabase/supabase-js`, `@supabase/ssr`, `google-auth-library`, `addressparser`, `pg`, and `tsx`.

Rule:

> Do not introduce distributed/enterprise infrastructure merely because it sounds scalable. Add complexity when throughput, latency, or operations prove it is needed.

## 5.2 Five architectural planes

### A — Source / Public Data

```text
provider
→ adapter
→ source run
→ source identity
→ observation
→ reviewed policy/resolution
→ publication decision
→ canonical target
```

Purpose: trustworthy external facts with provenance.

### B — Creator Operational

```text
creator
→ trip/opportunity
→ target
→ contact
→ pipeline
→ conversation
→ deal
→ collaboration
→ deliverable
→ outcome
```

Purpose: creator system of record.

### C — Private Communications

```text
mail account
→ raw provider evidence
→ normalized message/thread
→ commercial outreach interpretation
→ reply chronology
→ outcome interpretation
```

Purpose: automate the operational record without forcing manual entry.

### D — Intelligence

```text
verified/derived events
→ privacy-safe aggregation
→ confidence/freshness
→ personal/cohort metrics
→ ranking/recommendation
```

Purpose: improve future decisions.

### E — Commercial / Entitlement

```text
plan/pass/workspace
→ entitlement
→ feature/data access
```

Purpose: monetize without corrupting canonical data truth.

---

# 6. Evidence-first truth model

The system deliberately separates different kinds of truth.

## External source evidence
Provider data is evidence, not automatically canonical.

```text
source evidence
→ review/resolution policy
→ human/review gates where necessary
→ canonical publication
```

Bad merge is worse than temporary ambiguity/duplicate.

## Private Gmail raw evidence
Private content/metadata acquired under Gmail rules. Not public product data.

## Deterministic normalized Gmail projection
B04 normalizes threads/messages/headers/participants/references/text. It does not claim business meaning.

## Machine-interpreted private facts
B05 adds outreach, targets, recipients, candidate links, etc. Machine truth is replaceable/versioned.

## Human truth
Creator confirmations/corrections are authoritative. Machine reruns cannot overwrite human truth silently.

## Canonical-linked
A private target observation can have 0, 1, or N canonical links. The private fact exists independently of the catalogue.

## Outcome-linked
Future B07+.

## Network-eligible
Later privacy-safe stage. Gmail-derived data does not become unrestricted global data merely because it is structured.

---

# 7. Privacy / Gmail boundary

This is a hard product constraint.

## 7.1 Scopes

Historical analysis requires `gmail.readonly`.

Later sending uses `gmail.send` through incremental authorization.

Do not automatically request broader modify/delete/settings scopes.

## 7.2 Two consents

### `private_gmail_processing`
Required to process Gmail for the creator’s own private workflow/intelligence.

### `network_intelligence_contribution`
Separate, explicit, revocable, default OFF.

Connecting Gmail does not imply network contribution.

## 7.3 Data classes

- G0 — account/auth metadata;
- G1 — private Gmail content;
- G2 — private Gmail-derived facts;
- G3 — privacy-safe network-eligible aggregates/intelligence.

## 7.4 Limited Use principle

Derived Gmail data remains Gmail-derived.

```text
Gmail body
→ “reply received in 4 hours”
```

The response-time fact does not become ordinary unrestricted global data simply because the body was discarded.

## 7.5 Disconnect vs delete

Disconnect may retain history.

Deletion removes covered Gmail-origin/Gmail-derived data.

Retention and permission for **new processing** are different.

Staff/admin/editor do not get standing access to raw/private Gmail content merely because they have an internal role.

---

# 8. What has already been built

## 8.1 Phase A — Canonical Travel Truth

**Code gate complete.**

Major merged foundations include:

- provider-source infrastructure;
- source identities/observations;
- provenance;
- Hotelbeds evaluation corpus;
- hospitality-scope policy;
- entity-resolution evidence;
- conservative MATCH / REVIEW / NEW;
- lifecycle evidence;
- D062 publication preview;
- human review;
- review revocation;
- atomic authorized publication;
- immutable publication provenance;
- real PostgreSQL integrity/concurrency tests.

Important:

- evaluation identities cannot be accidentally published;
- provider evidence never becomes canonical merely because the provider says so;
- no universal fuzzy threshold silently resolves identity.

Production provider ingestion/publication is still an operational future task.

## 8.2 Phase B — Gmail Historical Intelligence

### B01 — DONE
Mail-account, consent, and private communication boundary.

### B02 — DONE
Gmail OAuth connection/reconnect/disconnect.

### B03 — DONE
Historical import:

- SENT-rooted;
- fixed bounded window;
- sanitized raw snapshots;
- no attachment retrieval;
- resumable/idempotent job pipeline;
- lifecycle/authorization fences.

### B04 — DONE
Private deterministic normalization:

- account-scoped message/thread identities;
- headers;
- participants;
- reference tokens;
- text parts;
- exact source digest;
- rebuild/invalidation;
- concurrency safety.

### B05 — DONE / merged PR #37
Private creator-commercial outreach interpretation:

- outreach status;
- private target facts;
- observed recipients;
- canonical target/contact candidate links;
- human creator confirmation/correction layer;
- organizations/agencies as legitimate targets;
- source-stable private facts independent of canonical inventory;
- machine-current vs historical observations;
- no CRM materialization;
- no G3/network output.

### B06 — DONE (merged)
D071 accepted and implemented; PR #38 merged into `main` at `c6cd180ea27a3901a365526a29371121f8cedc5c`.

B06 reconstructs **reply chronology**, not outcome.

It distinguishes:

- `qualifying_human_reply`;
- `automated_response`;
- `delivery_status`;
- `ambiguous_inbound`;
- `not_reply`.

Two clocks are preserved:

```text
first creator sent
→ first qualifying human reply

latest creator sent before first reply
→ first qualifying human reply
```

Critical right-censoring rule:

```text
no qualifying reply observed in imported window
!= never replied
!= ghosted
```

B06 is local computation: zero Gmail API calls.

### B07 — CONTRACT ACCEPTED / NEXT
D072 accepted (`docs/B07_GMAIL_COMMERCIAL_MEANING_CONTRACT.md`).

B07 attaches **commercial meaning** to B06's reply chronology, not the other way around.

It distinguishes, per message: disposition (`positive`/`negative`/`neutral`/`mixed`/`ambiguous`) and a commercial-signal SET (`interest`/`request_information`/`redirect`/`terms_discussion`/`offer`/`agreement`/`rejection`/`timing_constraint`/`other_commercial`). Per thread: a machine-advisory state (`unresolved`/`engaged`/`negotiating`/`agreement_observed`/`declined_observed`/`ambiguous`) and a separate creator-confirmed business outcome (`open`/`won`/`lost`/`ghosted`/`uncertain`).

Critical rules carried over from B06/D070/D045:

```text
offer alone != agreement
agreement_observed != deal_won
no reply observed in imported window != machine ghosted (human-confirmed only)
unknown compensation != unpaid
creator correction of B06 reply-nature is an overlay, never a B06 rewrite
```

B07 is local computation over already-stored evidence: zero Gmail API calls, zero new OAuth scopes. Machine inference may eventually be non-deterministic (unlike B06), so every result is provenance-bound and same-input replay must not oscillate current state by default. This contract is provider-neutral — no AI vendor is named or selected.

### B08 — PLANNED
Incremental Gmail sync + pilot instrumentation.

Needed so new sends/replies arrive without a full historical re-import.

---

# 9. Roadmap from now to commercial launch

## Phase B remaining

### B06 — Reply chronology
Who responded, human vs automatic/delivery/ambiguous, after which creator touch, how long it took, and what historical horizon was actually observed.

### B07 — Reply/outcome meaning
Structured business semantics, confidence, creator correction, provenance, no silent model truth.

### B08 — Incremental Gmail sync + pilot
Ongoing data pipe and real data-density measurement.

**Milestone B — Historical Inbox Truth Test**

Measure:

- inbox opt-in rate;
- qualified commercial threads/creator;
- precision/recall;
- % outcomes classifiable;
- unique targets per 1,000 outcomes;
- observations/target;
- metadata completeness;
- correction rate.

If historical data is too sparse/ambiguous, pause before overbuilding network intelligence.

## Phase C — Intelligence V1

### C01 — Intelligence event/fact contract
Every intelligence fact traces to evidence and target where applicable.

### C02 — Freshness/confidence/data strength
Unknown ≠ zero; weak sample ≠ precise score; recency matters.

### C03 — Personal + privacy-safe network aggregates
Private-data thresholds and contribution rules.

### C04 — Ranking / creator-fit V1
Compare against simple baselines. No opaque score without predictive evidence.

### C05 — Intelligence API + decision UI experiment
Test whether intelligence changes decisions, saves time, or improves results.

**Milestone C:** prove behavioral intelligence is actually useful.

## Phase D — Complete Travel Creator OS

### D01 — Trips
Destination/date/context + shortlist + summaries.

### D02 — Contact Hub
Provider abstraction for discovery, enrichment, verification, provenance, freshness. Snov.io can be evaluated here.

### D03 — AI Assistance Service + Contextual Composer
Main AI-platform block: reusable task service, not vendor calls scattered through UI.

### D04 — Gmail Send from OS
Bind exact sent event to target/contact/trip/pipeline.

### D05 — Follow-up scheduling/automation
Reply-aware stop, safe limits, transparent next action.

### D06 — Unified Inbox ↔ Pipeline
Email truth and CRM truth cannot silently drift.

### D07 — Collaboration Workspace + Deliverables
Reuse existing lifecycle foundations.

### D08 — Creator Context + Personal Analytics + Portfolio/Proof
History becomes an asset for the next opportunity.

**Milestone D:** creator can run the full travel opportunity loop without Sheets/Notion/separate CRM as system of record.

## Phase E — Commercial Travel V1 / Launch

### E01 — Production Discover / Map / Hotel Detail
Real canonical data and production UX.

### E02 — Product coherence
Home + Trips + Pipeline + Inbox + Collaboration feel like one OS.

### E03 — Onboarding / Activation / Recovery
New qualified creator reaches useful value quickly.

### E04 — Entitlement / Billing Audit
Free + Destination Pass + Pro + Rebill; new modules respect entitlements.

### E05 — Launch hardening
E2E, observability, privacy/security, data QA, recovery, support/admin, launch playbooks.

**Milestone E — Commercial Travel Creator OS V1:** real users can pay, activate, run real opportunity cycles, and return for another trip.

## Post-launch

### Phase F — Agency OS
Higher ARPU + denser multi-creator data.

### Phase G — Travel Scale
Coverage Engine, Provider B, contact/media queues, DataOps/freshness, destination expansion.

### Phase H — Second Vertical
Prove generalized Creator OS only after travel validation.

---

# 10. AI strategy — what kind of AI system is actually needed

TheUGC.life does **not** need one giant AI model controlling the product.

It needs a controlled **AI service architecture** with tasks separated by risk, latency, cost, privacy, and intelligence requirement.

## 10.1 Fundamental principles

AI should be:

- task-oriented;
- provider-abstracted;
- structured;
- evaluated;
- confidence-aware;
- capable of abstaining;
- human-correctable;
- provenance-backed.

AI should not be:

- the source of canonical truth;
- the source of permission/consent truth;
- a replacement for deterministic identity;
- allowed to silently mutate CRM truth;
- scattered as vendor-specific calls through UI;
- permanently locked to one model vendor.

## 10.2 Target internal AI capability API

Possible internal capabilities:

```text
compose_pitch(context)
personalize_pitch(context)
suggest_follow_up(context)
classify_reply(thread)
extract_offer(thread)
classify_outcome(thread)
extract_deliverables(thread)
summarize_negotiation(thread)
compare_offers(context)
infer_contact_role(evidence)
rank_targets(context)
explain_recommendation(context)
```

Every structured machine claim should carry, as appropriate:

```text
task
provider
model/version
prompt/policy version
source evidence references
structured output
confidence / abstention state
created_at
human correction state
```

## 10.3 Do not use AI where deterministic code is better

Remain deterministic/database-owned:

- authentication;
- authorization;
- entitlements;
- consent;
- deletion;
- provider identity;
- provider message identity;
- canonical FKs;
- audit/event sequencing;
- exact replay/idempotency;
- transaction/concurrency rules;
- source digests;
- billing transitions;
- Gmail acquisition;
- exact known canonical matches;
- deterministic reply chronology where evidence is sufficient.

## 10.4 Good AI tasks

- pitch drafting;
- semantic reply/outcome classification;
- offer extraction;
- deliverable extraction;
- negotiation summary;
- follow-up suggestion;
- contact-role inference with evidence;
- structured text-to-facts transformations.

## 10.5 Statistical/ML tasks later

Not every intelligence feature should be an LLM call.

Potential methods:

- SQL aggregation;
- Bayesian/statistical shrinkage;
- calibrated classifiers;
- ranking models;
- embeddings/retrieval;
- simple supervised ML;
- more advanced ML only if it creates measurable out-of-sample lift.

Do not use an LLM to calculate deterministic rates or substitute for statistical calibration.

---

# 11. Recommended AI topology

## Tier 0 — Deterministic layer

No model. Handles privacy, identity, evidence, chronology, permissions, calculations, state, constraints.

## Tier 1 — Fast / low-cost semantic model

Use where benchmarks prove quality:

- structured classification;
- bounded extraction;
- short summarization;
- first-pass drafting.

Needs low latency, low cost, structured-output reliability, strong multilingual performance.

## Tier 2 — Strong reasoning/writing model

Use only where quality justifies cost:

- nuanced negotiation;
- difficult outcome classification;
- high-quality personalized pitch;
- complex offer comparison;
- ambiguous contextual reasoning;
- recommendation explanations.

## Tier 3 — Retrieval / embeddings / ranking

Potential later uses:

- retrieve similar past outcomes;
- semantic search over creator-owned history;
- recommendation/ranking support.

Do not add vector infrastructure before there is a real task.

## Tier 4 — Fallback / second provider

Launch does not require using many providers simultaneously.

Reasonable architecture:

- one primary AI provider;
- one compatible fallback/benchmark provider;
- provider abstraction that allows switching.

Use multiple vendors only when benchmark evidence shows a cost/quality/reliability advantage.

---

# 12. AI Gateway / Service Layer

Conceptual flow:

```text
AI TASK
  ↓
privacy/policy check
  ↓
task router
  ↓
provider adapter
  ↓
model call
  ↓
schema validation
  ↓
confidence / abstention
  ↓
evidence-linked machine claim
  ↓
human correction path
```

The gateway should own:

- provider/model selection;
- prompt versions;
- structured schemas;
- retries/timeouts;
- cost tracking;
- latency tracking;
- error normalization;
- rate limits;
- logging policy;
- privacy policy;
- redaction where necessary;
- evaluations;
- fallbacks;
- semantically safe caching.

Bad:

```text
UI component → call Grok directly
```

Good:

```text
UI → compose_pitch() → AI service → configured provider/model
```

---

# 13. AI privacy requirements

Any AI provider handling private Gmail-derived content must be evaluated for:

- whether API/customer data is used for training;
- retention duration;
- zero-data-retention availability;
- abuse-monitoring retention;
- enterprise/API controls;
- regional processing;
- subprocessors;
- deletion;
- security certifications;
- contractual privacy terms;
- prompt/response dashboard logging;
- batch/async retention differences.

Data minimization is required.

If a classifier needs only clean reply text + one preceding creator touch, do not send an entire mailbox history.

AI logs must never become a hidden second database of private email.

---

# 14. Structured-output requirements

Machine decisions require schemas, not free prose.

Example reply/outcome classification:

```json
{
  "classification": "needs_more_information",
  "confidence": "medium",
  "evidence": [
    {"message_id": "...", "reason_code": "asks_for_media_kit"}
  ],
  "abstain": false
}
```

Example offer extraction:

```json
{
  "cash_amount": null,
  "cash_currency": null,
  "hosted_nights": 2,
  "deliverables": [
    {"type": "instagram_reel", "quantity": 1}
  ],
  "usage_rights": "unknown",
  "uncertain_fields": ["usage_rights"]
}
```

Example pitch composition:

```json
{
  "subject": "...",
  "body": "...",
  "tone": "professional_warm",
  "claims_used": [],
  "claims_avoided": [],
  "personalization_sources": []
}
```

Model output must pass schema validation before becoming machine state.

---

# 15. AI evaluation framework

Do not choose an AI company from general reputation or demo quality.

Benchmark on **TheUGC.life tasks**.

Create gold/adversarial datasets from:

- synthetic scenarios;
- creator-approved historical examples;
- corrected model errors;
- difficult edge cases.

## Classification metrics

- precision;
- recall;
- abstention rate;
- calibration;
- false-positive/false-negative cost.

## Extraction metrics

- exact field accuracy;
- missing-field rate;
- fabricated-field rate;
- schema-valid rate.

## Writing evaluation

- relevance;
- factual grounding;
- personalization;
- naturalness;
- creator voice;
- hallucination;
- later acceptance/conversion experimentation.

## Negotiation evaluation

- correct terms;
- risk detection;
- uncertainty preservation;
- no invented agreement terms.

## Production metrics

- cost per successful task;
- p50/p95 latency;
- timeout/error rate;
- schema failure rate;
- fallback rate;
- human correction rate;
- user acceptance/edit rate.

---

# 16. AI vendor comparison scorecard

Any comparison of OpenAI, xAI/Grok, Anthropic/Claude, Google/Gemini, or another provider should use the same criteria.

| Dimension | Importance | What matters |
|---|---:|---|
| Privacy / enterprise data policy | Critical | training, retention, ZDR, contracts |
| Structured output reliability | Critical | schema adherence |
| Quality on our evals | Critical | actual product tasks |
| Reasoning quality | High | ambiguous negotiation/outcomes |
| Writing quality | High | pitches/follow-ups |
| Latency | High | interactive UX |
| Cost | High | cost per successful task, not token price alone |
| Tool/function calling | High | orchestration |
| Long-context quality | Medium | threads/negotiations |
| Batch/async support | Medium | historical processing |
| Rate limits/scaling | Medium | inbox/data rebuilds |
| Multilingual quality | Medium | international users/targets |
| Embeddings/retrieval | Medium | later history/intelligence |
| Fine-tuning | Low/Medium early | only after labeled data exists |
| Observability/usage controls | Medium | cost/quotas/tracing |
| Provider stability/docs | High | production operations |
| Model lifecycle/versioning | High | reproducible machine claims |
| Geographic/legal fit | High | privacy/compliance |
| Fallback interoperability | Medium | avoid lock-in |

Recommended selection process:

1. define 5–10 critical product tasks;
2. build a gold eval set;
3. test the same examples across providers/models;
4. normalize cost per successful task;
5. compare latency;
6. compare hallucination/fabrication;
7. compare privacy controls;
8. choose task routing based on evidence.

Do not assume one vendor is best for every task.

---

# 17. Questions to ask every AI vendor

## Product/API

- Which API models are intended for production?
- Which support strict structured outputs?
- Which support tools/functions?
- Context limits?
- Prompt caching?
- Batch/async APIs?
- Rate limits?
- Model deprecation/version policy?

## Privacy

- Is API data used for training?
- What retention exists?
- Is zero-data-retention available?
- What does abuse monitoring retain?
- Enterprise terms?
- Can content be excluded from dashboards/logs?
- Where is data processed?
- What security certifications exist?

## Economics

- input/output price;
- cached input price;
- batch discount;
- embeddings/storage/tool-use charges;
- enterprise commitments/minimums.

## Quality

Test on:

- English/Spanish and multilingual workflows;
- creator email tone;
- hospitality language;
- commercial negotiation;
- ambiguous intent;
- exact structured extraction;
- abstention.

## Operations

- SLA/status;
- quotas;
- project/key controls;
- usage reports;
- spend caps;
- regional availability;
- support quality.

---

# 18. External provider strategy beyond AI

## Hotel inventory/content

Provider-source architecture already exists.

Hotelbeds has been used as Provider A/evaluation evidence.

Provider identity is never canonical identity.

Future Provider B should expand coverage without forcing a data-model rewrite.

## Contact enrichment

Needs an adapter.

Potential flow:

```text
business/domain
→ people
→ roles
→ emails
→ verification/freshness
```

Snov.io is one candidate worth evaluating, not a committed exclusive provider.

## Email

Gmail first. Outlook later behind a provider seam.

## Maps

Abstracted provider.

## Analytics

PostHog currently used / approved equivalent.

## Billing

Rebill accepted.

## AI

Provider-abstracted.

---

# 19. Background-processing strategy

Historical import, normalization, enrichment, classification, and intelligence rebuilds require background work.

Early architecture should prefer:

- Postgres-backed durable job state or another approved simple queue;
- idempotency;
- bounded work;
- retries;
- dead-letter/error visibility;
- rate-limit awareness;
- exact source/version tracking.

Do not introduce Kafka/complex distributed infrastructure until throughput proves it necessary.

---

# 20. Launch definition

“Launch” does not mean “the site loads.”

Commercial Travel V1 is launch-ready when:

## Product

A creator can:

```text
sign up
→ plan/select destination
→ discover targets
→ understand which deserve effort
→ access contacts if entitled
→ manage outreach
→ use inbox integration
→ understand replies
→ negotiate
→ manage collaboration/deliverables
→ complete outcome
→ see useful intelligence
```

## Commercial

- Free works;
- Destination Pass works;
- Pro works;
- Rebill works;
- entitlement expiry works;
- paying never destroys creator-owned history.

## Data

- canonical production hotel data exists;
- provenance works;
- contact provenance/freshness works;
- DataOps exists.

## AI

- AI service abstraction exists;
- critical tasks have evals;
- private-data vendor policy approved;
- structured output validated;
- human correction path exists;
- cost/latency budget understood;
- model/version recorded.

## Gmail/privacy

- consent;
- deletion;
- disconnect;
- processing fences;
- historical import;
- ongoing sync;
- reply chronology;
- outcome interpretation;
- no raw-data leakage.

## Reliability

- E2E;
- observability;
- recovery;
- support/admin;
- CI;
- security review;
- operational playbooks.

---

# 21. KPI framework

## Acquisition

- visitor → signup;
- signup → activation;
- Destination Pass conversion;
- Free → Pro;
- destination-page acquisition.

## Activation

Possible activation moments:

- first useful destination search;
- first target saved;
- first premium contact/intelligence unlock;
- Gmail connected;
- historical outreach detected;
- first real pipeline cycle.

## Engagement

- active trips;
- targets researched;
- contacts accessed;
- creator touches;
- replies;
- negotiations;
- collaborations.

## Retention

- weekly active creators;
- repeat trips;
- annual renewal;
- return for next destination;
- cycles/creator.

## Intelligence density

- Gmail opt-in;
- qualified threads/creator;
- outcomes/target;
- unique targets with outcomes;
- correction rate;
- confidence distribution;
- freshness.

## Commercial

- Destination Pass revenue;
- Pro ARR;
- later Agency revenue;
- ARPU;
- churn;
- cost to serve;
- AI cost/active user;
- enrichment cost/useful contact;
- provider cost/destination.

---

# 22. AI cost model

Do not optimize on token price alone.

Measure:

```text
AI_COST_PER_SUCCESSFUL_TASK
AI_COST_PER_ACTIVE_CREATOR
AI_COST_PER_PAID_CREATOR
AI_COST_PER_DESTINATION_PASS
AI_COST_PER_COMPLETED_COLLABORATION
```

A more expensive model may be cheaper overall if it needs fewer retries, produces valid schemas, causes fewer corrections, and creates higher-quality output.

A cheap model can be expensive if it hallucinates, fails schemas, needs second passes, or users rewrite everything.

---

# 23. Fastest responsible AI/build sequence

If speed matters:

```text
1. ~~Finish B06 deterministic reply chronology.~~ Done — B06 merged (PR #38).
2. ~~Contract B07 outcome taxonomy.~~ Done — D072 accepted.
3. Benchmark candidate inference approaches — deterministic/rules-based where useful, and model-backed candidates (evaluated on their merits, provider-neutral) — against B07's exact semantic tasks (§3–§8 of the B07 contract). No inference strategy is pre-selected; the benchmark decides.
4. Use that evidence to decide B07's inference-engine/provider strategy, subject to the separate vendor/privacy approval any external model requires (D072, §19 of the B07 contract).
5. Implement B07 against the chosen strategy, without coupling durable schema, provenance or human-truth history to one model vendor.
6. Build B08 + historical/ongoing pilot instrumentation.
7. Decide whether outcome density supports Intelligence V1.
8. Build C01–C05 only to the level real evidence justifies.
9. Build Trips + Contact Hub.
10. Add AI Gateway / Composer.
11. Add Gmail send + follow-up automation.
12. Unify Inbox ↔ Pipeline.
13. Complete Collaboration/Deliverables/Profile/Personal Analytics.
14. Integrate Rebill + entitlement audit.
15. E2E/privacy/security/DataOps.
16. Paid beta.
17. Commercial Travel V1.
```

Accelerate by:

- integrating commodity providers;
- using narrow contracts;
- reusing existing foundations;
- routing AI by task;
- avoiding premature infrastructure;
- delaying marketplace/mobile/second vertical.

Do **not** accelerate by weakening evidence, consent, correction, provenance, or evaluations.

---

# 24. Repository source hierarchy

When another AI reads the repo, use:

1. `docs/DECISIONS.md`
2. domain-specific accepted contract/spec
3. `docs/PRD.md`
4. `docs/MASTER_PLAN.md`
5. `docs/MASTER_PLAN_TRACKER.md`

Important files:

- `docs/PRD.md`
- `docs/MASTER_PLAN.md`
- `docs/MASTER_PLAN_TRACKER.md`
- `docs/DECISIONS.md`
- `docs/PAYMENT_PROVIDER.md`
- `docs/B01_GMAIL_DATA_BOUNDARY_CONTRACT.md`
- `docs/B03_GMAIL_HISTORICAL_IMPORT_CONTRACT.md`
- `docs/B04_GMAIL_PRIVATE_NORMALIZATION_CONTRACT.md`
- `docs/B05_GMAIL_OUTREACH_COMMERCIAL_TARGET_CONTRACT.md`
- `docs/B06_GMAIL_REPLY_CHRONOLOGY_CONTRACT.md`
- `docs/B07_GMAIL_COMMERCIAL_MEANING_CONTRACT.md`
- `docs/PERMISSIONS.md`
- `docs/DATABASE.md`

Relevant Gmail migrations:

```text
0035 — consent/private boundary
0036 — Gmail OAuth
0037 — historical import
0038 — private normalization
0039 — commercial outreach/targets
0040 — reply chronology (B06, merged)
0041 — expected B07 commercial meaning (RESERVED, not yet implemented)
```

At this snapshot 0040 is implemented and merged; 0041 does not exist yet.

Note: `docs/B07_GMAIL_COMMERCIAL_MEANING_CONTRACT.md` is the accepted B07 contract (D072); the B07 implementation PR is instructed to reconcile B07 NEXT to B07 DONE in `docs/MASTER_PLAN_TRACKER.md` with its real migration number, PR and merge SHA. The actual state in this document is the current project state.

---

# 25. Decisions another AI must not casually redesign

Treat these as accepted unless explicitly reopened:

- travel first, multi-vertical later;
- no premature mega-schema;
- canonical identity independent of providers;
- source evidence ≠ canonical truth;
- private Gmail data ≠ network data;
- machine truth ≠ human truth;
- private target observations independent of canonical catalogue;
- canonical links may be 0..N;
- organizations/agencies may be legitimate commercial targets;
- recipient ≠ target contact ≠ canonical contact;
- Gmail reply chronology ≠ outcome;
- no-reply-observed ≠ ghosted, and this stays true in B07: historical machine processing may never auto-assign `ghosted` — human-confirmed only;
- an offer ≠ agreement; agreement_observed ≠ deal_won; won ≠ collaboration completed (D045 unchanged);
- unknown compensation structure ≠ unpaid;
- creator correction of B06 reply-nature is a B07 overlay, never a B06 rewrite, and a later model/prompt/B06 change never silently overwrites a creator's B07 decision;
- AI inference never silently becomes verified fact;
- unknown ≠ zero;
- no misleading precision;
- no opaque weak-evidence “Creator Friendly Score”;
- hotels cannot pay to alter behavioral metrics;
- Gmail→CRM materialization is separately governed;
- Rebill is the payment provider;
- current Destination Pass / Pro commercial contracts remain until explicitly amended.

---

# 26. Open decisions / future research

Legitimate open questions:

- B07 implementation details within accepted D072;
- AI vendor benchmark results and eventual vendor selection for B07;
- exact network aggregate thresholds/UX;
- contact provider selection;
- AI provider selection;
- AI routing policy;
- production hotel provider operations;
- map provider;
- Outlook;
- Agency pricing;
- brand-side marketplace;
- second vertical selection.

Snov.io is a candidate, not an exclusive decision.

OpenAI/xAI/Anthropic/Google or another AI provider is not yet selected.

---

# 27. Recommended AI-vendor proof of concept

Before a major AI commitment, run the same benchmark across providers.

Suggested corpus:

### 100 reply/outcome classification examples

- human positive/negative;
- ambiguity;
- auto replies;
- delivery failures;
- negotiation;
- non-commercial;
- multilingual.

### 100 offer-extraction examples

- hosted stays;
- cash;
- hybrid;
- unclear terms;
- multiple offers;
- revisions.

### 50 negotiation summaries
Evaluate factuality and invented/omitted terms.

### 50 pitch-generation tasks
Context includes creator profile, target, trip, desired collaboration, known role, previous history.

### 50 follow-up tasks
Test context awareness, duplication, pressure/tone, factual grounding.

### Adversarial set

- quoted history;
- forwarded text;
- conflicting terms;
- changed deal terms;
- automatic signatures;
- sarcasm;
- ambiguous currencies/dates.

For each model/provider report:

```text
QUALITY
STRUCTURED_VALIDITY
HALLUCINATION
ABSTENTION
LATENCY
COST
PRIVACY
RELIABILITY
```

---

# 28. Required format for AI-provider recommendations

Any AI asked “Should TheUGC.life use OpenAI/ChatGPT, Grok/xAI, Claude/Anthropic, Gemini/Google, or another provider?” should answer:

1. Provider.
2. Exact API models evaluated.
3. Best TheUGC.life tasks.
4. Weakest TheUGC.life tasks.
5. Structured-output reliability.
6. Privacy/retention posture.
7. Batch/historical processing.
8. Interactive latency.
9. Tool/function support.
10. Long-context behavior.
11. Multilingual quality.
12. Cost per benchmark task.
13. Operational maturity.
14. Lock-in risk.
15. Recommended role:

```text
PRIMARY
SECONDARY/FALLBACK
SPECIALIST
EVALUATE LATER
REJECT
```

16. Evidence from current official API documentation and TheUGC.life benchmark results.

Brand reputation alone is not evidence.

---

# 29. Implementation methodology

Current quality method:

```text
strategy/product contract
→ implementation agent
→ real tests
→ external audit
→ amendment if necessary
→ exact-head CI
→ explicit merge authorization
→ post-merge CI
```

Claude Code is an implementation agent, not the default product strategist.

Implementation agents must surface unresolved product decisions instead of inventing them.

No merge occurs without explicit authorization for that exact PR.

This method intentionally produced multiple B05 audit amendments because hidden structural errors were discovered. The objective is not a low PR-comment count; the objective is trustworthy private data, canonical truth, and longitudinal intelligence.

---

# 30. Final mental model for any AI

Do not understand TheUGC.life as:

> “A hotel email database with ChatGPT.”

Understand it as:

> **A creator-business operating system with a travel wedge, a private communication data plane, a verified operational event history, and an intelligence layer that learns from real outcomes.**

Technology strategy:

```text
deterministic truth
+ provider integrations
+ private event history
+ task-specific AI
+ statistical intelligence
+ human correction
+ strong privacy boundaries
```

Commercial strategy:

```text
Free acquisition
→ Destination Pass trip-driven purchase
→ Pro annual OS subscription
→ Agency higher-ARPU expansion
→ travel scale
→ second vertical
→ eventual creator/business ecosystem
```

AI strategy:

```text
DO NOT buy “AI” in the abstract.
Buy model capabilities behind an abstraction.

Benchmark:
quality
+ structured reliability
+ privacy
+ latency
+ cost
+ operational stability

Then route each product task to the best acceptable model.
```

Core company advantage:

> **TheUGC.life should know not only who a creator could contact, but what historically happened after creators contacted similar targets — and how that knowledge should change the next decision.**

---

# 31. One-page requirement summary for AI providers

An AI provider for TheUGC.life should ideally support:

- production API access;
- reliable structured outputs;
- strong function/tool calling;
- excellent English + Spanish and broad multilingual quality;
- high-quality commercial writing;
- strong semantic classification;
- strong extraction;
- long-context thread reasoning;
- explicit model/version control;
- reasonable interactive latency;
- batch/async processing;
- predictable rate limits;
- cost controls;
- enterprise-grade privacy terms;
- API data not used for training by default;
- zero/minimal retention options for sensitive workloads;
- observability/usage reporting;
- stable documentation;
- graceful errors;
- provider portability;
- embeddings/retrieval if later useful;
- fine-tuning only if future labeled data justifies it.

The AI provider does **not** own:

- canonical database truth;
- user authentication;
- payment truth;
- Gmail acquisition;
- consent;
- CRM state;
- target identity;
- statistical network metrics.

Those remain inside TheUGC.life.

---

# 32. Single most important instruction to another AI

If you are an AI receiving this document to help TheUGC.life:

> **Do not propose technology in isolation. Map every recommendation to the product loop, data/privacy boundary, current repository state, launch sequence, and measurable business value.**

If recommending an AI provider, explain exactly:

- which tasks it should perform;
- which tasks it should never perform;
- why it wins on our evaluations;
- privacy implications;
- cost at expected workload;
- latency;
- portability/fallback strategy.

If proposing a feature, explain:

- which creator job it solves;
- where it sits in the loop;
- whether it creates proprietary data;
- whether it improves acquisition, conversion, retention, or outcomes;
- what new technical/data/privacy contract it requires;
- whether it is actually needed before launch.

That is the standard for useful technical or commercial advice on this project.
