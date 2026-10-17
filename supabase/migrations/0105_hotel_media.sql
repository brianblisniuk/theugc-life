-- 0105_hotel_media.sql
-- D189. Hotel photographs are a child of the canonical hotel.
-- Forbes files live in the public hotel-media bucket. Hotelbeds stays on its CDN.
-- A hidden row is a takedown. Re-import must not revive it (the loader uses
-- ON CONFLICT DO NOTHING). Coverage below 100% stays valid (D064, D055).

create table public.hotel_media (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  source text not null check (source in ('forbes', 'hotelbeds')),
  -- Forbes: <slug>/<file>. Hotelbeds: the giata path. The loader's idempotency key.
  source_media_key text not null,
  storage_bucket text,
  -- Forbes base path, without the w1280/w480 file name.
  storage_path text,
  -- Hotelbeds giata path, for example 00/005787/005787a_hb_a_030.jpg.
  remote_path text,
  category text,
  role text not null default 'gallery' check (role in ('cover', 'gallery')),
  position integer not null check (position >= 0),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  alt_text text,
  credit text not null,
  rights_basis text not null,
  status text not null default 'active' check (status in ('active', 'hidden')),
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint hotel_media_location check (
    (source = 'forbes' and storage_path is not null and remote_path is null)
    or (source = 'hotelbeds' and remote_path is not null and storage_path is null)
  ),
  constraint hotel_media_forbes_bucket check (
    source <> 'forbes' or storage_bucket = 'hotel-media'
  ),
  constraint hotel_media_key_shape check (
    source_media_key <> ''
    and position(E'\n' in source_media_key) = 0
    and position('..' in source_media_key) = 0
  ),
  constraint hotel_media_hotel_source_key unique (hotel_id, source, source_media_key)
);

comment on table public.hotel_media is
  'D189. One row per photograph. Forbes bytes are in storage. Hotelbeds is a remote path. status=hidden is a takedown and stays hidden across re-import.';

comment on column public.hotel_media.credit is
  'Visible credit source. Forbes Travel Guide or Hotelbeds. The screen adds the Photo: prefix for Forbes.';

comment on column public.hotel_media.rights_basis is
  'owner_decision_D189 until a later licence reference replaces it.';

create index hotel_media_hotel_pos
  on public.hotel_media (hotel_id, status, position);

create unique index hotel_media_one_cover
  on public.hotel_media (hotel_id)
  where role = 'cover' and status = 'active';

create trigger hotel_media_set_updated_at
  before update on public.hotel_media
  for each row execute function public.set_updated_at();

alter table public.hotel_media enable row level security;

-- Active rows only, including for staff. A hidden row is not a catalog photo.
create policy hotel_media_select on public.hotel_media
  for select
  using (status = 'active');

create policy hotel_media_insert on public.hotel_media
  for insert
  with check (public.is_admin_or_editor());

create policy hotel_media_update on public.hotel_media
  for update
  using (public.is_admin_or_editor())
  with check (public.is_admin_or_editor());

create policy hotel_media_delete on public.hotel_media
  for delete
  using (public.is_admin_or_editor());

revoke all on table public.hotel_media from public, anon, authenticated;
grant select on table public.hotel_media to anon, authenticated;
grant select, insert, update, delete on table public.hotel_media to authenticated;
grant all privileges on table public.hotel_media to service_role;

-- Best eligible cover. Forbes before Hotelbeds, then an active cover, then position.
-- security_invoker so hotel_media RLS applies to the caller.
create view public.hotel_cover
with (security_barrier = true, security_invoker = true) as
select distinct on (hotel_id)
  hotel_id,
  source,
  storage_bucket,
  storage_path,
  remote_path,
  alt_text,
  credit
from public.hotel_media
where status = 'active'
order by hotel_id, (source = 'forbes') desc, (role = 'cover') desc, position;

comment on view public.hotel_cover is
  'D189. One active photograph per hotel. Forbes first, then Hotelbeds. security_invoker: RLS still hides hidden rows.';

revoke all on table public.hotel_cover from public, anon, authenticated, service_role;
grant select on table public.hotel_cover to anon, authenticated, service_role;

-- Staff takedown. Security definer so the update does not depend on the caller
-- being able to see the row after the status flips. The role check is inside.
create or replace function public.hide_hotel_media(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  updated_id uuid;
begin
  if p_id is null or not public.is_admin_or_editor() then
    return false;
  end if;
  update public.hotel_media
     set status = 'hidden'
   where id = p_id
     and status = 'active'
  returning id into updated_id;
  return updated_id is not null;
end;
$$;

comment on function public.hide_hotel_media(uuid) is
  'D189 takedown. Admin or editor only. Sets status=hidden. SECURITY DEFINER. search_path is empty.';

revoke all on function public.hide_hotel_media(uuid) from public, anon;
grant execute on function public.hide_hotel_media(uuid) to authenticated, service_role;

-- Loader helper. One active cover per hotel: Forbes first, then GEN/facade.
-- Demote the old cover before promoting, so hotel_media_one_cover holds.
create or replace function public.promote_hotel_covers(p_hotel_ids uuid[])
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  hid uuid;
  chosen uuid;
  n integer := 0;
begin
  if p_hotel_ids is null or cardinality(p_hotel_ids) > 500 then
    raise exception 'promote_hotel_covers accepts at most 500 hotel ids'
      using errcode = '22023';
  end if;
  foreach hid in array p_hotel_ids loop
    if hid is null then
      continue;
    end if;
    select m.id into chosen
      from public.hotel_media m
     where m.hotel_id = hid
       and m.status = 'active'
     order by (m.source = 'forbes') desc,
              (m.category in ('GEN', 'facade')) desc,
              (m.role = 'cover') desc,
              m.position asc,
              m.created_at asc
     limit 1;
    if chosen is null then
      continue;
    end if;
    update public.hotel_media
       set role = 'gallery'
     where hotel_id = hid
       and status = 'active'
       and role = 'cover'
       and id <> chosen;
    update public.hotel_media
       set role = 'cover'
     where id = chosen
       and role is distinct from 'cover';
    n := n + 1;
  end loop;
  return n;
end;
$$;

comment on function public.promote_hotel_covers(uuid[]) is
  'D189. Service role only. Picks one active cover: Forbes, then GEN or facade. SECURITY DEFINER. search_path is empty.';

revoke all on function public.promote_hotel_covers(uuid[]) from public, anon, authenticated;
grant execute on function public.promote_hotel_covers(uuid[]) to service_role;

-- Public catalog bucket. Created when the platform storage schema exists
-- (hosted Supabase, or the test bootstrap). A plain Postgres without storage
-- skips this block; the table and RLS above still apply.
do $hotel_media_bucket$
begin
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise notice '0105: storage schema is absent; hotel-media bucket was not created';
    return;
  end if;

  insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  values ('hotel-media', 'hotel-media', true, 2097152, array['image/webp'])
  on conflict (id) do update
    set name = excluded.name,
        public = excluded.public,
        file_size_limit = excluded.file_size_limit,
        allowed_mime_types = excluded.allowed_mime_types;

  -- No insert, update, or delete policy for this bucket. Client roles cannot
  -- write objects. service_role bypasses RLS and is the only writer.
  execute 'drop policy if exists hotel_media_public_read on storage.objects';
  execute $policy$
    create policy hotel_media_public_read on storage.objects
      for select
      to anon, authenticated
      using (bucket_id = 'hotel-media')
  $policy$;
end
$hotel_media_bucket$;
