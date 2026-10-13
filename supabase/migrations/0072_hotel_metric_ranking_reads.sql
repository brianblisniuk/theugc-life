-- ===========================================================================
-- 0072 — H01 metric reads (D120)
-- ===========================================================================
-- Identity is auth.uid(). A client-supplied user id is not accepted.
-- A failed caller still gets a result code. An empty hotel array is a real
-- ranking whose hotels are all below the floor, and only on result = ok.
-- Locked omits the hotels key.
-- ===========================================================================

create or replace function public.read_hotel_metric_signals(p_hotel_id uuid)
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
  v_title text;
  v_rule text;
  v_availability text;
  v_value text;
  v_sample text;
begin
  if p_hotel_id is null then
    return jsonb_build_object('result', 'not_found');
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
    return jsonb_build_object('result', 'not_found');
  end if;

  v_entitled := public.has_premium_hotel_access(p_hotel_id);

  for v_metric, v_layer, v_title, v_rule in
    select *
      from (values
        (
          'response_rate'::text,
          'premium'::text,
          'Most responsive'::text,
          'Shown when at least 15 confirmed pitches from at least 5 creators in the last 365 days. A follow-up is not another pitch. Below that, not enough data.'::text
        ),
        (
          'response_time'::text,
          'premium'::text,
          'Fastest replying'::text,
          'Shown when at least 10 confirmed replies from at least 5 creators in the last 365 days. The value is a time band, not an hour count. Below that, not enough data.'::text
        ),
        (
          'creator_activity'::text,
          'public'::text,
          'Most active with creators'::text,
          'Shown when at least 3 creators have confirmed activity and the sample reaches emerging (5 or more confirmed events). Below that, not enough data.'::text
        )
      ) as spec(metric, layer, title, rule)
  loop
    if v_layer = 'premium' and not v_entitled then
      v_metrics := v_metrics || jsonb_build_array(jsonb_build_object(
        'metric', v_metric,
        'title', v_title,
        'layer', v_layer,
        'state', 'locked',
        'value_label', null,
        'sample_basis', null,
        'threshold_rule', v_rule
      ));
    else
      v_availability := null;
      v_value := null;
      v_sample := null;
      select b.availability, b.value_label, b.sample_basis
        into v_availability, v_value, v_sample
        from private.hotel_metric_basis b
       where b.hotel_id = p_hotel_id
         and b.metric = v_metric;
      if v_availability is distinct from 'available' or v_value is null then
        v_metrics := v_metrics || jsonb_build_array(jsonb_build_object(
          'metric', v_metric,
          'title', v_title,
          'layer', v_layer,
          'state', 'not_enough_data',
          'value_label', null,
          'sample_basis', null,
          'threshold_rule', v_rule
        ));
      else
        v_metrics := v_metrics || jsonb_build_array(jsonb_build_object(
          'metric', v_metric,
          'title', v_title,
          'layer', v_layer,
          'state', 'available',
          'value_label', v_value,
          'sample_basis', v_sample,
          'threshold_rule', v_rule
        ));
      end if;
    end if;
  end loop;

  return jsonb_build_object('result', 'ok', 'metrics', v_metrics);
end;
$$;

comment on function public.read_hotel_metric_signals(uuid) is
  'Per-metric signals for one published hotel. Premium metrics lock without a value when has_premium_hotel_access is false. Below a floor the state is not_enough_data and the value is null, never zero. SECURITY DEFINER. search_path is pinned empty. auth.uid() is the only identity.';

revoke all on function public.read_hotel_metric_signals(uuid) from public, anon, authenticated;
grant execute on function public.read_hotel_metric_signals(uuid) to anon, authenticated, service_role;

create or replace function public.read_destination_metric_ranking(
  p_destination_id uuid,
  p_metric text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_layer text;
  v_title text;
  v_rule text;
  v_entitled boolean;
  v_hotels jsonb;
begin
  if p_metric = 'response_rate' then
    v_layer := 'premium';
    v_title := 'Most responsive';
    v_rule := 'Shown when at least 15 confirmed pitches from at least 5 creators in the last 365 days. A follow-up is not another pitch. Below that, not enough data.';
  elsif p_metric = 'response_time' then
    v_layer := 'premium';
    v_title := 'Fastest replying';
    v_rule := 'Shown when at least 10 confirmed replies from at least 5 creators in the last 365 days. The value is a time band, not an hour count. Below that, not enough data.';
  elsif p_metric = 'creator_activity' then
    v_layer := 'public';
    v_title := 'Most active with creators';
    v_rule := 'Shown when at least 3 creators have confirmed activity and the sample reaches emerging (5 or more confirmed events). Below that, not enough data.';
  else
    return jsonb_build_object('result', 'invalid_input');
  end if;

  if p_destination_id is null or not exists (
    select 1 from public.destinations d where d.id = p_destination_id
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_layer = 'premium' then
    v_entitled := v_user is not null and (
      public._is_admin_or_editor(v_user)
      or public._has_active_pro(v_user)
      or public._has_active_destination_access(v_user, p_destination_id)
    );
    if not v_entitled then
      return jsonb_build_object(
        'result', 'locked',
        'metric', p_metric,
        'title', v_title,
        'layer', v_layer,
        'scope', 'destination_and_descendants',
        'threshold_rule', v_rule
      );
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'hotel_id', ranked.hotel_id,
           'rank', ranked.rank,
           'value_label', ranked.value_label,
           'sample_basis', ranked.sample_basis
         ) order by ranked.rank), '[]'::jsonb)
    into v_hotels
    from (
      select
        b.hotel_id,
        b.value_label,
        b.sample_basis,
        row_number() over (order by b.rank_key desc, h.id asc) as rank
      from private.hotel_metric_basis b
      join public.hotels h on h.id = b.hotel_id
      where b.metric = p_metric
        and b.availability = 'available'
        and b.value_label is not null
        and (
          h.destination_id = p_destination_id
          or public._destination_is_descendant(h.destination_id, p_destination_id)
        )
        and private.metric_hotel_is_published(
          h.destination_id,
          h.star_rating,
          h.latitude,
          h.longitude,
          h.active_status,
          h.star_rating_source,
          h.star_rating_confidence
        )
    ) ranked;

  return jsonb_build_object(
    'result', 'ok',
    'metric', p_metric,
    'title', v_title,
    'layer', v_layer,
    'scope', 'destination_and_descendants',
    'threshold_rule', v_rule,
    'hotels', v_hotels
  );
end;
$$;

comment on function public.read_destination_metric_ranking(uuid, text) is
  'One metric, ordered inside a destination and its descendants. Tie-break is hotel id, never another metric and never a timestamp. Premium metrics lock with no hotels key. Hotels below the floor are omitted. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.read_destination_metric_ranking(uuid, text) from public, anon, authenticated;
grant execute on function public.read_destination_metric_ranking(uuid, text) to anon, authenticated, service_role;
