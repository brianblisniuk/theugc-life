-- 0095_hunter_contact_provider.sql
-- D180. Hunter lookup cache and the monthly search / verification budgets.
-- Does not edit 0057, 0058, 0062, or the credit ledger. Does not change
-- unlock_hotel_contact. A client role gains no privilege.
--
-- contact_provider_lookups is one row per normalized domain, or per named
-- person when Email Finder runs. A second hotel on the same domain reads the
-- row and does not call Hunter. pending is an in-flight claim. unverified
-- means Domain Search or Email Finder already returned a candidate that still
-- needs the Email Verifier, so a retry must not search again.
--
-- contact_provider_budget is one row per UTC month. searches_used is the
-- Hunter search bucket (Domain Search and Email Finder). verifications_used
-- is the Email Verifier bucket and never increments searches_used. Each
-- bucket stops at 50. A Hunter 429 sets the matching exhausted flag for the
-- rest of that month even when the counter is still below 50.

create table public.contact_provider_lookups (
  cache_key text primary key,
  status text not null,
  email text,
  raw_provider_response jsonb,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  -- Length is a separate check. A Postgres bound cannot exceed 255.
  check (
    char_length(cache_key) between 3 and 300
    and cache_key ~ '^[a-z0-9:.-]+$'
  ),
  check (status in ('pending', 'found', 'not_found', 'unverified')),
  check (
    (
      status in ('found', 'unverified')
      and email is not null
      and char_length(btrim(email)) > 0
    )
    or status in ('pending', 'not_found')
  )
);

comment on table public.contact_provider_lookups is
  'Hunter lookup cache. One row per domain or named person. No client select. A hit does not call Hunter again.';

create trigger contact_provider_lookups_set_updated_at
  before update on public.contact_provider_lookups
  for each row execute function public.set_updated_at();

create table public.contact_provider_budget (
  month_key text primary key,
  searches_used integer not null default 0,
  verifications_used integer not null default 0,
  searches_exhausted boolean not null default false,
  verifications_exhausted boolean not null default false,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  check (month_key ~ '^[0-9]{4}-[0-9]{2}$'),
  check (searches_used >= 0 and searches_used <= 50),
  check (verifications_used >= 0 and verifications_used <= 50)
);

comment on table public.contact_provider_budget is
  'Global Hunter budget for one UTC month. Search credits and verifications are separate. Both fail closed at 50.';

create trigger contact_provider_budget_set_updated_at
  before update on public.contact_provider_budget
  for each row execute function public.set_updated_at();

alter table public.contact_provider_lookups enable row level security;
alter table public.contact_provider_budget enable row level security;

revoke all on table public.contact_provider_lookups, public.contact_provider_budget
  from public, anon, authenticated, service_role;

grant select, insert, update, delete on table public.contact_provider_lookups to service_role;
grant select, insert, update, delete on table public.contact_provider_budget to service_role;

-- ---------------------------------------------------------------------------
-- Claim. A terminal row is a hit. A fresh pending row belongs to another
-- caller. A missing or stale pending row becomes this caller's claim.
-- ---------------------------------------------------------------------------

create or replace function public.claim_contact_provider_lookup(p_cache_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.contact_provider_lookups%rowtype;
begin
  if p_cache_key is null
     or pg_catalog.char_length(p_cache_key) < 3
     or pg_catalog.char_length(p_cache_key) > 300
     or p_cache_key !~ '^[a-z0-9:.-]+$' then
    raise exception 'cache key is invalid' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('theugc.contact_provider_lookup'),
    pg_catalog.hashtext(p_cache_key)
  );

  select * into v_row
    from public.contact_provider_lookups
   where cache_key = p_cache_key
   for update;

  if found and v_row.status in ('found', 'not_found', 'unverified') then
    return pg_catalog.jsonb_build_object(
      'outcome', 'hit',
      'status', v_row.status,
      'email', v_row.email,
      'raw', v_row.raw_provider_response
    );
  end if;

  if found
     and v_row.status = 'pending'
     and v_row.updated_at > pg_catalog.now() - interval '2 minutes' then
    return pg_catalog.jsonb_build_object('outcome', 'pending');
  end if;

  if found then
    update public.contact_provider_lookups
       set status = 'pending',
           email = null,
           raw_provider_response = null
     where cache_key = p_cache_key
       and status = 'pending';
  else
    insert into public.contact_provider_lookups (cache_key, status)
    values (p_cache_key, 'pending');
  end if;

  return pg_catalog.jsonb_build_object('outcome', 'claimed');
end;
$$;

comment on function public.claim_contact_provider_lookup(text) is
  'Service-role claim of one Hunter lookup. A stored found, not_found, or unverified row is returned. A fresh pending row is not claimed again.';

