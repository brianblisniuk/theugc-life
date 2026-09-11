# B07 — Gmail Commercial Meaning Contract

**Status:** Contract accepted — the product/architecture strategy below is locked by the product owner for this round (D072). This document formalizes that locked strategy and is submitted, in this same PR, for a final product-owner read-through of the written artifact before B07 implementation begins. Nothing below is implemented: no schema, migration, application code or model/vendor selection exists yet.
**Decision:** D072 — Gmail commercial meaning is private, multi-axis, provenance-bound and human-correctable.
**Implementation round:** B07.
**Expected migration:** `0041_gmail_commercial_meaning.sql` — RESERVED number only. No migration exists yet; nothing in this document is implemented.
**Depends on:** D067, D068, D069, D070, D071; B03 (`0037`), B04 (`0038`), B05 (`0039`), B06 (`0040`).

This document is the accepted B07 product/architecture contract. It does not itself authorize implementation, schema, migration, application code or model/vendor selection — the implementation round is a separate, later piece of work gated on this contract. D072 is mirrored into `docs/DECISIONS.md` and `docs/MASTER_PLAN_TRACKER.md` is updated from B06 CURRENT PR / B07 GATED to B06 DONE / B07 NEXT by this same PR. The future B07 implementation PR must update the tracker again, from B07 NEXT to B07 DONE with its real migration number, PR and merge SHA, without changing the substance below.

---

## 1. The one question B07 answers

B03 answered **what historical Gmail evidence exists**.
B04 answered **how that evidence is normalized privately and deterministically**.
B05 answered **which conversations are creator-commercial outreach and who/what was being targeted**.
B06 answered **what happened chronologically after creator-sent messages: which later messages are plausible responses, which are qualifying human replies versus automated/delivery noise or ambiguity, and how much observed time elapsed**.

**B07 answers only:**

> Given a commercially relevant Gmail thread whose reply chronology has already been established by B06, what BUSINESS MEANING is supported by the observed conversation, and what has the CREATOR explicitly confirmed or corrected about that meaning?

B07 introduces commercial semantics. It does **not**:

- turn machine inference into creator truth;
- materialize Gmail history into the live CRM;
- perform incremental Gmail acquisition;
- reconsider whether a thread is commercial outreach (B05), who the target is (B05), or whether a message is a qualifying human reply as a matter of chronology (B06) — it consumes those layers;
- decide deal-value, deliverables, payment status or invoice state;
- decide an automatic ghosting policy over ongoing observation (B08).

Those belong to B05, B06, B08, later Deal/Collaboration/Deliverables contracts, or a separate future CRM-reconciliation contract.

### The central principle

```text
OBSERVED COMMUNICATION
  → MACHINE COMMERCIAL INTERPRETATION
    → CREATOR CORRECTION / CONFIRMATION
```

These are three different epistemic layers, extending D070's epistemic ladder (§6 below) one rung further. B07 never collapses them: a machine interpretation is never presented as creator truth, and a creator's confirmed decision is never silently overwritten by a later machine rerun, a model upgrade, or a prompt change.

---

## 2. B07 is local private computation, not another Gmail acquisition layer

B07 performs **zero Gmail API calls**, requests **zero new OAuth scopes**, sends nothing, and performs no incremental sync. It reads already-stored private evidence.

Primary inputs (§14 lists the exact bound):

- B04 normalized message text/subject/participants, as required by the current semantic task;
- B05 current commercial-thread/target context, where relevant to interpreting business meaning;
- B06 current reply chronology, response-class and relation evidence — B07's primary anchor;
- creator-SENT messages, when needed as context for reciprocal agreement or negotiation chronology.

B07 does not mutate B03, B04, B05 or B06 evidence. B08 owns ongoing Gmail sync; B07 has no watch subscription, no history cursor, no incremental acquisition of any kind.

---

## 3. Message-level commercial disposition

For a B07-semantically-eligible human reply (§15), machine interpretation may assign exactly one BUSINESS disposition — never emotional sentiment:

| Value | Means |
|---|---|
| `positive` | the reply materially advances the possibility of a commercial collaboration |
| `negative` | the reply explicitly declines or closes that possibility |
| `neutral` | the reply is operational/informational without materially advancing or declining the opportunity |
| `mixed` | the same message contains materially conflicting advancing and negative/constraining signals |
| `ambiguous` | evidence is insufficient to classify honestly |

Definitions are deliberately conservative. Politeness alone never implies disposition: "Thanks for reaching out" is not, by itself, `positive`. A disposition requires content that actually bears on whether a commercial collaboration is advancing, declining, or neither — not the presence or absence of courteous language. See §26 for worked adversarial examples.

`mixed` and `ambiguous` are both first-class, correct outputs, not failure states, mirroring B06's treatment of `ambiguous_inbound` (D071).

---

## 4. Message-level commercial signals

A single reply may express multiple commercial acts simultaneously. B07 stores a SET of signals per message, never one mutually-exclusive label.

V1 controlled vocabulary:

`interest` · `request_information` · `redirect` · `terms_discussion` · `offer` · `agreement` · `rejection` · `timing_constraint` · `other_commercial`

Worked examples (illustrative, not the exhaustive rule set):

- *"We'd love to explore this. Can you send your media kit and rates?"* → `{interest, request_information, terms_discussion}`
- *"Please contact our PR agency instead"* → `{redirect}`
- *"We can host you for two nights but cannot offer payment"* → `{offer, terms_discussion}`

V1 deliberately does not create dozens of micro-intents, and does not extract generic emotional sentiment. `other_commercial` exists for a genuinely commercial act that does not fit the other eight — it is not a dumping ground for uncertainty, which belongs to disposition `ambiguous`/evidence strength `insufficient_evidence` instead.

The signal SET is independent of disposition: `offer` commonly co-occurs with `positive`, but a hostile or clearly declining offer-adjacent message (e.g. an ultimatum) is not automatically `positive` merely because `offer`-shaped language appears.

---

## 5. Thread-level machine commercial state

A current eligible thread carries one machine ADVISORY state — never CRM state, never a creator-confirmed outcome:

| Value | Means |
|---|---|
| `unresolved` | a human commercial reply exists but no stronger state is supported |
| `engaged` | commercial human engagement exists but no supported negotiation or terminal business meaning has been established |
| `negotiating` | terms/offer discussion is supported, but no explicit agreement is established |
| `agreement_observed` | explicit evidence supports an agreement/confirmation |
| `declined_observed` | explicit rejection/decline is currently supported |
| `ambiguous` | conflicting or insufficient evidence prevents a safe current summary |

Precise boundaries:

- **`agreement_observed` requires explicit agreement evidence.** Mere interest, "sounds great," willingness to discuss, or an offer that has not been accepted is NOT agreement. An `offer` signal alone, however enthusiastic, never by itself promotes a thread to `agreement_observed`.
- **`declined_observed` is the CURRENT summary, not a permanent verdict.** A later reopening message may supersede it without deleting the earlier rejection observation — the underlying per-message observations always survive a summary change (§16).
- Underlying message-level observations must always survive summary changes; the thread summary is a replaceable machine projection over durable message-level facts, exactly as B06's `gmail_reply_thread_summaries` is a replaceable projection over durable `gmail_reply_message_observations` (D071, B06 §9).

---

## 6. Human business outcome

Creator-confirmed final/current business outcome is a DIFFERENT axis from the machine advisory state in §5 — a human fact, not a machine one:

| Value | Means |
|---|---|
| `open` | the creator considers the opportunity still active or undecided |
| `won` | the creator confirms a commercial collaboration/agreement was reached |
| `lost` | the creator confirms the opportunity ended without an agreement |
| `ghosted` | the creator confirms they consider the opportunity closed because communication stopped without a qualifying response/conclusion |
| `uncertain` | the creator cannot honestly classify it |

`won` does **not** mean the collaboration was completed. D045 remains unchanged: deal-won and collaboration-completion are distinct facts, and B07's `won` is not a substitute for, or a trigger of, D045's collaboration lifecycle — B07 writes no CRM row of any kind (§17).

### `ghosted` is human-confirmed only in B07

B06's historical absence is window-bounded and right-censored (D071, B06 §11): `no_qualifying_response_observed_in_window` is a statement about what was observed inside a proven horizon, not a claim that no reply will ever arrive. **B07 historical machine processing must never auto-assign `ghosted`.** A machine may not transform B06's `no_qualifying_response_observed_in_window` into `ghosted` under any circumstance. For B07 historical data, `ghosted` exists ONLY as an explicit human decision event on the thread business-outcome axis (§10, axis D; §11).

B08 may later contract an automatic ghosting policy using ongoing observation, an elapsed-time policy, and sufficient horizon completeness — a policy this contract does not specify and does not authorize. That is a genuinely different epistemic situation (continuous forward observation vs. a fixed historical window) and requires its own accepted decision.

---

## 7. Lost reason

Where the creator confirms `lost`, V1 reason vocabulary stays compatible with existing CRM semantics where possible:

`rejected` · `not_a_fit` · `timing` · `other`

This is deliberately a strict subset of D043's `deal_lost`/`creator_closed_pipeline` reason vocabulary (`no_reply`, `rejected`, `not_a_fit`, `timing`, `other`), omitting `no_reply` on purpose: B07 does not silently create CRM events from these values, and `ghosted` remains a separate B07 human outcome rather than pretending historical absence proves `lost`/`no_reply`. Any future CRM reconciliation may decide how B07's `ghosted` maps to D043's `deal_lost(reason=no_reply)` semantics — that mapping is explicitly **not** part of B07.

---

## 8. Commercial / compensation structure

B07 may interpret the broad compensation STRUCTURE when explicitly supported by evidence:

| Value | Means |
|---|---|
| `paid` | cash compensation is part of the supported terms |
| `in_kind` | non-cash value (e.g. a hosted stay, product or service) is the supported consideration |
| `hybrid` | cash + in-kind consideration |
| `unpaid` | evidence explicitly establishes no compensation/consideration |
| `other` | a supported structure that does not fit the above |
| `unknown` | compensation structure is not established |

