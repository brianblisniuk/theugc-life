-- 0100_audit_billing_unlock_ai.sql
-- Audit corrections. Does not edit 0076, 0081, or any earlier migration.
-- 0099 is reserved by another PR.
--
-- A pack chargeback after a refund posts the rest of the grant:
-- -(granted + prior rebill_revoke deltas) when that sum is positive.
-- The ledger is append-only, so the remainder uses
-- rebill_revoke:{payment}:chargeback when the refund already used
-- rebill_revoke:{payment}. The balance may go below zero (D140).
-- rebill_unused_credits reads the payment id before the first colon
-- so that remainder still reduces the named pack.
--
-- A monthly refund keeps a past_due subscription past_due.
--
-- unlock_hotel_contact returns insufficient_credits before needs_provider
-- when credit_balance is below unlock_cost.

create or replace function public.rebill_unused_credits(
  p_user_id uuid,
  p_key text,
  p_scope text
) returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_weekly integer := 0;
  v_need integer;
  v_take integer;
  v_seq integer := 0;
  v_left integer := 0;
  v_pay text;
  v_target text;
  r record;
  b record;
begin
  if p_user_id is null then
    return 0;
  end if;

  drop table if exists pg_temp.rebill_buckets;
  create temporary table pg_temp.rebill_buckets (
    seq integer primary key,
    bucket_key text not null,
    remaining integer not null
  ) on commit drop;

  for r in
    select delta, idempotency_key
      from public.credit_ledger
     where user_id = p_user_id
     order by created_at, idempotency_key
  loop
    if r.delta > 0 and r.idempotency_key like 'plan_monthly:%' then
      v_seq := v_seq + 1;
      insert into pg_temp.rebill_buckets (seq, bucket_key, remaining)
      values (v_seq, r.idempotency_key, r.delta);
    elsif r.delta > 0 and r.idempotency_key like 'free_weekly:%' then
      v_weekly := v_weekly + r.delta;
    elsif r.delta > 0 then
      v_seq := v_seq + 1;
      insert into pg_temp.rebill_buckets (seq, bucket_key, remaining)
      values (v_seq, r.idempotency_key, r.delta);
    elsif r.idempotency_key like 'plan_expire:%'
       or r.idempotency_key like 'rebill_revoke_plan:%' then
      v_need := -r.delta;
      for b in
        select seq, remaining
          from pg_temp.rebill_buckets
         where bucket_key like 'plan_monthly:%'
           and remaining > 0
         order by seq
      loop
        exit when v_need = 0;
        v_take := least(b.remaining, v_need);
        update pg_temp.rebill_buckets
           set remaining = remaining - v_take
         where seq = b.seq;
        v_need := v_need - v_take;
      end loop;
    elsif r.idempotency_key like 'free_weekly_expire:%' then
      v_take := least(v_weekly, -r.delta);
      v_weekly := v_weekly - v_take;
    elsif r.idempotency_key like 'rebill_revoke:%' then
      v_pay := pg_catalog.split_part(
        substring(r.idempotency_key from char_length('rebill_revoke:') + 1),
        ':',
        1
      );
      v_need := -r.delta;
      if exists (
        select 1 from pg_temp.rebill_buckets
         where bucket_key = 'pack:' || v_pay
      ) then
        for b in
          select seq, remaining
            from pg_temp.rebill_buckets
           where bucket_key = 'pack:' || v_pay
             and remaining > 0
           order by seq
        loop
          exit when v_need = 0;
          v_take := least(b.remaining, v_need);
          update pg_temp.rebill_buckets
             set remaining = remaining - v_take
           where seq = b.seq;
          v_need := v_need - v_take;
        end loop;
      else
        select f.grant_key into v_target
          from public.rebill_payment_effects f
         where f.payment_id = v_pay;
        if v_target is not null and exists (
          select 1 from pg_temp.rebill_buckets where bucket_key = v_target
        ) then
          for b in
            select seq, remaining
              from pg_temp.rebill_buckets
             where bucket_key = v_target
               and remaining > 0
             order by seq
          loop
            exit when v_need = 0;
            v_take := least(b.remaining, v_need);
            update pg_temp.rebill_buckets
               set remaining = remaining - v_take
             where seq = b.seq;
            v_need := v_need - v_take;
          end loop;
        else
          for b in
            select seq, remaining
              from pg_temp.rebill_buckets
             where bucket_key like 'plan_monthly:%'
               and remaining > 0
             order by seq
          loop
            exit when v_need = 0;
            v_take := least(b.remaining, v_need);
            update pg_temp.rebill_buckets
               set remaining = remaining - v_take
             where seq = b.seq;
            v_need := v_need - v_take;
          end loop;
        end if;
      end if;
    else
      v_need := -r.delta;
      for b in
        select seq, remaining
          from pg_temp.rebill_buckets
         where bucket_key like 'plan_monthly:%'
           and remaining > 0
         order by seq
      loop
        exit when v_need = 0;
        v_take := least(b.remaining, v_need);
        update pg_temp.rebill_buckets
           set remaining = remaining - v_take
         where seq = b.seq;
        v_need := v_need - v_take;
      end loop;
      v_take := least(v_weekly, v_need);
      v_weekly := v_weekly - v_take;
      v_need := v_need - v_take;
      for b in
        select seq, remaining
          from pg_temp.rebill_buckets
         where bucket_key not like 'plan_monthly:%'
           and remaining > 0
         order by seq
      loop
        exit when v_need = 0;
        v_take := least(b.remaining, v_need);
        update pg_temp.rebill_buckets
           set remaining = remaining - v_take
         where seq = b.seq;
        v_need := v_need - v_take;
      end loop;
    end if;
  end loop;

  if p_scope = 'plan' then
    select coalesce(sum(remaining), 0)::int into v_left
      from pg_temp.rebill_buckets
     where bucket_key like 'plan_monthly:%';
    return greatest(v_left, 0);
  end if;

  if p_key is null then
    return 0;
  end if;

  select coalesce(sum(remaining), 0)::int into v_left
    from pg_temp.rebill_buckets
   where bucket_key = p_key;
  return greatest(v_left, 0);
