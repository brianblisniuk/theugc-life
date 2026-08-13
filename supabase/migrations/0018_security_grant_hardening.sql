-- 0018_security_grant_hardening.sql
-- Hosted Supabase hardening for explicit default EXECUTE grants present on
-- newly created projects. 0010 revoked private helpers from PUBLIC, but hosted
-- defaults may also grant EXECUTE directly to anon/authenticated.

revoke all on function
  public._is_admin_or_editor(uuid),
  public._has_active_pro(uuid),
  public._destination_is_descendant(uuid, uuid),
  public._has_active_destination_access(uuid, uuid),
  public._has_premium_hotel_access(uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public._is_admin_or_editor(uuid),
  public._has_active_pro(uuid),
  public._destination_is_descendant(uuid, uuid),
  public._has_active_destination_access(uuid, uuid),
  public._has_premium_hotel_access(uuid, uuid)
to service_role;

-- Trigger-only provisioning function must not be exposed as an RPC.
revoke all on function public.handle_new_user()
from public, anon, authenticated;

-- Pin search_path on mutable trigger helpers flagged by hosted security advisor.
alter function public.set_updated_at()
  set search_path = public, pg_temp;

alter function public.prevent_user_privilege_change()
  set search_path = public, pg_temp;
