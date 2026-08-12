# Claude Code — Sprint 1A Master Prompt
Title: Canonical hotel data contract + seed import foundation

Sprint 0 and Sprint 0.1 are approved and closed.

## Read before coding

Read in full:
- `/docs/PRD.md`
- `/docs/DATABASE.md`
- `/docs/PERMISSIONS.md`
- `/docs/EVENTS.md`
- `/docs/DECISIONS.md`
- `/docs/HOTEL_DATA_CONTRACT.md`
- `/docs/IMPORT_SPEC.md`
- `/docs/LEGACY_DATA_MIGRATION.md`

These Sprint 1 documents are approved amendments. The legacy files are migration inputs, not product specifications.

## Core principle

Build the import system around the canonical contract in `HOTEL_DATA_CONTRACT.md`.

Do NOT model canonical schema around quirky legacy spreadsheets.

Future hotel research will conform to the canonical contract. Current messy files should be handled only through isolated one-time legacy adapters.

## Baseline migration rule

Migrations `0001`–`0013` are frozen reviewed baseline.

Create new migrations starting at `0014`.

Do not rewrite old migrations.

## Sprint 1A objective

Build a secure, auditable seed-data pipeline that can:
1. import clean future research in the canonical contract;
2. translate current legacy inputs into that same staging model;
3. validate and resolve entities conservatively;
4. produce dry-run review reports;
5. STOP before real bulk canonical promotion.

## Required schema

Implement coherent new tables from `IMPORT_SPEC.md`:
- `import_batches`
- `import_rows`
- `import_match_candidates`
- `import_row_links`
- `editorial_evidence`
- minimal `organizations`
- `hotel_organizations`
- `organization_contacts`

Reuse `hotels.hotel_type`; do not create duplicate property-type fields.

Apply foreign keys, check constraints, indexes, RLS and appropriate grants.

Import/provenance internals must be admin/service-role only.

## Durable standard importer

Implement the primary importer for the canonical contract:
- CSV
- XLSX
- `properties` sheet
- `contacts` sheet
- optional `evidence` sheet

This is the importer we should use for all future research.

Do not hard-code future product behavior around current legacy file names or columns.

## Legacy migration

Implement isolated adapters under a legacy namespace such as:

`scripts/import/legacy/`

for the currently supplied mixed research files.

The adapters may be ugly internally. Their OUTPUT must be clean canonical staging records.

It is acceptable to reject or flag legacy rows that cannot be mapped confidently. Do not contaminate canonical data in order to maximize imported row count.

## Normalization

Implement exactly the durable rules from `IMPORT_SPEC.md`, including:
- Unicode/whitespace cleanup
- valid email token extraction
- masked email rejection
- generic mailbox != named person
- URL normalization
- hotel-type taxonomy
- destination resolution against hierarchy
- verification status preservation
- editorial evidence preservation
- organizations not represented as fake hotels

## Entity resolution

Be conservative.

Safe auto-match only under approved deterministic rules.

Fuzzy similarity creates review candidates only.

Never identify a hotel solely by email, brand, chain domain, contact name, agency, or city.

False merges are worse than temporary duplicates.

## Editorial vs creator intelligence

Seed research MUST NOT create or update:
- `outreach_events`
- `hotel_intelligence`
- `destination_intelligence`
- reply rate
- creator activity
- creator collaboration metrics

Research about creator/influencer activity becomes `editorial_evidence` only.

Add a regression test proving seed import creates no creator intelligence events/metrics.

## Raw-data handling

Add these local paths to `.gitignore`:
- `/data/imports/raw/`
- `/data/imports/reports/`

Do not commit real source files or real-email reports.

Automated tests use synthetic invented fixtures only.

## CLI

Implement commands equivalent to:
- `npm run import:inspect -- --file <path>`
- `npm run import:stage -- --file <path>`
- `npm run import:dry-run -- --file <path>`
- `npm run import:report -- --batch <uuid>`

For legacy files allow explicit adapter selection.

Do not implement a blind `promote-all` command in Sprint 1A.

## Dry-run report

Generate both JSON and Markdown containing:
- raw/source rows
- property candidates
- contact candidates
- organization candidates
- valid/invalid/masked emails
- properties with no contact
- deterministic safe matches
- fuzzy review candidates
- unresolved destinations
- ambiguous multi-property rows
- verification distribution
- rejected and review-required rows
- transparent completeness metrics

Match candidates must explain why they matched.

## Testing

Use synthetic fixtures for at least:
- clean canonical workbook
- repeat import/idempotency
- exact property+destination match
- fuzzy name variant requiring review
- same corporate email across two hotels
- chain-domain collision that must not auto-match
- generic mailbox
- named contact
- group/operator/PR agency
- masked email
- inferred vs verified evidence
- ambiguous multi-property legacy row
- noisy legacy row
- destination unresolved
- seed evidence proving it does not seed creator intelligence

RLS tests must prove creators cannot read import/raw internals.

## Real legacy dry run

If the product owner provides the legacy files locally, run them through the isolated adapters and generate local dry-run reports.

Do not optimize architecture to improve their import percentage.

A row may be rejected if mapping it would require inventing facts.

## Definition of Done

Sprint 1A is complete only when:
- migrations `0014+` reproduce from empty DB with baseline;
- standard canonical importer works;
- legacy adapters translate into the same staging contract;
- import internals are private;
- entity resolution is conservative/explainable;
- synthetic tests pass;
- lint passes;
- typecheck passes;
- production build passes;
- actual supplied files can be dry-run locally if available;
- reports are generated locally/untracked;
- no real bulk canonical promotion occurred;
- no creator intelligence was seeded.

## Completion report

Report:
- migrations added
- schema added
- standard importer architecture
- legacy adapter architecture
- commands used
- test/build results
- real dry-run summary if source files were available
- rejected/review-required counts
- unresolved identity/geography decisions
- recommendation for Sprint 1B canonical promotion

STOP after Sprint 1A.

Do not proceed to canonical bulk promotion, map/discovery UI, payments, CRM UI, AI, email integration, community or marketplace.
