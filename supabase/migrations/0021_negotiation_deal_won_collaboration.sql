-- 0021_negotiation_deal_won_collaboration.sql
-- Sprint 2D: the first successful-deal path (PRD §7.4, EVENTS.md §3/§4, D043).
--
--   replied → negotiating → won → a first-class collaboration
--   negotiating → closed when the negotiation fails
--
-- Three things happen here:
--
--  1. `progress_pipeline_deal` performs the two deal transitions. Marking a
--     deal won is the first workflow step that creates a SECOND row of
--     proprietary data, so the pipeline status, the `deal_won` event and the
--     `collaborations` record are written in one transaction. A cycle that is
--     `won` without a collaboration — or a collaboration with no `deal_won` —
--     is not a state this system is allowed to reach.
--
--  2. `transition_pipeline_item` is replaced with the SAME signature to admit
--     one new origin for `close`: `negotiating`. Sprint 2C semantics are
--     otherwise byte-identical, and `won` remains un-closable in this slice.
--
--  3. Direct client writes to `collaborations` are revoked, before `deal_won`
--     starts producing collaboration data worth protecting. A partial unique
--     index makes "one collaboration per relationship cycle" a database fact
--     rather than a hope about double clicks and retries.
--
-- Additive; migrations 0001–0020 are unchanged.

-- ===========================================================================
-- 1. One collaboration per relationship CYCLE
--
-- The unit is the cycle, never creator+hotel: a creator who works with the
-- same hotel again next season gets a new pipeline cycle and, rightly, a new
-- collaboration. Partial, because historical rows may carry no cycle.
-- ===========================================================================

create unique index if not exists collaborations_one_per_cycle_uidx
  on public.collaborations (pipeline_item_id)
  where pipeline_item_id is not null;

-- ===========================================================================
-- 2. Close may now be reached from `negotiating`
--
-- Identical to 0020 apart from that one origin — replaced rather than altered
-- because Postgres has no other way to extend a function body in place.
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
      select count(*) into v_engaged_count
        from public.pipeline_items pi
       where pi.creator_id = v_creator_id
         and pi.status = any (c_engaged);

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
  'Transactional creator workflow transition. Trusted server code only (service_role): derives the creator from the authenticated user id, serializes per creator, enforces the Free engaged limit (D042), and appends the canonical outreach_events for the transition (EVENTS.md §3, D043). Sprint 2D adds `negotiating` as a close origin.';

revoke all on function public.transition_pipeline_item(uuid, uuid, text, timestamptz, text, text, text, text, integer)
  from public, anon, authenticated;

grant execute on function public.transition_pipeline_item(uuid, uuid, text, timestamptz, text, text, text, text, integer)
  to service_role;

-- ===========================================================================
-- 3. The deal path: start_negotiation and mark_won
--
-- A separate function keeps 0020's contract clean: these two actions carry
-- different inputs (an agreed date and a collaboration type) and, in the case
-- of mark_won, write to a third table. Same trust model as 0020 — identity is
-- derived here, never accepted; the caller may only name an item and an action.
-- ===========================================================================

