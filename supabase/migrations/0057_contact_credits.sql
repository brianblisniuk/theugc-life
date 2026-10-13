-- 0057_contact_credits.sql
-- F05 contact-credit foundation (D100–D105).
--
-- One credit unlocks one hotel's contact email(s) for one user. The balance is
-- the sum of an append-only ledger. A Pass or Pro row does not reveal a
-- contact. Payment is not an entitlement (D007). Numbers live in credit_config,
-- not in this function. The real contact provider is not callable from here.

-- ---------------------------------------------------------------------------
-- Config. One row. The application module CREDITS_CONFIG must match it.
-- Open amounts are pending owner config (D101).
-- ---------------------------------------------------------------------------

create table public.credit_config (
  id boolean primary key default true check (id),
  free_credits integer not null check (free_credits >= 0),
  pro_monthly_credits integer not null check (pro_monthly_credits >= 0),
  pro_plus_monthly_credits integer not null check (pro_plus_monthly_credits >= 0),
  unlock_cost integer not null check (unlock_cost > 0),
  charge_on_not_found boolean not null,
  cache_ttl_days integer not null check (cache_ttl_days > 0),
  pack_sizes integer[] not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.credit_config is
  'Singleton credit policy. Pending owner numbers (D101). The unlock function reads this row. It does not embed a price.';

create or replace function public.credit_config_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_size integer;
begin
  if new.pack_sizes is null or pg_catalog.cardinality(new.pack_sizes) < 1 then
    raise exception 'credit pack sizes are required' using errcode = '23514';
  end if;
  foreach v_size in array new.pack_sizes loop
    if v_size is null or v_size <= 0 then
      raise exception 'credit pack sizes must be positive' using errcode = '23514';
    end if;
  end loop;
  return new;
end;
$$;

create trigger credit_config_guard
  before insert or update on public.credit_config
  for each row execute function public.credit_config_guard();

create trigger credit_config_set_updated_at
  before update on public.credit_config
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Ledger. Append-only. Balance is the sum. No mutable balance column.
-- ---------------------------------------------------------------------------

create type public.credit_reason as enum (
  'free_grant',
  'plan_grant',
  'pack_purchase',
  'admin_grant',
  'courtesy',
  'unlock',
  'reversal'
);

create table public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id),
  delta integer not null check (delta <> 0),
  reason public.credit_reason not null,
  ref_id text,
  idempotency_key text not null check (char_length(idempotency_key) between 1 and 200),
  created_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

comment on table public.credit_ledger is
  'Append-only credit ledger (D100). No role may update or delete a row. Balance is sum(delta).';

create index credit_ledger_user_created_idx
  on public.credit_ledger (user_id, created_at);

create or replace function public.credit_ledger_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'credit_ledger is append-only' using errcode = '55000';
end;
$$;

create trigger credit_ledger_no_update
  before update on public.credit_ledger
  for each row execute function public.credit_ledger_append_only();

create trigger credit_ledger_no_delete
  before delete on public.credit_ledger
  for each row execute function public.credit_ledger_append_only();

-- ---------------------------------------------------------------------------
-- Cache. One row per hotel. No client select. raw_provider_response stays here
-- and is not granted to a client role because the table is not.
-- ---------------------------------------------------------------------------

create type public.contact_cache_source as enum ('owner_import', 'provider', 'admin');
create type public.contact_cache_status as enum ('found', 'not_found', 'invalid');

create table public.contact_cache (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null unique references public.hotels (id) on delete cascade,
  email text,
  source public.contact_cache_source not null,
  status public.contact_cache_status not null,
  first_unlocked_at timestamptz,
  last_verified_at timestamptz,
  bounce_count integer not null default 0 check (bounce_count >= 0),
  reported_invalid boolean not null default false,
  raw_provider_response jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (status = 'found' and email is not null and char_length(btrim(email)) > 0)
    or status <> 'found'
  )
);

comment on table public.contact_cache is
  'Hotel contact cache. A hit still costs the unlocking user one configured credit. Clients have no select.';

comment on column public.contact_cache.raw_provider_response is
  'Provider payload. Admin/server only. Not a client column.';

