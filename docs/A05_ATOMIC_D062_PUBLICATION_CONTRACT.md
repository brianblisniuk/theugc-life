# theugc.life — A05_ATOMIC_D062_PUBLICATION_CONTRACT.md

Atomic D062 publication. Migration `0034`, the publication pack, the publication
apply path, and the canonical field policy that governs what a published row may
say.

---

## 1. The one question this layer answers

> **How does an explicitly PUBLICATION-AUTHORIZED, PRODUCTION source identity
> with a current 11/11 D062 PASS become a canonical hotel, an ACTIVE source link
> and a `resolved_eligible` source identity in ONE atomic transaction, with
> immutable publication provenance and no partial publication?**

Four layers now answer four different questions, and none of them answers
another's:

| layer | question |
|---|---|
| A04 | what does the evidence say about publishability? |
| A04.5 | what did the human decide about identity and destination? |
| A04.6 | is that decision still authorized? |
| **A05** | **publish this PASS into canonical inventory** |

**A D062 PASS is NECESSARY. A D062 PASS is NOT publication authorization.**
"Everything checks out" and "publish it" are different sentences, and the second
one is a human's to say. `--apply` is a flag, not a person.

---

## 2. Scope: `approve_create` only

V1 implements exactly one route: `approve_create` → create a canonical hotel.

Everything else is **REFUSED**, and refused explicitly rather than falling
through:

| current human decision | outcome |
|---|---|
| `approve_match` | `approve_match_not_implemented` |
| `defer` / `reject` | `publication_decision_not_supported` |
| no review projection | `human_review_missing` |
| revoked | `human_review_revoked` |

`approve_match` is not merely uncoded. A04.5 deliberately has **no
`approve_match` receipt model** — 0032's `decision` CHECK admits only
`approve_create` and `defer` — so there is no authorization artefact to publish,
not just no code to publish it with. Attaching a second source identity to an
existing canonical hotel is that workflow, and it is future work.

---

## 3. The hard environment wall

> **EVALUATION DATA NEVER BECOMES CANONICAL DATA.**

Publication requires `source_property_identities.source_environment =
'production'`. Three independent layers say so, and A05 adds the third:

| layer | mechanism |
|---|---|
| 0027 | `hotel_source_identities_production_only` CHECK, made true of the IDENTITY by the composite FK; `source_property_identities_eligible_is_production` CHECK |
| 0034 | `source_property_publication_receipts_production_only` CHECK, likewise composite-FK'd |
| the writer | per item, before any read that could lead to a write: `evaluation_identity_not_publishable` |

The writer's check is deliberately **not** implemented by filtering the identity
lookup on `source_environment`. An evaluation identity is found and then
explicitly refused, because `identity_not_found` would be a false diagnosis of
the single most important boundary in this layer.

`validatePublicationItem` also refuses a manifest that *declares* a non-production
environment, before the database is opened at all — and a manifest that **lies**
about it is still refused, because the locked identity's own `source_environment`
is what the second check reads.

### The A04.7 pilot is the population this exists for

On 2026-08-27 the project owner authorized eight real `approve_create` decisions
and two defers. All eight reached a genuine 11/11 D062 PASS and the corpus moved
`1677 FAIL / 2433 UNRESOLVED / 0 PASS` → `1677 FAIL / 2425 UNRESOLVED / 8 PASS`.

Every one of those identities is `evaluation`. They stay unpublished, and
`tests/db/source-publication-pilot.test.ts` is the regression that keeps them
that way — by their real provider ids, so a future change that starts publishing
evaluation data fails there, naming the properties it would have published.

Nothing in this block relabels them. Turning evaluation evidence into production
evidence to make a publication succeed is precisely the failure the isolation
axis exists to prevent.

### Two different concepts

```
DATABASE DEPLOYMENT TARGET    where the rows are written
PROVIDER source_environment   whose evidence they describe
```

Confusing them is how test data reaches canonical inventory. Integration tests
run against a disposable LOCAL PostgreSQL using SYNTHETIC identities whose
`source_environment` is genuinely `production`; the production-only
source-environment constraint is never relaxed because the database happens to be
local.

