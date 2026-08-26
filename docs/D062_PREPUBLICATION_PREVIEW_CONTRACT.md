# D062 pre-publication preview — A04 contract

The A04 preview is a staff-only, read-only composition of evidence that exists
before publication. It never authorizes or applies publication. A row in
`hotels` remains publication; there is no draft canonical tier.

Run one explicitly scoped candidate with:

```text
npm run source:preview -- --source hotelbeds --environment evaluation \
  --as-of YYYY-MM-DD --source-property-id PROVIDER_ID
```

`--identity-id` is the alternative scope. `--environment` explicitly selects
`evaluation` or `production`; production inspection remains read-only and does
not implement production ingestion. `--source` is mandatory; provider-native ids
have no meaning outside their explicit source namespace. There is no unscoped
default and no `--apply`.

Every invocation reads all evidence inside one PostgreSQL `REPEATABLE READ`,
`READ ONLY` transaction. The transaction begins before the first evidence query,
commits on success, and rolls back on error. A hosted production database is a
valid inspection target only through this read-only path; the separate ingestion
resolver remains remote-write refusing.

## Vocabulary and composition

Each of all eleven separately rendered conditions is exactly `PASS`, `FAIL`, or
`UNRESOLVED`. Overall is `PASS` only when all eleven pass, `FAIL` when any
condition definitively fails, and `UNRESOLVED` otherwise. A fail and an unrelated
hold both remain visible; the fail deterministically controls overall.

Condition 5 is derived only from conditions 1, 2, 3, 4, 6, 7, and 11. It never
reads overall or `source_property_identities.resolution_state`, so it cannot be
circular. Conditions 8–10 remain independent D062 coordinate requirements.

Current observation means exactly the observation for the same identity and its
`last_seen_run_id`. A missing pointer target holds the preview. Timestamp, UUID,
creation time, and row order never select evidence; history is not a fallback.
The human entity-review manifest uses the same pointer. Contradictory accepted
canonical targets, or accepted NEW plus accepted canonical evidence, HOLD both
identity and conflict conditions; ordering or choosing one row cannot resolve a
contradiction.

## Evidence and fingerprint

For `approve_create`, condition 2 uses the explicit reviewed destination. For
`approve_match`, it uses the named canonical target hotel's destination; a null
review destination is permitted, but a non-null one must agree exactly with the
target hotel or the condition holds as unresolved.

Every condition contains its number, stable name, status, machine reason,
explanation, immutable identifiers/policy fields, and condition-specific
`asOf`. The preview fingerprint is lowercase SHA-256 over a canonical JSON
semantic bundle containing fingerprint schema version,
identity/source/environment/current observation, explicit as-of, and every
condition's stable number/key, status, machine reason, semantic evidence, and
condition-specific as-of. It also binds the complete current human-review
provenance and deterministic semantic snapshots of every supporting or
contradicting accepted entity candidate. Human-readable explanations/display copy are
explicitly excluded. Object keys are recursively sorted and set-like
identifier/reason arrays are sorted. It reads no clock, creates no UUID, depends
on no DB row order, and is not an authorization.

Fingerprint schema `d062-prepublication-preview-fingerprint/2` uses explicit
code-point lexical comparison rather than locale collation. Source-identity
candidate evidence binds both pair endpoints. Lifecycle arrays are retained and
sorted by semantic contents (including provider order when present), never by
evidence-row UUID. Fingerprint-bound `timestamptz` values are emitted as canonical
UTC instants with six fractional digits and `Z`.

Entity evidence uses a live discovery sweep and the existing sync gate. Pending
current pairs and live anomaly findings hold conditions 1/11; legitimately
superseded history is not actionable. `approve_create` additionally requires an
explicit accepted `new_property` finding. `approve_match` requires an accepted
canonical candidate naming exactly the reviewed target. No machine-candidate
absence becomes NEW.

## Human review receipt (A04.5)

For `approve_create`, conditions 1 and 2 additionally cite the immutable
`source_property_review_receipts` row recorded by A04.5. The receipt is checked
for **currentness**, not merely existence: it must cite this identity's current
observation. A decision taken against superseded evidence is not a decision about
today's evidence, so it holds rather than passes. `approve_match` receipts are
not part of this layer's vocabulary and conditions 1 and 2 evaluate that path
exactly as before.

| condition | hold reason |
|---|---|
| 1 | `human_review_receipt_missing` — no receipt for the identity |
| 1 | `human_review_receipt_decision_mismatch` — the receipt is a `defer` |
| 1 | `human_review_receipt_not_current` — the receipt cites a superseded observation |
| 1 | `human_review_receipt_finding_mismatch` — the receipt's finding is not an accepted current `new_property` finding for this identity |
| 2 | `human_review_receipt_missing` / `human_review_receipt_not_current` |
| 2 | `human_review_receipt_destination_mismatch` — the receipt names a different destination than the review row |

When condition 1 passes on this path its machine reason is
`reviewed_distinct_property`. Because conditions 1 and 2 now read the receipt,
the preview fingerprint changes when a review is applied; see
`A04_5_HUMAN_REVIEW_EVIDENCE_CONTRACT.md` §9 for why the review apply path must
therefore check idempotency before it checks fingerprint staleness.

## Human review revocation (A04.6)

Conditions 1 and 2 read **two** things about the current review: what the human
concluded (`decision`) and whether that conclusion is still authorized
(`review_status`). A withdrawn approval is checked **first**, ahead of every
other `approve_create` test, because a revoked review is not a weaker form of
approval — it is not an approval at all.

| condition | hold reason |
|---|---|
| 1 | `human_review_revoked` — a human explicitly withdrew this approval |
| 2 | `human_review_revoked` — same withdrawal, same effect |

Both hold as UNRESOLVED rather than FAIL: withdrawing an approval is not a
finding that the property is ineligible, and condition 5 stops passing because it
derives from 1 and 2. The verdict stops being PASS on the next evaluation, with
no backfill or recompute step in between. See
`A04_6_HUMAN_REVIEW_REVOCATION_CONTRACT.md`.

A candidate belongs to an identity when it matches **either** endpoint —
`source_property_identity_id` or `candidate_source_property_identity_id`. A pair
is unordered, and which endpoint is stored on which side follows identity UUID
ordering, which is meaningless across databases. See
`PROPERTY_ENTITY_RESOLUTION_CONTRACT.md` §8.1; reading a single column would
change the population under evaluation without raising any error.

Lifecycle reuses A03 unchanged: explicit as-of, complete current snapshot,
approved exact provider policy, property-level `HOTEL+CLOSED` only, and
`NO_KNOWN_CLOSURE` never re-labelled active/open/operating.