create trigger contact_cache_set_updated_at
  before update on public.contact_cache
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Per-user ownership. Re-unlock costs nothing.
-- ---------------------------------------------------------------------------

create table public.contact_unlocks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  ledger_id uuid not null unique references public.credit_ledger (id),
  created_at timestamptz not null default now(),
  unique (user_id, hotel_id)
);

comment on table public.contact_unlocks is
  'One row means this user owns this hotel contact. Another user does not.';

create index contact_unlocks_hotel_idx on public.contact_unlocks (hotel_id);

-- ---------------------------------------------------------------------------
-- Bounce reports. The owner files one. An admin accepts or rejects it.
-- ---------------------------------------------------------------------------

create type public.contact_report_status as enum ('pending', 'accepted', 'rejected');

create table public.contact_reports (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  reason text not null check (char_length(btrim(reason)) between 1 and 500),
  status public.contact_report_status not null default 'pending',
  reviewed_by uuid references public.users (id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index contact_reports_one_pending_idx
  on public.contact_reports (user_id, hotel_id)
  where status = 'pending';

create trigger contact_reports_set_updated_at
  before update on public.contact_reports
  for each row execute function public.set_updated_at();

comment on table public.contact_reports is
  'Owner-filed contact problem. Accept grants one courtesy credit and invalidates the cache.';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public._caller_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.users u
    where u.id = auth.uid()
      and u.role = 'admin'
  );
$$;

create or replace function public.credit_balance(p_user_id uuid)
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
begin
  if p_user_id is null then
    return 0;
  end if;
  if v_caller is null then
    if pg_catalog.current_setting('request.jwt.claims', true) is not null
       and pg_catalog.current_setting('request.jwt.claims', true) not in ('', '{}') then
      raise exception 'credit_balance is private' using errcode = '42501';
    end if;
  elsif v_caller is distinct from p_user_id and not public._caller_is_admin() then
    raise exception 'credit_balance is private' using errcode = '42501';
  end if;
  return coalesce((
    select sum(delta)::integer
    from public.credit_ledger
    where user_id = p_user_id
  ), 0);
end;
$$;

comment on function public.credit_balance(uuid) is
  'Sum of credit_ledger.delta for one user. Not a stored balance. Not granted to authenticated.';

create or replace function public.own_credit_balance()
returns integer
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  return public.credit_balance(v_caller);
end;
$$;

comment on function public.own_credit_balance() is
  'The signed-in user''s credit balance. A missing read is not zero.';

create or replace function public.has_unlocked_hotel_contact(p_hotel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.contact_unlocks u
    where u.user_id = auth.uid()
      and u.hotel_id = p_hotel_id
  );
$$;

comment on function public.has_unlocked_hotel_contact(uuid) is
  'True only when auth.uid() owns this hotel unlock. A Pass or Pro row is not an unlock.';

create or replace function public.read_own_unlocked_contact(p_hotel_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
  v_email text;
  v_status text;
begin
  if v_caller is null then
    return jsonb_build_object('email', null, 'status', null);
  end if;
  if not public.has_unlocked_hotel_contact(p_hotel_id)
     and not public.is_admin_or_editor() then
    return jsonb_build_object('email', null, 'status', null);
  end if;
  select c.email, c.status::text
    into v_email, v_status
  from public.contact_cache c
  where c.hotel_id = p_hotel_id
    and c.status = 'found';
  if v_status is distinct from 'found' then
    v_email := null;
  end if;
  return jsonb_build_object('email', v_email, 'status', v_status);
end;
$$;

comment on function public.read_own_unlocked_contact(uuid) is
  'Cache email for a hotel this user unlocked, or for admin/editor. No raw provider payload.';

create or replace function public.grant_free_credits(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_amount integer;
begin
  if p_user_id is null then
    return;
  end if;
  select free_credits into v_amount from public.credit_config where id;
  if v_amount is null then
    raise exception 'credit config missing' using errcode = '55000';
  end if;
  if v_amount = 0 then
    return;
  end if;
  insert into public.credit_ledger (user_id, delta, reason, idempotency_key)
  values (p_user_id, v_amount, 'free_grant', 'free_grant:v1')
  on conflict (user_id, idempotency_key) do nothing;
end;
$$;

comment on function public.grant_free_credits(uuid) is
  'One Free grant per user, key free_grant:v1. Amount is credit_config.free_credits. Not client-executable.';

-- ---------------------------------------------------------------------------
-- Unlock. Lock the user, then ownership, balance, and cache.
-- needs_provider means the server may call the fake adapter and retry.
-- ---------------------------------------------------------------------------

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
  v_cost integer;
  v_charge boolean;
  v_ttl integer;
  v_balance integer;
  v_cache public.contact_cache%rowtype;
  v_fresh boolean;
  v_ledger_id uuid;
  v_email text;
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

  if not exists (select 1 from public.hotels h where h.id = p_hotel_id) then
    return jsonb_build_object('status', 'hotel_missing', 'email', null);
  end if;

  select unlock_cost, charge_on_not_found, cache_ttl_days
    into v_cost, v_charge, v_ttl
  from public.credit_config
  where id;

  if v_cost is null or v_ttl is null or v_charge is null then
    raise exception 'credit config missing' using errcode = '55000';
  end if;

  select * into v_cache from public.contact_cache where hotel_id = p_hotel_id;
  v_fresh := found
    and v_cache.status <> 'invalid'
    and v_cache.last_verified_at is not null
    and v_cache.last_verified_at > pg_catalog.now() - pg_catalog.make_interval(days => v_ttl);

  if exists (
    select 1 from public.contact_unlocks u
    where u.user_id = v_uid and u.hotel_id = p_hotel_id
  ) then
    if v_fresh and v_cache.status = 'found' then
      return jsonb_build_object(
        'status', 'already_unlocked',
        'email', v_cache.email,
        'balance', public.credit_balance(v_uid)
      );
    end if;
    if not v_fresh then
      return jsonb_build_object(
        'status', 'needs_provider',
        'email', null,
        'balance', public.credit_balance(v_uid)
      );
    end if;
    return jsonb_build_object(
      'status', 'already_unlocked',
      'email', null,
      'balance', public.credit_balance(v_uid)
    );
  end if;

  if exists (
    select 1 from public.credit_ledger l
    where l.user_id = v_uid and l.idempotency_key = p_idempotency_key
  ) then
    return jsonb_build_object('status', 'idempotent_replay', 'email', null);
  end if;

  if not v_fresh then
    return jsonb_build_object(
      'status', 'needs_provider',
      'email', null,
      'balance', public.credit_balance(v_uid)
    );
  end if;

  if v_cache.status = 'not_found' and not v_charge then
    return jsonb_build_object(
      'status', 'not_found',
      'email', null,
      'balance', public.credit_balance(v_uid)
    );
  end if;

  if v_cache.status = 'found' and (v_cache.email is null or char_length(btrim(v_cache.email)) = 0) then
    return jsonb_build_object('status', 'needs_provider', 'email', null);
  end if;

  v_balance := public.credit_balance(v_uid);
  if v_balance < v_cost then
    return jsonb_build_object('status', 'insufficient_credits', 'email', null, 'balance', v_balance);
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
    'balance', v_balance - v_cost
  );
end;
$$;

comment on function public.unlock_hotel_contact(uuid, text) is
  'Atomic per-user unlock. Already owned costs nothing. A cache hit still debits credit_config.unlock_cost. A miss returns needs_provider and does not debit. Insufficient balance returns no email and writes no row.';

create or replace function public.upsert_contact_cache(
  p_hotel_id uuid,
  p_email text,
  p_status text,
  p_raw jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status public.contact_cache_status;
  v_email text;
begin
  if p_hotel_id is null or p_status not in ('found', 'not_found') then
    raise exception 'cache status must be found or not_found' using errcode = '22023';
  end if;
  if not exists (select 1 from public.hotels h where h.id = p_hotel_id) then
    raise exception 'hotel missing' using errcode = '23503';
  end if;
  v_status := p_status::public.contact_cache_status;
  v_email := nullif(btrim(coalesce(p_email, '')), '');
  if v_status = 'found' and v_email is null then
    raise exception 'a found cache row needs an email' using errcode = '23514';
  end if;
  if v_status = 'not_found' then
    v_email := null;
  end if;

  insert into public.contact_cache (
    hotel_id, email, source, status, last_verified_at, raw_provider_response
  )
  values (
    p_hotel_id, v_email, 'provider', v_status, pg_catalog.now(), p_raw
  )
  on conflict (hotel_id) do update
    set email = excluded.email,
        source = 'provider',
        status = excluded.status,
        last_verified_at = pg_catalog.now(),
        raw_provider_response = excluded.raw_provider_response,
        reported_invalid = false;
end;
$$;

comment on function public.upsert_contact_cache(uuid, text, text, jsonb) is
  'Service-role cache write after the fake provider returns. Source becomes provider. Not granted to authenticated.';

create or replace function public.admin_grant_credits(
  p_user_id uuid,
  p_amount integer,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public._caller_is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  if p_user_id is null or p_amount is null or p_amount <= 0 then
    raise exception 'grant amount must be positive' using errcode = '22023';
  end if;
  if p_idempotency_key is null or char_length(btrim(p_idempotency_key)) < 1 then
    raise exception 'idempotency key is required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.users u where u.id = p_user_id) then
    return jsonb_build_object('status', 'user_missing');
  end if;

  insert into public.credit_ledger (user_id, delta, reason, idempotency_key)
  values (p_user_id, p_amount, 'admin_grant', p_idempotency_key)
  on conflict (user_id, idempotency_key) do nothing;

  return jsonb_build_object(
    'status', 'granted',
    'balance', public.credit_balance(p_user_id)
  );
end;
$$;

comment on function public.admin_grant_credits(uuid, integer, text) is
  'Pilot credit grant. Admin session only. A repeat of the same key does not add a second row. Not a payment.';

create or replace function public.review_contact_report(
  p_report_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report public.contact_reports%rowtype;
  v_cost integer;
begin
  if not public._caller_is_admin() then
    raise exception 'admin required' using errcode = '42501';
  end if;
  if p_decision not in ('accept', 'reject') then
    raise exception 'decision must be accept or reject' using errcode = '22023';
  end if;

  select * into v_report from public.contact_reports where id = p_report_id for update;
  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;

  if v_report.status = 'accepted' and p_decision = 'accept' then
    return jsonb_build_object('status', 'accepted', 'hotel_id', v_report.hotel_id);
  end if;
  if v_report.status = 'rejected' and p_decision = 'reject' then
    return jsonb_build_object('status', 'rejected', 'hotel_id', v_report.hotel_id);
  end if;
  if v_report.status <> 'pending' then
    return jsonb_build_object('status', 'already_reviewed', 'hotel_id', v_report.hotel_id);
  end if;

  if p_decision = 'reject' then
    update public.contact_reports
       set status = 'rejected',
           reviewed_by = auth.uid(),
           reviewed_at = pg_catalog.now()
     where id = p_report_id;
    return jsonb_build_object('status', 'rejected', 'hotel_id', v_report.hotel_id);
  end if;

  select unlock_cost into v_cost from public.credit_config where id;
  if v_cost is null then
    raise exception 'credit config missing' using errcode = '55000';
  end if;

  insert into public.credit_ledger (user_id, delta, reason, ref_id, idempotency_key)
  values (
    v_report.user_id,
    v_cost,
    'courtesy',
    p_report_id::text,
    'courtesy:' || p_report_id::text
  )
  on conflict (user_id, idempotency_key) do nothing;

  update public.contact_cache
     set status = 'invalid',
         reported_invalid = true,
         bounce_count = bounce_count + 1
   where hotel_id = v_report.hotel_id;

  update public.contact_reports
     set status = 'accepted',
         reviewed_by = auth.uid(),
         reviewed_at = pg_catalog.now()
   where id = p_report_id;

  return jsonb_build_object('status', 'accepted', 'hotel_id', v_report.hotel_id);
end;
$$;

comment on function public.review_contact_report(uuid, text) is
  'Admin accept grants credit_config.unlock_cost as courtesy and marks the cache invalid. Reject grants nothing.';

-- ---------------------------------------------------------------------------
-- RLS. Contacts follow unlock ownership, or admin/editor. Pass stays for
-- intelligence only.
-- ---------------------------------------------------------------------------

alter table public.credit_config enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.contact_cache enable row level security;
alter table public.contact_unlocks enable row level security;
alter table public.contact_reports enable row level security;

drop policy if exists hotel_contacts_select on public.hotel_contacts;
create policy hotel_contacts_select on public.hotel_contacts
  for select
  using (
    public.is_admin_or_editor()
    or public.has_unlocked_hotel_contact(hotel_id)
  );

create policy credit_ledger_select on public.credit_ledger
  for select
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.role = 'admin'
    )
  );

create policy contact_unlocks_select on public.contact_unlocks
  for select
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.role = 'admin'
    )
  );

create policy contact_reports_select on public.contact_reports
  for select
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.role = 'admin'
    )
  );