---

## 4. Publication authorization is a separate, explicit human act

`prepare` is read-only and emits an item only when the REAL, recomputed evidence
says all of:

- the identity is `production`;
- the D062 result is `overall = PASS` **and every one of the eleven conditions is
  PASS** (equivalent today by D062's own composition rule, stated separately so a
  future condition cannot become publishable-by-omission);
- the current review projection is an ACTIVE `approve_create` naming the receipt
  it represents, that receipt cites the current observation, and no revocation
  exists for it;
- the identity is not already published.

Every human authorization field is emitted **EMPTY**:

```json
"publicationAuthorized": false,
"authorizedByLabel": null,
"authorizedByUserId": null,
"authorizationNote": null
```

Apply refuses an unedited pack. `authorizationNote` is **required and non-empty**
in the manifest and NOT NULL in the database, for 0033's reason: an irreversible
action with no stated reason is not auditable.

---

## 5. The immutable publication receipt

`source_property_publication_receipts`. One row means exactly:

> this exact production source identity, against this exact D062 PASS and this
> exact human review authorization, created this canonical hotel — because this
> human explicitly authorized publication, at this time, for this stated reason.

It binds identity · source · environment · provider id · **hotel** · the
published observation · the human review receipt · that receipt's accepted
`new_property` finding · the star, location and scope revisions · the preview
as-of, schema version and fingerprint · the authorizing human, label, note and
time · a content digest.

### Provenance is declarative

Nine composite foreign keys make misattribution unrepresentable rather than
merely discouraged. A receipt cannot cite another identity's observation, review
receipt, finding or resolution revision; cannot name a finding that is not the
one **that review receipt rests on**; and cannot name a hotel that is not this
identity's own canonical link.

| constraint | what becomes impossible |
|---|---|
| `…_identity_fk` | the denormalised source/environment/provider id disagreeing with the identity |
| `…_observation_fk` | publishing another identity's observation |
| `…_review_fk` | citing another identity's approval |
| `…_review_finding_fk` | citing a finding that approval does not rest on |
| `…_finding_fk` | citing a candidate row belonging to someone else |
| `…_star_fk` / `…_location_fk` / `…_scope_fk` | citing another identity's resolution revision |
| `…_link_fk` | naming a hotel this identity never linked to |

`unique (source_property_identity_id)` — one source identity creates at most ONE
canonical hotel on this path. `unique (hotel_id)` — two identities cannot both
claim to have created the same canonical row.

### The receipt's claim is checked, not assumed

The FKs prove **which** rows are cited. `enforce_publication_receipt_evidence()`
(BEFORE INSERT) proves **what they say**, so the canonical field policy in §6 is a
property of the database and not only of one writer:

- the cited review receipt is an `approve_create`;
- it reviewed the observation being published;
- the finding is the accepted, human-owned `new_property` finding
  (`human_review:distinct_property`);
- the hotel's destination is the reviewed destination;
- each cited revision is that identity's **current head** revision;
- the hotel's star equals the star revision's resolved value, and the outcome is
  `exact_four` or `exact_five`;
- the hotel's coordinates equal the location revision's resolved coordinates, and
  the outcome is `resolved`;
- the scope revision is `physical_hospitality`;
- the hotel's `active_status` is `unknown`.

### Append-only, in two layers

By **grant** and by **trigger**. No role — `service_role` included — holds UPDATE
or DELETE, and `forbid_publication_receipt_mutation()` refuses both even for the
table owner. RLS matches 0027–0033: admin/editor through
`public.is_admin_or_editor()` plus `service_role`, **no anon grant**, and an
ordinary creator sees nothing. The canonical `hotels` row is public; the
provenance behind it is editorial internals.

**No provider payload is stored here.** The receipt names evidence; it does not
duplicate it.

---

## 6. Canonical field policy

A05 does **not** copy the provider observation into `hotels`. Each field comes
from the evidence layer D062 actually approved.

