-- 0046_trips_context.sql
-- D01 — Trips: destination/date/context + shortlist + trip summary.
--
-- Migration number: 0046. 0045 is reserved for the parallel B07.1 follow-up
-- (fix/b07-1-followups). This file does not take 0045.
--
-- Reuses trips, trip_hotels and pipeline_items.trip_id from 0005. Does not
-- rebuild pipeline, the event ledger, or the collaboration lifecycle.
--
-- Active-trip allowance (PRD §5.1, §5.3.1; FREE_LIMITS.activeTrips).
-- The trip status vocabulary already separates in-progress statuses
-- (planning, upcoming, active) from terminal ones (completed, cancelled)
-- (PRD §9.13, DATABASE.md §8). "1 active trip" uses that vocabulary the same
-- way D023 uses "active" for pipeline cycles: every non-terminal status
-- consumes the allowance; completed and cancelled are history and do not.
-- The number is a parameter from typed server config. It is not a literal here.
--
-- Entitlement (D042, D056, the same helpers save_hotel_to_pipeline uses):
--   * active Pro is exempt worldwide;
--   * an active destination entitlement exempts a trip in that destination
--     (or a descendant);
--   * otherwise the Free allowance applies;
--   * a trip that already counts is still editable after entitlement expiry
--     (D014 — expiry never deletes creator work, and does not freeze it).
--   Entering a counting status from a terminal one re-checks the allowance.
--
-- Writes go through service_role RPCs. Authenticated INSERT/UPDATE/DELETE on
-- trips and trip_hotels is revoked so a direct PostgREST write cannot skip
-- the allowance (PERMISSIONS.md §5.1, same reason 0020 revoked pipeline writes).
-- RLS policies from 0012 stay as defence in depth. SELECT is unchanged.
--
-- Cross-tenant pipeline linking is rejected by a trigger, not only by the RPC,
-- so a service-role bug cannot attach User A's pipeline item to User B's trip.
--
-- Public portfolio exposure of a trip is out of scope. These RPCs never write
-- visibility; the column default remains private.

