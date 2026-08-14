-- 0025_service_role_view_acl_convergence.sql
--
-- Post-deploy verification of D046 found one effective relation privilege that
-- a clean local replay did not reproduce: hosted production already gave
-- service_role ALL privileges on public.hotel_public_intelligence, while the
-- application contract requires SELECT-only on this read projection.
--
-- 0024 reset anon/authenticated/PUBLIC relation privileges, but intentionally
-- did not reset pre-existing service_role privileges before re-granting the
-- application contract. A fresh replay therefore ended at SELECT-only while the
-- hosted project retained its older service_role grant.
--
-- We also observed platform-owned pg_default_acl entries under supabase_admin.
-- Those are Supabase internals, are not modifiable by the postgres migration
-- role, and do not govern application objects created by our migrations. The
-- supported opt-in control for our objects is the postgres default-privilege
-- revocation already applied by 0024. Do not attempt to mutate supabase_admin
-- defaults from an application migration.
--
-- 0024 is already deployed and remains immutable. Normalize the effective view
-- privilege in this follow-up migration so production and replay converge.

revoke all privileges on table public.hotel_public_intelligence from service_role;
grant select on table public.hotel_public_intelligence to service_role;
