-- 0027_property_content_infrastructure.sql
--
-- V1 PROPERTY CONTENT INFRASTRUCTURE — provider source runs, durable source
-- identities, source observations, entity-resolution candidates, the D063
-- canonical source-identity link and durable provider review decisions.
--
-- Full model: docs/PROPERTY_CONTENT_IMPLEMENTATION_SPEC.md
-- Governing contract: docs/PROPERTY_CONTENT_COVERAGE_CONTRACT.md (D060–D064)
--
-- Additive only. Migrations 0001–0026 are the reviewed baseline; this file
-- creates six new tables and adds ONE nullable column to editorial_evidence.
-- No existing table is altered, re-typed or dropped, and no canonical hotel row
-- is touched.
--
-- What this migration deliberately does NOT do
-- --------------------------------------------
--   * no ingestion of any provider data;
--   * no promotion, no D062 gate, no Coverage Engine;
--   * no hotel_media and no image rows (D064 storage strategy is open);
--   * no provider column on `hotels` — there is no hotelbeds_id, booking_id or
--     expedia_id anywhere in the canonical schema (D063);
--   * no star value is computed, rounded or averaged anywhere.
--
-- Security: every table here is editorial/operational internals — service_role
-- plus admin/editor through RLS, exactly like the import infrastructure. No
-- anon grant of any kind. Privileges are stated explicitly per D046, because
-- 0024's `alter default privileges` means a new table starts with none.

