-- 0024_explicit_acl_contract.sql
--
-- D046 — DATABASE PRIVILEGES ARE AN EXPLICIT MIGRATION CONTRACT.
-- Hosted default privileges are NOT part of the application security model.
--
-- Why this migration exists
-- -------------------------
-- The pre-Sprint-3 audit replayed 0001 -> 0023 into an empty database and read
-- the resulting privilege matrix. External verification then read the same
-- matrix from the deployed project and got a DIFFERENT answer: hosted Supabase
-- had left broader default grants in place, including client-role write and
-- TRUNCATE privileges on relations no migration in this repository ever asked
-- for. Two things follow:
--
--   * a fresh replay is not a faithful rehearsal of production, so every
--     DB-backed privilege assertion was reasoning about the wrong schema; and
--   * the intended privilege contract lived only in PERMISSIONS.md, so nothing
--     in the database asserted it and nothing could detect drift from it.
--
-- RLS is enabled on all 36 application tables and no row-level path through
-- those extra grants was found, so this is NOT a record of exposure. It is a
-- record of a surface wider than the contract, established by a mechanism the
-- repository does not control.
--
-- What this migration does
-- ------------------------
--   1. REVOKES every relation privilege in `public` from `anon`,
--      `authenticated` and `PUBLIC`, so no inherited or platform-supplied grant
--      survives, whatever the starting state was.
--   2. RE-GRANTS, by name, exactly the privileges each client role needs.
--   3. Establishes `service_role` coverage explicitly instead of inheriting it.
--   4. Stops FUTURE objects created by the migration role from inheriting
--      client-role privileges by default.
--
-- What this migration does NOT do
-- -------------------------------
--   * It does not drop, add or widen a single RLS policy. Table ACLs are the
--     capability/exposure control; RLS remains the authorization mechanism, and
--     both must hold independently.
--   * It does not touch Supabase-owned schemas (`auth`, `storage`,
--     `supabase_migrations`) — those belong to the platform, not the app.
--   * It does not revoke privileges on existing FUNCTIONS. The self-scoped
--     `current_*` / `has_*` / `is_*` wrappers are deliberately PUBLIC-executable
--     (0010, 0018) because RLS policies invoke them as the calling role, and the
--     eight application RPCs already carry their own explicit
--     revoke-then-grant blocks (0019-0023). Re-auditing them is a test
--     obligation, not a DDL one.
--   * It does not revoke `usage on schema public` from `anon`/`authenticated`.
--     PostgREST cannot resolve any relation without it.

-- ---------------------------------------------------------------------------
-- 1. RESET — nothing inherited survives
-- ---------------------------------------------------------------------------

-- Blanket first, so a relation this file forgot cannot keep a stale grant.
revoke all privileges on all tables in schema public from anon;
revoke all privileges on all tables in schema public from authenticated;
revoke all privileges on all tables in schema public from public;

-- Then by name, so the contract lists its own inventory: 36 tables + 1 view.
-- This is deliberately redundant with the blanket revoke above.
revoke all privileges on table
  public.access_entitlements,
  public.admin_flags,
  public.brands,
  public.collaborations,
  public.contact_signals,
  public.creator_profiles,
  public.destination_aliases,
  public.destination_intelligence,
  public.destinations,
  public.editorial_evidence,
  public.hotel_claims,
  public.hotel_contacts,
  public.hotel_intelligence,
  public.hotel_organizations,
  public.hotel_public_intelligence,
  public.hotels,
  public.import_batches,
  public.import_match_candidates,
  public.import_property_reviews,
  public.import_row_links,
  public.import_row_reviews,
  public.import_rows,
  public.milestones,
  public.organization_contacts,
  public.organizations,
  public.outreach_events,
  public.pipeline_items,
  public.portfolio_assets,
  public.public_creator_profile_views,
  public.purchases,
  public.referrals,
  public.share_cards,
  public.subscriptions,
  public.trip_hotels,
  public.trips,
  public.users,
  public.verification_events
