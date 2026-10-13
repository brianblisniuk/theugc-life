-- 0058_contact_cache_seed_and_free_grant.sql
-- Idempotent F05 backfill (D103, D101).
-- Existing hotel_contacts become owner_import cache rows. Unlocking them costs
-- the configured credit and does not call a provider. Every existing user
-- receives the Free grant once. Signup does the same after this migration.

insert into public.credit_config (
  free_credits,
  pro_monthly_credits,
  pro_plus_monthly_credits,
  unlock_cost,
  charge_on_not_found,
  cache_ttl_days,
  pack_sizes
) values (
  15,
  50,
  150,
  1,
  false,
  365,
  array[10, 25, 50]::integer[]
)
on conflict (id) do nothing;

create or replace function public.seed_imported_contact_cache()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  with picked as (
    select distinct on (hc.hotel_id)
      hc.hotel_id,
      btrim(hc.email) as email,
      coalesce(hc.verified_at, hc.last_checked_at, hc.created_at, pg_catalog.now()) as seen_at
    from public.hotel_contacts hc
    where hc.email is not null
      and char_length(btrim(hc.email)) > 0
      and hc.status not in ('invalid', 'replaced')
      and hc.verification_status is distinct from 'invalid'
    order by hc.hotel_id,
      case hc.verification_status
        when 'verified' then 0
        when 'probable' then 1
        when 'inferred' then 2
        else 3
      end,
      hc.created_at
  ),
  inserted as (
    insert into public.contact_cache (hotel_id, email, source, status, last_verified_at)
    select picked.hotel_id, picked.email, 'owner_import', 'found', picked.seen_at
    from picked
    on conflict (hotel_id) do nothing
    returning 1
  )
  select count(*)::integer into v_count from inserted;
  return coalesce(v_count, 0);
end;
$$;

comment on function public.seed_imported_contact_cache() is
  'Copy existing hotel contact emails into contact_cache as owner_import. A second run does not overwrite a row.';

revoke all on function public.seed_imported_contact_cache() from public, anon, authenticated, service_role;
grant execute on function public.seed_imported_contact_cache() to service_role;

select public.seed_imported_contact_cache();

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

  perform public.grant_free_credits(new.id);

  return new;
end;
$$;

comment on function public.handle_new_user() is
  'AFTER INSERT on auth.users: provisions public.users (role=creator) + creator_profiles, then one Free credit grant. Role is never client-supplied.';

-- Users who already exist do not pass through the signup trigger again.
do $$
declare
  v_user uuid;
begin
  for v_user in select id from public.users loop
    perform public.grant_free_credits(v_user);
  end loop;
end;
$$;
