# theugc.life — Sprint 1A Review Fixes
Version: 1.0
Status: Approved corrections required before Sprint 1A merge

Sprint 1A architecture is approved in principle. The following corrections are required before opening/merging its PR.

## F1 — Organization identity must be explicit

Problem: the canonical contact record currently has `contact_scope` but no explicit organization identity. The implementation may therefore infer an organization name from `contact_name`, email, or `source_property_key`. That is not acceptable: a person is not an organization.

Required change:

- Add nullable `organization_name` to the canonical CONTACTS contract and `ContactRecord`.
- Add nullable `organization_type` only if needed by the importer; otherwise derive type conservatively from `contact_scope`.
- For `contact_scope` in `brand`, `group`, `operator`, or `agency`, research should provide `organization_name` whenever known.
- Organization candidates may be created/surfaced only from an explicit organization name or explicit structured relationship evidence. Never use `contact_name`, email address, or property key as an organization name.
- If organization identity is missing, keep the contact attached to the property staging record and flag `organization_identity_missing` for review; do not invent an organization.
- Sync `HOTEL_DATA_CONTRACT.md`, `IMPORT_SPEC.md`, and `RESEARCH_PROMPT_TEMPLATE.md` accordingly.
- Add regression tests for: named agency employee + explicit agency name; named agency employee without agency name; generic corporate email without organization identity.

## F2 — Country-aware fuzzy matching must actually be country-aware

Problem: when destination resolution fails, the current resolver can generate fuzzy candidates under a code path described as “same country”, but `ExistingHotel` does not carry `countryCode`, so hotels from unrelated countries may enter the candidate pool.

Required change:

- Add `countryCode` to `ExistingHotel` and populate it from canonical hotel data.
- If canonical destination is unresolved, fuzzy hotel candidates may be generated only when both staged property and existing hotel have the same non-null country code.
- If country is unknown, do not use global fuzzy matching.
- Fuzzy results remain review-only and never auto-merge.
- Add a regression test proving similarly named hotels in different countries are not candidates when destination is unresolved.

## F3 — Import-batch idempotency needs a database backstop

Problem: duplicate file+parser detection currently depends mainly on application logic. Two concurrent import processes should not be able to stage the same non-failed file/parser version twice.

Required change:

- Add a database-enforced idempotency guard for non-failed batches using `file_sha256 + parser_name + parser_version` (or an equivalent deterministic import identity).
- A failed batch must not permanently block a legitimate retry.
- Keep application-level duplicate detection for clear CLI UX, but the database must be the final race-condition backstop.
- Add a concurrency/idempotency regression test where practical.

## F4 — Source-row uniqueness must handle non-XLSX sources deterministically

Problem: `UNIQUE(import_batch_id, sheet_name, source_row_number)` does not prevent duplicates when `sheet_name` is NULL because PostgreSQL treats NULLs as distinct.

Required change:

- Ensure one physical source row has one deterministic uniqueness identity even for CSV/Markdown sources with no sheet.
- Preferred options: normalize non-sheet sources to a stable synthetic sheet name such as `__root__`, or use a unique expression/index over `coalesce(sheet_name, '__root__')` plus row number.
- Add a regression test for duplicate row insertion in a non-sheet source.

## Stop condition

After these fixes:

- run migrations from empty DB;
- lint;
- typecheck;
- all tests;
- production build;
- report exact changes.

Do not implement canonical promotion, destination seeding, map/discovery, CRM, payments, AI, or any Sprint 1B feature.

Once these fixes are verified, Sprint 1A may open a PR to `main` for final review.