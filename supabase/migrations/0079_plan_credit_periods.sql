-- 0079_plan_credit_periods.sql
-- P02 credit windows (D135). Supersedes the calendar-month Pro/Max period in
-- 0076 and the sentence in D132 that left unused Pro/Max credits unexpired.
--
-- A plan credit period is 30 days from the entitlement starts_at. Missed
-- periods are not backfilled. Unused plan credits are reversed when the next
-- period opens, and when the plan is no longer active. Packs, admin grants,
-- courtesy, and free_grant:v1 are not reversed by a period change.
--
-- Spends reduce plan credits first, then weekly credits, then durable credits.
-- An active Pro or Max still pauses new weekly grants. A lapsed Rebill window
-- (source rebill, expires_at in the past) becomes expired here and weekly
-- grants resume. A manual entitlement with no expires_at stays active.

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
  v_window_id bigint;
  v_amount integer;
  v_key text;
  v_plan_left integer := 0;
  v_weekly_left integer := 0;
  v_take integer;
  v_rest integer;
  v_last_plan text;
  r record;
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

  update public.access_entitlements e
     set status = 'expired'
   where e.user_id = p_user_id
     and e.access_type in ('pro', 'max')
     and e.status = 'active'
     and e.source = 'rebill'
     and e.expires_at is not null
     and e.expires_at <= pg_catalog.now();

  update public.subscriptions s
     set status = 'expired',
         ended_at = coalesce(s.ended_at, pg_catalog.now())
   where s.user_id = p_user_id
     and s.provider = 'rebill'
     and s.status in ('active', 'past_due')
     and s.renews_at is not null
     and s.renews_at <= pg_catalog.now();

  select free_weekly_credits, free_weekly_period_days, pro_monthly_credits, max_monthly_credits
    into v_weekly, v_days, v_pro_amount, v_max_amount
  from public.credit_config
  where id;

  if v_weekly is null or v_days is null or v_pro_amount is null or v_max_amount is null then
    raise exception 'credit config missing' using errcode = '55000';
  end if;

  for r in
    select delta, idempotency_key
      from public.credit_ledger
     where user_id = p_user_id
     order by created_at, id
  loop
    if r.delta > 0 and r.idempotency_key like 'plan_monthly:%' then
      v_plan_left := v_plan_left + r.delta;
    elsif r.delta > 0 and r.idempotency_key like 'free_weekly:%' then
      v_weekly_left := v_weekly_left + r.delta;
    elsif r.delta < 0 then
      v_take := least(v_plan_left, -r.delta);
      v_plan_left := v_plan_left - v_take;
      v_rest := -r.delta - v_take;
      v_take := least(v_weekly_left, v_rest);
      v_weekly_left := v_weekly_left - v_take;
    end if;
  end loop;

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
    v_period := floor(
      extract(epoch from (pg_catalog.now() - v_ent_starts)) / (30 * 86400.0)
    )::integer;
    if v_period < 0 then
      v_period := 0;
    end if;
    -- The start instant is part of the key. A lapsed window that a later
    -- payment reopens has a new starts_at, so period 0 can be granted again.
    v_window_id := floor(extract(epoch from v_ent_starts))::bigint;
    v_key := 'plan_monthly:' || v_ent_id::text || ':' || v_window_id::text || ':' || v_period::text;
    if not exists (
      select 1
        from public.credit_ledger l
       where l.user_id = p_user_id
         and l.idempotency_key = v_key
    ) then
      if v_plan_left > 0 then
        insert into public.credit_ledger (user_id, delta, reason, idempotency_key)
        values (
          p_user_id, -v_plan_left, 'reversal',
          'plan_expire:' || v_ent_id::text || ':' || v_window_id::text || ':' || v_period::text
        )
        on conflict (user_id, idempotency_key) do nothing;
      end if;
      if v_amount > 0 then
        insert into public.credit_ledger (user_id, delta, reason, ref_id, idempotency_key)
        values (p_user_id, v_amount, 'plan_grant', v_ent_id::text, v_key)
        on conflict (user_id, idempotency_key) do nothing;
      end if;
    end if;
    return;
  end if;

  if v_plan_left > 0 then
    select l.idempotency_key into v_last_plan
      from public.credit_ledger l
     where l.user_id = p_user_id
       and l.idempotency_key like 'plan_monthly:%'
       and l.delta > 0
     order by l.created_at desc, l.id desc
     limit 1;
    if v_last_plan is not null then
      insert into public.credit_ledger (user_id, delta, reason, idempotency_key)
      values (p_user_id, -v_plan_left, 'reversal', 'plan_expire:' || v_last_plan)
      on conflict (user_id, idempotency_key) do nothing;
    end if;
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

  if v_weekly_left > 0 then
    insert into public.credit_ledger (user_id, delta, reason, idempotency_key)
    values (p_user_id, -v_weekly_left, 'reversal', 'free_weekly_expire:' || v_period::text)
    on conflict (user_id, idempotency_key) do nothing;
  end if;

  insert into public.credit_ledger (user_id, delta, reason, idempotency_key)
  values (p_user_id, v_weekly, 'free_grant', v_key)
  on conflict (user_id, idempotency_key) do nothing;
end;
$$;

comment on function public.ensure_credit_grants(uuid) is
  'Free weekly grant, and one Pro/Max grant per 30-day period of the active entitlement. Unused plan credits expire at the next period or when the plan lapses. Missed periods are not backfilled. Not client-callable.';

revoke all on function public.ensure_credit_grants(uuid) from public, anon, authenticated, service_role;
grant execute on function public.ensure_credit_grants(uuid) to service_role;
