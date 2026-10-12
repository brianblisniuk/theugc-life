-- 0043_grant_access_entitlement_hardening.sql
-- Baseline trust audit corrections for grant_access_entitlement (0042):
--  * p_source is required (a NULL source silently disabled idempotency, because
--    `source = NULL` never matches and the unique index treats NULLs as distinct);
--  * idempotency is race-safe: INSERT .. ON CONFLICT DO NOTHING, then re-select,
--    so two concurrent deliveries of the same reference both succeed with the
--    SAME entitlement instead of one surfacing a unique_violation;
--  * a replay whose (user, access_type, destination) does not match the stored
--    grant returns `source_reference_conflict` WITHOUT the other row's id, so a
--    reused reference can neither grant nor reveal another user's entitlement.
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
begin
  if p_user_id is null or p_access_type is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  if p_source is null or btrim(p_source) = '' then
    return jsonb_build_object('result', 'source_required');
  end if;

  if p_access_type not in ('destination', 'pro') then
    return jsonb_build_object('result', 'invalid_access_type');
  end if;

  if p_access_type = 'destination' and p_destination_id is null then
    return jsonb_build_object('result', 'destination_required');
  end if;

  if p_access_type = 'pro' and p_destination_id is not null then
    return jsonb_build_object('result', 'pro_cannot_have_destination');
  end if;

  insert into public.access_entitlements (
    user_id, access_type, destination_id, source, source_reference,
    starts_at, expires_at, status
  ) values (
    p_user_id, p_access_type, p_destination_id, p_source, p_source_reference,
    coalesce(p_starts_at, now()), p_expires_at, 'active'
  )
  on conflict (source, source_reference) where source_reference is not null
  do nothing
  returning id into v_id;

  if v_id is not null then
    return jsonb_build_object('result', 'granted', 'entitlement_id', v_id);
  end if;

  -- Conflict: the reference was already used. New statement => new snapshot
  -- under READ COMMITTED, so a concurrently committed winner is visible here.
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

revoke all on function public.grant_access_entitlement(uuid, text, uuid, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;

grant execute on function public.grant_access_entitlement(uuid, text, uuid, text, text, timestamptz, timestamptz)
  to service_role;
