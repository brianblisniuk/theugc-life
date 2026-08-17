# TheUGC.life — Master Plan

**Version:** 1.0  
**Date:** 2026-08-17  
**Status:** Strategic source of truth for product direction, technology direction and sequencing  
**Companion tracker:** [`MASTER_PLAN_TRACKER.md`](MASTER_PLAN_TRACKER.md)

---

## 0. How to use this document

This document defines **where the company/product is going and in what order we intend to get there**.

It does **not** replace the detailed contracts that already govern current V1 behavior.

Source-of-truth hierarchy:

1. `docs/DECISIONS.md` — explicit product/architecture decisions already closed.
2. Specific contracts/specifications (`PROPERTY_CONTENT_COVERAGE_CONTRACT.md`, `PROPERTY_CONTENT_IMPLEMENTATION_SPEC.md`, `PERMISSIONS.md`, etc.) — exact behavior for their domain.
3. `docs/PRD.md` — current product contract and shipped/built reality.
4. **This document** — long-range product vision, technology architecture and execution sequence.
5. `docs/MASTER_PLAN_TRACKER.md` — live execution status, estimated implementation rounds and actual progress.

If this plan conflicts with an already-closed contract, the closed contract wins until it is deliberately amended.

This is a **living plan**. Strategy may change when real usage, market data or technical evidence falsifies an assumption. Changes should be explicit, dated and recorded rather than silently rewriting history.

---

# 1. Company vision

## 1.1 Long-term vision

TheUGC.life should become the **operating system for content creators**.

The product should be the place a creator opens when they want to:

- find opportunities;
- decide which opportunities are worth pursuing;
- identify the right person to contact;
- pitch;
- manage replies and follow-ups;
- negotiate;
- manage collaborations;
- manage deliverables;
- track compensation/value;
- build proof of work;
- understand what is working;
- improve the next outreach cycle.

The long-term product loop is:

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

## 1.2 Travel is the wedge, not the final market

Travel is the first vertical because it has:

- a concrete and repeated creator workflow;
- high-value outcomes (stays, paid UGC, hybrid deals, commissions);
- a large, structured target universe;
- destination-driven intent;
- obvious discovery and contact pain;
- a natural reason to manage many targets at once;
- a strong opportunity for proprietary outcome data.

The travel implementation is therefore the first complete vertical of a larger Creator OS.

Future verticals may include, after travel product-market fit:

- restaurants and hospitality;
- tourism boards and experiences;
- airlines/cruises;
- beauty;
- fashion;
- food and beverage;
- fitness;
- technology/apps;
- other UGC-heavy categories.

We **do not** generalize the database prematurely. Travel-specific entities such as `hotel`, star classification and destination remain first-class travel concepts until a second vertical creates a real need for shared abstractions.

---

# 2. Strategic thesis after 2026 market research

The market evidence supports the following operating assumptions.

## 2.1 We do not need to be the only product or invent every feature

The goal is not to win because every individual feature is novel.

The goal is to become the **best and most complete integrated option for the target creator**.

A creator should not need to assemble a workflow from many disconnected tools if TheUGC.life can make the entire loop work in one place.

## 2.2 Commodity does not mean “do not include it”

Some features are commodity but still essential to an all-in-one product.

Examples:

- hotel inventory;
- contact enrichment;
- email verification;
- AI writing;
- email sending;
- follow-up automation;
- basic CRM.

We should not spend disproportionate engineering effort creating proprietary versions of commodity infrastructure when a reliable integration can provide it. But where the feature is necessary to create a seamless OS experience, it still belongs in the product.

The strategic rule is:

> **Buy/integrate commodity inputs; own the user experience, workflow context, event history, intelligence and high-value product logic.**

## 2.3 Outcome intelligence remains a strategic advantage, not the entire company thesis

Public hotel and contact data is reproducible.

Private workflow outcomes are harder to reproduce because they require user participation and historical usage.

The valuable longitudinal graph can become:

```text
property / brand
× creator archetype
× audience geography
× contact role
× pitch/outreach characteristics
× send date
× reply / no reply
× reply delay
× follow-up behavior
× negotiation
× collaboration type
× compensation/value
× final outcome
× freshness
```

This is **one potential moat**, not the only reason the company can win.

The full advantage stack we pursue is:

1. **Completeness** — the whole creator workflow.
2. **Integration** — every module shares context and data.
3. **UX** — easier and better than assembling many products.
4. **Intelligence** — the system learns from real activity.
5. **Distribution** — creators know and choose the brand.
6. **Data/history** — longitudinal creator × opportunity outcomes become difficult to reproduce at scale.
7. **Ecosystem** — individual creators, managers/agencies and eventually businesses reinforce the platform.

---

# 3. Product promise

## 3.1 Travel product promise

The travel wedge should ultimately answer:

> **I am planning a trip. Show me the properties worth my time, help me contact the right people, manage the entire collaboration process and learn from every outcome.**

The complete travel loop:

```text
TRIP INTENT
→ DISCOVER
→ PRIORITIZE / INTELLIGENCE
→ CONTACT
→ PITCH
→ SEND
→ WAIT / FOLLOW-UP
→ REPLY
→ NEGOTIATE
→ WIN / LOSE / GHOST
→ COLLABORATION
→ DELIVERABLES
→ VALUE / PAYMENT
→ OUTCOME
→ PORTFOLIO / PROOF
→ NETWORK + PERSONAL INTELLIGENCE
```

## 3.2 Creator OS promise

The long-term generalized promise:

> **One operating system to find, win and manage creator opportunities — and get better at it every time.**

---

# 4. Product architecture: modules and feature-by-feature intent

The modules below describe the intended final product. Their build order is defined later.

## 4.1 Discover

**User job:** find relevant opportunities without manually searching the open web.

Travel V1:

- destination search;
- hotel list and map;
- 4/5-star V1 travel scope;
- property filters;
- save/shortlist;
- public/basic intelligence;
- premium intelligence;
- visible data strength/freshness;
- no contact fetch merely to render locked UI.

Technology:

- canonical Postgres hotel inventory;
- provider adapters feeding staging/resolution/promotion;
- server-side filtered queries;
- map provider behind an abstraction;
- search/index optimization only when real scale demands it.

Strategic value: **table stakes + acquisition surface**, not moat by itself.

## 4.2 Property / Target Detail

**User job:** understand whether this specific target deserves effort.

Travel detail eventually includes:

- identity/location/classification;
- property media;
- creator activity;
- reply behavior;
- reply-time band;
- observed collaboration types;
- confidence/data strength;
- freshness;
- contact routes;
- known named role contacts where available;
- personal history (“you contacted this hotel before”);
- relevant trip/pipeline state.

Strategic value: primary **decision surface** where public data, private user data and network intelligence meet.

## 4.3 Contacts

**User job:** reach the best available person, not merely find an email.

Features:

- generic contact route;
- named marketing/PR/partnership/social/management contact where available;
- contact provenance;
- verification state;
- contact role;
- freshness/last verified;
- contact performance when network density supports it;
- alternate route when primary is unavailable.

Technology:

- provider/enrichment adapters;
- contact normalization and deduplication;
- separate `CONTACT_ROUTE` vs `TARGET_CONTACT` concepts;
- no email-as-hotel-identity behavior;
- later provider integrations for verification/enrichment.

Strategic value: initially **integrated commodity**, later potentially differentiated by role-performance history.

## 4.4 Trips

**User job:** organize opportunity work around real travel intent.

Features:

- destination;
- date range;
- saved/shortlisted targets;
- priority order;
- outreach status summary;
- deadlines;
- confirmed stays/collabs;
- trip-level value generated;
- trip collaboration calendar;
- historical trip outcomes.

Trips are an important retention/context object because the same creator may run multiple cycles per year.

Strategic value: converts a generic CRM into a **travel-native workflow**.

## 4.5 Pipeline / CRM

**User job:** never lose track of a relationship or follow-up.

Canonical lifecycle:

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