-- ===========================================================================
-- 1. SOURCE RUNS — one execution of one source, for one destination
-- ===========================================================================
-- Not import_batches: a batch is keyed on a parsed FILE (name, sha256, parser
-- version) and its status vocabulary is parse-shaped. A provider run has no
-- file and no parser, and needs pagination-exhaustion, coverage-risk,
-- provider-total and quota evidence that a file has no analogue for.
create table public.source_runs (
  id uuid primary key default gen_random_uuid(),
  -- Provider namespace, e.g. 'hotelbeds'. Free text on purpose: adding a
  -- provider must not require a migration.
  source text not null,
  -- THE ISOLATION AXIS. Evaluation/test provider data is not production
  -- canonical data and must never become promotable by accident.
  source_environment text not null check (source_environment in ('evaluation', 'production')),
  -- NULL for a run that is not destination-scoped (master data, credential probe).
  destination_id uuid references public.destinations(id),
  -- The provider-native geography actually used, e.g. {"destinationCode":"BAI"}.
  -- Evidence of what was asked for, not configuration for the next run.
  provider_geography jsonb not null default '{}',
  run_mode text not null check (run_mode in ('full', 'incremental', 'evaluation', 'master_data')),
  run_status text not null default 'running'
    check (run_status in ('running', 'completed', 'incomplete', 'failed', 'abandoned')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  raw_records_seen integer not null default 0 check (raw_records_seen >= 0),
  unique_source_property_ids integer not null default 0 check (unique_source_property_ids >= 0),
  -- NULL means the provider supplied no total. Never defaulted to 0: "zero
  -- properties" and "did not say" are different facts.
  provider_reported_total integer check (provider_reported_total is null or provider_reported_total >= 0),
  pagination_walk_completed boolean not null default false,
  extraction_exhaustion_proven boolean not null default false,
  -- Never emptied to make a run look clean.
  coverage_risks text[] not null default '{}',
  request_count integer not null default 0 check (request_count >= 0),
  cache_hit_count integer not null default 0 check (cache_hit_count >= 0),
  harness_version text,
  notes text,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- "Still running" and "finished" cannot be confused.
  constraint source_runs_completion_shape check (
    (run_status = 'running' and completed_at is null)
    or (run_status <> 'running' and completed_at is not null)
  ),
  -- A run cannot claim an exhaustion it never walked.
  constraint source_runs_exhaustion_requires_walk check (
    extraction_exhaustion_proven = false or pagination_walk_completed = true
  )
);

create index source_runs_source_env_started_idx
  on public.source_runs (source, source_environment, started_at desc);
create index source_runs_destination_status_idx
  on public.source_runs (destination_id, run_status);

create trigger source_runs_set_updated_at
  before update on public.source_runs
  for each row execute function public.set_updated_at();

comment on table public.source_runs is
  'One execution of one provider/source. source_environment isolates evaluation from production (D063 infrastructure).';
comment on column public.source_runs.provider_reported_total is
  'NULL means the provider supplied no total. Never defaulted to 0.';
comment on column public.source_runs.extraction_exhaustion_proven is
  'Walk completed AND zero coverage risks. Separate from pagination_walk_completed: they fail for different reasons.';

-- ===========================================================================
-- 2. SOURCE PROPERTY IDENTITIES — durable, run-independent
-- ===========================================================================
-- Not import_rows: an import row is immutable, batch-scoped and dies with its
-- batch. A source identity is mutable (last seen, resolution state) and must
-- OUTLIVE every run that observed it.
--
-- The surrogate `id` is ours. The provider's id is an attribute, never a key
-- into canonical data (D063: a provider ID must never become hotels.id).
create table public.source_property_identities (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  source_environment text not null check (source_environment in ('evaluation', 'production')),
  -- Text, not numeric: Hotelbeds returns a number, another provider may not.
  source_property_id text not null,
  source_url text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  -- RESTRICT: a run is never deleted to hide an extraction, and an identity
  -- must always be able to name the run that first saw it.
  first_seen_run_id uuid not null references public.source_runs(id) on delete restrict,
  last_seen_run_id uuid not null references public.source_runs(id) on delete restrict,
  -- D061 §15.1: every candidate resolves to exactly one of A/B/C, or is still
  -- a hold state. `unresolved` is what keeps a candidate inside the
  -- coverage-critical count.
  resolution_state text not null default 'unresolved'
    check (resolution_state in
      ('unresolved', 'resolved_eligible', 'duplicate_matched', 'final_exclusion')),
  -- D061 §9 vocabulary. NOTE what is absent: 'star_classification_unresolved'
  -- and 'identity_unresolved' are NOT exclusion reasons — they are hold states,
  -- and an identity carrying them stays `unresolved`. "Star unknown" is not the
  -- same fact as "confirmed 3-star", and collapsing them silently deletes
  -- eligible properties.
  resolution_reason text
    check (resolution_reason is null or resolution_reason in
      ('duplicate_merged', 'permanently_closed', 'corporate_group_hq',
       'agency_non_property', 'not_physical_hospitality', 'star_below_v1_scope',
       'outside_destination', 'other_reviewed_exclusion')),
  observation_count integer not null default 0 check (observation_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- A final exclusion without a durable reason is not auditable (D055).
  constraint source_property_identities_exclusion_reason check (
    resolution_state <> 'final_exclusion' or resolution_reason is not null
  ),
  -- THE CORE INVARIANT. Provider id uniqueness is scoped within its namespace
  -- AND environment: Hotelbeds evaluation 12345 and Hotelbeds production 12345
  -- are different identities, and must be, or evaluation data could satisfy a
  -- production precondition.
  constraint source_property_identities_unique_source_id
    unique (source, source_environment, source_property_id)
);

create index source_property_identities_resolution_idx
  on public.source_property_identities (resolution_state);
create index source_property_identities_last_run_idx
  on public.source_property_identities (last_seen_run_id);

create trigger source_property_identities_set_updated_at
  before update on public.source_property_identities
  for each row execute function public.set_updated_at();

comment on table public.source_property_identities is
  'Durable (provider, environment, provider id) identity, independent of any canonical hotel (D063 §11).';
comment on column public.source_property_identities.resolution_state is
  'D061 §15.1 A/B/C plus the hold state. `unresolved` is coverage-critical and is never silently dropped.';

-- ===========================================================================
-- 3. SOURCE PROPERTY OBSERVATIONS — one snapshot per run
-- ===========================================================================
-- Source facts, retained WITHOUT pretending they are canonical truth. One
-- identity accumulates many observations over time; nothing is overwritten, so
-- a future canonical star or coordinate can cite which observation, from which
-- run, at which time supported it (D062 conditions 7 and 10).
create table public.source_property_observations (
  id uuid primary key default gen_random_uuid(),
  -- RESTRICT on both: observations are evidence a canonical value may later
  -- cite. Deleting the run or the identity must not silently delete it.
  source_run_id uuid not null references public.source_runs(id) on delete restrict,
  source_property_identity_id uuid not null
    references public.source_property_identities(id) on delete restrict,
  observed_at timestamptz not null default now(),

  source_name text,
  source_destination_code text,
  source_zone_code text,
  source_address text,
  source_postal_code text,
  source_city text,

  -- DELIBERATELY NO RANGE CHECK. The Bali evaluation returned one out-of-range
  -- coordinate; a constraint would have made that row unstorable and the
  -- ingestion would have had to drop it, null it or crash. All three destroy
  -- evidence. Invalid provider values are evidence to audit, not rows to erase.
  source_latitude numeric,
  source_longitude numeric,
  -- The audit verdict, recorded rather than enforced.
  source_coordinates_plausible boolean,

  source_website_url text,
  source_email text,
  source_phone text,
  -- Carried so a FAXNUMBER is never silently reported as a contact phone.
  source_phone_type text,

  source_brand_code text,
  source_chain_code text,
  source_property_type_code text,
  source_property_type_label text,

  -- PROVIDER CLASSIFICATION EVIDENCE. Never canonical stars.
  source_classification_code text,
  source_classification_label text,
  source_classification_group text,
  -- TEXT, not numeric, on purpose. Hotelbeds `simpleCode` is a number that is
  -- NOT a star rating: simpleCode 5 covers 5EST (5 STARS), 5LL (5 KEYS), APTH5
  -- (aparthotel) and HS5 (hostel). A numeric column invites
  -- `where simple_code >= 4`, which is exactly the query that must never
  -- produce inventory.
  source_classification_simple_code text,
  source_classification_evidence_kind text not null default 'provider_classification_evidence'
    check (source_classification_evidence_kind in
      ('provider_classification_evidence', 'canonical_classification_evidence')),

  -- Only when the provider ACTUALLY supplies one. The Hotelbeds hotels payload
  -- carries no lifecycle field at all, so this stays NULL for it rather than
  -- being invented.
  source_lifecycle_status text,

  -- MEDIA BOUNDARY (D064). Availability summary only — no image rows, no
  -- binaries, no URLs. One Bali property returned 118 images and the
  -- destination totals 137,328; ingesting that before the rights review and
  -- storage strategy are settled would be a permanent cost for data no query
  -- needs yet. hotel_media plugs in later against this table's id.
  source_image_count integer check (source_image_count is null or source_image_count >= 0),
  source_provider_designated_principal_image boolean,

  -- Bounded overflow for provider fields not yet modelled. Guarded by a
  -- trigger (§8 below) — this is not a dumping ground for payloads.
  source_attributes jsonb not null default '{}',

  -- RAW PAYLOAD BOUNDARY. The full provider record is NOT stored in Postgres.
  -- The digest answers "did this property change between runs?" without it.
  source_payload_digest text,
  -- Opaque locator for an off-database raw artifact. NO object-storage product
  -- is chosen by this migration and none is required: every constraint, index
  -- and query here works with this column NULL.
  source_payload_uri text,

  created_at timestamptz not null default now(),

  -- IDEMPOTENCY: one run observes one source property at most once. Re-running
  -- an extraction creates a NEW run, so history accumulates instead of being
  -- overwritten.
  constraint source_property_observations_unique_per_run
    unique (source_run_id, source_property_identity_id)
);

create index source_property_observations_identity_time_idx
  on public.source_property_observations (source_property_identity_id, observed_at desc);
create index source_property_observations_run_idx
  on public.source_property_observations (source_run_id);

comment on table public.source_property_observations is
  'One source snapshot per (run, identity). Source facts are observations, never canonical truth (D063 §13).';
comment on column public.source_property_observations.source_latitude is
  'Source observation. No range constraint: invalid provider coordinates are evidence to audit, not rows to erase. hotels.latitude remains the resolved canonical value.';
comment on column public.source_property_observations.source_classification_simple_code is
  'TEXT deliberately. simpleCode is not a star rating — 5 covers 5 STARS, 5 KEYS, aparthotel and hostel alike.';
comment on column public.source_property_observations.source_payload_uri is
  'Opaque locator for an off-database raw artifact. No storage product is chosen; the relational layer does not depend on one.';

-- ===========================================================================
-- 4. SOURCE MATCH CANDIDATES — evidence, not scores
-- ===========================================================================
-- Not import_match_candidates: that table FKs a NOT NULL import_row_id and
-- requires a NOT NULL `score numeric`. D063 §12.2 refuses to invent a universal
-- match-confidence number, so reusing it would mean either a fake score or a
-- schema change to a working, reviewed table.
create table public.source_match_candidates (
  id uuid primary key default gen_random_uuid(),
  source_property_identity_id uuid not null
    references public.source_property_identities(id) on delete cascade,
  source_run_id uuid references public.source_runs(id) on delete set null,
  -- NULL candidate = an explicit NEW PROPERTY assertion: we looked and found no
  -- canonical counterpart. That is a finding, not an absence of one.
  candidate_hotel_id uuid references public.hotels(id) on delete cascade,

  -- ONE dimension with two strengths. `exact` implies token containment by
  -- construction, so counting them separately would score one name agreement
  -- twice and manufacture a multi-signal match out of nothing.
  name_evidence text not null default 'none'
    check (name_evidence in ('exact', 'token_containment', 'none')),
  -- `unavailable` is NOT `differs`. "Neither side supplied an address" is not
  -- evidence against a match; collapsing them turns missing data into a
  -- negative finding.
  domain_evidence text not null default 'unavailable'
    check (domain_evidence in ('agrees', 'differs', 'unavailable')),
  address_evidence text not null default 'unavailable'
    check (address_evidence in ('agrees', 'differs', 'unavailable')),
  phone_evidence text not null default 'unavailable'
    check (phone_evidence in ('agrees', 'differs', 'unavailable')),
  brand_evidence text not null default 'unavailable'
    check (brand_evidence in ('agrees', 'differs', 'unavailable')),
  -- Raw distance. NO threshold is stored anywhere: a number written here would
  -- later read as a decision nobody made (D063 §12.2).
  coordinate_distance_metres numeric,
  known_source_mapping boolean not null default false,
  -- Count of INDEPENDENT dimensions in agreement. A name alone is 1, whatever
  -- its strength — which is why a name alone can never auto-merge.
  agreeing_dimensions integer not null default 0
    check (agreeing_dimensions >= 0 and agreeing_dimensions <= 6),
  match_method text not null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'rejected', 'superseded')),
  review_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index source_match_candidates_identity_status_idx
  on public.source_match_candidates (source_property_identity_id, status);
create index source_match_candidates_hotel_idx
  on public.source_match_candidates (candidate_hotel_id);

comment on table public.source_match_candidates is
  'Entity-resolution evidence matrix. No confidence score and no threshold — D063 §12.2. A false merge is worse than a temporary duplicate.';

-- ===========================================================================
-- 5. HOTEL SOURCE IDENTITIES — the D063 canonical link
-- ===========================================================================
-- The table PROPERTY_CONTENT_COVERAGE_CONTRACT §11.1 names. Answers "which
-- provider property corresponds to this canonical hotel?" without any provider
-- column ever appearing on `hotels`.
create table public.hotel_source_identities (
  id uuid primary key default gen_random_uuid(),
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  -- RESTRICT: the canonical link outlives casual cleanup of source data.
  source_property_identity_id uuid not null
    references public.source_property_identities(id) on delete restrict,
  -- Denormalised so the link stays auditable even if a provider is dropped, and
  -- so the environment check below can be enforced on this row.
  source text not null,
  source_environment text not null,
  source_property_id text not null,
  link_status text not null default 'active'
    check (link_status in ('active', 'superseded', 'rejected')),
  match_method text not null,
  -- The evidence matrix as it stood at decision time.
  match_evidence jsonb not null default '{}',
  linked_by_user_id uuid references public.users(id),
  linked_at timestamptz not null default now(),
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- EVALUATION DATA CAN NEVER BECOME CANONICAL EVIDENCE. Not by a bug, not by
  -- a careless script, not by a reviewer. The Hotelbeds test environment is not
  -- production canonical data, and this is the constraint that makes
  -- "must never be accidentally promotable" true rather than aspirational.
  constraint hotel_source_identities_production_only
    check (source_environment = 'production')
);

-- One ACTIVE source identity maps to AT MOST ONE canonical hotel. Partial on
-- `active` so a superseded link is retained as history rather than deleted.
-- A canonical hotel may hold many source identities — no constraint prevents
-- that, by design (D063).
create unique index hotel_source_identities_active_identity_uidx
  on public.hotel_source_identities (source_property_identity_id)
  where link_status = 'active';

create index hotel_source_identities_hotel_idx
  on public.hotel_source_identities (hotel_id, link_status);
create index hotel_source_identities_source_lookup_idx
  on public.hotel_source_identities (source, source_environment, source_property_id);

create trigger hotel_source_identities_set_updated_at
  before update on public.hotel_source_identities
  for each row execute function public.set_updated_at();

comment on table public.hotel_source_identities is
  'D063 §11.1. Canonical hotel <-> provider source identity. Production-only by CHECK; one active identity maps to at most one hotel.';

-- ===========================================================================
-- 6. SOURCE PROPERTY REVIEWS — a decision that survives the next run
-- ===========================================================================
-- Not import_property_reviews: that is keyed on (import_batch_id,
-- source_property_key) and its decision dies with the batch. A provider
-- decision must survive re-execution, because re-execution is normal.
--
-- The decision VOCABULARY is deliberately identical, because both pipelines
-- converge on the same D062 promotion gate.
create table public.source_property_reviews (
  id uuid primary key default gen_random_uuid(),
  source_property_identity_id uuid not null unique
    references public.source_property_identities(id) on delete cascade,
  decision text not null
    check (decision in ('approve_create', 'approve_match', 'reject', 'defer')),
  target_hotel_id uuid references public.hotels(id),
  destination_id uuid references public.destinations(id),
  reviewer_user_id uuid references public.users(id),
  reviewer_label text not null,
  review_note text,
  -- Which run's evidence the decision was made against.
  decided_in_run_id uuid references public.source_runs(id) on delete set null,
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Same shape rule as import_property_reviews: invalid decision/target
  -- combinations cannot be stored.
  constraint source_property_reviews_decision_shape check (
    (decision = 'approve_create' and target_hotel_id is null and destination_id is not null)
    or (decision = 'approve_match' and target_hotel_id is not null)
    or (decision in ('reject', 'defer') and target_hotel_id is null)
  )
);

create index source_property_reviews_decision_idx
  on public.source_property_reviews (decision);

create trigger source_property_reviews_set_updated_at
  before update on public.source_property_reviews
  for each row execute function public.set_updated_at();

comment on table public.source_property_reviews is
  'Durable per-identity review decision. Same vocabulary as import_property_reviews; both converge on the D062 gate.';

-- ===========================================================================
-- 7. EDITORIAL EVIDENCE — one additive column
-- ===========================================================================
-- The provenance sink both pipelines share, so a provider claim and a file
-- research claim are auditable in one place. import_batch_id / import_row_id
-- are untouched.
alter table public.editorial_evidence
  add column source_run_id uuid references public.source_runs(id) on delete set null;

create index editorial_evidence_source_run_idx on public.editorial_evidence (source_run_id);

-- ===========================================================================
-- 8. RAW-PAYLOAD BOUNDARY GUARD
-- ===========================================================================
-- `source_attributes` exists for provider fields not yet modelled. It is NOT
-- for whole payloads, and specifically not for image arrays. A trigger enforces
-- that, because a documented rule with no mechanism is a rule that gets broken
-- by the first convenient ingestion script.
create or replace function public.enforce_source_attributes_bound()
returns trigger
language plpgsql
as $$
declare
  attr_size integer;
begin
  attr_size := octet_length(new.source_attributes::text);
  if attr_size > 8192 then
    raise exception
      'source_attributes is % bytes, over the 8192-byte bound. Whole provider payloads (and image arrays especially) do not belong in Postgres — use source_payload_digest plus an off-database artifact. See docs/PROPERTY_CONTENT_IMPLEMENTATION_SPEC.md §19.',
      attr_size
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_source_attributes_bound() from public;

create trigger source_property_observations_bound_attributes
  before insert or update on public.source_property_observations
  for each row execute function public.enforce_source_attributes_bound();

-- ===========================================================================
-- 9. RLS — admin/editor + service_role, exactly like the import infrastructure
-- ===========================================================================
alter table public.source_runs enable row level security;
alter table public.source_property_identities enable row level security;
alter table public.source_property_observations enable row level security;
alter table public.source_match_candidates enable row level security;
alter table public.hotel_source_identities enable row level security;
alter table public.source_property_reviews enable row level security;

create policy source_runs_admin on public.source_runs
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy source_property_identities_admin on public.source_property_identities
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy source_property_observations_admin on public.source_property_observations
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy source_match_candidates_admin on public.source_match_candidates
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy hotel_source_identities_admin on public.hotel_source_identities
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy source_property_reviews_admin on public.source_property_reviews
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());

-- ===========================================================================
-- 10. PRIVILEGES — stated, not inherited (D046)
-- ===========================================================================
-- 0024 revoked client privileges on FUTURE objects via `alter default
-- privileges`, so these tables start with none. The grants below are the entire
-- client surface, and there is deliberately NO anon grant: these tables are
-- editorial/operational internals and must not be publicly enumerable.
--
-- `authenticated` receives a capability grant only. Every policy above gates on
-- is_admin_or_editor(), so a regular creator holding these privileges reads
-- zero rows and writes none.
grant select, insert, update, delete on
  public.source_runs,
  public.source_property_identities,
  public.source_property_observations,
  public.source_match_candidates,
  public.hotel_source_identities,
  public.source_property_reviews
to authenticated;

grant all privileges on
  public.source_runs,
  public.source_property_identities,
  public.source_property_observations,
  public.source_match_candidates,
  public.hotel_source_identities,
  public.source_property_reviews
to service_role;
