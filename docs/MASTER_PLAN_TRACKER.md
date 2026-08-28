# TheUGC.life — Master Plan Execution Tracker

**Version:** 1.0  
**Baseline date:** 2026-08-17  
**Strategic plan:** [`MASTER_PLAN.md`](MASTER_PLAN.md)  
**Purpose:** live execution ledger, base Claude Code round estimate, milestone gates and planning-time model.

---

## 0. What this tracker counts

A **base CC round** means one deliberately scoped Claude Code implementation block / PR.

It does **not** count:

- external audit turns;
- audit correction prompts;
- CI/debug follow-ups;
- clarifications;
- research performed by ChatGPT/Gemini;
- tiny documentation corrections.

Those correction loops remain mandatory. They are intentionally excluded so this file measures the underlying implementation plan rather than pretending a complex PR always succeeds in one pass.

### Current forward estimate

From the post-PR25 baseline:

- **Base estimate to commercial Travel Creator OS V1:** ~30 future CC rounds.
- **Base estimate through Agency OS:** ~34 future CC rounds.
- **Base estimate through travel scale tooling:** ~38 future CC rounds.
- **Base estimate through a first second-vertical pilot:** ~43 future CC rounds.
- Planning uncertainty: **approximately ±20%**. Expect roughly **35–52** base rounds for the full sequence below depending on how much existing code can be reused and which blocks prove inseparable.

The estimate should be recalibrated after every 5–8 merged base rounds.

---

# 1. Completed foundation relevant to the current master plan

These are already merged and are **not** included in the 43 future-round estimate.

| PR | Status | What it established |
|---|---|---|
| #20 | DONE | D060–D064 property content / destination coverage contract |
| #21 | DONE | Hotelbeds Source A evaluation, Bali/Dubai evidence, provider-source architecture |
| #22 | DONE | pre-publication source infrastructure (`0027`) |
| #23 | DONE | cached Hotelbeds ingestion writer + 4,110-property offline stress proof |
| #24 | DONE | D066 provider-resolved classification policy; one approved provider can resolve product stars |
| #25 | DONE | immutable pre-publication star/location resolution, policy registries, provenance, real Bali/Dubai resolution |

**Baseline after PR25:** canonical travel source facts are increasingly trustworthy, but the physical-hospitality dimension, entity decision and D062 publication boundary are still incomplete.

---

# 2. Forward round ledger

Statuses:

- `NEXT` — immediate next block.
- `PLANNED` — planned but not yet contracted.
- `GATED` — depends on earlier evidence/decision.
- `OPTIONAL` — build only if usage proves need.
- `DONE` — merged.

The round IDs are stable planning IDs. GitHub PR numbers may differ.

---

## PHASE A — Finish canonical travel truth

**Goal:** trustworthy canonical properties to which future private creator outcomes can attach.

