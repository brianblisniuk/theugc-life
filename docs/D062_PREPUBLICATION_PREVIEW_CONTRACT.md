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

Lifecycle reuses A03 unchanged: explicit as-of, complete current snapshot,
approved exact provider policy, property-level `HOTEL+CLOSED` only, and
`NO_KNOWN_CLOSURE` never re-labelled active/open/operating.
