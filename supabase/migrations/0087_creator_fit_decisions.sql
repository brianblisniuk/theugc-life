-- ===========================================================================
-- 0087 — C05 creator-fit decisions (D149)
-- ===========================================================================
-- Pursue and skip are an append-only record for the signed-in creator.
-- They do not update facts, the H01 basis, the network aggregate, or the
-- fit order. A hotel that is not on the caller's fit list is not_visible.
-- The table has no client grant and no policy. RLS is enabled.
-- ===========================================================================

create table private.creator_fit_decisions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  creator_user_id uuid not null references public.users(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  decision text not null check (decision in ('pursue', 'skip')),
  created_at timestamptz not null default pg_catalog.now()
);

comment on table private.creator_fit_decisions is
  'C05 decision instrument. Pursue or skip does not change a network aggregate, a metric, or the fit order.';

create index creator_fit_decisions_owner_idx
  on private.creator_fit_decisions (creator_user_id, hotel_id, created_at desc, id desc);

alter table private.creator_fit_decisions enable row level security;

revoke all on table private.creator_fit_decisions from public, anon, authenticated, service_role;

create or replace function public.record_creator_fit_decision(
  p_hotel_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_destination uuid;
  v_fit jsonb;
begin
  if v_user is null or p_hotel_id is null then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;
  if p_decision is distinct from 'pursue' and p_decision is distinct from 'skip' then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  select h.destination_id
    into v_destination
    from public.hotels h
   where h.id = p_hotel_id;
  if v_destination is null then
    return pg_catalog.jsonb_build_object('result', 'not_visible');
  end if;

  v_fit := public.read_creator_fit(v_destination);
  if v_fit->>'result' is distinct from 'ok' or not exists (
    select 1
      from pg_catalog.jsonb_array_elements(coalesce(v_fit->'hotels', '[]'::jsonb)) as item
     where item->>'hotel_id' = p_hotel_id::text
  ) then
    return pg_catalog.jsonb_build_object('result', 'not_visible');
  end if;

  insert into private.creator_fit_decisions (creator_user_id, hotel_id, decision)
  values (v_user, p_hotel_id, p_decision);

  return pg_catalog.jsonb_build_object('result', 'ok', 'decision', p_decision);
end;
$$;

comment on function public.record_creator_fit_decision(uuid, text) is
  'Appends pursue or skip for auth.uid() when that hotel is on the caller''s fit list. Does not change aggregates or order. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.record_creator_fit_decision(uuid, text) from public, anon, authenticated;
grant execute on function public.record_creator_fit_decision(uuid, text) to authenticated, service_role;

create or replace function public.read_own_fit_decision(p_hotel_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_decision text;
begin
  if v_user is null or p_hotel_id is null then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;
  if not exists (select 1 from public.hotels h where h.id = p_hotel_id) then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  select d.decision
    into v_decision
    from private.creator_fit_decisions d
   where d.creator_user_id = v_user
     and d.hotel_id = p_hotel_id
   order by d.created_at desc, d.id desc
   limit 1;

  return pg_catalog.jsonb_build_object(
    'result', 'ok',
    'decision', v_decision
  );
end;
$$;

comment on function public.read_own_fit_decision(uuid) is
  'The caller''s latest pursue or skip for one hotel, or null when they have not chosen. No other creator. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.read_own_fit_decision(uuid) from public, anon, authenticated;
grant execute on function public.read_own_fit_decision(uuid) to authenticated, service_role;
