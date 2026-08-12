-- 0014_import_and_organizations.sql
-- Sprint 1A: seed-import provenance pipeline + minimal organization model
-- (IMPORT_SPEC.md §3–§5, HOTEL_DATA_CONTRACT.md, DECISIONS D025–D032).
--
-- Migrations 0001–0013 are the frozen reviewed baseline; this is additive.
--
-- ALL tables here are import/provenance/editorial internals: admin/editor +
-- service_role only. No anon grant; no creator (regular authenticated) access —
-- RLS gates every table to is_admin_or_editor(). Reproducible from an empty DB.

-- ===========================================================================
-- Organizations (minimal). Hotel groups / operators / management companies /
-- PR agencies are NOT fake hotel rows (HOTEL_DATA_CONTRACT §8, D029). Brands
-- remain a separate concept (IMPORT_SPEC §5) — this does not replace brands.
-- ===========================================================================
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  normalized_name text not null,
  org_type text not null check (org_type in
    ('hotel_group', 'operator', 'management_company', 'pr_agency', 'sales_rep', 'other')),
  website_url text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index organizations_normalized_name_idx on public.organizations (normalized_name);
create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();

create table public.hotel_organizations (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  relationship text not null check (relationship in
    ('operated_by', 'managed_by', 'represented_by', 'owned_by', 'corporate_group', 'other')),
  created_at timestamptz not null default now(),
  constraint hotel_organizations_unique unique (hotel_id, organization_id, relationship)
);
create index hotel_organizations_hotel_idx on public.hotel_organizations (hotel_id);
create index hotel_organizations_org_idx on public.hotel_organizations (organization_id);

-- Corporate/agency contacts whose scope is broader than one property.
create table public.organization_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  contact_name text,
  job_title text,
  department text check (department is null or department in
    ('marketing', 'pr', 'communications', 'social_media', 'partnerships', 'events',
     'sales', 'reservations', 'general', 'other', 'unknown')),
  email text,
  phone text,
  linkedin_url text,
  contact_scope text check (contact_scope is null or contact_scope in
    ('property', 'brand', 'group', 'operator', 'agency', 'unknown')),
  verification_status text not null default 'unverified' check (verification_status in
    ('verified', 'probable', 'inferred', 'unverified', 'invalid')),
  source_url text,
  verified_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index organization_contacts_org_idx on public.organization_contacts (organization_id);
create trigger organization_contacts_set_updated_at
  before update on public.organization_contacts
  for each row execute function public.set_updated_at();

