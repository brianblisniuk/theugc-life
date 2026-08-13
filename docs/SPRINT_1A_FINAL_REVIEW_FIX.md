# theugc.life — Sprint 1A Final Review Fix

Status: Approved final review correction before Sprint 1A PR/merge.
Scope: one persistence/reporting integrity fix only.

## F5 — Preserve explicit organization identity across DB round-trip

The F1 in-memory resolution is correct: organization candidates are derived only from explicit `organization_name`.

However, the persisted/reloaded representation currently loses that identity:

- `persistResolution()` writes an organization `import_match_candidates` row with `candidate_entity_id = null`, `match_method = org_scope:*`, and `review_note` containing only inferred type/reason.
- `getBatchReportInput()` then reconstructs `organizationCandidates[].name` from `review_note`, so the original explicit `organization_name` is not preserved in the regenerated report.

This is incorrect. A dry-run report regenerated from the database must be semantically equivalent to the report produced immediately after staging/resolution, including the exact explicit organization identity.

### Required behavior

1. Preserve/reconstruct the exact normalized `ContactRecord.organizationName` when rebuilding organization candidates from persisted import data.
2. Do not infer the organization name from `review_note`, contact person, email, or property key.
3. Keep the current schema minimal unless a new column is genuinely necessary. Preferred implementation: because the organization candidate is tied to the contact `import_row_id` and that row already preserves `normalized_data.organizationName`, reconstruct from the persisted contact row rather than duplicating identity in free-text `review_note`.
4. `review_note` remains explanation only, not identity storage.
5. Include `organizationName` in the JSON contact-candidate/report output where useful for review transparency.

### Regression test required

Add a DB/pipeline round-trip test that:

- stages a synthetic property + agency-scoped contact;
- sets explicit `organization_name = "Example PR Agency"`;
- persists resolution;
- reloads the batch using `getBatchReportInput()` / report regeneration;
- asserts exactly one organization candidate exists;
- asserts its name is exactly `Example PR Agency`;
- asserts the name is NOT the person name, email, property key, inferred type, or review-note text.

The test should also establish that the immediate in-memory and persisted/reloaded organization candidate identity agree.

## Verification

After the fix run:

- migrations from empty DB
- lint
- typecheck
- full test suite
- production build

Do not implement any other product/import behavior.
Do not implement canonical promotion.
Do not start Sprint 1B.
Do not open a PR automatically.

Stop and report the final commit for review.
