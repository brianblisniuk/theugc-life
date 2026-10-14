-- 0076_credit_grant_periods.sql
-- P01 grant periods (D132, D133, D134).
--
-- Free: one weekly grant per rolling 7-day period from users.created_at.
-- The key is free_weekly:{period}. A second call in the same period inserts
-- nothing. Unused weekly credits are expired when the next period starts, so
-- they do not stack past free_weekly_credits. Durable credits (free_grant:v1,
-- plan_grant, pack_purchase, admin_grant, courtesy) are not expired.
-- Missed weeks are not backfilled.
--
-- Pro and Max: one monthly grant per active entitlement period, counted from
-- that row's starts_at. Max wins when both are active. Unused paid credits
-- are not expired. An active Pro or Max pauses new weekly grants. A
-- Destination Pass does not. Credits already on the ledger stay.
--
-- This migration defines functions. It does not write a ledger row.

create or replace function public.ensure_credit_grants(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_weekly integer;
  v_days integer;
  v_pro_amount integer;
  v_max_amount integer;
  v_anchor timestamptz;
  v_period integer;
  v_ent_id uuid;
  v_ent_type text;
  v_ent_starts timestamptz;
  v_amount integer;
  v_monthly_period integer;
  v_key text;
  r record;
  v_weekly_left integer := 0;
  v_expire integer;
begin
  if p_user_id is null then
    return;
  end if;

  if not exists (select 1 from public.users u where u.id = p_user_id) then
    return;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('theugc.credit_grant'),
    pg_catalog.hashtext(p_user_id::text)
  );

  select free_weekly_credits, free_weekly_period_days, pro_monthly_credits, max_monthly_credits
    into v_weekly, v_days, v_pro_amount, v_max_amount
  from public.credit_config
  where id;

  if v_weekly is null or v_days is null or v_pro_amount is null or v_max_amount is null then
    raise exception 'credit config missing' using errcode = '55000';
  end if;

  -- One monthly grant. Max wins over Pro. A Pass does not grant plan credits.
  select e.id, e.access_type, e.starts_at
    into v_ent_id, v_ent_type, v_ent_starts
  from public.access_entitlements e
  where e.user_id = p_user_id
    and e.access_type in ('pro', 'max')
    and e.status = 'active'
    and e.starts_at <= pg_catalog.now()
    and (e.expires_at is null or e.expires_at > pg_catalog.now())
  order by case e.access_type when 'max' then 0 else 1 end, e.starts_at desc
  limit 1;

  if v_ent_id is not null then
    v_amount := case when v_ent_type = 'max' then v_max_amount else v_pro_amount end;
    v_monthly_period := floor(
      extract(year from age(pg_catalog.now(), v_ent_starts)) * 12
      + extract(month from age(pg_catalog.now(), v_ent_starts))
    )::integer;
    if v_monthly_period < 0 then
      v_monthly_period := 0;
    end if;
    if v_amount > 0 then
      v_key := 'plan_monthly:' || v_ent_type || ':' || v_ent_id::text || ':' || v_monthly_period::text;
      insert into public.credit_ledger (user_id, delta, reason, ref_id, idempotency_key)
      values (p_user_id, v_amount, 'plan_grant', v_ent_id::text, v_key)
      on conflict (user_id, idempotency_key) do nothing;
    end if;
    -- Paid plans pause new weekly grants. Credits already granted stay.
    return;
  end if;

  select u.created_at into v_anchor from public.users u where u.id = p_user_id;
  v_period := floor(
    extract(epoch from (pg_catalog.now() - v_anchor)) / (v_days * 86400.0)
  )::integer;
  if v_period < 0 then
    v_period := 0;
  end if;

  v_key := 'free_weekly:' || v_period::text;
  if exists (
    select 1
    from public.credit_ledger l
    where l.user_id = p_user_id
      and l.idempotency_key = v_key
  ) then
    return;
  end if;

  if v_weekly = 0 then
    return;
  end if;

  -- Spend weekly credits first. A positive row that is not a weekly grant is durable.
  for r in
    select delta, idempotency_key
    from public.credit_ledger
    where user_id = p_user_id
    order by created_at, id
  loop
    if r.idempotency_key like 'free_weekly:%' and r.delta > 0 then
      v_weekly_left := v_weekly_left + r.delta;
    elsif r.delta < 0 then
      v_weekly_left := v_weekly_left + r.delta;
      if v_weekly_left < 0 then
        v_weekly_left := 0;
      end if;
    end if;
  end loop;

  v_expire := v_weekly_left;
  if v_expire > 0 then
    insert into public.credit_ledger (user_id, delta, reason, idempotency_key)
    values (p_user_id, -v_expire, 'reversal', 'free_weekly_expire:' || v_period::text)
    on conflict (user_id, idempotency_key) do nothing;
  end if;

  insert into public.credit_ledger (user_id, delta, reason, idempotency_key)
  values (p_user_id, v_weekly, 'free_grant', v_key)
  on conflict (user_id, idempotency_key) do nothing;
