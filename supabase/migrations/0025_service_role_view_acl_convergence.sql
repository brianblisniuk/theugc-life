-- 0025_service_role_view_acl_convergence.sql
--
-- Post-deploy verification of D046 found one hosted-default privilege that
-- 0024 did not remove: service_role already held ALL relation privileges on
-- public.hotel_public_intelligence in the hosted project. A clean local replay
-- did not inherit that hosted grant, so it correctly reported SELECT-only.
--
-- 0024 intentionally reset anon/authenticated/PUBLIC relation privileges and
-- then granted service_role explicitly on application tables, but it did not
-- first revoke pre-existing service_role privileges on this view. As a result,
-- production and replay differed even though the intended contract was the same.
--
-- Do not rewrite 0024 after deployment. Normalize the already-deployed state in
-- a new immutable migration so fresh replay and production converge exactly.

revoke all privileges on table public.hotel_public_intelligence from service_role;
grant select on table public.hotel_public_intelligence to service_role;
