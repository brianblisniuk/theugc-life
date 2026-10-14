-- 0077_rebill_checkout.sql
-- P02 Rebill checkout records (D135–D139).
--
-- A checkout row names the signed-in account. The client does not supply a
-- user id. A payment link, a purchase, and a subscription are commercial
-- records. None of them grant access. Entitlements are written only by
-- apply_rebill_event (0078), which is service_role and runs after signature
-- verification.

alter table public.subscriptions
  add column plan_tier text,
  add column billing_interval text;

alter table public.subscriptions
  add constraint subscriptions_status_check
  check (status in ('active', 'past_due', 'canceled', 'expired'));

alter table public.subscriptions
  add constraint subscriptions_plan_tier_check
  check (plan_tier is null or plan_tier in ('pro', 'max'));

alter table public.subscriptions
  add constraint subscriptions_billing_interval_check
  check (billing_interval is null or billing_interval in ('month', 'year'));

comment on column public.subscriptions.status is
  'Commercial state only (D139): active, past_due, canceled, or expired. Not access. The column cancelled_at keeps its existing spelling.';

comment on column public.subscriptions.plan_tier is
  'pro or max. A tier on this row does not grant Max or Pro features.';

comment on column public.subscriptions.billing_interval is
  'month or year. Annual access is 12 months from the successful payment. Credits inside that window are still 30 days (D135).';

-- ---------------------------------------------------------------------------
-- Checkout intent. Created for auth.uid() only.
-- ---------------------------------------------------------------------------

create table public.rebill_checkouts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  product_code text not null,
  amount_usd integer not null check (amount_usd > 0),
  currency text not null default 'USD',
  provider_link_id text,
  status text not null default 'pending'
    check (status in ('pending', 'open', 'completed', 'canceled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.rebill_checkouts is
  'Server-created Rebill checkout for auth.uid(). The payment link is not access. A client user id is not stored from the browser.';

create index rebill_checkouts_user_idx on public.rebill_checkouts (user_id);

create unique index rebill_checkouts_link_uidx
  on public.rebill_checkouts (provider_link_id)
  where provider_link_id is not null;

create trigger rebill_checkouts_set_updated_at
  before update on public.rebill_checkouts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Webhook idempotency and the one effect of each payment.
-- No client privileges. A row here is not an entitlement.
-- ---------------------------------------------------------------------------

create table public.rebill_webhook_events (
  id uuid primary key default gen_random_uuid(),
  log_id text not null unique check (char_length(log_id) between 1 and 200),
  event_name text not null,
  payment_id text,
  result text not null,
  created_at timestamptz not null default now()
);

comment on table public.rebill_webhook_events is
  'One row per Rebill webhook.logId. Retries of the same delivery do not apply twice. The row does not grant access.';

create index rebill_webhook_events_payment_idx
  on public.rebill_webhook_events (payment_id)
  where payment_id is not null;

create table public.rebill_payment_effects (
  payment_id text primary key check (char_length(payment_id) between 1 and 80),
  user_id uuid not null references public.users (id) on delete cascade,
  product_code text not null,
  effect text not null check (effect in ('granted', 'revoked')),
  entitlement_id uuid references public.access_entitlements (id),
  subscription_id text,
  created_at timestamptz not null default now()
);

comment on table public.rebill_payment_effects is
  'One commercial effect per Rebill payment id. granted does not itself make has_active_pro true. revoked records a later refund or chargeback.';

create table public.rebill_catalog (
  product_code text primary key,
  provider_plan_id text not null,
  created_at timestamptz not null default now()
);

comment on table public.rebill_catalog is
  'Rebill plan id we created for a product code. Not a price and not an entitlement. Clients cannot read or write it.';

-- ---------------------------------------------------------------------------
-- Prices come from credit_config. The caller cannot name a user or an amount.
-- ---------------------------------------------------------------------------

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

comment on function public.create_own_rebill_checkout(text) is
  'Creates a pending checkout for auth.uid(). The price is credit_config. There is no user id argument. This does not grant access.';

create or replace function public.attach_own_rebill_checkout_link(
  p_checkout_id uuid,
  p_link_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
  v_updated uuid;
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;

  if p_checkout_id is null or p_link_id is null or p_link_id !~ '^pl_[A-Za-z0-9]+$' then
    return jsonb_build_object('result', 'invalid');
  end if;

  update public.rebill_checkouts
     set provider_link_id = p_link_id,
         status = 'open'
   where id = p_checkout_id
     and user_id = v_caller
     and status = 'pending'
     and provider_link_id is null
  returning id into v_updated;

  if v_updated is null then
    return jsonb_build_object('result', 'not_attached');
  end if;

  return jsonb_build_object('result', 'attached', 'checkout_id', v_updated);
end;
$$;

comment on function public.attach_own_rebill_checkout_link(uuid, text) is
  'Stores the Rebill payment link id on the caller''s pending checkout. Cannot attach another user''s row. Does not grant access.';

create or replace function public.record_rebill_plan_id(
  p_product_code text,
  p_plan_id text
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id text;
begin
  if p_product_code is null or p_product_code not in (
    'pro_monthly', 'pro_annual', 'max_monthly', 'max_annual'
  ) then
    raise exception 'invalid product' using errcode = '22023';
  end if;

  if p_plan_id is null or p_plan_id !~ '^pln_[A-Za-z0-9]+$' then
    raise exception 'invalid plan' using errcode = '22023';
  end if;

  insert into public.rebill_catalog (product_code, provider_plan_id)
  values (p_product_code, p_plan_id)
  on conflict (product_code) do nothing;

  select provider_plan_id into v_id
    from public.rebill_catalog
   where product_code = p_product_code;

  return v_id;
end;
$$;

comment on function public.record_rebill_plan_id(text, text) is
  'Stores the first Rebill plan id for a product. Service role only. Not an entitlement.';

alter table public.rebill_checkouts enable row level security;
alter table public.rebill_webhook_events enable row level security;
alter table public.rebill_payment_effects enable row level security;
alter table public.rebill_catalog enable row level security;

create policy rebill_checkouts_select on public.rebill_checkouts
  for select using (user_id = auth.uid() or public.is_admin_or_editor());

revoke all on table
  public.rebill_checkouts,
  public.rebill_webhook_events,
  public.rebill_payment_effects,
  public.rebill_catalog
  from public, anon, authenticated;

grant select on table public.rebill_checkouts to authenticated;

grant select, insert, update, delete on table
  public.rebill_checkouts,
  public.rebill_webhook_events,
  public.rebill_payment_effects,
  public.rebill_catalog
  to service_role;

revoke all on function public.create_own_rebill_checkout(text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_own_rebill_checkout(text)
  to authenticated, service_role;

revoke all on function public.attach_own_rebill_checkout_link(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.attach_own_rebill_checkout_link(uuid, text)
  to authenticated, service_role;

revoke all on function public.record_rebill_plan_id(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_rebill_plan_id(text, text)
  to service_role;
