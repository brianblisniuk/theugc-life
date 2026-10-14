-- 0075_plan_tier_and_pricing.sql
-- P01 plans and pricing (D131, D133, D134).
--
-- Adds the Max tier and stores the owner's prices and credit amounts.
-- This file does not insert, update, or delete a credit_ledger row.
-- A price column is not an entitlement. Rebill is not called.

-- ---------------------------------------------------------------------------
-- Max is a worldwide plan with the same shape as Pro: no destination.
-- ---------------------------------------------------------------------------

alter table public.access_entitlements
  drop constraint access_entitlements_access_type_check;

alter table public.access_entitlements
  add constraint access_entitlements_access_type_check
  check (access_type in ('free', 'destination', 'pro', 'max', 'admin'));

alter table public.access_entitlements
  drop constraint access_entitlements_destination_shape;

alter table public.access_entitlements
  add constraint access_entitlements_destination_shape check (
    (access_type = 'destination' and destination_id is not null)
    or (access_type in ('pro', 'max', 'admin') and destination_id is null)
    or (access_type = 'free')
  );

comment on column public.access_entitlements.access_type is
  'free, destination (Pass), pro, max, or admin. Max replaced Pro+ (D131). A row is access. A payment is not.';

-- ---------------------------------------------------------------------------
-- Pricing and the live credit amounts. free_credits stays the legacy total.
-- ---------------------------------------------------------------------------

alter table public.credit_config
  add column free_weekly_credits integer not null default 5 check (free_weekly_credits >= 0),
  add column free_weekly_period_days integer not null default 7 check (free_weekly_period_days > 0),
  add column max_monthly_credits integer not null default 500 check (max_monthly_credits >= 0),
  add column pro_price_annual_per_month_usd integer not null default 20 check (pro_price_annual_per_month_usd > 0),
  add column pro_price_monthly_usd integer not null default 30 check (pro_price_monthly_usd > 0),
  add column max_price_annual_per_month_usd integer not null default 50 check (max_price_annual_per_month_usd > 0),
  add column max_price_monthly_usd integer not null default 60 check (max_price_monthly_usd > 0),
  add column pack_price_usd integer[] not null default array[10, 20, 40]::integer[];

comment on column public.credit_config.free_credits is
  'Legacy one-time Free amount already granted as free_grant:v1. D132 does not grant it again and does not reverse it.';

comment on column public.credit_config.free_weekly_credits is
  'Free credits per rolling week from the account created_at. Unused weekly credits do not stack past this number (D132).';

comment on column public.credit_config.pro_plus_monthly_credits is
  'Unread. Max replaced Pro+ (D131). Grants read max_monthly_credits.';

comment on column public.credit_config.pro_price_annual_per_month_usd is
  'Pro price per month when billed annually. Config only. Not a charge (D134).';

comment on column public.credit_config.pack_price_usd is
  'USD whole dollars, same order as pack_sizes. Config only. Not a charge.';

create or replace function public.credit_config_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_size integer;
  v_price integer;
begin
  if new.pack_sizes is null or pg_catalog.cardinality(new.pack_sizes) < 1 then
    raise exception 'credit pack sizes are required' using errcode = '23514';
  end if;
  if new.pack_price_usd is null
     or pg_catalog.cardinality(new.pack_price_usd) is distinct from pg_catalog.cardinality(new.pack_sizes) then
    raise exception 'credit pack prices must match pack sizes' using errcode = '23514';
  end if;
  foreach v_size in array new.pack_sizes loop
    if v_size is null or v_size <= 0 then
      raise exception 'credit pack sizes must be positive' using errcode = '23514';
    end if;
  end loop;
  foreach v_price in array new.pack_price_usd loop
    if v_price is null or v_price <= 0 then
      raise exception 'credit pack prices must be positive' using errcode = '23514';
    end if;
  end loop;
  return new;
end;
$$;

update public.credit_config
   set free_weekly_credits = 5,
       free_weekly_period_days = 7,
       pro_monthly_credits = 150,
       max_monthly_credits = 500,
       pro_plus_monthly_credits = 500,
       pack_sizes = array[50, 150, 500]::integer[],
       pack_price_usd = array[10, 20, 40]::integer[],
       pro_price_annual_per_month_usd = 20,
       pro_price_monthly_usd = 30,
       max_price_annual_per_month_usd = 50,
       max_price_monthly_usd = 60
 where id;

