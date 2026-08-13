-- 0019_save_to_pipeline_rpc.sql
-- Sprint 2B: transactional Save-to-Pipeline (PRD §7.3/§8, DECISIONS D023/D042).
--
-- Saving a hotel must ATOMICALLY create a `saved` pipeline_items row and its
-- single `hotel_saved` outreach_events row, be idempotent under retries and
-- concurrency, and enforce the Free open-relationship limit race-safely. A pair
-- of independent PostgREST inserts cannot provide any of those guarantees, so
-- the operation lives in one SECURITY DEFINER function.
--
-- Privilege surface is deliberately minimal: the function is callable ONLY by
-- service_role (trusted server code). It is never exposed to the browser —
-- hosted Supabase projects may grant EXECUTE to client roles by default, so
-- 0018's hardening pattern is repeated here explicitly.
--
-- Additive; migrations 0001–0018 are unchanged.

create or replace function public.save_hotel_to_pipeline(
  p_user_id uuid,
  p_hotel_id uuid,
  p_free_saved_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_creator_id uuid;
  v_destination_id uuid;
  v_existing_id uuid;
  v_existing_status text;
  v_open_count integer;
  v_has_premium boolean;
  v_next_cycle integer;
  v_pipeline_id uuid;
begin
  -- Identity is derived here from the authenticated user id supplied by trusted
  -- server code. A creator_id is NEVER accepted from the caller.
  if p_user_id is null or p_hotel_id is null then
    return jsonb_build_object('result', 'error');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return jsonb_build_object('result', 'creator_profile_missing');
  end if;

  -- The hotel must exist; capture its destination for the entitlement check.
  select h.destination_id into v_destination_id
    from public.hotels h
   where h.id = p_hotel_id;

  if not found then
    return jsonb_build_object('result', 'hotel_not_found');
  end if;

  -- Serialize this creator's save operations. Locking the creator row makes the
  -- limit check and the insert one atomic decision, so two concurrent saves for
  -- DIFFERENT hotels cannot both observe count = limit - 1 and both succeed.
  perform 1 from public.creator_profiles where id = v_creator_id for update;

  -- Idempotency: an existing non-closed cycle is the authoritative answer.
  -- Returning it (rather than inserting) also guarantees exactly one
  -- hotel_saved event per relationship cycle.
  select pi.id, pi.status into v_existing_id, v_existing_status
    from public.pipeline_items pi
   where pi.creator_id = v_creator_id
     and pi.hotel_id = p_hotel_id
     and pi.status <> 'closed'
   limit 1;

  if v_existing_id is not null then
    return jsonb_build_object(
      'result', 'already_saved',
      'pipeline_item_id', v_existing_id,
      'status', v_existing_status
    );
  end if;

  -- Entitlement is resolved from the database's own source of truth, never from
  -- a caller-supplied flag. Premium coverage = active Pro, or an active
  -- destination entitlement covering this hotel's destination hierarchy.
  v_has_premium := public._has_active_pro(p_user_id)
    or (
      v_destination_id is not null
      and public._has_active_destination_access(p_user_id, v_destination_id)
    );

  if not v_has_premium then
    -- Free plan: cap OPEN (non-closed) relationships. `closed` cycles are
    -- history and do not count (D023 defines openness; D042 defines the Free
    -- allowance). The limit value is passed in from typed server config.
    select count(*) into v_open_count
      from public.pipeline_items pi
     where pi.creator_id = v_creator_id
       and pi.status <> 'closed';

    if v_open_count >= coalesce(p_free_saved_limit, 0) then
      return jsonb_build_object(
        'result', 'limit_reached',
        'open_count', v_open_count,
        'limit', p_free_saved_limit
      );
    end if;
  end if;

  -- A new cycle continues the historical numbering for this creator+hotel.
  select coalesce(max(pi.cycle_number), 0) + 1 into v_next_cycle
    from public.pipeline_items pi
   where pi.creator_id = v_creator_id
     and pi.hotel_id = p_hotel_id;

  insert into public.pipeline_items
    (creator_id, hotel_id, status, cycle_number, saved_at, last_activity_at)
  values
    (v_creator_id, p_hotel_id, 'saved', v_next_cycle, now(), now())
  returning id into v_pipeline_id;

  -- Exactly one hotel_saved event per newly created cycle. This event does NOT
  -- feed hotel_intelligence / destination_intelligence (EVENTS.md §3).
  insert into public.outreach_events
    (creator_id, hotel_id, pipeline_item_id, event_type, event_at, source)
  values
    (v_creator_id, p_hotel_id, v_pipeline_id, 'hotel_saved', now(), 'manual_creator');

  return jsonb_build_object(
    'result', 'created',
    'pipeline_item_id', v_pipeline_id,
    'status', 'saved',
    'cycle_number', v_next_cycle
  );

exception
  -- Belt-and-braces for a concurrent insert that beat us to the partial unique
  -- index: report the winning row instead of surfacing a constraint violation.
  when unique_violation then
    select pi.id, pi.status into v_existing_id, v_existing_status
      from public.pipeline_items pi
     where pi.creator_id = v_creator_id
       and pi.hotel_id = p_hotel_id
       and pi.status <> 'closed'
     limit 1;
    if v_existing_id is null then
      return jsonb_build_object('result', 'error');
    end if;
    return jsonb_build_object(
      'result', 'already_saved',
      'pipeline_item_id', v_existing_id,
      'status', v_existing_status
    );
end;
$$;

comment on function public.save_hotel_to_pipeline(uuid, uuid, integer) is
  'Transactional, idempotent Save-to-Pipeline. Trusted server code only (service_role): derives creator_profile from the authenticated user id, enforces the Free open-relationship limit race-safely, and emits exactly one hotel_saved event per new cycle.';

-- ===========================================================================
-- Privilege surface. Hosted Supabase projects can grant EXECUTE to client roles
-- via default privileges, so revoke explicitly before granting (cf. 0018).
-- ===========================================================================
revoke all on function public.save_hotel_to_pipeline(uuid, uuid, integer)
  from public, anon, authenticated;

grant execute on function public.save_hotel_to_pipeline(uuid, uuid, integer)
  to service_role;
