# theugc.life — CANONICAL_PROMOTION_SPEC.md
Version: 1.0
Status: Approved Sprint 1B specification

## 1. Objective

Sprint 1B builds the controlled gate from reviewed staging data into canonical production entities.

The promotion system must be:

- reviewer-gated;
- idempotent;
- transactional;
- conservative about overwrites;
- auditable from canonical entity back to source row;
- independent from legacy file quirks.

No source file writes directly to `hotels`, `hotel_contacts`, `organizations` or `editorial_evidence`.

> **Promotion IS publication (D062).** For V1 there is no canonical-but-
> unpublished state: a row in `hotels` is a row a creator can see, so
> **promotion into `hotels` is the publication boundary** and the D062
> publishability conditions are **promotion preconditions** — see §6.1.
>
> Sprint 1B's engine predates that gate and does not implement it. The gate is
> work for the Property Content implementation block; nothing here retroactively
> claims that already-promoted rows satisfy it.

## 2. Promotion unit

The primary promotion unit is a **property bundle** identified by:

`(import_batch_id, source_property_key)`

A bundle contains:

- one property row;
- zero or more contact rows;
- zero or more evidence rows;
- entity-resolution candidates;
- reviewer decision.

A bundle is promoted in one database transaction.

Failure of one bundle must not corrupt or partially promote that bundle.

## 3. Property review table

Add `import_property_reviews`.

Fields:

- `id uuid PK`
- `import_batch_id uuid FK import_batches`
- `source_property_key text NOT NULL`
- `decision text NOT NULL`
- `target_hotel_id uuid NULL FK hotels`
- `destination_id uuid NULL FK destinations`
- `reviewer_user_id uuid NULL FK users`
- `reviewer_label text NOT NULL`
- `review_note text NULL`
- `reviewed_at timestamptz NOT NULL`
- timestamps

Unique:

`(import_batch_id, source_property_key)`

Decisions:

- `approve_create`
- `approve_match`
- `reject`
- `defer`

Constraints:

### approve_create

- `target_hotel_id IS NULL`
- `destination_id IS NOT NULL`

### approve_match

- `target_hotel_id IS NOT NULL`
- target hotel must exist
- if reviewer also supplies a destination, it must equal the target hotel's destination

### reject / defer

- no canonical mutation

A deterministic match candidate does not by itself authorize promotion. The property bundle still requires an explicit review decision.

## 4. Child-row review overrides

Add `import_row_reviews` for contact/evidence exceptions.

Fields:

- `id uuid PK`
- `import_row_id uuid UNIQUE FK import_rows`
- `decision text NOT NULL`
- `reviewer_user_id uuid NULL FK users`
- `reviewer_label text NOT NULL`
- `review_note text NULL`
- `reviewed_at timestamptz NOT NULL`
- timestamps

Decisions:

- `include`
- `exclude`
- `defer`

Property rows use `import_property_reviews`; `import_row_reviews` applies only to child contact/evidence rows.

## 5. Default child inclusion policy

A property review approves the bundle, but child rows still follow deterministic safety rules.

### Contacts

Default INCLUDE only when all are true:

- row validation is `valid` or `warning`;
- contact verification status is not `invalid`;
- contact has at least one actionable endpoint: email, phone or LinkedIn URL;
- contact verification status is not `inferred`.

Default DEFER when:

- row validation is `review`; or
- verification status is `inferred`; or
- organization identity is missing for a broader-than-property scope.

Default EXCLUDE when:

- row validation is `rejected`; or
- verification status is `invalid`; or
- no actionable endpoint exists.

An explicit `import_row_reviews.decision = include` may include a `review` or `inferred` contact, but may NOT override a structurally rejected/invalid row in Sprint 1B.

### Evidence

Default INCLUDE when validation is `valid` or `warning` and evidence is not invalid.

`review` evidence requires explicit include.

Rejected/invalid evidence is excluded.

## 6. Canonical hotel creation

For `approve_create`:

- destination is the reviewer-approved canonical destination;
- use the normalized staged property fields;
- generate a stable human-readable slug;
- slug collisions are resolved deterministically with a destination-derived or short stable suffix;
- do not change an existing hotel's slug as a side effect of import;
- `active_status` defaults to `unknown` unless canonical editorial evidence explicitly supports another existing approved state;
- `editorial_verification_status` reflects evidence quality conservatively;
- never invent missing values.

### 6.1 Publishability gate — required by D054/D060/D062, NOT YET IMPLEMENTED

Creating a canonical hotel **is** publishing it (D062). The gate therefore sits on
promotion itself: a candidate must not be promoted into `hotels` unless all of
the following are true (`PROPERTY_CONTENT_COVERAGE_CONTRACT.md` §7):

1. canonical property identity is resolved;
2. it belongs to a supported canonical destination;
3. it is a physical hospitality property;
4. it is not known permanently closed/inactive;
5. its V1 scope status is resolved;
6. canonical star classification is exactly 4 or 5;
7. star-classification provenance exists;
8. canonical latitude exists;
9. canonical longitude exists;
10. coordinate/location provenance exists;
11. no unresolved entity-resolution conflict remains.

The gate must **not** require photography, any contact, a target contact, a
premium contact, or any intelligence. Those are enrichment states (D061), and
holding a hotel back for them would silently cap the destination (D055).

A candidate failing the gate **stays in staging/review and is not promoted**. It
is never deleted, and it is never given a fabricated coordinate or an invented
star classification to make it pass. Do **not** introduce a `publication_status`
column or an unpublished-canonical tier to work around the gate — the single
boundary is the contract.

The pipeline, stated once:

```
source → staging → audit/review → promotion preview → human review
       → promotion/apply → canonical publishable hotel
```

**Historical rows are not grandfathered.** The canonical pilot was promoted
before D054, D060 and D062 existed; the implementation block must audit, enrich
and re-evaluate those rows against this gate rather than assume them compliant.

Brand linking is NOT required for Sprint 1B. Preserve staged `brandName` in import lineage/evidence and leave `brand_id` null unless a future explicit brand-resolution rule is approved.

## 7. Matching an existing hotel

For `approve_match`:

- link the property import row to the target hotel;
- do not silently overwrite existing non-null hotel fields;
- Sprint 1B may fill a canonical hotel field only when the canonical value is NULL and the staged value is non-null, structurally valid and supported by the approved bundle;
- conflicting non-null values remain canonical unchanged and should be reported for later editorial review;
- never replace destination automatically during an import match.

This is intentionally conservative. Canonical field reconciliation can become a dedicated editorial workflow later.

## 8. Hotel-contact canonical model adjustments

The existing contact model mixes operational lifecycle and verification confidence. Sprint 1B must separate them.

Add to `hotel_contacts`:

- `display_name text NULL`
- `verification_status text NOT NULL DEFAULT 'unverified'`
- `organization_name text NULL`

Verification statuses:

- `verified`
- `probable`
- `inferred`
- `unverified`
- `invalid`

Do not parse international personal names into first/last name automatically. `display_name` preserves the researched name exactly; `first_name`/`last_name` may remain null unless explicitly structured in a future contract.

Expand `department` compatibility so the canonical contact table can preserve the research taxonomy, including:

- marketing
- pr
- communications
- social_media
- partnerships
- events
- sales
- reservations
- general
- other
- unknown

Operational `status` remains separate:

- verified usable contact -> `active`
- probable/unverified/inferred included by explicit review -> `unverified`
- invalid contacts are not promoted

`source_type = editorial` for seed/research imports.

`source_reference` may store the supporting source URL, while `editorial_evidence` retains full provenance.

## 9. Contact deduplication within a hotel

Never make email globally unique.

For the same hotel, reuse an existing contact endpoint when an approved deterministic rule matches in this order:

1. same normalized non-null email;
2. else same normalized non-null LinkedIn URL;
3. else same normalized non-null phone.

A name alone never auto-identifies a contact.

If an endpoint matches, attach new provenance/evidence and fill only safe null fields; do not silently overwrite conflicting non-null contact identity/title data.

