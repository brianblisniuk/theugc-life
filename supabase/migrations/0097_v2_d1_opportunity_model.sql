-- 0097 — V2-D1 data model (D182–D187).
--
-- Does not edit 0005–0096. Contract Review is not in this migration (D185).
--
-- D182. An open pipeline item is one opportunity. Two open opportunities for
-- the same creator and hotel are allowed when they belong to different trips,
-- or when their stay dates do not overlap. `closed` still ends a cycle (D023).
-- A missing date range is the whole timeline, so it overlaps every other open
-- opportunity in the same trip bucket. The no-trip bucket is its own trip.
-- Checkout is exclusive: [check-in, check-out). Back-to-back stays do not
-- overlap. Existing rows have no dates and at most one open row per pair, so
-- they already satisfy the new rule. Each row receives a per-creator display
-- id OP-1001, OP-1002, … The number is not an authorization key.
--
-- D183. Trip-hotel nights are the creator's check-in and check-out, with
-- night_status pending or confirmed. A Gmail signal inserts a suggestion.
-- It does not write the stored dates. Accept copies the suggested dates and
-- leaves night_status as the creator set it. Reject leaves the dates.
--
-- D184. An outreach initiative may have a trip or not. Linking a trip copies
-- the shortlist once. Hotels added to the trip later stay off the initiative
-- until import_outreach_shortlist.
--
-- D186. collaboration_deliverables.status gains revision_requested.
-- D115's deadline set stays pending and rejected.
--
-- D187. pipeline_stage_label maps the stored statuses onto the V12.1 stage
-- names. follow_up stays a stored status and is an event, not a stage.

-- ---------------------------------------------------------------------------
-- btree_gist so a GiST exclusion constraint can equate uuids.
-- ---------------------------------------------------------------------------
do $ext$
begin
  if exists (select 1 from pg_catalog.pg_extension where extname = 'btree_gist') then
    return;
  end if;
  if exists (select 1 from pg_catalog.pg_namespace where nspname = 'extensions') then
    execute 'create extension btree_gist with schema extensions';
  else
    execute 'create extension btree_gist';
  end if;
end
$ext$;

-- ---------------------------------------------------------------------------
-- Opportunity dates and the per-creator display id.
-- ---------------------------------------------------------------------------
alter table public.pipeline_items
  add column stay_start date,
  add column stay_end date,
  add column display_ref text,
  add column outreach_initiative_id uuid;

alter table public.pipeline_items
  add constraint pipeline_items_stay_dates_pair check (
    (stay_start is null and stay_end is null)
    or (
      stay_start is not null
      and stay_end is not null
      and stay_end > stay_start
    )
  );

comment on column public.pipeline_items.stay_start is
  'D182. Inclusive check-in of this opportunity. Null with stay_end means the open row occupies the whole trip bucket.';

comment on column public.pipeline_items.stay_end is
  'D182. Exclusive check-out. Nights are [stay_start, stay_end).';

comment on column public.pipeline_items.display_ref is
  'D182. Per-creator display id, OP-1001 and up. Not an authorization key. Unique for that creator. Assigned on insert and then frozen.';

with numbered as (
  select pi.id,
         1000 + pg_catalog.row_number() over (
           partition by pi.creator_id
           order by pi.created_at, pi.id
         ) as n
    from public.pipeline_items pi
)
update public.pipeline_items pi
   set display_ref = 'OP-' || numbered.n::text
  from numbered
 where pi.id = numbered.id;

alter table public.pipeline_items
  alter column display_ref set not null;

alter table public.pipeline_items
  add constraint pipeline_items_display_ref_shape
  check (display_ref ~ '^OP-[1-9][0-9]{3,}$');

create unique index pipeline_items_display_ref_uidx
  on public.pipeline_items (creator_id, display_ref);

create table public.pipeline_opportunity_counters (
  creator_id uuid primary key
    references public.creator_profiles(id) on delete cascade,
  last_number integer not null check (last_number >= 1001)
);

comment on table public.pipeline_opportunity_counters is
  'D182. Per-creator counter for pipeline_items.display_ref. Dies with the creator profile. No client privilege.';

insert into public.pipeline_opportunity_counters (creator_id, last_number)
select pi.creator_id, max(pg_catalog.substring(pi.display_ref, 4)::integer)
  from public.pipeline_items pi
 group by pi.creator_id;

create or replace function public.assign_pipeline_display_ref()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_number integer;
begin
  update public.pipeline_opportunity_counters
     set last_number = last_number + 1
   where creator_id = new.creator_id
  returning last_number into v_number;

  if v_number is null then
    begin
      insert into public.pipeline_opportunity_counters (creator_id, last_number)
      values (new.creator_id, 1001);
      v_number := 1001;
    exception
      when unique_violation then
        update public.pipeline_opportunity_counters
           set last_number = last_number + 1
         where creator_id = new.creator_id
        returning last_number into v_number;
    end;
  end if;

  if v_number is null then
    raise exception 'opportunity display id was not assigned'
      using errcode = '55000';
  end if;

  new.display_ref := 'OP-' || v_number::text;
  return new;
end;
$$;

comment on function public.assign_pipeline_display_ref() is
  'D182. Assigns the next per-creator OP- display id on insert. A supplied value is replaced. search_path is empty. service_role execute; the trigger runs as the owner.';

revoke all on function public.assign_pipeline_display_ref()
  from public, anon, authenticated;
grant execute on function public.assign_pipeline_display_ref() to service_role;

drop trigger if exists pipeline_items_assign_display_ref on public.pipeline_items;
create trigger pipeline_items_assign_display_ref
  before insert on public.pipeline_items
  for each row execute function public.assign_pipeline_display_ref();

create or replace function public.protect_pipeline_display_ref()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.display_ref is distinct from old.display_ref then
    raise exception 'opportunity display id cannot change'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.protect_pipeline_display_ref() is
  'D182. display_ref is assigned once and does not change. Invoker. search_path is empty.';

revoke all on function public.protect_pipeline_display_ref()
  from public, anon, authenticated;
grant execute on function public.protect_pipeline_display_ref() to service_role;

drop trigger if exists pipeline_items_protect_display_ref on public.pipeline_items;
create trigger pipeline_items_protect_display_ref
  before update of display_ref on public.pipeline_items
  for each row execute function public.protect_pipeline_display_ref();

-- Half-open stay. Null endpoints are the whole timeline, so two undated open
-- rows in one trip bucket conflict.
create or replace function public.pipeline_stay_span(p_start date, p_end date)
returns pg_catalog.daterange
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.daterange(
    coalesce(p_start, '-infinity'::pg_catalog.date),
    coalesce(p_end, 'infinity'::pg_catalog.date),
    '[)'
  );
$$;

comment on function public.pipeline_stay_span(date, date) is
  'D182. Half-open stay used by the overlap rule. Null dates are unbounded. Not a client function.';

revoke all on function public.pipeline_stay_span(date, date)
  from public, anon, authenticated;
grant execute on function public.pipeline_stay_span(date, date) to service_role;

do $path$
begin
  if exists (select 1 from pg_catalog.pg_namespace where nspname = 'extensions') then
    perform pg_catalog.set_config('search_path', 'public, extensions', true);
  end if;
end
$path$;

alter table public.pipeline_items
  add constraint pipeline_items_same_trip_stay_excl
  exclude using gist (
    creator_id with =,
    hotel_id with =,
    trip_id with =,
    public.pipeline_stay_span(stay_start, stay_end) with &&
  ) where (status <> 'closed' and trip_id is not null);

alter table public.pipeline_items
  add constraint pipeline_items_no_trip_stay_excl
  exclude using gist (
    creator_id with =,
    hotel_id with =,
    public.pipeline_stay_span(stay_start, stay_end) with &&
  ) where (status <> 'closed' and trip_id is null);