create policy contact_reports_insert on public.contact_reports
  for insert
  with check (
    user_id = auth.uid()
    and status = 'pending'
    and reviewed_by is null
    and exists (
      select 1 from public.contact_unlocks u
      where u.user_id = auth.uid()
        and u.hotel_id = contact_reports.hotel_id
    )
  );

create policy contact_reports_update on public.contact_reports
  for update
  using (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.role = 'admin'
    )
  )
  with check (
    exists (
      select 1 from public.users u
      where u.id = auth.uid() and u.role = 'admin'
    )
  );

-- No client policy on contact_cache or credit_config.

-- ---------------------------------------------------------------------------
-- Grants. Ledger and unlocks are not client-writable. Cache is not client-readable.
-- ---------------------------------------------------------------------------

revoke all on table
  public.credit_config,
  public.credit_ledger,
  public.contact_cache,
  public.contact_unlocks,
  public.contact_reports
from public, anon, authenticated, service_role;

grant select on table public.credit_ledger to authenticated;
grant select on table public.credit_ledger to service_role;

grant select on table public.contact_unlocks to authenticated;
grant select on table public.contact_unlocks to service_role;

grant select, insert, update on table public.contact_reports to authenticated;
grant select, insert, update, delete on table public.contact_reports to service_role;

grant select on table public.credit_config to service_role;
grant select, insert, update, delete on table public.contact_cache to service_role;

