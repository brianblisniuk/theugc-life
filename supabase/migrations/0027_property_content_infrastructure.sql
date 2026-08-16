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
  -- ENUMERATION exhaustion only: did we read every record the provider offers
  -- for this geography? Deliberately NOT a judgement about whether the
  -- destination's coverage is settled — those are different dimensions, and
  -- conflating them makes a correctly exhausted provider walk report false
  -- because an unrelated question (star authority, second source) is open.
  provider_enumeration_exhaustion_proven boolean not null default false,
  -- Risks that make the ENUMERATION itself unprovable: a cursor loop, a
  -- provider total that disagrees with the rows returned, a budget stop. These
  -- block enumeration exhaustion.
  enumeration_risks text[] not null default '{}',
  -- Risks about what the enumerated set MEANS: geography mapping caveats,
  -- unresolved classification authority, pending second source. These are
  -- recorded, never emptied to make a run look clean, and deliberately do NOT
  -- falsify a walk that genuinely completed.
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
  -- A run cannot claim an exhaustion it never walked, and cannot claim one
  -- while a risk to the enumeration itself is recorded.
  constraint source_runs_exhaustion_requires_walk check (
    provider_enumeration_exhaustion_proven = false
    or (pagination_walk_completed = true and cardinality(enumeration_risks) = 0)
  ),
  -- Composite key so identities and observations can be FK'd to a run's source
  -- AND environment, not merely to its id (see below).
  constraint source_runs_identity_uk unique (id, source, source_environment)
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
comment on column public.source_runs.provider_enumeration_exhaustion_proven is
  'ENUMERATION exhaustion only: walk completed and zero enumeration_risks. A non-enumeration coverage risk does NOT falsify it — those are different dimensions.';
comment on column public.source_runs.enumeration_risks is
  'Risks to the enumeration itself (cursor loop, total mismatch, budget stop). These block enumeration exhaustion.';