The repository already contains important pipeline/event-ledger foundations. Future work should extend/integrate rather than rebuild them.

Features:

- one state source of truth;
- immutable event history;
- next action;
- follow-up due;
- notes;
- owner/assignee later for agencies;
- link to email thread;
- link to trip;
- link to collaboration/deal.

Strategic value: **OS spine**. Not inherently defensible, but everything else becomes more valuable when it uses the same pipeline.

## 4.6 Gmail / Inbox Integration

**User job:** use the creator’s real inbox without duplicating work.

Gmail has two distinct strategic functions.

### Historical import

Purpose:

- discover pre-existing hotel outreach;
- identify qualified threads;
- reconstruct sent/replied timing;
- seed historical outcomes;
- test network-data density before waiting for future usage.

### Ongoing sync

Purpose:

- detect sent outreach;
- detect qualifying human replies;
- compute reply delay;
- stop/adjust follow-up state;
- update pipeline;
- create outcome evidence;
- reduce manual reporting.

Technology principles:

- Gmail first;
- minimum necessary OAuth scopes;
- official-provider APIs only;
- private raw mailbox data separated from shared/derived network intelligence;
- explicit user consent;
- revocation/deletion semantics;
- provider-native incremental sync/change notifications where appropriate, chosen only after an official-doc technical contract;
- idempotent message/thread ingestion;
- durable provider message/thread identities;
- no dependence on raw body retention when a derived/event representation is sufficient.

Strategic value: **table stakes + critical data pipe**. Gmail OAuth itself is not the moat; accumulated normalized history can become one.

## 4.7 AI Assistance

AI is a **service layer across the OS**, not the positioning of the company.

Features may include:

- pitch drafting;
- personalization suggestions;
- follow-up drafting;
- reply summarization;
- reply classification;
- extraction of requested deliverables;
- negotiation assistance;
- offer comparison;
- collaboration-type extraction;
- outcome classification;
- contact-role inference when evidence supports it;
- creator-fit recommendations when real outcome data supports them.

Technology principles:

- provider abstraction, not model lock-in;
- structured outputs for machine decisions;
- confidence and human correction;
- never silently turn model inference into verified fact;
- private input boundaries;
- logs must not leak email/content secrets;
- evaluation sets for classifiers before trusting them at scale.

Strategic value: improves UX and automation; **not the moat by itself**.

## 4.8 Outreach Composer and Sending

**User job:** go from decision to contact without leaving the OS.

Features:

- choose target/contact;
- create pitch from context;
- template/personalization;
- send through connected mailbox;
- schedule if needed;
- record exact sent event;
- manual/automatic follow-up later;
- safe volume limits;
- reply-aware sequence stop.

This is intentionally later than historical Gmail intelligence validation: we do not need to clone every Yukolab sending feature before proving the value of our differentiated layer.

Strategic value: **completeness/integration**.

## 4.9 Negotiation / Deal Workspace

**User job:** turn a reply into a good collaboration.

Features:

- what the target requested;
- creator proposal;
- deliverables;
- dates;
- hosted value;
- cash compensation;
- hybrid structures;
- usage rights notes;
- revisions/offer history;
- next action;
- agreed state;
- rejection reason where captured.

The existing negotiation/collaboration core should remain authoritative where already implemented.

Strategic value: extends the OS beyond “email sent,” which many competitor workflows treat shallowly.

## 4.10 Collaboration Workspace

**User job:** execute the agreement after a deal is won.

Features:

- confirmed property/brand;
- participants;
- dates;
- collaboration type;
- agreed value/compensation;
- deliverables;
- deadlines;
- content links;
- approval/status;
- notes;
- completion;
- final outcome.

Strategic value: creates richer outcome labels and makes the product useful after the reply.

## 4.11 Deliverables

**User job:** know exactly what is owed and what is complete.

Features:

- deliverable type;
- quantity;
- platform;
- due date;
- status;
- link/file reference;
- approval;
- revision/request notes;
- usage-right context;
- completed timestamp.

Strategic value: retention + reliable collaboration outcome data.

## 4.12 Creator Profile / Context

