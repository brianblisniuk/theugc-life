-- 0008_intelligence.sql
-- Derived, rebuildable intelligence tables (DATABASE.md §9, D008, D011).
-- These aggregates contain NO creator identifiers by construction.

-- ---------------------------------------------------------------------------
-- hotel_intelligence (derived; keyed by hotel)
-- ---------------------------------------------------------------------------
create table public.hotel_intelligence (
  hotel_id uuid primary key references public.hotels(id) on delete cascade,
  interaction_count_30d integer not null default 0,
  interaction_count_90d integer not null default 0,
  interaction_count_365d integer not null default 0,
  pitch_count integer not null default 0,
  reply_count integer not null default 0,
  positive_reply_count integer not null default 0,
  negative_reply_count integer not null default 0,
  collaboration_count integer not null default 0,
  reply_rate numeric,
  median_reply_hours numeric,
  last_creator_activity_at timestamptz,
  last_reply_at timestamptz,
  last_collaboration_at timestamptz,
  activity_level text
    check (activity_level is null or activity_level in ('high', 'medium', 'low', 'emerging')),
  confidence_level text
    check (confidence_level is null or confidence_level in
      ('insufficient', 'emerging', 'moderate', 'strong')),
  calculated_at timestamptz not null default now()
);

comment on table public.hotel_intelligence is
  'Derived hotel metrics. Rebuildable from outreach_events. Public pages read the safe view, not this table (DATABASE.md §9).';

create index hotel_intelligence_activity_idx
  on public.hotel_intelligence (activity_level, confidence_level);

-- ---------------------------------------------------------------------------
-- destination_intelligence (derived; keyed by destination)
-- ---------------------------------------------------------------------------
create table public.destination_intelligence (
  destination_id uuid primary key references public.destinations(id) on delete cascade,
  hotel_count integer not null default 0,
  creator_activity_count integer not null default 0,
  pitch_count integer not null default 0,
  reply_count integer not null default 0,
  collaboration_count integer not null default 0,
  reply_rate numeric,
  median_reply_hours numeric,
  active_hotels_count integer not null default 0,
  calculated_at timestamptz not null default now()
);