comment on column public.source_runs.coverage_risks is
  'Risks about what the enumerated set MEANS (geography caveats, open authority, pending second source). Recorded, never emptied, and never falsify a completed walk.';

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
  --
  -- These are COMPOSITE foreign keys, not plain id references. A plain FK would
  -- let a Hotelbeds-evaluation identity name a Nuitee-production run as the one
  -- that saw it: both rows exist, so both FKs pass, and the provenance is
  -- silently wrong. Including source and environment in the key makes the
  -- mismatch unrepresentable.
  first_seen_run_id uuid not null,
  last_seen_run_id uuid not null,
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
  -- Durable answer to "matched to WHAT?" for resolution_state='duplicate_matched'.
  --
  -- A CANONICAL HOTEL, and only a canonical hotel. D061 §15.1 B is literally
  -- "duplicate/matched to an existing canonical property", and letting a source
  -- identity be the terminal target would let coverage close on a cycle:
  -- A matched-to B while B is matched-to A leaves neither `unresolved` and no
  -- published property anywhere. Source-to-source equivalence is real and is
  -- retained — as *pre-publication evidence* in source_match_candidates (§4),
  -- which is a candidate record, not a terminal state.
  matched_hotel_id uuid references public.hotels(id) on delete restrict,
  -- Set by a future promotion apply step. The identity does not own the hotel;
  -- it records which canonical row its own resolution produced. Deliberately NO
  -- direct FK to hotels: the composite FK added after hotel_source_identities
  -- exists (§5) is stronger, and requiring both would be duplicate truth.
  promoted_hotel_id uuid,
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
    unique (source, source_environment, source_property_id),

  -- Composite keys so observations and the canonical link can reference this
  -- identity's source/environment/provider-id, not merely its surrogate id.
  constraint source_property_identities_env_uk unique (id, source, source_environment),
  constraint source_property_identities_full_uk
    unique (id, source, source_environment, source_property_id),

  -- A run that saw this identity must be a run of the SAME source and the SAME
  -- environment. Declarative, so no ingestion bug can cross the streams.
  constraint source_property_identities_first_run_fk
    foreign key (first_seen_run_id, source, source_environment)
    references public.source_runs (id, source, source_environment) on delete restrict,
  constraint source_property_identities_last_run_fk
    foreign key (last_seen_run_id, source, source_environment)
    references public.source_runs (id, source, source_environment) on delete restrict,

  -- "MATCHED TO WHAT?" must always have an answer, and the answer must be a
  -- CANONICAL property — see the column comment above for why another source
  -- identity is not an acceptable terminal target.
  constraint source_property_identities_duplicate_target check (
    resolution_state <> 'duplicate_matched' or matched_hotel_id is not null
  ),
  -- A match target only means something for a matched identity.
  constraint source_property_identities_match_target_scope check (
    resolution_state = 'duplicate_matched' or matched_hotel_id is null
  ),

  -- D061 §15.1 A is "CANONICAL ELIGIBLE V1 PROPERTY", and under D062 a
  -- canonical property IS a published row in `hotels`. So `resolved_eligible`
  -- cannot mean "looks eligible": it requires the promotion to have actually
  -- happened. Without this, a script could set the label directly and a future
  -- Coverage Engine closure count would read zero unresolved while nothing had
  -- been published.
  --
  -- Naming *some* hotel is not enough either — see the composite FK added in
  -- §5, which requires the named hotel to be THIS identity's own canonical link.
  constraint source_property_identities_eligible_requires_promotion check (
    resolution_state <> 'resolved_eligible' or promoted_hotel_id is not null
  ),
  -- ...and evaluation data can never be eligible, for the same reason it can
  -- never be linked (§5 below).
  constraint source_property_identities_eligible_is_production check (
    resolution_state <> 'resolved_eligible' or source_environment = 'production'
  )
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
  source_run_id uuid not null,
  source_property_identity_id uuid not null,
  -- Denormalised so BOTH parents can be composite-FK'd on them. Without this a
  -- production run could carry an observation of an evaluation identity: each
  -- row exists, each plain FK passes, and the environment of the evidence is
  -- quietly lost.
  source text not null,
  source_environment text not null check (source_environment in ('evaluation', 'production')),
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
  -- SOURCE EVIDENCE, ALWAYS. The single permitted value is deliberate: no
  -- issuing-authority hierarchy exists yet and no registry says which source
  -- may speak canonically, so allowing 'canonical_classification_evidence' here
  -- would let any ingestion script promote its own provider to star authority
  -- and Postgres would accept it.
  --
  -- The judgement "this observation is sufficient canonical star provenance"
  -- belongs to the future star-resolution layer, together with the issuing
  -- authority, the resolved value, the conflict state and who resolved it.
  -- Widening this CHECK is a product decision, not an ingestion convenience.
  source_classification_evidence_kind text not null default 'provider_classification_evidence'
    check (source_classification_evidence_kind = 'provider_classification_evidence'),

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
    unique (source_run_id, source_property_identity_id),

  -- PROVENANCE ALIGNMENT. The run and the identity must agree on source AND
  -- environment, enforced declaratively rather than by convention.
  constraint source_property_observations_run_fk
    foreign key (source_run_id, source, source_environment)
    references public.source_runs (id, source, source_environment) on delete restrict,
  constraint source_property_observations_identity_fk
    foreign key (source_property_identity_id, source, source_environment)
    references public.source_property_identities (id, source, source_environment) on delete restrict
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
  source_property_identity_id uuid not null,
  -- NULL when the candidate was not produced by a run (a reviewer's own
  -- finding). When present it is PROVENANCE, so it must be true: the composite
  -- FK below requires the run to be the same provider in the same environment
  -- as the identity. RESTRICT rather than SET NULL because a run is never
  -- deleted anyway (observations already hold it), and because SET NULL on a
  -- composite key would try to null the NOT NULL source columns with it.
  source_run_id uuid,
  -- Denormalised so both parents can be keyed on them, exactly as for
  -- observations (§3).
  source text not null,
  source_environment text not null check (source_environment in ('evaluation', 'production')),
  -- WHAT this candidate points at. Explicit rather than inferred from which
  -- column is NULL, because the coverage universe is multi-source: Hotelbeds
  -- H123 and Nuitee N456 may be the same physical hotel long before either is
  -- published, and requiring one to be promoted first to de-duplicate the other
  -- is exactly the coupling a source-agnostic architecture exists to avoid.
  candidate_kind text not null default 'new_property'
    check (candidate_kind in ('canonical_hotel', 'source_identity', 'new_property')),
  candidate_hotel_id uuid references public.hotels(id) on delete cascade,
  candidate_source_property_identity_id uuid
    references public.source_property_identities(id) on delete cascade,

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
  -- its strength.
  --
  -- This SUMMARISES evidence; it does not decide a match. There is deliberately
  -- no `agreeing_dimensions >= n` constraint anywhere: D063 §12.2 refuses a
  -- universal entity-resolution threshold, and an integer floor would be one.
  -- A single authoritative known_source_mapping can be worth more than three
  -- circumstantial agreements, so the future resolution/review layer weighs the
  -- evidence — the count only saves it from recomputing it.
  --
  -- GENERATED, not writer-supplied. Stored alongside the evidence it summarises,
  -- a hand-written count is duplicate truth: nothing stopped a row claiming
  -- `name=exact, domain=agrees, address=agrees, agreeing_dimensions=0`, and the
  -- two would drift the first time a caller updated one and forgot the other.
  --
  -- coordinate_distance_metres is deliberately NOT counted: there is no approved
  -- distance threshold, and counting it would be inventing one here (D063 §12.2).
  -- The 0..6 bound is now structural rather than a CHECK.
  agreeing_dimensions integer not null generated always as (
    (case when name_evidence <> 'none' then 1 else 0 end)
    + (case when domain_evidence = 'agrees' then 1 else 0 end)
    + (case when address_evidence = 'agrees' then 1 else 0 end)
    + (case when phone_evidence = 'agrees' then 1 else 0 end)
    + (case when brand_evidence = 'agrees' then 1 else 0 end)
    + (case when known_source_mapping then 1 else 0 end)
  ) stored,
  match_method text not null,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'rejected', 'superseded')),
  review_note text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz,

  -- Exactly one target for each kind; NULL is never overloaded.
  constraint source_match_candidates_target_shape check (
    (candidate_kind = 'canonical_hotel'
       and candidate_hotel_id is not null and candidate_source_property_identity_id is null)
    or (candidate_kind = 'source_identity'
       and candidate_source_property_identity_id is not null and candidate_hotel_id is null)
    or (candidate_kind = 'new_property'
       and candidate_hotel_id is null and candidate_source_property_identity_id is null)
  ),
  -- A source identity is never a candidate match for itself.
  constraint source_match_candidates_no_self_match check (
    candidate_source_property_identity_id is null
    or candidate_source_property_identity_id <> source_property_identity_id
  ),

  -- PROVENANCE ALIGNMENT, same rule as observations: the identity this
  -- candidate is about, and the run that generated it, must be the same
  -- provider in the same environment. Otherwise a Hotelbeds identity could
  -- claim its candidate was produced by an unrelated Nuitee run and the
  -- reference would be worse than absent.
  constraint source_match_candidates_identity_fk
    foreign key (source_property_identity_id, source, source_environment)
    references public.source_property_identities (id, source, source_environment)
    on delete cascade,
  constraint source_match_candidates_run_fk
    foreign key (source_run_id, source, source_environment)
    references public.source_runs (id, source, source_environment) on delete restrict
);

