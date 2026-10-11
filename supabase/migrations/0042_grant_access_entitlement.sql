-- 0042_grant_access_entitlement.sql
-- Idempotent grant of an access entitlement from a trusted source
-- (webhook, admin, or future payment provider).
-- Identity is derived from the supplied user id; never accepted as a free form.

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
begin
  if p_user_id is null or p_access_type is null then
    return jsonb_build_object('result', 'invalid_input');
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

  -- Idempotency: same source_reference returns the existing row.
  if p_source_reference is not null then
    select id into v_id
      from public.access_entitlements
     where source = p_source
       and source_reference = p_source_reference;
    if v_id is not null then
      return jsonb_build_object('result', 'already_granted', 'entitlement_id', v_id);
    end if;
  end if;

  insert into public.access_entitlements (
    user_id, access_type, destination_id, source, source_reference,
    starts_at, expires_at, status
  ) values (
    p_user_id, p_access_type, p_destination_id, p_source, p_source_reference,
    coalesce(p_starts_at, now()), p_expires_at, 'active'
  )
  returning id into v_id;

  return jsonb_build_object('result', 'granted', 'entitlement_id', v_id);
end;
$$;

revoke all on function public.grant_access_entitlement(uuid, text, uuid, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;

grant execute on function public.grant_access_entitlement(uuid, text, uuid, text, text, timestamptz, timestamptz)
  to service_role;
