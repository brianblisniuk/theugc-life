# Sprint 1C — Parser Review Fix

Status: Approved blocking correction before merging the Sprint 1C parser robustness change.

## Scope

Do not change the dataset, review decisions, promotion plan, canonical schema, or import architecture. This is only a defensive hardening of `loadXlsxWorkbook` introduced in commit `5340b8e`.

## P1 — Never turn an unreadable workbook into an empty workbook

The normal ExcelJS read currently catches any error and falls through to normalization. If normalization makes no changes, the function can return the original empty workbook and silently convert a real parser failure into an apparent zero-sheet workbook.

Required behavior:

- preserve the original ExcelJS error;
- if fallback normalization has nothing relevant to change, rethrow the original error (or a new error that retains the original cause);
- if the normalized workbook still has zero worksheets, throw;
- if JSZip/normalization/reload itself fails, throw a clear parse error; never return an empty workbook as success.

A malformed/corrupt XLSX must fail loudly.

## P2 — Namespace rewriting must be scoped

Do not globally rewrite every `<x:...>` element in every XML part merely because the fallback path ran.

Only strip the `x:` element prefix in an XML part when that part actually declares:

`xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`

Table-definition cleanup may remain separately scoped to the known OOXML table relationships/content-types used by the importer fallback.

Do not alter unrelated `x:` namespaces.

## P3 — Regression tests

Add synthetic tests proving:

1. the namespace-prefixed/table-definition workbook still parses with identical cell values;
2. a normal ExcelJS-readable workbook still uses the normal path and parses unchanged;
3. a valid ZIP/XLSX-shaped package that cannot be parsed and has no applicable normalization does not silently return zero sheets — it throws;
4. an unrelated XML part using an `x:` prefix bound to a different namespace is not rewritten/corrupted by the fallback.

No real pilot data in tests.

## Verification

Run lint, typecheck, full tests, production build, and format. Commit/push only this hardening and tests. Do not run real-data `--apply`. Stop for external review.
