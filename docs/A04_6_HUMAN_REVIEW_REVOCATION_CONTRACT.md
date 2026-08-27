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
| identical manifest replayed, projection still represents that revoked receipt | `already_revoked`, nothing written |
| materially different reason for the same receipt | `conflicting_revocation_exists` |
| the projection has since advanced to a fresh receipt | `revocation_manifest_no_longer_current` |

The stated reason is part of the record and is never silently rewritten.

*(Amendment #2.)* The third row exists because idempotency answers *"is the
withdrawal this manifest asks for already satisfied?"*, and after
`revoke A → fresh observation → approve B` the answer is no: the identity is
authorized again, by receipt B. Replaying the old revoke-A manifest writes
nothing either way, so it is mechanically safe — but answering `already_revoked`
would tell an operator the current approval is withdrawn while B is live. They
would walk away believing the brake is on. It is refused instead; nothing revokes
B, touches receipt A, or deletes revocation A, and the operator prepares a fresh
pack if B is what they mean to withdraw.

### Replaying the original approve manifest is REFUSED

This is the most dangerous replay in the system. The receipt still exists with
the same digest, so A04.5's idempotency check would answer `already_applied` —
literally true, and read by an operator as *"the approval is back"*.

The apply path therefore refuses first, with
**`review_revoked_requires_fresh_observation`**. It does not reactivate the
projection, does not delete the revocation, and writes nothing.

### The immutable event dominates the mutable column

*(Amendment #2.)* `review_status` is a column on `source_property_reviews`, which
is deliberately a **mutable** current projection — a fresh-observation review has
to advance it, so 0024's ACL contract gives `authenticated` SIUD and
`service_role` all, with RLS narrowing that to admin/editor. A revocation, by
contrast, is an append-only historical fact about one exact receipt.

Before this amendment, one statement undid the brake:

```sql
update public.source_property_reviews set review_status = 'active' where …
```

Nothing else moved — not the pointer, not the receipt, not the revocation — and
D062 returned to 11/11 PASS with the **identical pre-revocation fingerprint**.
"There is no un-revoke" was a property of one CLI, not of the system.

The fix is not to remove UPDATE; that would break the legitimate advance this
layer depends on. The **semantic transition** is protected instead. For a
receipt-backed projection, `enforce_review_status_matches_revocation()` requires:

> `review_status = 'revoked'` **iff** an immutable revocation exists for the
> receipt this projection **currently** represents.

Both directions are load-bearing. Left to right stops the un-revoke above. Right
to left stops a mutable column manufacturing a withdrawal no human ever made — a
projection with `current_receipt_id = NULL` may be `active` and may never claim
`revoked`, because there would be no event behind the claim.

`review_status` is **not** part of §8's projection↔receipt predicate and
`current_receipt_id` is **not** part of this one; the two triggers answer
different questions and both fire on every INSERT and UPDATE.

**D062 asks the same question independently.** The evaluator reads whether the
**current** receipt carries a revocation, and treats `human_review_revoked` as the
OR of the event and the column. So an upstream write that bypassed the database
still cannot turn a withdrawn approval into publication authorization, and the
inverse corruption (`revoked` with no event) also fails closed, with
`revocationStateCoherent: false` in the evidence either way.

The question asked is deliberately narrow — *does this projection's current
receipt have a revocation?* — never *has this identity ever been revoked?* The
second would brick every re-reviewed property forever and close the only route
back.

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
| `enforce_review_projection_receipt_coherence()` | the pointer must name the receipt this projection **is** |
| `enforce_review_status_matches_revocation()` | `review_status` must match the immutable revocation record |

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

The predicate is the **full** coherence predicate above — identity, decision,
destination and run — not the run alone. A receipt that agrees on the run but
records a different destination does not represent the projection, so it is not
bound, and the projection keeps `current_receipt_id = NULL`.

The ambiguity guard runs **before** the backfill, not after it. "UPDATE first,
discover the ambiguity afterwards" would be safe only because the migration
happens to be transactional; the contract is fail-**before**-choice, so a binding
nobody can prove is never computed at all. It raises `data_exception` if any
projection could bind to more than one compatible receipt, and refuses to break
the tie on `reviewed_at`.

One definition of "this receipt represents this projection" is used in all three
places — the trigger, the ambiguity guard and the backfill. A second definition
is how the two drift apart.

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

### The pointer must name the receipt this projection IS

*(Amendment #1.)* The composite FK proves the pointed receipt belongs to the same
**identity**. That is necessary and it is not sufficient, because an identity
legitimately accumulates one receipt per reviewed observation:

```
observation A -> receipt A        observation B -> receipt B
projection advances to B, decided_in_run_id = run B
...current_receipt_id pointed back at receipt A
```

Both receipts belong to the identity, so the FK is satisfied and the row is
schema-valid — yet the projection would claim to be represented by a receipt
describing a different decision about different evidence, and A05 could consume
authorization from one while the current human record named the other.

`enforce_review_projection_receipt_coherence()` therefore fires **before every
INSERT and every UPDATE** on `source_property_reviews` and, for a non-NULL
pointer, requires:

| requirement | why |
|---|---|
| projection `decision = 'approve_create'` | this pilot owns no other receipt-backed authorization |
| receipt `decision = 'approve_create'` | a `defer` receipt authorizes nothing |
| `receipt.destination_id` = `review.destination_id` | the destination is a human decision, so the receipt must carry the same one |
| `receipt.evidence_source_run_id` = `review.decided_in_run_id` | **the** distinction between receipt A and receipt B for one identity |

Comparisons are `is distinct from`, so NULL is compared honestly rather than
passing silently. `reviewed_at` appears nowhere in the predicate. The trigger
fires on every UPDATE rather than only when the pointer column changes, because
moving `decision`, `destination_id` or `decided_in_run_id` while leaving the
pointer alone breaks the invariant just as effectively.

`review_status` is deliberately **not** part of the predicate: a `revoked`
projection must keep pointing at the receipt that was withdrawn.

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

### D062 also fails closed on an incoherent pointer

*(Amendment #1.)* A04's loader picks the receipt about the identity's **current
observation**; the projection's `current_receipt_id` says which approval is
**current**. Those are two different questions, and D062 must not pass while they
disagree. Before any receipt-supported PASS, an active `approve_create` requires:

| situation | conditions 1 and 2 |
|---|---|
| projection names no receipt, but one exists | UNRESOLVED, `human_review_projection_receipt_missing` |
| projection names a different receipt from the one evaluated | UNRESOLVED, `human_review_projection_receipt_mismatch` |

"A receipt exists" is not authorization. The current projection must explicitly
identify **which** approval authorizes this identity, and a legacy row that never
named one may not borrow one.

This is a second, independent layer. 0033's trigger makes the incoherent row
unrepresentable; D062 is the publication gate and fails closed on its own
evidence without assuming any constraint upstream held.

**Revocation keeps precedence.** A revoked projection reports
`human_review_revoked` on both conditions even when the pointer is also
incoherent. The brake must stay the visible reason; a pointer diagnostic must
never obscure the fact that a human withdrew the approval.

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

*(Amendment #1.)* Both ends defend the coherence invariant independently of the
database:

- **`prepare`** emits no item for a projection whose pointer does not
  semantically represent it. Those are counted as `incoherentProjections`, listed
  by identity, and printed as a warning — excluded, never silently skipped.
- **`apply`** re-reads the receipt's decision, destination and evidence run and
  compares them to the locked projection. On disagreement it refuses with
  **`review_projection_receipt_mismatch`** before any write: no revocation row,
  no status change, no timestamp change, no canonical write.

Revoking a receipt the current projection does not represent would record that
the wrong approval was withdrawn while leaving the real one authorized. Failing
closed costs an operator one re-prepare; failing open leaves a revoked-looking
identity still authorizing D062.

Neither check requires D062 readiness, and neither requires the receipt's
observation to still be current. A **stale** provider approval remains fully
revocable.

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
