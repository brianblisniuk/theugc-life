-- 0106_deletion_refund_media_pool.sql
-- Final pre-launch audit of ab63df18.
-- 1. A Rebill payment for a deletion-pending or deleted account is recorded
--    (amount and provider ids only) and flagged refund_required. It is not
--    granted and it is not auto-refunded. Webhook log id idempotency stays.
--    Requesting deletion cancels the local Rebill subscription and remembers
--    provider ids with no user id, so a payment can still be matched after erase.
-- 2. Hiding a Forbes photo moves the object into hotel-media-private. Unhide
--    moves it back. Anon cannot list hotel-media. The bucket stays public so
--    an exact path can still be fetched.
-- 3. ai_pool_snapshot uses the D188 15–20 percent clamp and an uncapped floor.


-- Provider ids that belonged to a closed account. No user id, no email.
-- Rows stay after erase so a later charge can be matched without a person.
create table private.rebill_closed_provider_ids (
  kind text not null check (kind in ('subscription', 'payment_link', 'checkout')),
  provider_id text not null check (char_length(provider_id) between 1 and 80),
  created_at timestamptz not null default pg_catalog.now(),
  primary key (kind, provider_id)
);

comment on table private.rebill_closed_provider_ids is
  'Provider ids remembered when an account is closed. No user id. Not personal data. Used only to recognize a later charge.';

