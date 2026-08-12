-- 0009_growth_entities.sql
-- Growth/viral entities (DATABASE.md §10). Foundations only in Sprint 0; no
-- product UI yet. Share/portfolio public exposure uses non-guessable tokens.

-- ---------------------------------------------------------------------------
-- hotel_claims (MVP: lead capture only — PRD §7.8)
-- ---------------------------------------------------------------------------
create table public.hotel_claims (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  claimant_name text,
  claimant_email text,
  company text,
  status text not null default 'new',
  created_at timestamptz not null default now(),
  reviewed_at timestamptz
);

create index hotel_claims_hotel_idx on public.hotel_claims (hotel_id);
create index hotel_claims_status_idx on public.hotel_claims (status, created_at);

-- ---------------------------------------------------------------------------
-- public_creator_profile_views (anonymous/session-level; no implied identity)
-- ---------------------------------------------------------------------------
create table public.public_creator_profile_views (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  viewer_session_id text,
  referrer text,
  utm_source text,
  hotel_id uuid references public.hotels(id),
  viewed_at timestamptz not null default now()
);

create index pcp_views_creator_idx on public.public_creator_profile_views (creator_id, viewed_at);

-- ---------------------------------------------------------------------------
-- milestones (system-generated from real domain data — D015)
-- ---------------------------------------------------------------------------
create table public.milestones (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  milestone_type text not null,
  value integer,
  achieved_at timestamptz not null default now(),
  share_card_generated boolean not null default false,
  shared_at timestamptz
);

create index milestones_creator_idx on public.milestones (creator_id, achieved_at);

-- ---------------------------------------------------------------------------
-- share_cards (non-guessable public token; never serialize hotel targets)
-- ---------------------------------------------------------------------------
create table public.share_cards (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  milestone_id uuid references public.milestones(id) on delete set null,
  card_type text not null,
  period_start date,
  period_end date,
  public_token text not null unique,
  image_url text,
  created_at timestamptz not null default now(),
  expires_at timestamptz
);

create index share_cards_creator_idx on public.share_cards (creator_id);

-- ---------------------------------------------------------------------------
-- referrals (attribution/conversion; payout is separate — D001)
-- ---------------------------------------------------------------------------
create table public.referrals (
  id uuid primary key default gen_random_uuid(),
  referrer_user_id uuid not null references public.users(id) on delete cascade,
  referral_code text not null unique,
  referred_user_id uuid references public.users(id) on delete set null,
  status text not null default 'pending',
  conversion_purchase_id uuid references public.purchases(id) on delete set null,
  reward_status text not null default 'none',
  created_at timestamptz not null default now(),
  converted_at timestamptz
);

create index referrals_referrer_idx on public.referrals (referrer_user_id);
