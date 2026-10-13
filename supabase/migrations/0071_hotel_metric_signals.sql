-- ===========================================================================
-- 0071 — H01 per-metric hotel signals (D120)
-- ===========================================================================
-- Transparent metrics from creator-confirmed network facts only.
-- hotel_intelligence, recompute_hotel_intelligence, hotel_public_intelligence,
-- and hotel_premium_intelligence are not read and not rewritten.
-- A payment, an entitlement, a purchase, and a sponsored flag are not inputs.
-- There is no composite score and no numeric reply time.
-- ===========================================================================

create or replace function private.metric_hotel_is_published(
  p_destination_id uuid,
  p_star_rating numeric,
  p_latitude numeric,
  p_longitude numeric,
  p_active_status text,
  p_star_rating_source text,
  p_star_rating_confidence text
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select
    p_destination_id is not null
    and p_star_rating in (4, 5)
    and p_latitude >= -90 and p_latitude <= 90
    and p_longitude >= -180 and p_longitude <= 180
    and p_active_status in ('active', 'temporarily_closed', 'unknown')
    and (
      (p_star_rating_source is null and p_star_rating_confidence is null)
      or (p_star_rating_source = 'owner' and p_star_rating_confidence = 'confirmed')
      or (p_star_rating_source = 'hotelbeds' and p_star_rating_confidence = 'provisional')
    );
$$;

comment on function private.metric_hotel_is_published(uuid, numeric, numeric, numeric, text, text, text) is
  'Same publishable-hotel predicate as the app read path (D062, D106). Not a ranking input by itself. Invoker. search_path is pinned empty.';

revoke all on function private.metric_hotel_is_published(uuid, numeric, numeric, numeric, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function private.metric_hotel_is_published(uuid, numeric, numeric, numeric, text, text, text)
  to current_user;

-- ---------------------------------------------------------------------------
-- One row per hotel per metric, including hotels that stay below the floor.
-- Counts used to decide the floor are not columns. Contributor N appears only
-- inside the D058 sentence, and only once that metric is available.
-- ---------------------------------------------------------------------------
create view private.hotel_metric_basis
with (security_barrier = true, security_invoker = false) as
with eligible as (
  select
    f.canonical_hotel_id as hotel_id,
    f.owner_user_id,
    f.pipeline_item_id,
    f.fact_type,
    f.event_at,
    f.counts_as_sample,
    f.value
  from private.intelligence_facts f
  where f.network_eligible
    and f.provenance_class = 'creator_confirmed'
    and f.dismissed = false
    and f.source_family in ('manual', 'gmail')
    and f.canonical_hotel_id is not null
    and f.canonical_organization_id is null
),
samples as (
  select
    e.hotel_id,
    count(*) filter (where e.counts_as_sample)::integer as sample_size,
    count(distinct e.owner_user_id) filter (where e.counts_as_sample)::integer as sample_creators
  from eligible e
  group by e.hotel_id
),
pitched as (
  select
    e.hotel_id,
    e.owner_user_id,
    e.pipeline_item_id as cycle_id,
    min(e.event_at) as initial_pitch_at
  from eligible e
  where e.fact_type = 'pitch_sent'
    and e.pipeline_item_id is not null
    and e.event_at is not null
  group by e.hotel_id, e.owner_user_id, e.pipeline_item_id
  having min(e.event_at) >= now() - interval '365 days'
),
reply_events as (
  select
    p.hotel_id,
    p.owner_user_id,
    p.cycle_id,
    p.initial_pitch_at,
    min(r.event_at) as first_reply_at
  from pitched p
  join eligible r
    on r.hotel_id = p.hotel_id
   and r.owner_user_id = p.owner_user_id
   and r.pipeline_item_id = p.cycle_id
   and r.fact_type in ('reply_received', 'gmail_human_reply_observed')
   and r.event_at is not null
   and r.event_at >= p.initial_pitch_at
  group by p.hotel_id, p.owner_user_id, p.cycle_id, p.initial_pitch_at
),
gmail_latency as (
  select distinct on (e.hotel_id, e.owner_user_id, e.pipeline_item_id)
    e.hotel_id,
    e.owner_user_id,
    e.pipeline_item_id as cycle_id,
    (e.value->>'first_send_to_human_reply_ms')::numeric / 3600000.0 as hours
  from eligible e
  where e.fact_type = 'gmail_reply_latency'
    and e.pipeline_item_id is not null
    and e.event_at is not null
    and e.event_at >= now() - interval '365 days'
    and (e.value->>'first_send_to_human_reply_ms') ~ '^[0-9]+$'
    and not exists (
      select 1
        from eligible old_pitch
       where old_pitch.fact_type = 'pitch_sent'
         and old_pitch.owner_user_id = e.owner_user_id
         and old_pitch.pipeline_item_id = e.pipeline_item_id
         and old_pitch.event_at is not null
         and old_pitch.event_at < now() - interval '365 days'
    )
  order by e.hotel_id, e.owner_user_id, e.pipeline_item_id, e.event_at
),
time_obs as (
  select
    r.hotel_id,
    r.owner_user_id,
    r.cycle_id,
    extract(epoch from (r.first_reply_at - r.initial_pitch_at)) / 3600.0 as hours
  from reply_events r
  where r.first_reply_at >= r.initial_pitch_at
  union all
  select g.hotel_id, g.owner_user_id, g.cycle_id, g.hours
  from gmail_latency g
  where g.hours >= 0
    and not exists (
      select 1
        from reply_events r
       where r.hotel_id = g.hotel_id
         and r.owner_user_id = g.owner_user_id
         and r.cycle_id = g.cycle_id
    )
),
rate as (
  select
    p.hotel_id,
    count(*)::integer as pitched_cycles,
    count(distinct p.owner_user_id)::integer as pitch_creators,
    count(r.cycle_id)::integer as replied_cycles
  from pitched p
  left join reply_events r
    on r.hotel_id = p.hotel_id
   and r.owner_user_id = p.owner_user_id
   and r.cycle_id = p.cycle_id
  group by p.hotel_id
),
times as (
  select
    t.hotel_id,
    count(*)::integer as observations,
    count(distinct t.owner_user_id)::integer as reply_creators,
    percentile_cont(0.5) within group (order by t.hours) as median_hours
  from time_obs t
  group by t.hotel_id
),
touched as (
  select hotel_id from samples
  union
  select hotel_id from rate
  union
  select hotel_id from times
)
select
  touched.hotel_id,
  'response_rate'::text as metric,
  'premium'::text as layer,
  'Most responsive'::text as title,
  case
    when coalesce(rate.pitched_cycles, 0) >= 15
     and coalesce(rate.pitch_creators, 0) >= 5
      then 'available'
    else 'not_enough_data'
  end as availability,
  case
    when coalesce(rate.pitched_cycles, 0) >= 15
     and coalesce(rate.pitch_creators, 0) >= 5
      then round((100.0 * rate.replied_cycles::numeric) / rate.pitched_cycles)::integer::text || '%'
    else null
  end as value_label,
  case
    when coalesce(rate.pitched_cycles, 0) >= 15
     and coalesce(rate.pitch_creators, 0) >= 5
      then round((100.0 * rate.replied_cycles::numeric) / rate.pitched_cycles)::integer
    else null
  end as rank_key,
  case
    when coalesce(rate.pitched_cycles, 0) >= 15
     and coalesce(rate.pitch_creators, 0) >= 5
      then 'Based on activity from ' || rate.pitch_creators::text || ' creators'
    else null
  end as sample_basis,
  'Shown when at least 15 confirmed pitches from at least 5 creators in the last 365 days. A follow-up is not another pitch. Below that, not enough data.'::text
    as threshold_rule
from touched
left join rate on rate.hotel_id = touched.hotel_id
union all
select
  touched.hotel_id,
  'response_time'::text,
  'premium'::text,
  'Fastest replying'::text,
  case
    when coalesce(times.observations, 0) >= 10
     and coalesce(times.reply_creators, 0) >= 5
     and times.median_hours is not null
      then 'available'
    else 'not_enough_data'
  end,
  case
    when coalesce(times.observations, 0) >= 10
     and coalesce(times.reply_creators, 0) >= 5
     and times.median_hours is not null
      then case
        when times.median_hours < 24 then 'Under 24h'
        when times.median_hours < 72 then '1–3 days'
        when times.median_hours < 168 then '3–7 days'
        when times.median_hours < 336 then '1–2 weeks'
        else '2+ weeks'
      end
    else null
  end,
  case
    when coalesce(times.observations, 0) >= 10
     and coalesce(times.reply_creators, 0) >= 5
     and times.median_hours is not null
      then case
        when times.median_hours < 24 then 5
        when times.median_hours < 72 then 4
        when times.median_hours < 168 then 3
        when times.median_hours < 336 then 2
        else 1
      end
    else null
  end,
  case
    when coalesce(times.observations, 0) >= 10
     and coalesce(times.reply_creators, 0) >= 5
     and times.median_hours is not null
      then 'Based on activity from ' || times.reply_creators::text || ' creators'
    else null
  end,
  'Shown when at least 10 confirmed replies from at least 5 creators in the last 365 days. The value is a time band, not an hour count. Below that, not enough data.'::text
from touched
left join times on times.hotel_id = touched.hotel_id
union all
select
  touched.hotel_id,
  'creator_activity'::text,
  'public'::text,
  'Most active with creators'::text,
  case
    when coalesce(samples.sample_creators, 0) >= 3
     and coalesce(samples.sample_size, 0) >= 5
      then 'available'
    else 'not_enough_data'
  end,
  case
    when coalesce(samples.sample_creators, 0) >= 3 and samples.sample_size >= 50 then 'High'
    when coalesce(samples.sample_creators, 0) >= 3 and samples.sample_size >= 15 then 'Medium'
    when coalesce(samples.sample_creators, 0) >= 3 and samples.sample_size >= 5 then 'Emerging'
    else null
  end,
  case
    when coalesce(samples.sample_creators, 0) >= 3 and samples.sample_size >= 50 then 3
    when coalesce(samples.sample_creators, 0) >= 3 and samples.sample_size >= 15 then 2
    when coalesce(samples.sample_creators, 0) >= 3 and samples.sample_size >= 5 then 1
    else null
  end,
  case
    when coalesce(samples.sample_creators, 0) >= 5
     and coalesce(samples.sample_size, 0) >= 5
      then 'Based on activity from ' || samples.sample_creators::text || ' creators'
    else null
  end,
  'Shown when at least 3 creators have confirmed activity and the sample reaches emerging (5 or more confirmed events). Below that, not enough data.'::text
from touched
left join samples on samples.hotel_id = touched.hotel_id;

comment on view private.hotel_metric_basis is
  'H01 metric math (D120). Confirmed network facts only. Reply rate is a whole percent of pitched cycles. Reply time is a D058 band. Activity is the D099/D012 label. Below a floor the value is null. No creator id, no raw count, no hour count, no payment column.';

revoke all on table private.hotel_metric_basis from public, anon, authenticated, service_role;

create view public.hotel_metric_signal_public
with (security_barrier = true, security_invoker = false) as
select
  b.hotel_id,
  h.destination_id,
  b.metric,
  b.title,
  b.layer,
  b.value_label,
  b.rank_key,
  b.sample_basis,
  b.threshold_rule
from private.hotel_metric_basis b
join public.hotels h on h.id = b.hotel_id
where b.metric = 'creator_activity'
  and b.availability = 'available'
  and h.destination_id is not null
  and h.star_rating in (4, 5)
  and h.latitude >= -90 and h.latitude <= 90
  and h.longitude >= -180 and h.longitude <= 180
  and h.active_status in ('active', 'temporarily_closed', 'unknown')
  and (
    (h.star_rating_source is null and h.star_rating_confidence is null)
    or (h.star_rating_source = 'owner' and h.star_rating_confidence = 'confirmed')
    or (h.star_rating_source = 'hotelbeds' and h.star_rating_confidence = 'provisional')
  );

comment on view public.hotel_metric_signal_public is
  'Published hotels whose confirmed-activity metric cleared D012 and the 3-creator floor. F03 may order by rank_key desc, hotel_id. One metric. No other metric belongs in that ORDER BY. Hotels below the floor are absent, not last.';

revoke all on table public.hotel_metric_signal_public from public, anon, authenticated, service_role;
grant select on table public.hotel_metric_signal_public to anon, authenticated, service_role;

create view public.hotel_metric_signal_premium
with (security_barrier = true, security_invoker = false) as
select
  b.hotel_id,
  h.destination_id,
  b.metric,
  b.title,
  b.layer,
  b.value_label,
  b.rank_key,
  b.sample_basis,
  b.threshold_rule
from private.hotel_metric_basis b
join public.hotels h on h.id = b.hotel_id
where b.layer = 'premium'
  and b.availability = 'available'
  and h.destination_id is not null
  and h.star_rating in (4, 5)
  and h.latitude >= -90 and h.latitude <= 90
  and h.longitude >= -180 and h.longitude <= 180
  and h.active_status in ('active', 'temporarily_closed', 'unknown')
  and (
    (h.star_rating_source is null and h.star_rating_confidence is null)
    or (h.star_rating_source = 'owner' and h.star_rating_confidence = 'confirmed')
    or (h.star_rating_source = 'hotelbeds' and h.star_rating_confidence = 'provisional')
  )
  and public.has_premium_hotel_access(h.id);

comment on view public.hotel_metric_signal_premium is
  'Reply rate and reply-time band for a published hotel, one row per metric, only after that metric''s D058 floor. Entitlement is has_premium_hotel_access. Anon has no privilege. Payment does not change rank_key. F03 orders one metric at a time by rank_key desc, hotel_id.';

revoke all on table public.hotel_metric_signal_premium from public, anon, authenticated, service_role;
grant select on table public.hotel_metric_signal_premium to authenticated, service_role;
