-- 0011_auth_signup_trigger.sql
-- Safely provision an application user + creator profile from the authenticated
-- identity (PRD Sprint 0 "creation of application user/creator profile safely
-- from authenticated identity"; DATABASE.md §3).
--
-- The role is hard-set to 'creator' here and is NOT taken from any client input,
-- so a signing-up client can never assign itself a privileged role.

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.users (id, email, role, status)
  values (new.id, new.email, 'creator', 'active')
  on conflict (id) do nothing;

  insert into public.creator_profiles (user_id)
  values (new.id)
  on conflict (user_id) do nothing;

  return new;
end;
$$;

comment on function public.handle_new_user() is
  'AFTER INSERT on auth.users: provisions public.users (role=creator) + creator_profiles. Role is never client-supplied.';

-- Attach to Supabase auth.users. (The local test harness creates a compatible
-- auth.users table so this trigger is exercised identically off-platform.)
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
