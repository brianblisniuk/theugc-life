-- tests/db/bootstrap.sql
-- Supabase-compatibility shim for running the production migrations against a
-- vanilla PostgreSQL instance (local dev + CI). It reproduces ONLY the platform
-- primitives the migrations depend on:
--   * roles: anon, authenticated, service_role
--   * schema auth + auth.users
--   * auth.uid() / auth.role() reading the request.jwt.claims GUC
--
-- This file is TEST-ONLY. It is never applied to a real Supabase project (which
-- already provides all of the above), so the migrations stay production-accurate.

-- Roles ---------------------------------------------------------------------
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end
$$;

-- Allow the connecting (super)user to SET ROLE into these for impersonation.
grant anon, authenticated, service_role to current_user;

-- Auth schema + minimal auth.users -----------------------------------------
create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text,
  created_at timestamptz not null default now()
);

-- auth.uid(): current user's UUID from the JWT claims GUC (matches Supabase).
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid;
$$;

-- auth.role(): current user's role claim (matches Supabase).
create or replace function auth.role()
returns text
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '')::text;
$$;
