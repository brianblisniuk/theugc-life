-- 0028_prepublication_resolution.sql
--
-- V1 PRE-PUBLICATION STAR + LOCATION RESOLUTION.
--
-- The first layer that turns provider OBSERVATIONS into resolved PRODUCT facts,
-- and the layer PROPERTY_CONTENT_IMPLEMENTATION_SPEC.md §21.1 specified as an
-- interface: resolution attaches to the SOURCE PROPERTY IDENTITY, never to a
-- `hotel_id`, because under D062 a row in `hotels` IS publication and a candidate
-- has no hotel id until after the gate.
--
-- Governing decisions: D060 (exactly 4 or 5), D062 (promotion is publication),
-- D065 (source data isolated, never canonical by default), D066 (canonical
-- classification is resolved PRODUCT truth from a reviewed provider policy — one
-- approved provider is sufficient, no issuing authority required).
--
-- What this migration deliberately does NOT do
-- --------------------------------------------
--   * no scope/physical-hospitality resolver;
--   * no D062 preview, no apply, no promotion, no canonical hotel;
--   * no Coverage Engine, no media, no geocoder;
--   * no provider column on `hotels`, no publication_status, no draft tier;
--   * no automatic precedence between sources, no confidence score, no
--     distance threshold, no averaging.
--
-- Additive only. Migrations 0001–0027 are the reviewed baseline. One constraint
-- is ADDED to an existing table (§1) and no column is altered or dropped.

-- ===========================================================================
-- 1. THE PREREQUISITE: an observation must be citable AS BELONGING to its identity
-- ===========================================================================
-- A resolution cites an observation as its evidence. Left as a plain
-- `evidence_observation_id -> source_property_observations(id)`, a resolution for
-- identity A could cite an observation of identity B: both rows exist, the FK
-- passes, and the provenance is silently someone else's.
--
-- This redundant unique key exists so the resolution tables below can foreign-key
-- the PAIR, making that mismatch unrepresentable. Same technique 0027 used for
-- runs and identities.
alter table public.source_property_observations
  add constraint source_property_observations_identity_uk
  unique (id, source_property_identity_id);

-- ===========================================================================
-- 2. STAR RESOLUTION
-- ===========================================================================
-- One CURRENT resolution per source property identity.
--
-- Why one row rather than an append-only log: the durable history already exists
-- one level down. Observations are append-only (0027 §8), so "what did the
-- provider say, and when" is never lost. This table answers the different
-- question a future D062 preview asks — "what is this candidate's classification
-- RIGHT NOW, and what exactly supports it" — and answering it in one row is the
-- smallest design that does so.
create table public.source_property_star_resolutions (
  id uuid primary key default gen_random_uuid(),

  -- ONE current resolution per candidate. The unique constraint is the
  -- idempotency anchor: re-running the resolver upserts this row rather than
  -- accumulating duplicates.
  source_property_identity_id uuid not null unique,
  -- Denormalised so the identity, and through it the environment, can be keyed.
  source text not null,
  source_environment text not null check (source_environment in ('evaluation', 'production')),

  -- THE CITATION. Composite-FK'd to (observation id, identity id) below, so the
  -- cited observation provably belongs to THIS candidate.
  evidence_observation_id uuid not null,

  -- WHICH REVIEWED POLICY produced this, so a resolution can always name it
  -- (D066). Not the provider's claim about itself — ours about the provider.
  policy_provider text not null,
  policy_version text not null,
  -- The exact provider field the policy is contracted to read, recorded so a
  -- reader never has to guess whether `simpleCode` was involved. It was not.
  policy_field text not null,
  -- The exact value read FROM the cited observation. A trigger (§4) verifies it
  -- against the observation, so a caller cannot hand in a string and have it
  -- blessed.
  source_value text,

  outcome text not null check (outcome in
    ('exact_four', 'exact_five', 'classified_not_v1_scope', 'unresolved')),
  -- Only ever 4 or 5, and only when the outcome says so. Numeric rather than
  -- integer purely so a future half-star scope expansion is not a type change;
  -- the CHECK is what keeps V1 exact.
  resolved_star_value numeric,

  -- CONFLICT, not precedence. A second approved observation that disagrees does
  -- NOT overwrite this row and is NOT averaged with it (D066): the disagreement
  -- is recorded and the candidate goes to review.
  conflict_state text not null default 'none' check (conflict_state in ('none', 'conflict')),
  conflicting_observation_id uuid,
  conflicting_outcome text check (conflicting_outcome is null or conflicting_outcome in
    ('exact_four', 'exact_five', 'classified_not_v1_scope', 'unresolved')),

  -- OPTIONAL corroboration only. D066 removed the requirement for a government
  -- or tourism registry; keeping the column lets one be recorded when it exists,
  -- and nothing in this schema gates on it being present.
  issuing_authority text,

  resolved_by_user_id uuid references public.users(id),
  resolved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- The star value and the outcome cannot disagree, in either direction.
  constraint source_property_star_resolutions_value_shape check (
    (outcome = 'exact_four' and resolved_star_value = 4)
    or (outcome = 'exact_five' and resolved_star_value = 5)
    or (outcome in ('classified_not_v1_scope', 'unresolved') and resolved_star_value is null)
  ),
  -- "Conflicts with WHAT?" must have an answer, and a conflict target only means
  -- something for a row that is actually in conflict.
  constraint source_property_star_resolutions_conflict_shape check (
    (conflict_state = 'conflict'
       and conflicting_observation_id is not null and conflicting_outcome is not null)
    or (conflict_state = 'none'
       and conflicting_observation_id is null and conflicting_outcome is null)
  ),

  -- The candidate this resolution is about.
  constraint source_property_star_resolutions_identity_fk
    foreign key (source_property_identity_id, source, source_environment)
    references public.source_property_identities (id, source, source_environment)
    on delete cascade,
  -- THE PROVENANCE INVARIANT. RESTRICT, so an observation cannot be deleted out
  -- from under a resolution that cites it — and the composite key means the
  -- observation must be one of THIS identity's own.
  constraint source_property_star_resolutions_evidence_fk
    foreign key (evidence_observation_id, source_property_identity_id)
    references public.source_property_observations (id, source_property_identity_id)
    on delete restrict,
  constraint source_property_star_resolutions_conflict_evidence_fk
    foreign key (conflicting_observation_id, source_property_identity_id)
    references public.source_property_observations (id, source_property_identity_id)
    on delete restrict
);