comment on constraint pipeline_items_same_trip_stay_excl on public.pipeline_items is
  'D182. Open opportunities on one trip may not have overlapping stays. Replaces pipeline_items_single_active_cycle_uidx for the same-trip case.';

comment on constraint pipeline_items_no_trip_stay_excl on public.pipeline_items is
  'D182. Open opportunities with no trip share one bucket. Different trips are a different bucket and may overlap.';

drop index if exists public.pipeline_items_single_active_cycle_uidx;

-- ---------------------------------------------------------------------------
-- Trip-hotel nights. Existing shortlist rows stay, with no dates and pending.
-- ---------------------------------------------------------------------------
alter table public.trip_hotels
  add column check_in date,
  add column check_out date,
  add column night_status text not null default 'pending';

alter table public.trip_hotels
  add constraint trip_hotels_night_status_check
  check (night_status in ('pending', 'confirmed'));

alter table public.trip_hotels
  add constraint trip_hotels_stay_dates_pair check (
    (check_in is null and check_out is null)
    or (
      check_in is not null
      and check_out is not null
      and check_out > check_in
    )
  );

alter table public.trip_hotels
  add constraint trip_hotels_confirmed_has_dates check (
    night_status <> 'confirmed'
    or (check_in is not null and check_out is not null)
  );

comment on column public.trip_hotels.check_in is
  'D183. Creator-set inclusive check-in. Null until the creator records a stay.';

comment on column public.trip_hotels.check_out is
  'D183. Creator-set exclusive check-out.';

comment on column public.trip_hotels.night_status is
  'D183. pending or confirmed. Pending nights are not covered. Gmail does not set this.';

-- ---------------------------------------------------------------------------
-- Outreach initiatives. A trip is optional. Hotels are not a second catalog.
-- ---------------------------------------------------------------------------
create table public.outreach_initiatives (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  trip_id uuid references public.trips(id) on delete set null,
  destination_id uuid references public.destinations(id),
  name text not null,
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  constraint outreach_initiatives_name_shape check (
    pg_catalog.char_length(name) between 1 and 120
    and name = pg_catalog.btrim(name)
  )
);

comment on table public.outreach_initiatives is
  'D184. One outreach campaign. trip_id is optional. Deleting the trip keeps the campaign and clears the link. Dies with the creator.';

create index outreach_initiatives_creator_idx
  on public.outreach_initiatives (creator_id, created_at);

create index outreach_initiatives_trip_idx
  on public.outreach_initiatives (trip_id)
  where trip_id is not null;

create trigger outreach_initiatives_set_updated_at
  before update on public.outreach_initiatives
  for each row execute function public.set_updated_at();

create table public.outreach_initiative_hotels (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  initiative_id uuid not null references public.outreach_initiatives(id) on delete cascade,
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id),
  pipeline_item_id uuid references public.pipeline_items(id) on delete set null,
  source text not null,
  created_at timestamptz not null default pg_catalog.now(),
  constraint outreach_initiative_hotels_source_check
    check (source in ('trip_shortlist', 'imported', 'manual')),
  constraint outreach_initiative_hotels_hotel_uidx unique (initiative_id, hotel_id)
);

comment on table public.outreach_initiative_hotels is
  'D184. Hotels in one campaign. One row per hotel. trip_shortlist is the copy taken when the campaign was linked. imported is a later explicit import. manual is a hotel added on its own.';

create index outreach_initiative_hotels_creator_idx
  on public.outreach_initiative_hotels (creator_id);

create index outreach_initiative_hotels_pipeline_idx
  on public.outreach_initiative_hotels (pipeline_item_id)
  where pipeline_item_id is not null;

alter table public.pipeline_items
  add constraint pipeline_items_outreach_initiative_fk
  foreign key (outreach_initiative_id)
  references public.outreach_initiatives(id)
  on delete set null;

create index pipeline_items_outreach_initiative_idx
  on public.pipeline_items (outreach_initiative_id)
  where outreach_initiative_id is not null;

comment on column public.pipeline_items.outreach_initiative_id is
  'D184. Optional campaign. Clearing the campaign does not delete the opportunity.';

-- ---------------------------------------------------------------------------
-- Gmail stay suggestions. A row is a proposal. Accept is the only writer of
-- the stored dates from this table.
-- ---------------------------------------------------------------------------
create table public.stay_date_suggestions (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  owner_user_id uuid not null,
  trip_hotel_id uuid references public.trip_hotels(id) on delete cascade,
  pipeline_item_id uuid references public.pipeline_items(id) on delete cascade,
  suggested_check_in date not null,
  suggested_check_out date not null,
  status text not null default 'pending',
  source text not null default 'gmail',
  source_mail_account_id uuid not null,
  source_ref text,
  created_at timestamptz not null default pg_catalog.now(),
  resolved_at timestamptz,
  constraint stay_date_suggestions_status_check
    check (status in ('pending', 'accepted', 'rejected')),
  constraint stay_date_suggestions_source_check
    check (source = 'gmail'),
  constraint stay_date_suggestions_one_target check (
    (trip_hotel_id is not null and pipeline_item_id is null)
    or (trip_hotel_id is null and pipeline_item_id is not null)
  ),
  constraint stay_date_suggestions_range check (
    suggested_check_out > suggested_check_in
  ),
  constraint stay_date_suggestions_resolved check (
    (status = 'pending' and resolved_at is null)
    or (status in ('accepted', 'rejected') and resolved_at is not null)
  ),
  constraint stay_date_suggestions_source_ref_shape check (
    source_ref is null
    or (
      pg_catalog.char_length(source_ref) between 1 and 256
      and source_ref = pg_catalog.btrim(source_ref)
      and source_ref !~ '[[:space:]]'
    )
  ),
  constraint stay_date_suggestions_mail_owner_fk
    foreign key (source_mail_account_id, owner_user_id)
    references public.mail_accounts (id, user_id)
    on delete cascade
);

comment on table public.stay_date_suggestions is
  'D183. A Gmail proposal for different stay dates. Inserting a row does not change trip_hotels or pipeline_items. Accept and reject are creator actions. The mailbox composite key is the B01 provenance spine. Dies with the creator and with the mailbox.';

create index stay_date_suggestions_creator_idx
  on public.stay_date_suggestions (creator_id, status, created_at);

create index stay_date_suggestions_trip_hotel_idx
  on public.stay_date_suggestions (trip_hotel_id)
  where trip_hotel_id is not null;

create index stay_date_suggestions_pipeline_idx
  on public.stay_date_suggestions (pipeline_item_id)
  where pipeline_item_id is not null;

-- ---------------------------------------------------------------------------
-- Same-creator fences. They fire for every writer, including service_role.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_outreach_initiative_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_destination uuid;
begin
  if new.trip_id is null then
    return new;
  end if;

  select t.creator_id, t.destination_id
    into v_owner, v_destination
    from public.trips t
   where t.id = new.trip_id;

  if v_owner is null or v_owner is distinct from new.creator_id then
    raise exception 'outreach initiative and trip must belong to the same creator'
      using errcode = '23514';
  end if;

  if new.destination_id is not null and new.destination_id is distinct from v_destination then
    raise exception 'outreach initiative destination must match its trip'
      using errcode = '23514';
  end if;

  new.destination_id := v_destination;
  return new;
end;
$$;

comment on function public.enforce_outreach_initiative_owner() is
  'D184. A campaign trip belongs to the same creator. A linked trip supplies the destination. search_path is empty.';

revoke all on function public.enforce_outreach_initiative_owner()
  from public, anon, authenticated;
grant execute on function public.enforce_outreach_initiative_owner() to service_role;

drop trigger if exists outreach_initiatives_owner on public.outreach_initiatives;
create trigger outreach_initiatives_owner
  before insert or update of creator_id, trip_id, destination_id
  on public.outreach_initiatives
  for each row execute function public.enforce_outreach_initiative_owner();

