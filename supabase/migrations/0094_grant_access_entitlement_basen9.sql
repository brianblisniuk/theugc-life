-- 0094_grant_access_entitlement_basen9.sql
-- BASE-N9 / D179. Replaces grant_access_entitlement as it stands after 0075.
-- Does not edit 0042, 0043, 0075, or 0088–0093.
--
-- Null p_source_reference used to miss the partial unique index
-- (source, source_reference) WHERE source_reference IS NOT NULL, so the same
-- logical grant inserted another active row. A null reference is now one
-- logical grant: (user_id, access_type, destination_id, source). Status is
-- not part of that key. Exactly one matching row is a safe replay
-- (already_granted, that id). More than one is ambiguous: the call returns
-- ambiguous_null_reference, includes no id, and inserts nothing.
--
-- No new unique index. Existing duplicate null-reference rows must not fail
-- this migration, and a plain unique index would treat a null destination_id
-- as distinct. Concurrent calls take a transaction advisory lock, then
-- re-read, so two deliveries cannot both insert.
--
-- p_expires_at set strictly before the effective starts_at (coalesce of
-- p_starts_at, else now()) returns invalid_expires_at and inserts nothing.
-- A null expiry stays allowed. An expiry equal to starts_at stays allowed.
-- The non-null source_reference path is unchanged: ON CONFLICT DO NOTHING,
-- already_granted on the same identity, source_reference_conflict with no id
-- when the identity differs.
--
-- Still SECURITY DEFINER, search_path pinned, executable by service_role only.

create or replace function public.grant_access_entitlement(
  p_user_id uuid,
  p_access_type text,
  p_destination_id uuid,
  p_source text,
  p_source_reference text,
  p_starts_at timestamptz,
  p_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_existing public.access_entitlements%rowtype;
  v_starts_at timestamptz;
  v_matches integer;
begin
  if p_user_id is null or p_access_type is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  if p_source is null or btrim(p_source) = '' then
    return jsonb_build_object('result', 'source_required');
  end if;

  if p_access_type not in ('destination', 'pro', 'max') then
    return jsonb_build_object('result', 'invalid_access_type');
  end if;

  if p_access_type = 'destination' and p_destination_id is null then
    return jsonb_build_object('result', 'destination_required');
  end if;

  if p_access_type in ('pro', 'max') and p_destination_id is not null then
    return jsonb_build_object(
      'result',
      case
        when p_access_type = 'pro' then 'pro_cannot_have_destination'
        else 'plan_cannot_have_destination'
      end
    );
  end if;

  v_starts_at := coalesce(p_starts_at, pg_catalog.now());
  if p_expires_at is not null and p_expires_at < v_starts_at then
    return jsonb_build_object('result', 'invalid_expires_at');
  end if;

  if p_source_reference is null then
    -- Serialize this logical grant. Direct inserts are not covered; the
    -- function is the grant path, and a unique index would fail closed on
    -- rows that already violate it.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('theugc.grant_access_entitlement.null_ref'),
      pg_catalog.hashtext(
        p_user_id::text
        || '|' || p_access_type
        || '|' || coalesce(p_destination_id::text, '')
        || '|' || p_source
      )
    );

    select count(*)::integer,
           case when count(*) = 1 then (array_agg(e.id))[1] end
      into v_matches, v_id
      from public.access_entitlements e
     where e.user_id = p_user_id
       and e.access_type = p_access_type
       and e.destination_id is not distinct from p_destination_id
       and e.source = p_source
       and e.source_reference is null;

    if v_matches > 1 then
      return jsonb_build_object('result', 'ambiguous_null_reference');
    end if;

    if v_matches = 1 then
      return jsonb_build_object('result', 'already_granted', 'entitlement_id', v_id);
    end if;

    insert into public.access_entitlements (
      user_id, access_type, destination_id, source, source_reference,
      starts_at, expires_at, status
    ) values (
      p_user_id, p_access_type, p_destination_id, p_source, null,
      v_starts_at, p_expires_at, 'active'
    )
    returning id into v_id;

    return jsonb_build_object('result', 'granted', 'entitlement_id', v_id);
  end if;

  insert into public.access_entitlements (
    user_id, access_type, destination_id, source, source_reference,
    starts_at, expires_at, status
  ) values (
    p_user_id, p_access_type, p_destination_id, p_source, p_source_reference,
    v_starts_at, p_expires_at, 'active'
  )
  on conflict (source, source_reference) where source_reference is not null
  do nothing
  returning id into v_id;

  if v_id is not null then
    return jsonb_build_object('result', 'granted', 'entitlement_id', v_id);
  end if;

  select * into v_existing
    from public.access_entitlements
   where source = p_source
     and source_reference = p_source_reference;

  if not found then
    return jsonb_build_object('result', 'error');
  end if;

  if v_existing.user_id = p_user_id
     and v_existing.access_type = p_access_type
     and v_existing.destination_id is not distinct from p_destination_id then
    return jsonb_build_object('result', 'already_granted', 'entitlement_id', v_existing.id);
  end if;

  return jsonb_build_object('result', 'source_reference_conflict');
end;
$$;

comment on function public.grant_access_entitlement(uuid, text, uuid, text, text, timestamptz, timestamptz) is
  'D179. Service-role grant. A null source_reference is one logical grant. A non-null source_reference stays unique. expires_at before starts_at is refused.';

revoke all on function public.grant_access_entitlement(uuid, text, uuid, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;

grant execute on function public.grant_access_entitlement(uuid, text, uuid, text, text, timestamptz, timestamptz)
  to service_role;