**`unknown` must never mean `unpaid`.** The two are opposite epistemic states: `unknown` is an absence of evidence, `unpaid` is a positive finding from evidence that no compensation applies. Collapsing them would fabricate a negative business fact from silence.

B07 V1 explicitly does **not** extract: exact monetary amount, currency, exact hosted value, deliverable counts, usage-rights terms, payment status, or invoice state. Those belong to later Deal / Collaboration / Deliverables contracts, not B07.

---

## 9. B07 owns creator correction of B06 reply nature

B06's machine observations remain untouched by B07 (D071, B06 §14). B07 lets a creator record a HUMAN correction/confirmation of a message's reply nature, anchored to the same stable provider-message coordinate B06 uses:

`human_reply` · `automated` · `delivery` · `not_reply` · `uncertain`

This is an OVERLAY, never an UPDATE to B06's machine `response_class`. A future B06 rerun may change machine belief; it may never overwrite the creator's B07 decision. Ordinary B07 effective reads must be able to show, simultaneously: machine belief, creator belief, agreement/disagreement between the two, and source/currentness context for each.

---

## 10. Human correction axes

Human truth must be independently recordable for each of these five axes — never forced together:

| Axis | What the creator is confirming |
|---|---|
| A. message reply nature | overlay on B06's `response_class` (§9) |
| B. message commercial disposition | overlay/confirmation of §3 |
| C. message commercial-signal SET | overlay/confirmation of §4 |
| D. thread business outcome | §6 |
| E. thread commercial/compensation structure | §8 |

A decision on one axis must not fabricate a decision on another: confirming thread outcome `won` does not imply any particular message disposition, and confirming a message as `human_reply` does not imply any disposition or signal for that same message.

Axis A carries one additional, narrow responsibility the other four axes do not: because reply nature gates whether a message is an eligible input to B07 semantic processing at all (§15), a creator's current Axis A decision is also a **machine currentness dependency** (§21) — a change that alters effective eligibility makes a prior machine interpretation stale for ordinary effective use. Axes B, C, D and E are overlays/confirmations of an existing machine value (or independent human thread truth, for D) and never rewrite, and never gate the currentness of, the machine interpretation they sit alongside.

For axis C (signal sets), a correction REPLACES the full human-confirmed set for that decision event, rather than applying untraceable incremental add/remove mutations — the same "replace the whole set, event by event" discipline the disposition, outcome and structure axes already get for free by being single-valued.

---

## 11. Append-only human decision history

B07 follows the B05 pattern exactly (D070, B05 §17/§17a):

- immutable human decision events, one per axis per decision;
- database-owned, strictly-increasing `event_seq` ordering per (account, durable anchor, axis) — never a caller-supplied ordinal, never wall-clock time, for the same reason D067 requires it of consent receipts: `decided_at` can be back-dated, `created_at` ties on batched writes, and a UUID's lexical order is not chronology;
- a current projection per (durable anchor, axis) that names the event with the greatest `event_seq` — the projection may never move backwards;
- a later creator correction creates a NEW event; nothing is ever mutated or deleted;
- an explicit human CLEAR/WITHDRAW action is itself a NEW event that returns the effective UI to machine-only advisory state for that axis — never a delete of the historical event, mirroring B05's tombstone pattern (`is_confirmed = false` as a new row-state, never row removal);
- machine reruns NEVER write to any human table, on any axis;
- the shared consent/lifecycle fence (§18) is taken by both the machine writer and every human-decision writer, before either touches its respective table — exactly the pattern `private.gmail_outreach_assert_may_process_locked` establishes in B05 (§17a).

The current projection must be structurally unable to point at a wrong-axis, wrong-account, wrong-message/thread, or superseded event — enforced by real foreign keys and CHECK constraints at implementation time, not by application discipline alone. This requirement is stated as a product/architecture constraint here; the exact constraint shapes are implementation detail for the B07 migration.

---

## 12. Durable anchors

MESSAGE human decisions (axes A, B, C) anchor to:

`(mail_account_id, provider_message_id)`

or B06's stable observation identity, whose durable meaning is that same provider coordinate. Human truth is never anchored only to a replaceable B04 normalized-message UUID — the identical reasoning D071/B06 §9 already established for machine observations applies with equal or greater force to human truth, since a human decision must survive every future B04 rebuild indefinitely.

THREAD human decisions (axes D, E) anchor to durable Gmail thread identity:

`(mail_account_id, provider_thread_id)`

not only a replaceable normalized-thread UUID.

Current B04/B06 row IDs may be retained as current pointers/provenance — useful for joins and for showing "which current message/thread this decision is about" — but never as the durable human identity itself.

---

## 13. Machine inference provenance

B06 machine interpretation is deterministic and rules-based (D071). B07 machine meaning is replaceable/advisory like B06's, but unlike B06 it may eventually use non-deterministic model inference. B07 must not pretend machine inference is deterministic when it is not.

