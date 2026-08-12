-- 0002_users_and_profiles.sql
-- Application identity + creator domain (DATABASE.md §3, §4).
-- public.users.id equals auth.users.id (canonical auth identity).

-- ---------------------------------------------------------------------------
-- public.users
-- ---------------------------------------------------------------------------
create table public.users (
  id uuid primary key,
  email text,
  role text not null default 'creator'
    check (role in ('creator', 'editor', 'admin', 'moderator', 'brand')),
  status text not null default 'active'
    check (status in ('active', 'suspended', 'deleted')),
  timezone text,
  locale text,
  last_active_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.users is
  'Application users. id equals auth.users.id. role is server-controlled; clients must never set it (DATABASE.md §3).';

create trigger users_set_updated_at
  before update on public.users
  for each row execute function public.set_updated_at();

-- Prevent privilege escalation: only trusted server roles (service_role /
-- postgres) may change role or status. A normal authenticated request runs as
-- the `authenticated` DB role and is rejected here even if a row-update policy
-- would otherwise permit the write (PRD §33.4, PERMISSIONS.md §1).
create or replace function public.prevent_user_privilege_change()
returns trigger
language plpgsql
as $$
begin
  if (new.role is distinct from old.role
      or new.status is distinct from old.status)
     and current_user not in ('service_role', 'postgres', 'supabase_admin')
  then
    raise exception 'not authorized to change role/status';
  end if;
  return new;
end;
$$;

create trigger users_prevent_privilege_change
  before update on public.users
  for each row execute function public.prevent_user_privilege_change();

-- ---------------------------------------------------------------------------
-- creator_profiles
-- ---------------------------------------------------------------------------
create table public.creator_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references public.users(id) on delete cascade,
  display_name text,
  username citext unique,
  bio text,
  home_city text,
  home_country text,
  profile_photo_url text,
  primary_language text,
  languages text[] not null default '{}',
  creator_niches text[] not null default '{}',
  content_formats text[] not null default '{}',
  instagram_url text,
  instagram_handle text,
  tiktok_url text,
  tiktok_handle text,
  youtube_url text,
  website_url text,
  portfolio_visibility text not null default 'private'
    check (portfolio_visibility in ('private', 'public')),
  public_profile_enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.creator_profiles is
  'Creator profile, 1:1 with users. Public exposure gated by public_profile_enabled (PERMISSIONS.md §5).';

create trigger creator_profiles_set_updated_at
  before update on public.creator_profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- portfolio_assets
-- ---------------------------------------------------------------------------
create table public.portfolio_assets (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  type text not null check (type in ('video', 'image', 'link', 'case_study')),
  storage_path text,
  external_url text,
  thumbnail_path text,
  title text,
  description text,
  sort_order integer not null default 0,
  is_public boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Exactly one usable asset source (DATABASE.md §4).
  constraint portfolio_assets_one_source
    check (num_nonnulls(storage_path, external_url) = 1)
);

create index portfolio_assets_creator_idx
  on public.portfolio_assets (creator_id, sort_order);

create trigger portfolio_assets_set_updated_at
  before update on public.portfolio_assets
  for each row execute function public.set_updated_at();
