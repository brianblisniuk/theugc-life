-- 0051_outside_free_allowance.sql
-- E04 audit correction. Do not edit 0019, 0021, or 0046.
--
-- D056 / PRD §5.2 / PERMISSIONS.md §8: a Destination Pass is strictly additive.
-- When the action itself is outside coverage, the Free counters must count only
-- rows that are themselves outside coverage. In-destination open relationships,
-- engaged relationships, and active trips do not consume the outside Free
-- allowance a Free account would keep.
--
-- Signatures, security mode, and search_path are unchanged, so existing grants
-- persist. They are restated below so a hosted default privilege cannot widen
-- them. No new function is added.

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
    -- D056: this save is outside coverage, so count only open rows that are
    -- themselves outside coverage. In-destination rows do not consume the
    -- Free allowance a Free account would still have.
    select count(*) into v_open_count
      from public.pipeline_items pi
      join public.hotels h on h.id = pi.hotel_id
     where pi.creator_id = v_creator_id
       and pi.status <> 'closed'
       and not public._has_active_destination_access(p_user_id, h.destination_id);

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
  'Transactional, idempotent Save-to-Pipeline. Trusted server code only (service_role). Outside coverage, the Free open count includes only rows that are themselves outside coverage (D056). In-destination rows do not consume that allowance.';

-- ===========================================================================
-- Privilege surface. Hosted Supabase projects can grant EXECUTE to client roles
-- via default privileges, so revoke explicitly before granting (cf. 0018).
-- ===========================================================================

