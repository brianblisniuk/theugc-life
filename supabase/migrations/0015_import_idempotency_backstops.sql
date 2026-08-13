-- 0015_import_idempotency_backstops.sql
-- Sprint 1A review fixes F3 + F4 (SPRINT_1A_REVIEW_FIXES.md). Additive; the
-- baseline (0001-0013) and 0014 tables are not otherwise altered in behavior.

-- ---------------------------------------------------------------------------
-- F4: deterministic physical source-row uniqueness for non-sheet sources.
-- The original UNIQUE(import_batch_id, sheet_name, source_row_number) did not
-- prevent duplicates when sheet_name IS NULL (Postgres treats NULLs as
-- distinct). Replace it with an expression unique index that coalesces a NULL
-- sheet to a stable synthetic '__root__' so CSV/Markdown/non-sheet sources get
-- one uniqueness identity per physical row.
-- ---------------------------------------------------------------------------
alter table public.import_rows drop constraint import_rows_unique_source;

create unique index import_rows_unique_source_idx
  on public.import_rows (
    import_batch_id,
    coalesce(sheet_name, '__root__'),
    source_row_number
  );

-- ---------------------------------------------------------------------------
-- F3: database-enforced idempotency backstop for import batches.
-- Two non-failed batches must not exist for the same deterministic import
-- identity (file_sha256 + parser_name + parser_version), even under a race
-- between concurrent import processes. Failed batches are excluded so a
-- legitimate retry of a failed import is always permitted.
-- ---------------------------------------------------------------------------
create unique index import_batches_active_identity_uidx
  on public.import_batches (file_sha256, parser_name, parser_version)
  where status <> 'failed' and file_sha256 is not null;
