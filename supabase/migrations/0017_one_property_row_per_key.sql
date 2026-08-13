-- 0017_one_property_row_per_key.sql
-- Sprint 1B review fix F2: a canonical promotion bundle requires exactly one
-- structurally usable property row. Enforce, at the database level, that a
-- single import batch can never contain more than one `property` row sharing a
-- non-null source_property_key. This is the backstop behind the reviewable-
-- bundle definition used by review/promotion (a duplicate property key would
-- otherwise make "the property row for this key" ambiguous).
--
-- Additive only; migrations 0001–0016 are frozen baseline.

create unique index import_rows_one_property_per_key_uidx
  on public.import_rows (import_batch_id, source_property_key)
  where row_kind = 'property' and source_property_key is not null;