create index source_match_candidates_source_identity_target_idx
  on public.source_match_candidates (candidate_source_property_identity_id);
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
  source_property_identity_id uuid not null,
  -- Denormalised so the link stays auditable even if a provider is dropped —
  -- and, critically, CONSTRAINED to equal the referenced identity's own values
  -- by the composite FK below.
  --
  -- Without that composite key the production-only CHECK is decorative: a row
  -- could point at an EVALUATION identity while labelling itself
  -- 'production', the CHECK would read the label, pass, and test-environment
  -- data would sit against a canonical hotel. The label must be the identity's
  -- own, not the writer's assertion about it.
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
  -- The denormalised source/environment/provider-id MUST be the referenced
  -- identity's own. Combined with the CHECK below, an evaluation identity
  -- becomes UNLINKABLE rather than merely detectable after the fact.
  constraint hotel_source_identities_identity_fk
    foreign key (source_property_identity_id, source, source_environment, source_property_id)
    references public.source_property_identities (id, source, source_environment, source_property_id)
    on delete restrict,
  -- EVALUATION DATA CAN NEVER BECOME CANONICAL EVIDENCE. Not by a bug, not by
  -- a careless script, not by a reviewer. The Hotelbeds test environment is not
  -- production canonical data, and the composite FK above is what makes this
  -- CHECK true of the IDENTITY rather than merely of this row's label.
  constraint hotel_source_identities_production_only
    check (source_environment = 'production'),
  -- One row per (identity, hotel) pair. Redundant against the partial unique
  -- index below for the ACTIVE case, and present so an identity's
  -- `promoted_hotel_id` can foreign-key THIS PAIR (see below) rather than merely
  -- naming some row in `hotels`.
  --
  -- The cost is deliberate and small: re-linking an identity to a hotel it was
  -- previously linked to reactivates the existing row instead of inserting a
  -- second one. Linking it to a DIFFERENT hotel is unaffected, so the history
  -- that matters — which hotel this identity used to point at — is retained.
  constraint hotel_source_identities_identity_hotel_uk
    unique (source_property_identity_id, hotel_id)
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