create or replace function public.transition_pipeline_item(
  p_user_id uuid,
  p_pipeline_item_id uuid,
  p_action text,
  p_event_at timestamptz default null,
  p_channel text default null,
  p_sentiment text default null,
  p_offer_type text default null,
  p_close_reason text default null,
  p_free_engaged_limit integer default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  -- Engaged statuses per D042. `saved` is deliberately absent: a passive save
  -- does not consume the engaged allowance.
  c_engaged constant text[] := array['planned', 'pitched', 'replied', 'follow_up', 'negotiating', 'won'];
  c_channels constant text[] := array['email', 'instagram', 'linkedin', 'website_form', 'whatsapp', 'in_person', 'other'];
  c_sentiments constant text[] := array['positive', 'negative', 'unclear'];
  c_offer_types constant text[] := array['stay', 'product', 'paid', 'stay_plus_paid', 'other'];
  c_close_reasons constant text[] := array['no_reply', 'rejected', 'not_a_fit', 'timing', 'other'];
  -- Creators record events by hand, so a little clock skew is expected. This
  -- rejects "the future" without rejecting "a minute ahead of my server".
  c_future_slack constant interval := interval '5 minutes';

  v_creator_id uuid;
  v_hotel_id uuid;
  v_destination_id uuid;
  v_status text;
  v_first_pitched_at timestamptz;
  v_event_at timestamptz;
  v_entering_engaged boolean := false;
  v_has_premium boolean;
  v_engaged_count integer;
  v_reply_event_id uuid;
  v_event_type text;
begin
  -- ---------------------------------------------------------------------
  -- Input shape. Nothing about identity or plan is taken from the caller.
  -- ---------------------------------------------------------------------
  if p_user_id is null or p_pipeline_item_id is null or p_action is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  if p_action not in ('plan', 'mark_pitched', 'mark_followup_sent', 'mark_replied', 'close') then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return jsonb_build_object('result', 'creator_profile_missing');
  end if;

  -- Lock order is creator row first, then the item — the same order 0019 uses,
  -- so the two flows cannot deadlock against each other. Locking the creator
  -- makes "count the engaged items" and "engage one more" a single atomic
  -- decision, which is what stops two different hotels taking the last slot.
  perform 1 from public.creator_profiles where id = v_creator_id for update;

  -- Ownership is a join condition, not a check after the fact: another
  -- creator's item simply does not exist for this caller.
  select pi.hotel_id, pi.status, pi.first_pitched_at
    into v_hotel_id, v_status, v_first_pitched_at
    from public.pipeline_items pi
   where pi.id = p_pipeline_item_id
     and pi.creator_id = v_creator_id
   for update;

  if v_hotel_id is null then
    return jsonb_build_object('result', 'pipeline_item_not_found');
  end if;

  -- A closed cycle is history. Re-engaging means starting a NEW cycle through
  -- the Save flow, never reopening the old row (D023).
  if v_status = 'closed' and p_action <> 'close' then
    return jsonb_build_object('result', 'invalid_transition', 'status', v_status);
  end if;

  -- ---------------------------------------------------------------------
  -- Per-action validation and transition legality.
  -- ---------------------------------------------------------------------
  if p_action = 'plan' then
    if v_status = 'planned' then
      return jsonb_build_object('result', 'already_applied', 'status', v_status);
    end if;
    if v_status <> 'saved' then
      return jsonb_build_object('result', 'invalid_transition', 'status', v_status);
    end if;
    v_entering_engaged := true;

  elsif p_action = 'mark_pitched' then
    if p_event_at is null or p_channel is null or not (p_channel = any (c_channels)) then
      return jsonb_build_object('result', 'invalid_input');
    end if;
    if p_event_at > now() + c_future_slack then
      return jsonb_build_object('result', 'invalid_event_time');
    end if;
    -- Already pitched AND the pitch is on the ledger: a retry, not a second pitch.
    if v_status = 'pitched' and exists (
      select 1 from public.outreach_events oe
       where oe.pipeline_item_id = p_pipeline_item_id and oe.event_type = 'pitch_sent'
    ) then
      return jsonb_build_object('result', 'already_applied', 'status', v_status);
    end if;
    if v_status not in ('saved', 'planned', 'pitched') then
      return jsonb_build_object('result', 'invalid_transition', 'status', v_status);
    end if;
    v_entering_engaged := (v_status = 'saved');

  elsif p_action = 'mark_followup_sent' then
    if p_event_at is null then
      return jsonb_build_object('result', 'invalid_input');
    end if;
    if p_channel is not null and not (p_channel = any (c_channels)) then
      return jsonb_build_object('result', 'invalid_input');
    end if;
    if p_event_at > now() + c_future_slack then
      return jsonb_build_object('result', 'invalid_event_time');
    end if;
    -- Repeat follow-ups are not modelled in this slice, so a second call is a
    -- retry of the first.
    if v_status = 'follow_up' then
      return jsonb_build_object('result', 'already_applied', 'status', v_status);
    end if;
    if v_status <> 'pitched' then
      return jsonb_build_object('result', 'invalid_transition', 'status', v_status);
    end if;
    -- A follow-up cannot predate the pitch it follows.
    if v_first_pitched_at is not null and p_event_at < v_first_pitched_at then
      return jsonb_build_object('result', 'invalid_event_time');
    end if;

  elsif p_action = 'mark_replied' then
    if p_event_at is null or p_sentiment is null or not (p_sentiment = any (c_sentiments)) then
      return jsonb_build_object('result', 'invalid_input');
    end if;
    if p_offer_type is not null and not (p_offer_type = any (c_offer_types)) then
      return jsonb_build_object('result', 'invalid_input');
    end if;
    if p_event_at > now() + c_future_slack then
      return jsonb_build_object('result', 'invalid_event_time');
    end if;
    if v_status = 'replied' and exists (
      select 1 from public.outreach_events oe
       where oe.pipeline_item_id = p_pipeline_item_id and oe.event_type = 'reply_received'
    ) then
      return jsonb_build_object('result', 'already_applied', 'status', v_status);
    end if;
    if v_status not in ('pitched', 'follow_up') then
      return jsonb_build_object('result', 'invalid_transition', 'status', v_status);
    end if;
    -- A reply cannot predate the pitch it answers.
    if v_first_pitched_at is not null and p_event_at < v_first_pitched_at then
      return jsonb_build_object('result', 'invalid_event_time');
    end if;

  else -- close
    if p_close_reason is null or not (p_close_reason = any (c_close_reasons)) then
      return jsonb_build_object('result', 'invalid_input');
    end if;
    if p_event_at is not null and p_event_at > now() + c_future_slack then
      return jsonb_build_object('result', 'invalid_event_time');
    end if;
    if v_status = 'closed' then
      return jsonb_build_object('result', 'already_applied', 'status', v_status);
    end if;
    -- `won` is deliberately still excluded: closing a won cycle belongs to the
    -- collaboration lifecycle, not to this workflow. `negotiating` joins the
    -- list here (Sprint 2D) and classifies as deal_lost under D043, because
    -- outreach demonstrably occurred.
    if v_status not in ('saved', 'planned', 'pitched', 'follow_up', 'replied', 'negotiating') then
      return jsonb_build_object('result', 'invalid_transition', 'status', v_status);
    end if;
  end if;

  -- ---------------------------------------------------------------------
  -- Free engaged-relationship limit (D042), only for transitions that move an
  -- item OUT of `saved` and INTO the engaged set. An already-engaged item
  -- moving between engaged statuses consumes nothing.
  -- ---------------------------------------------------------------------
  if v_entering_engaged then
    select h.destination_id into v_destination_id
      from public.hotels h
     where h.id = v_hotel_id;

    -- Entitlement is read from the database's own source of truth. A caller
    -- claiming "isPro" would be ignored; it is not even an input.
    v_has_premium := public._has_active_pro(p_user_id)
      or (
        v_destination_id is not null
        and public._has_active_destination_access(p_user_id, v_destination_id)
      );

    if not v_has_premium then
      -- D056: this transition is outside coverage, so count only engaged rows
      -- that are themselves outside coverage.
      select count(*) into v_engaged_count
        from public.pipeline_items pi
        join public.hotels h on h.id = pi.hotel_id
       where pi.creator_id = v_creator_id
         and pi.status = any (c_engaged)
         and not public._has_active_destination_access(p_user_id, h.destination_id);

      if v_engaged_count >= coalesce(p_free_engaged_limit, 0) then
        return jsonb_build_object(
          'result', 'engaged_limit_reached',
          'engaged_count', v_engaged_count,
          'limit', p_free_engaged_limit
        );
      end if;
    end if;
  end if;

  -- ---------------------------------------------------------------------
  -- Apply. Domain chronology lives in outreach_events.event_at; CRM recency
  -- lives in last_activity_at, which is always "now" for a real mutation.
  -- Historical event_at values are never rewritten to now().
  -- ---------------------------------------------------------------------
  if p_action = 'plan' then
    -- `planned` is CRM state; EVENTS.md defines no canonical `planned` event,
    -- so none is invented here.
    update public.pipeline_items
       set status = 'planned', last_activity_at = now()
     where id = p_pipeline_item_id;

    return jsonb_build_object('result', 'applied', 'status', 'planned');

  elsif p_action = 'mark_pitched' then
    update public.pipeline_items
       set status = 'pitched',
           first_pitched_at = coalesce(first_pitched_at, p_event_at),
           last_activity_at = now()
     where id = p_pipeline_item_id;

    insert into public.outreach_events
      (creator_id, hotel_id, pipeline_item_id, event_type, event_at, channel, source)
    values
      (v_creator_id, v_hotel_id, p_pipeline_item_id, 'pitch_sent', p_event_at, p_channel, 'manual_creator');

    return jsonb_build_object('result', 'applied', 'status', 'pitched');

  elsif p_action = 'mark_followup_sent' then
    update public.pipeline_items
       set status = 'follow_up', last_activity_at = now()
     where id = p_pipeline_item_id;

    insert into public.outreach_events
      (creator_id, hotel_id, pipeline_item_id, event_type, event_at, channel, source)
    values
      (v_creator_id, v_hotel_id, p_pipeline_item_id, 'followup_sent', p_event_at, p_channel, 'manual_creator');

    return jsonb_build_object('result', 'applied', 'status', 'follow_up');

  elsif p_action = 'mark_replied' then
    update public.pipeline_items
       set status = 'replied', last_activity_at = now()
     where id = p_pipeline_item_id;

    insert into public.outreach_events
      (creator_id, hotel_id, pipeline_item_id, event_type, event_at, metadata, source)
    values
      (v_creator_id, v_hotel_id, p_pipeline_item_id, 'reply_received', p_event_at,
       jsonb_build_object('sentiment', p_sentiment), 'manual_creator')
    returning id into v_reply_event_id;

    -- The classification events reference the reply they classify, so the
    -- ledger stays navigable without inferring from timestamps.
    if p_sentiment in ('positive', 'negative') then
      insert into public.outreach_events
        (creator_id, hotel_id, pipeline_item_id, event_type, event_at, metadata, source)
      values
        (v_creator_id, v_hotel_id, p_pipeline_item_id,
         case p_sentiment when 'positive' then 'positive_reply' else 'negative_reply' end,
         p_event_at, jsonb_build_object('reply_event_id', v_reply_event_id), 'manual_creator');
    end if;

    if p_offer_type is not null then
      insert into public.outreach_events
        (creator_id, hotel_id, pipeline_item_id, event_type, event_at, metadata, source)
      values
        (v_creator_id, v_hotel_id, p_pipeline_item_id, 'offer_received', p_event_at,
         jsonb_build_object('offer_type', p_offer_type, 'reply_event_id', v_reply_event_id),
         'manual_creator');
    end if;

    return jsonb_build_object(
      'result', 'applied',
      'status', 'replied',
      'reply_event_id', v_reply_event_id
    );

  else -- close
    -- D043: abandoning a target BEFORE any pitch is not a lost deal. Only a
    -- cycle where outreach actually began can be lost.
    v_event_type := case
      when v_status in ('saved', 'planned') then 'creator_closed_pipeline'
      else 'deal_lost'
    end;
    v_event_at := coalesce(p_event_at, now());

    update public.pipeline_items
       set status = 'closed', last_activity_at = now()
     where id = p_pipeline_item_id;

    insert into public.outreach_events
      (creator_id, hotel_id, pipeline_item_id, event_type, event_at, metadata, source)
    values
      (v_creator_id, v_hotel_id, p_pipeline_item_id, v_event_type, v_event_at,
       jsonb_build_object('reason', p_close_reason), 'manual_creator');

    return jsonb_build_object(
      'result', 'applied',
      'status', 'closed',
      'event_type', v_event_type
    );
  end if;
end;
$$;

comment on function public.transition_pipeline_item(uuid, uuid, text, timestamptz, text, text, text, text, integer) is
  'Transactional creator workflow transition. Trusted server code only (service_role). Outside coverage, the Free engaged count includes only rows that are themselves outside coverage (D056). In-destination rows do not consume that allowance.';

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
    -- D056: this trip is outside coverage, so count only active trips that are
    -- themselves outside coverage.
    select count(*)::integer into v_active
      from public.trips t
     where t.creator_id = v_creator_id
       and t.status in ('planning', 'upcoming', 'active')
       and not public._has_active_destination_access(p_user_id, t.destination_id);

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
  'Creates one private trip for the authenticated user. Outside coverage, the Free active-trip count includes only trips that are themselves outside coverage (D056). In-destination trips do not consume that allowance. Never writes visibility.';

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
  v_old_destination uuid;
  v_limit integer;
  v_pro boolean;
  v_new_exempt boolean;
  v_old_exempt boolean;
  v_new_counts boolean;
  v_old_counts boolean;
  v_active integer;
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

  select t.status, t.destination_id
    into v_old_status, v_old_destination
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

  v_new_counts := p_status in ('planning', 'upcoming', 'active');
  v_old_counts := v_old_status in ('planning', 'upcoming', 'active');

  v_limit := greatest(coalesce(p_free_active_trip_limit, 0), 0);
  v_pro := public._has_active_pro(p_user_id);
  v_new_exempt := v_pro
    or public._has_active_destination_access(p_user_id, p_destination_id);
  v_old_exempt := v_pro
    or public._has_active_destination_access(p_user_id, v_old_destination);

  -- A counting trip outside Pro and outside a covering destination pass
  -- consumes a Free slot (D056). Re-check when this write newly consumes one:
  -- the trip was terminal, or its previous destination was exempt and the new
  -- one is not. Count the creator's OTHER outside-coverage counting trips so
  -- the trip that already occupies the slot can still be retargeted.
  -- In-destination trips do not consume that Free allowance.
  if v_new_counts and not v_new_exempt and (not v_old_counts or v_old_exempt) then
    -- D056: this write newly consumes an outside Free slot, so count only
    -- OTHER active trips that are themselves outside coverage.
    select count(*)::integer into v_active
      from public.trips t
     where t.creator_id = v_creator_id
       and t.id <> p_trip_id
       and t.status in ('planning', 'upcoming', 'active')
       and not public._has_active_destination_access(p_user_id, t.destination_id);

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
  'Updates the caller''s own trip. Does not change visibility. Re-checks the Free active-trip allowance when the result counts, the new destination is not exempt, and the trip previously did not count or its previous destination was exempt (D056). Other outside-coverage counting trips are counted; in-destination trips do not consume the Free allowance. The trip that already occupies a Free slot can change destination. Existing counting trips stay editable after entitlement expiry (D014).';

revoke all on function public.save_hotel_to_pipeline(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.save_hotel_to_pipeline(uuid, uuid, integer)
  to service_role;

revoke all on function public.transition_pipeline_item(uuid, uuid, text, timestamptz, text, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function public.transition_pipeline_item(uuid, uuid, text, timestamptz, text, text, text, text, integer)
  to service_role;

revoke all on function public.create_trip(uuid, uuid, text, date, date, text, integer)
  from public, anon, authenticated;
grant execute on function public.create_trip(uuid, uuid, text, date, date, text, integer)
  to service_role;

revoke all on function public.update_trip(uuid, uuid, uuid, text, date, date, text, integer)
  from public, anon, authenticated;
grant execute on function public.update_trip(uuid, uuid, uuid, text, date, date, text, integer)
  to service_role;