**User job:** let the system reason about fit without repeatedly entering the same information.

Potential fields:

- creator type;
- niches;
- platforms;
- audience size bands;
- audience geography;
- portfolio categories;
- preferred collaboration types;
- travel style;
- languages;
- previous collaboration history.

Rules:

- use only attributes that improve product decisions;
- avoid collecting profile data merely because it is available;
- network intelligence must not expose another creator’s private profile.

Strategic value: necessary for **creator-conditioned intelligence**.

## 4.13 Creator Network Intelligence

**User job:** know where time and effort are most likely to produce value.

Initial observable/derived concepts:

- creator activity level;
- reply-rate band when sample permits;
- typical reply-time band;
- recent creator activity;
- collaboration types observed;
- data strength/confidence;
- contact-role performance later;
- creator-fit signals later;
- deal/value patterns later.

Important principles:

- unknown ≠ zero;
- no misleading precision;
- no raw counts required user-facing;
- freshness matters;
- confidence/sample context visible;
- hotel-level signal can borrow strength from higher-level cohorts only after predictive value is proven;
- no opaque “Creator Friendly Score” that hides weak evidence;
- hotels cannot pay to alter behavioral metrics.

Future hierarchical context may use:

```text
PROPERTY
→ BRAND / CHAIN
→ DESTINATION
→ STAR TIER
→ PROPERTY TYPE
```

combined with:

```text
CREATOR TYPE
→ AUDIENCE GEOGRAPHY
→ NICHE
```

and:

```text
CONTACT ROLE
→ COLLABORATION TYPE
→ SEASON
→ RECENCY
```

This is a hypothesis to validate with real out-of-sample lift, not a promise that sophisticated ML will automatically create signal.

Strategic value: **potential data moat**.

## 4.14 Personal Intelligence

Network intelligence answers “what usually works.” Personal intelligence answers “what works for you.”

Potential features:

- personal reply rate by target type;
- best-performing contact roles;
- best pitch/follow-up patterns;
- destinations where creator gets strongest results;
- collaboration mix;
- time-to-deal;
- value generated by trip;
- repeat relationships;
- personal conversion funnel.

Strategic value: retention and individualized improvement even before network density is large.

## 4.15 Portfolio / Proof Layer

Do not build a generic Canva replacement.

The differentiated portfolio should be generated from the creator’s **verified operating history** inside the OS:

- completed collaborations;
- deliverables;
- content links;
- brands/properties;
- outcome/value context where creator chooses to expose it;
- testimonials/feedback later;
- performance proof later.

Strategic value: makes operational history reusable for winning the next deal.

## 4.16 Agency / Manager Workspace

Agency is an important expansion, both for revenue and data density.

Features:

- organization/workspace;
- multiple managed creators;
- seats and roles;
- creator assignment;
- shared opportunity/contact data;
- separate creator-private data boundaries;
- shared pipeline visibility;
- workload/next-action assignment;
- collaboration calendar;
- reporting;
- account-level intelligence;
- creator-level performance;
- export/reporting for clients.

Technology:

- explicit organization tenancy;
- RBAC in Postgres/RLS;
- no accidental cross-creator private inbox access;
- permissions tested at DB level;
- agency billing/seat model later.

Strategic value: higher ARPU, lower churn potential and many more workflow events per account.

## 4.17 Billing / Entitlements

Existing Destination Pass and Pro contracts remain unless deliberately amended.

Current strategic pricing direction:

- Free — discovery/basic public intelligence/limited workspace;
- Destination Pass — $39 / destination / 30 days, justified by actionable destination intelligence rather than a static list;
- Pro — $199/year worldwide;
- Agency — future separate product/price after workflow validation.

Product gating must happen in the entitlement layer, not through separate hotel inventories.

## 4.18 Admin / Data Operations

A scalable OS needs internal operations tooling.

Features eventually include:

- source-run health;
- unresolved identity queue;
- star/scope/location review;
- contact enrichment queues;
- photo/media queues;
- hotel confirmation queue;
- data freshness;
- intelligence anomaly review;
- user-reported corrections;
- policy/version registry visibility;
- experiment monitoring.

