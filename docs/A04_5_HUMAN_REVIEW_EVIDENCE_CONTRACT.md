# theugc.life — A04_5_HUMAN_REVIEW_EVIDENCE_CONTRACT.md

Human pre-publication review evidence. Migration `0032`, plus the readiness
helper, the review pack and the review apply path.

---

## 1. The one question this layer answers

> **How does an explicit human decision that a source identity represents a
> distinct property in a specific supported canonical destination become durable,
> auditable, current-evidence-bound pre-publication evidence that A04's
> conditions 1 and 2 can safely cite?**

It does **not** publish anything. It creates no canonical hotel, no
`hotel_source_identities` link, and no terminal `resolution_state`. A04 remains a
preview and A05 remains publication.

---

## 2. Human-review-ready

An identity is **human-review-ready** when every condition D062 can settle
without a human already passes:

| condition | |
|---|---|
| 3 | physical hospitality property |
| 4 | not blocked by a property-level closure |
| 6 | canonical star exactly four or five |
| 7 | star-classification provenance exists |
| 8 / 9 / 10 | latitude, longitude, coordinate provenance |
| 11 | no unresolved entity-resolution conflict |

…and no independently evaluated non-review condition FAILs.

**Conditions 1, 2 and 5 are deliberately not inputs.** 1 and 2 are the
human-dependent conditions this block exists to satisfy, and 5 derives from
1/2/3/4/6/7/11 — requiring it to pass beforehand would be requiring the answer
before the question.

### Readiness is computed by the REAL evaluator

`scripts/human-review/readiness.ts` is a pure function of a `PreviewResult`. It
never re-derives the conditions in SQL, and there is deliberately no SQL
shortcut for it.

> A SQL-only derivation reproduced condition 11's *persisted-candidate* half but
> not its *live anomaly* half, and called **1,141** identities ready where the
> evaluator says **867**. The 274-identity difference is entirely properties A04
> is actively holding on entity-resolution grounds.

---

## 3. Ready is NOT "one review row away"

This distinction is the reason the block exists, and it is easy to lose.

Condition 1's `approve_create` path requires **an explicit accepted
`new_property` finding**. Condition 11 passing means the machine found no
contradiction — it is a statement about the RULES, not about the world.

```
UNKNOWN / NO CONFLICT   ≠   POSITIVE NEW-PROPERTY EVIDENCE
```

So the literal "one `source_property_reviews` row away from 11/11" population is
**zero** before any human review, and stays zero until a human creates the
finding. `reviewRowOnlyEligible()` reports it from the evaluator's own evidence
rather than assuming.

---

## 4. Why the first canonical property must be `approve_create`

`hotels` is empty. `approve_match` requires an existing canonical hotel target,
so the real-data `approve_match` path is **unreachable** — there is nothing to
match against. The first publication in system history therefore has to begin
with `approve_create`.

V1 of this pilot implements exactly two decisions:

- `approve_create` — distinct property, in a named supported destination
- `defer` — the reviewer cannot establish the facts safely

`approve_match` and `reject` are absent from the receipt vocabulary at the
database level, not merely unimplemented. `reject` is absent because a final
exclusion is a different decision with different consequences, and this pilot
does not implement it.

---

## 5. Two artefacts, one action

A successful `approve_create` needs **both**:

| | |
|---|---|
| A | an accepted, HUMAN-OWNED `new_property` finding |
| B | a `source_property_reviews` decision naming the reviewed destination |

…plus the immutable receipt binding them to the exact observation reviewed.
Neither alone means anything: a review row without a finding is a decision with
no supporting entity evidence; a finding without a review is a claim nobody
signed. They are written in ONE transaction, and a failure anywhere rolls back
all of it.

### Human-owned findings

The finding's `match_method` is `human_review:distinct_property`.

It may **never** use the `blocking:*` namespace. That namespace is the
generator's, and A02's stand-down sweep — which only touches `blocking:%` rows —
would otherwise later supersede a human decision as though it were a stale
machine guess.