| field | source | if unavailable |
|---|---|---|
| `name` | the current observation's `source_name` — **only** when the human's `name` verification is `supports` | **REFUSE** (`publication_name_not_human_supported`) |
| `destination_id` | `source_property_reviews.destination_id` | never inferred from provider geography |
| `star_rating` | the current star revision: `exact_four` → 4, `exact_five` → 5 | refuse; never `simpleCode`, a provider numeric shortcut, a guest score or an average |
| `latitude` / `longitude` | the current location resolution revision | refuse; raw provider coordinates never substitute |
| `country_code` | the canonical destination | NULL when the destination records none — unknown stays unknown |
| `address` | the current observation's `source_address` — **only** when the human's `address` verification is `supports` | **NULL** |
| `active_status` | the literal `unknown` | A03's `no_known_closure` is not evidence of active/open/operating |
| `website_url`, `instagram_url`, `description_short`, `hotel_type`, `brand_id`, contacts, media | **not set** | A05's job is safe identity publication, not enrichment |

`editorial_verification_status` stays `unverified` and `editorial_verified_at`
stays NULL: A05 records no editorial verification, so claiming one would be a
fabricated fact.

### Why a name the human did not affirm is refused

A canonical hotel requires a name; the only name available is the provider's; and
A05 has **no corrected-name field**. `unavailable` is not `supports` — the
provider supplying nothing is not evidence that the name agrees — and
`contradicts` is the reviewer saying the provider is wrong. Publishing either
would put a name into canonical inventory that nobody affirmed.

### Why a contradicted address is published as NULL, not as the provider string

The A04.7 pilot proved a property can validly reach 11/11 **while preserving an
address contradiction**: two of the eight approvals carry `address = contradicts`
with the reviewer's written explanation. Publishing that address anyway would
silently normalize away a recorded human disagreement. Publishing NULL says
exactly what is true: no canonical address is established yet.

**A human contradiction is preserved, never normalized away.**

---

## 7. Atomicity

One `SERIALIZABLE` transaction produces all four facts, or none:

```
A) the canonical `hotels` row
B) the ACTIVE `hotel_source_identities` link
C) the immutable publication receipt
D) resolution_state = 'resolved_eligible', promoted_hotel_id = the hotel
```

No hotel without a link. No link without a hotel. No `resolved_eligible` without
a promotion. No publication receipt claiming a transaction that did not commit.

Order inside the transaction: lock → recompute D062 → verify every pin → verify
the approval is current and still authorized → verify explicit publication
authorization → **then** hotel → link → receipt → terminal transition → commit.
Nothing is written before every check for that item has passed.

### Lock order

1. `source_property_identities`
2. the `source_property_reviews` projection

The same order A04.5's apply and A04.6's revoke use, so a publication and a
concurrent revocation queue rather than deadlock.

The identity is locked `FOR NO KEY UPDATE`, not `FOR UPDATE`, and the difference
is load-bearing. This transaction changes `resolution_state` and
`promoted_hotel_id` — no key column — so the weaker mode is the honest one, and
it still conflicts with itself, so two concurrent publications of the same
identity still serialise. `FOR UPDATE` would additionally conflict with the `FOR
KEY SHARE` lock any FK child insert takes on that row, and A04.6's revocation is
exactly such a child: a publication in flight would then **block the emergency
brake and win the race**. That is legal under SSI and is the wrong way round for
a safety action. With `FOR NO KEY UPDATE` the two contend on the review
projection instead — the row whose meaning they actually disagree about.

### Why SERIALIZABLE, and why no retry

The verdict is composed across the identity, its current observation, the
star/scope/location head revisions, lifecycle evidence, the review projection,
the review receipt, the revocation record, the candidate matrix and a live
entity-resolution discovery sweep. READ COMMITTED gives every statement its own
snapshot; REPEATABLE READ fixes the snapshot but permits write skew, and this
transaction reads evidence and writes elsewhere — which is write skew.

