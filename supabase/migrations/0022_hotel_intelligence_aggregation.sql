-- 0022_hotel_intelligence_aggregation.sql
-- Sprint 2E: the first real derivation of hotel intelligence from creator
-- workflow events (PRD §12, DATABASE.md §9, EVENTS.md §6, D008/D009/D011/D012,
-- and the metric semantics recorded as D044).
--
--   outreach_events  →  hotel_intelligence  →  hotel_public_intelligence  →  UI
--
-- Three things happen here:
--
--  1. Rebuildable aggregation. Every metric is a pure function of the canonical
--     event history, so recomputing over unchanged facts always produces the
--     same numbers, and a full rebuild can reconstruct the whole derived table
--     from scratch. Nothing here writes to a creator's workflow — derived data
--     never edits its own source.
--
--  2. Privacy hardening, BEFORE any real intelligence row exists. The base
--     tables hold exact counts and timestamps; authenticated clients lose
--     direct SELECT on them and read the gated projection instead. Suppressing
--     a number in React is presentation, not authorization.
--
--  3. Progressive disclosure in the public view. Below the confidence a metric
--     needs, the view returns NULL — never `false` and never `0`, because both
--     of those assert a fact about the world that we deliberately withheld.
--
-- Additive; migrations 0001–0021 are unchanged.

-- ===========================================================================
-- 1. Base-table privacy boundary
--
-- 0012 granted authenticated creators direct SELECT on the intelligence base
-- tables, with RLS limiting *which rows*. But the rows themselves carry exact
-- pitch/reply counts and precise activity timestamps — the very values the
-- product suppresses below high confidence. A technically capable premium user
-- could read them straight from PostgREST and reconstruct low-N claims about a
-- hotel, so UI gating alone is not a boundary.
--
-- Product reads go through `hotel_public_intelligence` (a definer-rights view,
-- so it keeps working without any base-table grant). service_role retains
-- access for aggregation. The 0012 policies stay as defence in depth, and 0012
-- itself is untouched.
-- ===========================================================================

revoke select on public.hotel_intelligence from authenticated;
revoke select on public.destination_intelligence from authenticated;

comment on table public.hotel_intelligence is
  'Derived hotel metrics, rebuildable from outreach_events. Client SELECT is revoked (0022): exact counts and timestamps are read only by trusted server code; product surfaces read the gated hotel_public_intelligence view (DATABASE.md §9, D009).';

comment on table public.destination_intelligence is
  'Derived destination metrics. Client SELECT is revoked (0022) for the same privacy reason as hotel_intelligence. Destination aggregation itself is a later sprint.';

-- ===========================================================================
-- 2. Per-hotel recompute
--
-- The unit of observation is a RELATIONSHIP CYCLE, not an event: a creator who
-- pitches, follows up three times and replies to themselves is one data point,
-- not five. That is what makes the confidence bands honest (D044).
-- ===========================================================================

-- Stable lock key for one hotel's aggregation. Namespaced so it cannot collide
-- with the import-batch advisory locks, which hash a bare uuid the same way.
create or replace function public.hotel_intelligence_lock_key(p_hotel_id uuid)
returns bigint
language sql
immutable
set search_path = public, pg_temp
as $$
  select hashtextextended('hotel_intelligence:' || p_hotel_id::text, 0);
$$;

comment on function public.hotel_intelligence_lock_key(uuid) is
  'Deterministic advisory-lock key serializing recomputation of one hotel''s derived intelligence.';