Every successful machine interpretation must be provenance-bound to at least:

- mail account;
- durable provider thread/message coordinates (§12);
- the exact current source/input digest it was computed from;
- the relevant B06 observation identity/state/version it read;
- the B07 semantic-contract/schema version;
- inference-engine kind (e.g. deterministic-rules vs. model-backed);
- provider/model identity, when applicable;
- model/version identifier, when applicable;
- prompt/instruction version, when applicable;
- transformation version (the input-shaping/text-transform version, mirroring B06's `text_transform_version` and B05's classifier-input-transform version);
- evaluated timestamp.

This mirrors, and extends, B05's own provenance guarantee (§14): "we can reconstruct exactly what evidence and configuration produced this stored result" — never "calling the model again returns identical bytes." If a model call occurs, B07 preserves enough metadata to reproduce/audit WHAT SYSTEM produced the output, without duplicating unnecessary mailbox content into provenance storage itself.

---

## 14. Same input must not oscillate by default

Default production behavior: for the same input digest, the same semantic schema version, the same transform version, the same inference provider/model version, and the same prompt/instruction version, B07 must NOT automatically call the model repeatedly and let current state oscillate. The existing successful inference is treated as current — the same "exact replay is a true no-op" discipline B06 (D071, B06 §13) already established for its own deterministic evaluator, extended to a world where the underlying computation may not itself be byte-deterministic.

A deliberate benchmark/re-evaluation path may generate another inference attempt, but it must be explicit and auditable, never an accidental consequence of an ordinary replay/re-read path.

**Recommendation, not yet authorized to implement:** immutable inference-attempt rows plus a separate, replaceable current-projection row appear to be the cleanest architecture for this — an inference attempt is provenance-bound history (§13) exactly like a human decision event is, while the current projection is a replaceable pointer at the attempt currently treated as authoritative, mirroring the stable-anchor/replaceable-projection split B06 already uses between `gmail_reply_message_observations` and `gmail_reply_thread_summaries`. This contract records the recommendation; it does not implement it.

---

## 15. Effective human-reply eligibility

Machine semantic classification may ordinarily process a B06 current `qualifying_human_reply`.

If a creator has a current B07 human reply-nature decision (§9) for that message:

- `human_reply` establishes human-reply eligibility for B07 semantic meaning;
- `automated`, `delivery`, or `not_reply` SUPPRESS that message from effective human-reply semantics — B07 must not compute disposition/signals for a message the creator has confirmed is not a human reply;
- `uncertain` must NOT be treated as confirmed human — it behaves like the absence of a correction for eligibility purposes (falling back to B06's own `qualifying_human_reply` classification), while still being visibly recorded as the creator's stated uncertainty. Machine advisory processing may still proceed on that fallback basis, but an effective read must never collapse "machine processing used the fallback" into "the creator confirmed human reply nature" — the creator's Axis A truth remains `uncertain`, displayed as such alongside whatever machine belief exists.

This overlay never mutates B06. A message B06 currently classifies as `qualifying_human_reply` with no B07 correction, or with an `uncertain` correction, remains eligible for B07 semantic processing on B06's own classification.

### Evidence strength / confidence

B07 uses qualitative machine evidence strength, never a fabricated numeric probability presented as creator-facing truth:

`strong` · `moderate` · `weak` · `insufficient_evidence`

This is explicitly a MACHINE assessment, not a calibrated statistical probability, unless a future evaluation separately proves calibration — mirroring B05's own qualitative-states discipline (§13: `strong_match` / `needs_review` / `ambiguous` / `insufficient_evidence`, "never a numeric/calibrated percentage"). Low or insufficient evidence must allow abstention: a classifier is allowed to say "I don't know" by returning `insufficient_evidence` (disposition `ambiguous`, or no signal/state assignment at all) rather than forcing an answer.

---

## 16. Which content B07 may read

B07 may read only already-stored private evidence necessary for the current eligible thread:

- B04 normalized message text/subject/participants, as required;
- B05 commercial-thread/target context, where relevant;
- B06 current reply chronology/response-class/relation evidence;
- creator-SENT messages, when needed as context for reciprocal agreement or negotiation chronology.

Message-level REPLY semantics (disposition, signals) apply only to an effective human reply (§15). Creator-SENT text may provide CONTEXT — for example, evidence of the creator's own acceptance of offered terms feeding thread-level state (§5/§6) — but a creator-SENT message must never be relabeled as a target reply, and never receives its own reply disposition/signal set.

---

## 17. Thread summary evolution over later messages

A current thread-level machine summary (§5) may evolve as later observed messages change the commercial picture. It must never invent a lifecycle B07 does not own. Worked examples:

- rejection → later reopening: must not remain permanently `declined_observed`;
- offer → counter-discussion: may become/stay `negotiating`;
- offer → explicit confirmation: may become `agreement_observed`;
- agreement → later contradictory/cancellation evidence: must NOT be silently forced into a clean `agreement_observed` state if the evidence is materially conflicting — prefer `ambiguous` over inventing a collaboration-cancellation lifecycle B07 does not own (that lifecycle is D045's, and belongs to a CRM object B07 never writes).

Every message-level semantic observation is preserved regardless of how the thread summary changes — the summary is a replaceable projection; the message-level history beneath it is not (§5, mirroring B06's own stable-anchor/replaceable-summary split).

---

## 18. Privacy

Everything B07 stores is G2 private Gmail-derived data (D067).

`private_gmail_processing` governs NEW B07 machine work and NEW human-correction writes, under the same locked lifecycle/consent boundary B05 and B06 established (`private.gmail_outreach_assert_may_process_locked` or its B07-scoped equivalent; §11 above). Retention is distinct from permission to perform new processing, exactly as D067/D070/D071 already establish: an existing B07 row may survive a consent withdrawal or disconnect; no NEW B07 write may occur without current permission.

`network_intelligence_contribution` is IRRELEVANT to B07 processing. B07 creates NO G3 rows. No admin/editor/staff standing access by role — `public.is_admin_or_editor()` governs nothing in this plane, per D067/B01 §6 and B05 §18's identical rule.

Explicit Gmail-derived deletion must purge B07 machine state, inference provenance, and human correction history covered by the request — mirroring B05's purge-human-then-machine order (§19) and the deferred-constraint-trigger pattern that makes "`deleted` + surviving B07 data" structurally unrepresentable.

---

## 19. AI / external model policy

This contract does **not** select an AI vendor. It is provider-neutral, and must be implementable without naming OpenAI, Anthropic, Google, or any other vendor.

After this taxonomy is accepted, candidate vendors are benchmarked against these exact semantic tasks (§3–§8) as a separate, later activity — not part of this contract.

If an external model is later used, it must first pass a separate vendor/privacy approval covering at minimum:

- no use of submitted Gmail-derived data to train or shared-improve general models;
- acceptable retention/control terms;
- no advertising use;
- appropriate user-facing feature purpose;
- input minimization (§20);
- encryption/security;
- provider/version traceability;
- structured-output reliability.

---

## 20. Input minimization for model inference

If/when an external model is used, B07 sends only the minimum thread evidence needed for the requested task. It must never send:

- the entire mailbox;
- unrelated Gmail threads;
- unrelated creator-private CRM history;
- the whole canonical contact database;
- network intelligence histories.

OAuth scope granting the APPLICATION the ability to read a mailbox is never a reason to give an AI vendor more private Gmail evidence than a specific task actually requires.

---

## 21. Source currentness / staleness

B07's current machine interpretation must become stale when any dependency that could change the answer changes. At minimum:

- B04 source message content identity;
- B06 reply-nature/currentness/version dependencies;
- B05 commercial eligibility / current human outreach decision, where applicable;
- the current B07 human reply-nature decision for the message (Axis A, §9/§15), whenever it affects effective human-reply eligibility for that message;
- B07 semantic schema version;
- B07 text/input transform version;
- inference model/provider version;
- prompt/instruction version.

### Axis A (human reply-nature) is a machine-currentness dependency; axes B–E are not

§15 establishes that the creator's current Axis A decision changes effective human-reply eligibility. Because eligibility is a precondition for computing disposition/signals at all, a current B07 machine message/thread interpretation must be provenance/currentness-bound to the effective reply-nature basis it was computed against. That basis distinguishes at minimum:

- no current human reply-nature decision (B06's own `qualifying_human_reply` governs eligibility);
- current `human_reply`;
- current `automated`;
- current `delivery`;
- current `not_reply`;
- current `uncertain` (behaves as no confirmed correction for eligibility purposes, per §15, while remaining visibly recorded as the creator's stated uncertainty);
- current CLEAR/WITHDRAW / no active override (equivalent to no current decision).

A durable human-decision identity/version — e.g. the current Axis A decision event's identity/`event_seq` — is the natural implementation-time currentness key for this dependency. This contract does not choose the schema.

**Currentness consequence:** if the current Axis A basis changes in a way that changes effective eligibility, any dependent B07 machine message/thread interpretation computed under the prior basis must no longer be presented as CURRENT for ordinary effective use. Candidate selection, ordinary reads, and status/reporting surfaces must agree on this (the single-shared-currentness-definition recommendation below applies here too). The stale interpretation may remain stored for history/provenance (§13); it must never masquerade as the current effective result. For example:

- `qualifying_human_reply` with no override → machine semantics may be current;
- creator sets `not_reply` → dependent machine semantics become suppressed/stale for ordinary effective use;
- creator changes `not_reply` → `human_reply` → eligible again; the message becomes newly eligible for evaluation against that new effective input, subject to §14's no-oscillation discipline (a genuine eligibility change is a different input, not a same-input replay);
- creator CLEARs the override → processing returns to whatever B06's CURRENT classification supports, and currentness must again reflect that effective input.

This dependency is deliberately narrow and must not be generalized into "every human decision rewrites or gates machine state" (§10's axis table is otherwise unchanged):

- **Axis A (reply nature)** participates in effective eligibility and therefore in machine currentness, exactly as above.
- **Axis B (disposition)**, **Axis C (signal set)**, and **Axis E (compensation structure)** remain human overlays/confirmations of an existing machine value (§10) — they never rewrite the stored machine disposition, signal set, or interpretation they overlay, and machine and human beliefs stay separately inspectable. Human truth wins only for user-facing claims on the axis the creator actually decided.
- **Axis D (thread business outcome)** is independent human thread truth (§6) and never rewrites the machine commercial state (§5).

**Recommendation, not yet authorized to implement:** ONE authoritative currentness definition, used consistently by candidate selection, ordinary reads, and status/reporting surfaces — never independently-written, driftable formulas per surface. This directly extends B06's own hard-won lesson (D071's FINAL CLOSURE/AUDIT CORRECTION rounds): B06 shipped, was externally audited twice, and both audit rounds found exactly this failure mode — a shared staleness definition computed once and consumed everywhere, versus multiple formulas covering overlapping-but-not-identical dependency sets that silently drift apart. B07 should adopt the single-shared-definition pattern from the start rather than rediscovering the same defect. This contract records the recommendation; it does not implement it.

### Committing a new machine interpretation requires the same source-evidence fence B05/B06 already use

A B07 machine commit must re-verify, under the appropriate database lock, that the source identity it is about to write against (B04 content digest, B06 observation state/version, B05 eligibility where applicable) still matches what it read — exactly B06's own commit-time re-verification (D071, B06 §13) and B05's `p_expected_evidence_digest` fence (§15 there). A stale-source commit writes nothing. Two B07 workers computing an interpretation for the same message/thread concurrently must converge to one current machine state, never two. This requirement holds regardless of whether the inference itself is deterministic: even a non-deterministic model call still commits its RESULT under the same deterministic, lockable source-identity fence — non-determinism lives in what the model returns, never in whether the commit path honestly detects a stale source.

---

## 22. Human truth does not become stale because the model changed

A later model upgrade, prompt upgrade, B06 machine reclassification, or canonical target/contact change must NOT erase or silently invalidate a creator decision. If underlying source evidence materially changed after the creator's decision, B07 surfaces that fact as provenance/disagreement/currentness context — it never rewrites history. This is the same principle D070 already established for B05 ("A creator's confirmed decision on any axis is a separate, immutable-history-backed fact that a later machine reassessment never silently overwrites; the system may only flag disagreement between the two"), extended to B07's additional axes and to non-deterministic inference specifically.

---

## 23. B05 / B06 boundaries remain

B07 does not reconsider:

- whether the thread is commercial outreach, as a substitute for B05;
- target identity (B05);
- target-contact identity (B05);
- canonical linkage (B05);
- B06 chronology as machine history.

It consumes those layers as given. Human correction of B06 reply nature (§9) is an overlay owned by B07, never a rewrite of B06.

---

## 24. No new acquisition

Zero Gmail API calls. Zero OAuth scope changes. Zero sending. Zero incremental sync. B08 owns ongoing Gmail sync.

---

## 25. No CRM materialization

B07 writes NOTHING to:

- `public.pipeline_items`;
- `public.outreach_events`;
- `public.collaborations`;
- trip state;
- canonical hotel/organization/contact rows.

Specifically, and without exception:

- `positive` reply ≠ a `positive_reply` CRM event;
- machine `rejection` signal / `declined_observed` state ≠ `deal_lost`;
- `agreement_observed` ≠ `deal_won`;
- creator-confirmed `won` ≠ automatic collaboration creation;
- `ghosted` ≠ automatic pipeline close.

Historical Gmail → live workspace materialization remains a separate, future, creator-triggered reconciliation/import contract — exactly the same non-goal D070 already established for B05 (§22 there), extended unchanged to B07's richer semantics.

---

## 26. Pre-mortem / failure matrix

**IDENTITY**
- B04 UUID rebuilt underneath a human decision → durable anchor (§12) must survive it, exactly like B06's own anchor survives a B04 rebuild.
- Provider message id is stable across a B04 rebuild; provider thread id is stable across normalization — both are the correct anchors, never the replaceable UUIDs.

**AUTHORITY**
- Model vs. creator: creator always wins; a model output is advisory only (§9, §22).
- Machine vs. B06: B07 machine meaning is a separate layer built atop B06, never a rewrite of B06 (§23).
- Creator correction vs. a later rerun: the correction wins; the rerun updates only the machine layer (§9, §22).

**COMPLETENESS**
- Historical window ends before business outcome is knowable → the thread stays in whatever machine/human state the evidence actually supports (`unresolved`/`ambiguous`/`open`); B07 never manufactures a terminal state to fill the gap.
- Only partial negotiation is visible (e.g. the target's side of a phone call is invisible) → prefer `ambiguous`/`insufficient_evidence` over a confident but unsupported classification.

**STALENESS**
- B04 content changes → invalidates dependent B07 machine interpretation (§21).
- B06 classification changes → invalidates dependent B07 machine interpretation (§21), but never a creator's B07 decision (§22).
- Prompt/model version changes → invalidates dependent B07 machine interpretation (§21), but never a creator's B07 decision (§22).
- Creator changes/clears Axis A (reply nature) in a way that changes effective eligibility → invalidates dependent B07 machine interpretation for ordinary effective use, even though nothing about B04/B06/the model/prompt changed (§21); axes B–E never invalidate machine currentness this way (§21).

**CONCURRENCY**
- Model inference races a creator correction → the correction is authoritative regardless of arrival order once both exist; the machine layer never overwrites it (§9, §11 fence discipline mirrors B05 §17a/§15).
- Consent withdrawal races an inference commit → the shared lifecycle/consent fence (§11, §18) refuses the new machine write, mirroring B05/B06's own proven fence.
- Source rebuild (B04) races an inference commit → a source-evidence fence, mirroring B05 §15/B06 §13, refuses a commit against evidence that moved underneath it.
- Two inference workers race on the same thread → must converge to one current machine state, mirroring B06's own two-worker convergence requirement (D071, B06 §13).

**NULLABILITY**
- Compensation structure unknown → `unknown`, never `unpaid` (§8).
- Disposition unknown/unclear → `ambiguous`, never a forced positive/negative (§3).
- No terminal outcome yet → `open` or absence of a human-outcome decision entirely, never a fabricated `won`/`lost`.

**AMBIGUITY** — see §27 for worked prose examples covering: polite rejection; conditional interest; later reopening; mixed signals; an offer without acceptance; a target says yes but the creator never accepts; a creator accepts a proposal the target never confirmed.

**ORDERING**
- A later message reverses an earlier rejection → thread summary evolves (§17); the earlier rejection observation is preserved, never deleted.
- Equal timestamps → no invented elapsed ordering, mirroring B06's own tie-handling discipline (D071, B06 §10).
- Contradictory references → preserved as ambiguity, never silently resolved to one candidate, mirroring B06's `ambiguous_reference` (D071, B06 §7).

**REPLAY**
- Same input/model/prompt → no oscillation; existing successful inference is current (§14).
- Deliberate forced re-evaluation → explicit, auditable path only (§14).
- Failed model call retry → is not a "same input" replay in the oscillation sense; a genuinely failed attempt produces no successful current projection to treat as current, so a retry is expected and does not itself constitute unwanted oscillation.

**HUMAN TRUTH**
- Correction after a machine result → new human decision event; machine row is untouched (§9, §11).
- Correction-correction (a second creator decision on the same axis) → new event, `event_seq`-ordered, supersedes the prior current projection (§11).
- Clear/withdraw correction → new event returning that axis to machine-only advisory state; the withdrawn event itself is never deleted (§11).

**PRIVACY**
- Consent withdrawn → no new B07 machine or human write; existing rows retained per D067 (§18).
- Deletion → purges B07 machine state, inference provenance and human correction history covered by the request (§18).
- No G3 consent → irrelevant to B07; B07 never creates G3 rows regardless (§18).
- External inference provider → subject to §19/§20's vendor-approval and input-minimization requirements before any call is made.

**PROVENANCE**
- "Which source/model/prompt produced this current suggestion?" must always be answerable from stored provenance (§13) without needing to re-derive it from application logs or memory.

**SCOPE**
- No amounts/deliverables/payment workflow in B07 (§8).
- No CRM materialization (§25).
- No incremental sync (§24).

**DELETION**
- Machine state + human decision history + inference provenance are all purged together on an applicable deletion request (§18).

**VERSIONING**
- Semantic schema, transforms, provider/model, and prompt/instruction each carry their own version, all captured in provenance (§13) and all participating in staleness (§21).

---

## 27. Adversarial semantic cases

These examples are illustrative reasoning, not an exhaustive rule table. A real implementation's evaluation corpus (a future B07 implementation-round requirement, not part of this contract) must cover materially more cases than these.

- *"Thanks for reaching out."* → not automatically `positive`. Politeness alone carries no business-disposition evidence.
- *"This sounds interesting. Send your media kit."* → `positive` + `{interest, request_information}`; not negotiation, not `won`. Interest in learning more is not agreement to terms not yet discussed.
- *"We'd love to collaborate. What are your rates?"* → `positive` + `{interest, terms_discussion, request_information}`; not agreement. Asking about rates is opening a negotiation, not closing one.
- *"We can offer two nights, breakfast included."* → `{offer, terms_discussion}`; not agreement merely because an offer exists. An offer is one party's proposal, not a two-sided agreement (§5).
- *"Perfect, your stay is confirmed for November 10–12."* → potentially `agreement_observed` evidence, IF the surrounding conversation actually supports that an offer was made and accepted — the word "confirmed" alone, out of context, is not sufficient; B07 reads the thread's supporting chronology, not one message in isolation.
- *"Unfortunately we aren't accepting collaborations right now."* → `negative`/`{rejection}`, and possibly also `{timing_constraint}` depending on wording — but see the next example for why a timing qualifier changes the picture.
- *"No availability in November, but please reach out for January."* → must NOT automatically equal permanent `lost`/rejection. This is closer to `{timing_constraint}` with disposition `neutral` or `mixed` (a specific "no" combined with an explicit invitation to retry) — not a closed door, and thread state should not jump to `declined_observed` on this evidence alone.
- *"Please speak with Jane from our PR agency."* → `{redirect}`; disposition `neutral` typically — this is neither winning nor losing the opportunity, merely a routing instruction.
- A message with enthusiasm in QUOTED history but a current authored REJECTION → classify from the current authored content only, per §16's evidence-reading discipline; quoted positivity from an earlier message in the thread never overrides the current message's own authored disposition, mirroring B06's own quote-stripping discipline for automation-language evidence (D071, B06 §8.2).
- Agreement followed later by cancellation language → do not invent a collaboration-cancellation lifecycle B07 does not own (that belongs to D045's collaboration object); prefer `ambiguous` for the thread's machine state over silently reverting to, or freezing at, `agreement_observed` (§17).
- No reply through the historical horizon → never machine `ghosted` (§6); this remains B06's own `no_qualifying_response_observed_in_window`, an outcome-neutral B06 fact B07 must not reinterpret as an outcome.
- A target says yes, but the creator never explicitly accepts → the target-side `agreement`-shaped signal exists on that message, but thread-level `agreement_observed` requires the surrounding chronology to actually support a two-sided agreement; a one-sided "yes" awaiting the creator's own confirmation is closer to `negotiating`.
- A creator accepts a proposal the target never actually confirmed → the creator's own SENT acceptance is context (§16), not proof the target agreed; without target-side confirming evidence, thread state should not become `agreement_observed` on the creator's word alone.

---

## 28. What B07 deliberately leaves open

B07 does not decide:

- exact monetary amounts, currency, hosted value, deliverable counts, usage-rights terms, payment status or invoice state (a later Deal/Collaboration/Deliverables contract);
- an automatic ghosting policy over ongoing (non-historical) observation (B08 + a later contract);
- historical Gmail → live CRM promotion/reconciliation UX or mechanism (a separate future contract);
- vendor/model selection for any external inference (a separate future benchmarking and vendor-approval activity, §19);
- the exact currentness/oscillation architecture beyond the recommendations in §14/§21 (implementation detail for the accepted B07 implementation round);
- collaboration-cancellation lifecycle semantics (D045's domain, unchanged);
- how D043's `deal_lost(reason=no_reply)` relates to B07's `ghosted` (a future CRM-reconciliation decision, explicitly not B07, §7).

Those require later, separately accepted contracts.

---

## 29. D072 concise decision record

> **D072 — Gmail commercial meaning is private, multi-axis, provenance-bound and human-correctable.** B07 interprets B06's already-established reply chronology to answer what business meaning is supported by a commercially relevant Gmail thread, and what the creator has explicitly confirmed or corrected about that meaning — observed communication, machine commercial interpretation and creator correction remain three separate epistemic layers, never collapsed. Message-level disposition (`positive`/`negative`/`neutral`/`mixed`/`ambiguous`) and a signal SET (`interest`/`request_information`/`redirect`/`terms_discussion`/`offer`/`agreement`/`rejection`/`timing_constraint`/`other_commercial`) are machine-advisory only. Thread-level machine state (`unresolved`/`engaged`/`negotiating`/`agreement_observed`/`declined_observed`/`ambiguous`) is never CRM state: an offer is never agreement, and a decline is never permanent merely because it is current. Human business outcome (`open`/`won`/`lost`/`ghosted`/`uncertain`) is a separate, creator-confirmed axis; `won` does not mean collaboration completion (D045 unchanged), and B07 historical processing may never auto-assign `ghosted` from B06's window-bounded absence. Compensation structure (`paid`/`in_kind`/`hybrid`/`unpaid`/`other`/`unknown`) never lets `unknown` mean `unpaid`. B07 owns creator correction of B06's message reply-nature (`human_reply`/`automated`/`delivery`/`not_reply`/`uncertain`) as a durable overlay that a future B06 rerun can never overwrite; because reply nature also gates effective human-reply eligibility, a creator's current reply-nature decision is additionally a machine-currentness dependency, unlike the other four human axes, which are overlays/confirmations that never gate or rewrite machine state. All human decisions follow B05's append-only pattern — immutable events, database-owned `event_seq`, a current projection, explicit clear/withdraw as a new event, machine writers never touching human tables — anchored to durable provider message/thread coordinates, never a replaceable B04/B06 row id. Machine inference, unlike B06's deterministic rules, may be non-deterministic; every successful interpretation is provenance-bound to source digest, B06 state/version, B07 schema/transform version, and inference-engine/model/prompt identity when applicable, and the same input must not oscillate current state by default. B07 performs zero Gmail API calls, zero new OAuth scopes, zero CRM materialization, and creates zero G3 rows; this decision does not select an AI vendor and requires input minimization and a separate privacy/vendor approval before any external model call.

Full contract, taxonomy, human correction model, provenance model, failure matrix and adversarial cases: `docs/B07_GMAIL_COMMERCIAL_MEANING_CONTRACT.md`.
