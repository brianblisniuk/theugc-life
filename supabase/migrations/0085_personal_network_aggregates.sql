-- ===========================================================================
-- 0085 — C03 personal and network aggregates (D147)
-- ===========================================================================
-- Personal numbers are the caller's own confirmed facts. Network numbers are
-- the k-anonymous projections that already exist: network_hotel_public (3
-- distinct creators) and hotel_metric_signal_premium (the H01 floors).
-- This migration does not recompute those projections and does not add a
-- count column. Below the floor the result is insufficient, with no other
-- keys. A missing row is not zero.
-- ===========================================================================

create or replace function public.read_own_personal_aggregate(p_hotel_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_manual integer;
  v_gmail integer;
  v_last timestamptz;
  v_types jsonb;
begin
  if v_user is null or p_hotel_id is null then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;
  if not exists (select 1 from public.hotels h where h.id = p_hotel_id) then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  select
    count(*) filter (where f.source_family = 'manual')::integer,
    count(*) filter (where f.source_family = 'gmail')::integer,
    max(f.event_at)
    into v_manual, v_gmail, v_last
    from private.intelligence_facts f
   where f.owner_user_id = v_user
     and f.canonical_hotel_id = p_hotel_id
     and f.provenance_class = 'creator_confirmed'
     and f.dismissed = false
     and f.network_eligible
     and f.counts_as_sample
     and f.source_family in ('manual', 'gmail');

  select coalesce(pg_catalog.jsonb_agg(distinct t.collaboration_type order by t.collaboration_type), '[]'::jsonb)
    into v_types
    from (
      select f.value->>'collaboration_type' as collaboration_type
        from private.intelligence_facts f
       where f.owner_user_id = v_user
         and f.canonical_hotel_id = p_hotel_id
         and f.fact_type = 'collaboration_type_observed'
         and f.provenance_class = 'creator_confirmed'
         and f.dismissed = false
         and f.source_family in ('manual', 'gmail')
         and f.value->>'collaboration_type' in ('stay', 'product', 'paid', 'stay_plus_paid', 'other')
    ) t;

  return pg_catalog.jsonb_build_object(
    'result', 'ok',
    'manual_events', coalesce(v_manual, 0),
    'gmail_events', coalesce(v_gmail, 0),
    'last_event_at', v_last,
    'collaboration_types', v_types
  );
end;
$$;

comment on function public.read_own_personal_aggregate(uuid) is
  'The caller''s own confirmed sample counts for one hotel, split into manual and Gmail, plus the caller''s own collaboration types. Zero is an empty personal history. No evidence id and no other creator. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.read_own_personal_aggregate(uuid) from public, anon, authenticated;
grant execute on function public.read_own_personal_aggregate(uuid) to authenticated, service_role;

create or replace function public.read_network_aggregate(p_hotel_id uuid)
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
  v_star_confidence text;
  v_row public.network_hotel_public%rowtype;
  v_body jsonb;
  v_rate text;
  v_time text;
begin
  if p_hotel_id is null then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  select
    h.destination_id, h.star_rating, h.latitude, h.longitude,
    h.active_status, h.star_rating_source, h.star_rating_confidence
    into v_destination, v_star, v_lat, v_lng, v_status, v_source, v_star_confidence
    from public.hotels h
   where h.id = p_hotel_id;

  if not found or not private.metric_hotel_is_published(
    v_destination, v_star, v_lat, v_lng, v_status, v_source, v_star_confidence
  ) then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  select n.*
    into v_row
    from public.network_hotel_public n
   where n.hotel_id = p_hotel_id;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'insufficient');
  end if;

  v_body := pg_catalog.jsonb_build_object(
    'result', 'ok',
    'confidence_level', v_row.confidence_level,
    'activity_level', v_row.activity_level,
    'recency_band', v_row.recency_band,
    'freshness_band', v_row.freshness_band,
    'has_observed_collaboration', v_row.has_observed_collaboration
  );

  if public.has_premium_hotel_access(p_hotel_id) then
    select p.value_label
      into v_rate
      from public.hotel_metric_signal_premium p
     where p.hotel_id = p_hotel_id
       and p.metric = 'response_rate';
    select p.value_label
      into v_time
      from public.hotel_metric_signal_premium p
     where p.hotel_id = p_hotel_id
       and p.metric = 'response_time';
    v_body := v_body || pg_catalog.jsonb_build_object(
      'response_rate', v_rate,
      'response_time', v_time
    );
  end if;

  return v_body;
end;
$$;

comment on function public.read_network_aggregate(uuid) is
  'D147 k-anonymous hotel aggregate. Below three distinct creators the result is insufficient and has no other keys. Reply labels are copied from the premium H01 view and only when has_premium_hotel_access is true. No creator id, evidence id, or count. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.read_network_aggregate(uuid) from public, anon, authenticated;
grant execute on function public.read_network_aggregate(uuid) to anon, authenticated, service_role;
