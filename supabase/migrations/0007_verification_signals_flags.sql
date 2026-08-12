-- 0007_verification_signals_flags.sql
-- Editorial evidence: creator signals, verification events, admin flags
-- (DATABASE.md §6). Signals are NOT master truth (D010).

-- ---------------------------------------------------------------------------
-- contact_signals (creator observations; do not mutate editorial truth)
-- ---------------------------------------------------------------------------
create table public.contact_signals (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references public.hotel_contacts(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id),
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  signal_type text not null check (signal_type in
    ('email_worked', 'email_bounced', 'person_changed', 'wrong_department', 'auto_reply', 'other')),
  -- Internal/private; never surfaced as public intelligence (DATABASE.md §6).
  details text,
  created_at timestamptz not null default now()
);

create index contact_signals_contact_idx on public.contact_signals (contact_id, created_at);
create index contact_signals_creator_idx on public.contact_signals (creator_id, created_at);

-- ---------------------------------------------------------------------------
-- verification_events (polymorphic; do not cascade-delete history)
-- ---------------------------------------------------------------------------
create table public.verification_events (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  verification_type text,
  status text,
  performed_by uuid references public.users(id),
  source_type text,
  notes text,
  created_at timestamptz not null default now()
);

create index verification_events_entity_idx
  on public.verification_events (entity_type, entity_id, created_at);

-- ---------------------------------------------------------------------------
-- admin_flags (records needing human action)
-- ---------------------------------------------------------------------------
create table public.admin_flags (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null,
  entity_id uuid not null,
  flag_type text not null,
  source text,
  severity text,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.users(id)
);

create index admin_flags_status_idx on public.admin_flags (status, created_at);
create index admin_flags_entity_idx on public.admin_flags (entity_type, entity_id);