-- ===========================================================================
-- Import infrastructure (IMPORT_SPEC §3). RAW -> STAGING -> REVIEW lineage.
-- ===========================================================================
create table public.import_batches (
  id uuid primary key default gen_random_uuid(),
  source_name text not null,
  source_file_name text,
  source_kind text not null check (source_kind in ('canonical', 'legacy')),
  parser_name text not null,
  parser_version text not null,
  file_sha256 text,
  status text not null default 'pending' check (status in
    ('pending', 'parsing', 'parsed', 'review_required', 'failed', 'approved', 'promoted')),
  total_rows integer not null default 0,
  valid_rows integer not null default 0,
  warning_rows integer not null default 0,
  review_rows integer not null default 0,
  rejected_rows integer not null default 0,
  created_by uuid references public.users(id),
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- Repeat-import lookup (idempotency is enforced in the importer, which refuses
-- to re-stage an existing non-failed batch for the same file+parser version).
create index import_batches_sha_idx on public.import_batches (file_sha256, parser_version);
create index import_batches_status_idx on public.import_batches (status, created_at);
create trigger import_batches_set_updated_at
  before update on public.import_batches
  for each row execute function public.set_updated_at();

-- Immutable raw + normalized lineage, one row per source row.
create table public.import_rows (
  id uuid primary key default gen_random_uuid(),
  import_batch_id uuid not null references public.import_batches(id) on delete cascade,
  sheet_name text,
  source_row_number integer,
  row_kind text not null check (row_kind in ('property', 'contact', 'evidence')),
  -- Grouping key used to attach contacts/evidence to a property within a batch.
  source_property_key text,
  raw_data jsonb not null default '{}',
  raw_fingerprint text not null,
  normalized_data jsonb,
  validation_status text not null check (validation_status in
    ('valid', 'warning', 'review', 'rejected')),
  validation_errors text[] not null default '{}',
  validation_warnings text[] not null default '{}',
  created_at timestamptz not null default now(),
  constraint import_rows_unique_source unique (import_batch_id, sheet_name, source_row_number)
);
create index import_rows_batch_kind_idx on public.import_rows (import_batch_id, row_kind);
create index import_rows_batch_propkey_idx on public.import_rows (import_batch_id, source_property_key);
create index import_rows_fingerprint_idx on public.import_rows (raw_fingerprint);
create index import_rows_status_idx on public.import_rows (import_batch_id, validation_status);

-- Explainable entity-resolution candidates (IMPORT_SPEC §7).
create table public.import_match_candidates (
  id uuid primary key default gen_random_uuid(),
  import_row_id uuid not null references public.import_rows(id) on delete cascade,
  candidate_entity_type text not null check (candidate_entity_type in
    ('hotel', 'destination', 'organization', 'hotel_contact', 'brand')),
  candidate_entity_id uuid,
  score numeric not null,
  -- Human/machine readable method, e.g. 'exact_name_plus_destination',
  -- 'fuzzy_name', 'source_property_id', 'canonical_url'. Reports explain matches.
  match_method text not null,
  status text not null default 'pending' check (status in
    ('pending', 'accepted', 'rejected', 'superseded')),
  review_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create index import_match_candidates_row_idx on public.import_match_candidates (import_row_id);
create index import_match_candidates_entity_idx
  on public.import_match_candidates (candidate_entity_type, candidate_entity_id);

-- Links a raw row to canonical entities after review/promotion (empty in 1A).
create table public.import_row_links (
  id uuid primary key default gen_random_uuid(),
  import_row_id uuid not null references public.import_rows(id) on delete cascade,
  entity_type text not null,
  entity_id uuid not null,
  link_type text not null check (link_type in
    ('created', 'matched', 'updated', 'evidence_for', 'split_into')),
  created_at timestamptz not null default now()
);
create index import_row_links_row_idx on public.import_row_links (import_row_id);
create index import_row_links_entity_idx on public.import_row_links (entity_type, entity_id);

-- ===========================================================================
-- editorial_evidence (IMPORT_SPEC §4, HOTEL_DATA_CONTRACT §6/§7, D027).
-- Editorial provenance ONLY. Never feeds creator outcome metrics. subject_id is
-- nullable during staging (before canonical promotion).
-- ===========================================================================
create table public.editorial_evidence (
  id uuid primary key default gen_random_uuid(),
  subject_type text check (subject_type is null or subject_type in
    ('hotel', 'hotel_contact', 'organization', 'property_candidate', 'contact_candidate')),
  subject_id uuid,
  import_batch_id uuid references public.import_batches(id) on delete set null,
  import_row_id uuid references public.import_rows(id) on delete set null,
  claim_type text not null check (claim_type in
    ('property_exists', 'contact_confirmation', 'brand_relationship', 'operator_relationship',
     'agency_representation', 'creator_collaboration_evidence', 'other')),
  source_type text not null check (source_type in
    ('official_website', 'official_social', 'official_media_kit', 'official_privacy_policy',
     'authorized_representative', 'public_registry', 'reputable_third_party',
     'research_compilation', 'unknown')),
  source_url text,
  verification_status text not null default 'unverified' check (verification_status in
    ('verified', 'probable', 'inferred', 'unverified', 'invalid')),
  observed_at timestamptz,
  verified_at timestamptz,
  notes text,
  created_at timestamptz not null default now()
);
create index editorial_evidence_subject_idx on public.editorial_evidence (subject_type, subject_id);
create index editorial_evidence_batch_idx on public.editorial_evidence (import_batch_id);
create index editorial_evidence_claim_idx on public.editorial_evidence (claim_type);

comment on table public.editorial_evidence is
  'Editorial provenance for research claims. NEVER feeds creator outcome metrics (D027).';

-- ===========================================================================
-- RLS: everything here is admin/editor + service_role only.
-- ===========================================================================
alter table public.organizations enable row level security;
alter table public.hotel_organizations enable row level security;
alter table public.organization_contacts enable row level security;
alter table public.import_batches enable row level security;
alter table public.import_rows enable row level security;
alter table public.import_match_candidates enable row level security;
alter table public.import_row_links enable row level security;
alter table public.editorial_evidence enable row level security;

-- service_role bypasses RLS but still needs table privileges.
grant all on
  public.organizations, public.hotel_organizations, public.organization_contacts,
  public.import_batches, public.import_rows, public.import_match_candidates,
  public.import_row_links, public.editorial_evidence
to service_role;

-- authenticated is granted table privileges but RLS restricts to admin/editor.
-- No anon grant at all.
grant select, insert, update, delete on
  public.organizations, public.hotel_organizations, public.organization_contacts,
  public.import_batches, public.import_rows, public.import_match_candidates,
  public.import_row_links, public.editorial_evidence
to authenticated;

-- One admin/editor-only policy per table (all operations).
create policy organizations_admin on public.organizations
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy hotel_organizations_admin on public.hotel_organizations
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy organization_contacts_admin on public.organization_contacts
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy import_batches_admin on public.import_batches
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy import_rows_admin on public.import_rows
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy import_match_candidates_admin on public.import_match_candidates
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy import_row_links_admin on public.import_row_links
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy editorial_evidence_admin on public.editorial_evidence
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
