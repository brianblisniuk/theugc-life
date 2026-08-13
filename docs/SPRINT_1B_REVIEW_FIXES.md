# theugc.life — Sprint 1B External Review Fixes
Version: 1.0
Status: Approved blocking corrections before Sprint 1B PR

Sprint 1B architecture is accepted in principle, but the following data-integrity corrections are required before merge.

Do not expand scope beyond these corrections.

## F1 — Review manifests must be batch- and bundle-scoped

`import:review-apply` consumes editable JSON and MUST treat all identifiers in it as untrusted reviewer input.

Before writing any review state, validate all of the following:

1. Every `sourcePropertyKey` in the manifest belongs to exactly one reviewable property row in the specified `batchId`.
2. The manifest contains no duplicate property bundle keys.
3. Every child override `importRowId` belongs to the SAME `batchId`.
4. A child override row is only `contact` or `evidence`; never `property`.
5. The child row's `source_property_key` equals the containing bundle's `sourcePropertyKey`.
6. The same child row cannot appear in more than one override entry in the manifest.
7. Unknown property keys and unknown/cross-batch child IDs fail the entire review transaction; never silently ignore them.

Add regression tests proving a manifest for Batch A cannot mutate review state for Batch B and cannot attach a child from another property bundle.

## F2 — Define reviewable property bundles and enforce one property row per key

A canonical promotion bundle requires exactly one structurally usable property row.

Define a **reviewable property row** as:

- `row_kind = 'property'`
- `source_property_key IS NOT NULL`
- `normalized_data IS NOT NULL`
- `validation_status <> 'rejected'`

Structurally rejected property rows remain preserved in staging/reports, but they:

- are not rendered as canonical promotion bundles;
- do not enter the batch-approval denominator;
- can never be promoted;
- do not prevent valid reviewed bundles in the same batch from being approved/promoted.

A batch with zero reviewable property bundles cannot become `approved` or `promoted`.

Add a DB uniqueness backstop in a new additive migration so a batch cannot contain multiple `property` rows with the same non-null `source_property_key`.

Do NOT modify migrations `0001–0016`.

Add tests for:

- rejected structural property row + one valid property row: valid bundle can complete promotion; rejected row stays staging-only;
- zero reviewable property bundles: review/promotion cannot complete;
- duplicate property key rejected by DB.

## F3 — Destination alias resolution must never cross a known country conflict

`destination_aliases.country_code` being NULL must NOT allow an alias to resolve to a canonical destination whose known country conflicts with the source property's known country.

For alias resolution, compatibility must consider BOTH:

- the alias's optional `country_code`; and
- the target canonical destination's `country_code`.

If source country is known and either a non-null alias country or non-null destination country conflicts, that alias candidate is not compatible.

Also harden `destination:alias`:

- when an alias country is explicitly supplied and the canonical destination has a non-null country, they must match;
- do not permit an explicit cross-country alias mapping through the CLI.

Keep ambiguity conservative: multiple compatible destination IDs remain unresolved.

Add tests covering a NULL-country alias pointing to a BR destination with an AR source input (must NOT resolve) and an explicit mismatched alias-country insertion (must fail).

## F4 — Only included evidence may upgrade canonical hotel verification

For `approve_create`, `editorial_verification_status = 'verified'` may be derived only from an evidence row that:

- has `claim_type = 'property_exists'`;
- has `verification_status = 'verified'`; AND
- resolves to final child inclusion = `include` after applying default policy + reviewer override.

Evidence that is deferred, excluded, rejected or invalid must never upgrade the hotel verification state.

Add regression tests for:

- verified property evidence included -> canonical hotel verified;
- same evidence explicitly excluded/deferred -> canonical hotel remains unverified.

## F5 — Review state is immutable after canonical promotion

Once `import_batches.status = 'promoted'`, `applyReview` / `import:review-apply` must refuse to alter property or child review decisions for that batch.

Reason: canonical actions already reference the approved review state. Retroactively changing that state would make the audit trail dishonest and can conflict with idempotent row links.

A repeated `import:promote --apply` using the unchanged promoted review remains allowed and must remain idempotent.

Future canonical reconciliation/reversal is a separate workflow, not review mutation.

Add tests proving:

- promoted batch review mutation is rejected;
- repeat promotion with unchanged review is still a no-op/idempotent success.

## F6 — Rolled-back bundles must not report successful canonical mutations

Promotion is transactional per bundle. If a bundle transaction rolls back, returned `BundlePlan` and aggregate `totals` must not claim canonical rows were successfully created/matched/updated in that rolled-back transaction.

Only committed mutations count toward:

- `hotelsCreated`
- `hotelsMatched`
- `contactsCreated`
- `contactsReused` where the reuse/link was part of the failed transaction
- `evidenceCreated`
- applied filled-field counts

The failed bundle may retain diagnostics/conflicts/error text, but mutation counters must reflect committed database state.

Add one regression test that intentionally causes a failure after at least one mutation attempt inside a property transaction and proves:

- DB canonical state is rolled back;
- bundle mutation counters are zero for the rolled-back work;
- aggregate totals are zero for the rolled-back work.

## Verification

After implementing F1–F6 run:

- migrations from empty DB;
- lint;
- typecheck;
- full tests;
- production build.

Commit and push to `claude/sprint-1b-canonical-promotion` and stop for external review.

Do NOT open a PR automatically.
Do NOT begin Sprint 1C.
Do NOT import/promote real datasets.