Strategic value: quality and trust at scale.

---

# 5. Technology vision

## 5.1 Existing core stack

Continue with the current stack unless a real scale/functional limit requires change:

- Next.js App Router;
- React 19;
- strict TypeScript;
- Supabase/PostgreSQL/Auth/RLS;
- Tailwind v4 + semantic tokens;
- Vitest + real-Postgres permission tests;
- analytics abstraction (currently PostHog or approved equivalent).

Do not introduce infrastructure merely to look “enterprise.”

## 5.2 Architectural planes

The system should be thought of as five connected planes.

### A. Source / public-data plane

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

Purpose: reliable external facts with provenance.

### B. Creator operational plane

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

Purpose: system of record for the creator’s work.

### C. Private communications plane

```text
mail account
→ provider thread/message
→ normalized communication event
→ reply/intent/outcome extraction
```

Purpose: automate the operational record without forcing manual reporting.

### D. Intelligence plane

```text
verified/derived events
→ privacy-safe aggregation
→ freshness/confidence
→ cohort/personal metrics
→ ranking/recommendation
```

Purpose: turn activity into better future decisions.

### E. Commercial / entitlement plane

```text
plan/pass/workspace
→ entitlement
→ feature/data access
```

Purpose: keep monetization independent of canonical inventory truth.

## 5.3 Event-first architecture

Operational history should be append-friendly and auditable.

Important event families include:

- target_saved;
- outreach_sent;
- follow_up_sent;
- reply_received;
- reply_classified;
- negotiation_started;
- deal_won;
- deal_lost;
- collaboration_started;
- deliverable_completed;
- collaboration_completed;
- outcome_classified;
- user_correction.

Not every event needs a separate table. The important invariant is that the system can reconstruct **what happened, when, to which canonical entity, and from which evidence**.

## 5.4 Background processing

Historical inbox ingestion, enrichment, classification and intelligence rebuilds will require background work.

Do not choose a complex distributed queue before we know throughput.

Initial architecture should prefer:

- idempotent jobs;
- durable job state in Postgres or an approved simple queue;
- retry semantics;
- dead-letter/error visibility;
- rate-limit aware provider adapters;
- scheduled rebuilds where appropriate.

A dedicated queue/service is introduced only when actual throughput or latency proves the simpler model inadequate.

## 5.5 Integration gateway

External providers should sit behind narrow adapters so business logic does not depend directly on one vendor.

Provider families:

- hotel inventory/content;
- contact discovery/enrichment;
- email verification;
- Gmail;
- Outlook later;
- maps/geocoding;
- AI models;
- billing;
- analytics.

Each adapter should define:

- provider identity/version;
- request/response normalization;
- provenance;
- rate/error handling;
- caching/storage rights where relevant;
- test fixtures;
- production/evaluation environment separation.

## 5.6 AI service architecture

Use a task-oriented abstraction rather than sprinkling model calls across UI components.

Example internal capabilities:

```text
compose_pitch(context)
classify_reply(thread)
extract_offer(thread)
classify_outcome(thread)
summarize_negotiation(thread)
suggest_follow_up(context)
```

Every machine-derived structured claim should carry:

- model/provider version where relevant;
- timestamp;
- confidence/evaluation metadata where useful;
- human correction path;
- source evidence reference.

## 5.7 Privacy and shared intelligence boundary

This is a hard architectural boundary.

Private creator communications and shared network intelligence are different data products.

The system must never assume that because a user authorized mailbox access, raw mailbox content can be exposed to other creators.

Conceptual flow:

```text
PRIVATE MAIL CONTENT
→ normalized private event/evidence
→ allowed derived fact
→ privacy-safe aggregation threshold
→ network intelligence
```

Before Gmail historical import implementation, close a dedicated official-source contract covering:

- OAuth scopes;
- consent;
- data minimization;
- retention;
- revocation;
- deletion;
- provider policy requirements;
- shared-derived-data boundaries.