end;
$$;

comment on function public.ensure_credit_grants(uuid) is
  'Idempotent Free weekly grant and Pro/Max monthly grant. Does not reduce durable credits. Not client-callable.';

create or replace function public.grant_free_credits(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.ensure_credit_grants(p_user_id);
end;
$$;

comment on function public.grant_free_credits(uuid) is
  'Signup entry for ensure_credit_grants. The current Free week only. Not client-callable.';

create or replace function public.ensure_own_credit_grants()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  perform public.ensure_credit_grants(v_caller);
  return public.credit_balance(v_caller);
end;
$$;

comment on function public.ensure_own_credit_grants() is
  'Refreshes the signed-in user''s grants and returns that user''s balance. Cannot name another user.';

create or replace function public.own_plan_features()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
  v_max boolean;
  v_pro boolean;
  v_pass boolean;
  v_tier text;
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  v_max := public._has_active_max(v_caller);
  v_pro := exists (
    select 1
    from public.access_entitlements e
    where e.user_id = v_caller
      and e.access_type = 'pro'
      and e.status = 'active'
      and e.starts_at <= pg_catalog.now()
      and (e.expires_at is null or e.expires_at > pg_catalog.now())
  );
  v_pass := exists (
    select 1
    from public.access_entitlements e
    where e.user_id = v_caller
      and e.access_type = 'destination'
      and e.status = 'active'
      and e.starts_at <= pg_catalog.now()
      and (e.expires_at is null or e.expires_at > pg_catalog.now())
  );
  v_tier := case
    when v_max then 'max'
    when v_pro then 'pro'
    else 'free'
  end;

  return jsonb_build_object(
    'tier', v_tier,
    'full_ai_email', v_max or v_pro,
    'outreach_assisted', v_max or v_pro or v_pass,
    'premium_intelligence_worldwide', v_max or v_pro,
    'unlimited_crm', v_max or v_pro,
    'priority_ai', v_max,
    'advanced_signals', v_max,
    'priority_support', v_max,
    'future_premium', v_max,
    'packs_allowed', true
  );
end;
$$;

comment on function public.own_plan_features() is
  'Plan flags for auth.uid() only. Full AI is a flag, not a model call. Max flags do not change ranking. A purchase is not a flag.';

-- Unlock refreshes grants before it reads the balance. The rest is D108.
create or replace function public.unlock_hotel_contact(
  p_hotel_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  -- D042. tests/credits/config.test.ts fails if this drifts from FREE_LIMITS.savedHotels.
  v_free_saved_hotels constant integer := 10;
  v_cost integer;
  v_charge boolean;
  v_ttl integer;
  v_balance integer;
  v_cache public.contact_cache%rowtype;
  v_has_cache boolean;
  v_servable boolean;
  v_ledger_id uuid;
  v_email text;
  v_save jsonb;
  v_preview text;
  v_pipeline_added boolean := false;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_hotel_id is null
     or p_idempotency_key is null
     or char_length(btrim(p_idempotency_key)) < 1
     or char_length(p_idempotency_key) > 200 then
    raise exception 'hotel and idempotency key are required' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('theugc.credit_unlock'),
    pg_catalog.hashtext(v_uid::text)
  );

  perform public.ensure_credit_grants(v_uid);

  if not exists (select 1 from public.hotels h where h.id = p_hotel_id) then
    return jsonb_build_object('status', 'hotel_missing', 'email', null, 'pipeline_added', false);
  end if;

  select unlock_cost, charge_on_not_found, cache_ttl_days
    into v_cost, v_charge, v_ttl
  from public.credit_config
  where id;

  if v_cost is null or v_ttl is null or v_charge is null then
    raise exception 'credit config missing' using errcode = '55000';
  end if;

  -- cache_ttl_days stays required config. It does not expire a stored address.
  select * into v_cache from public.contact_cache where hotel_id = p_hotel_id;
  v_has_cache := found;
  v_servable := v_has_cache
    and v_cache.status = 'found'
    and not v_cache.reported_invalid
    and nullif(btrim(coalesce(v_cache.email, '')), '') is not null;

  if exists (
    select 1 from public.contact_unlocks u
    where u.user_id = v_uid and u.hotel_id = p_hotel_id
  ) then
    if v_servable and not exists (
      select 1
        from public.pipeline_items pi
        join public.creator_profiles cp on cp.id = pi.creator_id
       where cp.user_id = v_uid
         and pi.hotel_id = p_hotel_id
    ) then
      v_save := public.save_hotel_to_pipeline(v_uid, p_hotel_id, v_free_saved_hotels);
      v_pipeline_added := v_save->>'result' = 'created';
    end if;
    if v_servable then
      return jsonb_build_object(
        'status', 'already_unlocked',
        'email', v_cache.email,
        'balance', public.credit_balance(v_uid),
        'pipeline_added', v_pipeline_added
      );
    end if;
    return jsonb_build_object(
      'status', 'already_unlocked',
      'email', null,
      'balance', public.credit_balance(v_uid),
      'pipeline_added', false
    );
  end if;

  if exists (
    select 1 from public.credit_ledger l
    where l.user_id = v_uid and l.idempotency_key = p_idempotency_key
  ) then
    return jsonb_build_object('status', 'idempotent_replay', 'email', null, 'pipeline_added', false);
  end if;

  v_preview := null;
  begin
    v_save := public.save_hotel_to_pipeline(v_uid, p_hotel_id, v_free_saved_hotels);
    v_preview := v_save->>'result';
    if v_preview = 'created' then
      raise exception 'unlock pipeline preview' using errcode = 'P0001';
    end if;
  exception
    when sqlstate 'P0001' then
      v_preview := 'would_create';
  end;

  if v_preview = 'limit_reached' then
    return jsonb_build_object(
      'status', 'pipeline_limit',
      'email', null,
      'balance', public.credit_balance(v_uid),
      'pipeline_added', false,
      'limit', v_free_saved_hotels
    );
  end if;

  if v_preview is null or v_preview not in ('would_create', 'already_saved') then
    return jsonb_build_object('status', 'error', 'email', null, 'pipeline_added', false);
  end if;

  if not v_has_cache then
    return jsonb_build_object(
      'status', 'needs_provider',
      'email', null,
      'balance', public.credit_balance(v_uid),
      'pipeline_added', false
    );
  end if;

  if v_cache.status = 'invalid' or v_cache.reported_invalid then
    return jsonb_build_object(
      'status', 'not_found',
      'email', null,
      'balance', public.credit_balance(v_uid),
      'pipeline_added', false
    );
  end if;

  if v_cache.status = 'not_found' and not v_charge then
    return jsonb_build_object(
      'status', 'not_found',
      'email', null,
      'balance', public.credit_balance(v_uid),
      'pipeline_added', false
    );
  end if;

  if v_cache.status = 'found' and not v_servable then
    return jsonb_build_object(
      'status', 'needs_provider',
      'email', null,
      'pipeline_added', false
    );
  end if;

  v_balance := public.credit_balance(v_uid);
  if v_balance < v_cost then
    return jsonb_build_object(
      'status', 'insufficient_credits',
      'email', null,
      'balance', v_balance,
      'pipeline_added', false
    );
  end if;

  if v_servable then
    v_save := public.save_hotel_to_pipeline(v_uid, p_hotel_id, v_free_saved_hotels);
    v_preview := v_save->>'result';
    if v_preview = 'limit_reached' then
      return jsonb_build_object(
        'status', 'pipeline_limit',
        'email', null,
        'balance', v_balance,
        'pipeline_added', false,
        'limit', v_free_saved_hotels
      );
    end if;
    if v_preview is null or v_preview not in ('created', 'already_saved') then
      return jsonb_build_object('status', 'error', 'email', null, 'pipeline_added', false);
    end if;
    v_pipeline_added := v_preview = 'created';
  end if;

  insert into public.credit_ledger (user_id, delta, reason, ref_id, idempotency_key)
  values (v_uid, -v_cost, 'unlock', p_hotel_id::text, p_idempotency_key)
  returning id into v_ledger_id;

  insert into public.contact_unlocks (user_id, hotel_id, ledger_id)
  values (v_uid, p_hotel_id, v_ledger_id);

  update public.contact_cache
     set first_unlocked_at = coalesce(first_unlocked_at, pg_catalog.now())
   where hotel_id = p_hotel_id
     and first_unlocked_at is null;

  v_email := case when v_cache.status = 'found' then v_cache.email else null end;

  return jsonb_build_object(
    'status', case when v_email is null then 'not_found' else 'unlocked' end,
    'email', v_email,
    'balance', v_balance - v_cost,
    'pipeline_added', case when v_email is null then false else v_pipeline_added end
  );
end;
$$;

comment on function public.unlock_hotel_contact(uuid, text) is
  'Atomic per-user unlock. Refreshes that user''s credit grants first. A revealed email also saves the hotel on the caller pipeline, or refuses with no debit when the Free allowance is full (D108).';

revoke all on function public.unlock_hotel_contact(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.unlock_hotel_contact(uuid, text) to authenticated, service_role;

revoke all on function public.ensure_credit_grants(uuid) from public, anon, authenticated, service_role;
grant execute on function public.ensure_credit_grants(uuid) to service_role;

revoke all on function public.grant_free_credits(uuid) from public, anon, authenticated, service_role;

revoke all on function public.ensure_own_credit_grants() from public, anon, authenticated, service_role;
grant execute on function public.ensure_own_credit_grants() to authenticated, service_role;

revoke all on function public.own_plan_features() from public, anon, authenticated, service_role;
grant execute on function public.own_plan_features() to authenticated, service_role;