create or replace function public.complete_contact_provider_lookup(
  p_cache_key text,
  p_status text,
  p_email text,
  p_raw jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
begin
  if p_cache_key is null
     or pg_catalog.char_length(p_cache_key) < 3
     or pg_catalog.char_length(p_cache_key) > 300
     or p_cache_key !~ '^[a-z0-9:.-]+$' then
    raise exception 'cache key is invalid' using errcode = '22023';
  end if;
  if p_status not in ('found', 'not_found', 'unverified') then
    raise exception 'lookup status is invalid' using errcode = '22023';
  end if;

  v_email := nullif(btrim(coalesce(p_email, '')), '');
  if p_status = 'not_found' then
    v_email := null;
  elsif v_email is null then
    raise exception 'a stored candidate needs an email' using errcode = '23514';
  end if;

  update public.contact_provider_lookups
     set status = p_status,
         email = v_email,
         raw_provider_response = p_raw
   where cache_key = p_cache_key
     and status in ('pending', 'unverified');
end;
$$;

comment on function public.complete_contact_provider_lookup(text, text, text, jsonb) is
  'Service-role finish of a pending or unverified Hunter lookup. A found or not_found row is left as it is.';

create or replace function public.abandon_contact_provider_lookup(p_cache_key text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_cache_key is null
     or pg_catalog.char_length(p_cache_key) < 3
     or pg_catalog.char_length(p_cache_key) > 300
     or p_cache_key !~ '^[a-z0-9:.-]+$' then
    raise exception 'cache key is invalid' using errcode = '22023';
  end if;

  delete from public.contact_provider_lookups
   where cache_key = p_cache_key
     and status = 'pending';
end;
$$;

comment on function public.abandon_contact_provider_lookup(text) is
  'Service-role delete of a pending claim. A found, not_found, or unverified row stays.';

-- ---------------------------------------------------------------------------
-- Budget. The month is the UTC clock, not an argument. reserve fails closed
-- at 50 or when the bucket is exhausted. release undoes a reserve that Hunter
-- did not count. exhaust sticks for the rest of the month.
-- ---------------------------------------------------------------------------

create or replace function public.apply_contact_provider_budget(
  p_bucket text,
  p_op text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month text;
  v_row public.contact_provider_budget%rowtype;
  v_used integer;
  v_exhausted boolean;
begin
  if p_bucket not in ('search', 'verification') or p_op not in ('reserve', 'release', 'exhaust') then
    raise exception 'budget request is invalid' using errcode = '22023';
  end if;

  v_month := to_char(pg_catalog.statement_timestamp() at time zone 'utc', 'YYYY-MM');

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('theugc.contact_provider_budget'),
    pg_catalog.hashtext(v_month)
  );

  insert into public.contact_provider_budget (month_key)
  values (v_month)
  on conflict (month_key) do nothing;

  select * into v_row
    from public.contact_provider_budget
   where month_key = v_month
   for update;

  if p_bucket = 'search' then
    v_used := v_row.searches_used;
    v_exhausted := v_row.searches_exhausted;
  else
    v_used := v_row.verifications_used;
    v_exhausted := v_row.verifications_exhausted;
  end if;

  if p_op = 'exhaust' then
    if p_bucket = 'search' then
      update public.contact_provider_budget
         set searches_exhausted = true
       where month_key = v_month;
    else
      update public.contact_provider_budget
         set verifications_exhausted = true
       where month_key = v_month;
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'ok', 'used', v_used);
  end if;

  if p_op = 'release' then
    if v_used > 0 and not v_exhausted then
      if p_bucket = 'search' then
        update public.contact_provider_budget
           set searches_used = searches_used - 1
         where month_key = v_month;
      else
        update public.contact_provider_budget
           set verifications_used = verifications_used - 1
         where month_key = v_month;
      end if;
      v_used := v_used - 1;
    end if;
    return pg_catalog.jsonb_build_object('outcome', 'ok', 'used', v_used);
  end if;

  if v_exhausted or v_used >= 50 then
    return pg_catalog.jsonb_build_object('outcome', 'exhausted', 'used', v_used);
  end if;

  if p_bucket = 'search' then
    update public.contact_provider_budget
       set searches_used = searches_used + 1
     where month_key = v_month;
  else
    update public.contact_provider_budget
       set verifications_used = verifications_used + 1
     where month_key = v_month;
  end if;

  return pg_catalog.jsonb_build_object('outcome', 'reserved', 'used', v_used + 1);
end;
$$;

comment on function public.apply_contact_provider_budget(text, text) is
  'Service-role Hunter budget. search and verification are separate. Each reserve fails closed at 50 used or when that bucket is exhausted. The month is UTC.';

revoke all on function public.claim_contact_provider_lookup(text)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_contact_provider_lookup(text) to service_role;

revoke all on function public.complete_contact_provider_lookup(text, text, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_contact_provider_lookup(text, text, text, jsonb) to service_role;

revoke all on function public.abandon_contact_provider_lookup(text)
  from public, anon, authenticated, service_role;
grant execute on function public.abandon_contact_provider_lookup(text) to service_role;

revoke all on function public.apply_contact_provider_budget(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.apply_contact_provider_budget(text, text) to service_role;
