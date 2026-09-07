# B06 — Gmail Private Reply Chronology Contract

**Status:** ACCEPTED by product owner on 2026-09-07.  
**Decision:** D071 — Gmail reply chronology is private, message-anchored, window-bounded and outcome-neutral.  
**Implementation round:** B06.  
**Expected migration:** `0040_gmail_reply_chronology.sql`.  
**Depends on:** D067, D068, D069, D070; B03 (`0037`), B04 (`0038`), B05 (`0039`).

This document is the accepted B06 product/architecture contract. The B06 implementation PR must mirror D071 into `docs/DECISIONS.md` and update `docs/MASTER_PLAN_TRACKER.md` from B05 CURRENT to B05 DONE / B06 NEXT without changing the substance below.

---

## 1. The one question B06 answers

B03 answered **what historical Gmail evidence exists**.  
B04 answered **how that evidence is normalized privately and deterministically**.  
B05 answered **which conversations are creator-commercial outreach and who/what was being targeted**.

**B06 answers only:**

> **What happened chronologically after creator-sent messages in a commercially relevant Gmail thread: which later messages are plausible responses, which are qualifying human replies versus automated/delivery noise or ambiguity, and how much observed time elapsed relative to the creator's sends?**

B06 does **not** answer:

- whether a reply is positive or negative;
- interest, rejection, negotiation, rate request, barter, hosted stay, paid work or hybrid terms;
- won / lost / ghosted;
- collaboration state;
- deliverables, compensation, value or payment;
- summary or sentiment;
- whether a private Gmail fact enters CRM;
- network intelligence eligibility or aggregation;
- incremental Gmail sync.

Those belong to B07, B08 and Phase C+.

---

## 2. B06 is local private computation, not another Gmail acquisition layer

B06 performs **zero Gmail API calls**, requests **zero new OAuth scopes**, stores no credential and sends no message. It reads already-stored private evidence.

Primary inputs:

- B04 normalized threads/messages;
- B04 normalized participants;
- B04 `Message-ID`, `In-Reply-To` and `References` tokens;
- B04 normalized text parts and subjects;
- B04 `provider_sent` and `internal_date`;
- B05 current outreach machine/human state only to decide whether a thread is commercially eligible for new B06 processing;
- B03 import-run/thread metadata only for the historical observation horizon (§11);
- `mail_accounts.email_address` as routing/display evidence, never durable identity truth.

B06 does not mutate B03, B04 or B05 evidence.

### Important acquisition limitation

B03 V1 keeps exactly these RFC message headers:

`From`, `Sender`, `Reply-To`, `To`, `Cc`, `Bcc`, `Subject`, `Date`, `Message-ID`, `In-Reply-To`, `References`.

It does **not** currently retain `Auto-Submitted`, `Precedence`, `X-Autoreply`, `X-Autorespond` or similar automation headers.

Therefore B06 V1 must not pretend those signals are available. **Absence of an automation header that B03 never stored is never evidence that a message is human.** If the available evidence cannot distinguish human from automated safely, the correct state is `ambiguous_inbound`.

If pilot evidence later proves this materially limits B06 accuracy, widening B03's acquisition allow-list is a new explicit D068/B03 contract amendment plus re-import/re-normalization consequences. B06 may not widen historical acquisition silently.

---

## 3. Which threads B06 may newly process

B06 minimizes unnecessary processing of likely non-commercial private mail.

Human B05 truth is authoritative when present:

- current human `outreach_confirmed` -> B06 eligible;
- current human `outreach_rejected` -> NOT eligible for new B06 processing, regardless of machine state.

Without a current human outreach decision:

- machine `qualified_outreach` -> eligible;
- machine `needs_review` -> eligible for private advisory chronology, but no downstream product may present it as creator-confirmed commercial history;
- machine `not_outreach` -> not eligible;
- machine `insufficient_evidence` -> not eligible until B05 state or human truth changes.

Eligibility controls **new processing**, not retention. Existing B06 history may remain after disconnect/consent withdrawal according to D067. Explicit Gmail-derived deletion purges it.

