-- 0006_events_and_collaborations.sql
-- Strategic append-oriented domain ledger + first-class collaborations
-- (DATABASE.md §8, EVENTS.md, D008).

-- ---------------------------------------------------------------------------
-- outreach_events (append-oriented; source of truth for intelligence)
-- ---------------------------------------------------------------------------
create table public.outreach_events (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id),
  pipeline_item_id uuid not null references public.pipeline_items(id) on delete cascade,
  event_type text not null check (event_type in (
    'hotel_saved', 'pitch_sent', 'followup_sent', 'reply_received',
    'positive_reply', 'negative_reply', 'contact_bounced', 'offer_received',
    'negotiation_started', 'deal_won', 'deal_lost', 'collaboration_started',
    'collaboration_completed', 'creator_closed_pipeline'
  )),
  event_at timestamptz not null,
  channel text check (channel is null or channel in
    ('email', 'instagram', 'linkedin', 'website_form', 'whatsapp', 'in_person', 'other')),
  metadata jsonb not null default '{}',
  source text not null default 'manual_creator'
    check (source in ('manual_creator', 'system', 'admin_correction', 'gmail', 'outlook', 'marketplace')),
  created_at timestamptz not null default now()
);

comment on table public.outreach_events is
  'Append-oriented domain ledger. Corrections are explicit/auditable, never silent rewrites (DATABASE.md §2, EVENTS.md §9).';

create index outreach_events_hotel_idx on public.outreach_events (hotel_id, event_at);
create index outreach_events_creator_idx on public.outreach_events (creator_id, event_at);
create index outreach_events_pipeline_idx on public.outreach_events (pipeline_item_id, event_at);
create index outreach_events_type_idx on public.outreach_events (event_type, event_at);

-- ---------------------------------------------------------------------------
-- collaborations (first-class; not merely status = won — D-invariant §8.8)
-- ---------------------------------------------------------------------------
create table public.collaborations (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id),
  pipeline_item_id uuid references public.pipeline_items(id) on delete set null,
  status text not null default 'agreed'
    check (status in ('agreed', 'scheduled', 'active', 'completed', 'cancelled')),
  collaboration_type text
    check (collaboration_type is null or collaboration_type in
      ('stay', 'product', 'paid', 'stay_plus_paid', 'other')),
  agreed_at timestamptz,
  start_date date,
  end_date date,
  terms_matched text not null default 'unknown'
    check (terms_matched in ('yes', 'partially', 'no', 'unknown')),
  would_work_again boolean,
  -- Private financial values MUST NOT feed public aggregates in V1 (DATABASE.md §8).
  private_value_amount numeric,
  private_value_currency text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint collaborations_dates_valid
    check (start_date is null or end_date is null or end_date >= start_date)
);

create index collaborations_creator_idx on public.collaborations (creator_id);
create index collaborations_hotel_idx on public.collaborations (hotel_id);

create trigger collaborations_set_updated_at
  before update on public.collaborations
  for each row execute function public.set_updated_at();