from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- 2. IDENTITY — public.users
-- ---------------------------------------------------------------------------
-- The application resolves the session role by reading this table under the
-- caller's own RLS. Without a table privilege the read fails, and a failed read
-- was being collapsed into the domain role "creator" (audit F-01). The grant is
-- half the fix; the other half is in src/lib/auth/guards.ts, which now reports a
-- lookup failure as a technical error instead of as a role.
--
-- `users_select_own` / `users_update_own` restrict both statements to
-- `id = auth.uid()`, and `prevent_user_privilege_change` still blocks any
-- attempt to alter `role` or `status`. No INSERT (rows come from the signup
-- trigger), no DELETE, no TRUNCATE.
grant select, update on table public.users to authenticated;

-- ---------------------------------------------------------------------------
-- 3. CREATOR IDENTITY AND PORTFOLIO
-- ---------------------------------------------------------------------------
-- Public profiles and public portfolio assets are readable anonymously; the
-- policies (`creator_profiles_select`, `portfolio_assets_select`) decide which
-- rows that means.
grant select on table
  public.creator_profiles,
  public.portfolio_assets
to anon;

-- Onboarding inserts/updates the caller's own profile row. There is no DELETE
-- policy on creator_profiles, so a DELETE privilege would be unusable; it is
-- not granted.
grant select, insert, update on table public.creator_profiles to authenticated;
grant select, insert, update, delete on table public.portfolio_assets to authenticated;

-- ---------------------------------------------------------------------------
-- 4. PUBLIC CATALOGUE
-- ---------------------------------------------------------------------------
-- Anonymous browsing of the catalogue is intended. Write capability is granted
-- to `authenticated` as a capability only: `*_write` policies restrict every
-- write to `is_admin_or_editor()`, so a regular creator holding these
-- privileges still cannot change a single row.
grant select on table
  public.brands,
  public.destinations,
  public.hotels
to anon;

grant select, insert, update, delete on table
  public.brands,
  public.destinations,
  public.hotels
to authenticated;

-- Contacts are never anonymous. `hotel_contacts_select` gates reads on
-- `has_premium_hotel_access()`; `hotel_contacts_write` gates writes on
-- `is_admin_or_editor()`.
grant select, insert, update, delete on table public.hotel_contacts to authenticated;

-- ---------------------------------------------------------------------------
-- 5. COMMERCE — read-only to the browser
-- ---------------------------------------------------------------------------
-- Entitlement state is written by the billing path under service_role and is
-- never client-writable. Reads are restricted to the caller's own rows (or
-- admin/editor) by policy.
grant select on table
  public.access_entitlements,
  public.purchases,
  public.subscriptions
to authenticated;

-- ---------------------------------------------------------------------------
-- 6. CREATOR WORKSPACE
-- ---------------------------------------------------------------------------
-- Trips remain directly owner-writable: they carry no cross-table invariant and
-- no trusted RPC.
grant select, insert, update, delete on table
  public.trip_hotels,
  public.trips
to authenticated;

-- The CRM tables are SELECT-ONLY to the browser, and must stay that way.
-- 0020 revoked client writes on pipeline_items and outreach_events and 0021 on
-- collaborations, because every state change has to happen inside a
-- transactional, service_role-only RPC that locks the creator, enforces the
-- Free limits, validates the transition and appends the event ledger entry in
-- one transaction. A direct client write would bypass all of it.
-- Re-granting INSERT/UPDATE/DELETE here would silently undo Sprint 2C/2D.
grant select on table
  public.collaborations,
  public.outreach_events,
  public.pipeline_items
to authenticated;