create index source_property_star_resolutions_outcome_idx
  on public.source_property_star_resolutions (outcome);
create index source_property_star_resolutions_conflict_idx
  on public.source_property_star_resolutions (conflict_state)
  where conflict_state = 'conflict';
create index source_property_star_resolutions_evidence_idx
  on public.source_property_star_resolutions (evidence_observation_id);

create trigger source_property_star_resolutions_set_updated_at
  before update on public.source_property_star_resolutions
  for each row execute function public.set_updated_at();

comment on table public.source_property_star_resolutions is
  'Pre-publication canonical star classification, attached to the SOURCE IDENTITY (never a hotel_id) and citing the exact observation that produced it. D060/D066.';
comment on column public.source_property_star_resolutions.issuing_authority is
  'OPTIONAL corroboration. D066 removed any government/registry requirement; nothing gates on this being present.';
comment on column public.source_property_star_resolutions.policy_version is
  'The reviewed provider policy that produced this outcome, e.g. hotelbeds-classification/1.';

-- ===========================================================================
-- 3. LOCATION RESOLUTION
-- ===========================================================================
-- Same shape, same provenance rules. `hotels.latitude` / `hotels.longitude`
-- remain the canonical published values and are untouched by this block.
create table public.source_property_location_resolutions (
  id uuid primary key default gen_random_uuid(),

  source_property_identity_id uuid not null unique,
  source text not null,
  source_environment text not null check (source_environment in ('evaluation', 'production')),

  evidence_observation_id uuid not null,

  policy_provider text not null,
  policy_version text not null,

  outcome text not null check (outcome in ('resolved', 'unresolved')),
  -- Copied verbatim from the cited observation, and a trigger (§4) proves it.
  -- Nothing here clamps, snaps, rounds, geocodes or substitutes a coordinate.
  resolved_latitude numeric,
  resolved_longitude numeric,
  -- Why it did not resolve. "No coordinates supplied" and "coordinates supplied
  -- but implausible" are different facts about the provider and must not
  -- collapse into one.
  unresolved_reason text check (unresolved_reason is null or unresolved_reason in
    ('coordinates_missing', 'coordinates_implausible')),

  conflict_state text not null default 'none' check (conflict_state in ('none', 'conflict')),
  conflicting_observation_id uuid,

  resolved_by_user_id uuid references public.users(id),
  resolved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint source_property_location_resolutions_outcome_shape check (
    (outcome = 'resolved'
       and resolved_latitude is not null and resolved_longitude is not null
       and unresolved_reason is null)
    or (outcome = 'unresolved'
       and resolved_latitude is null and resolved_longitude is null
       and unresolved_reason is not null)
  ),
  constraint source_property_location_resolutions_conflict_shape check (
    (conflict_state = 'conflict' and conflicting_observation_id is not null)
    or (conflict_state = 'none' and conflicting_observation_id is null)
  ),

  constraint source_property_location_resolutions_identity_fk
    foreign key (source_property_identity_id, source, source_environment)
    references public.source_property_identities (id, source, source_environment)
    on delete cascade,
  constraint source_property_location_resolutions_evidence_fk
    foreign key (evidence_observation_id, source_property_identity_id)
    references public.source_property_observations (id, source_property_identity_id)
    on delete restrict,
  constraint source_property_location_resolutions_conflict_evidence_fk
    foreign key (conflicting_observation_id, source_property_identity_id)
    references public.source_property_observations (id, source_property_identity_id)
    on delete restrict
);

create index source_property_location_resolutions_outcome_idx
  on public.source_property_location_resolutions (outcome);
create index source_property_location_resolutions_conflict_idx
  on public.source_property_location_resolutions (conflict_state)
  where conflict_state = 'conflict';