create or replace function public.enforce_trip_creator_matches_outreach()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.creator_id is not distinct from old.creator_id then
    return new;
  end if;

  if exists (
    select 1
      from public.outreach_initiatives o
     where o.trip_id = new.id
       and o.creator_id is distinct from new.creator_id
  ) then
    raise exception 'outreach initiative and trip must belong to the same creator'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.enforce_trip_creator_matches_outreach() is
  'D184. Rejects a trips.creator_id change that would leave a campaign on another creator''s trip. search_path is empty.';

revoke all on function public.enforce_trip_creator_matches_outreach()
  from public, anon, authenticated;
grant execute on function public.enforce_trip_creator_matches_outreach() to service_role;

drop trigger if exists trips_creator_matches_outreach on public.trips;
create trigger trips_creator_matches_outreach
  before update of creator_id on public.trips
  for each row execute function public.enforce_trip_creator_matches_outreach();

create or replace function public.enforce_outreach_membership_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_trip uuid;
  v_item_creator uuid;
  v_item_hotel uuid;
  v_item_trip uuid;
begin
  select o.creator_id, o.trip_id
    into v_owner, v_trip
    from public.outreach_initiatives o
   where o.id = new.initiative_id;

  if v_owner is null or v_owner is distinct from new.creator_id then
    raise exception 'outreach hotel must belong to the same creator as the campaign'
      using errcode = '23514';
  end if;

  if new.pipeline_item_id is null then
    return new;
  end if;

  select pi.creator_id, pi.hotel_id, pi.trip_id
    into v_item_creator, v_item_hotel, v_item_trip
    from public.pipeline_items pi
   where pi.id = new.pipeline_item_id;

  if v_item_creator is null
     or v_item_creator is distinct from new.creator_id
     or v_item_hotel is distinct from new.hotel_id then
    raise exception 'outreach hotel must link an opportunity for the same creator and hotel'
      using errcode = '23514';
  end if;

  -- A campaign with a trip can only point at an opportunity on that trip.
  -- A campaign with no trip can point at an opportunity that has its own trip.
  if v_trip is not null and v_item_trip is distinct from v_trip then
    raise exception 'outreach hotel must link an opportunity on the campaign trip'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.enforce_outreach_membership_owner() is
  'D184. A campaign hotel and any linked opportunity share the creator and the hotel. A campaign that has a trip only links an opportunity on that trip. search_path is empty.';

revoke all on function public.enforce_outreach_membership_owner()
  from public, anon, authenticated;
grant execute on function public.enforce_outreach_membership_owner() to service_role;

drop trigger if exists outreach_initiative_hotels_owner on public.outreach_initiative_hotels;
create trigger outreach_initiative_hotels_owner
  before insert or update of initiative_id, creator_id, hotel_id, pipeline_item_id
  on public.outreach_initiative_hotels
  for each row execute function public.enforce_outreach_membership_owner();

create or replace function public.enforce_pipeline_outreach_same_creator()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_trip uuid;
begin
  if new.outreach_initiative_id is null then
    return new;
  end if;

  select o.creator_id, o.trip_id
    into v_owner, v_trip
    from public.outreach_initiatives o
   where o.id = new.outreach_initiative_id;

  if v_owner is null or v_owner is distinct from new.creator_id then
    raise exception 'pipeline item and outreach initiative must belong to the same creator'
      using errcode = '23514';
  end if;

  if v_trip is not null and new.trip_id is distinct from v_trip then
    raise exception 'pipeline item trip and outreach initiative trip must match'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.enforce_pipeline_outreach_same_creator() is
  'D184. An opportunity''s campaign belongs to the same creator. A campaign that names a trip only links an opportunity on that same trip, including when the opportunity has no trip. A campaign with no trip may link an opportunity that has its own trip. search_path is empty.';

revoke all on function public.enforce_pipeline_outreach_same_creator()
  from public, anon, authenticated;
grant execute on function public.enforce_pipeline_outreach_same_creator() to service_role;

drop trigger if exists pipeline_items_outreach_same_creator on public.pipeline_items;
create trigger pipeline_items_outreach_same_creator
  before insert or update of outreach_initiative_id, creator_id, trip_id
  on public.pipeline_items
  for each row execute function public.enforce_pipeline_outreach_same_creator();

create or replace function public.enforce_stay_date_suggestion_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_trip_creator uuid;
  v_item_creator uuid;
begin
  select cp.user_id into v_user
    from public.creator_profiles cp
   where cp.id = new.creator_id;

  if v_user is null or v_user is distinct from new.owner_user_id then
    raise exception 'stay suggestion owner must be the creator user'
      using errcode = '23514';
  end if;

  if new.trip_hotel_id is not null then
    select t.creator_id into v_trip_creator
      from public.trip_hotels th
      join public.trips t on t.id = th.trip_id
     where th.id = new.trip_hotel_id;

    if v_trip_creator is null or v_trip_creator is distinct from new.creator_id then
      raise exception 'stay suggestion and trip hotel must belong to the same creator'
        using errcode = '23514';
    end if;
  end if;

  if new.pipeline_item_id is not null then
    select pi.creator_id into v_item_creator
      from public.pipeline_items pi
     where pi.id = new.pipeline_item_id;

    if v_item_creator is null or v_item_creator is distinct from new.creator_id then
      raise exception 'stay suggestion and opportunity must belong to the same creator'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.enforce_stay_date_suggestion_owner() is
  'D183. A suggestion names the creator, that creator''s user, and one of their trip hotels or opportunities. search_path is empty.';

revoke all on function public.enforce_stay_date_suggestion_owner()
  from public, anon, authenticated;
grant execute on function public.enforce_stay_date_suggestion_owner() to service_role;

drop trigger if exists stay_date_suggestions_owner on public.stay_date_suggestions;
create trigger stay_date_suggestions_owner
  before insert or update of creator_id, owner_user_id, trip_hotel_id, pipeline_item_id
  on public.stay_date_suggestions
  for each row execute function public.enforce_stay_date_suggestion_owner();

