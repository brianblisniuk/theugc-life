-- 0001_extensions_and_helpers.sql
-- Foundation: extensions and shared trigger helpers.
-- Reproducible from an empty database (DATABASE.md §13).

-- gen_random_uuid() for UUID primary keys (DATABASE.md §2).
create extension if not exists pgcrypto;
-- Case-insensitive text for username/email-like uniqueness (DATABASE.md §2).
create extension if not exists citext;

-- Shared trigger to maintain updated_at on mutable tables (DATABASE.md §2:
-- "Every mutable table has created_at and updated_at unless append-only").
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.set_updated_at() is
  'BEFORE UPDATE trigger: stamps updated_at = now().';
