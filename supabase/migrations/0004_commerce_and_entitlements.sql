-- 0004_commerce_and_entitlements.sql
-- Commerce records and authorization entitlements are SEPARATE (D007).
-- Payments describe commercial state; access_entitlements is the authorization
-- source of truth (PRD §15, DATABASE.md §7).

-- ---------------------------------------------------------------------------
-- subscriptions (recurring commercial state)
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  provider text not null,
  provider_customer_id text,
  provider_subscription_id text,
  plan_code text,
  status text not null,
  price_paid numeric,
  currency text,
  started_at timestamptz,
  renews_at timestamptz,
  cancelled_at timestamptz,
  ended_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index subscriptions_user_idx on public.subscriptions (user_id);
-- Idempotency: one row per provider subscription (PRD §15.3).
create unique index subscriptions_provider_sub_uidx
  on public.subscriptions (provider, provider_subscription_id)
  where provider_subscription_id is not null;

create trigger subscriptions_set_updated_at
  before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- purchases (one-off transactions)
-- ---------------------------------------------------------------------------
create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  provider text not null,
  provider_transaction_id text,
  product_type text,
  product_reference text,
  amount numeric,
  currency text,
  status text,
  purchased_at timestamptz,
  refunded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index purchases_user_idx on public.purchases (user_id);
-- Idempotency: repeated webhook delivery must not duplicate purchases (PRD §15.3).
create unique index purchases_provider_txn_uidx
  on public.purchases (provider, provider_transaction_id)
  where provider_transaction_id is not null;

create trigger purchases_set_updated_at
  before update on public.purchases
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- access_entitlements (authorization source of truth)
-- ---------------------------------------------------------------------------
create table public.access_entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  access_type text not null check (access_type in ('free', 'destination', 'pro', 'admin')),
  destination_id uuid references public.destinations(id),
  source text,
  source_reference text,
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  status text not null default 'active'
    check (status in ('active', 'expired', 'revoked', 'pending')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- destination access requires a destination; pro/admin must not carry one
  -- (DATABASE.md §7 invariant).
  constraint access_entitlements_destination_shape check (
    (access_type = 'destination' and destination_id is not null)
    or (access_type in ('pro', 'admin') and destination_id is null)
    or (access_type = 'free')
  )
);

create index access_entitlements_user_idx
  on public.access_entitlements (user_id, status, starts_at, expires_at);
create index access_entitlements_destination_idx
  on public.access_entitlements (destination_id);
-- Idempotency around provider/source references where present (DATABASE.md §7).
create unique index access_entitlements_source_ref_uidx
  on public.access_entitlements (source, source_reference)
  where source_reference is not null;

create trigger access_entitlements_set_updated_at
  before update on public.access_entitlements
  for each row execute function public.set_updated_at();