The same email may legitimately exist on multiple hotels.

## 10. Organizations during Sprint 1B

Organizations remain first-class, but Sprint 1B does NOT need to auto-normalize every organization candidate into the organization graph.

For an included external/group/operator contact:

- preserve explicit `organization_name` on the canonical `hotel_contact`;
- preserve scope and agency/operator relationship in `editorial_evidence`;
- do not invent or fuzzy-match an organization entity.

Organization graph promotion may be added later with dedicated organization-resolution rules. This avoids false company merges while preserving user-visible outreach context now.

## 11. Editorial evidence promotion

Promotion creates canonical `editorial_evidence` rows for included evidence and important contact/property provenance.

Each promoted evidence record must keep:

- canonical subject type/id;
- source type;
- source URL;
- verification status;
- observed/verified time when known;
- import batch ID;
- import row ID.

Research evidence never creates creator outcome events or intelligence.

## 12. Import row links

For every successful canonical action, create `import_row_links`:

- `created`
- `matched`
- `updated`
- `evidence_for`

Add a uniqueness constraint/index so the same row/entity/link action cannot be duplicated on repeat promotion.

These links are the primary canonical-to-source audit trail.

## 13. Idempotency and locking

Promotion must be safely repeatable.

Requirements:

- transaction per property bundle;
- lock the property review row during promotion;
- use existing import-row links to detect already-promoted actions;
- use DB uniqueness as a final backstop;
- retrying an already promoted bundle returns a no-op/idempotent result, not duplicate hotels/contacts/evidence.

Do not implement a blind `promote-all` operation.

## 14. Review manifest workflow

Until an admin UI exists, Sprint 1B uses a local reviewer manifest that writes the same DB review tables a future UI will use.

Commands equivalent to:

### Generate

`npm run import:review-template -- --batch <uuid>`

Produces gitignored JSON containing each property bundle, proposed matches, destination resolution and child-row default inclusion status.

### Apply review

`npm run import:review-apply -- --batch <uuid> --file <review.json> --reviewer "Brian"`

Validates the manifest and writes `import_property_reviews` / `import_row_reviews` only.

### Promotion preview

`npm run import:promote -- --batch <uuid>`

Without `--apply`, prints/writes a promotion plan and performs no canonical mutation.

### Apply promotion

`npm run import:promote -- --batch <uuid> --apply`

Requires complete approved review state and promotes only eligible reviewed bundles.

There is no command that bypasses review.

## 15. Batch state

A batch may become `approved` only when all property bundles are either:

- approve_create;
- approve_match;
- reject.

Any `defer` or missing property review keeps the batch review-required.

After all approved bundles have completed idempotent promotion, batch status may become `promoted`.

Rejected bundles remain preserved in staging.

## 16. Security

- review and promotion tooling is admin/server only;
- no public/browser promotion endpoint in Sprint 1B;
- real review manifests/reports remain gitignored;
- promotion does not log raw rows or contact PII unnecessarily;
- all review tables use RLS for admin/editor/service-role only.

## 17. Required tests

Synthetic tests must cover at minimum:

- create a new hotel after explicit review;
- match an existing hotel after explicit review;
- missing destination blocks create;
- no review blocks promotion;
- rejected property produces no canonical mutation;
- review/deferred child contact is not promoted by default;
- inferred contact excluded by default and includable only by explicit review;
- invalid contact cannot be force-included;
- same contact email on same hotel is idempotently reused;
- same email on two different hotels is allowed;
- existing non-null hotel fields are not overwritten silently;
- null hotel field may be safely filled according to policy;
- display_name preserves full researched person name without name splitting;
- organization_name survives canonical contact promotion;
- evidence lineage points back to import batch/row;
- repeated promotion creates no duplicates;
- zero outreach/intelligence events are created.

## 18. Sprint 1B stopping point

Sprint 1B stops when the destination catalog tooling, review state and canonical promotion engine work end-to-end on synthetic data.

Do NOT require or bulk-promote the messy legacy source files in order to complete Sprint 1B.

The first real dataset promotion is a separate review step after this infrastructure is merged.