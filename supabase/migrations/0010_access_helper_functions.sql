-- 0010_access_helper_functions.sql
-- Centralized authorization helpers (PERMISSIONS.md §3). Entitlement logic lives
-- HERE, once, and is reused by RLS policies — never duplicated in React.
--
-- SECURITY / EXPOSURE MODEL (Sprint 0.1 hardening):
--   * PRIVATE core functions take an arbitrary user id and therefore could leak
--     another user's entitlement/role state if callable over the PostgREST RPC
--     surface. They are `_`-prefixed, have EXECUTE revoked from PUBLIC (so anon
--     and authenticated cannot call them), and are used ONLY from inside the
--     SECURITY DEFINER wrappers below (which run as the function owner and thus
--     retain the privilege to call them).
--   * PUBLIC wrappers take NO user id and evaluate authorization strictly for
--     auth.uid(). They are safe to expose to anon/authenticated because a client
--     can only ever ask about itself.
--
-- All functions are SECURITY DEFINER with a fixed search_path so they can read
-- entitlements/hierarchy without recursing into the policies being evaluated.

-- ===========================================================================
-- Self-scoped identity helpers (safe: reveal only the caller's own row).
-- ===========================================================================

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

-- ===========================================================================
-- PRIVATE arbitrary-user core functions. NOT client-callable (see grants at
-- bottom). Invoked only from the SECURITY DEFINER wrappers below.
-- ===========================================================================

create or replace function public._is_admin_or_editor(uid uuid)
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

create or replace function public._has_active_pro(uid uuid)
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

-- Is `child_id` a proper (strict) descendant of `ancestor_id`? Not user-scoped
-- (no personal data), but kept internal for a minimal RPC surface. Depth-limited
-- to guard against accidental cycles in the data.
create or replace function public._destination_is_descendant(child_id uuid, ancestor_id uuid)
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

create or replace function public._has_active_destination_access(uid uuid, dest_id uuid)
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
        or public._destination_is_descendant(dest_id, e.destination_id)
      )
  );
$$;

create or replace function public._has_premium_hotel_access(uid uuid, hotel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when uid is null then false
    when public._is_admin_or_editor(uid) then true
    when public._has_active_pro(uid) then true
    else public._has_active_destination_access(
      uid,
      (select destination_id from public.hotels where id = hotel_id)
    )
  end;
$$;

-- ===========================================================================
-- PUBLIC self-scoped wrappers. Evaluate ONLY for auth.uid(); safe to expose.
-- These are what RLS policies and clients call.
-- ===========================================================================

create or replace function public.is_admin_or_editor()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public._is_admin_or_editor(auth.uid());
$$;

create or replace function public.has_active_pro()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public._has_active_pro(auth.uid());
$$;

create or replace function public.has_active_destination_access(dest_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public._has_active_destination_access(auth.uid(), dest_id);
$$;

create or replace function public.has_premium_hotel_access(hotel_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public._has_premium_hotel_access(auth.uid(), hotel_id);
$$;

-- ===========================================================================
-- Grants. Default EXECUTE is granted to PUBLIC on create, so we REVOKE it from
-- PUBLIC on the private core functions, then grant the private set to
-- service_role only (trusted server / admin tooling). The self-scoped wrappers
-- are exposed to anon/authenticated.
-- ===========================================================================

revoke all on function
  public._is_admin_or_editor(uuid),
  public._has_active_pro(uuid),
  public._destination_is_descendant(uuid, uuid),
  public._has_active_destination_access(uuid, uuid),
  public._has_premium_hotel_access(uuid, uuid)
from public;

grant execute on function
  public._is_admin_or_editor(uuid),
  public._has_active_pro(uuid),
  public._destination_is_descendant(uuid, uuid),
  public._has_active_destination_access(uuid, uuid),
  public._has_premium_hotel_access(uuid, uuid)
to service_role;

grant execute on function
  public.current_user_role(),
  public.current_creator_id(),
  public.is_admin_or_editor(),
  public.has_active_pro(),
  public.has_active_destination_access(uuid),
  public.has_premium_hotel_access(uuid)
to anon, authenticated;
