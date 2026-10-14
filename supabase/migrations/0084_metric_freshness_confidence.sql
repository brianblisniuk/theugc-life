-- ===========================================================================
-- 0084 — C02 metric freshness and confidence (D146)
-- ===========================================================================
-- Annotates an H01 metric that is already available. It does not recompute
-- the H01 value, rank key, or sample sentence, and it does not edit 0071
-- or 0072. Discover and Pipeline order are untouched.
--
-- Confidence for creator activity is the H01 label (High / Medium /
-- Emerging), mapped to the D012 words. Reply-rate and reply-time confidence
-- use the same cycle and observation definitions as 0071, and only the D012
-- band. Freshness is null unless that confidence is moderate or strong and
-- three distinct creators have a qualifying event inside the window (D099).
-- A missing band is not zero. Counts and creator ids are not columns.
-- 0081–0083 are not this block.
-- ===========================================================================

create view private.hotel_metric_freshness
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
activity_windows as (
  select
    e.hotel_id,
    count(distinct e.owner_user_id) filter (
      where e.counts_as_sample and e.event_at >= pg_catalog.now() - interval '30 days'
    )::integer as creators_30,
    count(distinct e.owner_user_id) filter (
      where e.counts_as_sample and e.event_at >= pg_catalog.now() - interval '90 days'
    )::integer as creators_90,
    count(distinct e.owner_user_id) filter (
      where e.counts_as_sample and e.event_at < pg_catalog.now() - interval '90 days'
    )::integer as creators_older
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
  having min(e.event_at) >= pg_catalog.now() - interval '365 days'
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
    e.event_at,
    (e.value->>'first_send_to_human_reply_ms')::numeric / 3600000.0 as hours
  from eligible e
  where e.fact_type = 'gmail_reply_latency'
    and e.pipeline_item_id is not null
    and e.event_at is not null
    and e.event_at >= pg_catalog.now() - interval '365 days'
    and (e.value->>'first_send_to_human_reply_ms') ~ '^[0-9]+$'
    and not exists (
      select 1
        from eligible old_pitch
       where old_pitch.fact_type = 'pitch_sent'
         and old_pitch.owner_user_id = e.owner_user_id
         and old_pitch.pipeline_item_id = e.pipeline_item_id
         and old_pitch.event_at is not null
         and old_pitch.event_at < pg_catalog.now() - interval '365 days'
    )
  order by e.hotel_id, e.owner_user_id, e.pipeline_item_id, e.event_at
),
time_obs as (
  select r.hotel_id, r.owner_user_id, r.cycle_id, r.first_reply_at as event_at
  from reply_events r
  where r.first_reply_at >= r.initial_pitch_at
  union all
  select g.hotel_id, g.owner_user_id, g.cycle_id, g.event_at
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
rate_windows as (
  select
    p.hotel_id,
    count(*)::integer as pitched_cycles,
    count(distinct p.owner_user_id) filter (
      where p.initial_pitch_at >= pg_catalog.now() - interval '30 days'
    )::integer as creators_30,
    count(distinct p.owner_user_id) filter (
      where p.initial_pitch_at >= pg_catalog.now() - interval '90 days'
    )::integer as creators_90,
    count(distinct p.owner_user_id) filter (
      where p.initial_pitch_at < pg_catalog.now() - interval '90 days'
    )::integer as creators_older
  from pitched p
  group by p.hotel_id
),
time_windows as (
  select
    t.hotel_id,
    count(*)::integer as observations,
    count(distinct t.owner_user_id) filter (
      where t.event_at >= pg_catalog.now() - interval '30 days'
    )::integer as creators_30,
    count(distinct t.owner_user_id) filter (
      where t.event_at >= pg_catalog.now() - interval '90 days'
    )::integer as creators_90,
    count(distinct t.owner_user_id) filter (
      where t.event_at < pg_catalog.now() - interval '90 days'
    )::integer as creators_older
  from time_obs t
  group by t.hotel_id
),
annotated as (
  select
    b.hotel_id,
    b.metric,
    case b.metric
      when 'creator_activity' then case b.value_label
        when 'High' then 'strong'
        when 'Medium' then 'moderate'
        when 'Emerging' then 'emerging'
        else null
      end
      when 'response_rate' then case
        when coalesce(rate_windows.pitched_cycles, 0) >= 50 then 'strong'
        when coalesce(rate_windows.pitched_cycles, 0) >= 15 then 'moderate'
        else null
      end
      when 'response_time' then case
        when coalesce(time_windows.observations, 0) >= 50 then 'strong'
        when coalesce(time_windows.observations, 0) >= 15 then 'moderate'
        when coalesce(time_windows.observations, 0) >= 10 then 'emerging'
        else null
      end
      else null
    end as confidence_level,
    case b.metric
      when 'creator_activity' then activity_windows.creators_30
      when 'response_rate' then rate_windows.creators_30
      when 'response_time' then time_windows.creators_30
      else null
    end as creators_30,
    case b.metric
      when 'creator_activity' then activity_windows.creators_90
      when 'response_rate' then rate_windows.creators_90
      when 'response_time' then time_windows.creators_90
      else null
    end as creators_90,
    case b.metric
      when 'creator_activity' then activity_windows.creators_older
      when 'response_rate' then rate_windows.creators_older
      when 'response_time' then time_windows.creators_older
      else null
    end as creators_older
  from private.hotel_metric_basis b
  left join activity_windows on activity_windows.hotel_id = b.hotel_id
  left join rate_windows on rate_windows.hotel_id = b.hotel_id
  left join time_windows on time_windows.hotel_id = b.hotel_id
  where b.availability = 'available'
)
select
  hotel_id,
  metric,
  confidence_level,
  case
    when confidence_level not in ('moderate', 'strong') then null
    when creators_30 >= 3 then 'past_month'
    when creators_90 >= 3 then 'past_quarter'
    when creators_older >= 3 then 'older'
    else null
  end as freshness_band
from annotated
where confidence_level is not null;

comment on view private.hotel_metric_freshness is
  'D146 annotation for an available H01 metric. Activity confidence is the H01 label. Reply confidence is the D012 band on the H01 cycle or observation count. Freshness is null below moderate, and null unless three distinct creators fall inside that window. No creator id and no count column.';

revoke all on table private.hotel_metric_freshness from public, anon, authenticated, service_role;

create or replace function public.read_hotel_metric_confidence(p_hotel_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_destination uuid;
  v_star numeric;
  v_lat numeric;
  v_lng numeric;
  v_status text;
  v_source text;
  v_confidence text;
  v_entitled boolean;
  v_metrics jsonb := '[]'::jsonb;
  v_metric text;
  v_layer text;
  v_availability text;
  v_level text;
  v_band text;
begin
  if p_hotel_id is null then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  select
    h.destination_id, h.star_rating, h.latitude, h.longitude,
    h.active_status, h.star_rating_source, h.star_rating_confidence
    into v_destination, v_star, v_lat, v_lng, v_status, v_source, v_confidence
    from public.hotels h
   where h.id = p_hotel_id;

  if not found or not private.metric_hotel_is_published(
    v_destination, v_star, v_lat, v_lng, v_status, v_source, v_confidence
  ) then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  v_entitled := public.has_premium_hotel_access(p_hotel_id);

  for v_metric, v_layer in
    select *
      from (values
        ('response_rate'::text, 'premium'::text),
        ('response_time'::text, 'premium'::text),
        ('creator_activity'::text, 'public'::text)
      ) as spec(metric, layer)
  loop
    if v_layer = 'premium' and not v_entitled then
      v_metrics := v_metrics || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'metric', v_metric,
        'state', 'locked',
        'confidence_level', null,
        'freshness_band', null
      ));
    else
      select b.availability
        into v_availability
        from private.hotel_metric_basis b
       where b.hotel_id = p_hotel_id
         and b.metric = v_metric;
      if v_availability is distinct from 'available' then
        v_metrics := v_metrics || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'metric', v_metric,
          'state', 'not_enough_data',
          'confidence_level', null,
          'freshness_band', null
        ));
      else
        v_level := null;
        v_band := null;
        select f.confidence_level, f.freshness_band
          into v_level, v_band
          from private.hotel_metric_freshness f
         where f.hotel_id = p_hotel_id
           and f.metric = v_metric;
        v_metrics := v_metrics || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'metric', v_metric,
          'state', 'available',
          'confidence_level', v_level,
          'freshness_band', v_band
        ));
      end if;
    end if;
  end loop;

  return pg_catalog.jsonb_build_object('result', 'ok', 'metrics', v_metrics);
end;
$$;

comment on function public.read_hotel_metric_confidence(uuid) is
  'D146 confidence and freshness for one published hotel. Premium metrics lock with null bands when has_premium_hotel_access is false. Below an H01 floor the state is not_enough_data and both bands are null. SECURITY DEFINER. search_path is pinned empty. auth.uid() is the only identity.';

revoke all on function public.read_hotel_metric_confidence(uuid) from public, anon, authenticated;
grant execute on function public.read_hotel_metric_confidence(uuid) to anon, authenticated, service_role;
