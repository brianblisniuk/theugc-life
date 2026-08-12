-- 0010_access_helper_functions.sql
-- Centralized authorization helpers (PERMISSIONS.md §3). Entitlement logic lives
-- HERE, once, and is reused by RLS policies — never duplicated in React.
--
-- All are SECURITY DEFINER with a fixed search_path so they can evaluate
-- entitlements/hierarchy the calling user may not directly read, without
-- recursing into the policies being evaluated.

-- Current authenticated user's application role, or null.
create or replace function public.current_user_role()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select role from public.users where id = auth.uid();
$$;

-- Current authenticated user's creator_profiles.id, or null.
create or replace function public.current_creator_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select id from public.creator_profiles where user_id = auth.uid();
$$;

-- Is the given user an admin or editor? (role-based; PERMISSIONS.md §11)
create or replace function public.is_admin_or_editor(uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.users
    where id = uid and role in ('admin', 'editor')
  );
$$;

-- Active worldwide premium entitlement (Pro, or internal 'admin' comp access).
-- Access is judged by time-bounded active entitlements, not subscription UI
-- state (DATABASE.md §7, PRD §15.4).
create or replace function public.has_active_pro(uid uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.access_entitlements e
    where e.user_id = uid
      and e.access_type in ('pro', 'admin')
      and e.status = 'active'
      and e.starts_at <= now()
      and (e.expires_at is null or e.expires_at > now())
  );
$$;

-- Is `child_id` a proper (strict) descendant of `ancestor_id` in the
-- destination hierarchy? Used so a Bali pass covers Ubud/Seminyak (PRD §15.4).
-- Depth-limited to guard against accidental cycles in the data.
create or replace function public.destination_is_descendant(child_id uuid, ancestor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with recursive chain as (
    select d.id, d.parent_destination_id, 1 as depth
    from public.destinations d
    where d.id = child_id
    union all
    select p.id, p.parent_destination_id, c.depth + 1
    from public.destinations p
    join chain c on p.id = c.parent_destination_id
    where c.depth < 20
  )
  select exists (
    select 1 from chain
    where id = ancestor_id and id <> child_id
  );
$$;

-- Active destination entitlement covering `dest_id` directly or via hierarchy.
create or replace function public.has_active_destination_access(uid uuid, dest_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.access_entitlements e
    where e.user_id = uid
      and e.access_type = 'destination'
      and e.status = 'active'
      and e.starts_at <= now()
      and (e.expires_at is null or e.expires_at > now())
      and e.destination_id is not null
      and (
        e.destination_id = dest_id
        or public.destination_is_descendant(dest_id, e.destination_id)
      )
  );
$$;

-- Master premium-contact/intelligence gate for a hotel (PERMISSIONS.md §7, §9).
-- admin/editor (operational) OR active Pro (worldwide) OR active destination
-- entitlement covering the hotel's destination.
create or replace function public.has_premium_hotel_access(uid uuid, hotel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when uid is null then false
    when public.is_admin_or_editor(uid) then true
    when public.has_active_pro(uid) then true
    else public.has_active_destination_access(
      uid,
      (select destination_id from public.hotels where id = hotel_id)
    )
  end;
$$;

-- Access checks are safe to expose to both roles; they only return booleans/ids.
grant execute on function
  public.current_user_role(),
  public.current_creator_id(),
  public.is_admin_or_editor(uuid),
  public.has_active_pro(uuid),
  public.destination_is_descendant(uuid, uuid),
  public.has_active_destination_access(uuid, uuid),
  public.has_premium_hotel_access(uuid, uuid)
to anon, authenticated;
