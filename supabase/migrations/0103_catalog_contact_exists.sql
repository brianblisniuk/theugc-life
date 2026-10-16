-- 0103_catalog_contact_exists.sql
-- Discover may show "Contact available" without an address.
-- The function returns a boolean per published hotel id. It does not return
-- email, phone, name, or the cache row.

create or replace function public.catalog_contact_exists(p_hotel_ids uuid[])
returns table (hotel_id uuid, contact_exists boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select h.id as hotel_id,
    (
      exists (
        select 1
          from public.hotel_contacts c
         where c.hotel_id = h.id
           and c.status in ('active', 'unverified', 'stale')
      )
      or exists (
        select 1
          from public.contact_cache k
         where k.hotel_id = h.id
           and k.status = 'found'
      )
    ) as contact_exists
  from public.hotels h
  where h.id in (
    select distinct requested.id
      from unnest(coalesce(p_hotel_ids, array[]::uuid[])) as requested(id)
     limit 50
  )
    and h.destination_id is not null
    and h.star_rating in (4, 5)
    and h.latitude >= -90 and h.latitude <= 90
    and h.longitude >= -180 and h.longitude <= 180
    and h.active_status in ('active', 'temporarily_closed', 'unknown')
    and (
      (h.star_rating_source is null and h.star_rating_confidence is null)
      or (h.star_rating_source = 'owner' and h.star_rating_confidence = 'confirmed')
      or (h.star_rating_source = 'hotelbeds' and h.star_rating_confidence = 'provisional')
    );
$$;

comment on function public.catalog_contact_exists(uuid[]) is
  'Boolean contact existence for up to 50 published hotel ids. No email, phone, or name is returned. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.catalog_contact_exists(uuid[]) from public, anon;
grant execute on function public.catalog_contact_exists(uuid[]) to authenticated, service_role;
