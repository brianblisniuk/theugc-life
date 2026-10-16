-- E2E-4 security hardening.
--
-- Anon loses SELECT on creator_profiles. Public cards stay on
-- read_public_creator_card. Share links and positive credit grants stop while
-- account deletion is pending. Usernames are constrained to the form alphabet.
-- Private Gmail tables enable RLS with no client policy. Security definer
-- functions drop pg_temp from search_path. A service-role function rebinds a
-- stored Gmail ciphertext to its mailbox without rotating the key or the
-- credential generation.

revoke select on public.creator_profiles from anon;

drop policy creator_profiles_select on public.creator_profiles;
create policy creator_profiles_select on public.creator_profiles
  for select using (user_id = auth.uid());

alter table public.creator_profiles
  add constraint creator_profiles_username_format
  check (username ~ '^[a-z0-9_]{3,30}$');

-- RLS on, not forced. No policies: a future GRANT SELECT still returns no
-- rows for client roles. service_role bypasses RLS.
alter table private.gmail_historical_import_runs enable row level security;
alter table private.gmail_historical_import_threads enable row level security;
alter table private.gmail_normalized_headers enable row level security;
alter table private.gmail_normalized_messages enable row level security;
alter table private.gmail_normalized_participants enable row level security;
alter table private.gmail_normalized_reference_tokens enable row level security;
alter table private.gmail_normalized_text_parts enable row level security;
alter table private.gmail_normalized_threads enable row level security;
alter table private.gmail_oauth_credentials enable row level security;
alter table private.gmail_oauth_transactions enable row level security;
alter table private.gmail_outreach_catalog_epoch_lock enable row level security;
alter table private.gmail_outreach_creator_decision_events enable row level security;
alter table private.gmail_outreach_creator_decisions enable row level security;
alter table private.gmail_outreach_observed_recipient_canonical_links enable row level security;
alter table private.gmail_outreach_observed_recipients enable row level security;
alter table private.gmail_outreach_target_canonical_links enable row level security;
alter table private.gmail_outreach_target_confirmations enable row level security;
alter table private.gmail_outreach_target_contact_candidates enable row level security;
alter table private.gmail_outreach_target_contact_confirmed_members enable row level security;
alter table private.gmail_outreach_target_contact_signals enable row level security;
alter table private.gmail_outreach_target_observations enable row level security;
alter table private.gmail_outreach_target_scope_signals enable row level security;
alter table private.gmail_outreach_thread_signals enable row level security;
alter table private.gmail_raw_messages enable row level security;
alter table private.gmail_reply_message_observations enable row level security;
alter table private.gmail_reply_thread_summaries enable row level security;
create or replace function public.create_creator_share_link(p_expires_at timestamptz default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_token text;
  v_id uuid;
begin
  v_creator := public.current_creator_id();
  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if exists (
    select 1 from public.users u
    join public.creator_profiles cp on cp.user_id = u.id
    where cp.id = v_creator and u.deletion_requested_at is not null
  ) then
    return jsonb_build_object('result', 'deletion_pending');
  end if;
  if p_expires_at is not null and p_expires_at <= clock_timestamp() then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  perform 1 from public.creator_profiles where id = v_creator for update;

  if exists (
    select 1 from public.creator_share_links
     where creator_id = v_creator and revoked_at is null
  ) then
    return jsonb_build_object('result', 'active_link_exists');
  end if;

  v_token := public.creator_share_random_token();
  insert into public.creator_share_links (creator_id, token_hash, expires_at)
  values (v_creator, public.creator_share_token_hash(v_token), p_expires_at)
  returning id into v_id;

  return jsonb_build_object(
    'result', 'created',
    'token', v_token,
    'link_id', v_id,
    'expires_at', p_expires_at
  );
end;
$$;

create or replace function public.rotate_creator_share_link(p_expires_at timestamptz default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_old uuid;
  v_token text;
  v_id uuid;
begin
  v_creator := public.current_creator_id();
  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if exists (
    select 1 from public.users u
    join public.creator_profiles cp on cp.user_id = u.id
    where cp.id = v_creator and u.deletion_requested_at is not null
  ) then
    return jsonb_build_object('result', 'deletion_pending');
  end if;
  if p_expires_at is not null and p_expires_at <= clock_timestamp() then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  perform 1 from public.creator_profiles where id = v_creator for update;

  update public.creator_share_links
     set revoked_at = clock_timestamp()
   where creator_id = v_creator
     and revoked_at is null
  returning id into v_old;

  if v_old is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  v_token := public.creator_share_random_token();
  insert into public.creator_share_links (creator_id, token_hash, expires_at)
  values (v_creator, public.creator_share_token_hash(v_token), p_expires_at)
  returning id into v_id;

  return jsonb_build_object(
    'result', 'rotated',
    'token', v_token,
    'link_id', v_id,
    'expires_at', p_expires_at
  );
end;
$$;

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

  if not exists (
    select 1 from public.users u
     where u.id = p_user_id
       and u.deletion_requested_at is null
  ) then
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
     order by created_at, idempotency_key
  loop
    if r.delta > 0 and r.idempotency_key like 'plan_monthly:%' then
      v_plan_left := v_plan_left + r.delta;
    elsif r.delta > 0 and r.idempotency_key like 'free_weekly:%' then
      v_weekly_left := v_weekly_left + r.delta;
    elsif r.delta < 0 and (
      r.idempotency_key like 'plan_expire:%'
      or r.idempotency_key like 'rebill_revoke_plan:%'
    ) then
      v_plan_left := v_plan_left - least(v_plan_left, -r.delta);
    elsif r.delta < 0 and r.idempotency_key like 'free_weekly_expire:%' then
      v_weekly_left := v_weekly_left - least(v_weekly_left, -r.delta);
    elsif r.delta < 0 and r.idempotency_key like 'rebill_revoke:%' then
      if not exists (
        select 1
          from public.credit_ledger l
         where l.user_id = p_user_id
           and l.idempotency_key = 'pack:' || substring(
             r.idempotency_key from char_length('rebill_revoke:') + 1
           )
           and l.delta > 0
      ) then
        v_plan_left := v_plan_left - least(v_plan_left, -r.delta);
      end if;
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
     order by l.created_at desc, l.idempotency_key desc
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

create or replace function public.apply_rebill_event(p_event jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_log text;
  v_event text;
  v_payment text;
  v_status text;
  v_amount numeric;
  v_currency text;
  v_link text;
  v_checkout_id uuid;
  v_sub text;
  v_sub_status text;
  v_sub_detail text;
  v_plan_updated boolean := false;
  v_new_product text;
  v_checkout public.rebill_checkouts%rowtype;
  v_sub_row public.subscriptions%rowtype;
  v_user uuid;
  v_product text;
  v_catalog integer;
  v_pro_m integer;
  v_pro_a integer;
  v_max_m integer;
  v_max_a integer;
  v_sizes integer[];
  v_prices integer[];
  v_i integer;
  v_credits integer;
  v_tier text;
  v_interval text;
  v_window interval;
  v_ref text;
  v_ent public.access_entitlements%rowtype;
  v_starts timestamptz;
  v_expires timestamptz;
  v_ent_id uuid;
  v_effect public.rebill_payment_effects%rowtype;
  v_plan_left integer := 0;
  v_take integer;
  v_rest integer;
  v_granted integer;
  v_reversed integer;
  v_slice_start timestamptz;
  v_slice_end timestamptz;
  v_grant_key text;
  v_had_grant boolean := false;
  v_period integer;
  v_window_epoch bigint;
  v_later_start timestamptz;
  v_later_end timestamptz;
  v_this_current boolean := false;
  v_ended_now boolean := false;
  v_next_period integer;
  v_balance integer := 0;
  v_unused integer := 0;
  v_mapped text;
  r record;
  v_result text;
begin
  if p_event is null or pg_catalog.jsonb_typeof(p_event) <> 'object' then
    return pg_catalog.jsonb_build_object('result', 'invalid');
  end if;

  v_log := nullif(p_event->>'logId', '');
  v_event := nullif(p_event->>'event', '');
  if v_log is null or char_length(v_log) > 200 or v_log !~ '^[A-Za-z0-9_]+$'
     or v_event is null or char_length(v_event) > 80 then
    return pg_catalog.jsonb_build_object('result', 'invalid');
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('theugc.rebill_log'),
    pg_catalog.hashtext(v_log)
  );

  if exists (select 1 from public.rebill_webhook_events e where e.log_id = v_log) then
    return pg_catalog.jsonb_build_object('result', 'duplicate');
  end if;

  v_payment := nullif(p_event #>> '{payment,id}', '');
  if v_payment is not null and v_payment !~ '^pay_[A-Za-z0-9]+$' then
    return pg_catalog.jsonb_build_object('result', 'invalid');
  end if;
  if v_payment is not null then
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('theugc.rebill_pay'),
      pg_catalog.hashtext(v_payment)
    );
  end if;

  begin
    if nullif(p_event #>> '{payment,checkoutId}', '') is not null then
      v_checkout_id := (p_event #>> '{payment,checkoutId}')::uuid;
    end if;
  exception
    when invalid_text_representation then
      return pg_catalog.jsonb_build_object('result', 'invalid');
  end;

  v_link := nullif(p_event #>> '{payment,paymentLinkId}', '');
  if v_link is not null and v_link !~ '^pl_[A-Za-z0-9]+$' then
    return pg_catalog.jsonb_build_object('result', 'invalid');
  end if;

  v_sub := coalesce(
    nullif(p_event #>> '{payment,subscriptionId}', ''),
    nullif(p_event #>> '{subscription,id}', '')
  );
  if v_sub is not null and v_sub !~ '^sub_[A-Za-z0-9]+$' then
    return pg_catalog.jsonb_build_object('result', 'invalid');
  end if;

  v_status := lower(coalesce(p_event #>> '{payment,status}', ''));
  v_currency := upper(coalesce(p_event #>> '{payment,currency}', ''));
  begin
    if nullif(p_event #>> '{payment,amount}', '') is not null then
      v_amount := (p_event #>> '{payment,amount}')::numeric;
    end if;
  exception
    when invalid_text_representation then
      return pg_catalog.jsonb_build_object('result', 'invalid');
  end;

  v_sub_status := lower(coalesce(p_event #>> '{subscription,status}', ''));
  v_sub_detail := nullif(p_event #>> '{subscription,statusDetail}', '');
  v_plan_updated := coalesce(p_event #>> '{subscription,planUpdated}', '') in ('true', 't');
  v_new_product := nullif(p_event #>> '{subscription,productCode}', '');

  if v_event not in (
    'payment.created', 'payment.updated', 'subscription.updated'
  ) then
    insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
    values (v_log, v_event, v_payment, 'ignored');
    return pg_catalog.jsonb_build_object('result', 'ignored');
  end if;

  if v_checkout_id is not null and v_link is not null then
    select * into v_checkout
      from public.rebill_checkouts c
     where c.id = v_checkout_id
       and c.provider_link_id = v_link;
  elsif v_checkout_id is not null then
    select * into v_checkout
      from public.rebill_checkouts c
     where c.id = v_checkout_id;
  elsif v_link is not null then
    select * into v_checkout
      from public.rebill_checkouts c
     where c.provider_link_id = v_link;
  end if;

  if v_sub is not null then
    select * into v_sub_row
      from public.subscriptions s
     where s.provider = 'rebill'
       and s.provider_subscription_id = v_sub;
  end if;

  if v_checkout.id is not null and v_sub_row.id is not null
     and v_checkout.user_id is distinct from v_sub_row.user_id then
    insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
    values (v_log, v_event, v_payment, 'user_conflict');
    return pg_catalog.jsonb_build_object('result', 'user_conflict');
  end if;

  v_user := coalesce(v_checkout.user_id, v_sub_row.user_id);
  v_product := coalesce(v_checkout.product_code, v_sub_row.plan_code);

  -- Plan change and subscription status. No user id in the payload is read.
  -- A plan change does not grant credits and does not move the paid window.
  if v_event = 'subscription.updated' and v_payment is null then
    if v_user is null or v_sub is null then
      insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
      values (v_log, v_event, v_payment, 'unknown_subscription');
      return pg_catalog.jsonb_build_object('result', 'unknown_subscription');
    end if;

    if v_plan_updated and v_new_product in (
      'pro_monthly', 'pro_annual', 'max_monthly', 'max_annual'
    ) then
      v_tier := case when v_new_product like 'max_%' then 'max' else 'pro' end;
      v_interval := case when v_new_product like '%_annual' then 'year' else 'month' end;
      update public.subscriptions s
         set plan_code = v_new_product,
             plan_tier = v_tier,
             billing_interval = v_interval
       where s.id = v_sub_row.id
         and s.user_id = v_user;
      update public.access_entitlements e
         set access_type = v_tier
       where e.user_id = v_user
         and e.source = 'rebill'
         and e.source_reference = 'rebill-sub:' || v_sub
         and e.status = 'active';
      v_product := v_new_product;
    end if;

    v_mapped := case
      when v_sub_status = 'active' then 'active'
      when v_sub_status = 'paused' and v_sub_detail = 'defaulted' then 'past_due'
      when v_sub_status = 'paused' then 'canceled'
      when v_sub_status in ('cancelled', 'canceled') then 'canceled'
      when v_sub_status in ('finished', 'expired') then 'expired'
      else null
    end;

    if v_mapped is not null then
      update public.subscriptions s
         set status = v_mapped,
             cancelled_at = case
               when v_mapped = 'canceled' then coalesce(s.cancelled_at, pg_catalog.now())
               else s.cancelled_at
             end,
             ended_at = case
               when v_mapped = 'expired' then coalesce(s.ended_at, pg_catalog.now())
               else s.ended_at
             end
       where s.id = v_sub_row.id
         and s.user_id = v_user;
    end if;

    insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
    values (v_log, v_event, v_payment, 'subscription_updated');
    return pg_catalog.jsonb_build_object('result', 'subscription_updated');
  end if;

  if v_status not in ('refunded', 'partially_refunded', 'chargeback') then
  if v_payment is null or v_user is null or v_product is null then
    insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
    values (v_log, v_event, v_payment, 'unknown_checkout');
    return pg_catalog.jsonb_build_object('result', 'unknown_checkout');
  end if;

  if not exists (select 1 from public.users u where u.id = v_user) then
    insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
    values (v_log, v_event, v_payment, 'unknown_checkout');
    return pg_catalog.jsonb_build_object('result', 'unknown_checkout');
  end if;

  select pro_price_monthly_usd, pro_price_annual_per_month_usd,
         max_price_monthly_usd, max_price_annual_per_month_usd,
         pack_sizes, pack_price_usd
    into v_pro_m, v_pro_a, v_max_m, v_max_a, v_sizes, v_prices
  from public.credit_config
  where id;

  v_catalog := case v_product
    when 'pro_monthly' then v_pro_m
    when 'pro_annual' then v_pro_a * 12
    when 'max_monthly' then v_max_m
    when 'max_annual' then v_max_a * 12
    else null
  end;
  v_credits := null;
  if v_catalog is null then
    v_i := 1;
    while v_i <= pg_catalog.cardinality(v_sizes) loop
      if v_product = 'pack_' || v_sizes[v_i]::text then
        v_catalog := v_prices[v_i];
        v_credits := v_sizes[v_i];
      end if;
      v_i := v_i + 1;
    end loop;
  end if;

  if v_catalog is null or v_currency <> 'USD' or v_amount is null or v_amount < v_catalog then
    insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
    values (v_log, v_event, v_payment, 'amount_mismatch');
    return pg_catalog.jsonb_build_object('result', 'amount_mismatch');
  end if;


  if v_status in ('rejected', 'cancelled', 'canceled') then
    if v_sub_row.id is not null then
      update public.subscriptions s
         set status = 'past_due'
       where s.id = v_sub_row.id
         and s.user_id = v_user
         and s.status = 'active';
    end if;
    insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
    values (v_log, v_event, v_payment, 'past_due');
    return pg_catalog.jsonb_build_object('result', 'past_due');
  end if;

  if v_status <> 'approved' then
    insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
    values (v_log, v_event, v_payment, 'ignored');
    return pg_catalog.jsonb_build_object('result', 'ignored');
  end if;
  end if;

  if v_status in ('refunded', 'partially_refunded', 'chargeback') then
    select * into v_effect
      from public.rebill_payment_effects f
     where f.payment_id = v_payment;

    if not found then
      insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
      values (v_log, v_event, v_payment, 'refund_without_grant');
      return pg_catalog.jsonb_build_object('result', 'refund_without_grant');
    end if;

    -- A second refund is a no-op. A chargeback after that refund still
    -- revokes the whole subscription (D140).
    if v_effect.effect = 'revoked'
       and not (v_status = 'chargeback' and v_effect.entitlement_id is not null) then
      insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
      values (v_log, v_event, v_payment, 'already_revoked');
      return pg_catalog.jsonb_build_object('result', 'already_revoked');
    end if;

    update public.rebill_payment_effects
       set effect = 'revoked'
     where payment_id = v_payment
       and effect = 'granted';

    select coalesce(sum(delta), 0)::int into v_balance
      from public.credit_ledger
     where user_id = v_effect.user_id;

    -- Chargeback still ends the whole subscription. An annual refund ends the
    -- plan. A monthly refund removes only that payment's 30-day slice (D140).
    if v_effect.entitlement_id is not null
       and (
         v_status = 'chargeback'
         or v_effect.product_code in ('pro_annual', 'max_annual')
       ) then
      update public.access_entitlements e
         set status = case
               when v_status = 'chargeback' or e.status = 'revoked' then 'revoked'
               else 'expired'
             end,
             expires_at = least(coalesce(e.expires_at, pg_catalog.now()), pg_catalog.now())
       where e.id = v_effect.entitlement_id
         and e.user_id = v_effect.user_id;
      v_unused := public.rebill_unused_credits(v_effect.user_id, null, 'plan');
      v_take := least(v_unused, greatest(v_balance, 0));
      if v_take > 0 then
        insert into public.credit_ledger (user_id, delta, reason, ref_id, idempotency_key)
        values (
          v_effect.user_id, -v_take, 'reversal', v_payment,
          'rebill_revoke_plan:' || v_payment
        )
        on conflict (user_id, idempotency_key) do nothing;
      end if;
      if v_effect.subscription_id is not null then
        update public.subscriptions s
           set status = 'canceled',
               cancelled_at = coalesce(s.cancelled_at, pg_catalog.now()),
               renews_at = least(coalesce(s.renews_at, pg_catalog.now()), pg_catalog.now())
         where s.provider = 'rebill'
           and s.provider_subscription_id = v_effect.subscription_id
           and s.user_id = v_effect.user_id;
      end if;
      v_ended_now := true;
    elsif v_effect.product_code in ('pro_monthly', 'max_monthly') then
      if v_effect.grant_key is not null then
        select coalesce(sum(delta), 0)::int into v_granted
          from public.credit_ledger
         where user_id = v_effect.user_id
           and idempotency_key = v_effect.grant_key
           and delta > 0;
        v_unused := public.rebill_unused_credits(v_effect.user_id, v_effect.grant_key, 'key');
        v_take := least(v_unused, greatest(v_granted, 0), greatest(v_balance, 0));
        if v_take > 0 then
          insert into public.credit_ledger (user_id, delta, reason, ref_id, idempotency_key)
          values (
            v_effect.user_id, -v_take, 'reversal', v_payment,
            'rebill_revoke:' || v_payment
          )
          on conflict (user_id, idempotency_key) do nothing;
        end if;
      end if;

      -- No slice dates: the payment predates 0080. End access. Do not invent
      -- a window and do not reopen a revoked entitlement or a canceled subscription.
      if v_effect.slice_start is null or v_effect.slice_end is null then
        if v_effect.grant_key is null then
          v_unused := public.rebill_unused_credits(v_effect.user_id, null, 'plan');
          v_take := least(v_unused, greatest(v_balance, 0));
          if v_take > 0 then
            insert into public.credit_ledger (user_id, delta, reason, ref_id, idempotency_key)
            values (
              v_effect.user_id, -v_take, 'reversal', v_payment,
              'rebill_revoke_plan:' || v_payment
            )
            on conflict (user_id, idempotency_key) do nothing;
          end if;
        end if;
        update public.access_entitlements e
           set status = case when e.status = 'revoked' then 'revoked' else 'expired' end,
               expires_at = least(coalesce(e.expires_at, pg_catalog.now()), pg_catalog.now())
         where e.id = v_effect.entitlement_id
           and e.user_id = v_effect.user_id;
        update public.subscriptions s
           set status = case when s.status = 'canceled' then 'canceled' else 'expired' end,
               renews_at = least(coalesce(s.renews_at, pg_catalog.now()), pg_catalog.now()),
               ended_at = coalesce(s.ended_at, pg_catalog.now())
         where s.provider = 'rebill'
           and s.provider_subscription_id = v_effect.subscription_id
           and s.user_id = v_effect.user_id;
        v_ended_now := true;
      else
        v_this_current := v_effect.slice_start <= pg_catalog.now()
          and v_effect.slice_end > pg_catalog.now();

        if not v_this_current then
          update public.rebill_payment_effects f
             set slice_start = f.slice_start - (v_effect.slice_end - v_effect.slice_start),
                 slice_end = f.slice_end - (v_effect.slice_end - v_effect.slice_start)
           where f.user_id = v_effect.user_id
             and f.subscription_id = v_effect.subscription_id
             and f.effect = 'granted'
             and f.slice_start is not null
             and f.slice_start >= v_effect.slice_end;
        end if;

        select min(f.slice_start), max(f.slice_end)
          into v_later_start, v_later_end
          from public.rebill_payment_effects f
         where f.user_id = v_effect.user_id
           and f.subscription_id = v_effect.subscription_id
           and f.effect = 'granted'
           and f.slice_end > pg_catalog.now();

        if v_this_current and v_later_start is not null and v_later_start > pg_catalog.now() then
          update public.access_entitlements e
             set starts_at = case when e.status = 'revoked' then e.starts_at else v_later_start end,
                 expires_at = case
                   when e.status = 'revoked' then least(coalesce(e.expires_at, pg_catalog.now()), pg_catalog.now())
                   else v_later_end
                 end,
                 status = case when e.status = 'revoked' then 'revoked' else 'active' end
           where e.id = v_effect.entitlement_id
             and e.user_id = v_effect.user_id;
          update public.subscriptions s
             set status = case
                   when s.status = 'canceled' then 'canceled'
                   when exists (
                     select 1 from public.access_entitlements e
                      where e.id = v_effect.entitlement_id and e.status = 'revoked'
                   ) then s.status
                   else 'active'
                 end,
                 renews_at = case
                   when exists (
                     select 1 from public.access_entitlements e
                      where e.id = v_effect.entitlement_id and e.status = 'revoked'
                   ) then least(coalesce(s.renews_at, pg_catalog.now()), pg_catalog.now())
                   else v_later_end
                 end
           where s.provider = 'rebill'
             and s.provider_subscription_id = v_effect.subscription_id
             and s.user_id = v_effect.user_id;
          v_ended_now := true;
        elsif v_later_end is not null and v_later_end > pg_catalog.now()
              and not v_this_current then
          update public.access_entitlements e
             set expires_at = case
                   when e.status = 'revoked' then least(coalesce(e.expires_at, pg_catalog.now()), pg_catalog.now())
                   else v_later_end
                 end,
                 status = case when e.status = 'revoked' then 'revoked' else 'active' end
           where e.id = v_effect.entitlement_id
             and e.user_id = v_effect.user_id;
          update public.subscriptions s
             set status = case
                   when s.status = 'canceled' then 'canceled'
                   when exists (
                     select 1 from public.access_entitlements e
                      where e.id = v_effect.entitlement_id and e.status = 'revoked'
                   ) then s.status
                   else 'active'
                 end,
                 renews_at = case
                   when exists (
                     select 1 from public.access_entitlements e
                      where e.id = v_effect.entitlement_id and e.status = 'revoked'
                   ) then least(coalesce(s.renews_at, pg_catalog.now()), pg_catalog.now())
                   else v_later_end
                 end
           where s.provider = 'rebill'
             and s.provider_subscription_id = v_effect.subscription_id
             and s.user_id = v_effect.user_id;
          v_ended_now := false;
        else
          update public.access_entitlements e
             set status = case when e.status = 'revoked' then 'revoked' else 'expired' end,
                 expires_at = least(coalesce(e.expires_at, pg_catalog.now()), pg_catalog.now())
           where e.id = v_effect.entitlement_id
             and e.user_id = v_effect.user_id;
          update public.subscriptions s
             set status = case when s.status = 'canceled' then 'canceled' else 'expired' end,
                 renews_at = least(coalesce(s.renews_at, pg_catalog.now()), pg_catalog.now()),
                 ended_at = coalesce(s.ended_at, pg_catalog.now())
           where s.provider = 'rebill'
             and s.provider_subscription_id = v_effect.subscription_id
             and s.user_id = v_effect.user_id;
          v_ended_now := true;
        end if;

        if not exists (
          select 1 from public.access_entitlements e
           where e.id = v_effect.entitlement_id and e.status = 'revoked'
        ) then
          select e.starts_at into v_starts
            from public.access_entitlements e
           where e.id = v_effect.entitlement_id;
          if v_starts is not null then
            v_window_epoch := floor(extract(epoch from v_starts))::bigint;
            v_next_period := 0;
            for r in
              select f.payment_id, f.slice_start
                from public.rebill_payment_effects f
               where f.user_id = v_effect.user_id
                 and f.subscription_id = v_effect.subscription_id
                 and f.effect = 'granted'
                 and f.slice_start is not null
               order by f.slice_start, f.payment_id
            loop
              v_period := floor(
                extract(epoch from (r.slice_start - v_starts)) / (30 * 86400.0)
              )::integer;
              if v_period < v_next_period then
                v_period := v_next_period;
              end if;
              update public.rebill_payment_effects f
                 set grant_key = 'plan_monthly:' || v_effect.entitlement_id::text
                   || ':' || v_window_epoch::text || ':' || v_period::text
               where f.payment_id = r.payment_id;
              v_next_period := v_period + 1;
            end loop;
          end if;
        end if;
      end if;
    else
      select coalesce(sum(delta), 0)::int into v_granted
        from public.credit_ledger
       where user_id = v_effect.user_id
         and idempotency_key = 'pack:' || v_payment
         and delta > 0;
      if v_status = 'chargeback' then
        select coalesce(sum(delta), 0)::int into v_reversed
          from public.credit_ledger
         where user_id = v_effect.user_id
           and idempotency_key = 'rebill_revoke:' || v_payment;
        if v_granted + v_reversed > 0 then
          insert into public.credit_ledger (user_id, delta, reason, ref_id, idempotency_key)
          values (
            v_effect.user_id, -(v_granted + v_reversed), 'reversal', v_payment,
            'rebill_revoke:' || v_payment
          )
          on conflict (user_id, idempotency_key) do nothing;
        end if;
      else
        v_unused := public.rebill_unused_credits(
          v_effect.user_id, 'pack:' || v_payment, 'key'
        );
        v_take := least(v_unused, greatest(v_granted, 0), greatest(v_balance, 0));
        if v_take > 0 then
          insert into public.credit_ledger (user_id, delta, reason, ref_id, idempotency_key)
          values (
            v_effect.user_id, -v_take, 'reversal', v_payment,
            'rebill_revoke:' || v_payment
          )
          on conflict (user_id, idempotency_key) do nothing;
        end if;
      end if;
    end if;

    if v_ended_now then
      perform public.ensure_credit_grants(v_effect.user_id);
    end if;

    update public.purchases p
       set status = case when v_status = 'chargeback' then 'chargeback' else 'refunded' end,
           refunded_at = coalesce(p.refunded_at, pg_catalog.now())
     where p.provider = 'rebill'
       and p.provider_transaction_id = v_payment
       and p.user_id = v_effect.user_id;

    insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
    values (v_log, v_event, v_payment, 'revoked');
    return pg_catalog.jsonb_build_object('result', 'revoked');
  end if;

  if exists (
    select 1
      from public.rebill_webhook_events e
     where e.payment_id = v_payment
       and e.result in ('revoked', 'refund_without_grant')
  ) then
    insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
    values (v_log, v_event, v_payment, 'refunded_before_grant');
    return pg_catalog.jsonb_build_object('result', 'refunded_before_grant');
  end if;

  if exists (
    select 1 from public.rebill_payment_effects f where f.payment_id = v_payment
  ) then
    insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
    values (v_log, v_event, v_payment, 'already_applied');
    return pg_catalog.jsonb_build_object('result', 'already_applied');
  end if;

  if v_user is not null and exists (
    select 1 from public.users u
     where u.id = v_user and u.deletion_requested_at is not null
  ) then
    insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
    values (v_log, v_event, v_payment, 'deletion_pending');
    return pg_catalog.jsonb_build_object('result', 'deletion_pending');
  end if;

  insert into public.purchases (
    user_id, provider, provider_transaction_id, product_type, product_reference,
    amount, currency, status, purchased_at
  ) values (
    v_user, 'rebill', v_payment,
    case when v_product like 'pack_%' then 'credit_pack' else 'plan' end,
    v_product, v_amount, 'USD', 'approved', pg_catalog.now()
  )
  on conflict (provider, provider_transaction_id) where provider_transaction_id is not null
  do nothing;

  if v_product like 'pack_%' then
    if v_credits is null or v_credits <= 0 then
      insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
      values (v_log, v_event, v_payment, 'amount_mismatch');
      return pg_catalog.jsonb_build_object('result', 'amount_mismatch');
    end if;

    insert into public.credit_ledger (user_id, delta, reason, ref_id, idempotency_key)
    values (v_user, v_credits, 'pack_purchase', v_payment, 'pack:' || v_payment)
    on conflict (user_id, idempotency_key) do nothing;

    insert into public.rebill_payment_effects (
      payment_id, user_id, product_code, effect, entitlement_id, subscription_id
    ) values (
      v_payment, v_user, v_product, 'granted', null, null
    );

    if v_checkout.id is not null then
      update public.rebill_checkouts
         set status = 'completed'
       where id = v_checkout.id
         and user_id = v_user;
    end if;

    insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
    values (v_log, v_event, v_payment, 'applied');
    return pg_catalog.jsonb_build_object('result', 'applied', 'kind', 'pack');
  end if;

  if v_product not in ('pro_monthly', 'pro_annual', 'max_monthly', 'max_annual') then
    insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
    values (v_log, v_event, v_payment, 'unknown_checkout');
    return pg_catalog.jsonb_build_object('result', 'unknown_checkout');
  end if;

  if v_sub is null then
    insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
    values (v_log, v_event, v_payment, 'subscription_required');
    return pg_catalog.jsonb_build_object('result', 'subscription_required');
  end if;

  v_tier := case when v_product like 'max_%' then 'max' else 'pro' end;
  v_interval := case when v_product like '%_annual' then 'year' else 'month' end;
  v_window := case
    when v_interval = 'year' then interval '12 months'
    else interval '30 days'
  end;
  v_ref := 'rebill-sub:' || v_sub;

  select * into v_ent
    from public.access_entitlements e
   where e.source = 'rebill'
     and e.source_reference = v_ref;

  if found and v_ent.user_id <> v_user then
    insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
    values (v_log, v_event, v_payment, 'user_conflict');
    return pg_catalog.jsonb_build_object('result', 'user_conflict');
  end if;

  if found and v_ent.status <> 'revoked'
     and v_ent.expires_at is not null
     and v_ent.expires_at > pg_catalog.now() then
    v_starts := v_ent.starts_at;
    v_expires := v_ent.expires_at + v_window;
    v_slice_start := v_ent.expires_at;
  else
    v_starts := pg_catalog.now();
    v_expires := pg_catalog.now() + v_window;
    v_slice_start := v_starts;
  end if;
  v_slice_end := v_expires;

  insert into public.subscriptions (
    user_id, provider, provider_subscription_id, plan_code, plan_tier,
    billing_interval, status, price_paid, currency, started_at, renews_at
  ) values (
    v_user, 'rebill', v_sub, v_product, v_tier, v_interval, 'active',
    v_catalog, 'USD', coalesce(v_sub_row.started_at, v_starts), v_expires
  )
  on conflict (provider, provider_subscription_id) where provider_subscription_id is not null
  do update set
    plan_code = excluded.plan_code,
    plan_tier = excluded.plan_tier,
    billing_interval = excluded.billing_interval,
    status = 'active',
    price_paid = excluded.price_paid,
    renews_at = excluded.renews_at,
    cancelled_at = null
  where public.subscriptions.user_id = excluded.user_id;

  insert into public.access_entitlements (
    user_id, access_type, destination_id, source, source_reference,
    starts_at, expires_at, status
  ) values (
    v_user, v_tier, null, 'rebill', v_ref, v_starts, v_expires, 'active'
  )
  on conflict (source, source_reference) where source_reference is not null
  do update set
    access_type = excluded.access_type,
    starts_at = excluded.starts_at,
    expires_at = excluded.expires_at,
    status = 'active'
  where public.access_entitlements.user_id = excluded.user_id
  returning id into v_ent_id;

  if v_ent_id is null then
    insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
    values (v_log, v_event, v_payment, 'user_conflict');
    return pg_catalog.jsonb_build_object('result', 'user_conflict');
  end if;

  v_period := floor(
    extract(epoch from (pg_catalog.now() - v_starts)) / (30 * 86400.0)
  )::integer;
  if v_period < 0 then
    v_period := 0;
  end if;
  v_window_epoch := floor(extract(epoch from v_starts))::bigint;
  v_grant_key := 'plan_monthly:' || v_ent_id::text || ':' || v_window_epoch::text || ':' || v_period::text;
  select exists (
    select 1 from public.credit_ledger l
     where l.user_id = v_user and l.idempotency_key = v_grant_key
  ) into v_had_grant;

  perform public.ensure_credit_grants(v_user);

  -- An early renewal finds this period's grant already written. The payment
  -- still owns the next period no other payment has claimed.
  v_next_period := v_period;
  loop
    v_grant_key := 'plan_monthly:' || v_ent_id::text || ':' || v_window_epoch::text || ':' || v_next_period::text;
    exit when not exists (
      select 1
        from public.rebill_payment_effects f
       where f.entitlement_id = v_ent_id
         and f.grant_key = v_grant_key
    ) and (v_next_period > v_period or not v_had_grant);
    v_next_period := v_next_period + 1;
    exit when v_next_period > v_period + 24;
  end loop;

  insert into public.rebill_payment_effects (
    payment_id, user_id, product_code, effect, entitlement_id, subscription_id,
    grant_key, slice_start, slice_end
  ) values (
    v_payment, v_user, v_product, 'granted', v_ent_id, v_sub,
    v_grant_key, v_slice_start, v_slice_end
  );

  if v_checkout.id is not null then
    update public.rebill_checkouts
       set status = 'completed'
     where id = v_checkout.id
       and user_id = v_user;
  end if;

  v_result := 'applied';
  insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
  values (v_log, v_event, v_payment, v_result);
  return pg_catalog.jsonb_build_object(
    'result', v_result,
    'kind', 'plan',
    'entitlement_id', v_ent_id
  );
end;
$$;

create or replace function public.gmail_credential_bind_ciphertext(
  p_mail_account_id uuid,
  p_expected_ciphertext text,
  p_refresh_ciphertext text,
  p_refresh_iv text,
  p_refresh_auth_tag text,
  p_key_version text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_generation bigint;
begin
  if p_mail_account_id is null
     or p_expected_ciphertext is null
     or length(p_expected_ciphertext) = 0
     or p_refresh_ciphertext is null
     or length(p_refresh_ciphertext) = 0
     or p_refresh_iv is null
     or length(p_refresh_iv) = 0
     or p_refresh_auth_tag is null
     or length(p_refresh_auth_tag) = 0
     or p_key_version is null
     or length(btrim(p_key_version)) = 0
  then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  update private.gmail_oauth_credentials
     set refresh_token_ciphertext = p_refresh_ciphertext,
         refresh_token_iv = p_refresh_iv,
         refresh_token_auth_tag = p_refresh_auth_tag,
         encryption_key_version = p_key_version,
         updated_at = pg_catalog.now()
   where mail_account_id = p_mail_account_id
     and refresh_token_ciphertext = p_expected_ciphertext
  returning credential_generation into v_generation;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_current');
  end if;

  return pg_catalog.jsonb_build_object(
    'result', 'ok',
    'credential_generation', v_generation
  );
end;
$$;

comment on function public.gmail_credential_bind_ciphertext(uuid, text, text, text, text, text) is
  'Rewrites one stored refresh-token envelope onto its mailbox. Matches the ciphertext the caller loaded and does not change credential_generation. Service role only.';

revoke all on function public.gmail_credential_bind_ciphertext(uuid, text, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.gmail_credential_bind_ciphertext(uuid, text, text, text, text, text)
  to service_role;

-- Qualify unqualified digest() and pin every remaining security definer to an
-- empty search_path. Invoker functions are left as they are. The pattern is a
-- string, so this block does not call digest().
do $e2e4$
declare
  r record;
  def text;
begin
  for r in
    select p.oid
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where p.prosecdef
       and n.nspname in ('public', 'private')
       and exists (
         select 1
           from unnest(coalesce(p.proconfig, array[]::text[])) cfg
          where cfg like '%pg_temp%'
       )
  loop
    def := pg_get_functiondef(r.oid);
    def := regexp_replace(def, '(?<![[:alnum:]_.])digest[[:space:]]*\(', 'public.digest(', 'g');
    def := regexp_replace(def, 'SET search_path TO [^\n]+', 'SET search_path TO ''''', 'g');
    execute def;
  end loop;
end
$e2e4$;

-- These two helpers are invokers with no search_path of their own. A security
-- definer that calls them now has an empty search_path, so an unqualified
-- digest() no longer resolves. Qualify the call. Do not pin their search_path.
do $e2e4_digest$
declare
  r record;
  def text;
begin
  for r in
    select p.oid
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'private'
       and p.proname in (
         'gmail_reply_routing_context_digest',
         'gmail_reply_thread_summary_is_stale'
       )
  loop
    def := pg_get_functiondef(r.oid);
    def := regexp_replace(def, '(?<![[:alnum:]_.])digest[[:space:]]*\(', 'public.digest(', 'g');
    execute def;
  end loop;
end
$e2e4_digest$;
