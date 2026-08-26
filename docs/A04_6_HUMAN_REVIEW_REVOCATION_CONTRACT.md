# theugc.life — A04_6_HUMAN_REVIEW_REVOCATION_CONTRACT.md

Human review revocation. Migration `0033`, the revocation pack, the revocation
apply path, and the two D062 conditions that stop passing.

---

## 1. The one question this layer answers

> **How can a human withdraw a previous `approve_create` review so that it
> immediately stops authorizing D062, without modifying the immutable historical
> receipt, without deleting history, and without publishing anything?**

A04.5 made a human decision durable. It deliberately refused correction and
supersession, which was right for a pilot that publishes nothing. A05 turns an
authorized D062 PASS into a canonical hotel, and a human must have an emergency
brake **before** publication exists. That is the whole of A04.6.

This layer writes no canonical row. It creates no hotel, no
`hotel_source_identities` link, no `hotel_contacts` row, and no terminal
`resolution_state`. Revoking is the opposite of publishing.

---

## 2. A revocation is not a rejection

A revocation asserts exactly one thing:

> the previously active human approval is withdrawn and may no longer authorize
> D062.

It does **not** assert that the property is wrong, that it is a duplicate, that
it should be excluded, or that the provider data is bad. Each of those is a
different claim with different consequences, and none of them is implemented
here.

This is why `decision` and `review_status` are separate columns:

| column | question it answers |
|---|---|
| `decision` | what the human **concluded** |
| `review_status` | whether that conclusion is **currently authorized for use** |

A revoked row legitimately stays `decision = 'approve_create'` with
`review_status = 'revoked'`. That is not a contradiction; it is the audit trail.

Two alternatives were rejected outright:

- **Rewriting `decision`** destroys the record of what was actually decided.
- **Reusing `decision = 'defer'`** claims the human said something they never
  said. Defer means "I could not establish this"; revocation means "I am
  withdrawing what I established."

---

## 3. What a revocation does not touch

| left byte-identical | why |
|---|---|
| `source_property_review_receipts` | the immutable record of the review event |
| `source_property_review_verifications` | what the human checked at that moment |
| `source_property_review_evidence_references` | what the human consulted |
| the `new_property` finding | an entity-level claim, not an authorization |
| `source_property_observations` | provider evidence |
| `resolution_state` | still `unresolved`; revoking resolves nothing |
| every canonical table | nothing is published, and nothing is unpublished |

The projection keeps pointing at the revoked receipt through
`current_receipt_id`, so the resulting state reads as:
`decision approve_create · receipt A · status revoked`, beside a revocation event
naming who withdrew it, when, and why.

---

## 4. Revocation does NOT require D062 review-readiness

Requiring current readiness would disable the brake in exactly the situations
that most need it: a fresh observation has arrived, star or scope or location
evidence has drifted, an entity-resolution conflict has opened, A04 is already
UNRESOLVED.

Revocation **withdraws** authorization; it never grants any. Nothing unsafe can
follow from withdrawing an approval that no longer looks safe. So the only
currentness a revocation checks is that the projection is still the exact
approval the manifest says it is withdrawing.

---

## 5. Every revocation is pinned to one approval

A revocation manifest names the identity **and** the exact approval:

| pin | refusal if it moved |
|---|---|
| `reviewId` | `stale_review_projection` |
| `sourcePropertyId` | `identity_mismatch` |
| `expectedDecision` | `review_not_approve_create` |
| `expectedReviewStatus` | `review_not_active` |
| `expectedCurrentReceiptId` | `receipt_mismatch` |
| `expectedReceiptDigest` | `receipt_mismatch` |
| `expectedEvidenceObservationId` | `receipt_mismatch` |

A human must never discover they revoked something other than what they were
looking at, so every pin is re-checked inside the write transaction.

### Ordering is load-bearing

Two orderings are deliberate and non-obvious:

1. **Idempotency is checked BEFORE the state pins.** Revoking changes the very
   state (`active`) the pins look for, so checking state first would turn an
   exact replay into `review_not_active` instead of `already_revoked`.
2. **Every check precedes every write, for every item.** A refused item does not
   abort the transaction — the other items in the manifest still commit — so a
   refusal after an INSERT would leave an orphan behind.

---

## 6. SERIALIZABLE, and no retry

The revocation transaction reads the projection and the receipt and inserts into
a different table. That is write skew, so `REPEATABLE READ` is insufficient and
`SERIALIZABLE` (SSI) is used, exactly as in A04.5's apply path.

There is **no retry**. A retry would re-run a human decision against a snapshot
the human never saw — a silent rebase of a safety action. `40001` and `40P01`
surface as the refusal `evidence_changed_concurrently`, meaning: nothing was
withdrawn, re-prepare and look at the current approval.

---

## 7. There is no un-revoke

A second withdrawal of the same approval is not new information, so the
database carries `unique (revoked_receipt_id)` and the application answers:

| case | outcome |
|---|---|
| identical manifest replayed | `already_revoked`, nothing written |
| materially different reason for the same receipt | `conflicting_revocation_exists` |

