-- 0026_premium_intelligence.sql
--
-- The V1 Public/Premium Creator Network Intelligence split (D050, and the
-- metric contract recorded as D057/D058).
--
--   outreach_events + collaborations
--        ↓  recompute_hotel_intelligence   (trusted, rebuildable)
--   hotel_intelligence                      (server-only: exact counts)
--        ↓
--   hotel_public_intelligence   — everyone, coarse
--   hotel_premium_intelligence  — entitlement-gated in the DATABASE, richer
--
-- Three things happen here:
--
--  1. The derived table gains 365-day windowed aggregates and, crucially,
--     DISTINCT-CREATOR counts. Every BEHAVIOURAL signal — public and premium
--     alike — is gated on contributor diversity, because a signal supported by
--     one busy creator describes that creator and not the hotel.
--
--  2. `reply_rate` LEAVES the public projection. It is the most actionable
--     behavioural signal the network produces, and D050 classifies it as
--     premium. Removing a column requires dropping and recreating the view.
--
--  3. A second, deliberately scoped projection is added for premium. It is
--     gated by `public.has_premium_hotel_access(hotel_id)` INSIDE the view, so
--     entitlement is enforced by the database rather than by the UI, exactly
--     as `hotel_contacts` already is.
--
-- PRIVACY INVARIANT (D050): premium buys MORE OF THE SAFE AGGREGATE, never
-- weaker privacy. No threshold below is lower than its public counterpart, and
-- the base tables remain unreachable by every browser role.
--
-- What "no counts" means precisely: no RAW OUTREACH COUNT reaches any client
-- role — no pitch count, reply count, event count, cycle denominator, or raw
-- timestamp. Premium DOES expose one count, deliberately: the distinct-creator
-- sample (`contributor_count`), and only once it clears its own >= 5 floor, so
-- the number can never be small enough to point at anyone.
--
-- Publication thresholds are METRIC-SPECIFIC, not a uniform pair. The reply
-- metrics need both qualifying-cycle volume and contributor diversity; the
-- recency, activity and collaboration signals rely on their approved
-- distinct-creator population floor, which IS the relevant floor for them.
--
-- Additive; migrations 0001–0025 are unchanged.

-- ===========================================================================
-- 1. Derived support for the premium metrics
--
-- All additive columns on the existing rebuildable aggregate. They are derived
-- facts, not editorial truth: a full rebuild reconstructs every one of them
-- from the canonical event history (D008).
-- ===========================================================================

alter table public.hotel_intelligence
  -- Reply rate, over a trailing 365-day window of qualifying pitched cycles.
  add column if not exists pitched_cycles_365d integer not null default 0,
  add column if not exists replied_cycles_365d integer not null default 0,
  add column if not exists distinct_pitch_creators_365d integer not null default 0,
  add column if not exists distinct_reply_creators_365d integer not null default 0,
  add column if not exists reply_rate_365d numeric,
  -- Median hours from initial qualifying pitch to first qualifying reply.
  add column if not exists median_reply_hours_365d numeric,
  -- Contributor diversity per recency window. These are what make a recency
  -- band publishable without revealing that one identifiable creator acted.
  add column if not exists distinct_creators_7d integer not null default 0,
  add column if not exists distinct_creators_30d integer not null default 0,
  add column if not exists distinct_creators_90d integer not null default 0,
  add column if not exists distinct_creators_365d integer not null default 0,
  -- Distinct creators with an observed collaboration outcome in 365 days. This
  -- is the floor for the PUBLIC collaboration-presence signal: "creators have
  -- collaborated here" is a behavioural claim, and one creator cannot make it.
  add column if not exists distinct_collaboration_creators_365d integer not null default 0,
  -- {"stay": 4, "paid": 2} — collaboration type → distinct creators observed.
  -- Stored with counts so the threshold lives in one place (the projection),
  -- and so a rebuild can change the threshold without re-deriving history.
  add column if not exists collaboration_type_creators_365d jsonb not null default '{}'::jsonb;

comment on column public.hotel_intelligence.reply_rate_365d is
  'Qualifying pitched cycles with at least one qualifying human reply / qualifying pitched cycles, over a trailing 365 days. A cycle counts once however many follow-ups it contains. NULL means no denominator; 0 means measured and unanswered.';

comment on column public.hotel_intelligence.distinct_collaboration_creators_365d is
  'Distinct creators with an OBSERVED collaboration outcome in the trailing 365 days. Creator Network provenance only (D057): derived from collaborations recorded through the creator workflow, never from research/editorial evidence, hotel declarations or hotel outreach.';