There is deliberately **NO RETRY**. A retry would re-run a human's irreversible
publication authorization against a snapshot that human never saw. `40001` and
`40P01` surface as `publication_evidence_changed_concurrently`: nothing was
published, look at the new evidence.

### The deferred invariant, enforced from both tables

0027 already refuses `resolved_eligible` without an ACTIVE canonical link to the
named hotel. 0034 closes the other direction:

> a publication receipt exists **IFF** its identity is `resolved_eligible`
> against that same hotel, and carries no `resolution_reason`.

`DEFERRABLE INITIALLY DEFERRED`, because the legitimate write order leaves the
receipt existing while the identity is still `unresolved` for a few statements.
An immediate check would make the correct application path impossible; what must
be coherent is the state that survives COMMIT.

Registered on **both** tables, for the reason A04.6's amendment #3 established: an
invariant enforced from one side can be broken from the other. The identity-side
trigger carries a WHEN clause so it fires only when `resolution_state`,
`promoted_hotel_id` or `resolution_reason` actually move — ordinary ingestion,
which touches `last_seen_run_id` and `observation_count`, never enqueues it.

`resolution_reason` is D061 §9 EXCLUSION vocabulary. A published property is the
opposite of an exclusion, so holding both at once is refused.

---

## 8. Evidence drift is refused, never rebased

The prepared fingerprint is a **PIN**, not cached authorization. D062 is
recomputed inside the publication transaction, and every pin is re-checked.

| refusal | |
|---|---|
| `stale_observation` / `stale_run` / `stale_payload_digest` | ingestion advanced the identity since prepare |
| `stale_preview_schema_version` / `stale_preview_fingerprint` | the semantic evidence bundle moved |
| `stale_star_revision` / `stale_location_revision` / `stale_scope_revision` | a resolution head advanced |
| `stale_review_projection` / `stale_review_receipt` / `stale_destination` / `stale_new_property_finding` | the human record moved |
| `human_review_receipt_not_current` | the approval describes a superseded observation |
| `d062_not_pass` | a condition stopped passing; the failing conditions are named |
| `publication_evidence_changed_concurrently` | `40001`/`40P01`; nothing was published |

All of them are specialisations of one idea: **`publication_evidence_changed`**.
Narrower names are used wherever they improve auditability, because "something
moved" is not a useful thing to hand an operator.

### Revocation dominates

A revoked approval is refused, and the check reads the **immutable event** and
the **mutable column** as an OR, exactly as D062 does. `review_status` sits on a
table admin/editor legitimately hold UPDATE on; a revocation is an append-only
fact, and it wins.

A concurrent revocation therefore has two correct outcomes, and both are the
brake working: either the publication's `for update of rv` raises `40001` on a
row the revocation updated after its snapshot — surfaced as a refusal, never
retried — or the publication reads the withdrawn approval and refuses on its own
evidence. Neither publishes.

---

## 9. Idempotency

The receipt carries a content digest over the manifest's pins and the human
authorization, deliberately **excluding `authorized_at`**, so an exact replay is
not called "different" merely because the clock moved.

| second apply | |
|---|---|
| identical manifest | `already_published`, returning the SAME hotel id, source link id and publication receipt id. No new rows, no new resolution transition. |
| materially different | **REFUSED** (`conflicting_publication_exists`). Never a second canonical hotel. |

The idempotency check runs **before** the "not yet published" state checks, and
the ordering is load-bearing for A04.5's reason applied to a different column:
publishing makes the identity `resolved_eligible` and linked, so checking those
first would refuse every exact replay and turn idempotency into a guaranteed
failure.

**Publication does not change the D062 fingerprint.** The evaluator reads no
canonical table, no `resolution_state` and no link, so a published identity
evaluates to the same PASS with the same fingerprint it had before. That is also
why publishing eight identities cannot perturb the verdict of any other identity
in the corpus.

---

## 10. Slugs

There is now **one** canonical slug definition: `src/lib/canonical/slug.ts`,
extracted verbatim from the import promotion engine, which imports it rather
than owning a private copy. Two generators would eventually disagree about what
`hotels.slug` means, and the one that is wrong is always the one nobody looked
at. `tests/db/canonical-slug.test.ts` proves the legacy behaviour is unchanged.