create or replace function public.progress_pipeline_deal(
  p_user_id uuid,
  p_pipeline_item_id uuid,
  p_action text,
  p_agreed_at timestamptz default null,
  p_collaboration_type text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  c_types constant text[] := array['stay', 'product', 'paid', 'stay_plus_paid', 'other'];
  -- The same clock-skew convention as 0020: reject the future without
  -- rejecting a creator whose device is a minute ahead of ours.
  c_future_slack constant interval := interval '5 minutes';

  v_creator_id uuid;
  v_hotel_id uuid;
  v_status text;
  v_collaboration_id uuid;
  v_collaboration_count integer;
  v_has_deal_won boolean;
begin
  if p_user_id is null or p_pipeline_item_id is null or p_action is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  if p_action not in ('start_negotiation', 'mark_won') then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return jsonb_build_object('result', 'creator_profile_missing');
  end if;

  -- Established lock order: creator row, then the item (cf. 0019/0020), so
  -- concurrent deal progress serializes and cannot deadlock against the other
  -- workflow functions.
  perform 1 from public.creator_profiles where id = v_creator_id for update;

  -- Ownership is a join condition: another creator's item does not exist here.
  -- hotel_id comes from the row, never from the caller.
  select pi.hotel_id, pi.status
    into v_hotel_id, v_status
    from public.pipeline_items pi
   where pi.id = p_pipeline_item_id
     and pi.creator_id = v_creator_id
   for update;

  if v_hotel_id is null then
    return jsonb_build_object('result', 'pipeline_item_not_found');
  end if;

  -- ---------------------------------------------------------------------
  if p_action = 'start_negotiation' then
    if v_status = 'negotiating' then
      -- A retry only if the ledger agrees. A `negotiating` cycle with no
      -- negotiation_started is an impossible state we refuse to paper over.
      if exists (
        select 1 from public.outreach_events oe
         where oe.pipeline_item_id = p_pipeline_item_id
           and oe.event_type = 'negotiation_started'
      ) then
        return jsonb_build_object('result', 'already_applied', 'status', v_status);
      end if;
      return jsonb_build_object('result', 'integrity_error');
    end if;

    if v_status <> 'replied' then
      return jsonb_build_object('result', 'invalid_transition', 'status', v_status);
    end if;

    update public.pipeline_items
       set status = 'negotiating', last_activity_at = now()
     where id = p_pipeline_item_id;

    insert into public.outreach_events
      (creator_id, hotel_id, pipeline_item_id, event_type, event_at, source)
    values
      (v_creator_id, v_hotel_id, p_pipeline_item_id, 'negotiation_started', now(), 'manual_creator');

    return jsonb_build_object('result', 'applied', 'status', 'negotiating');
  end if;

  -- ---------------------------------------------------------------------
  -- mark_won
  -- ---------------------------------------------------------------------
  if p_agreed_at is null
     or p_collaboration_type is null
     or not (p_collaboration_type = any (c_types)) then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  if p_agreed_at > now() + c_future_slack then
    return jsonb_build_object('result', 'invalid_event_time');
  end if;

  select count(*) into v_collaboration_count
    from public.collaborations c
   where c.pipeline_item_id = p_pipeline_item_id;

  select c.id into v_collaboration_id
    from public.collaborations c
   where c.pipeline_item_id = p_pipeline_item_id
   order by c.created_at
   limit 1;

  v_has_deal_won := exists (
    select 1 from public.outreach_events oe
     where oe.pipeline_item_id = p_pipeline_item_id and oe.event_type = 'deal_won'
  );

  if v_status = 'won' then
    -- A genuine retry: the status, the event and exactly one collaboration all
    -- agree. Anything else is a partial state, and guessing which half is
    -- correct would only add history that never happened.
    if v_collaboration_count = 1 and v_has_deal_won then
      return jsonb_build_object(
        'result', 'already_applied',
        'status', v_status,
        'collaboration_id', v_collaboration_id
      );
    end if;
    return jsonb_build_object('result', 'integrity_error');
  end if;

  if v_status <> 'negotiating' then
    return jsonb_build_object('result', 'invalid_transition', 'status', v_status);
  end if;

  -- Still negotiating, yet a collaboration or a deal_won already exists: the
  -- same impossible state seen from the other side.
  if v_collaboration_count > 0 or v_has_deal_won then
    return jsonb_build_object('result', 'integrity_error');
  end if;

  -- All three writes, or none of them.
  insert into public.collaborations
    (creator_id, hotel_id, pipeline_item_id, status, collaboration_type, agreed_at)
  values
    (v_creator_id, v_hotel_id, p_pipeline_item_id, 'agreed', p_collaboration_type, p_agreed_at)
  returning id into v_collaboration_id;

  insert into public.outreach_events
    (creator_id, hotel_id, pipeline_item_id, event_type, event_at, metadata, source)
  values
    (v_creator_id, v_hotel_id, p_pipeline_item_id, 'deal_won', p_agreed_at,
     jsonb_build_object(
       'collaboration_type', p_collaboration_type,
       'collaboration_id', v_collaboration_id
     ),
     'manual_creator');

  update public.pipeline_items
     set status = 'won', last_activity_at = now()
   where id = p_pipeline_item_id;

  return jsonb_build_object(
    'result', 'applied',
    'status', 'won',
    'collaboration_id', v_collaboration_id
  );

exception
  -- Belt and braces for a concurrent mark_won that beat us to the per-cycle
  -- unique index: report the collaboration that won rather than a constraint
  -- violation.
  when unique_violation then
    select c.id into v_collaboration_id
      from public.collaborations c
     where c.pipeline_item_id = p_pipeline_item_id
     limit 1;
    if v_collaboration_id is null then
      return jsonb_build_object('result', 'error');
    end if;
    return jsonb_build_object(
      'result', 'already_applied',
      'status', 'won',
      'collaboration_id', v_collaboration_id
    );
end;
$$;

comment on function public.progress_pipeline_deal(uuid, uuid, text, timestamptz, text) is
  'Transactional deal progress: replied → negotiating → won. Trusted server code only (service_role). Marking a deal won writes the pipeline status, the deal_won event and the first-class collaboration together, or not at all (EVENTS.md §3, DATABASE.md §8).';

revoke all on function public.progress_pipeline_deal(uuid, uuid, text, timestamptz, text)
  from public, anon, authenticated;

grant execute on function public.progress_pipeline_deal(uuid, uuid, text, timestamptz, text)
  to service_role;

-- ===========================================================================
-- 4. Collaboration write hardening
--
-- 0012 granted authenticated creators direct INSERT/UPDATE/DELETE on
-- collaborations. RLS scopes those writes to the owner but enforces nothing
-- about the workflow, so a creator could fabricate an "agreed" collaboration
-- with no pitch, no reply and no won cycle behind it — precisely the record
-- future intelligence will treat as a confirmed creator collaboration
-- (EVENTS.md §7). Writes now happen only through trusted server workflows.
--
-- SELECT and the 0012 ownership policy are untouched. 0012 itself is
-- unmodified — this is additive.
-- ===========================================================================

revoke insert, update, delete on public.collaborations from authenticated;

comment on table public.collaborations is
  'First-class creator collaborations. Client writes are revoked (0021): rows are created only by trusted server workflows alongside their deal_won event, one per relationship cycle. RLS ownership remains as defence in depth.';