## 5.8 Multi-vertical architecture rule

Do not refactor `hotels` into a generic mega-table now.

Instead:

1. Finish the travel vertical with clean seams.
2. Identify which concepts are truly shared when a second vertical is selected.
3. Extract stable shared concepts such as workspace, creator, contact, outreach, thread, deal, deliverable and outcome.
4. Keep vertical-specific target data in vertical modules/tables.

The likely long-term conceptual core is:

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

but the exact second-vertical schema is a future contract decision.

---

# 6. Build strategy

## 6.1 Vision all-in-one, execution sequential

“All-in-one” must not mean building 30 incomplete modules simultaneously.

Rule:

> **Close one useful loop at a time, then extend the loop.**

Every implementation block should have:

1. explicit contract;
2. narrow scope;
3. implementation by CC;
4. external audit;
5. correction loop if needed;
6. gate;
7. merge;
8. next block.

Intermediate corrections are not failure or schedule noise. They are part of the quality method.

## 6.2 Build vs buy vs integrate

### Build/own

- canonical identity and provenance;
- creator workflow/context;
- Gmail outcome ingestion/normalization;
- reply/outcome taxonomy;
- creator-network intelligence;
- confidence/freshness;
- recommendation/prioritization;
- collaboration/deal/deliverable operating layer;
- agency permission model;
- personal/network learning.

### Buy/integrate first

- public hotel inventory;
- generic contact enrichment;
- email verification;
- mapping/geocoding where needed;
- foundation AI models;
- billing rails.

### Build thin because it is table stakes

- map/list UI;
- search;
- basic CRM surfaces;
- email composer;
- templates;
- simple analytics.

### Delay until core loop proves value

- marketplace;
- hotel-side SaaS;
- payments/escrow;
- affiliate engine;
- native mobile app;
- generic media-kit builder;
- massive multi-vertical abstraction.

---

# 7. Master execution sequence

The live round-by-round tracker is in [`MASTER_PLAN_TRACKER.md`](MASTER_PLAN_TRACKER.md). This section defines the intended major milestones.

## Milestone A — Finish canonical travel truth

Purpose: create trustworthy canonical targets to which future private outcomes can attach.

Remaining work after PR25:

1. physical-hospitality scope resolution;
2. entity-resolution evidence/review;
3. D062 publication preview;
4. human authorization + atomic canonical apply.

**Gate:** a real provider property can move from source observation to immutable pre-publication facts to a human-reviewable publication decision without silent assumptions.

## Milestone B — Historical Inbox Truth Test infrastructure

Purpose: answer the largest business-risk question: **does historical creator email contain enough qualified hotel-outreach data to build useful intelligence?**

Build:

1. Gmail/privacy contract;
2. connected mail account model;
3. historical import;
4. idempotent message/thread normalization;
5. hotel-outreach thread detection;
6. canonical hotel matching/review;
7. sent/reply timing;
8. basic reply/outcome classification;
9. creator correction path;
10. import-quality metrics.

**Gate:** pilot inboxes can be processed safely and produce measurable qualified hotel threads with acceptable classification quality.

Critical KPIs:

- historical inbox opt-in rate;
- qualified hotel threads / connected creator;
- thread-detection precision/recall;
- % outcomes classifiable automatically;
- unique properties per 1,000 outcomes;
- median observations/property;
- metadata completeness.

## Milestone C — Intelligence V1

Purpose: make the accumulated facts useful before building every workflow convenience.

Build:

- normalized reply event;
- time-to-reply;
- reply/no-reply semantics;
- ghosting rule/observation window contract;
- collaboration outcome taxonomy;
- collaboration type;
- freshness/decay;
- confidence/data-strength;
- privacy-safe aggregation;
- personal intelligence;
- network intelligence;
- destination/property ranking;
- decision interface.

**Gate:** behavioral intelligence changes decisions or saves meaningful creator time compared with a static hotel/contact list.

## Milestone D — Complete Travel Creator OS loop

Purpose: make creators stay in one product for the full collaboration lifecycle.

Build/integrate:

- Trips;
- contact hub;
- Gmail ongoing sync;
- composer/AI assistance;
- sending;
- follow-up;
- unified inbox/pipeline state;
- negotiation UI over existing core;
- collaboration workspace;
- deliverables;
- creator profile/context;
- personal analytics;
- portfolio/proof layer.

**Gate:** a creator can manage a trip from target discovery through completed collaboration without needing a spreadsheet/Notion/CRM as the system of record.

## Milestone E — Commercial Travel V1

Purpose: turn the complete loop into a reliable paid product.

Build/harden:

- final Sunlit Creator OS product experience;
- onboarding/activation;
- entitlement coverage across new features;
- Destination Pass flow;
- Pro flow;
- usage analytics;
- data-quality dashboards;
- E2E testing;
- security/privacy review;
- error/recovery UX;
- operational playbooks.

**Gate:** paid beta users can activate, get value, complete real cycles and return for another trip.

## Milestone F — Agency OS

Purpose: raise ARPU and capture dense multi-creator operational data.

Build:

- organization/workspace model;
- agency RBAC;
- managed creators;
- assignments;
- shared pipeline/contact context;
- reporting;
- creator-level performance;
- agency billing/limits.

**Gate:** one manager can operate multiple creator pipelines without violating private-data boundaries.

## Milestone G — Travel scale

Purpose: expand coverage only after the value loop is proven.

Build:

- Coverage Engine;
- Provider B evaluation/integration;
- destination closure tooling;
- contact enrichment at scale;
- media pipeline;
- hotel verification outreach where valuable;
- Data QA and freshness operations;
- expand destination catalog based on demand.

Principle: **coverage depth follows validated demand and intelligence density; hotel count is not the north star.**

## Milestone H — Second vertical and generalized Creator OS

Purpose: prove that the core operating system travels beyond hotels.

Sequence:

1. market research chooses the second vertical;
2. identify shared vs travel-only concepts;
3. contract the minimum generalized target/opportunity model;
4. add second-vertical discovery/data adapter;
5. reuse contact/outreach/thread/deal/deliverable/outcome core;
6. add vertical-specific intelligence;
7. test cross-vertical creator retention.

**Gate:** a creator can use the same workspace and operating loop for travel plus a second category without the travel product degrading into a generic lowest-common-denominator CRM.

---

# 8. Metrics and north stars

## 8.1 Company/product north star

Do not optimize primarily for hotel count.

The core operating metric should move toward:

> **Completed creator opportunity cycles managed through the OS.**

Supporting funnel:

```text
ACTIVE CREATORS
→ ACTIVE TRIPS / CAMPAIGNS
→ TARGETS SHORTLISTED
→ OUTREACH EVENTS
→ QUALIFIED REPLIES
→ NEGOTIATIONS
→ COLLABORATIONS WON
→ DELIVERABLES COMPLETED
→ OUTCOMES CAPTURED
→ REPEAT CYCLES
```

## 8.2 Intelligence metrics

- qualified outcome events;
- fresh events per destination;
- observations per property/brand/cohort;
- % automatically classified;
- human correction rate;
- recommendation calibration/lift;
- decision-change rate;
- time saved per trip;
- creator-specific vs generic ranking improvement.

## 8.3 Commercial metrics

- activation;
- paid conversion;
- Destination Pass purchase rate;
- Pro annual conversion;
- repeat trip usage;
- D30/D90 retention by ICP;
- collaborations managed per active creator;
- expansion to Agency;
- gross margin by provider/integration usage.

## 8.4 Quality metrics

- canonical identity conflict rate;
- contact accuracy;
- stale contact rate;
- provider-resolution unresolved rate;
- privacy/security incidents = zero tolerance;
- failed/background job rate;
- intelligence claim correction rate.

---

# 9. Kill criteria / falsifiable assumptions

The strategy must be allowed to fail evidence-based tests.

Re-evaluate the intelligence thesis if:

- professional creators will not connect/import inbox history;
- qualified historical hotel threads per creator are too low;
- thread/outcome classification requires too much manual work;
- property/cohort density remains unusably sparse;
- freshness destroys value faster than new data arrives;
- creator-conditioned ranking does not outperform simple heuristics;
- behavioral information does not change creator decisions;
- $39 Destination Pass does not sell when real actionable intelligence exists;
- a major competitor demonstrably already owns a substantially larger equivalent cross-user off-platform outcome graph and distribution advantage.

If intelligence proves weaker than expected, the integrated OS can still be a business, but its positioning, pricing and capital allocation must be reconsidered rather than pretending the moat exists.

---

# 10. Delivery method with Claude Code + external audit

## 10.1 Definition of one “base CC round”

For estimation, one base CC round is:

> **one deliberately scoped implementation PR/block sent to Claude Code.**

The estimate does **not** count:

- audit corrections;
- CI fixes;
- clarification turns;
- small documentation amendments;
- research performed outside CC.

Those corrections remain mandatory and should continue exactly as in the current workflow.

## 10.2 Standard block lifecycle

```text
1. Contract / product decision closed
2. Narrow CC prompt
3. CC implementation + PR
4. External audit of actual patch
5. Correction prompt(s) if required
6. Re-audit
7. Merge gate
8. Tracker update
9. Next block
```

## 10.3 Estimation philosophy

Round estimates are planning tools, not commitments.

A block should be split if:

- it introduces more than one independent product decision;
- provenance/security cannot be audited coherently;
- database + external integration + large UI are all changing at once;
- rollback/failure boundaries become unclear.

A block may be combined if the parts are inseparable and can still be fully tested/audited.

The current detailed estimate lives in `MASTER_PLAN_TRACKER.md` and should be revised after every 5–8 merged base rounds based on actual velocity.

---

# 11. Product design principles

1. **One context, not many tools.** A trip/target/contact/thread/deal should not be recreated in separate modules.
2. **Evidence over claims.** Intelligence must expose confidence/freshness rather than pretending weak data is certain.
3. **Unknown is a real state.** Never silently convert missing information to zero/false.
4. **Private by default.** Raw creator communications never become shared content merely because aggregate intelligence exists.
5. **No paid reputation manipulation.** Sponsored visibility, if ever added, is separate and clearly labeled.
6. **Human correction is product data.** Corrections improve models and quality; they should be traceable.
7. **Vertical excellence before generic abstraction.** Be the best travel OS before making a generic creator database.
8. **Integrate commodity, own strategic logic.** Do not waste time recreating Hunter/Maps/model infrastructure without a reason.
9. **Full loops beat feature checklists.** Finish discover→outcome flows, then widen.
10. **Distribution is part of product strategy.** SEO/content/referral/community must grow alongside software; superior code without creator acquisition is insufficient.

---

# 12. What we explicitly are NOT optimizing for now

- being the first company to have every individual feature;
- claiming “AI-powered” as differentiation;
- the largest hotel database headline;
- a two-sided marketplace before the creator OS works;
- payments before collaboration workflow is validated;
- a generic media-kit builder;
- a native mobile app before web behavior proves the need;
- global multi-industry schema abstraction before a second vertical exists;
- hiding uncertainty behind a single opaque score.

---

# 13. End-state picture

The long-term product should feel like this:

```text
THEUGC.LIFE

HOME
  What needs attention today?

DISCOVER
  Where are the best opportunities for me?

TRIPS / CAMPAIGNS
  What am I trying to win right now?

CONTACTS
  Who should I talk to?

INBOX / OUTREACH
  What did I send and who replied?

PIPELINE
  What is the status of every opportunity?

DEALS / COLLABORATIONS
  What was agreed?

DELIVERABLES
  What do I owe and when?

PORTFOLIO / PROOF
  What have I accomplished?

INTELLIGENCE
  What works in the network, and what works for me?

AGENCY
  How do I manage this across multiple creators?
```

Travel proves the model. The shared operating loop then expands to the wider UGC economy.

The ambition is not “a better hotel list.”

The ambition is:

> **the best integrated operating system for creators to find, win, execute and learn from commercial opportunities.**
