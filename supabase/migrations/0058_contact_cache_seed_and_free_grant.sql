-- 0058_contact_cache_seed_and_free_grant.sql
-- Idempotent F05 backfill (D103, D101).
-- Existing hotel_contacts become owner_import cache rows. A creator who could
-- already see a contact keeps that hotel via contact_unlocks, with a net-zero
-- ledger pair so the Free grant is not consumed. Everyone else pays the
-- configured credit and does not call a provider. Every existing user
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

-- Prior Pass, Pro, admin, editor, and destination visibility becomes an unlock.
-- The offset and the debit use the live unlock cost, so the balance does not move.
create or replace function public.grandfather_visible_contact_unlocks()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cost integer;
  v_inserted integer;
begin
  select unlock_cost into v_cost from public.credit_config where id;
  if v_cost is null then
    raise exception 'credit config missing' using errcode = '55000';
  end if;

  insert into public.credit_ledger (user_id, delta, reason, ref_id, idempotency_key)
  select pairs.user_id,
         v_cost,
         'plan_grant',
         pairs.hotel_id::text,
         'grandfather_offset:' || pairs.hotel_id::text
  from (
    select distinct u.id as user_id, hc.hotel_id
    from public.users u
    join public.hotel_contacts hc
      on hc.status is distinct from 'replaced'
    where public._has_premium_hotel_access(u.id, hc.hotel_id)
      and not exists (
        select 1
        from public.contact_unlocks owned
        where owned.user_id = u.id
          and owned.hotel_id = hc.hotel_id
      )
  ) pairs
  on conflict (user_id, idempotency_key) do nothing;

  insert into public.credit_ledger (user_id, delta, reason, ref_id, idempotency_key)
  select pairs.user_id,
         -v_cost,
         'unlock',
         pairs.hotel_id::text,
         'grandfather:' || pairs.hotel_id::text
  from (
    select distinct u.id as user_id, hc.hotel_id
    from public.users u
    join public.hotel_contacts hc
      on hc.status is distinct from 'replaced'
    where public._has_premium_hotel_access(u.id, hc.hotel_id)
      and not exists (
        select 1
        from public.contact_unlocks owned
        where owned.user_id = u.id
          and owned.hotel_id = hc.hotel_id
      )
  ) pairs
  on conflict (user_id, idempotency_key) do nothing;

  insert into public.contact_unlocks (user_id, hotel_id, ledger_id)
  select l.user_id, l.ref_id::uuid, l.id
  from public.credit_ledger l
  where l.reason = 'unlock'
    and l.idempotency_key = 'grandfather:' || l.ref_id
  on conflict (user_id, hotel_id) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

comment on function public.grandfather_visible_contact_unlocks() is
  'One unlock per hotel each existing user could already see. Net-zero plan_grant plus unlock. A second run inserts nothing.';

revoke all on function public.grandfather_visible_contact_unlocks() from public, anon, authenticated, service_role;
grant execute on function public.grandfather_visible_contact_unlocks() to service_role;

select public.grandfather_visible_contact_unlocks();