A later B05 decision change must affect ordinary B06 current-read eligibility immediately; it must not require rewriting human history or fabricating a B06 event.

---

## 4. Consent and deletion boundary

B06 outputs are G2: private Gmail-derived facts.

Before every new B06 derivation/commit, the database must authoritatively establish the same permission boundary B05 established:

- mailbox belongs to the creator;
- current `private_gmail_processing` consent is granted under the applicable account/scope state;
- deletion has not started / account is not terminally deleted;
- a concurrent withdrawal/deletion cannot race past the write.

Retention permission and permission to perform **new processing** remain distinct.

`network_intelligence_contribution` is irrelevant to B06. B06 creates no G3/network output and never trains a global/shared model on Gmail-derived content.

Deletion must extend D067's invariant: an account cannot finish Gmail-derived deletion while B06 rows remain.

---

## 5. Literal creator sends: call them touches, not pitches or follow-ups

Every B04 message with `provider_sent = true` is a literal **creator-sent touch**.

B06 may assign deterministic ordinals such as first / second / third creator-sent touch inside the stored thread chronology.

B06 must **not** relabel those messages as:

- initial pitch;
- follow-up;
- negotiation response;
- closing message;
- outreach success.

Those are semantic interpretations B06 does not own.

In particular, the database field should mean `first_creator_sent_in_thread`, not `initial_outreach`, unless a future accepted contract supplies a message-level commercial-pitch anchor.

---

## 6. A non-SENT message is not automatically a reply

B04 deliberately established that `provider_sent = false` proves only that Gmail's stored snapshot did not carry the `SENT` label. B06 preserves that epistemic rule.

A non-SENT message becomes a **response candidate** only after B06 evaluates the available relationship/direction evidence.

B06 V1 response classes:

- `qualifying_human_reply`
- `automated_response`
- `delivery_status`
- `ambiguous_inbound`
- `not_reply`

No binary `replied=true` field is the sole source of truth.

### `not_reply`

Use when available evidence positively says the message is not a response to a preceding creator-sent touch — for example, it precedes every creator-sent touch in the stored chronology and has no valid reference relationship proving otherwise.

### `ambiguous_inbound`

Use when a non-SENT message plausibly belongs after creator activity but the evidence is insufficient to call it a human reply, automated response or delivery status safely.

Ambiguity is a first-class successful output, not a failure.

---

## 7. Reply relationship evidence is preserved separately from human/automation classification

B06 must not collapse "this message belongs after a creator send" and "a human replied" into one judgement.

For each response candidate, preserve a versioned relationship status such as:

- `direct_in_reply_to` — an unambiguous `In-Reply-To` token maps to one earlier creator-sent message in the same mailbox/thread;
- `references_chain` — no direct parent is established, but `References` contains an unambiguous creator-sent message token;
- `thread_sequence_only` — same Gmail thread and a strictly later provider `internal_date`, with no contradictory reference evidence;
- `ambiguous_reference` — reference evidence maps to zero/multiple/conflicting local candidates and B06 cannot choose honestly;
- `no_preceding_creator_sent` — no preceding creator-sent touch is established.

A Gmail thread is useful evidence, not proof of a direct parent-child relation.

### Repeated / ambiguous Message-ID evidence

B04 intentionally preserves repeated header occurrences and token evidence. If one reference token can map to multiple local normalized messages, B06 must not silently pick one. Store ambiguity.

Provider message identity remains `(mail_account_id, provider_message_id)`. `Message-ID` is evidence only.

---

## 8. V1 human / automated / delivery semantics

B06 uses deterministic, versioned rules. No external AI/ML provider is called in B06.

### 8.1 Qualifying human reply

A V1 `qualifying_human_reply` requires all of the following:

1. a non-SENT message;
2. a relationship to prior creator activity (`direct_in_reply_to`, `references_chain`, or a non-contradictory `thread_sequence_only` case);
3. parsed sender evidence consistent with an external participant rather than the connected mailbox's own current routing address;
4. non-empty newly-authored textual evidence after conservative quote/signature handling;
5. no strong delivery-status or explicit automated-response evidence;
6. no unresolved chronology/reference contradiction that makes the claim unsafe.

