-- 0096_hunter_lookup_catalog_qualifiers.sql
-- D180 amendment. Replaces complete_contact_provider_lookup and
-- apply_contact_provider_budget as they stand after 0095.
-- Does not edit 0095. Does not change the function arguments, the grants,
-- or unlock_hotel_contact.
--
-- 0095 calls btrim, coalesce, nullif, and to_char with search_path = ''.
-- pg_temp is still searched first, so an unqualified btrim or to_char can
-- be shadowed in the session that runs the function. This migration
-- qualifies both with pg_catalog.
--
-- COALESCE and NULLIF are parser expressions, not pg_catalog functions.
-- On PostgreSQL 16, pg_proc has no coalesce and no nullif, and
-- pg_catalog.coalesce(...) does not resolve. The email line below calls
-- only pg_catalog.btrim, then treats null and '' as no address. That is
-- the same result as nullif(btrim(coalesce(p_email, '')), '').
--
-- The email check on contact_provider_lookups used an unqualified btrim.
-- It is replaced with the same predicate qualified to pg_catalog.

do $$
declare
  v_name text;
begin
  select con.conname
    into v_name
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class rel on rel.oid = con.conrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = rel.relnamespace
   where nsp.nspname = 'public'
     and rel.relname = 'contact_provider_lookups'
     and con.contype = 'c'
     and pg_catalog.pg_get_constraintdef(con.oid) like '%btrim(email)%'
     and pg_catalog.pg_get_constraintdef(con.oid) not like '%pg_catalog.btrim(email)%';

  if v_name is not null then
    execute format(
      'alter table public.contact_provider_lookups drop constraint %I',
      v_name
    );
  end if;
end
$$;

alter table public.contact_provider_lookups
  drop constraint if exists contact_provider_lookups_email_present;

alter table public.contact_provider_lookups
  add constraint contact_provider_lookups_email_present check (
    (
      status in ('found', 'unverified')
      and email is not null
      and pg_catalog.char_length(pg_catalog.btrim(email)) > 0
    )
    or status in ('pending', 'not_found')
  );

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

  v_email := pg_catalog.btrim(p_email);
  if v_email is null or v_email = '' then
    v_email := null;
  end if;
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
  'Service-role finish of a pending or unverified Hunter lookup. A found or not_found row is left as it is. The email trim is pg_catalog.btrim.';

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

  v_month := pg_catalog.to_char(pg_catalog.statement_timestamp() at time zone 'utc', 'YYYY-MM');

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
  'Service-role Hunter budget. search and verification are separate. Each reserve fails closed at 50 used or when that bucket is exhausted. The month is pg_catalog.to_char of the UTC clock.';