-- ---------------------------------------------------------------------------
-- PROMOTION IS THIS IDENTITY'S OWN PROMOTION
-- ---------------------------------------------------------------------------
-- Added here rather than inline above, because the two tables reference each
-- other and this one is created second.
--
-- `resolved_eligible` already required `promoted_hotel_id`. That was still too
-- weak: ANY existing hotel id satisfied it, so the state proved only that some
-- canonical property existed somewhere — not that THIS identity produced it.
-- Keying the pair against the canonical link makes the two facts the same fact.
--
-- MATCH SIMPLE (the default) means the constraint is satisfied whenever
-- promoted_hotel_id is NULL, so an unresolved identity is unaffected. This does
-- NOT recreate the pre-publication cycle the spec removed: nothing here is
-- required *before* the gate. The expected apply transaction is
--   create hotel -> create link -> set promoted_hotel_id -> commit,
-- which publishes atomically and therefore introduces no draft tier.
alter table public.source_property_identities
  add constraint source_property_identities_promotion_link_fk
  foreign key (id, promoted_hotel_id)
  references public.hotel_source_identities (source_property_identity_id, hotel_id)
  on delete restrict;

-- The FK proves the link EXISTS, for any identity naming a promoted hotel at
-- all. This trigger proves the link is the LIVE one: a rejected or superseded
-- link says "this identity does not correspond to that hotel", which would make
-- `resolved_eligible` a lie again. Enforced in both directions — setting the
-- state, and later demoting the link out from under it.
--
-- It deliberately stays quiet when a CHECK already says something more precise
-- (no promoted hotel at all; an evaluation identity, which can never hold a link
-- in the first place), so each mechanism reports the failure it actually owns.
create or replace function public.enforce_eligible_requires_active_link()
returns trigger
language plpgsql
as $$
begin
  if new.resolution_state = 'resolved_eligible'
     and new.source_environment = 'production'
     and new.promoted_hotel_id is not null
     and not exists (
    select 1 from public.hotel_source_identities hsi
    where hsi.source_property_identity_id = new.id
      and hsi.hotel_id = new.promoted_hotel_id
      and hsi.link_status = 'active'
  ) then
    raise exception
      'source identity % cannot be resolved_eligible: it has no ACTIVE canonical link to hotel %. D061 §15.1 A means a published canonical property produced by THIS identity, not any existing hotel row. See docs/PROPERTY_CONTENT_IMPLEMENTATION_SPEC.md §8.1.',
      new.id, new.promoted_hotel_id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.enforce_eligible_requires_active_link() from public;

create trigger source_property_identities_eligible_needs_active_link
  before insert or update on public.source_property_identities
  for each row execute function public.enforce_eligible_requires_active_link();

