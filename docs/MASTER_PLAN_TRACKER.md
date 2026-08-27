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
| A04.6 | **IN PROGRESS** — open PR, not merged | human review revocation | a human can withdraw a previous `approve_create` so it immediately stops authorizing D062, without touching the immutable receipt, deleting history, or publishing anything |
| A05 | PLANNED | human authorization + atomic D062 apply | canonical hotel/source link created atomically; publication provenance immutable |

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

A04.6 is **not DONE** — it is an open PR awaiting external audit and the human
merge gate. A05 remains PLANNED and is not authorized by this entry.

**Milestone A gate:** a real source property can reach a human-reviewable canonical publication decision without hidden assumptions or direct provider-to-canonical shortcuts.

---

## PHASE B — Gmail Historical Intelligence Data Pipe

**Goal:** prove whether creator inbox history contains enough qualified hotel outreach to create a proprietary outcome dataset.

**Before B01:** ChatGPT performs a current primary-source Gmail/OAuth/privacy/technical contract. Do not let CC invent scopes, retention or shared-data semantics.

| Round | Status | Implementation block | Core gate |
|---|---|---|---|
| B01 | GATED | mail-account + consent + private communication data model | explicit provider identities, tenant isolation, revocation/deletion semantics |
| B02 | GATED | Gmail OAuth connection / reconnect / disconnect | minimum approved scopes; secrets server-only; DB permission tests |
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

At this baseline, Phase A's evidence and preview layers are closed:

> **A01 (PR #26), A02 (PR #27), A03 (PR #28), A04 (PR #29) and A04.5 (PR #30)
> are merged.** A04 landed on `main` as merge commit `6cffa8b9`; A04.5 as
> `bbd0d887e6c15b7dea881b77667213b8ef5232a2`.

The open implementation block is:

> **A04.6 — human review revocation. Open PR, not merged, awaiting external
> audit and the human merge gate.**

A04.6 is the only round open. A05 (human authorization + atomic D062 apply) comes
after A04.6 merges, not after A04.5, and is not started by this entry. Nothing
may be published on the strength of A04, A04.5 or A04.6: A04 previews
pre-publication evidence, A04.5 records a human decision about it, and A04.6
withdraws one. None of them authorizes publication, and none writes a canonical
row.

The canonical target spine must still be closed before Gmail implementation
begins. In parallel, business/technical research may prepare the Gmail contract,
so Phase B can begin immediately after the publication spine is closed.
