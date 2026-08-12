-- 0012_rls_policies.sql
-- Enable RLS everywhere, set explicit table grants, and define policies
-- (PERMISSIONS.md). Ownership/authorization is enforced server-side here — UI
-- hiding is never authorization (PERMISSIONS.md §1).
--
-- Grants + RLS work together: a role needs BOTH a table GRANT and a passing
-- policy. Sensitive tables have no anon grant at all; RLS then gates rows for
-- authenticated callers. The service_role bypasses RLS (webhooks/admin jobs).

grant usage on schema public to anon, authenticated;

-- ===========================================================================
-- Enable Row Level Security on every application table.
-- ===========================================================================
alter table public.users enable row level security;
alter table public.creator_profiles enable row level security;
alter table public.portfolio_assets enable row level security;
alter table public.destinations enable row level security;
alter table public.brands enable row level security;
alter table public.hotels enable row level security;
alter table public.hotel_contacts enable row level security;
alter table public.subscriptions enable row level security;
alter table public.purchases enable row level security;
alter table public.access_entitlements enable row level security;
alter table public.trips enable row level security;
alter table public.trip_hotels enable row level security;
alter table public.pipeline_items enable row level security;
alter table public.outreach_events enable row level security;
alter table public.collaborations enable row level security;
alter table public.contact_signals enable row level security;
alter table public.verification_events enable row level security;
alter table public.admin_flags enable row level security;
alter table public.hotel_intelligence enable row level security;
alter table public.destination_intelligence enable row level security;
alter table public.hotel_claims enable row level security;
alter table public.public_creator_profile_views enable row level security;
alter table public.milestones enable row level security;
alter table public.share_cards enable row level security;
alter table public.referrals enable row level security;

-- ===========================================================================
-- Table grants. service_role gets everything (it also bypasses RLS).
-- ===========================================================================
grant all on all tables in schema public to service_role;

-- Public-readable reference/inventory data.
grant select on public.destinations, public.brands, public.hotels to anon, authenticated;
grant insert, update, delete on public.destinations, public.brands, public.hotels to authenticated;

-- Premium contacts: authenticated only (RLS gates by entitlement). No anon.
grant select, insert, update, delete on public.hotel_contacts to authenticated;

-- Creator profile + portfolio: anon may read (RLS restricts to public rows).
grant select on public.creator_profiles, public.portfolio_assets to anon, authenticated;
grant insert, update, delete on public.creator_profiles, public.portfolio_assets to authenticated;

-- Creator-private workspace: authenticated only.
grant select, insert, update, delete on public.trips, public.trip_hotels,
  public.pipeline_items, public.collaborations to authenticated;

-- Append-oriented ledger: read + insert only (no update/delete grant).
grant select, insert on public.outreach_events to authenticated;

-- Commerce: read-own only; writes happen via service_role (webhooks/admin).
grant select on public.subscriptions, public.purchases, public.access_entitlements
  to authenticated;

-- Signals: read + insert (RLS gates). Verification/flags: admin/editor via RLS.
grant select, insert on public.contact_signals to authenticated;
grant select, insert, update on public.verification_events, public.admin_flags
  to authenticated;

-- Intelligence base tables: authenticated read (RLS = premium/admin). Anon uses
-- the safe view (0013), not these tables.
grant select on public.hotel_intelligence, public.destination_intelligence
  to authenticated;

-- Growth: hotel_claims (lead capture) and public_creator_profile_views
-- (anonymous view counting) are written ONLY through validated server endpoints
-- with anti-abuse controls (via service_role), which are not implemented yet.
-- Sprint 0.1: no direct client INSERT grant for either table — not to anon and
-- not to authenticated — so no client can write to them directly. Reads remain
-- gated by RLS below.
grant select, update on public.hotel_claims to authenticated;
grant select on public.public_creator_profile_views to authenticated;
grant select on public.milestones, public.share_cards, public.referrals
  to authenticated;

-- ===========================================================================
-- Policies
-- ===========================================================================

-- users: read/update own row only. Role/status changes are blocked by trigger.
create policy users_select_own on public.users
  for select using (id = auth.uid());
create policy users_update_own on public.users
  for update using (id = auth.uid()) with check (id = auth.uid());

-- creator_profiles: owner full access; public rows are world-readable.
create policy creator_profiles_select on public.creator_profiles
  for select using (user_id = auth.uid() or public_profile_enabled = true);
create policy creator_profiles_insert on public.creator_profiles
  for insert with check (user_id = auth.uid());
create policy creator_profiles_update on public.creator_profiles
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());

-- portfolio_assets: owner full access; public assets of public profiles readable.
create policy portfolio_assets_select on public.portfolio_assets
  for select using (
    creator_id = public.current_creator_id()
    or (
      is_public
      and exists (
        select 1 from public.creator_profiles cp
        where cp.id = portfolio_assets.creator_id and cp.public_profile_enabled
      )
    )
  );
create policy portfolio_assets_insert on public.portfolio_assets
  for insert with check (creator_id = public.current_creator_id());