A canonical hotel/contact match is **not required**. A legitimate reply may come from a colleague, agency, group inbox or previously unseen employee.

A sender address different from `mail_accounts.email_address` is evidence, not durable human identity truth. B06 must not invent alias ownership or person identity.

### 8.2 Automated response

`automated_response` requires explicit deterministic evidence in the content/subject/sender signals B06 actually possesses. Examples may include bounded, versioned patterns that explicitly say the message is an automatic reply, out-of-office response or automatic acknowledgement.

Rules:

- generic `noreply` / `no-reply` sender morphology alone is never sufficient;
- a generic word such as "automatic" appearing in quoted history is never sufficient;
- quote/signature stripping must happen before body-language evidence is used;
- when evidence could plausibly be a human-written template, prefer `ambiguous_inbound`.

### 8.3 Delivery status

`delivery_status` requires strong mechanical evidence, preferably multiple agreeing signals available in V1, such as a mechanical delivery sender pattern plus explicit undeliverable/bounce/delivery-failure language.

One weak phrase alone must not classify a human response as delivery status.

### 8.4 Evidence ceiling

Because B03 V1 omitted standard automation headers, B06 V1 is intentionally conservative. The system is allowed to have a meaningful `ambiguous_inbound` rate. Precision is more important than forcing recall by pretending unavailable headers exist.

---

## 9. Stable private message observations; machine interpretation is replaceable

B06's durable message anchor is the Gmail provider message identity, not a replaceable B04 UUID:

`(mail_account_id, provider_message_id)`.

A B04 raw-digest replacement may delete/rebuild the normalized projection while the Gmail provider message remains the same communication. B06 must therefore not key future human correction anchors to `gmail_normalized_messages.id`.

Recommended B06 shape:

### `private.gmail_reply_message_observations`

One stable row per provider message identity that B06 has evaluated, carrying at least:

- owner/mail-account/thread provenance;
- `provider_message_id`;
- stable observation id;
- current source payload digest / source evidence identity;
- current machine response class;
- relationship status;
- unambiguous direct/referenced creator-sent provider id when one exists;
- latest preceding creator-sent provider id when chronology establishes one;
- machine rule versions;
- evaluated-at/currentness metadata.

Machine fields may change after a source/rule-version change. Stable provider identity does not.

B07 may later add creator corrections anchored to this stable observation. B06 must be designed so a future machine rerun cannot rewrite that human truth.

### `private.gmail_reply_thread_summaries`

A replaceable machine summary over the current eligible thread, derived atomically from the message observations/evidence. It may include the exact summary facts defined in §10–§11 and an evidence digest/version.

The exact table split is implementation detail, but the stable-anchor / replaceable-machine distinction is not.

---

## 10. Timing facts: preserve both clocks we actually need

For the **first qualifying human reply observed**, B06 stores both timing views when chronology is valid:

1. `latency_from_first_creator_sent_ms`
   - first creator-SENT message in the stored thread -> first qualifying human reply;

2. `latency_from_latest_creator_sent_ms`
   - latest creator-SENT touch strictly preceding that human reply -> that reply.

Also preserve:

- first creator-sent provider message id/time;
- first qualifying-human-reply provider message id/time;
- count of creator-sent touches strictly before first qualifying human reply;
- latest creator-sent provider message id before each qualifying human reply, when determinable;
- human-reply ordinal for subsequent qualifying human replies if useful.

This lets future intelligence distinguish:

> reply 76 hours after the first creator send, but only 4 hours after the latest creator touch.

B06 does not call the second creator touch a follow-up; B07/Phase C can interpret that later.

### Timestamp conflicts

`internal_date` is evidence, not omniscient chronology.

- Negative latency is never stored.
- If a reference relation says "reply" but timestamps place the response before its supposed creator parent, preserve the reply relation and mark chronology conflict; latency is NULL.
- Equal-time/tie cases that cannot establish a strict predecessor are explicit ambiguity, not arbitrary provider-message-id arithmetic disguised as elapsed time.
- Deterministic tie-breaking may be used for reproducible reading order, never as proof that one event happened before another.