-- Admin queue and alert. One row per captured payment. Status stays
-- refund_required until an owner acts outside this product. No auto-refund.
create table private.rebill_refund_queue (
  payment_id text primary key check (payment_id ~ '^pay_[A-Za-z0-9]+$'),
  subscription_id text check (subscription_id is null or subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  payment_link_id text check (payment_link_id is null or payment_link_id ~ '^pl_[A-Za-z0-9]+$'),
  amount numeric not null check (amount >= 0),
  currency text not null check (char_length(currency) between 3 and 8),
  status text not null default 'refund_required' check (status = 'refund_required'),
  created_at timestamptz not null default pg_catalog.now()
);

comment on table private.rebill_refund_queue is
  'Admin-visible refund alert. Amount and provider ids only. No user id, email, or name. refund_required is not a refund.';

alter table private.rebill_closed_provider_ids enable row level security;
alter table private.rebill_refund_queue enable row level security;

revoke all on private.rebill_closed_provider_ids from public, anon, authenticated, service_role;
revoke all on private.rebill_refund_queue from public, anon, authenticated, service_role;

create or replace function public.rebill_remember_closed_account(p_user uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user is null then
    return;
  end if;

  insert into private.rebill_closed_provider_ids (kind, provider_id)
  select 'subscription', s.provider_subscription_id
    from public.subscriptions s
   where s.user_id = p_user
     and s.provider = 'rebill'
     and s.provider_subscription_id is not null
  on conflict (kind, provider_id) do nothing;

  insert into private.rebill_closed_provider_ids (kind, provider_id)
  select 'payment_link', c.provider_link_id
    from public.rebill_checkouts c
   where c.user_id = p_user
     and c.provider_link_id is not null
  on conflict (kind, provider_id) do nothing;

  insert into private.rebill_closed_provider_ids (kind, provider_id)
  select 'checkout', c.id::text
    from public.rebill_checkouts c
   where c.user_id = p_user
  on conflict (kind, provider_id) do nothing;
end;
$$;

comment on function public.rebill_remember_closed_account(uuid) is
  'Copies Rebill provider ids for one account into a table with no user id. Does not grant or refund.';

revoke all on function public.rebill_remember_closed_account(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.rebill_close_local_subscriptions(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids text[];
begin
  if p_user is null then
    return '[]'::jsonb;
  end if;

  perform public.rebill_remember_closed_account(p_user);

  select coalesce(
           array_agg(s.provider_subscription_id order by s.provider_subscription_id),
           array[]::text[]
         )
    into v_ids
    from public.subscriptions s
   where s.user_id = p_user
     and s.provider = 'rebill'
     and s.provider_subscription_id is not null;

  update public.subscriptions s
     set status = 'canceled',
         cancelled_at = coalesce(s.cancelled_at, pg_catalog.clock_timestamp())
   where s.user_id = p_user
     and s.provider = 'rebill'
     and s.status not in ('canceled', 'expired');

  return pg_catalog.to_jsonb(v_ids);
end;
$$;

comment on function public.rebill_close_local_subscriptions(uuid) is
  'Cancels local Rebill subscriptions and returns their provider ids. Does not call Rebill and does not refund.';

revoke all on function public.rebill_close_local_subscriptions(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.rebill_account_closed_for_payment(
  p_user uuid,
  p_subscription text,
  p_checkout uuid,
  p_link text
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_user is not null and exists (
    select 1
      from public.users u
     where u.id = p_user
       and u.deletion_requested_at is not null
  ) then
    return true;
  end if;

  if p_subscription is not null and exists (
    select 1
      from private.rebill_closed_provider_ids k
     where k.kind = 'subscription'
       and k.provider_id = p_subscription
  ) then
    return true;
  end if;

  if p_checkout is not null and exists (
    select 1
      from private.rebill_closed_provider_ids k
     where k.kind = 'checkout'
       and k.provider_id = p_checkout::text
  ) then
    return true;
  end if;

  if p_link is not null and exists (
    select 1
      from private.rebill_closed_provider_ids k
     where k.kind = 'payment_link'
       and k.provider_id = p_link
  ) then
    return true;
  end if;

  return false;
end;
$$;

comment on function public.rebill_account_closed_for_payment(uuid, text, uuid, text) is
  'True when the account is deletion-pending or a remembered provider id matches a deleted account. No personal columns are returned.';

revoke all on function public.rebill_account_closed_for_payment(uuid, text, uuid, text)
  from public, anon, authenticated, service_role;

create or replace function public.rebill_queue_refund_required(
  p_payment text,
  p_subscription text,
  p_link text,
  p_amount numeric,
  p_currency text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_payment is null or p_amount is null or p_currency is null or p_currency = '' then
    raise exception 'refund queue requires a payment id, amount, and currency'
      using errcode = '22023';
  end if;

  insert into private.rebill_refund_queue (
    payment_id, subscription_id, payment_link_id, amount, currency, status
  ) values (
    p_payment,
    nullif(p_subscription, ''),
    nullif(p_link, ''),
    p_amount,
    pg_catalog.upper(p_currency),
    'refund_required'
  )
  on conflict (payment_id) do nothing;
end;
$$;

comment on function public.rebill_queue_refund_required(text, text, text, numeric, text) is
  'Records one refund_required alert. Does not call a provider and does not grant credits.';

revoke all on function public.rebill_queue_refund_required(text, text, text, numeric, text)
  from public, anon, authenticated, service_role;

create or replace function public.read_admin_rebill_refund_queue(p_limit integer)
returns table (
  payment_id text,
  subscription_id text,
  payment_link_id text,
  amount numeric,
  currency text,
  status text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if not exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'admin'
  ) then
    return;
  end if;

  return query
  select q.payment_id, q.subscription_id, q.payment_link_id,
         q.amount, q.currency, q.status, q.created_at
    from private.rebill_refund_queue q
   order by q.created_at desc, q.payment_id
   limit v_limit;
end;
$$;

comment on function public.read_admin_rebill_refund_queue(integer) is
  'Admin-only refund alert queue. A creator or an editor receives no rows. The rows have no user id.';

revoke all on function public.read_admin_rebill_refund_queue(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.read_admin_rebill_refund_queue(integer)
  to authenticated, service_role;


create or replace function public.request_own_account_deletion(p_confirmation text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := public.account_deletion_caller();
  v_role text;
  v_requested timestamptz;
  v_after timestamptz;
  v_balance integer;
  v_closed jsonb;
begin
  if v_user is null then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  select u.role, u.deletion_requested_at, u.delete_after
    into v_role, v_requested, v_after
    from public.users u
   where u.id = v_user
   for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  if v_role is distinct from 'creator' then
    return pg_catalog.jsonb_build_object('result', 'not_creator');
  end if;

  if v_requested is not null and v_after is not null then
    v_closed := public.rebill_close_local_subscriptions(v_user);
    return pg_catalog.jsonb_build_object(
      'result', 'already_scheduled',
      'deletion_requested_at', v_requested,
      'delete_after', v_after,
      'subscription_ids', v_closed
    );
  end if;

  if p_confirmation is distinct from 'DELETE' then
    return pg_catalog.jsonb_build_object('result', 'confirmation_required');
  end if;

  perform public.account_deletion_stop_gmail(v_user);

  update public.creator_share_links as link
     set revoked_at = pg_catalog.clock_timestamp()
    from public.creator_profiles as profile
   where link.creator_id = profile.id
     and profile.user_id = v_user
     and link.revoked_at is null;

  delete from public.pitch_drafts as draft
   using public.creator_profiles as profile
   where draft.creator_id = profile.id
     and profile.user_id = v_user
     and draft.origin = 'assistant';

  select coalesce(pg_catalog.sum(entry.delta), 0)::integer
    into v_balance
    from public.credit_ledger as entry
   where entry.user_id = v_user;

  if v_balance > 0 then
    insert into public.credit_ledger (user_id, delta, reason, idempotency_key)
    values (
      v_user,
      -v_balance,
      'reversal',
      'account-deletion:' || v_user::text
    )
    on conflict (user_id, idempotency_key) do nothing;
  end if;

  v_requested := pg_catalog.clock_timestamp();
  v_after := v_requested + interval '30 days';

  perform pg_catalog.set_config('theugc.account_deletion', 'on', true);
  update public.users
     set deletion_requested_at = v_requested,
         delete_after = v_after
   where id = v_user;

  v_closed := public.rebill_close_local_subscriptions(v_user);

  return pg_catalog.jsonb_build_object(
    'result', 'scheduled',
    'deletion_requested_at', v_requested,
    'delete_after', v_after,
    'subscription_ids', v_closed
  );
end;
$$;

create or replace function public.erase_creator_account(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_requested timestamptz;
  v_after timestamptz;
  v_mail record;
  v_purge jsonb;
begin
  if public.account_deletion_caller() is not null then
    return pg_catalog.jsonb_build_object('result', 'forbidden');
  end if;

  if p_user_id is null then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  select u.role, u.deletion_requested_at, u.delete_after
    into v_role, v_requested, v_after
    from public.users u
   where u.id = p_user_id
   for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  if v_role is distinct from 'creator' then
    return pg_catalog.jsonb_build_object('result', 'not_creator');
  end if;

  if v_requested is null or v_after is null then
    return pg_catalog.jsonb_build_object('result', 'not_scheduled');
  end if;

  if v_after > pg_catalog.now() then
    return pg_catalog.jsonb_build_object('result', 'not_due');
  end if;

  perform public.account_deletion_stop_gmail(p_user_id);

  for v_mail in
    select m.id, m.current_deletion_request_id as request_id
      from public.mail_accounts m
     where m.user_id = p_user_id
       and m.connection_state is distinct from 'deleted'
     order by m.id
  loop
    if v_mail.request_id is null then
      raise exception 'account erasure has no gmail deletion request'
        using errcode = '55000';
    end if;

    v_purge := public.gmail_historical_import_purge_for_deletion(
      p_user_id, v_mail.id, v_mail.request_id
    );
    if coalesce(v_purge->>'result', '') is distinct from 'ok' then
      raise exception 'gmail historical purge returned %', v_purge->>'result'
        using errcode = '55000';
    end if;

    v_purge := public.gmail_normalize_purge_for_deletion(
      p_user_id, v_mail.id, v_mail.request_id
    );
    if coalesce(v_purge->>'result', '') is distinct from 'ok' then
      raise exception 'gmail normalize purge returned %', v_purge->>'result'
        using errcode = '55000';
    end if;

    v_purge := public.gmail_outreach_purge_for_deletion(
      p_user_id, v_mail.id, v_mail.request_id
    );
    if coalesce(v_purge->>'result', '') is distinct from 'ok' then
      raise exception 'gmail outreach purge returned %', v_purge->>'result'
        using errcode = '55000';
    end if;

    v_purge := public.gmail_reply_purge_for_deletion(
      p_user_id, v_mail.id, v_mail.request_id
    );
    if coalesce(v_purge->>'result', '') is distinct from 'ok' then
      raise exception 'gmail reply purge returned %', v_purge->>'result'
        using errcode = '55000';
    end if;

    v_purge := public.gmail_commercial_purge_for_deletion(
      p_user_id, v_mail.id, v_mail.request_id
    );
    if coalesce(v_purge->>'result', '') is distinct from 'ok' then
      raise exception 'gmail commercial purge returned %', v_purge->>'result'
        using errcode = '55000';
    end if;

    v_purge := public.gmail_incremental_sync_purge_for_deletion(
      p_user_id, v_mail.id, v_mail.request_id
    );
    if coalesce(v_purge->>'result', '') is distinct from 'ok' then
      raise exception 'gmail sync purge returned %', v_purge->>'result'
        using errcode = '55000';
    end if;

    v_purge := public.gmail_send_purge_for_deletion(
      p_user_id, v_mail.id, v_mail.request_id
    );
    if coalesce(v_purge->>'result', '') is distinct from 'ok' then
      raise exception 'gmail send purge returned %', v_purge->>'result'
        using errcode = '55000';
    end if;
  end loop;

  perform pg_catalog.set_config('b07.purge', 'on', true);

  perform public.rebill_remember_closed_account(p_user_id);

  delete from public.users where id = p_user_id;
  delete from auth.users where id = p_user_id;

  return pg_catalog.jsonb_build_object('result', 'erased');
end;
$$;

create or replace function public.create_own_rebill_checkout(p_product_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
  v_amount integer;
  v_id uuid;
  v_pro_m integer;
  v_pro_a integer;
  v_max_m integer;
  v_max_a integer;
  v_sizes integer[];
  v_prices integer[];
  v_i integer;
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_product_code is null or p_product_code not in (
    'pro_monthly', 'pro_annual', 'max_monthly', 'max_annual',
    'pack_50', 'pack_150', 'pack_500'
  ) then
    return jsonb_build_object('result', 'invalid_product');
  end if;

  select pro_price_monthly_usd, pro_price_annual_per_month_usd,
         max_price_monthly_usd, max_price_annual_per_month_usd,
         pack_sizes, pack_price_usd
    into v_pro_m, v_pro_a, v_max_m, v_max_a, v_sizes, v_prices
  from public.credit_config
  where id;

  v_amount := case p_product_code
    when 'pro_monthly' then v_pro_m
    when 'pro_annual' then v_pro_a * 12
    when 'max_monthly' then v_max_m
    when 'max_annual' then v_max_a * 12
    else null
  end;

  if v_amount is null then
    v_i := 1;
    while v_i <= pg_catalog.cardinality(v_sizes) loop
      if p_product_code = 'pack_' || v_sizes[v_i]::text then
        v_amount := v_prices[v_i];
      end if;
      v_i := v_i + 1;
    end loop;
  end if;

  if v_amount is null or v_amount <= 0 then
    return jsonb_build_object('result', 'invalid_product');
  end if;

  if exists (
    select 1
      from public.users u
     where u.id = v_caller
       and u.deletion_requested_at is not null
  ) then
    return jsonb_build_object('result', 'deletion_pending');
  end if;

  insert into public.rebill_checkouts (user_id, product_code, amount_usd, currency)
  values (v_caller, p_product_code, v_amount, 'USD')
  returning id into v_id;

  return jsonb_build_object(
    'result', 'created',
    'checkout_id', v_id,
    'product_code', p_product_code,
    'amount_usd', v_amount,
    'currency', 'USD'
  );
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

    -- A closed account must not be put back on a plan or reactivated.
    if public.rebill_account_closed_for_payment(v_user, v_sub, null, null) then
      v_plan_updated := false;
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

    if v_mapped is not null
       and (
         not public.rebill_account_closed_for_payment(v_user, v_sub, null, null)
         or v_mapped in ('canceled', 'expired')
       ) then
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
  -- Approved money for a deletion-pending or deleted account is not granted.
  -- The same log id still returns duplicate above. The queue is the alert.
  if v_status = 'approved'
     and public.rebill_account_closed_for_payment(
       v_user, v_sub, coalesce(v_checkout.id, v_checkout_id), v_link
     )
  then
    if v_payment is null or v_amount is null or v_currency = '' then
      return pg_catalog.jsonb_build_object('result', 'error');
    end if;
    perform public.rebill_queue_refund_required(
      v_payment, v_sub, v_link, v_amount, v_currency
    );
    insert into public.rebill_webhook_events (log_id, event_name, payment_id, result)
    values (v_log, v_event, v_payment, 'deletion_pending');
    return pg_catalog.jsonb_build_object('result', 'deletion_pending');
  end if;
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

  if public.rebill_account_closed_for_payment(
       v_user, v_sub, coalesce(v_checkout.id, v_checkout_id), v_link
     )
  then
    perform public.rebill_queue_refund_required(
      v_payment, v_sub, v_link, v_amount, v_currency
    );
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

create or replace function public.ai_pool_snapshot(
  p_pool_floor_micros bigint,
  p_pool_percent_bps integer
)
returns table (pool_micros bigint, spent_micros bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month timestamptz;
  v_prev timestamptz;
  v_revenue numeric;
  v_bps integer;
  v_floor bigint;
  v_pool bigint;
  v_spent bigint;
begin
  v_month := (date_trunc('month', pg_catalog.now() at time zone 'utc') at time zone 'utc');
  v_prev := v_month - interval '1 month';
  -- D188. Same rule as poolPercentBps / readBudgetMicros.
  -- Null or below 15% becomes 15%. Above 20% becomes 20%. No $100,000 floor cap.
  if p_pool_percent_bps is null or p_pool_percent_bps < 1500 then
    v_bps := 1500;
  elsif p_pool_percent_bps > 2000 then
    v_bps := 2000;
  else
    v_bps := p_pool_percent_bps;
  end if;
  v_floor := coalesce(p_pool_floor_micros, 0);
  if v_floor < 0 then
    v_floor := 0;
  end if;

  select coalesce(sum(p.amount), 0)
    into v_revenue
    from public.purchases p
   where p.status = 'approved'
     and p.refunded_at is null
     and upper(coalesce(p.currency, '')) = 'USD'
     and p.purchased_at >= v_prev
     and p.purchased_at < v_month;

  v_pool := greatest(
    v_floor,
    greatest(0, round(v_revenue * v_bps * 100)::bigint)
  );

  select coalesce(sum(picked.estimated_cost_micros), 0)
    into v_spent
    from (
      select distinct on (u.request_id) u.estimated_cost_micros
        from public.ai_usage u
       where u.created_at >= v_month
       order by u.request_id,
         case u.status
           when 'completed' then 0
           when 'rejected' then 1
           when 'failed' then 2
           else 3
         end,
         u.created_at desc
    ) picked;

  pool_micros := v_pool;
  spent_micros := v_spent;
  return next;
end;
$$;

create or replace function public.hide_hotel_media(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.hotel_media%rowtype;
  v_bucket text;
begin
  if p_id is null or not public.is_admin_or_editor() then
    return false;
  end if;

  select m.*
    into v_row
    from public.hotel_media m
   where m.id = p_id
     and m.status = 'active'
   for update;

  if not found then
    return false;
  end if;

  v_bucket := v_row.storage_bucket;
  if v_row.source = 'forbes'
     and v_row.storage_path is not null
     and pg_catalog.to_regclass('storage.objects') is not null
     and exists (
       select 1 from storage.buckets b where b.id = 'hotel-media-private'
     )
  then
    -- Move the object row. Do not delete it. Unhide moves it back.
    update storage.objects o
       set bucket_id = 'hotel-media-private'
     where o.bucket_id = 'hotel-media'
       and o.name in (
         v_row.storage_path || '/w480.webp',
         v_row.storage_path || '/w1280.webp'
       );
    v_bucket := 'hotel-media-private';
  end if;

  update public.hotel_media
     set status = 'hidden',
         storage_bucket = v_bucket
   where id = p_id
     and status = 'active';
  return true;
end;
$$;


comment on function public.request_own_account_deletion(text) is
  'D151. Schedules the signed-in creator''s deletion 30 days out. Stops Gmail, revokes share links, removes assistant drafts, reverses a positive credit balance, and cancels local Rebill subscriptions. Returns provider subscription ids so the server can cancel them at Rebill. Does not take a user id and does not refund.';

revoke all on function public.request_own_account_deletion(text)
  from public, anon, authenticated;
grant execute on function public.request_own_account_deletion(text)
  to authenticated, service_role;

comment on function public.erase_creator_account(uuid) is
  'D151 and D161. Removes one due creator and the personal rows that name them, including Gmail send attempts and sent events. Remembers Rebill provider ids with no user id before the delete. service_role only.';

revoke all on function public.erase_creator_account(uuid)
  from public, anon, authenticated;
grant execute on function public.erase_creator_account(uuid) to service_role;

comment on function public.create_own_rebill_checkout(text) is
  'Creates a pending checkout for auth.uid(). The price is credit_config. A deletion-pending account is refused and no row is inserted. There is no user id argument. This does not grant access.';

revoke all on function public.create_own_rebill_checkout(text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_own_rebill_checkout(text)
  to authenticated, service_role;

comment on function public.apply_rebill_event(jsonb) is
  'Applies one verified Rebill event. The account comes from a checkout or subscription row, never from a payload user id. A monthly refund removes that payment''s slice and does not set a past_due subscription back to active. A pack chargeback after a refund still reverses the full grant and may go below zero. A chargeback still ends the subscription, including after a refund of the same payment. An approved payment for a deletion-pending or deleted account is queued as refund_required and is not granted. Service role only.';

revoke all on function public.apply_rebill_event(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.apply_rebill_event(jsonb) to service_role;

comment on function public.ai_pool_snapshot(bigint, integer) is
  'D163 and D188. Service role only. This month''s pool in micros and the real token spend against it. Percent is clamped to 15–20. The floor has no $100,000 cap. No prompt.';

revoke all on function public.ai_pool_snapshot(bigint, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.ai_pool_snapshot(bigint, integer) to service_role;

alter table public.hotel_media drop constraint hotel_media_forbes_bucket;
alter table public.hotel_media add constraint hotel_media_forbes_bucket check (
  source <> 'forbes'
  or (
    status = 'active'
    and storage_bucket = 'hotel-media'
  )
  or (
    status = 'hidden'
    and storage_bucket in ('hotel-media', 'hotel-media-private')
  )
);

comment on function public.hide_hotel_media(uuid) is
  'D189 takedown. Admin or editor only. Sets status=hidden and moves Forbes objects into hotel-media-private. Does not delete the object. SECURITY DEFINER. search_path is empty.';

revoke all on function public.hide_hotel_media(uuid) from public, anon;
grant execute on function public.hide_hotel_media(uuid) to authenticated, service_role;

create or replace function public.unhide_hotel_media(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.hotel_media%rowtype;
  v_role text;
begin
  if p_id is null or not public.is_admin_or_editor() then
    return false;
  end if;

  select m.*
    into v_row
    from public.hotel_media m
   where m.id = p_id
     and m.status = 'hidden'
   for update;

  if not found then
    return false;
  end if;

  if v_row.source = 'forbes'
     and v_row.storage_path is not null
     and pg_catalog.to_regclass('storage.objects') is not null
  then
    update storage.objects o
       set bucket_id = 'hotel-media'
     where o.bucket_id = 'hotel-media-private'
       and o.name in (
         v_row.storage_path || '/w480.webp',
         v_row.storage_path || '/w1280.webp'
       );
  end if;

  v_role := v_row.role;
  if v_role = 'cover' and exists (
    select 1
      from public.hotel_media m
     where m.hotel_id = v_row.hotel_id
       and m.status = 'active'
       and m.role = 'cover'
       and m.id <> v_row.id
  ) then
    v_role := 'gallery';
  end if;

  update public.hotel_media
     set status = 'active',
         role = v_role,
         storage_bucket = case
           when source = 'forbes' then 'hotel-media'
           else storage_bucket
         end
   where id = p_id
     and status = 'hidden';
  return true;
end;
$$;

comment on function public.unhide_hotel_media(uuid) is
  'Restores a hidden photograph. Admin or editor only. Moves Forbes objects back to the public bucket and sets status=active. Does not delete. SECURITY DEFINER. search_path is empty.';

revoke all on function public.unhide_hotel_media(uuid) from public, anon;
grant execute on function public.unhide_hotel_media(uuid) to authenticated, service_role;

-- Public GET of an exact path uses the public bucket. A SELECT policy is what
-- lets anon list names, so this drops that policy and does not recreate it.
do $hotel_media_private$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice '0106: storage schema is absent; hotel-media-private was not created';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('hotel-media-private', 'hotel-media-private', false, 2097152, array['image/webp'])
  on conflict (id) do update
    set name = excluded.name,
        public = false,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  execute 'drop policy if exists hotel_media_public_read on storage.objects';
end
$hotel_media_private$;
