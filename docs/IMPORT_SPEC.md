# theugc.life — IMPORT_SPEC.md
Version: 2.0
Status: Approved Sprint 1 import architecture

## 1. Principle

The importer is designed around the canonical hotel research contract, not around historical spreadsheets.

Future research should conform to `HOTEL_DATA_CONTRACT.md`.

Legacy files are handled by one-time adapters that translate them into the same normalized staging model. Legacy quirks MUST NOT leak into canonical schema or product behavior.

## 2. Pipeline

`SOURCE FILE -> IMPORT BATCH -> RAW ROWS -> NORMALIZED STAGING -> VALIDATION -> ENTITY RESOLUTION -> REVIEW -> CANONICAL PROMOTION`

Canonical promotion is never automatic for ambiguous records.

## 3. Import infrastructure

### import_batches
- id
- source_name
- source_file_name
- source_kind
- parser_name
- parser_version
- file_sha256
- status
- counters: total/valid/warning/review/rejected
- started_at
- completed_at
- created_at

Statuses: `pending`, `parsing`, `parsed`, `review_required`, `failed`, `approved`, `promoted`.

### import_rows
Immutable raw lineage.
- id
- import_batch_id
- sheet_name
- source_row_number
- row_kind
- raw_data jsonb
- raw_fingerprint
- normalized_data jsonb
- validation_status
- validation_errors text[]
- validation_warnings text[]
- created_at

### import_match_candidates
For explainable entity resolution.
- id
- import_row_id
- candidate_entity_type
- candidate_entity_id
- score
- match_method
- status
- review_note
- created_at
- resolved_at

### import_row_links
Links a raw row to canonical entities after review/promotion.
- import_row_id
- entity_type
- entity_id
- link_type

Link types: `created`, `matched`, `updated`, `evidence_for`, `split_into`.

## 4. Provenance

Add a first-class `editorial_evidence` entity so important contact/property claims can preserve:
- subject type/id
- claim type
- verification status
- source type
- source URL
- observed/verified timestamps
- import batch/row lineage
- optional research note/excerpt

This table is editorial. It never feeds creator outcome metrics directly.

## 5. Organizations

Implement a minimal reusable organization model because hotel groups/operators/agencies are normal hospitality entities, not legacy-file artifacts.

### organizations
Types initially:
- `hotel_group`
- `operator`
- `management_company`
- `pr_agency`
- `sales_rep`
- `other`

### hotel_organizations
Relationships initially:
- `operated_by`
- `managed_by`
- `represented_by`
- `owned_by`
- `corporate_group`
- `other`

### organization_contacts
Use for corporate/agency contacts whose true scope is broader than one property.

Do not replace `brands`; brand identity and operating organization are different concepts.

## 6. Normalization

### Strings
Unicode normalize, trim, collapse repeated whitespace. Preserve original in raw data.

### Emails
Extract only complete syntactically valid email tokens; compare case-insensitively. Masked values are invalid endpoints. Preserve narrative/routing notes separately.

### URLs
Normalize hostname, tracking params and trailing slash for comparison. Chain hostname alone is never a hotel identity key.

### Hotels
Maintain commercial display name plus normalized match representation. Do not aggressively strip brand/geographic/property-type words.

### hotel_type
Reuse existing `hotels.hotel_type`. Do not introduce a duplicate field. Normalize using `HOTEL_DATA_CONTRACT.md` taxonomy.

### Geography
Resolve against existing hierarchical destinations. Do not auto-create a destination for every free-text neighborhood. Unknown/ambiguous geography becomes review-required.

## 7. Entity resolution

False merges are more damaging than temporary duplicates.

### Safe auto-match
Only:
1. stable source ID on re-import;
2. exact normalized hotel name + same canonical destination;
3. exact property-specific canonical URL + compatible normalized name;
4. explicit versioned alias rule.

### Fuzzy matching
May generate a candidate only. Never auto-merge based solely on fuzzy similarity.

### Forbidden hotel identity keys
Never identify a hotel solely by:
- email
- brand
- chain domain
- contact name
- agency
- city alone

One corporate contact may represent multiple properties.

## 8. Contact rules

- A generic mailbox is a contact endpoint, not a fake person.
- Same email may attach to multiple properties or to one organization.
- Named contacts can have multiple scopes over time.
- Verification status is preserved independently of syntax.
- Inferred contacts must not be labeled verified.

## 9. Standard importer

Build the primary importer against the canonical format in `HOTEL_DATA_CONTRACT.md`.

Support:
- CSV
- XLSX

Expected future normalized workbooks:
- `properties`
- `contacts`
- optional `evidence`

This is the durable importer.

## 10. Legacy migration adapters

Legacy adapters are one-time migration code and should live under a clearly isolated namespace, e.g. `scripts/import/legacy/`.

They may contain source-specific parsing logic, but their output MUST be the same normalized contract consumed by the standard staging pipeline.

Do not add legacy column names or special cases to canonical database tables.

## 11. Idempotency

Required:
- SHA256 file hash
- parser version
- stable row fingerprints
- deterministic source IDs when available
- repeat import detection

Re-running the same input must not duplicate canonical hotels/contacts.

## 12. Security

- import tooling is server/admin only;
- raw datasets are not committed;
- import tables are not creator-readable;
- real contact data is not used in test fixtures;
- reports with real emails remain local/untracked;
- raw rows must not be dumped into application logs.

Local paths:
- `/data/imports/raw/`
- `/data/imports/reports/`

Both should be gitignored except documentation placeholders where useful.

## 13. Commands

Provide CLI commands equivalent to:

- `npm run import:inspect -- --file ...`
- `npm run import:stage -- --file ...`
- `npm run import:dry-run -- --file ...`
- `npm run import:report -- --batch ...`

Legacy inputs additionally select a legacy adapter.

Do not implement a blind `promote-all` command in Sprint 1A.

## 14. Dry-run report

Produce JSON + Markdown with:
- source rows
- property candidates
- contact candidates
- organization candidates
- valid/invalid/masked emails
- no-contact properties
- safe matches
- fuzzy candidates
- unresolved destinations
- ambiguous multi-property rows
- verification distribution
- rejected/review-required rows

Reports must explain match methods.

## 15. Data quality

Use transparent completeness dimensions rather than one permanent opaque score:
- destination resolved
- website/source present
- any contact present
- marketing/PR contact present
- named contact present
- provenance present
- verification status/recency known
- needs review

## 16. Migration rule

Migrations `0001`–`0013` are reviewed baseline.

Sprint 1 creates `0014+` migrations. Do not rewrite baseline migrations unless an explicitly approved critical defect requires it.

## 17. Sprint 1A stop condition

Sprint 1A ends when:
- canonical research contract importer works;
- staging/provenance schema exists;
- legacy data can be translated into staging through isolated adapters;
- actual files can be dry-run;
- review reports are generated;
- no bulk canonical promotion has happened.

Human review is required before promotion.
