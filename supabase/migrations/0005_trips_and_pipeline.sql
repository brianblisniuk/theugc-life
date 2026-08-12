-- 0005_trips_and_pipeline.sql
-- Creator workflow: trips and pipeline (DATABASE.md §8).
-- pipeline_items = current relationship state; history lives in outreach_events.

-- ---------------------------------------------------------------------------
-- trips (private by default — D014-adjacent; PRD §7.5)
-- ---------------------------------------------------------------------------
create table public.trips (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  destination_id uuid not null references public.destinations(id),
  name text,
  start_date date not null,
  end_date date not null,
  status text not null default 'planning'
    check (status in ('planning', 'upcoming', 'active', 'completed', 'cancelled')),
  visibility text not null default 'private'
    check (visibility in ('private', 'public')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trips_dates_valid check (end_date >= start_date)
);

create index trips_creator_status_idx on public.trips (creator_id, status);
create index trips_destination_idx on public.trips (destination_id);

create trigger trips_set_updated_at
  before update on public.trips
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- trip_hotels
-- ---------------------------------------------------------------------------
create table public.trip_hotels (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id),
  priority text,
  created_at timestamptz not null default now(),
  constraint trip_hotels_unique unique (trip_id, hotel_id)
);

create index trip_hotels_hotel_idx on public.trip_hotels (hotel_id);

-- ---------------------------------------------------------------------------
-- pipeline_items (one creator<->hotel relationship cycle)
-- ---------------------------------------------------------------------------
create table public.pipeline_items (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id),
  trip_id uuid references public.trips(id) on delete set null,
  status text not null default 'saved'
    check (status in ('saved', 'planned', 'pitched', 'replied', 'follow_up', 'negotiating', 'won', 'closed')),
  priority text,
  private_notes text,
  next_followup_at timestamptz,
  saved_at timestamptz not null default now(),
  first_pitched_at timestamptz,
  last_activity_at timestamptz not null default now(),
  cycle_number integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pipeline_items_cycle_positive check (cycle_number >= 1)
);

create index pipeline_items_creator_status_idx on public.pipeline_items (creator_id, status);
create index pipeline_items_hotel_idx on public.pipeline_items (hotel_id);
create index pipeline_items_followup_idx
  on public.pipeline_items (creator_id, next_followup_at)
  where next_followup_at is not null;

-- Multiple historical cycles per (creator, hotel) are allowed, but only one
-- non-closed (active) cycle at a time (DATABASE.md §8 "prevent multiple
-- simultaneously active cycles").
create unique index pipeline_items_single_active_cycle_uidx
  on public.pipeline_items (creator_id, hotel_id)
  where status <> 'closed';

create trigger pipeline_items_set_updated_at
  before update on public.pipeline_items
  for each row execute function public.set_updated_at();
