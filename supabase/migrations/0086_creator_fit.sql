-- ===========================================================================
-- 0086 — C04 creator fit (D148)
-- ===========================================================================
-- A hotel fits the caller when the caller has confirmed a collaboration type
-- and at least three creators other than the caller have confirmed that same
-- type on that hotel. The caller's own confirmation does not fill the floor.
-- The order is the public H01 activity rank key, then
-- hotel id. Hotels below the activity floor are absent. The hierarchical
-- prior is not applied. Max advanced_signals adds rank, confidence, and
-- freshness. It does not change the order, and it does not change Discover
-- or Pipeline.
-- ===========================================================================

create view private.hotel_confirmed_types
with (security_barrier = true, security_invoker = false) as
select
  f.canonical_hotel_id as hotel_id,
  f.value->>'collaboration_type' as collaboration_type
from private.intelligence_facts f
where f.network_eligible
  and f.provenance_class = 'creator_confirmed'
  and f.dismissed = false
  and f.source_family in ('manual', 'gmail')
  and f.canonical_hotel_id is not null
  and f.canonical_organization_id is null
  and f.fact_type = 'collaboration_type_observed'
  and f.value->>'collaboration_type' in ('stay', 'product', 'paid', 'stay_plus_paid', 'other')
group by f.canonical_hotel_id, f.value->>'collaboration_type'
having count(distinct f.owner_user_id) filter (
  where f.owner_user_id is distinct from auth.uid()
) >= 3;

comment on view private.hotel_confirmed_types is
  'Collaboration types confirmed by at least three creators other than auth.uid(). The caller does not count toward that floor. No count column and no creator id.';

revoke all on table private.hotel_confirmed_types from public, anon, authenticated, service_role;

create or replace function public.read_creator_fit(p_destination_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_entitled boolean;
  v_detailed boolean;
  v_hotels jsonb;
begin
  if v_user is null then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;
  if p_destination_id is null or not exists (
    select 1 from public.destinations d where d.id = p_destination_id
  ) then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  v_entitled := public._is_admin_or_editor(v_user)
    or public._has_active_pro(v_user)
    or public._has_active_destination_access(v_user, p_destination_id);
  v_detailed := public._has_active_max(v_user);

  if not v_entitled then
    return pg_catalog.jsonb_build_object(
      'result', 'locked',
      'detailed', false
    );
  end if;

  select coalesce(pg_catalog.jsonb_agg(
           pg_catalog.jsonb_build_object(
             'hotel_id', ranked.hotel_id,
             'activity_label', ranked.activity_label,
             'matched_type', ranked.matched_type
           ) || case
             when v_detailed then pg_catalog.jsonb_build_object(
               'rank', ranked.rank,
               'confidence_level', ranked.confidence_level,
               'freshness_band', ranked.freshness_band
             )
             else '{}'::jsonb
           end
           order by ranked.rank
         ), '[]'::jsonb)
    into v_hotels
    from (
      select
        picked.hotel_id,
        picked.activity_label,
        picked.matched_type,
        picked.confidence_level,
        picked.freshness_band,
        pg_catalog.row_number() over (order by picked.rank_key desc, picked.hotel_id asc) as rank
      from (
        select distinct on (b.hotel_id)
          b.hotel_id,
          b.value_label as activity_label,
          b.rank_key,
          t.collaboration_type as matched_type,
          f.confidence_level,
          f.freshness_band
        from private.hotel_metric_basis b
        join public.hotels h on h.id = b.hotel_id
        join private.hotel_confirmed_types t on t.hotel_id = b.hotel_id
        join lateral (
          select count(distinct others.owner_user_id)::integer as other_creators
            from private.intelligence_facts others
           where others.network_eligible
             and others.provenance_class = 'creator_confirmed'
             and others.dismissed = false
             and others.source_family in ('manual', 'gmail')
             and others.canonical_hotel_id = b.hotel_id
             and others.canonical_organization_id is null
             and others.fact_type = 'collaboration_type_observed'
             and others.value->>'collaboration_type' = t.collaboration_type
             and others.owner_user_id is distinct from v_user
        ) others on others.other_creators >= 3
        left join private.hotel_metric_freshness f
          on f.hotel_id = b.hotel_id
         and f.metric = 'creator_activity'
        where b.metric = 'creator_activity'
          and b.availability = 'available'
          and b.value_label is not null
          and b.rank_key is not null
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
          and t.collaboration_type in (
            select f2.value->>'collaboration_type'
              from private.intelligence_facts f2
              join public.hotels own on own.id = f2.canonical_hotel_id
             where f2.owner_user_id = v_user
               and f2.fact_type = 'collaboration_type_observed'
               and f2.provenance_class = 'creator_confirmed'
               and f2.dismissed = false
               and f2.source_family in ('manual', 'gmail')
               and f2.network_eligible
               and f2.value->>'collaboration_type' in
                 ('stay', 'product', 'paid', 'stay_plus_paid', 'other')
               and (
                 own.destination_id = p_destination_id
                 or public._destination_is_descendant(own.destination_id, p_destination_id)
                 or public._destination_is_descendant(p_destination_id, own.destination_id)
               )
          )
        order by b.hotel_id, t.collaboration_type
      ) picked
    ) ranked;

  return pg_catalog.jsonb_build_object(
    'result', 'ok',
    'detailed', v_detailed,
    'prior_applied', false,
    'prior_reason', 'no_proven_lift',
    'hotels', v_hotels
  );
end;
$$;

comment on function public.read_creator_fit(uuid) is
  'D148 creator fit for auth.uid() inside one destination and its descendants. A matched type needs three creators other than the caller. Locked calls omit hotels. Order is activity rank_key desc, hotel id. Max adds rank, confidence, and freshness without changing that order. Prior is not applied. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.read_creator_fit(uuid) from public, anon, authenticated;
grant execute on function public.read_creator_fit(uuid) to authenticated, service_role;