The collision ladder is unchanged: folded name → name + destination slug → +
short digest of the caller's uniqueness key → + numeric suffix. The digest is
over a caller-supplied key, never over the name, so two genuinely different
properties sharing a name cannot collapse onto one slug. Source publication
passes `source:environment:providerId`; the import path passes its
`source_property_key`, exactly as before.

A05 is **not** routed through `import:promote`. That engine is batch/file/review-
row based and also handles contacts, editorial evidence and file import links;
feeding source identities through fabricated import batches would borrow an
authorization model that does not apply and a provenance chain that would be
fiction. Only small, genuinely shared primitives are reused: the slug helper and
the persistent-target classifier.

---

## 11. Write-target safety

A05 **inverts** A04.5's posture, and the inversion is the point.

| | writes | posture |
|---|---|---|
| A04.5 / A04.6 | pilot review evidence about the evaluation corpus | local-only, evaluation-only; writing to a real database would be the mistake |
| **A05** | **canonical inventory** | a real publication belongs in the real persistent database |

A real `--apply` therefore reuses `assertPersistentApplyTarget` — the import
apply CLI's existing definition of a deliberate remote persistent database, which
requires an explicit `DATABASE_URL` and **never** falls back to
`TEST_DATABASE_URL`. There is deliberately no second definition of "the
production database" in this repository, and no override flag.

`prepare` and dry-run are read-only in effect (a dry-run runs every write and
rolls back), so they accept any classifiable target, including a disposable one.

---

## 12. Commands

```text
npm run source:publication:prepare -- \
  --source hotelbeds --environment production --as-of YYYY-MM-DD \
  [--limit N] [--out path]

npm run source:publication:apply -- \
  --source hotelbeds --environment production --as-of YYYY-MM-DD \
  --manifest path [--apply]
```

`--environment` must be typed out on prepare and must be `production`, so nobody
prepares a publication pack while thinking about evaluation. `apply` is dry-run
without `--apply`, and the dry-run exercises every pin, every constraint and
every write before rolling back.

---

## 13. Operational follow-up discovered by A04.7 (NOT an A05 blocker)

An **initial defer** creates receipt history but no `source_property_reviews`
projection (A04.5 §10). D062's condition 1 reads the projection, so a deferred
identity reports `identity_review_missing_or_deferred` — the same reason as an
unreviewed one — and its preview fingerprint is byte-identical before and after
the defer. `buildReviewPack` selects from `review_ready` without excluding an
identity that already carries a defer receipt for the **same observation**, so an
unchanged deferred identity can reappear in a later deterministic review pack and
be handed back to a human who already looked at it.

This is **not** a publication-safety issue: a defer never creates a projection,
so A05 refuses it at `human_review_missing`, and nothing about it can reach
canonical inventory. It is a human-review ergonomics issue, and it matters before
bulk review operations rather than before publication.

It is recorded here and deliberately **not** solved inside A05: fixing it means
deciding whether a same-observation defer suppresses re-presentation forever or
until evidence advances, which is supersession semantics — the same future work
A04.5 §9 and A04.6 §12 already defer.

---

## 14. Not in this layer

- **No `approve_match` publication.** No receipt model exists to publish.
- **No un-publish, no correction, no supersession** of a published canonical
  property. Post-publication conflict lifecycle remains future work (D063).
- **No `hotel_contacts`, media, website, Instagram, description, brand or
  `hotel_type` policy.** Publication is identity, not enrichment.
- **No intelligence, outreach or coverage write** of any kind.
- **No `publication_status` column and no draft-canonical tier.** D062: a row in
  `hotels` IS publication.
- **No automatic destination resolver, geocoding or coordinate correction.**
  Unchanged from A04.5 §11.
- **No real production publication.** No canonical hotel has been published by
  this block; every write test uses synthetic fixtures, and the eight real
  evaluation PASS identities remain unpublished.