The stated reason is part of the record and is never silently rewritten.

### Replaying the original approve manifest is REFUSED

This is the most dangerous replay in the system. The receipt still exists with
the same digest, so A04.5's idempotency check would answer `already_applied` —
literally true, and read by an operator as *"the approval is back"*.

The apply path therefore refuses first, with
**`review_revoked_requires_fresh_observation`**. It does not reactivate the
projection, does not delete the revocation, and writes nothing.

### Authorization returns only through fresh evidence

A **fresh observation** plus a **fresh human review** is the one route back. That
path writes a new receipt, advances the projection onto it, and sets
`review_status = 'active'` — because that is a new human decision about new
evidence, not an undo of the withdrawal. The revoked receipt and its revocation
both remain.

An initial **defer** after a revocation is still refused
(`defer_after_existing_review_unsupported`), unchanged from A04.5.

---

## 8. What 0033 adds

| object | |
|---|---|
| `source_property_review_receipts_id_identity_uk` | additive `unique (id, source_property_identity_id)`, so pointers can be composite-FK'd |
| `source_property_reviews.review_status` | `active` / `revoked`, default `active` |
| `source_property_reviews.current_receipt_id` | the receipt this projection represents, composite-FK'd to the same identity |
| `source_property_review_revocations` | the immutable revocation event |

`revocation_note` is **NOT NULL and non-empty**. A withdrawal with no stated
reason is not auditable.

Migrations `0027`–`0032` are not modified.

### The backfill binds on run provenance, not the clock

A04.5 sets `source_property_reviews.decided_in_run_id` to the run of the
observation reviewed, and every receipt records that same run as
`evidence_source_run_id`. The backfill joins on those columns, so the binding is
a **fact**, not a guess.

`order by reviewed_at desc limit 1` was rejected: two receipts written in the
same transaction, or a clock that moved, would silently bind the wrong one.

Section 4 of the migration then **proves** the mapping rather than assuming it —
it raises `data_exception` and fails the migration if any projection could bind
to more than one receipt, rather than picking one.

> That guard is unreachable on a schema-valid database, and this was verified
> rather than assumed: two receipts for one identity sharing a run would require
> two observations of that identity inside one run, which
> `source_property_observations_unique_per_run` (0027) refuses. The guard exists
> because "provably impossible today" and "safe to guess tomorrow" are not the
> same statement.

`current_receipt_id` is nullable, and NULL is honest: a legacy or hand-made
projection has no receipt at all. Those rows are **excluded** from the revocation
pack — with no receipt there is no specific approval to pin, and V1 will not
invent one.

---

## 9. Append-only, in two layers

`source_property_review_revocations` is append-only by **grant** and by
**trigger**. No role — `service_role` included — holds UPDATE or DELETE, and
`forbid_review_revocation_mutation()` refuses both even for the table owner. A
revocation records that a human withdrew authorization at a moment that has
passed; editing it would change what is recorded as having happened.

RLS matches 0027–0032: admin/editor through `public.is_admin_or_editor()`, plus
`service_role`. **No anon grant**, and an ordinary creator sees nothing.

---

## 10. What A04 does with a revoked review

| condition | before | after |
|---|---|---|
| 1 — distinct property, human-reviewed | PASS | UNRESOLVED, `human_review_revoked` |
| 2 — destination membership, human-reviewed | PASS | UNRESOLVED, `human_review_revoked` |
| 5 — derives from 1/2/3/4/6/7/11 | PASS | not PASS |

The overall verdict stops being PASS immediately, on the next evaluation, with no
migration, backfill or recompute step in between.

---

## 11. Commands

Revocation lives under its own namespace. It is deliberately **not** a flag on
the normal review apply command: withdrawing authorization is not a variant of
reviewing, and nobody should reach it by adding an argument to the command they
use every day.

```
npm run source:review:revoke:prepare -- \
  --source hotelbeds --environment evaluation \
  [--identity <uuid>] --out .data/human-review/revocation.json

npm run source:review:revoke:apply -- \
  --source hotelbeds --environment evaluation \
  --manifest .data/human-review/revocation.json [--apply]
```

`prepare` emits `reviewerLabel` and `revocationNote` **empty**; an unedited pack
is refused, because nobody decided anything. `apply` is dry-run without
`--apply`, and the dry-run rolls back after exercising every pin and constraint.

Write-target safety is A04.5's, unchanged and reused: evaluation only,
local/disposable database only, remote refused, private-network refused,
unclassifiable refused, and **no override flag**.

---

## 12. Not in this layer

- **No `approve_match` receipts.** Unchanged from A04.5.
- **No un-revoke.** A later approval is a fresh review of fresh evidence.
- **No revocation of a `defer`.** A defer authorizes nothing, so withdrawing one
  would withdraw nothing.
- **No correction or supersession workflow.** Still future work.
- **No decision applied to the real cached population.** Every write test in this
  block uses synthetic review and revocation fixtures.
- **No publication.** A05 remains publication, and A04 remains a preview.
