-- GoTrue inserts into auth.users as supabase_auth_admin.
-- 0018 revoked EXECUTE on handle_new_user() from PUBLIC, so that role
-- can no longer fire the signup trigger. The test harness connects as a
-- superuser and does not see the denial. The local Supabase role is not a
-- superuser. Grant schema visibility and the trigger function back to that
-- role only. Table privileges stay revoked.
-- The plain Postgres test database has no supabase_auth_admin role.

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant usage on schema public to supabase_auth_admin;
    grant execute on function public.handle_new_user() to supabase_auth_admin;
  end if;
end
$$;
