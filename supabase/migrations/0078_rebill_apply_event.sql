-- 0078_rebill_apply_event.sql
-- P02 verified Rebill effects (D007, D135–D139).
--
-- apply_rebill_event is the only writer that turns a confirmed payment into
-- an entitlement. It does not accept a user id. The account is the checkout
-- row or the subscription row this database already stored. A purchase or a
-- subscription insert, by itself, still grants nothing.
--
-- service_role only. Signature verification happens before this function is
-- called. The function still refuses an unknown checkout and an underpayment.

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

    if v_effect.effect = 'revoked' then
      insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
      values (v_log, v_event, v_payment, 'already_revoked');
      return pg_catalog.jsonb_build_object('result', 'already_revoked');
    end if;

    update public.rebill_payment_effects
       set effect = 'revoked'
     where payment_id = v_payment
       and effect = 'granted';

    if v_effect.entitlement_id is not null then
      update public.access_entitlements e
         set status = 'revoked'
       where e.id = v_effect.entitlement_id
         and e.user_id = v_effect.user_id;

      for r in
        select delta, idempotency_key
          from public.credit_ledger
         where user_id = v_effect.user_id
         order by created_at, id
      loop
        if r.delta > 0 and r.idempotency_key like 'plan_monthly:%' then
          v_plan_left := v_plan_left + r.delta;
        elsif r.delta < 0 then
          v_take := least(v_plan_left, -r.delta);
          v_plan_left := v_plan_left - v_take;
        end if;
      end loop;

      if v_plan_left > 0 then
        insert into public.credit_ledger (user_id, delta, reason, ref_id, idempotency_key)
        values (
          v_effect.user_id, -v_plan_left, 'reversal', v_payment,
          'rebill_revoke:' || v_payment
        )
        on conflict (user_id, idempotency_key) do nothing;
      end if;
    else
      select coalesce(sum(delta), 0)::int into v_granted
        from public.credit_ledger
       where user_id = v_effect.user_id
         and idempotency_key = 'pack:' || v_payment;
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
    end if;

    if v_effect.subscription_id is not null then
      update public.subscriptions s
         set status = 'canceled',
             cancelled_at = coalesce(s.cancelled_at, pg_catalog.now())
       where s.provider = 'rebill'
         and s.provider_subscription_id = v_effect.subscription_id
         and s.user_id = v_effect.user_id;
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
  else
    v_starts := pg_catalog.now();
    v_expires := pg_catalog.now() + v_window;
  end if;

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

  insert into public.rebill_payment_effects (
    payment_id, user_id, product_code, effect, entitlement_id, subscription_id
  ) values (
    v_payment, v_user, v_product, 'granted', v_ent_id, v_sub
  );

  perform public.ensure_credit_grants(v_user);

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
  'Applies one verified Rebill event. The account comes from a checkout or subscription row, never from a payload user id. A payment effect is not access; the entitlement row is. Service role only.';

revoke all on function public.apply_rebill_event(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.apply_rebill_event(jsonb) to service_role;