create index source_property_location_resolutions_evidence_idx
  on public.source_property_location_resolutions (evidence_observation_id);

create trigger source_property_location_resolutions_set_updated_at
  before update on public.source_property_location_resolutions
  for each row execute function public.set_updated_at();

comment on table public.source_property_location_resolutions is
  'Pre-publication resolved coordinates, attached to the SOURCE IDENTITY and copied verbatim from the cited observation. No geocoding, no clamping, no substitution.';

-- ===========================================================================
-- 4. THE RESOLUTION MUST MATCH ITS EVIDENCE
-- ===========================================================================
-- The composite FKs prove the cited observation belongs to this candidate. They
-- do NOT prove the resolution actually came from it: a caller could still cite a
-- real observation while writing a `source_value` or a coordinate of its own
-- choosing, which is exactly the "hand it a string and have it blessed" failure
-- this layer exists to prevent.
--
-- These triggers close that gap. After them, a resolution row cannot say
-- anything about the provider that the cited observation does not say.

create or replace function public.enforce_star_resolution_matches_evidence()
returns trigger
language plpgsql
as $$
declare
  observed_code text;
begin
  select o.source_classification_code into observed_code
    from public.source_property_observations o
   where o.id = new.evidence_observation_id;

  if new.source_value is distinct from observed_code then
    raise exception
      'star resolution claims source value % but the cited observation carries %. A resolution may only restate what its evidence says — it cannot bless a caller-supplied classification. See docs/PROPERTY_SOURCE_CLASSIFICATION_POLICY.md.',
      coalesce(quote_literal(new.source_value), 'NULL'),
      coalesce(quote_literal(observed_code), 'NULL')
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_star_resolution_matches_evidence() from public;

create trigger source_property_star_resolutions_match_evidence
  before insert or update on public.source_property_star_resolutions
  for each row execute function public.enforce_star_resolution_matches_evidence();

create or replace function public.enforce_location_resolution_matches_evidence()
returns trigger
language plpgsql
as $$
declare
  observed_lat numeric;
  observed_lon numeric;
  observed_plausible boolean;
begin
  select o.source_latitude, o.source_longitude, o.source_coordinates_plausible
    into observed_lat, observed_lon, observed_plausible
    from public.source_property_observations o
   where o.id = new.evidence_observation_id;

  if new.outcome = 'resolved' then
    -- Verbatim, to the digit. No clamping, no rounding, no snapping.
    if new.resolved_latitude is distinct from observed_lat
       or new.resolved_longitude is distinct from observed_lon then
      raise exception
        'location resolution claims (%, %) but the cited observation carries (%, %). Resolved coordinates are copied from the evidence, never adjusted, geocoded or substituted.',
        new.resolved_latitude, new.resolved_longitude, observed_lat, observed_lon
        using errcode = 'check_violation';
    end if;
    -- An implausible or absent coordinate cannot become a resolved location.
    if observed_lat is null or observed_lon is null or observed_plausible is distinct from true then
      raise exception
        'location resolution cannot resolve from an observation whose coordinates are missing or implausible (lat %, lon %, plausible %).',
        observed_lat, observed_lon, observed_plausible
        using errcode = 'check_violation';
    end if;
  else
    -- The stated reason must be the one the evidence actually supports.
    if new.unresolved_reason = 'coordinates_missing'
       and observed_lat is not null and observed_lon is not null then
      raise exception
        'location resolution reports coordinates_missing, but the cited observation carries (%, %).',
        observed_lat, observed_lon
        using errcode = 'check_violation';
    end if;
    if new.unresolved_reason = 'coordinates_implausible'
       and (observed_lat is null or observed_lon is null) then
      raise exception
        'location resolution reports coordinates_implausible, but the cited observation supplies no coordinates at all — those are different facts.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_location_resolution_matches_evidence() from public;

create trigger source_property_location_resolutions_match_evidence
  before insert or update on public.source_property_location_resolutions
  for each row execute function public.enforce_location_resolution_matches_evidence();

-- ===========================================================================
-- 5. RLS — admin/editor + service_role, exactly like 0027
-- ===========================================================================
alter table public.source_property_star_resolutions enable row level security;
alter table public.source_property_location_resolutions enable row level security;

create policy source_property_star_resolutions_admin on public.source_property_star_resolutions
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy source_property_location_resolutions_admin on public.source_property_location_resolutions
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());

-- ===========================================================================
-- 6. PRIVILEGES — stated, not inherited (D046)
-- ===========================================================================
-- 0024's `alter default privileges` means these tables start with none. No anon
-- grant: pre-publication resolutions are editorial internals.
--
-- Unlike observations these are NOT append-only — a resolution is the CURRENT
-- answer and is upserted as evidence accumulates — so the client roles hold the
-- full capability set and RLS reduces a regular creator to zero rows.
grant select, insert, update, delete on
  public.source_property_star_resolutions,
  public.source_property_location_resolutions
to authenticated;

grant all privileges on
  public.source_property_star_resolutions,
  public.source_property_location_resolutions
to service_role;
