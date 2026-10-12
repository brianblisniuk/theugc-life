# C01 — Normalized intelligence event/fact contract

**Status:** PROPOSED. Requires owner acceptance. This document is not an accepted decision, and accepting the pull request that adds it does not by itself accept the product rule.
**Decision:** D077 — proposed, not accepted. D076 is not this decision. On 2026-10-12, `main` `4062170212beb8b978a248ef219eb91ddbfb080b` ends at D075, and open PR #53 already uses D076 for B08.
**Base:** `main` `4062170212beb8b978a248ef219eb91ddbfb080b` (merge of PR #52).
**Implementation round:** none. No schema, no migration, no application code, no UI. No migration number is reserved. D074 still applies: a later implementation takes the next free number at the time the migration is written.
**Depends on, and does not amend:** D009, D010, D012, D014, D043, D045, D050, D057, D058, D067, D070, D071, D072, and the D01 trip reading already merged in PR #52.

---

## 1. The one question

Pipeline events, collaborations, the private Gmail layers B05–B07, and trips already record different kinds of claim. They do not yet share one rule for what counts as an intelligence fact.

**C01 answers only:**

> Which claims already produced by those layers are intelligence facts, what must every such fact point at, and which of those facts a later freshness engine (C02) or aggregate engine (C03) is allowed to read?

C01 does not compute freshness, confidence, a sample floor, a rank, or a screen.

### The gate

Every admitted fact traces to exactly one canonical target and exactly one private evidence or event id. A claim that cannot fill both is not a C01 fact. It stays in the layer that already stores it.

---

## 2. What acceptance would mean

If the owner accepts D077, a later implementation block may store derived facts under this contract. This pull request does not. Until that acceptance:

- D057 is unchanged. `recompute_hotel_intelligence` still reads `outreach_events` and `collaborations` only.
- D058 public and premium projections are unchanged, including every publication floor.
- B05, B06, and B07 still write no `pipeline_items`, `outreach_events`, `collaborations`, trip rows, or canonical hotel, organization, or contact rows.
- No Gmail-derived row becomes network intelligence.

---

## 3. Decisions this proposal does not change

D072 stays exactly as accepted:

- a machine interpretation is never human truth;
- `redirect` is not `rejection`;
- a one-sided "yes" is negotiation, not agreement;
- `unknown` is not `unpaid`, and `unknown` is not zero.

The same discipline already fixed next to D072 stays in force:

- B06 absence inside a proven window is right-censored. It is not `ghosted`, not `no_reply`, and not a reply count of zero (D071, D072).
- `deal_won` is not collaboration completion. A cancelled collaboration is not `deal_lost` and does not erase `deal_won` (D045).
- `would_work_again` null is "not sure", not no (D045).
- A suppressed public intelligence field is not a negative finding (D058).
- `hotel_saved` does not count as creator activity (`docs/EVENTS.md`).
- `contact_bounced` has no V1 producer and is a signal, not an edit of a contact (D010, `docs/EVENTS.md`).
- Scheduling a collaboration emits no domain event and contributes nothing to intelligence (D045).
- Disconnect, churn, inactivity, and subscription expiry are not deletion (D014, D067, D070).
- Limited Use follows Gmail-derived data. Discarding a body does not turn it into ordinary global data (D067).
- `network_intelligence_contribution` stays separate, explicit, revocable, and default not granted (D067).

---

## 4. What a fact is

A C01 fact is a derived claim. It is not a second source of truth. The source row remains the source. The fact points at it.

Every admitted fact has all of the following:

| Field | Rule |
|---|---|
| `fact_type` | one value from the closed list in §7 |
| `provenance_class` | exactly one of `machine` or `creator_confirmed` |
| `canonical_target` | exactly one canonical hotel id, or, for a B05-origin fact only, exactly one canonical organization id |
| `evidence_id` | the private evidence or event id named for that type in §7. It must still exist |
| `owner` | the creator who owns the evidence. This is a privacy attribute, not a network attribute |

A fact may also carry `trip_id` when the source row already has one. Trip context is not evidence and is not a target.

These are never a canonical target: a contact, a recipient address, a destination, a trip, a mail account, a normalized Gmail row id, or a current-pointer row whose only job is to name some other row.

`provenance_class` is not inferred from the words in the value. `agreement_observed` can be machine. `won` on a B07 outcome axis can be creator-confirmed. The class is the field, not the vocabulary.

Two facts that differ in `provenance_class` are different facts, even when they describe the same thread.

---

## 5. Provenance

Machine and creator-confirmed stay separate, as D070 and D072 already require.

- A machine fact cites a machine attempt, observation, link, or summary. It never cites a human decision event as its evidence.
- A creator-confirmed fact cites the immutable human decision event, or the creator-written workflow event, named in §7. It never cites a machine attempt as its evidence.
- A later machine rerun may add an attempt or move a current pointer. It does not update the cited attempt in place, and it does not delete or rewrite the human event.
- A creator clear or withdraw is a new decision event on the source layer. The current fact follows that layer's current pointer. The earlier decision event remains a historical fact until a real purge (§9).
- A reader must be able to see both facts when both exist. Neither is presented as the other.

`admin_correction`, `system`, `gmail`, `outlook`, and `marketplace` are legal `outreach_events.source` values in migration `0006`. This proposal does not assign them a provenance class. The pipeline and collaboration RPCs that exist today write `manual_creator`. A fact is not invented for the other source values.

This refusal does not add a source filter to the current V1 recompute. That recompute is outside this contract (§2).

---

## 6. The trace, per layer

### 6.1 Canonical target

- A workflow or collaboration fact uses the `hotel_id` already stored on that row. That id is a canonical published hotel (D062).
- A Gmail-derived fact uses a B05 canonical link (`private.gmail_outreach_target_canonical_links`) that names exactly one canonical hotel or exactly one canonical organization. Zero links, or more than one, emit no fact. Ambiguous candidates are not collapsed.
- A creator confirmation of a private target that has no canonical link stays in B05. Confirmation does not fabricate the missing target (D070).
- A canonical contact link is not a target. An observed recipient is not a target (D070).
- A trip shortlist fact uses the `hotel_id` on `trip_hotels`. A trip with no canonical hotel emits nothing. A destination is not a hotel.

### 6.2 Evidence id

The evidence id is the durable private row, never a replaceable current pointer and never a B04 row id.

| Layer | Machine evidence | Creator-confirmed evidence |
|---|---|---|
| Workflow ledger | not admitted | `outreach_events.id` |
| Collaboration type | not admitted | `collaborations.id` |
| B05 | `gmail_outreach_target_observations.id` or `gmail_outreach_target_canonical_links.id`, as §7 names | `gmail_outreach_creator_decision_events.id` |
| B06 | `gmail_reply_message_observations.id` or `gmail_reply_thread_summaries.id`, as §7 names | not a B06 fact. Reply-nature confirmation is B07 |
| B07 | `gmail_commercial_message_attempts.id` or `gmail_commercial_thread_attempts.id` | `gmail_commercial_creator_decision_events.id` |
| Trip shortlist | not admitted | `trip_hotels.id` |

B06 message evidence also records `provider_message_id`. B07 evidence also records the provider message id or provider thread id the decision is anchored to. Those coordinates are anchors. They do not replace `evidence_id`.

`gmail_commercial_message_current`, `gmail_commercial_thread_current`, `gmail_commercial_message_decisions`, and `gmail_commercial_thread_decisions` are current projections. They are not evidence ids.

---

## 7. Closed fact types

No other fact type is admitted. Attributes listed below are copied from the source row. They are not new vocabularies.

### 7.1 Creator workflow (`provenance_class = creator_confirmed`)

Admitted only when `outreach_events.source = 'manual_creator'`.

| `fact_type` | What it asserts | What it does not assert |
|---|---|---|
| `pitch_sent` | the creator recorded an initial pitch | that a reply exists |
| `followup_sent` | the creator recorded a follow-up | that this is another pitch denominator |
| `reply_received` | the creator recorded a human reply | machine sentiment, ghosting, or a Gmail classification |
| `positive_reply` | the creator classified that reply positive | that `reply_received` can be skipped |
| `negative_reply` | the creator classified that reply negative | that `reply_received` can be skipped |
| `offer_received` | the creator recorded an offer | agreement, or a compensation amount |
| `negotiation_started` | the creator recorded negotiation | agreement |
| `deal_won` | the creator recorded an agreement | completion, hotel confirmation, or a cancelled collaboration |
| `deal_lost` | the creator recorded a loss, with the reason already on the event | `no_reply` inferred from Gmail silence |
| `collaboration_started` | the creator started the collaboration | completion |
| `collaboration_completed` | the creator completed it | that `terms_matched = unknown` means a mismatch, or that null `would_work_again` means no |
| `creator_closed_pipeline` | the creator closed the cycle without a deal-loss classification | `deal_lost`. A `collaboration_cancelled` reason stays a cancellation |

Not facts: `hotel_saved`, `contact_bounced`, and any event whose source is not `manual_creator`.

`collaboration_completed` may carry `terms_matched` and `would_work_again` from the collaboration row named by the event. `private_value_amount` and `private_value_currency` are not attributes of any fact. They feed no aggregate in V1 (`docs/DATABASE.md` §8) and unconfirmed value extraction is not network intelligence (`docs/INTELLIGENCE_ROADMAP.md` §4).

### 7.2 Collaboration type (`provenance_class = creator_confirmed`)

| `fact_type` | Evidence | Value |
|---|---|---|
| `collaboration_type_observed` | `collaborations.id` | the existing type: `stay`, `product`, `paid`, `stay_plus_paid`, `other` |

The canonical target is the collaboration's `hotel_id`. Status is not a second fact type. The events in §7.1 already record start, completion, and cancellation. `scheduled` remains a planning state and emits no fact (D045).

### 7.3 B05 Gmail outreach

Emitted only when §6.1 finds exactly one canonical hotel or exactly one canonical organization.

| `fact_type` | Class | Evidence | Value |
|---|---|---|---|
| `gmail_outreach_classification` | `machine` | target observation id | `qualified_outreach`, `not_outreach`, `needs_review`, `insufficient_evidence` |
| `gmail_target_link` | `machine` | canonical-link id | `strong_match`, `needs_review`, `ambiguous`, `insufficient_evidence` |
| `gmail_target_confirmed` | `creator_confirmed` | creator decision event id | the creator confirmed this private target was a real target |
| `gmail_target_scope` | whichever class wrote it | observation id if machine, decision event id if creator-confirmed | `single_target`, `multiple_targets`, `portfolio_target`, `unresolved` |

A machine scope fact and a creator-confirmed scope fact are two facts. Scope is not inferred from how many targets were confirmed (D070).

Link quality is the value of `gmail_target_link`. It is not a second cardinality test. `needs_review`, `ambiguous`, and `insufficient_evidence` may be stored on that one fact. They do not become `strong_match`. Several current link rows still emit nothing (§6.1).

No B05 fact writes the CRM, and none of them is network-eligible under this proposal (§8).

### 7.4 B06 reply chronology

B06 is outcome-neutral. These facts exist only when the same thread already satisfies §6.1.

| `fact_type` | Class | Evidence | Rule |
|---|---|---|---|
| `gmail_human_reply_observed` | `machine` | message observation id | `response_class = qualifying_human_reply` only. Automated, delivery, ambiguous, and not-reply observations are not this fact |
| `gmail_reply_latency` | `machine` | thread summary id | emitted only when that summary's chronology is valid. Carries the two B06 measures already stored: first-send-to-human-reply and latest-touch-to-human-reply. Neither measure is a score. A tie that B06 stores as an unknown singular message id stays unknown |
| `gmail_reply_window_censored` | `machine` | thread summary id | value is exactly `no_qualifying_response_observed_in_window` or `observation_horizon_unknown` |

`gmail_reply_window_censored` is a statement about a window. It is not a reply count of zero, not `ghosted`, not `deal_lost`, and not `negative_reply`. `only_automated_or_delivery_observed` and `ambiguous_response_observed` are not given fact types. They are not qualifying replies and they are not censored absence.

Creator reply-nature is not a B06 fact.

### 7.5 B07 commercial meaning

Emitted only when the thread satisfies §6.1. Values are the vocabularies D072 already fixed. This contract does not add a label.

Machine facts, each citing the attempt id:

| `fact_type` | Value |
|---|---|
| `gmail_commercial_disposition` | `positive`, `negative`, `neutral`, `mixed`, `ambiguous` |
| `gmail_commercial_signals` | the set, unchanged: `interest`, `request_information`, `redirect`, `terms_discussion`, `offer`, `agreement`, `rejection`, `timing_constraint`, `other_commercial` |
| `gmail_thread_commercial_state` | `unresolved`, `engaged`, `negotiating`, `agreement_observed`, `declined_observed`, `ambiguous` |
| `gmail_compensation_structure` | `paid`, `in_kind`, `hybrid`, `unpaid`, `other`, `unknown` |

Creator-confirmed facts, each citing `gmail_commercial_creator_decision_events.id`:

| `fact_type` | Value |
|---|---|
| `gmail_reply_nature_overlay` | `human_reply`, `automated`, `delivery`, `not_reply`, `uncertain` |
| `gmail_disposition_confirmed` | the same disposition vocabulary, as the creator's decision |
| `gmail_signals_confirmed` | the same signal set, as the creator's decision |
| `gmail_business_outcome` | `open`, `won`, `lost`, `ghosted`, `uncertain`. When the value is `lost`, the fact may carry the reason already stored on that decision: `rejected`, `not_a_fit`, `timing`, `other`. There is no `no_reply` |
| `gmail_compensation_confirmed` | the same compensation vocabulary, as the creator's decision |

Rules that bind any reader of these facts:

- `redirect` does not become `rejection`. A reader must not treat a `redirect` signal as a rejection.
- `offer` does not become `agreement_observed`. A one-sided yes does not become `agreement_observed`. Creator-sent acceptance alone does not become `agreement_observed`.
- `gmail_business_outcome = won` is not `collaboration_completed` and is not `deal_won`.
- `ghosted` exists only as `gmail_business_outcome` with class `creator_confirmed`. No machine fact type has that value.
- `gmail_compensation_structure = unknown` and `gmail_compensation_confirmed = unknown` are not `unpaid`.
- No compensation fact at all is not `unknown` and is not `unpaid`. Absence, unknown, and unpaid stay three states.
- B07 evidence strength may ride along as an attribute of the machine attempt. It is not a fact type, and it is not a C02 confidence band.

### 7.6 Trips

| `fact_type` | Class | Evidence | Target |
|---|---|---|---|
| `trip_shortlist_membership` | `creator_confirmed` | `trip_hotels.id` | that row's canonical `hotel_id` |

This asserts that the creator put this hotel on this private trip shortlist. It does not assert a pitch, a reply, a negotiation, or a collaboration.

It is not network-eligible. Creator Network intelligence is qualifying workflow and outcome data (D057). A shortlist is a private plan. Public trip exposure is out of scope for D01, and milestones must not reveal competitive hotel targets (D015).

A pipeline or collaboration fact may carry `trip_id` from `pipeline_items.trip_id`. Removing the link drops the context. It does not delete the workflow fact.

Trip summary counts are not facts. A null summary bucket is unknown, not zero (D01). `follow_up` is not `reply_received`. A cancelled collaboration is not a confirmed collaboration.

---

## 8. Network-level eligibility

Network-level means any read by another creator, an anonymous viewer, or an aggregate that mixes creators. That includes a future G3 contribution and the existing public and premium intelligence projections.

- A `machine` fact is never network-eligible.
- `trip_shortlist_membership` is never network-eligible (§7.6).
- A creator-confirmed workflow fact or `collaboration_type_observed` is the class D057 already derives from. This proposal does not put a new aggregate on top of it, and it does not change D058.
- A creator-confirmed Gmail-derived fact is not declared network-eligible, and it is not declared permanently ineligible. That is owner question 2 (§12). Until the owner decides, C03 must not read it as a network input.
- Personal use is not network use. The owning creator may read their own facts of both classes, still labeled, under the consent the source layer already requires. For Gmail facts that consent is `private_gmail_processing` (D067). Connecting a mailbox still has to be useful with network contribution left off.

Staff `is_admin_or_editor()` still governs none of the private Gmail plane (D067). A network aggregate is not a way to read another creator's evidence (D009).

---

## 9. Retention and purge cascade

A fact does not outlive its evidence. If the evidence row is purged, every fact that cites it is purged in the same operation. A remaining fact whose evidence id is gone is not a representable state.

| Event | Facts |
|---|---|
| Explicit Gmail-derived deletion, or account erasure that covers the mailbox | purge machine and creator-confirmed Gmail facts that cite that mailbox's evidence, together with the source purge (B05 human-then-machine order, and the same obligation B06 and B07 already have) |
| Disconnect, churn, inactivity, withdrawal of `private_gmail_processing` without a deletion request | no purge. New derivation stops when the source layer's fence already stops new writes. Existing facts remain |
| Withdrawal of `network_intelligence_contribution` | private facts remain. Any future network contribution must be removable and recomputable without them (D067, D070). This contract creates no G3 row |
| Account deletion of workflow, collaboration, or trip rows | facts that cite those evidence ids are purged with them |
| Subscription expiry | deletes nothing (D014) |
| Hotel merge | the fact's canonical target follows the canonical id. `evidence_id` does not change. No second fact is created |
| Creator withdraw of a human decision | a new decision event. Current projection moves. History remains until a row in this table actually purges it |

Lawful anonymous aggregates that a future C03 might already have emitted are not designed here. The obligation that is already accepted is the one this contract repeats: an aggregate must be recomputable without purged evidence (D009, `docs/DATABASE.md` §11). This proposal does not choose whether a published snapshot is retained.

---

## 10. What C02 consumes

C02 is freshness, confidence, and data strength. It is not built here.

C02 may read admitted facts and only these inputs from them:

- `fact_type`, `provenance_class`, canonical target, `evidence_id`, owner;
- the source event time, when the source row has one;
- the B06 observation horizon, when the fact cites a thread summary;
- the explicit markers already on the fact: compensation `unknown`, window-censored observation, null `would_work_again`, `terms_matched = unknown`.

C02 must not coerce those markers to zero, unpaid, no, ghosted, or a precise score.

C02 does not read raw mailbox bodies, pipeline notes, private compensation amounts, or another creator's facts. It does not assign network eligibility. It does not treat B07 evidence strength as a publication threshold. It does not invent a fact for a missing source row. Absence of a fact, an explicit `unknown`, and a numeric zero stay distinct, which is the C02 gate already written on the tracker.

Confidence bands, decay, and sample floors are C02 outputs or C02 inputs from an owner decision (§12, question 1). They are not C01 fields.

---

## 11. What C03 consumes

C03 is personal aggregates and privacy-safe network aggregates. It is not built here.

C03 may read admitted facts, plus C02 annotations that do not change the fact. It may not read raw evidence.

- Personal aggregates read the owning creator's own facts, both provenance classes, still labeled, and are visible only to that creator.
- Network aggregates read `creator_confirmed` facts only, and only types the owner has declared network-eligible.
- Gmail-derived facts are not a network input until owner question 2 is answered.
- `trip_shortlist_membership` is not a network input.
- Private compensation amounts are not an input.
- A shared output does not carry `creator_id`, `evidence_id`, or a raw count that D058 already forbids the current projections from carrying.

Thresholds for any new aggregate are owner question 1. This contract does not copy D012 or D058 floors onto the new fact set, and it does not repeal the floors on the current projections.

---

## 12. Open owner questions

This proposal does not answer these. An implementation block must not answer them either.

### 1. Aggregation thresholds

What sample floor, contributor floor, and time window apply to any new personal or network aggregate over C01 facts? D012's confidence hypothesis and D058's V1 floors govern the current projections only. This contract does not adopt them, extend them, or replace them.

### 2. Network eligibility of Gmail-derived facts

May a creator-confirmed Gmail-derived fact ever enter G3 or Creator Network intelligence? If it may, what has to be true beyond the existing default-off `network_intelligence_contribution`? Would that amend D057's rule that recompute reads `outreach_events` and `collaborations` only?

The open subset is the creator-confirmed Gmail facts in §7.3 and §7.5, including B05 target confirmation, B07 human outcome, and the B07 reply-nature overlay. Machine Gmail facts are already out of network eligibility by §8, independent of this question.

A related clause of the same question: may a canonical organization, as opposed to a canonical hotel, be the target of a network-level fact? This proposal allows an organization as the canonical target of a private B05 fact, because B05 already links organizations. It does not make that target network-eligible.

### 3. B08 pilot KPIs

Which quality and data-density measures must the B08 pilot observe, and what result would pause or justify a larger intelligence product?

D076, on open PR #53, is the B08 sync decision and does not define those KPIs. The Milestone B list in `docs/MASTER_PLAN_TRACKER.md` and `docs/MASTER_PLAN.md` (opt-in rate, qualified threads, precision/recall, classifiable outcomes, unique targets per 1,000 outcomes, observations per target, metadata completeness, correction rate) is a planning hypothesis. It is not an accepted KPI contract. This proposal does not turn that list into a decision.

---

## 13. Out of scope

- Aggregates, ranks, scores, and UI (C02–C05).
- Schema, migrations, RLS policies, RPCs, and application code.
- Materializing Gmail into `pipeline_items`, `outreach_events`, `collaborations`, or trips.
- Incremental Gmail sync, watches, history cursors, and pilot instrumentation (B08, PR #53).
- A ghosting rule over ongoing observation.
- Amounts, currency, deliverables, payment status, invoices, prices, and Rebill.
- Model or vendor HTTP calls, and any new provider receiving private data.
- Choosing `admin_correction`, `system`, `gmail`, `outlook`, or `marketplace` as a provenance class.
- Public portfolio exposure of trips.

---

## 14. What a later implementation would have to prove

Not in this pull request. Recorded so the gate is testable once an implementation is authorized:

- a fact with no canonical target cannot be stored;
- a fact with no live `evidence_id` cannot be stored;
- zero or many B05 canonical links emit no fact;
- a machine row is not readable as `creator_confirmed`, and a human event is not readable as `machine`;
- User A cannot read, enumerate, update, delete, or infer User B's facts by id, API, or relation;
- purging an evidence row purges the citing facts in the same operation;
- `unknown` compensation is not stored or read as `unpaid` or as zero;
- a window-censored observation is not stored or read as zero replies or as `ghosted`;
- `redirect` is not stored as `rejection`, and a one-sided yes is not stored as `agreement_observed`;
- a Gmail-derived fact is not readable as a network aggregate input while question 2 is open;
- anon receives nothing.

Authentication is not authorization. The private fact is the owner's row. RLS, where the repo forces it, is the boundary a later migration has to meet. This contract does not write that migration.

---

## 15. Ambiguities refused

- No aggregation threshold was selected.
- Gmail-derived creator-confirmed facts were neither admitted to nor banned from the network.
- No B08 pilot KPI was defined, and the tracker hypothesis was not promoted to a decision.
- `outreach_events.source` values other than `manual_creator` were not classified.
- Organization targets were not rolled up to hotels.
- No retention period, in days, was invented. The cascade follows deletion events that already exist.
- No new event type, signal label, or compensation value was added.
