-- 0041_pipeline_private_notes_rpc.sql
-- Private notes update for pipeline_items.
-- Ownership is derived inside the function from the authenticated user id.
-- Callable only by service_role. No client exposure.

create or replace function public.update_pipeline_private_notes(
  p_user_id uuid,
  p_pipeline_item_id uuid,
  p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_creator_id uuid;
  v_updated integer;
begin
  if p_user_id is null or p_pipeline_item_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return jsonb_build_object('result', 'creator_profile_missing');
  end if;

  update public.pipeline_items
     set private_notes = nullif(trim(p_notes), ''),
         updated_at = now()
   where id = p_pipeline_item_id
     and creator_id = v_creator_id
  returning 1 into v_updated;

  if v_updated is null then
    return jsonb_build_object('result', 'not_found_or_forbidden');
  end if;

  return jsonb_build_object('result', 'updated');
end;
$$;

revoke all on function public.update_pipeline_private_notes(uuid, uuid, text)
  from public, anon, authenticated;

grant execute on function public.update_pipeline_private_notes(uuid, uuid, text)
  to service_role;