| Round | Status | Implementation block | Core gate |
|---|---|---|---|
| A01 | **DONE** (PR #26, merged) | Hotelbeds hospitality-scope policy + immutable pre-publication physical-hospitality resolution | Every provider type code reviewed once; scope ≠ final eligibility |
| A02 | **DONE** (PR #27, merged) | entity-resolution evidence + candidate matching/review model | conservative MATCH / REVIEW / NEW; no universal threshold |
| A03 | **DONE** (PR #28, merged) | pre-publication lifecycle / closure evidence | property-level closure only, evaluated AS OF an explicit date; absence of evidence is never "active" |
| A04 | **DONE** (PR #29, merged `6cffa8b9`) | D062 pre-publication preview | every publication condition explicit, evidence-linked, non-circular |
| A04.5 | **DONE** (PR #30, head `d09231e96762a51b0af7398931037507b805e9ac`, merged `bbd0d887e6c15b7dea881b77667213b8ef5232a2`) | human identity + destination review evidence pilot | an explicit human `approve_create` becomes durable, append-only, current-evidence-bound evidence that D062's conditions 1 and 2 cite; nothing canonical is written |
| A04.6 | **DONE** (PR #31, final audited head `4a6ae0432810df05a8aa176b7d8a0cd4b2b8edc0`, merged `da968185fb3125b33b3b965e63f153ada0ad552f`) | human review revocation | a human can withdraw a previous `approve_create` so it immediately stops authorizing D062, without touching the immutable receipt, deleting history, or publishing anything |
| A05 | **DONE** (PR #32, final audited head `463b0e32afdb94b7c4a0ffff999468829f89ccce`, merged `ed857f0ba38013772b5a94d488ed9295123676fb`) | human authorization + atomic D062 apply | canonical hotel/source link created atomically; publication provenance immutable |

**Base rounds:** 4 *(original estimate, preserved)*  
**Cumulative future rounds:** 6

**Why A03 exists.** It was not in the original four. The A01 provider evidence
showed that D062's condition 4 — "the property is not known inactive / closed" —
had **no safe evidence path**: the only lifecycle-shaped provider signal was
Hotelbeds' `issues[]`, and the obvious reading of it (`issueType = CLOSED`) is
materially wrong. In the real Bali/Dubai data 13 rows are `CLOSED` and only 2 are
the hotel itself; the other 11 are a water park, a restaurant, a spa and a car
park. Building D062 Preview on that would have closed eleven operating hotels, so
the lifecycle evidence layer was inserted ahead of it. The former A03 and A04 are
now A04 and A05; their scope and gates are unchanged.

**Why A04.5 exists.** A round is inserted between the D062 preview (A04) and the
human authorization + atomic apply (A05), because A04 exposed a missing layer.
The preview holds conditions 1 and 2 pending a human decision, but there was
nowhere for that decision to live: no durable, auditable, evidence-bound record
that a source identity is a distinct property in a named supported destination.
A05 would otherwise have had to invent one while also performing the atomic
apply. A01–A04 keep their numbers; nothing is renumbered.

Its contract is
[`A04_5_HUMAN_REVIEW_EVIDENCE_CONTRACT.md`](A04_5_HUMAN_REVIEW_EVIDENCE_CONTRACT.md),
implemented by migration `0032` and `scripts/human-review/*`. The pilot proves
`approve_create` end to end **without publishing a hotel**: no `hotels` insert,
no `hotel_source_identities` link, no `resolution_state` transition, and review
writes restricted to a local disposable evaluation database with no override.

**Amendment #1 (external audit).** The apply path opened a plain `begin`, so the
multi-statement evaluator ran under READ COMMITTED and the "one consistent read"
claim was stronger than the transaction actually delivered. The write
transaction is now `SERIALIZABLE`, a serialization abort is refused rather than
retried, and the guarantee is proven by deterministic multi-connection tests.

**Amendment #2 (external audit).** The contract permits re-reviewing a NEW
observation, but the apply path could not persist one: it inserted a second
`new_property` finding (0030 allows one per identity) and a second
`source_property_reviews` row (0027 makes the identity UNIQUE). Both constraints
are correct and unchanged. The finding is now **reused** as the entity-level
claim it is, the current review row **advances in place**, and the immutable
per-observation history lives in the receipts. No new migration.

**Amendment #3 (external audit).** A `defer` taken after an earlier review wrote
a current `defer` receipt beside a stale `approve_create` projection — the two
current-decision surfaces disagreeing. An initial defer stays supported; a defer
once a projection exists is now refused, because replacing it would require the
correction/supersession workflow that remains future work.

A04.5 merged as PR #30 (head `d09231e96762a51b0af7398931037507b805e9ac`, merge
commit `bbd0d887e6c15b7dea881b77667213b8ef5232a2`) after the three amendments
above. At that head: 63 A04.5 database tests, 1,593 tests total, CI green, a
4,110/4,110 read-only stress with 100% fingerprint replay, **zero canonical
writes** and **zero decisions applied to the 867 real review-ready identities**.

**Why A04.6 exists.** A04.5 deliberately refused correction and supersession,
which was right for a pilot that publishes nothing. A05 turns an authorized D062
PASS into a canonical hotel, so a human needs an emergency brake **before**
publication exists: a way to withdraw a previous `approve_create` that takes
effect immediately, without editing the immutable receipt and without deleting
history. A01–A05 keep their numbers; nothing is renumbered.

Its contract is
[`A04_6_HUMAN_REVIEW_REVOCATION_CONTRACT.md`](A04_6_HUMAN_REVIEW_REVOCATION_CONTRACT.md),
implemented by migration `0033` and `scripts/human-review-revocation/*`. A
revocation is not a rejection, not a deletion and not a publication action: it
separates *what the human concluded* (`decision`) from *whether that conclusion
is currently authorized* (`review_status`), and records the withdrawal as a new
append-only fact. There is no un-revoke — authorization returns only through a
fresh human review of a fresh observation.

**Amendment #1 (external audit).** `current_receipt_id` was FK'd to the same
identity but not to the same *decision*. An identity legitimately holds one
receipt per reviewed observation, so a projection advanced onto run B could be
pointed back at receipt A while A04 still evaluated — and passed — receipt B. A
database trigger now requires the projection and its receipt to agree on
decision, destination and evidence run; the backfill binds on that same full
predicate and refuses ambiguity **before** choosing; and D062 independently holds
conditions 1 and 2 when the projection names no receipt or a different one.

**Amendment #2 (external audit).** "There is no un-revoke" held only in the
revocation CLI. `review_status` is a mutable column on a table admin/editor and
`service_role` legitimately hold UPDATE on, so a single
`set review_status = 'active'` — touching nothing else — restored a 11/11 PASS
with the identical pre-revocation fingerprint while the immutable revocation sat
unread. A database trigger now requires `revoked` **iff** an immutable revocation
exists for the projection's current receipt, in both directions; D062 asks the
same question independently and treats the event as dominating the column; and a
revocation manifest whose approval has since been superseded is refused rather
than reported as already satisfied.

**Amendment #3 (external audit).** The `revoked` ⇔ event equivalence was enforced
only from `source_property_reviews`, while 0033 grants INSERT on the revocation
table to admin/editor and `service_role` — so the immutable event could be filed
with the projection never touched and no projection trigger firing. D062 still
refused to publish, but the database contract was false. A `deferrable initially
deferred` constraint trigger now re-checks the final state at COMMIT from **both**
tables, and a revocation may only withdraw the approval the projection currently
represents. The pack and the apply path each gained an independent, separately
named diagnosis for the same state.

A04.6 merged as PR #31 (final audited head
`4a6ae0432810df05a8aa176b7d8a0cd4b2b8edc0`, merge commit
`da968185fb3125b33b3b965e63f153ada0ad552f`) after the three amendments above.

**A04.7 — the real human review pilot (operational, no roadmap round).** Run on
the merged A04.6 code against the real 4,110-property cached Hotelbeds
*evaluation* corpus, in two stages. Stage 1 prepared ten deterministic identities
(5 Bali, 5 Dubai) with every human-decision field empty and nothing applied.
Stage 2 executed the project owner's explicit authorization of 2026-08-27:

- **8 `approve_create` + 2 `defer`**, applied through the real A04.5 path;
- **8 real evaluation identities reached a genuine 11/11 D062 PASS**;
- the corpus moved `1677 FAIL / 2433 UNRESOLVED / 0 PASS` →
  `1677 FAIL / 2425 UNRESOLVED / 8 PASS`, recomputed on both sides;
- `review_ready` unchanged at **867** — it derives only from the non-review
  conditions 3,4,6,7,8,9,10,11, so human decisions do not reduce it;
- **0 non-pilot drift**: exactly the eight approved identities changed `overall`
  or fingerprint, out of 4,110;
- exact replay returned **10/10 `already_applied`** with a byte-identical
  artefact-state checksum;
- **0 canonical writes**: 0 hotels, 0 `hotel_source_identities`, 0
  `hotel_contacts`, 0 terminal `resolution_state`.

A04.7 is deliberately **not** numbered as a roadmap round. It contracted no new
behaviour and changed no product code; it is an operational exercise of A04.5 and
A04.6 on real evidence, and this tracker counts implementation blocks. The eight
identities it produced are `source_environment = 'evaluation'` and are therefore
**permanently unpublishable** — they are the population A05's hard wall exists
for, and A05 carries the regression that keeps them unpublished.

**Why A05 is open.** A04 previews, A04.5 records the human decision, A04.6
withdraws it — and none of them writes a canonical row. A05 crosses the
irreversible boundary: an explicitly publication-authorized, PRODUCTION source
identity with a current 11/11 D062 PASS becomes a canonical hotel, an ACTIVE
canonical source link and a `resolved_eligible` source identity in one atomic
transaction, with immutable publication provenance. Its contract is
[`A05_ATOMIC_D062_PUBLICATION_CONTRACT.md`](A05_ATOMIC_D062_PUBLICATION_CONTRACT.md),
implemented by migration `0034` and `scripts/source-publication/*`.

**Amendment #1 (external audit).** Three database-integrity blockers, all
reproduced on real PostgreSQL before being fixed. The claimed publication IFF was
one-way, so `hotel → ACTIVE link → resolved_eligible` with **no publication
receipt at all** committed happily — a canonical hotel through the
source-publication lifecycle with no human authorization behind it. A REVOKED
approval was still publishable by direct SQL, because the receipt trigger read
the immutable review receipt and never asked whether it was still the
authorization in force. And the canonical field policy was writer-only for name,
address and country, so direct SQL could publish a name nobody affirmed, an
address the human explicitly CONTRADICTED, or a fabricated country code. The
invariant is now two-sided and enforced from both write origins; the cited
approval must be the current, active, unwithdrawn one about the current
observation; and the full field policy is a database property. 0034 was amended
in place, and the migration refuses to run against a database already carrying an
unaccountable `resolved_eligible` identity rather than inventing history.

A05 merged as PR #32 (final audited head
`463b0e32afdb94b7c4a0ffff999468829f89ccce`, merge commit
`ed857f0ba38013772b5a94d488ed9295123676fb`) — **FINAL PASS**. At that head:

- **1,750 tests** across 59 files, CI green on the exact head;
- a true **publication receipt ↔ `resolved_eligible`** invariant, both
  directions, deferred to COMMIT and registered on both write origins;
- publication requires a **current, active, non-revoked** human approval about
  the **current** observation;
- the canonical field policy — destination, star, coordinates, scope, name,
  address, country, `active_status`, and the fields A05 does not own — enforced
  by the writer **and** by the database;
- **evaluation identities permanently unpublishable**, with the A04.7 pilot's
  eight real 11/11 PASS provider ids as the committed regression;
- **no real production hotel published**, and none exists.

**PHASE A CODE GATE COMPLETE.** A real source property can reach a
human-reviewable canonical publication decision, and an explicitly authorized one
can become canonical inventory, without hidden assumptions or direct
provider-to-canonical shortcuts. What remains open in Phase A is operational, not
structural: no production provider ingestion exists yet, so nothing has been
published.

**Milestone A gate:** a real source property can reach a human-reviewable canonical publication decision without hidden assumptions or direct provider-to-canonical shortcuts.

---

## PHASE B — Gmail Historical Intelligence Data Pipe

**Goal:** prove whether creator inbox history contains enough qualified hotel outreach to create a proprietary outcome dataset.

**Before B01:** ChatGPT performs a current primary-source Gmail/OAuth/privacy/technical contract. Do not let CC invent scopes, retention or shared-data semantics.

**That contract is closed.** The architecture owner performed the primary-source
research on 2026-08-27; it is recorded as **D067** and implemented as
[`B01_GMAIL_DATA_BOUNDARY_CONTRACT.md`](B01_GMAIL_DATA_BOUNDARY_CONTRACT.md) plus
migration `0035`. Headline inputs: `gmail.readonly` (RESTRICTED) is required and
`gmail.metadata` is insufficient — no message body, and the `q` search parameter
is unavailable under it; `gmail.send` (SENSITIVE) is requested later through
incremental authorization; Limited Use follows **derived** data, so a reply
classification remains Gmail-derived; and network contribution is a **separate,
explicit, revocable, default-OFF** consent rather than something a blanket
"connect Gmail" click can imply.

**B01 is schema, contract and RLS only. Gmail OAuth is NOT implemented** — no
client id, no callback, no API call, no token stored, no mailbox connected. That
is B02.

| Round | Status | Implementation block | Core gate |
|---|---|---|---|
| B01 | **DONE** — PR #33, merge `d4a9e81d` | mail-account + consent + private communication data model | explicit provider identities, tenant isolation, revocation/deletion semantics |
| B02 | **IN PROGRESS** — open PR, not merged | Gmail OAuth connection / reconnect / disconnect | minimum approved scopes; secrets server-only; DB permission tests |
| B03 | GATED | historical import job pipeline | resumable/idempotent import; provider rate limits; no duplicate messages |
| B04 | GATED | normalized thread/message/event representation | provider IDs preserved; private raw vs derived data boundary explicit |
| B05 | GATED | hotel-outreach thread detection + canonical hotel matching/review | measurable precision/recall; ambiguous target identity cannot silently merge |
| B06 | GATED | sent/reply/time-to-reply extraction | qualifying human reply semantics explicit; auto/delivery noise separated |
| B07 | GATED | reply/outcome classification + creator correction loop | structured taxonomy; confidence; correction provenance |
| B08 | GATED | ongoing incremental Gmail sync + pilot instrumentation | new sent/replies arrive without full re-import; quality/data-density KPIs observable |

**Base rounds:** 8  
**Cumulative future rounds:** 12

**Milestone B gate — Historical Inbox Truth Test:**

We can connect a small professional-creator cohort and measure:

- opt-in rate;
- qualified hotel threads per inbox;
- thread-detection precision/recall;
- % automatically classifiable outcomes;
- unique hotels per 1,000 outcomes;
- median observations/property;
- metadata completeness;
- correction rate.

If qualified data is too sparse/ambiguous, pause before building a large intelligence product.

---

## PHASE C — Intelligence V1

**Goal:** transform private operational history into useful personal/network decision intelligence without misleading precision.

| Round | Status | Implementation block | Core gate |
|---|---|---|---|
| C01 | GATED | normalized intelligence event/fact contract | every derived fact traces to canonical target + private evidence/event |
| C02 | GATED | freshness, confidence and data-strength engine | unknown ≠ zero; weak sample cannot render false precision |
| C03 | GATED | personal + privacy-safe network aggregates | private creator data cannot leak; aggregation thresholds/contracts explicit |
| C04 | GATED | ranking / creator-fit V1 + hierarchical-prior experiment | compare against simple baseline; no opaque score without evidence |
| C05 | GATED | intelligence APIs + destination/property decision UI experiment | creators demonstrably change/prioritize decisions or save meaningful time |

**Base rounds:** 5  
**Cumulative future rounds:** 17

**Milestone C gate — Intelligence Value Test:**

Compare a static/public-data experience with behavioral intelligence.

Measure:

- decision-change rate;
- time saved;
- contact choice changes;
- reply/collaboration lift where sample permits;
- calibration;
- creator trust in confidence/freshness display.

At this point the central intelligence thesis should be materially more or less credible.

---

## PHASE D — Complete the Travel Creator OS loop

**Goal:** make TheUGC.life the creator’s actual system of record from trip intent through completed collaboration.

Reuse existing pipeline, event-ledger, negotiation and collaboration foundations. Do not rebuild working core logic merely because UI/product sequencing changes.

| Round | Status | Implementation block | Core gate |
|---|---|---|---|
| D01 | PLANNED | Trips: destination/date/context + shortlist + trip summary | targets/pipeline/collabs share one trip context |
| D02 | PLANNED | Contact Hub + enrichment/verification adapter | best route/role available; provenance and freshness visible |
| D03 | PLANNED | AI assistance service + contextual composer | reusable structured AI service; not model calls scattered through UI |
| D04 | PLANNED | Gmail send from OS | exact sent event linked to target/contact/trip/pipeline |
| D05 | PLANNED | follow-up scheduling/automation | reply-aware stop; safe sending limits; transparent next action |
| D06 | PLANNED | unified Inbox ↔ Pipeline experience | email state and CRM state cannot drift silently |
| D07 | PLANNED | collaboration workspace + deliverables over existing lifecycle core | won deal flows through execution/completion without external spreadsheet |
| D08 | PLANNED | creator context + personal analytics + verified proof/portfolio layer | history is reused to improve next opportunity, not just archived |

**Base rounds:** 8  
**Cumulative future rounds:** 25

**Milestone D gate — Complete Travel OS loop:**

A creator can:

```text
destination
→ discover
→ prioritize
→ contact
→ send
→ follow up
→ negotiate
→ win
→ execute deliverables
→ complete outcome
→ see learned intelligence
```

without needing Sheets/Notion/a separate CRM as the operational source of truth.

---

## PHASE E — Commercial Travel V1 / Product Experience / Launch Readiness

**Goal:** turn the complete loop into a coherent, reliable paid product.

| Round | Status | Implementation block | Core gate |
|---|---|---|---|
| E01 | PLANNED | Sunlit Creator OS Discover + Map + Hotel Detail production experience | A2 visual direction, real canonical data, no demo leakage |
| E02 | PLANNED | Home + Trips + Pipeline + Inbox + Collaboration product coherence | one navigation/information architecture; no module feels like separate software |
| E03 | PLANNED | onboarding + activation + empty/error/recovery states | new qualified creator reaches useful first workflow quickly |
| E04 | PLANNED | entitlement/billing audit for Pass/Pro + new modules | one canonical inventory; feature access correct; no accidental data exposure |
| E05 | PLANNED | E2E, observability, security/privacy, data QA and launch operations | failure/retry/admin paths tested; launch candidate gate explicit |

**Base rounds:** 5  
**Cumulative future rounds:** 30

**Milestone E gate — Commercial Travel Creator OS V1:** real users can pay, activate, manage real opportunity cycles and return for a later trip.

---

## PHASE F — Agency / Manager OS

**Goal:** support high-volume multi-creator workflows, higher ARPU and denser outcome data.

| Round | Status | Implementation block | Core gate |
|---|---|---|---|
| F01 | PLANNED | organization/workspace tenancy + agency RBAC | DB-level isolation across agency/creator/private mailbox boundaries |
| F02 | PLANNED | managed creators + assignment + shared targets/contacts | manager can coordinate without impersonating private creator ownership |
| F03 | PLANNED | agency pipeline/calendar/reporting | multi-creator operational dashboard with clear responsibility/state |
| F04 | PLANNED | agency analytics + billing/limits | value and usage support a distinct agency commercial plan |

**Base rounds:** 4  
**Cumulative future rounds:** 34

**Milestone F gate:** one manager can run several creators through the OS without privacy ambiguity or spreadsheet-level operational gaps.

---

## PHASE G — Travel Scale

**Goal:** expand supply depth after the product loop and paid value are validated.

| Round | Status | Implementation block | Core gate |
|---|---|---|---|
| G01 | GATED | Coverage Engine | destination closure cannot hide unresolved candidates |
| G02 | GATED | Provider B evaluation + adapter | expands coverage universe; does not revalidate every Hotelbeds star by default |
| G03 | GATED | scalable contact/media/enrichment queues + provider economics | quality/freshness/cost measurable per destination |
| G04 | GATED | destination closure + DataOps/freshness tooling | repeatable operating process for expanding destinations safely |

**Base rounds:** 4  
**Cumulative future rounds:** 38

**Milestone G gate:** destination expansion is a repeatable operation rather than custom research work.

---

## PHASE H — First second-vertical pilot

**Goal:** prove that the operating system generalizes beyond travel without destroying travel quality.

**Before H01:** market research chooses the vertical based on demand, workflow similarity, monetization and data access.

| Round | Status | Implementation block | Core gate |
|---|---|---|---|
| H01 | GATED | second-vertical product/data contract + shared-core boundary | no premature mega-schema; explicit shared vs vertical-specific concepts |
| H02 | GATED | generalized opportunity/target seam + second-vertical source adapter | existing travel contracts remain stable |
| H03 | GATED | second-vertical Discover + Contact workflow | creator can identify and contact targets in same workspace |
| H04 | GATED | reuse Outreach/Deal/Deliverable/Outcome core across verticals | no duplicated CRM stack per industry |
| H05 | GATED | second-vertical intelligence + cross-vertical creator dashboard | same creator gets meaningful value across two categories |

**Base rounds:** 5  
**Cumulative future rounds:** 43

**Milestone H gate:** TheUGC.life is demonstrably a Creator OS with travel as its first vertical, not merely a hotel-collaboration app.

---

# 3. Milestone round estimate summary

| Milestone | Future base CC rounds from PR25 baseline | What exists at that point |
|---|---:|---|
| Canonical Travel Truth | **4** | trustworthy publishable property pipeline |
| Historical Inbox + Intelligence proof | **17** | real historical outcomes + decision intelligence experiment |
| Complete Travel OS loop | **25** | discover→outcome operational system |
| Commercial Travel V1 | **30** | paid/polished/observable launch candidate |
| Agency OS | **34** | multi-creator organization product |
| Travel scale machinery | **38** | repeatable destination/provider expansion |
| First second vertical | **43** | first proof of generalized Creator OS |

Planning range for the full sequence: **35–52 base rounds**.

---

# 4. Calendar-time scenarios

These are planning scenarios, not promises. Audit/correction loops are excluded from the round count but must be included in calendar buffer.

### Scenario 1 — ~1 merged base round/week

- Intelligence proof: ~17 weeks base; plan **5–6 months** with correction/research buffer.
- Commercial Travel V1: ~30 weeks base; plan **8–10 months**.
- Agency OS: ~34 weeks base; plan **9–11 months**.
- Second vertical pilot: ~43 weeks base; plan **11–14 months**.

### Scenario 2 — ~2 merged base rounds/week

- Intelligence proof: ~8.5 weeks base; plan **2.5–3.5 months**.
- Commercial Travel V1: ~15 weeks base; plan **4.5–6 months**.
- Agency OS: ~17 weeks base; plan **5–7 months**.
- Second vertical pilot: ~21.5 weeks base; plan **6.5–8.5 months**.

### Scenario 3 — ~3 merged base rounds/week

This requires small, well-contracted blocks and enough CC availability. It should not be achieved by skipping audits.

- Intelligence proof: ~6 weeks base; plan **2–2.5 months**.
- Commercial Travel V1: ~10 weeks base; plan **3–4 months**.
- Agency OS: ~11–12 weeks base; plan **3.5–4.5 months**.
- Second vertical pilot: ~14–15 weeks base; plan **4.5–6 months**.

### Recommended planning assumption

Use **Scenario 2 as an optimistic-but-responsible operating target** and Scenario 1 as the conservative capacity case.

The objective is not to maximize PR count/week. The objective is to maintain the current quality loop while reducing wasted work through better contracts.

---

# 5. What can change the estimate

## Could reduce rounds

- existing pipeline/negotiation/collaboration code proves reusable with only UI work;
- Gmail integration can share one coherent persistence model for historical + ongoing sync;
- intelligence and personal analytics share the same event/aggregate framework;
- design modules can be implemented safely in larger visual batches after behavior is stable.

## Could increase rounds

- Gmail OAuth/privacy requirements force additional security/data-retention work;
- historical thread matching to canonical hotels is harder than expected;
- outcome classification accuracy requires a dedicated evaluation/human-review subsystem;
- agency permissions require finer-grained private-mail boundaries;
- provider commercial rights force inventory/media substitutions;
- second vertical exposes a real need to refactor shared domain primitives.

---

# 6. Business experiment gates that can pause engineering

The roadmap is not an instruction to blindly complete 43 rounds.

### Gate B — Historical Inbox Truth

Pause/rethink if professional creators will not opt in or inboxes contain too little qualified data.

### Gate C — Intelligence Value

Pause/rethink if behavior-based ranking does not change decisions or outperform a simple static heuristic.

### Gate E — Paid Travel V1

Pause/rethink pricing/ICP if creators will not pay for the integrated value even when real intelligence exists.

### Gate H — Second vertical

Do not generalize merely because travel code is mature. Choose the second vertical through fresh market research.

---

# 7. Current business hypotheses to measure

| Hypothesis | Current state | How to validate |
|---|---|---|
| Professional travel creators have repeated outbound pain | supported, not fully quantified | qualified-user recruitment + historical inbox analysis |
| An all-in-one OS is more valuable than disconnected tools | strategic hypothesis | activation/retention + competitor-switch interviews + usage concentration |
| $39 Destination Pass works with actionable intelligence | plausible, unproven | real paid destination pilot |
| $199/year Pro works for semi-pro/pro creators | plausible, unproven | annual paid beta conversion |
| Historical Gmail can rapidly seed a proprietary dataset | high-value hypothesis | qualified threads / connected inbox |
| Creator-conditioned intelligence improves decisions | unproven | baseline-vs-intelligence decision/lift experiment |
| Agency accounts are higher-value and data-dense | plausible | agency data-partner pilot + workflow interviews |
| Travel core can generalize to other UGC industries | vision, not yet validated | second-vertical research/pilot |

---

# 8. Progress update protocol

After each merged base round, update this tracker with:

- round status `DONE`;
- actual PR number;
- merge date;
- important scope deviation;
- any newly discovered dependency;
- cumulative completed future rounds.

After every 5–8 merged base rounds:

1. compare actual complexity with estimate;
2. update remaining round range;
3. update calendar scenarios;
4. record strategic changes in `MASTER_PLAN.md` if needed;
5. preserve completed history rather than renumbering old rounds.

---

# 9. Immediate next move

At this baseline, Phase A is closed at the code gate:

> **A01 (PR #26), A02 (PR #27), A03 (PR #28), A04 (PR #29), A04.5 (PR #30),
> A04.6 (PR #31) and A05 (PR #32) are all merged.** A04 landed on `main` as merge
> commit `6cffa8b9`; A04.5 as `bbd0d887e6c15b7dea881b77667213b8ef5232a2`; A04.6
> as `da968185fb3125b33b3b965e63f153ada0ad552f`; A05 as
> `ed857f0ba38013772b5a94d488ed9295123676fb`.

> **A04.6 (PR #31) is merged as `da968185fb3125b33b3b965e63f153ada0ad552f`.**

The open implementation block is:

> **B02 — Gmail OAuth connection, reconnect and disconnect. Open PR #34, not
> merged, on external audit amendment #5, awaiting re-audit and the human merge
> gate.**

**B02 external audit amendment #5 (2026-08-28)** closed two findings against
head `16cdea0`:

- **a stale OAuth flow could reauthorize Google after a Disconnect.** Reproduced
  at the audited head: a Reconnect begun, a real Disconnect performed
  (`disconnected`, zero credentials), then the old callback landing —
  1 code exchange, 0 revocations, and the grant live again at Google while the
  mailbox read `disconnected`. Disconnect now records the human's intent BEFORE
  the network call: `gmail_disconnect_prepare` cancels the mailbox's outstanding
  OAuth transactions, moves the row to a new `disconnecting` state and pins
  `disconnect_requested_revision`. The stale callback then finds no transaction
  and exchanges nothing. For the genuine race — the callback consumed its
  transaction first — the persist answers `superseded_by_disconnect` and that
  one refusal revokes, because there the project-wide revocation is exactly what
  the human asked for. Every other refusal still revokes nothing;
- **Disconnect could reach into a running deletion.** A `deletion_pending`
  mailbox was protected only incidentally, by a B01 CHECK written for a different
  purpose, and only as an unhandled `check_violation` rather than an answer.
  Prepare and finalize now refuse it as `deletion_in_progress`, and `deleted` as
  `account_retired`.

`disconnecting` is a real state, not a synonym for `disconnected`: access has not
stopped yet and the credential is deliberately retained, because it is the only
thing that can revoke. It is the one state whose credential invariant is a range
(zero or one, enforced as an upper bound), no read path treats it as usable, and
Disconnect accepts it so a failed revocation can be retried.

**B02 external audit amendment #4 (2026-08-28)** closed four findings against
head `88d4b8e`:

- the lifecycle revision was **checked but not reserved**. Reproduced with two
  real PostgreSQL sessions: the callback read revision N, a Disconnect committed
  N+1, and the callback still wrote. The reconnect target is now locked
  `for no key update` before anything is compared;
- a successful reconnect did not **consume** its revision, so two flows begun
  against the same version could both land — the second replacing the first's
  credential. A successful reconnect now advances it, requested by the function
  and numbered by the trigger, which also now fires on INSERT;
- `consent_required` with an older `granted` consent for a narrower scope set
  left the UI showing "Awaiting your permission" **with no way to give it**. The
  prompt now follows the state, which is the authority;
- the contract still told a future maintainer that a failed health check and an
  account mismatch revoke the grant — the exact defect amendment #2 removed from
  the code. All refusal paths now agree.

Also: one creator may have many mailboxes (B01 says so), and the panel now offers
**Connect another Gmail**; Reconnect is offered only for the states the database
accepts.

**B02 external audit amendment #3 (2026-08-28)** closed the last two
merge-blocking findings against head `b50eff0`:

- an OAuth flow had no causality token, so a Reconnect started before an explicit
  Disconnect **landed afterwards and undid it** — restoring the credential and
  the `connected` state. `mail_accounts.authorization_revision` is pinned at
  start and required exactly at the callback; checking the state name would not
  have been enough, because a mailbox can leave a reconnectable state and return
  to one. A generic Connect may no longer revive a live mailbox at all — it never
  pinned a revision for an identity it learns only at the callback — and answers
  `reconnect_required` instead;
- the migration guard checked only one of the two invariants 0036 installs. A
  `pending_authorization` row with a non-empty scope set is valid under 0035 and
  forbidden by 0036, and the migration completed on one. It now refuses.

**B02 external audit amendment #2 (2026-08-28)** closed three further
merge-blocking findings against head `578bf37`:

- Google's revocation is **project-wide** — it removes every scope the project
  holds for that user. B02 was using it as callback cleanup, so refusing an
  authorization destroyed whatever else that person had connected; a stranger
  authorizing someone else's Google account could disconnect the real owner. A
  refused callback now revokes nothing; explicit Disconnect still does, and the
  runbook records the OAuth project as an authorization domain that unrelated
  Google integrations must not share;
- credential mutations had no concurrency token, so a slow worker could overwrite
  a newer credential, delete one it never saw, or drag a **disconnected** mailbox
  back to `reauth_required`. Every mutation is now compare-and-swap on a
  database-owned `credential_generation`, and a final currentness check runs
  before any access token is handed over;
- 0036 completed successfully on a database where `connected` mailboxes held zero
  credentials — the invariant it claims to establish was already false. It now
  **refuses to install**, names the rows, and leaves them to an operator.

**B02 external audit amendment #1 (2026-08-28)** closed five merge-blocking
findings against head `99833bd`, all reproduced as real committed states first:

- a successful Google authorization sat in `pending_authorization` — a state 0035
  defines as "not authorized, no access" — while holding `gmail.readonly` and a
  live refresh token. 0036 now ALTERs that CHECK to add **`consent_required`**,
  additively, and the correspondence between the state word and the stored
  credential is a **deferred invariant** rather than writer discipline;
- "reconnect mailbox A" fell through to a generic connect when the human chose a
  different Google account, silently creating a mailbox or reporting success for
  one they never named. The reconnect target is now bound to the verified Google
  subject **before** any general case applies, and `purpose`/`target` is an IFF;
- three errors Google documents against OUR client and OUR request were treated
  as proof that a CREATOR's refresh token had died, so one wrong environment
  variable would have deleted every credential it touched. Only `invalid_grant`
  is destructive now;
- a rotated refresh token whose storage failed was reported as a successful
  refresh, leaving the mailbox holding a value that stops working;
- Disconnect loaded the encrypted credential for a browser-supplied mailbox id
  and compared owners afterwards. User-initiated actions now use an owner-bound
  RPC where the authenticated user is part of the lookup.

**B01 is DONE and merged.** PR #33, final audited head
`699c07b651303406cd4131376c15f62cfb33adf0`, merged as
`d4a9e81d9f7d800d8b17ff5af7e85544fd0b883c`, with 1,843 tests passing at the
audited head. It passed on the third external audit amendment; what it
established, and what B02 now builds on:

- the private Gmail plane is isolated from admin/editor **client** access —
  `is_admin_or_editor()` governs nothing in it;
- private-processing and network-intelligence consent are **separate**, the
  second explicit, revocable and default NOT granted;
- the **latest consent event dominates**, ordered by a database-owned ordinal
  rather than a caller-supplied timestamp;
- a durable Google provider identity has **exactly one app owner**, held in its
  own registry spanning a mailbox's whole history;
- after a terminal deletion the **same owner may reconnect** through a NEW row,
  inheriting no consent and no history;
- **cross-owner transfer of a provider identity is refused**, and the ownership
  reservation is released **only** by full app-user erasure;
- and B01 implemented **no Gmail OAuth, no token storage and no message table** —
  which is precisely the gap B02 fills.

B02 does **not** implement email import. Historical import begins at B03.

**Phase A's code gate is closed.** A05 merged as `ed857f0b`, and with it the
canonical property spine: preview (A04), human decision (A04.5), withdrawal
(A04.6), a real ten-property pilot on evaluation evidence (A04.7) and atomic
authorized publication (A05). No canonical hotel has been published, because no
production provider ingestion exists yet — that is operational work, not a
missing structure.

External audit amendment #1 (2026-08-27) closed four integrity blockers in `0035`
before any of it was merged, each first reproduced as a real committed state on
PostgreSQL using nothing but direct SQL: a withdrawal that could be recorded
without taking effect, a current consent that could be rewound to a grant already
withdrawn, a `deleted` mailbox produced by a deletion nobody asked for, and a
consent receipt that could describe a mailbox that never existed. `deleted` is
now terminal, consent events carry a database-owned ordinal, and the scope
snapshot is checked against the account rather than accepted from the writer. The
migration was amended IN PLACE — `0035` is unmerged, so there is no history to
correct with an `0036`.

External audit amendment #3 (2026-08-27) closed the last opening in that model:
the ownership reservation could be deleted outright while its owner still
existed, so the same cross-owner transfer was reachable by removing a mailbox row
and then its reservation. Releasing a reservation is now possible only as part of
erasing the owning user, and the trusted role no longer holds DELETE on the
registry.

External audit amendment #2 (2026-08-27) closed a regression amendment #1 had
introduced. Making `deleted` terminal meant a creator reconnecting their own
Gmail account needed a new row, which required relaxing the provider-subject
uniqueness to live rows only — and that stopped the database seeing retired rows
at all, so a second app user could claim a Google account whose previous owner's
consent receipts and deletion record were still on file. Ownership of a durable
provider identity now lives in its own registry spanning a mailbox's whole
history, with the live-row rule left to govern only the present. Reproduced
first, as a real committed cross-owner state, then closed.

B01 opens Phase B on a deliberately different footing. Everything Phase A built
is provider evidence reviewed by staff whose job is to review it; a creator's
mailbox is private correspondence, and under Google's restricted-scope rules the
obligations follow the data including what is derived from it. So the boundary is
fixed before the first message exists, and `public.is_admin_or_editor()` — which
governs every Phase-A evidence table — governs nothing in the new plane.

The canonical target spine must still be closed before Gmail implementation
begins. In parallel, business/technical research may prepare the Gmail contract,
so Phase B can begin immediately after the publication spine is closed.