**No placeholder evidence is written.** 0027's defaults are already the honest
values for a finding no machine produced: `name_evidence = 'none'`, the four
other dimensions `'unavailable'`, `agreeing_dimensions = 0`,
`coordinate_distance_metres` NULL, and `source_run_id` NULL — which 0027 itself
documents as "NULL when the candidate was not produced by a run (a reviewer's own
finding)". Nothing was fabricated to satisfy a NOT NULL column, and nothing
needed to be.

---

## 6. The receipt

`source_property_review_receipts` binds, in one immutable row:

identity · source · environment · provider id · **current observation** ·
**current source run** · **whole-record payload digest** · decision · reviewed
destination · the accepted finding · reviewer · `reviewed_at` · the **A04
pre-review fingerprint** · the as-of date · a content digest.

Five composite foreign keys make misattribution unrepresentable rather than
merely discouraged. A receipt cannot cite another identity's observation, a
digest that observation never carried, a run that did not produce it, or a
finding belonging to someone else.

All three review tables are **APPEND-ONLY**, by trigger *and* by grant: no role,
`service_role` included, holds UPDATE or DELETE.

### Completeness is enforced at COMMIT

The rules span rows, so no CHECK can express them. A **deferred constraint
trigger** runs at COMMIT, when the receipt and its children are all visible, and
fails the whole transaction. An `approve_create` receipt must have all six
verification dimensions, an affirmative `distinct_property`, an affirmative
`destination_membership`, and at least one evidence reference.

---

## 7. Structured human verification

Six dimensions, each recorded separately with an explicit state:

`distinct_property` · `name` · `city_locality` · `address` · `coordinates` ·
`destination_membership`

Vocabulary: **`supports` · `contradicts` · `unavailable`**.

- `unavailable` is **never** silently promoted to `supports`. The provider not
  supplying an address is not evidence that the address agrees.
- A dimension may not be omitted because its provider field is NULL. It is
  recorded as `unavailable`.
- A `contradicts` verdict is **allowed** and must carry the reviewer's written
  explanation. A lower-level dimension may contradict while the destination
  judgement stays affirmative — a provider coordinate can be wrong while an
  official address settles the destination. The system does not algorithmically
  overrule the reviewer, but the contradiction is never invisible.

### Evidence references

At least one for `approve_create`, each with a kind, a locator, the dimensions
it bears on, and a stance. **This is not a source count** — one authoritative
reference may establish several facts, but zero establishes none.

The apply path **never fetches** any locator. A review is the human's assertion
about what they read; a machine re-fetch would be a different claim made at a
different time.

---

## 8. Currentness, and stale-review refusal

The review pack PINS identity, current observation, current run, payload digest
and the A04 pre-review fingerprint. At apply time every pin is re-checked inside
one **SERIALIZABLE** transaction, with the identity locked, and readiness is
recomputed from the real evaluator.

### The isolation level is the guarantee

Readiness is not one row. The evaluator composes the identity and its current
observation, the star/scope/location head revisions, lifecycle evidence,
`source_property_reviews`, `source_match_candidates`, the live entity-resolution
discovery sweep and the receipts — across many statements.

| | |
|---|---|
| `begin` (READ COMMITTED) | **Insufficient.** Every statement gets its own snapshot, so the evaluator can compose a view that never existed at any instant, and evidence can move between the verdict and the write. |
| locking `source_property_identities` | **Insufficient.** It freezes one row. The resolution, candidate, review and lifecycle tables the verdict actually depends on are untouched. |
| `repeatable read` | **Insufficient.** One stable snapshot, but this transaction *reads* evidence and *inserts* elsewhere — textbook write skew, which REPEATABLE READ permits. |
| `serializable` | **What is used.** SSI tracks the read/write dependencies across every table the evaluator touched. A commit that could not have been reached in any serial order aborts with `40001` instead. |