end;
$$;

comment on function public.rebill_unused_credits(uuid, text, text) is
  'Unused credits for one ledger key, or for every plan grant. A reversal reduces the grant it names. Service role only. Not access.';

revoke all on function public.rebill_unused_credits(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.rebill_unused_credits(uuid, text, text) to service_role;

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
    -- revokes the whole subscription, and a pack chargeback still reverses
    -- the full grant even after a partial refund (D140).
    if v_effect.effect = 'revoked' and v_status <> 'chargeback' then
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
                   when s.status in ('canceled', 'past_due') then s.status
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
                   when s.status in ('canceled', 'past_due') then s.status
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
           and (
             idempotency_key = 'rebill_revoke:' || v_payment
             or idempotency_key = 'rebill_revoke:' || v_payment || ':chargeback'
           );
        if v_granted + v_reversed > 0 then
          insert into public.credit_ledger (user_id, delta, reason, ref_id, idempotency_key)
          values (
            v_effect.user_id,
            -(v_granted + v_reversed),
            'reversal',
            v_payment,
            case
              when exists (
                select 1
                  from public.credit_ledger existing
                 where existing.user_id = v_effect.user_id
                   and existing.idempotency_key = 'rebill_revoke:' || v_payment
              ) then 'rebill_revoke:' || v_payment || ':chargeback'
              else 'rebill_revoke:' || v_payment
            end
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


comment on function public.apply_rebill_event(jsonb) is
  'Applies one verified Rebill event. The account comes from a checkout or subscription row, never from a payload user id. A monthly refund removes that payment''s slice and does not set a past_due subscription back to active. A pack chargeback after a refund still reverses the full grant and may go below zero. A chargeback still ends the subscription, including after a refund of the same payment. Service role only.';

revoke all on function public.apply_rebill_event(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.apply_rebill_event(jsonb) to service_role;

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

  v_balance := public.credit_balance(v_uid);
  if v_balance < v_cost
     and (
       not v_has_cache
       or (v_cache.status = 'found' and not v_servable)
     ) then
    return jsonb_build_object(
      'status', 'insufficient_credits',
      'email', null,
      'balance', v_balance,
      'pipeline_added', false
    );
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
  'Atomic per-user unlock. Refreshes that user''s credit grants first. A balance below unlock_cost returns insufficient_credits before needs_provider, so the caller does not ask a provider. A revealed email also saves the hotel on the caller pipeline, or refuses with no debit when the Free allowance is full (D108).';

revoke all on function public.unlock_hotel_contact(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.unlock_hotel_contact(uuid, text) to authenticated, service_role;