create or replace function public.forbid_demoting_promoted_link()
returns trigger
language plpgsql
as $$
begin
  if old.link_status = 'active' and new.link_status <> 'active' and exists (
    select 1 from public.source_property_identities spi
    where spi.id = old.source_property_identity_id
      and spi.promoted_hotel_id = old.hotel_id
      and spi.resolution_state = 'resolved_eligible'
  ) then
    raise exception
      'canonical link for source identity % cannot leave `active` while that identity is resolved_eligible against hotel %. Resolve the identity first; otherwise a coverage closure count would keep counting a property whose canonical link has been withdrawn.',
      old.source_property_identity_id, old.hotel_id
      using errcode = 'restrict_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.forbid_demoting_promoted_link() from public;

create trigger hotel_source_identities_no_demote_promoted
  before update on public.hotel_source_identities
  for each row execute function public.forbid_demoting_promoted_link();

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
  source_property_identity_id uuid not null unique,
  -- Denormalised for the same reason as everywhere else in this migration: so
  -- the identity and the run this decision cites can be required to agree.
  source text not null,
  source_environment text not null check (source_environment in ('evaluation', 'production')),
  decision text not null
    check (decision in ('approve_create', 'approve_match', 'reject', 'defer')),
  target_hotel_id uuid references public.hotels(id),
  destination_id uuid references public.destinations(id),
  reviewer_user_id uuid references public.users(id),
  reviewer_label text not null,
  review_note text,
  -- Which run's evidence the decision was made against. NULL is honest ("decided
  -- outside a run"); a run from another provider or another environment is not.
  decided_in_run_id uuid,
  reviewed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Same shape rule as import_property_reviews: invalid decision/target
  -- combinations cannot be stored.
  constraint source_property_reviews_decision_shape check (
    (decision = 'approve_create' and target_hotel_id is null and destination_id is not null)
    or (decision = 'approve_match' and target_hotel_id is not null)
    or (decision in ('reject', 'defer') and target_hotel_id is null)
  ),
  constraint source_property_reviews_identity_fk
    foreign key (source_property_identity_id, source, source_environment)
    references public.source_property_identities (id, source, source_environment)
    on delete cascade,
  constraint source_property_reviews_run_fk
    foreign key (decided_in_run_id, source, source_environment)
    references public.source_runs (id, source, source_environment) on delete restrict
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
  before insert on public.source_property_observations
  for each row execute function public.enforce_source_attributes_bound();

-- ---------------------------------------------------------------------------
-- APPEND-ONLY OBSERVATIONS
-- ---------------------------------------------------------------------------
-- A future canonical star or coordinate will cite an observation id as its
-- provenance (D062 conditions 7 and 10). If the cited row can later be edited
-- or deleted, that provenance is a promise the database does not keep.
--
-- ON DELETE RESTRICT on the observation's PARENTS does not protect the
-- observation itself — it stops the run being deleted, not the row. And a
-- privilege-only defence fails the moment some future migration grants ALL to
-- a role for convenience. So this is enforced in a trigger as well as in the
-- grants: even the table owner and service_role are refused.
create or replace function public.forbid_observation_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'source_property_observations is APPEND-ONLY (attempted %). A source observation is evidence a canonical star or coordinate may cite as its provenance; editing or deleting it would silently invalidate that claim. Record a NEW observation in a NEW run instead. See docs/PROPERTY_CONTENT_IMPLEMENTATION_SPEC.md §9.',
    tg_op
    using errcode = 'restrict_violation';
end;
$$;

revoke all on function public.forbid_observation_mutation() from public;

create trigger source_property_observations_no_update
  before update on public.source_property_observations
  for each row execute function public.forbid_observation_mutation();

create trigger source_property_observations_no_delete
  before delete on public.source_property_observations
  for each row execute function public.forbid_observation_mutation();

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
  public.source_match_candidates,
  public.hotel_source_identities,
  public.source_property_reviews
to authenticated;

grant all privileges on
  public.source_runs,
  public.source_property_identities,
  public.source_match_candidates,
  public.hotel_source_identities,
  public.source_property_reviews
to service_role;

-- Observations are APPEND-ONLY. The privilege set says so as the first layer,
-- and the triggers above hold even if a future migration widens this by
-- mistake. Neither role receives UPDATE or DELETE.
grant select, insert on public.source_property_observations to authenticated;
grant select, insert on public.source_property_observations to service_role;