-- ---------------------------------------------------------------------------
-- Reads. Invoker, so RLS is the row boundary. search_path is empty.
-- ---------------------------------------------------------------------------
create or replace function public.pipeline_stage_label(p_status text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case p_status
    when 'saved' then 'Saved'
    when 'planned' then 'Pitch ready'
    when 'pitched' then 'Sent'
    when 'replied' then 'Replied'
    when 'negotiating' then 'Negotiating'
    when 'won' then 'Agreed'
    when 'closed' then 'Closed'
    else null
  end;
$$;

comment on function public.pipeline_stage_label(text) is
  'D187. V12.1 stage name for a stored pipeline status. follow_up is not a stage and returns null.';

create or replace function public.pipeline_status_kind(p_status text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case
    when p_status in (
      'saved', 'planned', 'pitched', 'replied', 'negotiating', 'won', 'closed'
    ) then 'stage'
    when p_status = 'follow_up' then 'event'
    else null
  end;
$$;

comment on function public.pipeline_status_kind(text) is
  'D187. stage for the seven V12.1 columns. event for follow_up. null for anything else. The stored status values are unchanged.';

revoke all on function public.pipeline_stage_label(text) from public, anon;
revoke all on function public.pipeline_status_kind(text) from public, anon;
grant execute on function public.pipeline_stage_label(text) to authenticated, service_role;
grant execute on function public.pipeline_status_kind(text) to authenticated, service_role;

create or replace function public.trip_night_coverage(p_trip_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_start date;
  v_end date;
  v_trip integer;
  v_confirmed integer;
  v_pending integer;
begin
  if p_trip_id is null then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  select t.start_date, t.end_date
    into v_start, v_end
    from public.trips t
   where t.id = p_trip_id;

  if v_start is null then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  -- Booking-style trip window: [start_date, end_date). Nov 12–19 is 7 nights.
  if v_end <= v_start then
    return pg_catalog.jsonb_build_object(
      'result', 'ok',
      'trip_nights', 0,
      'confirmed_nights', 0,
      'pending_nights', 0,
      'gap_nights', 0
    );
  end if;

  with nights as (
    select gs::pg_catalog.date as night
      from pg_catalog.generate_series(
        v_start::pg_catalog.timestamp,
        (v_end - 1)::pg_catalog.timestamp,
        pg_catalog.interval '1 day'
      ) as gs
  ),
  confirmed as (
    select distinct n.night
      from nights n
      join public.trip_hotels th on th.trip_id = p_trip_id
     where th.night_status = 'confirmed'
       and th.check_in is not null
       and n.night >= th.check_in
       and n.night < th.check_out
  ),
  pending as (
    select distinct n.night
      from nights n
      join public.trip_hotels th on th.trip_id = p_trip_id
     where th.night_status = 'pending'
       and th.check_in is not null
       and n.night >= th.check_in
       and n.night < th.check_out
       and not exists (select 1 from confirmed c where c.night = n.night)
  )
  select
    (select count(*)::integer from nights),
    (select count(*)::integer from confirmed),
    (select count(*)::integer from pending)
    into v_trip, v_confirmed, v_pending;

  return pg_catalog.jsonb_build_object(
    'result', 'ok',
    'trip_nights', v_trip,
    'confirmed_nights', v_confirmed,
    'pending_nights', v_pending,
    'gap_nights', v_trip - v_confirmed - v_pending
  );
end;
$$;

comment on function public.trip_night_coverage(uuid) is
  'D183. Distinct nights in [trip.start_date, trip.end_date). Confirmed stays count once. Pending does not count as confirmed and does not recount a confirmed night. A missing trip is not_found. Runs as the caller.';

revoke all on function public.trip_night_coverage(uuid) from public, anon;
grant execute on function public.trip_night_coverage(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Writes. service_role only. Identity comes from p_user_id, never a creator id
-- argument. search_path is empty.
-- ---------------------------------------------------------------------------
create or replace function public.open_pipeline_opportunity(
  p_user_id uuid,
  p_hotel_id uuid,
  p_trip_id uuid,
  p_stay_start date,
  p_stay_end date,
  p_outreach_initiative_id uuid,
  p_free_saved_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_destination_id uuid;
  v_trip uuid;
  v_initiative_trip uuid;
  v_initiative_creator uuid;
  v_has_premium boolean;
  v_hotel_open boolean;
  v_open_count integer;
  v_conflict uuid;
  v_conflict_start date;
  v_conflict_end date;
  v_next_cycle integer;
  v_pipeline_id uuid;
  v_display text;
begin
  if p_user_id is null or p_hotel_id is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  if (p_stay_start is null) <> (p_stay_end is null)
     or (p_stay_start is not null and p_stay_end <= p_stay_start) then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return pg_catalog.jsonb_build_object('result', 'creator_profile_missing');
  end if;

  select h.destination_id into v_destination_id
    from public.hotels h
   where h.id = p_hotel_id;

  if v_destination_id is null and not exists (
    select 1 from public.hotels h where h.id = p_hotel_id
  ) then
    return pg_catalog.jsonb_build_object('result', 'hotel_not_found');
  end if;

  if not exists (select 1 from public.hotels h where h.id = p_hotel_id) then
    return pg_catalog.jsonb_build_object('result', 'hotel_not_found');
  end if;

  v_trip := p_trip_id;

  if p_outreach_initiative_id is not null then
    select o.creator_id, o.trip_id
      into v_initiative_creator, v_initiative_trip
      from public.outreach_initiatives o
     where o.id = p_outreach_initiative_id;

    if v_initiative_creator is null or v_initiative_creator is distinct from v_creator_id then
      return pg_catalog.jsonb_build_object('result', 'not_found');
    end if;

    if v_initiative_trip is not null and v_trip is not null and v_trip is distinct from v_initiative_trip then
      return pg_catalog.jsonb_build_object('result', 'invalid_input');
    end if;

    if v_trip is null then
      v_trip := v_initiative_trip;
    end if;
  end if;

  if v_trip is not null and not exists (
    select 1 from public.trips t
     where t.id = v_trip and t.creator_id = v_creator_id
  ) then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  perform 1 from public.creator_profiles where id = v_creator_id for update;

  select pi.id, pi.stay_start, pi.stay_end
    into v_conflict, v_conflict_start, v_conflict_end
    from public.pipeline_items pi
   where pi.creator_id = v_creator_id
     and pi.hotel_id = p_hotel_id
     and pi.status <> 'closed'
     and pi.trip_id is not distinct from v_trip
     and public.pipeline_stay_span(pi.stay_start, pi.stay_end)
         && public.pipeline_stay_span(p_stay_start, p_stay_end)
   order by pi.created_at, pi.id
   limit 1;

  if v_conflict is not null then
    if v_conflict_start is not distinct from p_stay_start
       and v_conflict_end is not distinct from p_stay_end then
      return pg_catalog.jsonb_build_object(
        'result', 'already_open',
        'pipeline_item_id', v_conflict,
        'display_ref', (
          select pi.display_ref from public.pipeline_items pi where pi.id = v_conflict
        )
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'result', 'overlap',
      'pipeline_item_id', v_conflict
    );
  end if;

  v_has_premium := public._has_active_pro(p_user_id)
    or (
      v_destination_id is not null
      and public._has_active_destination_access(p_user_id, v_destination_id)
    );

  v_hotel_open := exists (
    select 1
      from public.pipeline_items pi
     where pi.creator_id = v_creator_id
       and pi.hotel_id = p_hotel_id
       and pi.status <> 'closed'
  );

  -- D042 counts open hotels, not opportunity rows. A second opportunity on a
  -- hotel that is already open does not take another Free slot.
  if not v_has_premium and not v_hotel_open then
    select count(distinct pi.hotel_id)::integer into v_open_count
      from public.pipeline_items pi
      join public.hotels h on h.id = pi.hotel_id
     where pi.creator_id = v_creator_id
       and pi.status <> 'closed'
       and not public._has_active_destination_access(p_user_id, h.destination_id);

    if v_open_count >= coalesce(p_free_saved_limit, 0) then
      return pg_catalog.jsonb_build_object(
        'result', 'limit_reached',
        'open_count', v_open_count,
        'limit', p_free_saved_limit
      );
    end if;
  end if;

  select coalesce(max(pi.cycle_number), 0) + 1 into v_next_cycle
    from public.pipeline_items pi
   where pi.creator_id = v_creator_id
     and pi.hotel_id = p_hotel_id;

  insert into public.pipeline_items (
    creator_id, hotel_id, trip_id, outreach_initiative_id,
    status, cycle_number, stay_start, stay_end, saved_at, last_activity_at
  ) values (
    v_creator_id, p_hotel_id, v_trip, p_outreach_initiative_id,
    'saved', v_next_cycle, p_stay_start, p_stay_end, pg_catalog.now(), pg_catalog.now()
  )
  returning id, display_ref into v_pipeline_id, v_display;

  insert into public.outreach_events (
    creator_id, hotel_id, pipeline_item_id, event_type, event_at, source
  ) values (
    v_creator_id, p_hotel_id, v_pipeline_id, 'hotel_saved', pg_catalog.now(), 'manual_creator'
  );

  if p_outreach_initiative_id is not null then
    insert into public.outreach_initiative_hotels (
      initiative_id, creator_id, hotel_id, pipeline_item_id, source
    ) values (
      p_outreach_initiative_id, v_creator_id, p_hotel_id, v_pipeline_id, 'manual'
    )
    on conflict on constraint outreach_initiative_hotels_hotel_uidx
    do update set pipeline_item_id = excluded.pipeline_item_id
     where public.outreach_initiative_hotels.pipeline_item_id is null;
  end if;

  return pg_catalog.jsonb_build_object(
    'result', 'created',
    'pipeline_item_id', v_pipeline_id,
    'display_ref', v_display,
    'status', 'saved',
    'cycle_number', v_next_cycle
  );
exception
  when exclusion_violation then
    return pg_catalog.jsonb_build_object('result', 'overlap');
end;
$$;

comment on function public.open_pipeline_opportunity(uuid, uuid, uuid, date, date, uuid, integer) is
  'D182. Opens one opportunity when the previous one is closed, the dates do not overlap, or the trip differs. A repeat of the same trip and dates is already_open. An overlap does not insert. Free slots count distinct open hotels (D042, D056). service_role only.';

revoke all on function public.open_pipeline_opportunity(uuid, uuid, uuid, date, date, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.open_pipeline_opportunity(uuid, uuid, uuid, date, date, uuid, integer)
  to service_role;

create or replace function public.set_pipeline_opportunity_dates(
  p_user_id uuid,
  p_pipeline_item_id uuid,
  p_stay_start date,
  p_stay_end date
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_updated uuid;
begin
  if p_user_id is null or p_pipeline_item_id is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  if (p_stay_start is null) <> (p_stay_end is null)
     or (p_stay_start is not null and p_stay_end <= p_stay_start) then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return pg_catalog.jsonb_build_object('result', 'creator_profile_missing');
  end if;

  perform 1 from public.creator_profiles where id = v_creator_id for update;

  begin
    update public.pipeline_items pi
       set stay_start = p_stay_start,
           stay_end = p_stay_end
     where pi.id = p_pipeline_item_id
       and pi.creator_id = v_creator_id
    returning pi.id into v_updated;

    if v_updated is null then
      return pg_catalog.jsonb_build_object('result', 'not_found');
    end if;
  exception
    when exclusion_violation then
      return pg_catalog.jsonb_build_object('result', 'overlap');
  end;

  return pg_catalog.jsonb_build_object(
    'result', 'updated',
    'pipeline_item_id', v_updated
  );
end;
$$;

comment on function public.set_pipeline_opportunity_dates(uuid, uuid, date, date) is
  'D182. The creator sets or clears this opportunity''s stay. An overlap is refused and the stored dates stay. Does not read Gmail. service_role only.';

revoke all on function public.set_pipeline_opportunity_dates(uuid, uuid, date, date)
  from public, anon, authenticated;
grant execute on function public.set_pipeline_opportunity_dates(uuid, uuid, date, date)
  to service_role;

create or replace function public.set_trip_hotel_stay(
  p_user_id uuid,
  p_trip_id uuid,
  p_hotel_id uuid,
  p_check_in date,
  p_check_out date,
  p_night_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_updated uuid;
begin
  if p_user_id is null or p_trip_id is null or p_hotel_id is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  if p_night_status is null or p_night_status not in ('pending', 'confirmed') then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  if (p_check_in is null) <> (p_check_out is null)
     or (p_check_in is not null and p_check_out <= p_check_in)
     or (p_night_status = 'confirmed' and p_check_in is null) then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return pg_catalog.jsonb_build_object('result', 'creator_profile_missing');
  end if;

  update public.trip_hotels th
     set check_in = p_check_in,
         check_out = p_check_out,
         night_status = p_night_status
    from public.trips t
   where th.trip_id = p_trip_id
     and th.hotel_id = p_hotel_id
     and t.id = th.trip_id
     and t.creator_id = v_creator_id
  returning th.id into v_updated;

  if v_updated is null then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  return pg_catalog.jsonb_build_object(
    'result', 'updated',
    'trip_hotel_id', v_updated,
    'night_status', p_night_status
  );
end;
$$;

comment on function public.set_trip_hotel_stay(uuid, uuid, uuid, date, date, text) is
  'D183. The creator records check-in, check-out, and pending or confirmed on a shortlisted hotel. Confirmed requires dates. Does not read Gmail and does not change an opportunity. service_role only.';

revoke all on function public.set_trip_hotel_stay(uuid, uuid, uuid, date, date, text)
  from public, anon, authenticated;
grant execute on function public.set_trip_hotel_stay(uuid, uuid, uuid, date, date, text)
  to service_role;

create or replace function public.propose_stay_date_suggestion(
  p_user_id uuid,
  p_trip_hotel_id uuid,
  p_pipeline_item_id uuid,
  p_check_in date,
  p_check_out date,
  p_mail_account_id uuid,
  p_source_ref text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_mail_user uuid;
  v_mail_state text;
  v_cur_in date;
  v_cur_out date;
  v_ref text;
  v_existing uuid;
  v_id uuid;
  v_before_in date;
  v_before_out date;
  v_after_in date;
  v_after_out date;
begin
  if p_user_id is null or p_mail_account_id is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  if (p_trip_hotel_id is null) = (p_pipeline_item_id is null) then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  if p_check_in is null or p_check_out is null or p_check_out <= p_check_in then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  v_ref := nullif(pg_catalog.btrim(coalesce(p_source_ref, '')), '');
  if v_ref is not null and (
    pg_catalog.char_length(v_ref) > 256
    or v_ref ~ '[[:space:]]'
  ) then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return pg_catalog.jsonb_build_object('result', 'creator_profile_missing');
  end if;

  select m.user_id, m.connection_state
    into v_mail_user, v_mail_state
    from public.mail_accounts m
   where m.id = p_mail_account_id;

  if v_mail_user is null
     or v_mail_user is distinct from p_user_id
     or v_mail_state = 'deleted' then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  if p_trip_hotel_id is not null then
    select th.check_in, th.check_out
      into v_cur_in, v_cur_out
      from public.trip_hotels th
      join public.trips t on t.id = th.trip_id
     where th.id = p_trip_hotel_id
       and t.creator_id = v_creator_id;
  else
    select pi.stay_start, pi.stay_end
      into v_cur_in, v_cur_out
      from public.pipeline_items pi
     where pi.id = p_pipeline_item_id
       and pi.creator_id = v_creator_id;
  end if;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  v_before_in := v_cur_in;
  v_before_out := v_cur_out;

  if v_cur_in is not distinct from p_check_in
     and v_cur_out is not distinct from p_check_out then
    return pg_catalog.jsonb_build_object('result', 'same_dates');
  end if;

  select s.id into v_existing
    from public.stay_date_suggestions s
   where s.creator_id = v_creator_id
     and s.status = 'pending'
     and s.trip_hotel_id is not distinct from p_trip_hotel_id
     and s.pipeline_item_id is not distinct from p_pipeline_item_id
     and s.suggested_check_in = p_check_in
     and s.suggested_check_out = p_check_out
   limit 1;

  if v_existing is not null then
    return pg_catalog.jsonb_build_object(
      'result', 'already_pending',
      'suggestion_id', v_existing
    );
  end if;

  insert into public.stay_date_suggestions (
    creator_id, owner_user_id, trip_hotel_id, pipeline_item_id,
    suggested_check_in, suggested_check_out, status, source,
    source_mail_account_id, source_ref
  ) values (
    v_creator_id, p_user_id, p_trip_hotel_id, p_pipeline_item_id,
    p_check_in, p_check_out, 'pending', 'gmail',
    p_mail_account_id, v_ref
  )
  returning id into v_id;

  if p_trip_hotel_id is not null then
    select th.check_in, th.check_out
      into v_after_in, v_after_out
      from public.trip_hotels th
     where th.id = p_trip_hotel_id;
  else
    select pi.stay_start, pi.stay_end
      into v_after_in, v_after_out
      from public.pipeline_items pi
     where pi.id = p_pipeline_item_id;
  end if;

  if v_after_in is distinct from v_before_in or v_after_out is distinct from v_before_out then
    raise exception 'a stay suggestion must not change stored dates'
      using errcode = '55000';
  end if;

  return pg_catalog.jsonb_build_object(
    'result', 'suggested',
    'suggestion_id', v_id
  );
end;
$$;

comment on function public.propose_stay_date_suggestion(uuid, uuid, uuid, date, date, uuid, text) is
  'D183. Records a Gmail date proposal. Does not update trip_hotels or pipeline_items. The same pending dates return already_pending. Identical stored dates return same_dates. service_role only.';

revoke all on function public.propose_stay_date_suggestion(uuid, uuid, uuid, date, date, uuid, text)
  from public, anon, authenticated;
grant execute on function public.propose_stay_date_suggestion(uuid, uuid, uuid, date, date, uuid, text)
  to service_role;

create or replace function public.accept_stay_date_suggestion(
  p_user_id uuid,
  p_suggestion_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_row public.stay_date_suggestions%rowtype;
  v_updated uuid;
  v_status text;
begin
  if p_user_id is null or p_suggestion_id is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return pg_catalog.jsonb_build_object('result', 'creator_profile_missing');
  end if;

  perform 1 from public.creator_profiles where id = v_creator_id for update;

  select s.* into v_row
    from public.stay_date_suggestions s
   where s.id = p_suggestion_id
     and s.creator_id = v_creator_id
   for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  if v_row.status <> 'pending' then
    return pg_catalog.jsonb_build_object('result', 'not_pending');
  end if;

  begin
    if v_row.trip_hotel_id is not null then
      update public.trip_hotels th
         set check_in = v_row.suggested_check_in,
             check_out = v_row.suggested_check_out
       where th.id = v_row.trip_hotel_id
      returning th.id, th.night_status into v_updated, v_status;
    else
      update public.pipeline_items pi
         set stay_start = v_row.suggested_check_in,
             stay_end = v_row.suggested_check_out
       where pi.id = v_row.pipeline_item_id
         and pi.creator_id = v_creator_id
      returning pi.id into v_updated;
    end if;

    if v_updated is null then
      return pg_catalog.jsonb_build_object('result', 'not_found');
    end if;

    update public.stay_date_suggestions s
       set status = 'accepted',
           resolved_at = pg_catalog.now()
     where s.id = v_row.id
       and s.status = 'pending';
  exception
    when exclusion_violation then
      return pg_catalog.jsonb_build_object('result', 'overlap');
  end;

  return pg_catalog.jsonb_build_object(
    'result', 'accepted',
    'suggestion_id', v_row.id,
    'night_status', v_status
  );
end;
$$;

comment on function public.accept_stay_date_suggestion(uuid, uuid) is
  'D183. Copies a pending suggestion onto its one target. Trip-hotel night_status is not changed. An opportunity overlap leaves the suggestion pending and the dates unchanged. service_role only.';

revoke all on function public.accept_stay_date_suggestion(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.accept_stay_date_suggestion(uuid, uuid) to service_role;

create or replace function public.reject_stay_date_suggestion(
  p_user_id uuid,
  p_suggestion_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_status text;
  v_target uuid;
  v_rejected uuid;
begin
  if p_user_id is null or p_suggestion_id is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return pg_catalog.jsonb_build_object('result', 'creator_profile_missing');
  end if;

  select s.status, coalesce(s.trip_hotel_id, s.pipeline_item_id)
    into v_status, v_target
    from public.stay_date_suggestions s
   where s.id = p_suggestion_id
     and s.creator_id = v_creator_id
   for update;

  if v_target is null and v_status is null then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  if v_status <> 'pending' then
    return pg_catalog.jsonb_build_object('result', 'not_pending');
  end if;

  update public.stay_date_suggestions s
     set status = 'rejected',
         resolved_at = pg_catalog.now()
   where s.id = p_suggestion_id
     and s.creator_id = v_creator_id
     and s.status = 'pending'
  returning s.id into v_rejected;

  return pg_catalog.jsonb_build_object(
    'result', 'rejected',
    'suggestion_id', v_rejected
  );
end;
$$;

comment on function public.reject_stay_date_suggestion(uuid, uuid) is
  'D183. Marks a pending suggestion rejected. Does not change stored dates. service_role only.';

revoke all on function public.reject_stay_date_suggestion(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.reject_stay_date_suggestion(uuid, uuid) to service_role;

create or replace function public.create_outreach_initiative(
  p_user_id uuid,
  p_name text,
  p_trip_id uuid,
  p_destination_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_name text;
  v_destination uuid;
  v_id uuid;
  v_hotels integer := 0;
begin
  if p_user_id is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  v_name := nullif(pg_catalog.btrim(coalesce(p_name, '')), '');
  if v_name is null or pg_catalog.char_length(v_name) > 120 then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return pg_catalog.jsonb_build_object('result', 'creator_profile_missing');
  end if;

  if p_trip_id is not null then
    select t.destination_id into v_destination
      from public.trips t
     where t.id = p_trip_id
       and t.creator_id = v_creator_id;

    if v_destination is null then
      return pg_catalog.jsonb_build_object('result', 'not_found');
    end if;

    if p_destination_id is not null and p_destination_id is distinct from v_destination then
      return pg_catalog.jsonb_build_object('result', 'invalid_input');
    end if;
  else
    v_destination := p_destination_id;
    if v_destination is not null and not exists (
      select 1 from public.destinations d where d.id = v_destination
    ) then
      return pg_catalog.jsonb_build_object('result', 'destination_not_found');
    end if;
  end if;

  insert into public.outreach_initiatives (creator_id, trip_id, destination_id, name)
  values (v_creator_id, p_trip_id, v_destination, v_name)
  returning id into v_id;

  if p_trip_id is not null then
    insert into public.outreach_initiative_hotels (
      initiative_id, creator_id, hotel_id, pipeline_item_id, source
    )
    select v_id,
           v_creator_id,
           th.hotel_id,
           (
             select case when count(*) = 1 then (min(pi.id::text))::uuid else null end
               from public.pipeline_items pi
              where pi.creator_id = v_creator_id
                and pi.hotel_id = th.hotel_id
                and pi.status <> 'closed'
                and pi.trip_id is not distinct from p_trip_id
                and pi.outreach_initiative_id is null
           ),
           'trip_shortlist'
      from public.trip_hotels th
     where th.trip_id = p_trip_id;

    get diagnostics v_hotels = row_count;

    update public.pipeline_items pi
       set outreach_initiative_id = v_id
      from public.outreach_initiative_hotels h
     where h.initiative_id = v_id
       and h.pipeline_item_id = pi.id
       and pi.creator_id = v_creator_id
       and pi.outreach_initiative_id is null;
  end if;

  return pg_catalog.jsonb_build_object(
    'result', 'created',
    'initiative_id', v_id,
    'hotel_count', v_hotels
  );
end;
$$;

comment on function public.create_outreach_initiative(uuid, text, uuid, uuid) is
  'D184. Creates one campaign. A trip copies the current shortlist and does not create opportunities. A later shortlist change is not copied. No trip is allowed. service_role only.';

revoke all on function public.create_outreach_initiative(uuid, text, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.create_outreach_initiative(uuid, text, uuid, uuid)
  to service_role;

create or replace function public.import_outreach_shortlist(
  p_user_id uuid,
  p_initiative_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_trip uuid;
  v_hotels integer := 0;
begin
  if p_user_id is null or p_initiative_id is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return pg_catalog.jsonb_build_object('result', 'creator_profile_missing');
  end if;

  select o.trip_id into v_trip
    from public.outreach_initiatives o
   where o.id = p_initiative_id
     and o.creator_id = v_creator_id;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  if v_trip is null then
    return pg_catalog.jsonb_build_object('result', 'no_trip');
  end if;

  insert into public.outreach_initiative_hotels (
    initiative_id, creator_id, hotel_id, pipeline_item_id, source
  )
  select p_initiative_id,
         v_creator_id,
         th.hotel_id,
         (
           select case when count(*) = 1 then (min(pi.id::text))::uuid else null end
             from public.pipeline_items pi
            where pi.creator_id = v_creator_id
              and pi.hotel_id = th.hotel_id
              and pi.status <> 'closed'
              and pi.trip_id is not distinct from v_trip
              and (
                pi.outreach_initiative_id is null
                or pi.outreach_initiative_id = p_initiative_id
              )
         ),
         'imported'
    from public.trip_hotels th
   where th.trip_id = v_trip
     and not exists (
       select 1
         from public.outreach_initiative_hotels h
        where h.initiative_id = p_initiative_id
          and h.hotel_id = th.hotel_id
     );

  get diagnostics v_hotels = row_count;

  update public.pipeline_items pi
     set outreach_initiative_id = p_initiative_id
    from public.outreach_initiative_hotels h
   where h.initiative_id = p_initiative_id
     and h.pipeline_item_id = pi.id
     and h.source = 'imported'
     and pi.creator_id = v_creator_id
     and pi.outreach_initiative_id is null;

  return pg_catalog.jsonb_build_object(
    'result', 'imported',
    'initiative_id', p_initiative_id,
    'hotel_count', v_hotels
  );
end;
$$;

comment on function public.import_outreach_shortlist(uuid, uuid) is
  'D184. Copies trip hotels that are not already on the campaign. Does not remove hotels and does not edit rows already copied. service_role only.';

revoke all on function public.import_outreach_shortlist(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.import_outreach_shortlist(uuid, uuid) to service_role;

create or replace function public.add_outreach_hotel(
  p_user_id uuid,
  p_initiative_id uuid,
  p_hotel_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_id uuid;
begin
  if p_user_id is null or p_initiative_id is null or p_hotel_id is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return pg_catalog.jsonb_build_object('result', 'creator_profile_missing');
  end if;

  if not exists (
    select 1 from public.outreach_initiatives o
     where o.id = p_initiative_id and o.creator_id = v_creator_id
  ) then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  if not exists (select 1 from public.hotels h where h.id = p_hotel_id) then
    return pg_catalog.jsonb_build_object('result', 'hotel_not_found');
  end if;

  insert into public.outreach_initiative_hotels (
    initiative_id, creator_id, hotel_id, source
  ) values (
    p_initiative_id, v_creator_id, p_hotel_id, 'manual'
  )
  on conflict on constraint outreach_initiative_hotels_hotel_uidx
  do nothing
  returning id into v_id;

  if v_id is null then
    return pg_catalog.jsonb_build_object('result', 'already_linked', 'initiative_id', p_initiative_id);
  end if;

  return pg_catalog.jsonb_build_object(
    'result', 'added',
    'initiative_id', p_initiative_id,
    'outreach_hotel_id', v_id
  );
end;
$$;

comment on function public.add_outreach_hotel(uuid, uuid, uuid) is
  'D184. Adds one canonical hotel to the caller''s campaign. Does not create an opportunity. A duplicate hotel is already_linked. service_role only.';

revoke all on function public.add_outreach_hotel(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.add_outreach_hotel(uuid, uuid, uuid) to service_role;

create or replace function public.delete_outreach_initiative(
  p_user_id uuid,
  p_initiative_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_id uuid;
begin
  if p_user_id is null or p_initiative_id is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return pg_catalog.jsonb_build_object('result', 'creator_profile_missing');
  end if;

  delete from public.outreach_initiatives o
   where o.id = p_initiative_id
     and o.creator_id = v_creator_id
  returning o.id into v_id;

  if v_id is null then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  return pg_catalog.jsonb_build_object('result', 'deleted', 'initiative_id', v_id);
end;
$$;

comment on function public.delete_outreach_initiative(uuid, uuid) is
  'D184. Deletes the caller''s campaign and its hotel rows. Opportunities remain, with the campaign link cleared. service_role only.';

revoke all on function public.delete_outreach_initiative(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.delete_outreach_initiative(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Save still returns the one open undated no-trip cycle. The Free count is
-- distinct hotels, so a second opportunity does not consume another slot.
-- A concurrent insert now hits the exclusion constraint, not the old index.
-- ---------------------------------------------------------------------------
create or replace function public.save_hotel_to_pipeline(
  p_user_id uuid,
  p_hotel_id uuid,
  p_free_saved_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_creator_id uuid;
  v_destination_id uuid;
  v_existing_id uuid;
  v_existing_status text;
  v_display text;
  v_open_count integer;
  v_has_premium boolean;
  v_next_cycle integer;
  v_pipeline_id uuid;
begin
  if p_user_id is null or p_hotel_id is null then
    return jsonb_build_object('result', 'error');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return jsonb_build_object('result', 'creator_profile_missing');
  end if;

  select h.destination_id into v_destination_id
    from public.hotels h
   where h.id = p_hotel_id;

  if not found then
    return jsonb_build_object('result', 'hotel_not_found');
  end if;

  perform 1 from public.creator_profiles where id = v_creator_id for update;

  select pi.id, pi.status, pi.display_ref
    into v_existing_id, v_existing_status, v_display
    from public.pipeline_items pi
   where pi.creator_id = v_creator_id
     and pi.hotel_id = p_hotel_id
     and pi.status <> 'closed'
   order by pi.created_at, pi.id
   limit 1;

  if v_existing_id is not null then
    return jsonb_build_object(
      'result', 'already_saved',
      'pipeline_item_id', v_existing_id,
      'status', v_existing_status,
      'display_ref', v_display
    );
  end if;

  v_has_premium := public._has_active_pro(p_user_id)
    or (
      v_destination_id is not null
      and public._has_active_destination_access(p_user_id, v_destination_id)
    );

  if not v_has_premium then
    select count(distinct pi.hotel_id) into v_open_count
      from public.pipeline_items pi
      join public.hotels h on h.id = pi.hotel_id
     where pi.creator_id = v_creator_id
       and pi.status <> 'closed'
       and not public._has_active_destination_access(p_user_id, h.destination_id);

    if v_open_count >= coalesce(p_free_saved_limit, 0) then
      return jsonb_build_object(
        'result', 'limit_reached',
        'open_count', v_open_count,
        'limit', p_free_saved_limit
      );
    end if;
  end if;

  select coalesce(max(pi.cycle_number), 0) + 1 into v_next_cycle
    from public.pipeline_items pi
   where pi.creator_id = v_creator_id
     and pi.hotel_id = p_hotel_id;

  insert into public.pipeline_items
    (creator_id, hotel_id, status, cycle_number, saved_at, last_activity_at)
  values
    (v_creator_id, p_hotel_id, 'saved', v_next_cycle, now(), now())
  returning id, display_ref into v_pipeline_id, v_display;

  insert into public.outreach_events
    (creator_id, hotel_id, pipeline_item_id, event_type, event_at, source)
  values
    (v_creator_id, p_hotel_id, v_pipeline_id, 'hotel_saved', now(), 'manual_creator');

  return jsonb_build_object(
    'result', 'created',
    'pipeline_item_id', v_pipeline_id,
    'display_ref', v_display,
    'status', 'saved',
    'cycle_number', v_next_cycle
  );

exception
  when unique_violation or exclusion_violation then
    select pi.id, pi.status, pi.display_ref
      into v_existing_id, v_existing_status, v_display
      from public.pipeline_items pi
     where pi.creator_id = v_creator_id
       and pi.hotel_id = p_hotel_id
       and pi.status <> 'closed'
     order by pi.created_at, pi.id
     limit 1;
    if v_existing_id is null then
      return jsonb_build_object('result', 'error');
    end if;
    return jsonb_build_object(
      'result', 'already_saved',
      'pipeline_item_id', v_existing_id,
      'status', v_existing_status,
      'display_ref', v_display
    );
end;
$$;

comment on function public.save_hotel_to_pipeline(uuid, uuid, integer) is
  'Transactional, idempotent Save-to-Pipeline. An existing open opportunity for the hotel is already_saved. Free slots count distinct open hotels (D042, D056, D182). A concurrent overlap returns that row. service_role only.';

revoke all on function public.save_hotel_to_pipeline(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.save_hotel_to_pipeline(uuid, uuid, integer)
  to service_role;

-- ---------------------------------------------------------------------------
-- D186. revision_requested joins the deliverable checklist. Deadlines stay
-- pending and rejected (D115).
-- ---------------------------------------------------------------------------
do $status$
declare
  v_name text;
begin
  select c.conname into v_name
    from pg_catalog.pg_constraint c
    join pg_catalog.pg_class t on t.oid = c.conrelid
    join pg_catalog.pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public'
     and t.relname = 'collaboration_deliverables'
     and c.contype = 'c'
     and pg_catalog.pg_get_constraintdef(c.oid) like '%pending%submitted%approved%rejected%';

  if v_name is null then
    raise exception 'deliverable status check was not found';
  end if;

  execute format(
    'alter table public.collaboration_deliverables drop constraint %I',
    v_name
  );
end
$status$;

alter table public.collaboration_deliverables
  add constraint collaboration_deliverables_status_check
  check (status in ('pending', 'submitted', 'revision_requested', 'approved', 'rejected'));

comment on column public.collaboration_deliverables.status is
  'D078 checklist state, plus D186 revision_requested. It does not change the derived value and it does not approve the collaboration.';

create or replace function public.upsert_collaboration_deliverable(
  p_user_id uuid,
  p_pipeline_item_id uuid,
  p_deliverable_id uuid,
  p_deliverable_type text,
  p_quantity integer,
  p_platform text,
  p_due_on date,
  p_status text,
  p_proof_url text,
  p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_count integer;
  v_collab_id uuid;
  v_collab_creator uuid;
  v_type text;
  v_status text;
  v_platform text;
  v_notes text;
  v_url text;
  v_saved uuid;
begin
  if p_user_id is null or p_pipeline_item_id is null then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  v_type := nullif(pg_catalog.btrim(coalesce(p_deliverable_type, '')), '');
  v_status := nullif(pg_catalog.btrim(coalesce(p_status, '')), '');
  v_platform := nullif(pg_catalog.btrim(coalesce(p_platform, '')), '');
  v_notes := nullif(pg_catalog.btrim(coalesce(p_notes, '')), '');
  v_url := nullif(pg_catalog.btrim(coalesce(p_proof_url, '')), '');

  if v_type is null
     or v_type not in ('reel','story','post','tiktok','youtube','photo_set','ugc_video','other')
     or v_status is null
     or v_status not in ('pending','submitted','revision_requested','approved','rejected')
     or p_quantity is null
     or p_quantity < 1
     or p_quantity > 10000 then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  if v_platform is not null and pg_catalog.char_length(v_platform) > 80 then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;
  if v_notes is not null and pg_catalog.char_length(v_notes) > 2000 then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;
  if v_url is not null
     and (
       pg_catalog.char_length(v_url) > 2000
       or v_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]]*)?$'
     ) then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return pg_catalog.jsonb_build_object('result', 'creator_profile_missing');
  end if;

  perform 1 from public.creator_profiles where id = v_creator_id for update;

  if not exists (
    select 1 from public.pipeline_items pi
     where pi.id = p_pipeline_item_id
       and pi.creator_id = v_creator_id
  ) then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  select count(*)::integer into v_count
    from public.collaborations c
   where c.pipeline_item_id = p_pipeline_item_id;

  if v_count = 0 then
    return pg_catalog.jsonb_build_object('result', 'collaboration_not_found');
  end if;
  if v_count <> 1 then
    return pg_catalog.jsonb_build_object('result', 'integrity_error');
  end if;

  select c.id, c.creator_id
    into v_collab_id, v_collab_creator
    from public.collaborations c
   where c.pipeline_item_id = p_pipeline_item_id
   for update;

  if v_collab_creator is distinct from v_creator_id then
    return pg_catalog.jsonb_build_object('result', 'integrity_error');
  end if;

  if p_deliverable_id is null then
    insert into public.collaboration_deliverables (
      creator_id, collaboration_id, pipeline_item_id,
      deliverable_type, quantity, platform, due_on, status, proof_url, notes
    ) values (
      v_creator_id, v_collab_id, p_pipeline_item_id,
      v_type, p_quantity, v_platform, p_due_on, v_status, v_url, v_notes
    )
    returning id into v_saved;
  else
    update public.collaboration_deliverables d
       set deliverable_type = v_type,
           quantity = p_quantity,
           platform = v_platform,
           due_on = p_due_on,
           status = v_status,
           proof_url = v_url,
           notes = v_notes
     where d.id = p_deliverable_id
       and d.collaboration_id = v_collab_id
       and d.creator_id = v_creator_id
       and d.pipeline_item_id = p_pipeline_item_id
    returning d.id into v_saved;

    if v_saved is null then
      return pg_catalog.jsonb_build_object('result', 'not_found');
    end if;
  end if;

  return pg_catalog.jsonb_build_object('result', 'saved', 'deliverable_id', v_saved);
end;
$$;

comment on function public.upsert_collaboration_deliverable(
  uuid, uuid, uuid, text, integer, text, date, text, text, text
) is
  'D078 creator write of one deliverable, including D186 revision_requested. A foreign deliverable id is not_found. service_role only.';

revoke all on function public.upsert_collaboration_deliverable(
  uuid, uuid, uuid, text, integer, text, date, text, text, text
) from public, anon, authenticated;
grant execute on function public.upsert_collaboration_deliverable(
  uuid, uuid, uuid, text, integer, text, date, text, text, text
) to service_role;

-- ---------------------------------------------------------------------------
-- Privileges. Authenticated may read its own rows. Writes are the RPCs.
-- The counter has no client privilege.
-- ---------------------------------------------------------------------------
alter table public.pipeline_opportunity_counters enable row level security;
alter table public.outreach_initiatives enable row level security;
alter table public.outreach_initiative_hotels enable row level security;
alter table public.stay_date_suggestions enable row level security;

revoke all on table public.pipeline_opportunity_counters
  from public, anon, authenticated, service_role;
revoke all on table public.outreach_initiatives
  from public, anon, authenticated, service_role;
revoke all on table public.outreach_initiative_hotels
  from public, anon, authenticated, service_role;
revoke all on table public.stay_date_suggestions
  from public, anon, authenticated, service_role;

grant select, insert, update, delete on table public.pipeline_opportunity_counters
  to service_role;
grant select on table public.outreach_initiatives to authenticated;
grant select, insert, update, delete on table public.outreach_initiatives to service_role;
grant select on table public.outreach_initiative_hotels to authenticated;
grant select, insert, update, delete on table public.outreach_initiative_hotels to service_role;
grant select on table public.stay_date_suggestions to authenticated;
grant select, insert, update, delete on table public.stay_date_suggestions to service_role;

create policy outreach_initiatives_select on public.outreach_initiatives
  for select to authenticated
  using (creator_id = public.current_creator_id());

create policy outreach_initiative_hotels_select on public.outreach_initiative_hotels
  for select to authenticated
  using (creator_id = public.current_creator_id());

create policy stay_date_suggestions_select on public.stay_date_suggestions
  for select to authenticated
  using (creator_id = public.current_creator_id());
