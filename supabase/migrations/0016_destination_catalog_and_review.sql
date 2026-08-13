-- 0016_destination_catalog_and_review.sql
-- Sprint 1B: destination catalog (aliases), reviewer-gated promotion review
-- state, canonical hotel_contacts adjustments, and the import_row_links
-- idempotency backstop (DESTINATION_CATALOG.md, CANONICAL_PROMOTION_SPEC.md,
-- SPRINT_1B_DECISIONS D034–D041). Additive; migrations 0001–0015 are baseline.

-- ===========================================================================
-- Destination aliases (DESTINATION_CATALOG.md §4). Internal editorial mapping,
-- NOT a public destination entity. Admin/editor + service_role only.
-- ===========================================================================
create table public.destination_aliases (
  id uuid primary key default gen_random_uuid(),
  destination_id uuid not null references public.destinations(id) on delete cascade,
  alias text not null,
  normalized_alias text not null,
  country_code text,
  source text not null default 'editorial',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Prevent duplicate active alias identities for the SAME destination, while
-- allowing the same human alias to map to different destinations/countries
-- (ambiguity is then detected + left unresolved by the resolver, never
-- auto-resolved). country_code NULL is coalesced so it participates in the key.
create unique index destination_aliases_active_identity_uidx
  on public.destination_aliases (destination_id, normalized_alias, coalesce(country_code, ''))
  where is_active;
-- Resolution lookup by alias (+ optional country).
create index destination_aliases_lookup_idx
  on public.destination_aliases (normalized_alias, country_code);

create trigger destination_aliases_set_updated_at
  before update on public.destination_aliases
  for each row execute function public.set_updated_at();

-- ===========================================================================
-- Property-level review decisions (CANONICAL_PROMOTION_SPEC.md §3).
-- One decision per property bundle (import_batch_id, source_property_key).
-- ===========================================================================
create table public.import_property_reviews (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references public.import_batches(id) on delete cascade,
  source_property_key text not null,
  decision text not null check (decision in ('approve_create', 'approve_match', 'reject', 'defer')),
  target_hotel_id uuid references public.hotels(id),
  destination_id uuid references public.destinations(id),
  reviewer_user_id uuid references public.users(id),
  reviewer_label text not null,
  review_note text,
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint import_property_reviews_unique unique (import_batch_id, source_property_key),
  -- Invalid decision/target combinations cannot be stored.
  constraint import_property_reviews_decision_shape check (
    (decision = 'approve_create' and target_hotel_id is null and destination_id is not null)
    or (decision = 'approve_match' and target_hotel_id is not null)
    or (decision in ('reject', 'defer') and target_hotel_id is null)
  )
);
create index import_property_reviews_batch_idx
  on public.import_property_reviews (import_batch_id, decision);

create trigger import_property_reviews_set_updated_at
  before update on public.import_property_reviews
  for each row execute function public.set_updated_at();

-- ===========================================================================
-- Child-row (contact/evidence) review overrides (CANONICAL_PROMOTION_SPEC.md §4).
-- ===========================================================================
create table public.import_row_reviews (
  id uuid primary key default gen_random_uuid(),
  import_row_id uuid not null unique references public.import_rows(id) on delete cascade,
  decision text not null check (decision in ('include', 'exclude', 'defer')),
  reviewer_user_id uuid references public.users(id),
  reviewer_label text not null,
  review_note text,
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger import_row_reviews_set_updated_at
  before update on public.import_row_reviews
  for each row execute function public.set_updated_at();

-- ===========================================================================
-- Canonical hotel_contacts adjustments (CANONICAL_PROMOTION_SPEC.md §8, D038/D039).
-- Separate operational lifecycle (status) from research verification confidence
-- (verification_status); preserve the exact researched display name; carry
-- explicit organization identity; expand department taxonomy.
-- ===========================================================================
alter table public.hotel_contacts
  add column display_name text,
  add column verification_status text not null default 'unverified'
    check (verification_status in ('verified', 'probable', 'inferred', 'unverified', 'invalid')),
  add column organization_name text;

-- Expand department to the full canonical research taxonomy.
alter table public.hotel_contacts drop constraint if exists hotel_contacts_department_check;
alter table public.hotel_contacts
  add constraint hotel_contacts_department_check check (
    department is null or department in
      ('marketing', 'pr', 'communications', 'social_media', 'partnerships', 'events',
       'sales', 'reservations', 'general', 'other', 'unknown')
  );

-- ===========================================================================
-- import_row_links idempotency backstop (CANONICAL_PROMOTION_SPEC.md §12).
-- The same source-row → entity link action cannot be duplicated on repeat
-- promotion.
-- ===========================================================================
create unique index import_row_links_unique_action_uidx
  on public.import_row_links (import_row_id, entity_type, entity_id, link_type);

-- ===========================================================================
-- RLS: new review/catalog tables are admin/editor + service_role only.
-- ===========================================================================
alter table public.destination_aliases enable row level security;
alter table public.import_property_reviews enable row level security;
alter table public.import_row_reviews enable row level security;

grant all on
  public.destination_aliases, public.import_property_reviews, public.import_row_reviews
to service_role;

grant select, insert, update, delete on
  public.destination_aliases, public.import_property_reviews, public.import_row_reviews
to authenticated;

create policy destination_aliases_admin on public.destination_aliases
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy import_property_reviews_admin on public.import_property_reviews
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy import_row_reviews_admin on public.import_row_reviews
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