-- ---------------------------------------------------------------------------
-- Reads: one derived summary. Unknown (JSON null) when the trip has no linked
-- pipeline rows. A real zero is only returned when linked rows exist and that
-- bucket is empty. unknown is not zero.
--
-- SECURITY INVOKER so RLS on trips, pipeline_items, outreach_events and
-- collaborations stays the row boundary. search_path is empty.
-- ---------------------------------------------------------------------------
create or replace function public.trip_workspace_summary(p_trip_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_linked integer;
  v_targets integer;
  v_pitched integer;
  v_replies integer;
  v_negotiations integer;
  v_confirmed integer;
  v_followups integer;
begin
  if p_trip_id is null
     or not exists (select 1 from public.trips t where t.id = p_trip_id) then
    return jsonb_build_object('result', 'not_found');
  end if;

  select count(*)::integer into v_linked
    from public.pipeline_items pi
   where pi.trip_id = p_trip_id;

  if v_linked = 0 then
    return jsonb_build_object(
      'result', 'ok',
      'target_hotels', null,
      'pitched', null,
      'replies', null,
      'negotiations', null,
      'confirmed_collaborations', null,
      'followups_due', null
    );
  end if;

  -- Current targets: open cycles linked to this trip (D023: closed is history).
  select count(*)::integer into v_targets
    from public.pipeline_items pi
   where pi.trip_id = p_trip_id
     and pi.status <> 'closed';

  -- Pitched: the pitch fact, not only the row currently sitting in `pitched`.
  select count(*)::integer into v_pitched
    from public.pipeline_items pi
   where pi.trip_id = p_trip_id
     and (
       pi.first_pitched_at is not null
       or pi.status in ('pitched', 'replied', 'follow_up', 'negotiating', 'won')
       or exists (
         select 1 from public.outreach_events oe
          where oe.pipeline_item_id = pi.id
            and oe.event_type = 'pitch_sent'
       )
     );

  -- Replies: a reply event, or a status that the deal path only reaches
  -- after `replied` (0021: replied → negotiating → won). `follow_up` is not
  -- a reply.
  select count(*)::integer into v_replies
    from public.pipeline_items pi
   where pi.trip_id = p_trip_id
     and (
       pi.status in ('replied', 'negotiating', 'won')
       or exists (
         select 1 from public.outreach_events oe
          where oe.pipeline_item_id = pi.id
            and oe.event_type in ('reply_received', 'positive_reply', 'negative_reply')
       )
     );

  select count(*)::integer into v_negotiations
    from public.pipeline_items pi
   where pi.trip_id = p_trip_id
     and pi.status = 'negotiating';

  -- Confirmed collaborations: a collaboration row that is not cancelled
  -- (D045: agreed is confirmation; cancelled is a later, different fact).
  select count(*)::integer into v_confirmed
    from public.collaborations c
    join public.pipeline_items pi on pi.id = c.pipeline_item_id
   where pi.trip_id = p_trip_id
     and c.status in ('agreed', 'scheduled', 'active', 'completed');

  select count(*)::integer into v_followups
    from public.pipeline_items pi
   where pi.trip_id = p_trip_id
     and pi.status <> 'closed'
     and pi.next_followup_at is not null
     and pi.next_followup_at <= pg_catalog.now();

  return jsonb_build_object(
    'result', 'ok',
    'target_hotels', v_targets,
    'pitched', v_pitched,
    'replies', v_replies,
    'negotiations', v_negotiations,
    'confirmed_collaborations', v_confirmed,
    'followups_due', v_followups
  );
end;
$$;

comment on function public.trip_workspace_summary(uuid) is
  'Read-only trip workspace counts from pipeline items and collaborations linked by trip_id. JSON null means unknown (no linked pipeline rows), which is not zero. Runs as the caller so RLS applies.';

revoke all on function public.trip_workspace_summary(uuid) from public, anon;
grant execute on function public.trip_workspace_summary(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Same-creator fence for pipeline_items.trip_id. Fires for every writer,
-- including service_role. A missing trip and a trip owned by someone else
-- are the same failure: the link is not written.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_pipeline_item_trip_same_creator()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if new.trip_id is null then
    return new;
  end if;

  select t.creator_id into v_owner
    from public.trips t
   where t.id = new.trip_id;

  if v_owner is null or v_owner is distinct from new.creator_id then
    raise exception 'pipeline item and trip must belong to the same creator'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.enforce_pipeline_item_trip_same_creator() is
  'Rejects a pipeline_items.trip_id that points at a trip owned by a different creator, or at a trip that does not exist. SECURITY DEFINER so the check sees the trip row even when the caller cannot.';

revoke all on function public.enforce_pipeline_item_trip_same_creator()
  from public, anon, authenticated;
grant execute on function public.enforce_pipeline_item_trip_same_creator()
  to service_role;

drop trigger if exists pipeline_items_trip_same_creator on public.pipeline_items;
create trigger pipeline_items_trip_same_creator
  before insert or update of trip_id, creator_id on public.pipeline_items
  for each row execute function public.enforce_pipeline_item_trip_same_creator();

create index if not exists pipeline_items_trip_idx
  on public.pipeline_items (trip_id)
  where trip_id is not null;

-- ---------------------------------------------------------------------------
-- Shared shape checks used by the write RPCs. Not a product limit.
-- ---------------------------------------------------------------------------
-- (inlined per function so the privileged surface stays the named RPCs)

create or replace function public.create_trip(
  p_user_id uuid,
  p_destination_id uuid,
  p_name text,
  p_start_date date,
  p_end_date date,
  p_status text,
  p_free_active_trip_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_name text;
  v_limit integer;
  v_exempt boolean;
  v_active integer;
  v_trip_id uuid;
begin
  if p_user_id is null or p_destination_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  if p_status is null
     or p_status not in ('planning', 'upcoming', 'active', 'completed', 'cancelled')
     or p_start_date is null
     or p_end_date is null
     or p_end_date < p_start_date then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  v_name := nullif(btrim(coalesce(p_name, '')), '');
  if v_name is not null and char_length(v_name) > 120 then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return jsonb_build_object('result', 'creator_profile_missing');
  end if;

  if not exists (select 1 from public.destinations d where d.id = p_destination_id) then
    return jsonb_build_object('result', 'destination_not_found');
  end if;

  perform 1 from public.creator_profiles where id = v_creator_id for update;

  v_limit := greatest(coalesce(p_free_active_trip_limit, 0), 0);
  v_exempt := public._has_active_pro(p_user_id)
    or public._has_active_destination_access(p_user_id, p_destination_id);

  if not v_exempt and p_status in ('planning', 'upcoming', 'active') then
    select count(*)::integer into v_active
      from public.trips t
     where t.creator_id = v_creator_id
       and t.status in ('planning', 'upcoming', 'active');

    if v_active >= v_limit then
      return jsonb_build_object(
        'result', 'limit_reached',
        'active_count', v_active,
        'limit', v_limit
      );
    end if;
  end if;

  insert into public.trips (creator_id, destination_id, name, start_date, end_date, status)
  values (v_creator_id, p_destination_id, v_name, p_start_date, p_end_date, p_status)
  returning id into v_trip_id;

  return jsonb_build_object('result', 'created', 'trip_id', v_trip_id, 'status', p_status);
end;
$$;

comment on function public.create_trip(uuid, uuid, text, date, date, text, integer) is
  'Creates one private trip for the authenticated user. Enforces the Free active-trip allowance race-safely unless Pro or a covering destination entitlement exempts this destination. Never writes visibility.';

create or replace function public.update_trip(
  p_user_id uuid,
  p_trip_id uuid,
  p_destination_id uuid,
  p_name text,
  p_start_date date,
  p_end_date date,
  p_status text,
  p_free_active_trip_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_name text;
  v_old_status text;
  v_limit integer;
  v_exempt boolean;
  v_active integer;
  v_increases boolean;
begin
  if p_user_id is null or p_trip_id is null or p_destination_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  if p_status is null
     or p_status not in ('planning', 'upcoming', 'active', 'completed', 'cancelled')
     or p_start_date is null
     or p_end_date is null
     or p_end_date < p_start_date then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  v_name := nullif(btrim(coalesce(p_name, '')), '');
  if v_name is not null and char_length(v_name) > 120 then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return jsonb_build_object('result', 'creator_profile_missing');
  end if;

  perform 1 from public.creator_profiles where id = v_creator_id for update;

  select t.status into v_old_status
    from public.trips t
   where t.id = p_trip_id
     and t.creator_id = v_creator_id
   for update;

  if v_old_status is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  if not exists (select 1 from public.destinations d where d.id = p_destination_id) then
    return jsonb_build_object('result', 'destination_not_found');
  end if;

  v_increases := p_status in ('planning', 'upcoming', 'active')
    and v_old_status not in ('planning', 'upcoming', 'active');

  v_limit := greatest(coalesce(p_free_active_trip_limit, 0), 0);
  v_exempt := public._has_active_pro(p_user_id)
    or public._has_active_destination_access(p_user_id, p_destination_id);

  if v_increases and not v_exempt then
    select count(*)::integer into v_active
      from public.trips t
     where t.creator_id = v_creator_id
       and t.status in ('planning', 'upcoming', 'active');

    if v_active >= v_limit then
      return jsonb_build_object(
        'result', 'limit_reached',
        'active_count', v_active,
        'limit', v_limit
      );
    end if;
  end if;

  update public.trips
     set destination_id = p_destination_id,
         name = v_name,
         start_date = p_start_date,
         end_date = p_end_date,
         status = p_status
   where id = p_trip_id
     and creator_id = v_creator_id;

  return jsonb_build_object('result', 'updated', 'trip_id', p_trip_id, 'status', p_status);
end;
$$;

comment on function public.update_trip(uuid, uuid, uuid, text, date, date, text, integer) is
  'Updates the caller''s own trip. Does not change visibility. Re-checks the Free active-trip allowance only when the trip moves from a terminal status into a counting one. Existing counting trips stay editable after entitlement expiry (D014).';

create or replace function public.delete_trip(
  p_user_id uuid,
  p_trip_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_id uuid;
begin
  if p_user_id is null or p_trip_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return jsonb_build_object('result', 'creator_profile_missing');
  end if;

  delete from public.trips
   where id = p_trip_id
     and creator_id = v_creator_id
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  return jsonb_build_object('result', 'deleted', 'trip_id', v_id);
end;
$$;

comment on function public.delete_trip(uuid, uuid) is
  'Deletes the caller''s own trip. Entitlement expiry must never call this (D014). pipeline_items.trip_id is set null by the existing foreign key; pipeline rows are not deleted.';

create or replace function public.add_trip_hotel(
  p_user_id uuid,
  p_trip_id uuid,
  p_hotel_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_id uuid;
begin
  if p_user_id is null or p_trip_id is null or p_hotel_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return jsonb_build_object('result', 'creator_profile_missing');
  end if;

  -- Ownership before the hotel check, so a foreign trip id is always not_found.
  if not exists (
    select 1 from public.trips t
     where t.id = p_trip_id and t.creator_id = v_creator_id
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- A row in public.hotels is the V1 publication boundary (D062). Staging
  -- identities are not hotels and are rejected here.
  if not exists (select 1 from public.hotels h where h.id = p_hotel_id) then
    return jsonb_build_object('result', 'hotel_not_found');
  end if;

  insert into public.trip_hotels (trip_id, hotel_id)
  values (p_trip_id, p_hotel_id)
  on conflict (trip_id, hotel_id) do nothing
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('result', 'already_shortlisted', 'trip_id', p_trip_id);
  end if;

  return jsonb_build_object(
    'result', 'added',
    'trip_id', p_trip_id,
    'trip_hotel_id', v_id
  );
end;
$$;

comment on function public.add_trip_hotel(uuid, uuid, uuid) is
  'Shortlists a canonical published hotel on the caller''s own trip. Idempotent. A trip the caller does not own is not_found.';

create or replace function public.remove_trip_hotel(
  p_user_id uuid,
  p_trip_id uuid,
  p_hotel_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_id uuid;
begin
  if p_user_id is null or p_trip_id is null or p_hotel_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return jsonb_build_object('result', 'creator_profile_missing');
  end if;

  if not exists (
    select 1 from public.trips t
     where t.id = p_trip_id and t.creator_id = v_creator_id
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  delete from public.trip_hotels th
   where th.trip_id = p_trip_id
     and th.hotel_id = p_hotel_id
  returning th.id into v_id;

  if v_id is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  return jsonb_build_object('result', 'removed', 'trip_id', p_trip_id);
end;
$$;

comment on function public.remove_trip_hotel(uuid, uuid, uuid) is
  'Removes a shortlisted hotel from the caller''s own trip.';

create or replace function public.link_pipeline_item_to_trip(
  p_user_id uuid,
  p_pipeline_item_id uuid,
  p_trip_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_item_creator uuid;
  v_id uuid;
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

  select pi.creator_id into v_item_creator
    from public.pipeline_items pi
   where pi.id = p_pipeline_item_id;

  if v_item_creator is null or v_item_creator is distinct from v_creator_id then
    return jsonb_build_object('result', 'not_found');
  end if;

  if p_trip_id is not null and not exists (
    select 1 from public.trips t
     where t.id = p_trip_id and t.creator_id = v_creator_id
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  update public.pipeline_items
     set trip_id = p_trip_id
   where id = p_pipeline_item_id
     and creator_id = v_creator_id
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  return jsonb_build_object(
    'result', case when p_trip_id is null then 'unlinked' else 'linked' end,
    'pipeline_item_id', v_id,
    'trip_id', p_trip_id
  );
exception
  when check_violation or foreign_key_violation then
    return jsonb_build_object('result', 'not_found');
end;
$$;

comment on function public.link_pipeline_item_to_trip(uuid, uuid, uuid) is
  'Links or unlinks the caller''s own pipeline item and the caller''s own trip. A null trip id unlinks. Cross-creator ids return not_found and write nothing. The same-creator trigger is the backstop.';

revoke all on function
  public.create_trip(uuid, uuid, text, date, date, text, integer),
  public.update_trip(uuid, uuid, uuid, text, date, date, text, integer),
  public.delete_trip(uuid, uuid),
  public.add_trip_hotel(uuid, uuid, uuid),
  public.remove_trip_hotel(uuid, uuid, uuid),
  public.link_pipeline_item_to_trip(uuid, uuid, uuid)
  from public, anon, authenticated;

grant execute on function
  public.create_trip(uuid, uuid, text, date, date, text, integer),
  public.update_trip(uuid, uuid, uuid, text, date, date, text, integer),
  public.delete_trip(uuid, uuid),
  public.add_trip_hotel(uuid, uuid, uuid),
  public.remove_trip_hotel(uuid, uuid, uuid),
  public.link_pipeline_item_to_trip(uuid, uuid, uuid)
  to service_role;

-- Browser writes would skip the allowance and the canonical-hotel check.
revoke insert, update, delete on public.trips, public.trip_hotels from authenticated, anon;