comment on table public.credit_config is
  'Singleton credit and price policy (D131). The grant and unlock functions read this row. A price is not an entitlement.';

-- ---------------------------------------------------------------------------
-- Max has every worldwide Pro capability. The function name stays historical.
-- Admin stays included. A Destination Pass does not.
-- ---------------------------------------------------------------------------

create or replace function public._has_active_pro(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.access_entitlements e
    where e.user_id = uid
      and e.access_type in ('pro', 'max', 'admin')
      and e.status = 'active'
      and e.starts_at <= now()
      and (e.expires_at is null or e.expires_at > now())
  );
$$;

comment on function public._has_active_pro(uuid) is
  'Active Pro, Max, or admin. Max is worldwide paid (D133). Not granted to authenticated. A purchase is not this row.';

create or replace function public._has_active_max(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.access_entitlements e
    where e.user_id = uid
      and e.access_type = 'max'
      and e.status = 'active'
      and e.starts_at <= pg_catalog.now()
      and (e.expires_at is null or e.expires_at > pg_catalog.now())
  );
$$;

comment on function public._has_active_max(uuid) is
  'Active Max entitlement for an arbitrary user. Not client-callable.';

create or replace function public.has_active_max()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select public._has_active_max(auth.uid());
$$;

comment on function public.has_active_max() is
  'True only when auth.uid() has an active Max entitlement. Another user''s row does not count.';

revoke all on function public._has_active_max(uuid) from public, anon, authenticated, service_role;
grant execute on function public._has_active_max(uuid) to service_role;

revoke all on function public.has_active_max() from public, anon, authenticated, service_role;
grant execute on function public.has_active_max() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Trusted grant accepts Max. Still service_role only. Still not a payment.
-- ---------------------------------------------------------------------------

create or replace function public.grant_access_entitlement(
  p_user_id uuid,
  p_access_type text,
  p_destination_id uuid,
  p_source text,
  p_source_reference text,
  p_starts_at timestamptz,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_existing public.access_entitlements%rowtype;
begin
  if p_user_id is null or p_access_type is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  if p_source is null or btrim(p_source) = '' then
    return jsonb_build_object('result', 'source_required');
  end if;

  if p_access_type not in ('destination', 'pro', 'max') then
    return jsonb_build_object('result', 'invalid_access_type');
  end if;

  if p_access_type = 'destination' and p_destination_id is null then
    return jsonb_build_object('result', 'destination_required');
  end if;

  if p_access_type in ('pro', 'max') and p_destination_id is not null then
    return jsonb_build_object(
      'result',
      case
        when p_access_type = 'pro' then 'pro_cannot_have_destination'
        else 'plan_cannot_have_destination'
      end
    );
  end if;

  insert into public.access_entitlements (
    user_id, access_type, destination_id, source, source_reference,
    starts_at, expires_at, status
  ) values (
    p_user_id, p_access_type, p_destination_id, p_source, p_source_reference,
    coalesce(p_starts_at, now()), p_expires_at, 'active'
  )
  on conflict (source, source_reference) where source_reference is not null
  do nothing
  returning id into v_id;

  if v_id is not null then
    return jsonb_build_object('result', 'granted', 'entitlement_id', v_id);
  end if;

  select * into v_existing
    from public.access_entitlements
   where source = p_source
     and source_reference = p_source_reference;

  if not found then
    return jsonb_build_object('result', 'error');
  end if;

  if v_existing.user_id = p_user_id
     and v_existing.access_type = p_access_type
     and v_existing.destination_id is not distinct from p_destination_id then
    return jsonb_build_object('result', 'already_granted', 'entitlement_id', v_existing.id);
  end if;

  return jsonb_build_object('result', 'source_reference_conflict');
end;
$$;

revoke all on function public.grant_access_entitlement(uuid, text, uuid, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;

grant execute on function public.grant_access_entitlement(uuid, text, uuid, text, text, timestamptz, timestamptz)
  to service_role;
