-- 0025_service_role_view_acl_convergence.sql
--
-- Post-deploy verification of D046 found two hosted-specific privilege states
-- that a clean local replay did not reproduce:
--
-- 1. service_role already held ALL relation privileges on
--    public.hotel_public_intelligence, while the contract requires SELECT-only.
-- 2. Supabase also stores automatic Data API default grants under the
--    supabase_admin role. 0024 revoked the defaults of the migration role
--    (postgres), but the supabase_admin defaults for anon/authenticated remained.
--
-- Neither finding created a current client data exposure: existing application
-- relations were normalized by 0024 and RLS remains enabled. The second finding
-- would, however, let FUTURE objects inherit client privileges again, defeating
-- D046's opt-in contract.
--
-- Do not rewrite deployed 0024. Normalize the hosted state in a new immutable
-- migration so production and replay converge on the declared contract.

-- Public intelligence is a read projection. service_role needs SELECT only.
revoke all privileges on table public.hotel_public_intelligence from service_role;
grant select on table public.hotel_public_intelligence to service_role;

-- Restate the postgres defaults explicitly for deterministic replay.
alter default privileges for role postgres in schema public
  revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public
  revoke all on functions from anon, authenticated, public;

-- Hosted Supabase projects may also carry platform defaults owned by
-- supabase_admin. A custom/plain test database may not have that role, so make
-- this hosted-specific normalization conditional rather than making replay
-- depend on the platform role existing.
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_admin') then
    execute 'alter default privileges for role supabase_admin in schema public revoke all on tables from anon, authenticated';
    execute 'alter default privileges for role supabase_admin in schema public revoke all on sequences from anon, authenticated';
    execute 'alter default privileges for role supabase_admin in schema public revoke all on functions from anon, authenticated, public';
  end if;
end;
$$;