---

## 11. No reply is window-bounded and right-censored

Historical Gmail import has a fixed observation window. Therefore B06 may never convert absence into `ghosted` or "never replied".

For each thread, derive an `observed_through_at` horizon only from B03 evidence that the provider thread was actually fetched in a completed historical import work item. A safe V1 definition is the greatest `window_end_at` among completed B03 import runs whose thread-work row for that exact mailbox/provider thread is `complete`.

That means:

- `no_qualifying_human_reply_observed_in_window` = no qualifying human reply was observed through the proven thread horizon;
- it does **not** mean no reply happened after that horizon;
- `only_automated_or_delivery_observed_in_window` is distinct;
- `ambiguous_response_observed_in_window` is distinct;
- if a reliable horizon cannot be proved, absence is `observation_horizon_unknown`, not "no reply".

B08 incremental sync may later advance the observation horizon. B06 must allow the summary to be recomputed without rewriting stable message identity or future human corrections.

`ghosted` remains B07+ outcome semantics and requires a separately accepted policy about elapsed time / observation completeness.

---

## 12. Thread-level current summary vocabulary

A current eligible thread summary should expose one of these outcome-neutral observation states:

- `qualifying_human_reply_observed`
- `ambiguous_response_observed`
- `only_automated_or_delivery_observed`
- `no_qualifying_response_observed_in_window`
- `observation_horizon_unknown`

This is **not** a business outcome taxonomy.

A thread may contain multiple message classes; the summary must not erase the underlying per-message observations.

---

## 13. Source evidence, replay, staleness and races

B06 computation is local but its source may still change concurrently because B03 can replace a raw snapshot and B04 invalidates/rebuilds its projection.

Requirements:

- compute a deterministic current thread evidence digest from the exact normalized message identities/source payload digests/provider-sent facts B06 used;
- candidate offering compares content identity/version, not timestamp ordering;
- commit re-verifies source identity under the appropriate database lock/fence;
- stale-source commit writes nothing;
- exact replay under the same evidence + rule versions is a true no-op or byte-equivalent convergence;
- two B06 workers on the same thread converge to one current machine state;
- B04 rebuild race is tested with real PostgreSQL sessions, not sleeps.

If a B04 projection disappears temporarily during raw replacement, ordinary B06 current reads must not present stale machine facts as current evidence.

---

## 14. Machine vs human boundary

B06 is MACHINE/OBSERVED only.

It creates no creator correction table and does not edit B05 human decisions.

B07 owns creator correction of reply/outcome meaning. B06 must leave B07 a stable message observation anchor and enough provenance to record:

- what the machine believed;
- what source evidence/version it used;
- what the creator later corrected;
- without the next machine rerun overwriting the correction.

---

## 15. Canonical / CRM / target boundaries

B06 writes nothing to:

- `public.pipeline_items`;
- `public.outreach_events`;
- `public.collaborations`;
- hotel/organization/contact canonical rows;
- trip state;
- network intelligence aggregates.

A qualifying human reply does not automatically move pipeline state to REPLIED in B06. Historical CRM materialization remains a separate creator-triggered reconciliation/import capability.

B06 may read B05 target/contact observations for context or evaluation, but reply existence cannot require a canonical target/contact match.

---

## 16. Deterministic V1 evaluator and abstention

V1 is rules-based and versioned. Suggested semantic versions:

- `gmail_reply_relation_rules_v1`
- `gmail_reply_classification_rules_v1`
- `gmail_reply_text_transform_v1`

No external model call.

Any future model adapter must preserve:

- structured output;
- explicit confidence/evidence;
- private-data boundary;
- human correction precedence;
- no content leakage in logs;
- evaluation before trust.

---

## 17. Required evaluation corpus

Before B06 is merge-ready, create a hand-labeled synthetic/adversarial corpus and a real-PostgreSQL integration harness.

Required scenarios include at least:

1. direct human reply using `In-Reply-To`;
2. human reply with only `References`;
3. human reply in same Gmail thread with missing reference headers;
4. inbound message before any creator send -> `not_reply`;
5. explicit out-of-office / automatic reply -> `automated_response`;
6. automatic acknowledgement -> automated or ambiguous according to the exact evidence rule;
7. delivery failure / bounce -> `delivery_status`;
8. `noreply@...` with otherwise human-looking text -> not automatically automated;
9. quoted "automatic reply" text inside a real human reply -> quote text cannot trigger automation;
10. malformed/missing From -> `ambiguous_inbound` unless stronger evidence legitimately resolves it;
11. creator sends twice, then human replies -> two latency clocks and creator-sent count are exact;
12. creator sends, automated reply arrives, creator sends again, human replies -> first human timing is based on human reply, not automation;
13. duplicate/repeated Message-ID evidence -> no silent parent selection;
14. reference/timestamp contradiction -> reply relation can survive while latency is NULL/conflicted;
15. equal timestamp tie -> no invented elapsed ordering;
16. no human reply inside a proven B03 horizon -> window-bounded absence only;
17. no proven horizon -> `observation_horizon_unknown`;
18. B04 source digest replacement -> stale B06 state not exposed/current; recomputation converges;
19. consent withdrawal/deletion race -> no new G2 write after permission is gone;
20. B05 human `outreach_rejected` suppresses new B06 processing even if machine says positive;
21. B05 human `outreach_confirmed` permits B06 processing even if machine disagrees;
22. zero CRM/G3/canonical writes.

Evaluation must report separately:

- qualifying-human-reply precision/recall;
- automated-response precision/recall;
- delivery-status precision/recall;
- ambiguous rate;
- relationship-status accuracy;
- exact latency correctness on classifiable cases;
- window/horizon correctness.

Synthetic metrics are not production accuracy claims.

---

## 18. Acceptance gates

B06 is merge-ready only when all of these hold:

1. migration `0040` applies after current main (`0039`) without editing `0035`–`0039`;
2. populated replay over real-shaped B01–B05 data succeeds;
3. consent/deletion/source-race invariants are proven on real PostgreSQL;
4. stable provider-message anchoring survives a B04 rebuild;
5. machine rerun cannot destroy the stable future human-correction anchor;
6. reply relation ambiguity is preserved rather than silently resolved;
7. two timing clocks are computed exactly and never negative;
8. no-reply state is explicitly window-bounded/right-censored;
9. automated/delivery ambiguity is not forced into human reply;
10. no CRM/canonical/G3 writes exist;
11. focused B06 tests, Gmail B01–B06 tests and full repository suite are green;
12. format/lint/typecheck/build are green;
13. exact-head push CI and pull-request CI both complete successfully.

---

## 19. What B06 deliberately leaves open

B06 does not decide:

- positive/negative reply taxonomy;
- negotiation/outcome taxonomy;
- creator correction UX/schema beyond requiring a stable anchor for B07;
- what elapsed duration means `ghosted`;
- automatic CRM import/materialization;
- Gmail incremental watch/history sync;
- adding `Auto-Submitted` or other automation headers to historical acquisition;
- global/network aggregation;
- AI reply summarization.

Those require later contracts.

---

## 20. D071 concise decision record

> **D071 — Gmail reply chronology is private, message-anchored, window-bounded and outcome-neutral.** B06 may interpret current stored Gmail evidence only when current private-processing permission permits new G2 work. It preserves every creator-SENT message as a touch, separates reply-relationship evidence from human/automated/delivery classification, stores stable provider-message observations plus replaceable machine interpretation, computes both first-send-to-human-reply and latest-touch-to-human-reply latency when chronology is valid, and treats absence as right-censored by the proven historical observation horizon. `provider_sent = false` alone never means reply; automation ambiguity is explicit; canonical identity is unnecessary for a reply to exist; no reply classification becomes sentiment, negotiation, ghosting, CRM state or network intelligence in B06. B03's current omission of `Auto-Submitted` is an acknowledged evidence ceiling, not permission to infer humanity from absence. B07 owns reply/outcome meaning and creator correction; B08 owns incremental sync.