comment on column public.hotel_intelligence.collaboration_type_creators_365d is
  'Collaboration type → number of DISTINCT creators who recorded that outcome in the trailing 365 days. Observed creator outcomes only — never what a hotel says it accepts.';

-- ===========================================================================
-- 2. Recompute, extended
--
-- Same contract as 0022: pure derivation, per-hotel advisory lock, no writes to
-- creator data, and no derived row at all when nothing qualifies. The 365-day
-- block is added; every pre-existing metric keeps its exact prior semantics.
-- ===========================================================================

create or replace function public.recompute_hotel_intelligence(p_hotel_id uuid)
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

  -- 365-day premium support.
  v_pitched_365 integer := 0;
  v_replied_365 integer := 0;
  v_pitch_creators_365 integer := 0;
  v_reply_creators_365 integer := 0;
  v_reply_rate_365 numeric;
  v_median_365 numeric;
  v_creators_7d integer := 0;
  v_creators_30d integer := 0;
  v_creators_90d integer := 0;
  v_creators_365d integer := 0;
  v_collab_creators_365 integer := 0;
  v_collab_types jsonb := '{}'::jsonb;
begin
  if p_hotel_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  if not exists (select 1 from public.hotels where id = p_hotel_id) then
    return jsonb_build_object('result', 'hotel_not_found');
  end if;

  perform pg_advisory_xact_lock(public.hotel_intelligence_lock_key(p_hotel_id));

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
    select oe.pipeline_item_id, min(oe.event_at) as initial_pitch_at
      from public.outreach_events oe
     where oe.hotel_id = p_hotel_id
       and oe.event_type = 'pitch_sent'
     group by oe.pipeline_item_id
  ),
  qualifying_replies as (
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
      extract(epoch from (qr.first_reply_at - qr.initial_pitch_at)) / 3600.0 as reply_hours
      from qualifying_replies qr
  )
  select
    (select count(*) from pitched_cycles),
    (select count(*) from qualifying_replies),
    (select count(*) from classified where is_positive),
    (select count(*) from classified where is_negative),
    (select percentile_cont(0.5) within group (order by reply_hours)
       from classified where reply_hours >= 0)
  into v_pitch_count, v_reply_count, v_positive, v_negative, v_median_hours;

  -- -----------------------------------------------------------------------
  -- Trailing 365 days, keyed on the INITIAL pitch.
  --
  -- The window is anchored to when the creator pitched, not to when the hotel
  -- replied, so a slow reply cannot pull an old pitch back into the sample and
  -- a fast reply cannot push a recent one out. `creator_id` is grouped with
  -- `pipeline_item_id` only because it is functionally dependent on it — one
  -- cycle belongs to exactly one creator.
  -- -----------------------------------------------------------------------
  with w_pitched as (
    select oe.pipeline_item_id, oe.creator_id, min(oe.event_at) as initial_pitch_at
      from public.outreach_events oe
     where oe.hotel_id = p_hotel_id
       and oe.event_type = 'pitch_sent'
     group by oe.pipeline_item_id, oe.creator_id
    having min(oe.event_at) >= now() - interval '365 days'
  ),
  w_replied as (
    select distinct on (wp.pipeline_item_id)
           wp.pipeline_item_id, wp.creator_id, wp.initial_pitch_at,
           oe.event_at as first_reply_at
      from w_pitched wp
      join public.outreach_events oe
        on oe.pipeline_item_id = wp.pipeline_item_id
       and oe.event_type = 'reply_received'
       and oe.event_at >= wp.initial_pitch_at
     order by wp.pipeline_item_id, oe.event_at, oe.id
  )
  select
    (select count(*) from w_pitched),
    (select count(distinct creator_id) from w_pitched),
    (select count(*) from w_replied),
    (select count(distinct creator_id) from w_replied),
    (select percentile_cont(0.5) within group (
              order by extract(epoch from (first_reply_at - initial_pitch_at)) / 3600.0)
       from w_replied
      where first_reply_at >= initial_pitch_at)
  into v_pitched_365, v_pitch_creators_365, v_replied_365, v_reply_creators_365, v_median_365;

  select count(distinct oe.pipeline_item_id)
    into v_collaborations
    from public.outreach_events oe
   where oe.hotel_id = p_hotel_id
     and oe.event_type = 'deal_won';

  select
    count(*) filter (where oe.event_at >= now() - interval '30 days'),
    count(*) filter (where oe.event_at >= now() - interval '90 days'),
    count(*) filter (where oe.event_at >= now() - interval '365 days'),
    count(distinct oe.pipeline_item_id)
      filter (where oe.event_at >= now() - interval '90 days'),
    max(oe.event_at),
    -- Contributor diversity per window. This is the number that decides
    -- whether a recency band or a sample disclosure may be published at all.
    count(distinct oe.creator_id) filter (where oe.event_at >= now() - interval '7 days'),
    count(distinct oe.creator_id) filter (where oe.event_at >= now() - interval '30 days'),
    count(distinct oe.creator_id) filter (where oe.event_at >= now() - interval '90 days'),
    count(distinct oe.creator_id) filter (where oe.event_at >= now() - interval '365 days')
    into v_30d, v_90d, v_365d, v_active_cycles_90d, v_last_activity,
         v_creators_7d, v_creators_30d, v_creators_90d, v_creators_365d
    from public.outreach_events oe
   where oe.hotel_id = p_hotel_id
     and oe.event_type = any (c_primary);

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

  -- -----------------------------------------------------------------------
  -- Collaboration TYPES OBSERVED — creator outcomes, never hotel declarations.
  --
  -- Dated by `agreed_at`, the domain instant the creator recorded, never by
  -- `created_at`. A collaboration with no `agreed_at` cannot be placed in the
  -- window and is deliberately excluded rather than dated by row creation.
  -- Private financial columns are not read here and never will be (D050).
  -- -----------------------------------------------------------------------
  -- Distinct creators with ANY observed collaboration in the window. Type is
  -- not required here: presence is a different question from "which kinds".
  -- Status is not filtered either — a cancelled collaboration was still agreed,
  -- and D045 is explicit that cancellation is not a retraction of the deal.
  select count(distinct c.creator_id)
    into v_collab_creators_365
    from public.collaborations c
   where c.hotel_id = p_hotel_id
     and c.agreed_at is not null
     and c.agreed_at >= now() - interval '365 days';

  select coalesce(jsonb_object_agg(t.collaboration_type, t.creators), '{}'::jsonb)
    into v_collab_types
    from (
      select c.collaboration_type, count(distinct c.creator_id) as creators
        from public.collaborations c
       where c.hotel_id = p_hotel_id
         and c.collaboration_type is not null
         and c.agreed_at is not null
         and c.agreed_at >= now() - interval '365 days'
       group by c.collaboration_type
    ) t;

  v_reply_rate := case
    when v_pitch_count > 0 then round(v_reply_count::numeric / v_pitch_count, 4)
    else null
  end;

  v_reply_rate_365 := case
    when v_pitched_365 > 0 then round(v_replied_365::numeric / v_pitched_365, 4)
    else null
  end;

  v_confidence := case
    when v_pitch_count >= 50 then 'strong'
    when v_pitch_count >= 15 then 'moderate'
    when v_pitch_count >= 5 then 'emerging'
    else 'insufficient'
  end;

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
    activity_level, confidence_level, calculated_at,
    pitched_cycles_365d, replied_cycles_365d,
    distinct_pitch_creators_365d, distinct_reply_creators_365d,
    reply_rate_365d, median_reply_hours_365d,
    distinct_creators_7d, distinct_creators_30d, distinct_creators_90d,
    distinct_creators_365d, distinct_collaboration_creators_365d,
    collaboration_type_creators_365d
  )
  values (
    p_hotel_id,
    coalesce(v_30d, 0), coalesce(v_90d, 0), coalesce(v_365d, 0),
    v_pitch_count, v_reply_count, v_positive, v_negative,
    v_collaborations, v_reply_rate, v_median_hours,
    v_last_activity, v_last_reply, v_last_collaboration,
    v_activity, v_confidence, now(),
    coalesce(v_pitched_365, 0), coalesce(v_replied_365, 0),
    coalesce(v_pitch_creators_365, 0), coalesce(v_reply_creators_365, 0),
    v_reply_rate_365, v_median_365,
    coalesce(v_creators_7d, 0), coalesce(v_creators_30d, 0),
    coalesce(v_creators_90d, 0), coalesce(v_creators_365d, 0),
    coalesce(v_collab_creators_365, 0),
    coalesce(v_collab_types, '{}'::jsonb)
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
    calculated_at = excluded.calculated_at,
    pitched_cycles_365d = excluded.pitched_cycles_365d,
    replied_cycles_365d = excluded.replied_cycles_365d,
    distinct_pitch_creators_365d = excluded.distinct_pitch_creators_365d,
    distinct_reply_creators_365d = excluded.distinct_reply_creators_365d,
    reply_rate_365d = excluded.reply_rate_365d,
    median_reply_hours_365d = excluded.median_reply_hours_365d,
    distinct_creators_7d = excluded.distinct_creators_7d,
    distinct_creators_30d = excluded.distinct_creators_30d,
    distinct_creators_90d = excluded.distinct_creators_90d,
    distinct_creators_365d = excluded.distinct_creators_365d,
    distinct_collaboration_creators_365d = excluded.distinct_collaboration_creators_365d,
    collaboration_type_creators_365d = excluded.collaboration_type_creators_365d;

  return jsonb_build_object(
    'result', 'recomputed',
    'hotel_id', p_hotel_id,
    'confidence_level', v_confidence
  );
end;
$$;

comment on function public.recompute_hotel_intelligence(uuid) is
  'Rebuild one hotel''s derived intelligence from canonical outreach_events and collaborations. Trusted server code only (service_role). Pure derivation: it never writes to outreach_events, pipeline_items, collaborations, contacts or editorial evidence, never reads private collaboration values, and deletes the derived row when no qualifying activity remains (D044, D057).';

-- ===========================================================================
-- 3. Public projection — reply rate removed
--
-- `create or replace view` cannot drop a column, so the view is dropped and
-- rebuilt. Grants do not survive that, and are restated below exactly as
-- 0024/0025 left them: SELECT for anon, authenticated and service_role, and
-- nothing else.
--
-- Also tightened: EVERY public behavioural signal now requires contributor
-- diversity, not only confidence.
--
-- Confidence counts pitched CYCLES, and fifteen cycles can belong to one
-- creator. Under the old gates, one busy creator could produce
-- "Activity: high", "creator collaboration", and "creator activity in the past
-- month" — three behavioural statements about a hotel that were really three
-- statements about one identifiable person's month, published to anonymous
-- visitors. D050 requires the same privacy rule for a metric on every plan, so
-- the public signals get the same contributor floors the premium ones have:
--
--   activity_level            confidence gate AND >= 3 distinct creators / 90d
--   recency_band (recent)     confidence gate AND >= 3 distinct creators / 90d
--   has_observed_collaboration              >= 3 distinct collaborating creators / 365d
--
-- Suppression is NULL in every case. A suppressed activity level is not `low`,
-- and a suppressed collaboration answer is not `false`.
-- ===========================================================================

drop view if exists public.hotel_public_intelligence;

create view public.hotel_public_intelligence
with (security_invoker = false) as
select
  h.id as hotel_id,
  h.slug as hotel_slug,
  -- Activity is a behavioural claim about a hotel, so it needs a population:
  -- the confidence gate AND three distinct creators active in 90 days. Below
  -- that the answer is NULL — withheld, NOT `low`.
  case
    when hi.confidence_level in ('emerging', 'moderate', 'strong')
     and hi.distinct_creators_90d >= 3
      then hi.activity_level
    else null
  end as activity_level,
  hi.confidence_level,
  -- POSITIVE PRESENCE ONLY, and only with three distinct collaborating
  -- creators behind it. `true` means "creators have collaborated here";
  -- there is no `false`, because too few observed outcomes cannot prove that a
  -- hotel does not collaborate — it proves only that we have not seen it.
  --
  -- Named OBSERVED, never CONFIRMED: this is a Creator Network fact derived
  -- from what creators recorded. "Confirmed" is reserved for hotel-confirmed
  -- intelligence and editorial verification (D057).
  case
    when hi.distinct_collaboration_creators_365d >= 3 then true
    else null
  end as has_observed_collaboration,
  case
    when hi.confidence_level not in ('moderate', 'strong') then null
    when hi.last_creator_activity_at is null then null
    -- A RECENT band describes what creators are doing now, so it needs a
    -- population behind it: three distinct contributors in the trailing 90
    -- days. Below that, "creator activity in the past month" would be one
    -- identifiable person's week, published to anyone.
    when hi.last_creator_activity_at >= now() - interval '90 days' then
      case
        when hi.distinct_creators_90d < 3 then null
        when hi.last_creator_activity_at >= now() - interval '30 days' then 'past_month'
        else 'past_quarter'
      end
    -- `older` reveals nothing about recent behaviour, so the confidence gate
    -- (>= 15 pitched cycles) is sufficient on its own.
    else 'older'
  end as recency_band
from public.hotels h
join public.hotel_intelligence hi on hi.hotel_id = h.id;

comment on view public.hotel_public_intelligence is
  'PUBLIC Creator Network Intelligence. Everyone — anonymous, Free, Destination Pass, Pro — sees exactly this. No creator identifiers, no raw outreach counts, no raw timestamps, no reply rate and no reply timing: those are premium (D050). Every behavioural signal additionally requires contributor diversity. Suppression yields NULL, never a fabricated false/zero/low.';

grant select on public.hotel_public_intelligence to anon, authenticated, service_role;

-- ===========================================================================
-- 4. Premium projection — entitlement enforced in the database
--
-- Definer rights so the view can read `hotel_intelligence`, which no browser
-- role may touch; `has_premium_hotel_access()` still resolves per session
-- because it reads `auth.uid()` from the request, not from the view owner.
-- The gate lives in the WHERE clause, so an unentitled caller receives zero
-- rows even if every line of UI code were deleted.
--
-- `anon` is granted nothing at all here. It could never be entitled, so the
-- privilege simply should not exist — the row filter is the second layer, not
-- the only one.
--
-- Publication thresholds are METRIC-SPECIFIC. The reply metrics require both
-- qualifying-cycle volume and contributor diversity; recency, activity and
-- collaboration-type signals rely on their approved distinct-creator population
-- floor, which is the relevant privacy floor for them. No threshold is lower
-- than its public counterpart, and payment moves none of them (D050).
-- ===========================================================================

create or replace view public.hotel_premium_intelligence
with (security_invoker = false) as
select
  h.id as hotel_id,
  h.slug as hotel_slug,
  hi.confidence_level,

  -- Reply rate: >= 15 qualifying pitched cycles AND >= 5 distinct creators,
  -- trailing 365 days. Below either, NULL — never 0%, which would assert that
  -- this hotel ignores creators.
  case
    when hi.pitched_cycles_365d >= 15 and hi.distinct_pitch_creators_365d >= 5
      then hi.reply_rate_365d
    else null
  end as reply_rate,

  -- Typical reply time: >= 10 qualifying replied cycles AND >= 5 distinct
  -- creators who received one. Published as a BAND; the median hours behind it
  -- stay server-side, because "83.6 hours" invites false precision and, at low
  -- N, can identify a single exchange.
  case
    when hi.replied_cycles_365d >= 10
     and hi.distinct_reply_creators_365d >= 5
     and hi.median_reply_hours_365d is not null
      then case
        when hi.median_reply_hours_365d < 24 then 'under_24h'
        when hi.median_reply_hours_365d < 72 then '1_3_days'
        when hi.median_reply_hours_365d < 168 then '3_7_days'
        when hi.median_reply_hours_365d < 336 then '1_2_weeks'
        else '2_plus_weeks'
      end
    else null
  end as reply_time_band,

  -- Recent activity: the tightest band that at least 3 DISTINCT creators
  -- support. Never the raw last-activity timestamp — "someone contacted this
  -- hotel yesterday" is one creator's private movement.
  case
    when hi.distinct_creators_7d >= 3 then 'within_7_days'
    when hi.distinct_creators_30d >= 3 then 'within_30_days'
    when hi.distinct_creators_90d >= 3 then 'within_90_days'
    else null
  end as recent_activity_band,

  -- Collaboration types OBSERVED in creator outcomes, each supported by >= 3
  -- distinct creators. One creator's repeated collaborations cannot manufacture
  -- population diversity, so a single paid stay never becomes "this hotel pays".
  (
    select array_agg(e.key order by e.key)
      from jsonb_each_text(hi.collaboration_type_creators_365d) as e(key, value)
     where value ~ '^[0-9]+$' and value::integer >= 3
  ) as collaboration_types,

  -- Sample context: how many independent creators stand behind the row. Shown
  -- only once the disclosure itself clears the contributor floor, so the number
  -- can never be small enough to point at anyone.
  case
    when hi.distinct_creators_365d >= 5 then hi.distinct_creators_365d
    else null
  end as contributor_count

from public.hotels h
join public.hotel_intelligence hi on hi.hotel_id = h.id
where public.has_premium_hotel_access(h.id);

comment on view public.hotel_premium_intelligence is
  'PREMIUM Creator Network Intelligence. Entitlement is enforced here, in the database, via has_premium_hotel_access() — Destination Pass inside its destination hierarchy, Pro worldwide, admin/editor per PERMISSIONS.md §11. Exposes no creator identity, no raw outreach counts (pitches, replies, events, cycle denominators) and no raw timestamps. It DOES expose one deliberate count: the distinct-creator sample, and only above its own >= 5 floor. Thresholds are metric-specific and payment lowers none of them (D050, D058).';

revoke all on public.hotel_premium_intelligence from public, anon;
grant select on public.hotel_premium_intelligence to authenticated, service_role;