create or replace function public.recompute_hotel_intelligence(p_hotel_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  -- Primary domain moments only. Classifications (positive_reply,
  -- negative_reply, offer_received) enrich another event and must not be
  -- counted again; hotel_saved is creator intent, not hotel interaction; and
  -- creator_closed_pipeline can precede any outreach at all (D044 §4).
  c_primary constant text[] := array[
    'pitch_sent', 'followup_sent', 'reply_received', 'negotiation_started',
    'deal_won', 'deal_lost', 'collaboration_started', 'collaboration_completed'
  ];

  v_pitch_count integer := 0;
  v_reply_count integer := 0;
  v_positive integer := 0;
  v_negative integer := 0;
  v_collaborations integer := 0;
  v_reply_rate numeric;
  v_median_hours numeric;
  v_30d integer := 0;
  v_90d integer := 0;
  v_365d integer := 0;
  v_active_cycles_90d integer := 0;
  v_last_activity timestamptz;
  v_last_reply timestamptz;
  v_last_collaboration timestamptz;
  v_confidence text;
  v_activity text;
  v_has_activity boolean;
begin
  if p_hotel_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  if not exists (select 1 from public.hotels where id = p_hotel_id) then
    return jsonb_build_object('result', 'hotel_not_found');
  end if;

  -- Serialize recomputation FOR THIS HOTEL before reading any facts.
  --
  -- Without it, two refreshes triggered by two creators can interleave: the
  -- second reads newer history and finishes first, then the first — working
  -- from an older snapshot — overwrites it with stale aggregates. With no
  -- scheduled rebuild yet, that wrong row would simply persist. The lock is
  -- transaction-scoped, so it is released the moment this call commits, and it
  -- is keyed per hotel, so aggregating hotel A never blocks hotel B.
  --
  -- This does NOT pull aggregation into the workflow transaction: the caller is
  -- still a separate post-commit, best-effort operation, and a failure here
  -- still cannot roll back a creator's recorded event.
  perform pg_advisory_xact_lock(public.hotel_intelligence_lock_key(p_hotel_id));

  -- A hotel with no primary activity gets NO derived row. "Not enough creator
  -- data yet" is an absence, and must never be stored as pitch_count = 0 /
  -- activity_level = 'low', which would read as a claim about the hotel.
  v_has_activity := exists (
    select 1 from public.outreach_events oe
     where oe.hotel_id = p_hotel_id
       and oe.event_type = any (c_primary)
  );

  if not v_has_activity then
    delete from public.hotel_intelligence where hotel_id = p_hotel_id;
    return jsonb_build_object('result', 'no_data', 'hotel_id', p_hotel_id);
  end if;

  with pitched_cycles as (
    -- One row per relationship cycle that has a pitch; the EARLIEST pitch is
    -- the initial one, and the cycle counts once however many pitches exist.
    select oe.pipeline_item_id, min(oe.event_at) as initial_pitch_at
      from public.outreach_events oe
     where oe.hotel_id = p_hotel_id
       and oe.event_type = 'pitch_sent'
     group by oe.pipeline_item_id
  ),
  qualifying_replies as (
    -- The FIRST reply at or after the initial pitch. A reply that predates its
    -- pitch is not evidence the pitch worked, so it does not qualify; a reply
    -- with no pitch at all never enters the funnel.
    select distinct on (pc.pipeline_item_id)
           pc.pipeline_item_id,
           pc.initial_pitch_at,
           oe.id as reply_event_id,
           oe.event_at as first_reply_at
      from pitched_cycles pc
      join public.outreach_events oe
        on oe.pipeline_item_id = pc.pipeline_item_id
       and oe.event_type = 'reply_received'
       and oe.event_at >= pc.initial_pitch_at
     order by pc.pipeline_item_id, oe.event_at, oe.id
  ),
  classified as (
    select
      qr.pipeline_item_id,
      -- Classification is tied to the qualifying reply through
      -- metadata.reply_event_id (written by the workflow RPC). An event that
      -- carries no reference — an admin correction, say — falls back to "in
      -- this cycle, at or after the qualifying reply" rather than being lost.
      exists (
        select 1 from public.outreach_events c
         where c.pipeline_item_id = qr.pipeline_item_id
           and c.event_type = 'positive_reply'
           and (
             (c.metadata ->> 'reply_event_id') = qr.reply_event_id::text
             or ((c.metadata ->> 'reply_event_id') is null and c.event_at >= qr.first_reply_at)
           )
      ) as is_positive,
      exists (
        select 1 from public.outreach_events c
         where c.pipeline_item_id = qr.pipeline_item_id
           and c.event_type = 'negative_reply'
           and (
             (c.metadata ->> 'reply_event_id') = qr.reply_event_id::text
             or ((c.metadata ->> 'reply_event_id') is null and c.event_at >= qr.first_reply_at)
           )
      ) as is_negative,
      -- Domain chronology only: event_at, never created_at. A backfilled pitch
      -- must measure from when it was sent, not from when it was typed in.
      extract(epoch from (qr.first_reply_at - qr.initial_pitch_at)) / 3600.0 as reply_hours
      from qualifying_replies qr
  )
  select
    (select count(*) from pitched_cycles),
    (select count(*) from qualifying_replies),
    (select count(*) from classified where is_positive),
    (select count(*) from classified where is_negative),
    -- Negative durations cannot occur given the join, but excluding them keeps
    -- the median honest if history is ever corrected by hand.
    (select percentile_cont(0.5) within group (order by reply_hours)
       from classified where reply_hours >= 0)
  into v_pitch_count, v_reply_count, v_positive, v_negative, v_median_hours;

  select count(distinct oe.pipeline_item_id)
    into v_collaborations
    from public.outreach_events oe
   where oe.hotel_id = p_hotel_id
     and oe.event_type = 'deal_won';

  -- Rolling windows count EVENTS, and always by event_at.
  select
    count(*) filter (where oe.event_at >= now() - interval '30 days'),
    count(*) filter (where oe.event_at >= now() - interval '90 days'),
    count(*) filter (where oe.event_at >= now() - interval '365 days'),
    count(distinct oe.pipeline_item_id)
      filter (where oe.event_at >= now() - interval '90 days'),
    max(oe.event_at)
    into v_30d, v_90d, v_365d, v_active_cycles_90d, v_last_activity
    from public.outreach_events oe
   where oe.hotel_id = p_hotel_id
     and oe.event_type = any (c_primary);

  -- Recency uses qualifying replies only, for the same reason the counts do.
  select max(oe.event_at)
    into v_last_reply
    from public.outreach_events oe
    join (
      select oe2.pipeline_item_id, min(oe2.event_at) as initial_pitch_at
        from public.outreach_events oe2
       where oe2.hotel_id = p_hotel_id and oe2.event_type = 'pitch_sent'
       group by oe2.pipeline_item_id
    ) pc on pc.pipeline_item_id = oe.pipeline_item_id
   where oe.hotel_id = p_hotel_id
     and oe.event_type = 'reply_received'
     and oe.event_at >= pc.initial_pitch_at;

  select max(oe.event_at)
    into v_last_collaboration
    from public.outreach_events oe
   where oe.hotel_id = p_hotel_id
     and oe.event_type = 'deal_won';

  -- NULL means "not measurable" — there is no denominator. A numeric 0 means
  -- "measured, and nobody replied", which is a real and useful finding. The two
  -- are different answers and must not be collapsed.
  v_reply_rate := case
    when v_pitch_count > 0 then round(v_reply_count::numeric / v_pitch_count, 4)
    else null
  end;

  -- Confidence describes the SAMPLE behind the metric — pitched relationship
  -- cycles — not how many buttons were pressed (D012, D044 §2).
  v_confidence := case
    when v_pitch_count >= 50 then 'strong'
    when v_pitch_count >= 15 then 'moderate'
    when v_pitch_count >= 5 then 'emerging'
    else 'insufficient'
  end;

  -- Activity counts DISTINCT recently active cycles, so one creator having a
  -- busy month with one hotel cannot make that hotel look globally popular.
  -- Zero recent cycles is NULL, never 'low': no label beats a false one.
  v_activity := case
    when v_active_cycles_90d >= 10 then 'high'
    when v_active_cycles_90d >= 5 then 'medium'
    when v_active_cycles_90d >= 2 then 'low'
    when v_active_cycles_90d = 1 then 'emerging'
    else null
  end;

  insert into public.hotel_intelligence as hi (
    hotel_id,
    interaction_count_30d, interaction_count_90d, interaction_count_365d,
    pitch_count, reply_count, positive_reply_count, negative_reply_count,
    collaboration_count, reply_rate, median_reply_hours,
    last_creator_activity_at, last_reply_at, last_collaboration_at,
    activity_level, confidence_level, calculated_at
  )
  values (
    p_hotel_id,
    coalesce(v_30d, 0), coalesce(v_90d, 0), coalesce(v_365d, 0),
    v_pitch_count, v_reply_count, v_positive, v_negative,
    v_collaborations, v_reply_rate, v_median_hours,
    v_last_activity, v_last_reply, v_last_collaboration,
    v_activity, v_confidence, now()
  )
  on conflict (hotel_id) do update set
    interaction_count_30d = excluded.interaction_count_30d,
    interaction_count_90d = excluded.interaction_count_90d,
    interaction_count_365d = excluded.interaction_count_365d,
    pitch_count = excluded.pitch_count,
    reply_count = excluded.reply_count,
    positive_reply_count = excluded.positive_reply_count,
    negative_reply_count = excluded.negative_reply_count,
    collaboration_count = excluded.collaboration_count,
    reply_rate = excluded.reply_rate,
    median_reply_hours = excluded.median_reply_hours,
    last_creator_activity_at = excluded.last_creator_activity_at,
    last_reply_at = excluded.last_reply_at,
    last_collaboration_at = excluded.last_collaboration_at,
    activity_level = excluded.activity_level,
    confidence_level = excluded.confidence_level,
    calculated_at = excluded.calculated_at;

  return jsonb_build_object(
    'result', 'recomputed',
    'hotel_id', p_hotel_id,
    'confidence_level', v_confidence
  );
end;
$$;

comment on function public.recompute_hotel_intelligence(uuid) is
  'Rebuild one hotel''s derived intelligence from canonical outreach_events. Trusted server code only (service_role). Pure derivation: it never writes to outreach_events, pipeline_items, collaborations, contacts or editorial evidence, and it deletes the derived row when no qualifying activity remains (D044).';

-- ===========================================================================
-- 3. Pipeline-item wrapper
--
-- Server actions refresh intelligence after a workflow mutation. They must not
-- pass a hotel id: the browser supplies one, and a valid workflow action must
-- never become a way to aim service-role aggregation at an arbitrary hotel.
-- The item id was just mutated and verified, so the hotel is resolved from it.
-- ===========================================================================

create or replace function public.recompute_hotel_intelligence_for_pipeline_item(
  p_pipeline_item_id uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_hotel_id uuid;
  v_outcome jsonb;
begin
  if p_pipeline_item_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select pi.hotel_id into v_hotel_id
    from public.pipeline_items pi
   where pi.id = p_pipeline_item_id;

  if v_hotel_id is null then
    return jsonb_build_object('result', 'pipeline_item_not_found');
  end if;

  v_outcome := public.recompute_hotel_intelligence(v_hotel_id);

  -- Deliberately narrow: this is a mutation hook, not a data read. It reports
  -- whether the refresh ran, never the aggregate values themselves.
  return jsonb_build_object('result', v_outcome ->> 'result');
end;
$$;

comment on function public.recompute_hotel_intelligence_for_pipeline_item(uuid) is
  'Refresh derived intelligence for the hotel behind a pipeline item, resolved in the database so no caller-supplied hotel id is ever trusted. Returns only a sanitized status.';

-- ===========================================================================
-- 4. Deterministic full rebuild
--
-- Intelligence is explicitly rebuildable (D008): the derived table can always
-- be reconstructed from raw facts, which is what makes corrections safe. This
-- also removes derived rows whose source data no longer qualifies.
-- ===========================================================================

create or replace function public.recompute_all_hotel_intelligence()
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  c_primary constant text[] := array[
    'pitch_sent', 'followup_sent', 'reply_received', 'negotiation_started',
    'deal_won', 'deal_lost', 'collaboration_started', 'collaboration_completed'
  ];
  v_hotel_id uuid;
  v_had_row boolean;
  v_outcome text;
  v_recomputed integer := 0;
  v_removed integer := 0;
begin
  -- Every hotel that either HAS activity or currently has a derived row: the
  -- second half is what makes stale rows disappear after a correction. The
  -- cursor's snapshot is taken here, so `v_had_row` reports the state BEFORE
  -- this rebuild touched anything.
  for v_hotel_id, v_had_row in
    select h.id,
           exists (select 1 from public.hotel_intelligence hi where hi.hotel_id = h.id)
      from public.hotels h
     where exists (
             select 1 from public.outreach_events oe
              where oe.hotel_id = h.id and oe.event_type = any (c_primary)
           )
        or exists (select 1 from public.hotel_intelligence hi where hi.hotel_id = h.id)
     order by h.id
  loop
    v_outcome := public.recompute_hotel_intelligence(v_hotel_id) ->> 'result';

    -- Count what actually happened per hotel. A net before/after row count
    -- would silently cancel a removal against an addition and report zero
    -- removals for a rebuild that really did delete a stale row.
    if v_outcome = 'recomputed' then
      v_recomputed := v_recomputed + 1;
    elsif v_outcome = 'no_data' and v_had_row then
      v_removed := v_removed + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'result', 'rebuilt',
    'recomputed', v_recomputed,
    'removed', v_removed
  );
end;
$$;

comment on function public.recompute_all_hotel_intelligence() is
  'Deterministic full rebuild of hotel_intelligence from canonical events. Never truncates or modifies raw creator data; removes derived rows that no longer have qualifying source events.';

-- Aggregation is trusted server work only. Hosted Supabase can grant EXECUTE to
-- client roles by default, so revoke explicitly before granting (cf. 0018).
revoke all on function public.hotel_intelligence_lock_key(uuid) from public, anon, authenticated;
revoke all on function public.recompute_hotel_intelligence(uuid) from public, anon, authenticated;
revoke all on function public.recompute_hotel_intelligence_for_pipeline_item(uuid)
  from public, anon, authenticated;
revoke all on function public.recompute_all_hotel_intelligence() from public, anon, authenticated;

grant execute on function public.hotel_intelligence_lock_key(uuid) to service_role;
grant execute on function public.recompute_hotel_intelligence(uuid) to service_role;
grant execute on function public.recompute_hotel_intelligence_for_pipeline_item(uuid) to service_role;
grant execute on function public.recompute_all_hotel_intelligence() to service_role;

-- ===========================================================================
-- 5. Progressive disclosure in the public projection
--
-- Same purpose and shape as 0013 — no creator_id, no pipeline_item_id, no
-- exact counts, no raw timestamps — but each metric now appears only once the
-- sample behind it can carry the claim.
--
-- Suppression returns NULL, never `false` and never `0`. Reporting
-- has_confirmed_collaboration = false for a hotel we simply refused to answer
-- about would be a fabricated domain fact, and a damaging one.
-- ===========================================================================

create or replace view public.hotel_public_intelligence
with (security_invoker = false) as
select
  h.id as hotel_id,
  h.slug as hotel_slug,
  -- Coarse activity from `emerging` confidence upward.
  case
    when hi.confidence_level in ('emerging', 'moderate', 'strong') then hi.activity_level
    else null
  end as activity_level,
  hi.confidence_level,
  -- Precise reply rate only at `strong`.
  case
    when hi.confidence_level = 'strong' then hi.reply_rate
    else null
  end as reply_rate,
  -- A confirmed-collaboration boolean (EVENTS.md §7) from `emerging` upward;
  -- NULL below that — withheld, not denied.
  case
    when hi.confidence_level in ('emerging', 'moderate', 'strong')
      then (hi.collaboration_count > 0)
    else null
  end as has_confirmed_collaboration,
  -- Coarse recency band from `moderate` upward.
  case
    when hi.confidence_level not in ('moderate', 'strong') then null
    when hi.last_creator_activity_at is null then null
    when hi.last_creator_activity_at >= now() - interval '30 days' then 'past_month'
    when hi.last_creator_activity_at >= now() - interval '90 days' then 'past_quarter'
    else 'older'
  end as recency_band
from public.hotels h
join public.hotel_intelligence hi on hi.hotel_id = h.id;

comment on view public.hotel_public_intelligence is
  'Safe public projection of hotel intelligence. No creator identifiers, no exact counts, no raw timestamps. Each metric is gated by the confidence its sample supports, and suppression yields NULL rather than a fabricated false/zero (D009, D012, D044).';

grant select on public.hotel_public_intelligence to anon, authenticated;
