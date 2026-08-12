-- 0003_geography_and_inventory.sql
-- Destinations (hierarchical), brands, hotels, hotel contacts (DATABASE.md §5).

-- ---------------------------------------------------------------------------
-- destinations (hierarchical; not synonymous with cities — D013)
-- ---------------------------------------------------------------------------
create table public.destinations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  type text not null check (type in ('country', 'region', 'island', 'city', 'area')),
  country_code text,
  country_name text,
  parent_destination_id uuid references public.destinations(id),
  latitude numeric,
  longitude numeric,
  bounding_box jsonb,
  is_sellable boolean not null default false,
  is_featured boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index destinations_parent_idx on public.destinations (parent_destination_id);
create index destinations_slug_idx on public.destinations (slug);

create trigger destinations_set_updated_at
  before update on public.destinations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- brands
-- ---------------------------------------------------------------------------
create table public.brands (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  website_url text,
  logo_url text,
  parent_brand_id uuid references public.brands(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index brands_parent_idx on public.brands (parent_brand_id);

create trigger brands_set_updated_at
  before update on public.brands
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- hotels (basic data is public; contacts are separate — D006)
-- ---------------------------------------------------------------------------
create table public.hotels (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  brand_id uuid references public.brands(id),
  destination_id uuid not null references public.destinations(id),
  country_code text,
  address text,
  latitude numeric,
  longitude numeric,
  website_url text,
  instagram_url text,
  hotel_type text,
  star_rating numeric check (star_rating is null or (star_rating >= 0 and star_rating <= 5)),
  description_short text,
  active_status text not null default 'unknown'
    check (active_status in ('active', 'temporarily_closed', 'closed', 'unknown')),
  editorial_verified_at timestamptz,
  editorial_verification_status text not null default 'unverified'
    check (editorial_verification_status in ('verified', 'needs_review', 'stale', 'unverified')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index hotels_destination_idx on public.hotels (destination_id);
create index hotels_brand_idx on public.hotels (brand_id);
create index hotels_slug_idx on public.hotels (slug);

create trigger hotels_set_updated_at
  before update on public.hotels
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- hotel_contacts (premium; never exposed via unrestricted public select)
-- ---------------------------------------------------------------------------
create table public.hotel_contacts (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  first_name text,
  last_name text,
  job_title text,
  department text
    check (department is null or department in
      ('marketing', 'pr', 'social_media', 'communications', 'partnerships', 'sales', 'general', 'other')),
  email text,
  phone text,
  linkedin_url text,
  contact_type text,
  status text not null default 'unverified'
    check (status in ('active', 'unverified', 'stale', 'invalid', 'replaced')),
  source_type text not null default 'editorial'
    check (source_type in ('editorial', 'public_source', 'creator_signal', 'hotel_claim')),
  source_reference text,
  verified_at timestamptz,
  last_checked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index hotel_contacts_hotel_status_idx on public.hotel_contacts (hotel_id, status);

create trigger hotel_contacts_set_updated_at
  before update on public.hotel_contacts
  for each row execute function public.set_updated_at();
