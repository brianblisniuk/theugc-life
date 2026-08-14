-- 0023_collaboration_lifecycle.sql
-- Sprint 2F: the life of a relationship AFTER the deal is won
-- (PRD §7.4, EVENTS.md §3, DATABASE.md §8, DECISIONS D043/D045).
--
--   won + agreed → scheduled? → active → completed | cancelled → pipeline closed
--
-- Until now a `won` cycle stayed open forever: it held a Free engaged slot and
-- blocked the creator↔hotel pair from ever starting a second relationship. That
-- is because `won` describes the DEAL, not the collaboration. The commercial
-- agreement succeeding and the collaboration finishing are two different facts,
-- and only the second one should end the cycle.
--
-- The other half of D045 is what this migration deliberately does NOT do: a
-- cancelled collaboration never produces `deal_lost` and never erases
-- `deal_won`. The deal really was won; the collaboration later failed to
-- complete. Rewriting the first fact to express the second would corrupt every
-- funnel metric derived from the ledger and destroy the distinction that
-- Experience Intelligence will need.
--
-- Additive; migrations 0001–0022 are unchanged.

create or replace function public.progress_collaboration(
  p_user_id uuid,
  p_pipeline_item_id uuid,
  p_action text,
  p_event_at timestamptz default null,
  p_start_date date default null,
  p_end_date date default null,
  p_terms_matched text default null,
  p_would_work_again boolean default null,
  p_cancel_reason text default null
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  c_terms constant text[] := array['yes', 'partially', 'no', 'unknown'];
  c_cancel_reasons constant text[] := array['creator_cancelled', 'hotel_cancelled', 'mutual', 'other'];
  -- Same clock-skew convention as 0020/0021.
  c_future_slack constant interval := interval '5 minutes';

  v_creator_id uuid;
  v_hotel_id uuid;
  v_pipeline_status text;

  v_collaboration_id uuid;
  v_collaboration_count integer;
  v_collab_status text;
  v_collab_creator uuid;
  v_collab_hotel uuid;
  v_collab_start date;
  v_collab_end date;

  v_started_at timestamptz;
  v_started_count integer;
  v_completed_count integer;
  v_cancelled_count integer;
  v_end_date date;
begin
  if p_user_id is null or p_pipeline_item_id is null or p_action is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  if p_action not in ('schedule', 'start', 'complete', 'cancel') then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return jsonb_build_object('result', 'creator_profile_missing');
  end if;

  -- Established lock order: creator, then pipeline item, then collaboration.
  -- Reversing it anywhere would open a deadlock path against the workflow and
  -- deal functions, which already lock creator → item.
  perform 1 from public.creator_profiles where id = v_creator_id for update;

  select pi.hotel_id, pi.status
    into v_hotel_id, v_pipeline_status
    from public.pipeline_items pi
   where pi.id = p_pipeline_item_id
     and pi.creator_id = v_creator_id
   for update;

  if v_hotel_id is null then
    return jsonb_build_object('result', 'pipeline_item_not_found');
  end if;

  select count(*) into v_collaboration_count
    from public.collaborations c
   where c.pipeline_item_id = p_pipeline_item_id;

  if v_collaboration_count = 0 then
    -- A won cycle MUST have a collaboration (0021 writes them together), so an
    -- absence here is a contradiction rather than a normal miss.
    if v_pipeline_status = 'won' then
      return jsonb_build_object('result', 'integrity_error');
    end if;
    return jsonb_build_object('result', 'collaboration_not_found');
  end if;

  if v_collaboration_count > 1 then
    return jsonb_build_object('result', 'integrity_error');
  end if;

  select c.id, c.status, c.creator_id, c.hotel_id, c.start_date, c.end_date
    into v_collaboration_id, v_collab_status, v_collab_creator, v_collab_hotel,
         v_collab_start, v_collab_end
    from public.collaborations c
   where c.pipeline_item_id = p_pipeline_item_id
   for update;

  -- The collaboration must describe the same relationship as the cycle.
  if v_collab_creator <> v_creator_id or v_collab_hotel <> v_hotel_id then
    return jsonb_build_object('result', 'integrity_error');
  end if;

  -- The 0021 invariant: won + deal_won + exactly one collaboration agree.
  if not exists (
    select 1 from public.outreach_events oe
     where oe.pipeline_item_id = p_pipeline_item_id and oe.event_type = 'deal_won'
  ) then
    return jsonb_build_object('result', 'integrity_error');
  end if;

  select
    count(*) filter (where oe.event_type = 'collaboration_started'),
    count(*) filter (where oe.event_type = 'collaboration_completed'),
    count(*) filter (
      where oe.event_type = 'creator_closed_pipeline'
        and oe.metadata ->> 'reason' = 'collaboration_cancelled'
    ),
    min(oe.event_at) filter (where oe.event_type = 'collaboration_started')
    into v_started_count, v_completed_count, v_cancelled_count, v_started_at
    from public.outreach_events oe
   where oe.pipeline_item_id = p_pipeline_item_id;

  -- ---------------------------------------------------------------------
  -- The collaboration's STATUS and its lifecycle HISTORY must agree, and that
  -- is checked before any branch — retry or mutation.
  --
  -- Otherwise a partial technical state becomes new domain history: an `active`
  -- collaboration whose `collaboration_started` event is missing would skip the
  -- chronology guard (there is no start to compare against), sail through
  -- completion, and mint a `collaboration_completed` event plus a closed cycle
  -- describing something that never demonstrably happened. Those events are
  -- inputs to hotel intelligence now, so guessing is not a small mistake.
  --
  -- A technical inconsistency is not a domain fact. We refuse and say so.
  -- ---------------------------------------------------------------------
  if v_collab_status in ('agreed', 'scheduled') then
    -- Nothing has happened yet, and the cycle must still be live.
    if v_pipeline_status <> 'won'
       or v_started_count <> 0
       or v_completed_count <> 0
       or v_cancelled_count <> 0 then
      return jsonb_build_object('result', 'integrity_error');
    end if;

  elsif v_collab_status = 'active' then
    -- Exactly one start, nothing terminal, cycle still live.
    if v_pipeline_status <> 'won'
       or v_started_count <> 1
       or v_completed_count <> 0
       or v_cancelled_count <> 0 then
      return jsonb_build_object('result', 'integrity_error');
    end if;

  elsif v_collab_status = 'completed' then
    -- A completed collaboration was necessarily started, exactly once, and
    -- never cancelled; the cycle is closed.
    if v_pipeline_status <> 'closed'
       or v_started_count <> 1
       or v_completed_count <> 1
       or v_cancelled_count <> 0 then
      return jsonb_build_object('result', 'integrity_error');
    end if;

  elsif v_collab_status = 'cancelled' then
    -- Cancellation may precede a start (from agreed/scheduled) or follow one
    -- (from active), so 0 or 1 starts are both coherent — but nothing else is.
    if v_pipeline_status <> 'closed'
       or v_completed_count <> 0
       or v_cancelled_count <> 1
       or v_started_count not in (0, 1) then
      return jsonb_build_object('result', 'integrity_error');
    end if;
  end if;

  -- ---------------------------------------------------------------------
  -- Retries are answered BEFORE the `won` requirement, because the terminal
  -- actions deliberately leave the pipeline `closed`. The history behind each
  -- of these has just been validated, so a retry reports the ORIGINAL stored
  -- values rather than overwriting them with whatever was posted again.
  -- ---------------------------------------------------------------------
  if p_action = 'schedule' and v_collab_status = 'scheduled' then
    -- Rescheduling is out of scope.
    return jsonb_build_object(
      'result', 'already_applied',
      'collaboration_status', v_collab_status,
      'pipeline_status', v_pipeline_status,
      'start_date', v_collab_start,
      'end_date', v_collab_end
    );
  end if;

  if p_action = 'start' and v_collab_status = 'active' then
    return jsonb_build_object(
      'result', 'already_applied',
      'collaboration_status', v_collab_status,
      'pipeline_status', v_pipeline_status,
      'start_date', v_collab_start
    );
  end if;

  if p_action = 'complete' and v_collab_status = 'completed' then
    return jsonb_build_object(
      'result', 'already_applied',
      'collaboration_status', v_collab_status,
      'pipeline_status', v_pipeline_status,
      'end_date', v_collab_end
    );
  end if;

  if p_action = 'cancel' and v_collab_status = 'cancelled' then
    return jsonb_build_object(
      'result', 'already_applied',
      'collaboration_status', v_collab_status,
      'pipeline_status', v_pipeline_status
    );
  end if;

  -- Any non-retry lifecycle move requires a live won cycle. This is also what
  -- makes a complete/cancel race safe: the loser finds a terminal collaboration
  -- and a closed pipeline, and is refused.
  if v_pipeline_status <> 'won' then
    return jsonb_build_object('result', 'invalid_transition', 'status', v_pipeline_status);
  end if;

  -- ---------------------------------------------------------------------
  if p_action = 'schedule' then
    if v_collab_status <> 'agreed' then
      return jsonb_build_object('result', 'invalid_transition', 'status', v_collab_status);
    end if;
    if p_start_date is null then
      return jsonb_build_object('result', 'invalid_input');
    end if;
    if p_end_date is not null and p_end_date < p_start_date then
      return jsonb_build_object('result', 'invalid_input');
    end if;

    -- Scheduling is planning state, not a creator↔hotel interaction, so it
    -- emits no domain event and future dates are perfectly valid.
    update public.collaborations
       set status = 'scheduled',
           start_date = p_start_date,
           end_date = coalesce(p_end_date, end_date)
     where id = v_collaboration_id;

    update public.pipeline_items
       set last_activity_at = now()
     where id = p_pipeline_item_id;

    return jsonb_build_object(
      'result', 'applied',
      'collaboration_status', 'scheduled',
      'pipeline_status', v_pipeline_status,
      'start_date', p_start_date,
      'end_date', coalesce(p_end_date, v_collab_end)
    );

  elsif p_action = 'start' then
    if v_collab_status not in ('agreed', 'scheduled') then
      return jsonb_build_object('result', 'invalid_transition', 'status', v_collab_status);
    end if;
    if p_event_at is null or p_start_date is null then
      return jsonb_build_object('result', 'invalid_input');
    end if;
    if p_event_at > now() + c_future_slack then
      return jsonb_build_object('result', 'invalid_event_time');
    end if;
    -- A scheduled end date is preserved, so the start may not overshoot it.
    if v_collab_end is not null and p_start_date > v_collab_end then
      return jsonb_build_object('result', 'invalid_input');
    end if;

    update public.collaborations
       set status = 'active',
           start_date = p_start_date
     where id = v_collaboration_id;

    insert into public.outreach_events
      (creator_id, hotel_id, pipeline_item_id, event_type, event_at, metadata, source)
    values
      (v_creator_id, v_hotel_id, p_pipeline_item_id, 'collaboration_started', p_event_at,
       jsonb_build_object('collaboration_id', v_collaboration_id), 'manual_creator');

    -- The pipeline stays `won`: the deal is still the deal, and the cycle is
    -- not finished until the collaboration reaches a terminal state (D045).
    update public.pipeline_items
       set last_activity_at = now()
     where id = p_pipeline_item_id;

    return jsonb_build_object(
      'result', 'applied',
      'collaboration_status', 'active',
      'pipeline_status', v_pipeline_status,
      'start_date', p_start_date
    );

  elsif p_action = 'complete' then
    if v_collab_status <> 'active' then
      return jsonb_build_object('result', 'invalid_transition', 'status', v_collab_status);
    end if;
    if p_event_at is null
       or p_end_date is null
       or p_terms_matched is null
       or not (p_terms_matched = any (c_terms)) then
      return jsonb_build_object('result', 'invalid_input');
    end if;
    if p_event_at > now() + c_future_slack then
      return jsonb_build_object('result', 'invalid_event_time');
    end if;
    if v_collab_start is not null and p_end_date < v_collab_start then
      return jsonb_build_object('result', 'invalid_input');
    end if;
    -- A collaboration cannot finish before it started.
    if v_started_at is not null and p_event_at < v_started_at then
      return jsonb_build_object('result', 'invalid_event_time');
    end if;

    -- `would_work_again` is deliberately nullable: "not sure" is a real answer
    -- and must not be recorded as "no".
    update public.collaborations
       set status = 'completed',
           end_date = p_end_date,
           terms_matched = p_terms_matched,
           would_work_again = p_would_work_again
     where id = v_collaboration_id;

    insert into public.outreach_events
      (creator_id, hotel_id, pipeline_item_id, event_type, event_at, metadata, source)
    values
      (v_creator_id, v_hotel_id, p_pipeline_item_id, 'collaboration_completed', p_event_at,
       jsonb_build_object(
         'collaboration_id', v_collaboration_id,
         'terms_matched', p_terms_matched,
         'would_work_again', p_would_work_again
       ),
       'manual_creator');

    -- Terminal: the cycle closes, freeing the creator↔hotel pair for a future
    -- cycle and returning one Free engaged slot.
    update public.pipeline_items
       set status = 'closed', last_activity_at = now()
     where id = p_pipeline_item_id;

    return jsonb_build_object(
      'result', 'applied',
      'collaboration_status', 'completed',
      'pipeline_status', 'closed',
      'end_date', p_end_date
    );

  else -- cancel
    if v_collab_status not in ('agreed', 'scheduled', 'active') then
      return jsonb_build_object('result', 'invalid_transition', 'status', v_collab_status);
    end if;
    if p_event_at is null
       or p_cancel_reason is null
       or not (p_cancel_reason = any (c_cancel_reasons)) then
      return jsonb_build_object('result', 'invalid_input');
    end if;
    if p_event_at > now() + c_future_slack then
      return jsonb_build_object('result', 'invalid_event_time');
    end if;
    if v_collab_status = 'active' and v_started_at is not null and p_event_at < v_started_at then
      return jsonb_build_object('result', 'invalid_event_time');
    end if;

    -- Cancelling an ACTIVE collaboration closes its date range, when the caller
    -- supplied the cancellation day and no end date is recorded yet. Cancelling
    -- before it ever started leaves end_date alone: there was no period to end.
    v_end_date := case
      when v_collab_status = 'active' and v_collab_end is null then p_end_date
      else v_collab_end
    end;

    if v_end_date is not null and v_collab_start is not null and v_end_date < v_collab_start then
      return jsonb_build_object('result', 'invalid_input');
    end if;

    update public.collaborations
       set status = 'cancelled',
           end_date = v_end_date
     where id = v_collaboration_id;

    -- NOT deal_lost. The deal was won; the collaboration was cancelled
    -- afterwards (D045). `creator_closed_pipeline` already means "closed
    -- without a deal-loss classification", so no new event type is needed to
    -- finish this slice.
    insert into public.outreach_events
      (creator_id, hotel_id, pipeline_item_id, event_type, event_at, metadata, source)
    values
      (v_creator_id, v_hotel_id, p_pipeline_item_id, 'creator_closed_pipeline', p_event_at,
       jsonb_build_object(
         'reason', 'collaboration_cancelled',
         'cancellation_reason', p_cancel_reason,
         'collaboration_id', v_collaboration_id
       ),
       'manual_creator');

    update public.pipeline_items
       set status = 'closed', last_activity_at = now()
     where id = p_pipeline_item_id;

    return jsonb_build_object(
      'result', 'applied',
      'collaboration_status', 'cancelled',
      'pipeline_status', 'closed',
      'end_date', v_end_date
    );
  end if;
end;
$$;

comment on function public.progress_collaboration(uuid, uuid, text, timestamptz, date, date, text, boolean, text) is
  'Transactional collaboration lifecycle: agreed → scheduled → active → completed | cancelled, closing the won pipeline cycle on a terminal state (D045). Trusted server code only (service_role). A cancellation never emits deal_lost and never erases deal_won.';

-- Trusted server work only. Hosted Supabase can grant EXECUTE to client roles
-- by default, so revoke explicitly before granting (cf. 0018).
revoke all on function public.progress_collaboration(uuid, uuid, text, timestamptz, date, date, text, boolean, text)
  from public, anon, authenticated;

grant execute on function public.progress_collaboration(uuid, uuid, text, timestamptz, date, date, text, boolean, text)
  to service_role;
