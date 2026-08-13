-- 0020_pipeline_transitions.sql
-- Sprint 2C: the creator outreach workflow + trusted write boundary
-- (PRD §7.4, EVENTS.md §3/§4/§8, DECISIONS D042/D043).
--
-- Two things happen here, and they belong together:
--
--  1. `transition_pipeline_item` performs every Sprint 2C workflow transition
--     as ONE transaction: ownership resolution, per-creator serialization, the
--     Free engaged-relationship limit, the status change, and the canonical
--     outreach_events it implies. Retries and concurrent requests converge on
--     the same state without duplicating history.
--
--  2. Direct client writes to the CRM tables are revoked. Until now an
--     authenticated creator could reach Supabase straight from a browser and
--     set status = 'won', skip the transition map, bypass the engaged limit, or
--     fabricate pitch/reply/deal events. RLS stops cross-user access but knows
--     nothing about workflow semantics, so it cannot stop any of that. After
--     this migration, creator workflow writes exist only behind trusted
--     server-mediated RPCs, and the raw ledger that future intelligence will
--     aggregate can be trusted.
--
-- The function is SECURITY INVOKER on purpose: only service_role may execute
-- it, and service_role already holds the table privileges and bypasses RLS.
-- SECURITY DEFINER would widen the privilege surface for no benefit.
--
-- Additive; migrations 0001–0019 are unchanged.

-- ===========================================================================
-- 1. Workflow RPC
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
    -- negotiating/won close semantics belong to the next workflow slice.
    if v_status not in ('saved', 'planned', 'pitched', 'follow_up', 'replied') then
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
  'Transactional creator workflow transition. Trusted server code only (service_role): derives the creator from the authenticated user id, serializes per creator, enforces the Free engaged limit (D042), and appends the canonical outreach_events for the transition (EVENTS.md §3, D043).';

-- Only trusted server code may transition a relationship. Hosted Supabase can
-- grant EXECUTE to client roles by default, so revoke before granting (cf. 0018).
revoke all on function public.transition_pipeline_item(uuid, uuid, text, timestamptz, text, text, text, text, integer)
  from public, anon, authenticated;

grant execute on function public.transition_pipeline_item(uuid, uuid, text, timestamptz, text, text, text, text, integer)
  to service_role;

-- ===========================================================================
-- 2. Creator write hardening
--
-- 0012 gave authenticated creators direct INSERT/UPDATE/DELETE on
-- pipeline_items and direct INSERT on outreach_events. RLS scopes those to the
-- creator's own rows but enforces no workflow rules, so a creator could set
-- their own status to `won`, skip the transition map, bypass the engaged
-- limit, or write arbitrary pitch/reply/deal events straight into the ledger
-- that future intelligence aggregates.
--
-- Reads stay exactly as they were: creators still SELECT their own rows, and
-- the ownership policies from 0012 remain in force as defence in depth.
-- 0012 itself is untouched — this is additive.
-- ===========================================================================

revoke insert, update, delete on public.pipeline_items from authenticated;
revoke insert on public.outreach_events from authenticated;

comment on table public.pipeline_items is
  'Creator relationship cycles. Client writes are revoked (0020): every mutation goes through a trusted server RPC so workflow rules and limits cannot be bypassed. RLS ownership remains as defence in depth.';

comment on table public.outreach_events is
  'Append-oriented domain ledger and source of truth for intelligence. Client INSERT is revoked (0020): events are written only by trusted server RPCs (DATABASE.md §2, EVENTS.md §9).';