create policy portfolio_assets_update on public.portfolio_assets
  for update using (creator_id = public.current_creator_id())
  with check (creator_id = public.current_creator_id());
create policy portfolio_assets_delete on public.portfolio_assets
  for delete using (creator_id = public.current_creator_id());

-- destinations / brands / hotels: world-readable; admin/editor write.
create policy destinations_select on public.destinations for select using (true);
create policy destinations_write on public.destinations
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());

create policy brands_select on public.brands for select using (true);
create policy brands_write on public.brands
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());

create policy hotels_select on public.hotels for select using (true);
create policy hotels_write on public.hotels
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());

-- hotel_contacts: premium-gated read; admin/editor write. Never anon.
-- Uses the self-scoped wrapper (evaluates only for auth.uid()).
create policy hotel_contacts_select on public.hotel_contacts
  for select using (public.has_premium_hotel_access(hotel_id));
create policy hotel_contacts_write on public.hotel_contacts
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());

-- Commerce: read own (admins may read for reconciliation). No client writes.
create policy subscriptions_select on public.subscriptions
  for select using (user_id = auth.uid() or public.is_admin_or_editor());
create policy purchases_select on public.purchases
  for select using (user_id = auth.uid() or public.is_admin_or_editor());
create policy access_entitlements_select on public.access_entitlements
  for select using (user_id = auth.uid() or public.is_admin_or_editor());

-- trips: owner-only, all operations.
create policy trips_all on public.trips
  for all using (creator_id = public.current_creator_id())
  with check (creator_id = public.current_creator_id());

-- trip_hotels: ownership resolved through the parent trip.
create policy trip_hotels_all on public.trip_hotels
  for all using (
    exists (
      select 1 from public.trips t
      where t.id = trip_hotels.trip_id and t.creator_id = public.current_creator_id()
    )
  )
  with check (
    exists (
      select 1 from public.trips t
      where t.id = trip_hotels.trip_id and t.creator_id = public.current_creator_id()
    )
  );

-- pipeline_items: owner-only. private_notes never leave the owner via RLS.
create policy pipeline_items_all on public.pipeline_items
  for all using (creator_id = public.current_creator_id())
  with check (creator_id = public.current_creator_id());

-- outreach_events: read own; insert own identity only; no update/delete
-- (append-only; corrections go through service_role/admin_correction).
create policy outreach_events_select on public.outreach_events
  for select using (creator_id = public.current_creator_id());
create policy outreach_events_insert on public.outreach_events
  for insert with check (creator_id = public.current_creator_id());

-- collaborations: owner-only.
create policy collaborations_all on public.collaborations
  for all using (creator_id = public.current_creator_id())
  with check (creator_id = public.current_creator_id());

-- contact_signals: creators read/insert own; admin/editor may review all.
create policy contact_signals_select on public.contact_signals
  for select using (
    creator_id = public.current_creator_id() or public.is_admin_or_editor()
  );
create policy contact_signals_insert on public.contact_signals
  for insert with check (creator_id = public.current_creator_id());

-- verification_events / admin_flags: admin/editor only.
create policy verification_events_select on public.verification_events
  for select using (public.is_admin_or_editor());
create policy verification_events_insert on public.verification_events
  for insert with check (public.is_admin_or_editor());

create policy admin_flags_select on public.admin_flags
  for select using (public.is_admin_or_editor());
create policy admin_flags_write on public.admin_flags
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());

-- hotel_intelligence: premium/admin read only. Public reads the safe view.
create policy hotel_intelligence_select on public.hotel_intelligence
  for select using (public.has_premium_hotel_access(hotel_id));

-- destination_intelligence: any active premium entitlement, or admin/editor.
create policy destination_intelligence_select on public.destination_intelligence
  for select using (
    public.is_admin_or_editor()
    or public.has_active_pro()
    or public.has_active_destination_access(destination_id)
  );

-- hotel_claims: admin/editor review. Lead submission is server-mediated
-- (service_role) once the validated endpoint exists — no direct client INSERT
-- policy/grant, so anon and authenticated direct inserts are rejected.
create policy hotel_claims_select on public.hotel_claims
  for select using (public.is_admin_or_editor());
create policy hotel_claims_update on public.hotel_claims
  for update using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());

-- public_creator_profile_views: owner/admin read. View logging is server-
-- mediated (service_role) via a future validated endpoint — no direct client
-- INSERT policy/grant, so anon and authenticated direct inserts are rejected.
create policy pcp_views_select on public.public_creator_profile_views
  for select using (
    creator_id = public.current_creator_id() or public.is_admin_or_editor()
  );

-- milestones / share_cards / referrals: owner read. Creation via service_role
-- or later-sprint features.
create policy milestones_select on public.milestones
  for select using (creator_id = public.current_creator_id());
create policy share_cards_select on public.share_cards
  for select using (creator_id = public.current_creator_id());
create policy referrals_select on public.referrals
  for select using (referrer_user_id = auth.uid());