There is deliberately **no retry**. Retrying would re-run the same human
manifest against newer evidence — the silent rebase this block exists to
prevent. A serialization abort is surfaced as the refusal
`evidence_changed_concurrently`, and it leaves **nothing**: no receipt, no
verification, no evidence reference, no human-owned finding, no
`source_property_reviews` row, no canonical write. The reviewer prepares again
and reviews the new evidence.

What SERIALIZABLE does *not* claim: it does not freeze the world. If evidence
drifts after this transaction's serialization point, the commit still succeeds
and is correct — the receipt is bound to the evidence that genuinely was current
when the decision serialized. From then on §8's currentness rules govern, and
the drifted state is A04's problem to hold, not this receipt's to absorb.

Any drift is **REFUSED**, never rebased:

| refusal | |
|---|---|
| `stale_observation` | ingestion advanced the identity since the pack was prepared |
| `stale_run` / `stale_payload_digest` | the current evidence is not what was reviewed |
| `stale_prereview_fingerprint` | star, location, scope or entity state moved without the observation changing |
| `not_review_ready` | a non-review condition stopped passing |
| `evidence_changed_concurrently` | a concurrent transaction made this decision unserializable (`40001`/`40P01`) |

There is no best-effort apply, no silent rebase, and no substituting the newest
observation. The reviewer must inspect the new evidence.

### Which receipt A04 reads

One identity can legitimately hold several receipts, so the selection is bound
to the **current observation** rather than to wall-clock recency: A04 prefers the
receipt whose `evidence_observation_id` is the identity's current observation,
falling back to the newest (`reviewed_at`, then `id`) only so that a non-current
decision is still *visible* — which is what lets conditions 1 and 2 say
`human_review_receipt_not_current` instead of pretending no review exists. A
superseded receipt can never become current again, and none are hidden.

### A04 holds a non-current receipt

After A04.5, conditions 1 and 2 cite the receipt. When the receipt's observation
is no longer the identity's current one:

- condition 1 → `UNRESOLVED`, reason `human_review_receipt_not_current`
- condition 2 → `UNRESOLVED`, same reason
- overall → `UNRESOLVED`

The decision is not *wrong*; it is simply not a decision about today's evidence.
Other receipt-related holds: `human_review_receipt_missing`,
`human_review_receipt_decision_mismatch`, `human_review_receipt_finding_mismatch`,
`human_review_receipt_destination_mismatch`.

---

## 9. Idempotency and correction

The receipt carries a content digest over the decision's semantics —
deliberately **excluding `reviewed_at`**, so re-running an identical manifest is
not called "different" merely because the clock moved.

| second apply | |
|---|---|
| identical manifest | `already_applied`. No second receipt, no second finding, no second review row, and `reviewed_at` is untouched. |
| materially different, same evidence | **REFUSED** (`conflicting_review_exists`). Never a silent overwrite. |
| same identity, NEW observation | a fresh review of fresh evidence, and permitted |

The idempotency check runs **before** the fingerprint check, and the ordering is
load-bearing: applying a review changes the A04 fingerprint, because the receipt
becomes part of conditions 1 and 2. Checking staleness first would refuse every
exact replay as stale — turning idempotency into a guaranteed failure.

A correction/supersession workflow is **future work**. This pilot refuses rather
than inventing one.

### Three tables, three different lifetimes

The last row of that table — a fresh review of a NEW observation — is the whole
point of currentness, and it only works because these three things are *not* the
same kind of record:

| | lifetime | uniqueness |
|---|---|---|
| `source_property_review_receipts` | **immutable review-event history** | one per identity **+ evidence observation** |
| `source_property_reviews` | **the one CURRENT decision** (a projection, not history) | `source_property_identity_id` UNIQUE (0027) |
| the human `new_property` finding | **entity-level**, reused | one per identity (0030) |

So when ingestion advances an identity and the reviewer looks again:

- a **NEW receipt** is written for observation B — the old receipt stays
  byte-unchanged, children included;
- the **same** `human_review:distinct_property` finding is **reused**, because
  "this is a distinct property" is a claim about the entity, not about one
  observation of it. 0030 is right that a second row "is not new information";
- the **current projection advances** in place to B's destination, run,
  reviewer, note and time.

One finding may therefore be cited by several receipts from different
observations of the same identity. That is not duplication; it is one entity
claim confirmed against successive evidence.

### What is refused rather than repurposed

| | |
|---|---|
| `existing_new_property_finding_incompatible` | a `new_property` row exists that is not the accepted `human_review:distinct_property` finding for this identity/source/environment. It is never overwritten, re-owned, or have its `match_method` rewritten — converting a machine finding into a human one is not a review. |
| `existing_review_decision_incompatible` | the current projection holds a decision this pilot has no authority to supersede (`approve_match`, `reject`, …). |

A previous A04.5 `approve_create` on an **older observation** is explicitly *not*
an incompatible state — that is the supported fresh-observation path. Every
refusal above is evaluated **before any write**, because a refused item does not
abort the transaction: the other items in the manifest still commit, so a
refusal after an INSERT would leave an orphan behind.

---

## 10. Defer

`defer` writes the durable receipt and nothing else. It:

- creates **no** accepted `new_property` finding
- creates **no** `source_property_reviews` row, so condition 1 stays
  `identity_review_missing_or_deferred`
- never makes condition 1 pass, never publishes, and never creates a final
  exclusion
- must carry a note saying what could not be established
- may **not** name a destination — uncertainty is not a placement

Uncertainty remains uncertainty. A defer is not evidence that the property is
outside V1.

---

## 11. Why destination membership is human-reviewed here

This pilot produces structured human truth. It does not generalise it yet.

**No automatic destination resolver is implemented**: no bounding box, no
nearest-destination assignment, no city-name heuristic, no geocoder, no LLM
classification, no country lookup, no automatic "BAI = Bali", no
coordinate-cluster threshold.

The review corpus is deliberately structured so that a future block *could*
study whether such a resolver is justified. Recording today's human rule is not
permission to turn it into tomorrow's automated policy.

### Location resolved ≠ destination membership proven

Location resolution answers approximately *"does the current observation contain
structurally usable coordinates under the approved policy?"*. It does **not**
prove those coordinates belong to the selected destination.

A coordinate can be numerically plausible and still point at another city,
another emirate, another island, a chain fallback point, or the wrong property.
Conditions 8–10 passing therefore does **not** eliminate the human
destination-membership check, and this block changes no location semantics.

---

## 12. Commands

```text
npm run source:human-review:prepare -- --source hotelbeds --environment evaluation \
  --as-of YYYY-MM-DD [--destination slug] [--limit N] [--out path]

npm run source:human-review:apply -- --source hotelbeds --environment evaluation \
  --as-of YYYY-MM-DD --manifest path [--apply]
```

`prepare` is read-only and leaves every human-decision field empty. `apply` is
**dry-run by default**; without `--apply` the transaction is rolled back, so the
same code proves the same things and leaves nothing behind.

Review writes are **evaluation-only and local-only**, reusing the ingestion
writer's target classifier. A remote, container-bridge or unclassifiable target
is refused. There is no override flag and no bypass.

---

## 13. Not in this layer

A05 publication/apply · canonical hotel creation · `hotel_source_identities` ·
terminal `resolution_state` transitions · production ingestion · real decisions
for the 867 real ready identities · the `approve_match` workflow ·
accept/reject of the 261 pending candidate pairs · a general entity-review UI ·
any automatic destination resolver · geocoding · coordinate correction ·
lat/lon transposition repair · Provider B · Coverage Engine · contacts · media ·
Gmail · creator UI · LLM judgement of identity or destination · automatic NEW
inference · final exclusions · review correction/supersession.