revoke all on function public.credit_config_guard() from public, anon, authenticated, service_role;
revoke all on function public.credit_ledger_append_only() from public, anon, authenticated, service_role;

revoke all on function public._caller_is_admin() from public, anon, authenticated, service_role;
grant execute on function public._caller_is_admin() to service_role;

revoke all on function public.credit_balance(uuid) from public, anon, authenticated, service_role;
grant execute on function public.credit_balance(uuid) to service_role;

revoke all on function public.own_credit_balance() from public, anon, authenticated, service_role;
grant execute on function public.own_credit_balance() to authenticated, service_role;

revoke all on function public.has_unlocked_hotel_contact(uuid) from public, anon, authenticated, service_role;
grant execute on function public.has_unlocked_hotel_contact(uuid) to authenticated, service_role;

revoke all on function public.read_own_unlocked_contact(uuid) from public, anon, authenticated, service_role;
grant execute on function public.read_own_unlocked_contact(uuid) to authenticated, service_role;

revoke all on function public.grant_free_credits(uuid) from public, anon, authenticated, service_role;

revoke all on function public.unlock_hotel_contact(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.unlock_hotel_contact(uuid, text) to authenticated, service_role;

revoke all on function public.upsert_contact_cache(uuid, text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.upsert_contact_cache(uuid, text, text, jsonb) to service_role;

revoke all on function public.admin_grant_credits(uuid, integer, text) from public, anon, authenticated, service_role;
grant execute on function public.admin_grant_credits(uuid, integer, text) to authenticated, service_role;

revoke all on function public.review_contact_report(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.review_contact_report(uuid, text) to authenticated, service_role;
