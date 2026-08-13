# Claude Code — Sprint 1B Master Prompt
Title: Destination Catalog + Reviewer-Gated Canonical Promotion

Sprint 1A has been externally reviewed, CI-validated and merged into `main`.

This branch starts Sprint 1B from that reviewed baseline.

## Read before coding

Read in full:

- `/docs/PRD.md`
- `/docs/DATABASE.md`
- `/docs/PERMISSIONS.md`
- `/docs/DECISIONS.md`
- `/docs/HOTEL_DATA_CONTRACT.md`
- `/docs/IMPORT_SPEC.md`
- `/docs/DESTINATION_CATALOG.md`
- `/docs/CANONICAL_PROMOTION_SPEC.md`

Treat `DESTINATION_CATALOG.md` and `CANONICAL_PROMOTION_SPEC.md` as approved Sprint 1B amendments.

If you encounter an actual contradiction that cannot be resolved through document precedence, use the blocking-decision protocol. Do not silently invent product behavior.

## Objective

Build the controlled gate from reviewed staging data to canonical production hotel/contact/evidence records.

Sprint 1B is infrastructure and correctness work. It must work end-to-end using synthetic fixtures.

**Real legacy datasets are NOT required to complete this sprint.**

Do not redesign the system around the old spreadsheets.

## Baseline migration rule

Migrations `0001–0015` are reviewed baseline.

Create additive migrations starting at `0016`.

Do not rewrite baseline migrations.

## Required database changes

Implement the schema defined by the approved Sprint 1B docs.

At minimum:

### Destination resolution

Add `destination_aliases` with RLS/admin-only access, indexes and deterministic normalized alias behavior.

### Review state

Add:

- `import_property_reviews`
- `import_row_reviews`

Implement constraints so invalid decision/target combinations cannot be stored.

### Canonical contacts

Add to `hotel_contacts`:

- `display_name`
- `verification_status`
- `organization_name`

Expand department support to the canonical research taxonomy.

Operational `status` and verification confidence remain separate.

Do NOT automatically parse `display_name` into first/last name.

### Import lineage

Add a DB uniqueness backstop for `import_row_links` so repeat promotion cannot duplicate an identical source-row → entity link action.

## Canonical research contract

Extend the property research contract with nullable/preferred `destination_slug` as defined in `DESTINATION_CATALOG.md`.

Synchronize:

- TypeScript contract
- parser/staging
- `HOTEL_DATA_CONTRACT.md`
- `RESEARCH_PROMPT_TEMPLATE.md`

Future clean research should use `destination_slug` when the canonical destination is known.

Legacy adapters may leave it null.

## Destination resolution

Implement deterministic resolution order exactly:

1. exact canonical destination slug;
2. exact active alias + compatible country;
3. exact normalized canonical name + compatible country when unique;
4. unresolved.

No fuzzy geography auto-resolution.

No automatic destination creation from imported free text.

Provide admin/server CLI tooling equivalent to:

- `destination:list`
- `destination:upsert`
- `destination:alias`

Validate hierarchy cycles, parent existence, slug uniqueness, taxonomy and coordinates.

Do not add a third-party geocoding dependency in Sprint 1B.

## Review workflow

Implement a review manifest workflow that persists to DB review tables.

Commands equivalent to:

- `import:review-template -- --batch <uuid>`
- `import:review-apply -- --batch <uuid> --file <json> --reviewer <label>`

Review-template output is gitignored and contains:

- each property bundle;
- staged property data;
- destination resolution;
- hotel match candidates;
- child contacts/evidence;
- default child inclusion/defer/exclude status;
- editable reviewer decision fields.

`review-apply` validates the manifest and writes only review state. It does not promote canonical data.

## Child inclusion policy

Implement exactly as `CANONICAL_PROMOTION_SPEC.md`.

Critical points:

- inferred contacts are DEFERRED by default;
- invalid/rejected contacts cannot be force-included in Sprint 1B;
- review-status rows require explicit include;
- actionable endpoint required for canonical contact promotion;
- generic mailboxes remain endpoints, not fake named people.

## Promotion engine

Implement:

`npm run import:promote -- --batch <uuid>`

Default mode is PREVIEW ONLY and makes zero canonical mutations.

Actual mutation requires explicit:

`--apply`

There is no blind `promote-all` bypass.

Promotion operates transactionally per property bundle.

### approve_create

Create a canonical hotel only when:

- explicit property review is `approve_create`;
- destination is canonical and approved;
- required staged data is valid.

Generate collision-safe stable slug.

Do not invent missing fields.

### approve_match

Link to target canonical hotel.

Do not overwrite conflicting non-null hotel fields.

Only safe fill-null behavior defined by the spec is allowed.

Never change destination implicitly.

## Contact promotion

Preserve:

- exact `display_name`
- department
- actionable endpoints
- contact scope/type
- explicit `organization_name`
- verification status
- source URL/provenance

Do not split names automatically.

Contact deterministic reuse is scoped to the same hotel:

1. exact normalized email;
2. else LinkedIn URL;
3. else phone.

The same email on different hotels is valid.

## Organizations

Do NOT build a broad organization entity-resolution engine in Sprint 1B.

Preserve explicit organization context on hotel contacts/evidence as specified.

Do not fuzzy-match or invent organizations.

The existing organization tables remain available for a later dedicated resolver.

## Editorial evidence

Promotion must create proper canonical editorial evidence and preserve import batch/row lineage.

Seed/import promotion must still create ZERO:

- `outreach_events`
- creator activity metrics
- `hotel_intelligence` observations
- `destination_intelligence` observations

Add regression tests proving this.

## Idempotency

Repeated promotion of the same approved bundle must be a no-op/reuse, not duplication.

Use:

- transaction per bundle;
- review-row locking;
- `import_row_links`;
- canonical contact deterministic reuse;
- DB unique constraints/backstops.

## Batch state

Implement review completeness and batch state transitions from the spec.

A batch cannot be `approved` while a property bundle is missing a final review or remains deferred.

Batch becomes `promoted` only after all approved property bundles are successfully/idempotently promoted.

## Security

- review/promotion tables admin/editor/service-role only;
- no creator or anonymous access;
- no public promotion endpoint;
- reviewer manifests/reports remain gitignored;
- avoid raw contact data in logs;
- no service-role credentials in client code.

## Required tests

Implement every required synthetic test in `CANONICAL_PROMOTION_SPEC.md §17` plus:

- destination_slug exact resolution;
- alias+country resolution;
- ambiguous alias stays unresolved;
- destination hierarchy cycle prevention;
- review manifest validation;
- review state RLS;
- preview mode produces zero canonical mutations;
- `--apply` without complete review fails safely;
- repeat apply is idempotent.

Use synthetic invented contact/property data only.

## Verification

Before completion run:

- migrations from empty DB
- lint
- typecheck
- full tests
- production build

Do not suppress failures.

## Completion report

Report:

- migrations added
- schema changes
- destination resolver/tooling
- review workflow
- promotion algorithm
- contact merge/idempotency rules
- exact CLI commands
- tests added and total count
- migration/lint/typecheck/test/build results
- any unresolved decisions

## STOP CONDITION

Stop after Sprint 1B infrastructure passes end-to-end synthetic review → promotion tests.

Do NOT:

- import/promote the real messy datasets;
- seed a large arbitrary destination catalog;
- build map/discovery UI;
- build CRM UI;
- implement Hotmart;
- implement AI/email/community/marketplace;
- begin Sprint 1C automatically.

The first real canonical dataset import is reviewed separately after Sprint 1B.