-- ---------------------------------------------------------------------------
-- 7. INTELLIGENCE
-- ---------------------------------------------------------------------------
-- The base aggregate tables are NOT client-readable (0022). Their RLS policies
-- are retained as defence in depth, but no client role holds a privilege to
-- reach them, so `anon` and `authenticated` are granted nothing here and this
-- block is intentionally a comment rather than a GRANT.
--
-- Creators see intelligence exclusively through the gated projection, which
-- exposes seven coarse columns and no creator, pipeline, count or timestamp.
-- service_role is granted SELECT so that a future server-side read via the
-- admin client does not fail with a confusing permission error (audit F-07).
grant select on table public.hotel_public_intelligence to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. EDITORIAL / IMPORT / ADMIN
-- ---------------------------------------------------------------------------
-- These are capability grants for staff surfaces and the import CLI's
-- admin-authenticated paths. Every one of these tables is gated by an
-- `is_admin_or_editor()` policy, so a regular creator holding the privilege
-- reads zero rows and writes none.
grant select, insert, update, delete on table
  public.destination_aliases,
  public.editorial_evidence,
  public.hotel_organizations,
  public.import_batches,
  public.import_match_candidates,
  public.import_property_reviews,
  public.import_row_links,
  public.import_row_reviews,
  public.import_rows,
  public.organization_contacts,
  public.organizations
to authenticated;

-- Narrower staff tables: the privilege set matches the policies that exist.
-- admin_flags has no delete surface; hotel_claims is reviewed, not created or
-- removed, from the client; verification_events and contact_signals are
-- append-only ledgers.
grant select, insert, update on table public.admin_flags to authenticated;
grant select, update on table public.hotel_claims to authenticated;
grant select, insert on table public.contact_signals to authenticated;
grant select, insert on table public.verification_events to authenticated;

-- ---------------------------------------------------------------------------
-- 9. GROWTH — read-only, own rows
-- ---------------------------------------------------------------------------
-- No client write surface is implemented for any of these. Granting one now
-- would enable a capability the product does not have.
grant select on table
  public.milestones,
  public.public_creator_profile_views,
  public.referrals,
  public.share_cards
to authenticated;

-- ---------------------------------------------------------------------------
-- 10. SERVICE ROLE — stated, not inherited
-- ---------------------------------------------------------------------------
-- The trusted server boundary runs every RPC and every admin-client read as
-- service_role. RLS is bypassed for this role by design, which is exactly why
-- its privileges must be written down rather than assumed.
grant all privileges on table
  public.access_entitlements,
  public.admin_flags,
  public.brands,
  public.collaborations,
  public.contact_signals,
  public.creator_profiles,
  public.destination_aliases,
  public.destination_intelligence,
  public.destinations,
  public.editorial_evidence,
  public.hotel_claims,
  public.hotel_contacts,
  public.hotel_intelligence,
  public.hotel_organizations,
  public.hotels,
  public.import_batches,
  public.import_match_candidates,
  public.import_property_reviews,
  public.import_row_links,
  public.import_row_reviews,
  public.import_rows,
  public.milestones,
  public.organization_contacts,
  public.organizations,
  public.outreach_events,
  public.pipeline_items,
  public.portfolio_assets,
  public.public_creator_profile_views,
  public.purchases,
  public.referrals,
  public.share_cards,
  public.subscriptions,
  public.trip_hotels,
  public.trips,
  public.users,
  public.verification_events
to service_role;

-- ---------------------------------------------------------------------------
-- 11. FUTURE OBJECTS — no inherited client privileges
-- ---------------------------------------------------------------------------
-- Without this, the divergence that produced this migration simply returns the
-- next time a migration creates a table: replay would grant the client roles
-- nothing while hosted defaults would grant them everything.
--
-- These statements apply to the role running the migrations, which is the role
-- that will own every future application object. service_role defaults are left
-- alone deliberately — its broad access is by design, and the drift assertion in
-- the test suite fails if a new relation is missing explicit service_role
-- coverage.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;

-- Same reasoning for functions, and the same failure mode: hosted Supabase
-- grants EXECUTE on new functions to the client roles, which is why 0018 had to
-- exist and why every RPC since has carried its own revoke block. Future
-- functions must state their callers.
alter default privileges in schema public revoke all on functions from anon, authenticated, public;
