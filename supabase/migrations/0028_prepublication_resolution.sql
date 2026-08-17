-- 0028_prepublication_resolution.sql
--
-- V1 PRE-PUBLICATION STAR + LOCATION RESOLUTION.
--
-- The layer PROPERTY_CONTENT_IMPLEMENTATION_SPEC.md §21.1 specified as an
-- interface: resolution attaches to the SOURCE PROPERTY IDENTITY, never to a
-- `hotel_id`, because under D062 a row in `hotels` IS publication and a candidate
-- has no hotel id until after the gate.
--
-- Governing decisions: D060 (exactly 4 or 5), D062 (promotion is publication),
-- D065 (source data isolated, never canonical by default), D066 (canonical
-- classification is resolved PRODUCT truth from a reviewed provider policy).
--
-- THREE STRUCTURES, and each exists because the one before it was not enough:
--
--   §2  The reviewed POLICY, in the database. Without it a resolution could cite
--       the right observation, restate its code faithfully, and still assert an
--       outcome the approved policy never sanctioned.
--   §3  IMMUTABLE revisions plus a head pointer. Without them a later observation
--       or policy version could rewrite the provenance of a hotel already
--       published from an earlier resolution — the publication would appear to
--       have been authorised by evidence that did not exist at the time.
--   §5  Triggers that check a resolution against BOTH its evidence and its
--       policy, including the conflict citations.
--
-- What this migration deliberately does NOT do
-- --------------------------------------------
--   * no scope/physical-hospitality resolver;
--   * no review or adjudication workflow;
--   * no D062 preview, apply, promotion or canonical hotel;
--   * no Coverage Engine, no media, no geocoder;
--   * no precedence, confidence score, authority hierarchy or distance tolerance.
--
-- Additive only. One constraint is ADDED to an existing table (§1); no existing
-- column is altered or dropped.

-- ===========================================================================
-- 1. PREREQUISITE: an observation must be citable AS BELONGING to its identity
-- ===========================================================================
-- Left as a plain `evidence_observation_id -> source_property_observations(id)`,
-- a resolution for identity A could cite an observation of identity B: both rows
-- exist, the FK passes, and the provenance is silently someone else's. Keying
-- the PAIR makes that unrepresentable. Same technique 0027 used for runs.
alter table public.source_property_observations
  add constraint source_property_observations_identity_uk
  unique (id, source_property_identity_id);

-- ===========================================================================
-- 2. THE REVIEWED CLASSIFICATION POLICY, AS DATA
-- ===========================================================================
-- D066 made the PROVIDER the unit of review: one reviewed mapping applies to
-- every property carrying a code. That mapping lived only in TypeScript, which
-- left `5EST -> exact_four` insertable by anything holding a write privilege —
-- direct SQL, a service-role script, a future editorial tool.
--
-- These tables put the approved semantics where the data is, so the check is
-- structural rather than a property of one code path. They are provider-,
-- version- and field-specific and strictly allow-list: a future Provider B adds
-- rows here and changes no canonical schema.
create table public.provider_classification_policies (
  provider text not null,
  version text not null,
  -- The ONE provider field this policy is contracted to read. Recorded so a
  -- reader never has to wonder whether an aggregate field was involved.
  field text not null,
  notes text,
  created_at timestamptz not null default now(),
  primary key (provider, version),
  -- Redundant, and the FK target the mappings and resolutions key against.
  constraint provider_classification_policies_field_uk unique (provider, version, field)
);

comment on table public.provider_classification_policies is
  'Reviewed per-provider classification policies (D066). The unit of review is the provider, not the property.';

create table public.provider_classification_policy_mappings (
  provider text not null,
  version text not null,
  field text not null,
  -- The exact provider code. NEVER an aggregate: for Hotelbeds this is
  -- `categoryCode`, and `simpleCode` conflates keys, aparthotels, hostels and
  -- "without official category" into one number.
  source_code text not null,
  outcome text not null check (outcome in
    ('exact_four', 'exact_five', 'classified_not_v1_scope')),
  resolved_star_value numeric,
  primary key (provider, version, source_code),
  constraint provider_classification_policy_mappings_value_shape check (
    (outcome = 'exact_four' and resolved_star_value = 4)
    or (outcome = 'exact_five' and resolved_star_value = 5)
    or (outcome = 'classified_not_v1_scope' and resolved_star_value is null)
  ),
  constraint provider_classification_policy_mappings_policy_fk
    foreign key (provider, version, field)
    references public.provider_classification_policies (provider, version, field)
    on delete restrict
);

comment on table public.provider_classification_policy_mappings is
  'Allow-list of reviewed provider codes. A code that is ABSENT resolves to `unresolved` — never to a guess.';

-- `unresolved` is deliberately absent from the mapping vocabulary: it is the
-- ABSENCE of a mapping, not an entry. Storing it would make "we reviewed this
-- code and it means nothing" and "we never reviewed this code" the same row.

-- --------------------------------------------------------------------------
-- The Hotelbeds policy v1, exactly as reviewed in
-- docs/PROPERTY_SOURCE_CLASSIFICATION_POLICY.md §5. A parity test fails if this
-- and the TypeScript policy ever drift.
-- --------------------------------------------------------------------------
insert into public.provider_classification_policies (provider, version, field, notes) values
  ('hotelbeds', 'hotelbeds-classification/1', 'categoryCode',
   'Reviewed against the 65-code categories master retrieved in PR #21. Only plain hotel-star codes in the star groups are approved; every other register and every property-type label is unresolved. simpleCode is never read.');

insert into public.provider_classification_policy_mappings
  (provider, version, field, source_code, outcome, resolved_star_value) values
  -- APPROVED: the master names an exact star count.
  ('hotelbeds', 'hotelbeds-classification/1', 'categoryCode', '4EST', 'exact_four', 4),
  ('hotelbeds', 'hotelbeds-classification/1', 'categoryCode', '4LUX', 'exact_four', 4),
  ('hotelbeds', 'hotelbeds-classification/1', 'categoryCode', '5EST', 'exact_five', 5),
  ('hotelbeds', 'hotelbeds-classification/1', 'categoryCode', '5LUX', 'exact_five', 5),
  -- CLASSIFIED, but not V1 scope. Known facts, not unknowns — including the
  -- half-star levels, which are real classifications D060 excludes and which a
  -- careless mapping would round into scope.
  ('hotelbeds', 'hotelbeds-classification/1', 'categoryCode', '1EST', 'classified_not_v1_scope', null),
  ('hotelbeds', 'hotelbeds-classification/1', 'categoryCode', '2EST', 'classified_not_v1_scope', null),
  ('hotelbeds', 'hotelbeds-classification/1', 'categoryCode', '3EST', 'classified_not_v1_scope', null),
  ('hotelbeds', 'hotelbeds-classification/1', 'categoryCode', 'H1_5', 'classified_not_v1_scope', null),
  ('hotelbeds', 'hotelbeds-classification/1', 'categoryCode', 'H2_5', 'classified_not_v1_scope', null),
  ('hotelbeds', 'hotelbeds-classification/1', 'categoryCode', 'H3_5', 'classified_not_v1_scope', null),
  ('hotelbeds', 'hotelbeds-classification/1', 'categoryCode', 'H4_5', 'classified_not_v1_scope', null),
  ('hotelbeds', 'hotelbeds-classification/1', 'categoryCode', 'H5_5', 'classified_not_v1_scope', null),
  ('hotelbeds', 'hotelbeds-classification/1', 'categoryCode', 'H2S', 'classified_not_v1_scope', null),
  ('hotelbeds', 'hotelbeds-classification/1', 'categoryCode', 'H3S', 'classified_not_v1_scope', null);

-- ===========================================================================
-- 3. IMMUTABLE RESOLUTION REVISIONS
-- ===========================================================================
-- A resolution is the evidence a future D062 publication will cite. If the row
-- can be rewritten, that citation is a promise the database does not keep: a
-- hotel published in August from `5EST -> exact_five` would, after an October
-- observation of `4EST`, appear to have been authorised by evidence that did not
-- exist when it was published.
--
-- So revisions are APPEND-ONLY and a separate head table (§4) names the current
-- one. D062 cites a revision id, which cannot change underneath it.
create table public.source_property_star_resolution_revisions (
  id uuid primary key default gen_random_uuid(),

  source_property_identity_id uuid not null,
  source text not null,
  source_environment text not null check (source_environment in ('evaluation', 'production')),

  -- THE CITATION, composite-FK'd to (observation, identity) so the evidence
  -- provably belongs to this candidate.
  evidence_observation_id uuid not null,

  policy_provider text not null,
  policy_version text not null,
  policy_field text not null,
  source_value text,

  outcome text not null check (outcome in
    ('exact_four', 'exact_five', 'classified_not_v1_scope', 'unresolved')),
  resolved_star_value numeric,

  conflict_state text not null default 'none' check (conflict_state in ('none', 'conflict')),
  conflicting_observation_id uuid,
  conflicting_outcome text check (conflicting_outcome is null or conflicting_outcome in
    ('exact_four', 'exact_five', 'classified_not_v1_scope')),

  -- OPTIONAL corroboration. D066 removed any registry requirement and nothing
  -- here gates on it.
  issuing_authority text,

  -- Lineage. Excluded from the digest below, so re-deriving the same conclusion
  -- does not mint a revision merely because the chain moved.
  supersedes_revision_id uuid references public.source_property_star_resolution_revisions(id)
    on delete restrict,

  resolved_by_user_id uuid references public.users(id),
  resolved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  -- THE IDEMPOTENCY KEY. A revision is identified by what it CONCLUDES and what
  -- it concludes it from. Replaying identical evidence under an identical policy
  -- produces the same digest and inserts nothing.
  revision_digest text generated always as (
    md5(
      evidence_observation_id::text || '|' ||
      policy_provider || '|' || policy_version || '|' || policy_field || '|' ||
      coalesce(source_value, '~null~') || '|' ||
      outcome || '|' || coalesce(resolved_star_value::text, '~null~') || '|' ||
      conflict_state || '|' ||
      coalesce(conflicting_observation_id::text, '~null~') || '|' ||
      coalesce(conflicting_outcome, '~null~')
    )
  ) stored,

  constraint source_property_star_resolution_revisions_value_shape check (
    (outcome = 'exact_four' and resolved_star_value = 4)
    or (outcome = 'exact_five' and resolved_star_value = 5)
    or (outcome in ('classified_not_v1_scope', 'unresolved') and resolved_star_value is null)
  ),
  constraint source_property_star_resolution_revisions_conflict_shape check (
    (conflict_state = 'conflict'
       and conflicting_observation_id is not null and conflicting_outcome is not null)
    or (conflict_state = 'none'
       and conflicting_observation_id is null and conflicting_outcome is null)
  ),
  -- A conflict is a disagreement between two READINGS. An `unresolved` outcome is
  -- not a reading, recording a conflict against the SAME outcome is not a
  -- disagreement, and an observation cannot disagree with itself.
  constraint source_property_star_resolution_revisions_conflict_differs check (
    conflict_state = 'none'
    or (outcome <> 'unresolved'
        and conflicting_outcome is distinct from outcome
        and conflicting_observation_id <> evidence_observation_id)
  ),
  constraint source_property_star_resolution_revisions_digest_uk
    unique (source_property_identity_id, revision_digest),
  -- The head pointer keys this pair, so a head can only ever name a revision of
  -- its own candidate.
  constraint source_property_star_resolution_revisions_identity_uk
    unique (id, source_property_identity_id),

  constraint source_property_star_resolution_revisions_identity_fk
    foreign key (source_property_identity_id, source, source_environment)
    references public.source_property_identities (id, source, source_environment)
    on delete cascade,
  constraint source_property_star_resolution_revisions_evidence_fk
    foreign key (evidence_observation_id, source_property_identity_id)
    references public.source_property_observations (id, source_property_identity_id)
    on delete restrict,
  -- Named `_conflict_obs_fk` rather than `..._conflict_evidence_fk` so the
  -- location table's twin stays inside Postgres's 63-character identifier limit
  -- and both can be matched by name.
  constraint source_property_star_resolution_revisions_conflict_obs_fk
    foreign key (conflicting_observation_id, source_property_identity_id)
    references public.source_property_observations (id, source_property_identity_id)
    on delete restrict,
  -- The policy named must be a policy that exists, at the version and field it
  -- claims. §5 then checks the OUTCOME against that policy's mappings.
  constraint source_property_star_resolution_revisions_policy_fk
    foreign key (policy_provider, policy_version, policy_field)
    references public.provider_classification_policies (provider, version, field)
    on delete restrict
);

create index source_property_star_resolution_revisions_identity_idx
  on public.source_property_star_resolution_revisions (source_property_identity_id, resolved_at desc);
create index source_property_star_resolution_revisions_outcome_idx
  on public.source_property_star_resolution_revisions (outcome);

comment on table public.source_property_star_resolution_revisions is
  'IMMUTABLE pre-publication star classification revisions. A future D062 publication cites a revision id, which can never be rewritten.';

create table public.source_property_location_resolution_revisions (
  id uuid primary key default gen_random_uuid(),

  source_property_identity_id uuid not null,
  source text not null,
  source_environment text not null check (source_environment in ('evaluation', 'production')),

  evidence_observation_id uuid not null,

  policy_provider text not null,
  policy_version text not null,

  outcome text not null check (outcome in ('resolved', 'unresolved')),
  -- Copied verbatim from the cited observation; §5 proves it. Nothing clamps,
  -- snaps, rounds, geocodes or substitutes.
  resolved_latitude numeric,
  resolved_longitude numeric,
  -- "Not supplied" and "supplied but implausible" are different facts about the
  -- provider and must not collapse into one.
  unresolved_reason text check (unresolved_reason is null or unresolved_reason in
    ('coordinates_missing', 'coordinates_implausible')),

  conflict_state text not null default 'none' check (conflict_state in ('none', 'conflict')),
  conflicting_observation_id uuid,

  supersedes_revision_id uuid references public.source_property_location_resolution_revisions(id)
    on delete restrict,

  resolved_by_user_id uuid references public.users(id),
  resolved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  revision_digest text generated always as (
    md5(
      evidence_observation_id::text || '|' ||
      policy_provider || '|' || policy_version || '|' ||
      outcome || '|' ||
      coalesce(resolved_latitude::text, '~null~') || '|' ||
      coalesce(resolved_longitude::text, '~null~') || '|' ||
      coalesce(unresolved_reason, '~null~') || '|' ||
      conflict_state || '|' ||
      coalesce(conflicting_observation_id::text, '~null~')
    )
  ) stored,

  constraint source_property_location_resolution_revisions_outcome_shape check (
    (outcome = 'resolved'
       and resolved_latitude is not null and resolved_longitude is not null
       and unresolved_reason is null)
    or (outcome = 'unresolved'
       and resolved_latitude is null and resolved_longitude is null
       and unresolved_reason is not null)
  ),
  constraint source_property_location_resolution_revisions_conflict_shape check (
    (conflict_state = 'conflict' and conflicting_observation_id is not null)
    or (conflict_state = 'none' and conflicting_observation_id is null)
  ),
  -- Only a RESOLVED location can be in conflict — an unresolved one has no
  -- coordinate pair for anything to disagree with — and never with itself.
  constraint source_property_location_resolution_revisions_conflict_differs check (
    conflict_state = 'none'
    or (outcome = 'resolved' and conflicting_observation_id <> evidence_observation_id)
  ),
  constraint source_property_location_resolution_revisions_digest_uk
    unique (source_property_identity_id, revision_digest),
  constraint source_property_location_resolution_revisions_identity_uk
    unique (id, source_property_identity_id),

  constraint source_property_location_resolution_revisions_identity_fk
    foreign key (source_property_identity_id, source, source_environment)
    references public.source_property_identities (id, source, source_environment)
    on delete cascade,
  constraint source_property_location_resolution_revisions_evidence_fk
    foreign key (evidence_observation_id, source_property_identity_id)
    references public.source_property_observations (id, source_property_identity_id)
    on delete restrict,
  constraint source_property_location_resolution_revisions_conflict_obs_fk
    foreign key (conflicting_observation_id, source_property_identity_id)
    references public.source_property_observations (id, source_property_identity_id)
    on delete restrict
);

create index source_property_location_resolution_revisions_identity_idx
  on public.source_property_location_resolution_revisions (source_property_identity_id, resolved_at desc);
create index source_property_location_resolution_revisions_outcome_idx
  on public.source_property_location_resolution_revisions (outcome);

comment on table public.source_property_location_resolution_revisions is
  'IMMUTABLE pre-publication location resolution revisions. Coordinates are copied verbatim from the cited observation.';

-- ===========================================================================
-- 4. CURRENT-RESOLUTION HEAD POINTERS
-- ===========================================================================
-- Exactly one current revision per candidate per dimension. The head MOVES; the
-- revisions it has pointed at never change. A resolver reads current state in one
-- join and never replays history.
create table public.source_property_star_resolutions (
  source_property_identity_id uuid primary key,
  current_revision_id uuid not null,
  updated_at timestamptz not null default now(),
  constraint source_property_star_resolutions_revision_fk
    foreign key (current_revision_id, source_property_identity_id)
    references public.source_property_star_resolution_revisions (id, source_property_identity_id)
    on delete restrict,
  constraint source_property_star_resolutions_identity_fk
    foreign key (source_property_identity_id)
    references public.source_property_identities (id) on delete cascade
);

create table public.source_property_location_resolutions (
  source_property_identity_id uuid primary key,
  current_revision_id uuid not null,
  updated_at timestamptz not null default now(),
  constraint source_property_location_resolutions_revision_fk
    foreign key (current_revision_id, source_property_identity_id)
    references public.source_property_location_resolution_revisions (id, source_property_identity_id)
    on delete restrict,
  constraint source_property_location_resolutions_identity_fk
    foreign key (source_property_identity_id)
    references public.source_property_identities (id) on delete cascade
);

create trigger source_property_star_resolutions_set_updated_at
  before update on public.source_property_star_resolutions
  for each row execute function public.set_updated_at();
create trigger source_property_location_resolutions_set_updated_at
  before update on public.source_property_location_resolutions
  for each row execute function public.set_updated_at();

comment on table public.source_property_star_resolutions is
  'HEAD POINTER: the current star resolution revision per candidate. The pointer moves; the revisions do not change.';
comment on table public.source_property_location_resolutions is
  'HEAD POINTER: the current location resolution revision per candidate.';

-- Convenience read model, so "current resolution" is one relation rather than a
-- join every caller has to remember to write.
--
-- `security_invoker = true`, unlike the public intelligence views: these are
-- editorial internals, and a security-definer view would hand every caller with
-- the SELECT privilege the whole table regardless of the RLS policies above.
create view public.source_property_current_star_resolutions
with (security_invoker = true) as
  select r.*, h.updated_at as head_updated_at
    from public.source_property_star_resolutions h
    join public.source_property_star_resolution_revisions r on r.id = h.current_revision_id;

create view public.source_property_current_location_resolutions
with (security_invoker = true) as
  select r.*, h.updated_at as head_updated_at
    from public.source_property_location_resolutions h
    join public.source_property_location_resolution_revisions r on r.id = h.current_revision_id;

-- ===========================================================================
-- 5. A REVISION MUST MATCH ITS EVIDENCE *AND* ITS POLICY
-- ===========================================================================
-- The composite FKs prove the cited observation belongs to the candidate, and
-- the policy FK proves the named policy exists. Neither proves the CONCLUSION is
-- the one the approved policy reaches from that evidence — a caller could cite a
-- real observation, restate its code faithfully, and still assert `exact_four`
-- for `5EST`. These triggers close that.

create or replace function public.enforce_star_revision_integrity()
returns trigger
language plpgsql
as $$
declare
  observed_code text;
  mapped_outcome text;
  mapped_value numeric;
  mapping_found boolean;
  conflict_code text;
  conflict_mapped_outcome text;
  conflict_mapping_found boolean;
begin
  -- (a) The source value must be the cited observation's own.
  select o.source_classification_code into observed_code
    from public.source_property_observations o
   where o.id = new.evidence_observation_id;

  if new.source_value is distinct from observed_code then
    raise exception
      'star resolution claims source value % but the cited observation carries %. A resolution may only restate what its evidence says.',
      coalesce(quote_literal(new.source_value), 'NULL'),
      coalesce(quote_literal(observed_code), 'NULL')
      using errcode = 'check_violation';
  end if;

  -- (b) The OUTCOME must be the one the approved policy reaches from that value.
  select m.outcome, m.resolved_star_value into mapped_outcome, mapped_value
    from public.provider_classification_policy_mappings m
   where m.provider = new.policy_provider
     and m.version = new.policy_version
     and m.field = new.policy_field
     and m.source_code = new.source_value;
  mapping_found := found;

  if mapping_found then
    if new.outcome is distinct from mapped_outcome
       or new.resolved_star_value is distinct from mapped_value then
      raise exception
        'policy % maps % to %/% but this resolution claims %/%. The approved policy decides the outcome, not the caller.',
        new.policy_version, quote_literal(new.source_value), mapped_outcome,
        coalesce(mapped_value::text, 'NULL'), new.outcome,
        coalesce(new.resolved_star_value::text, 'NULL')
        using errcode = 'check_violation';
    end if;
  else
    -- An UNMAPPED code means exactly one thing: we have not reviewed it.
    if new.outcome <> 'unresolved' then
      raise exception
        'policy % has no mapping for % under field %, so it can only resolve to `unresolved` — not to %. An unreviewed code never acquires a meaning by accident.',
        new.policy_version, coalesce(quote_literal(new.source_value), 'NULL'),
        quote_literal(new.policy_field), new.outcome
        using errcode = 'check_violation';
    end if;
  end if;

  -- (c) A conflict must be a REAL disagreement, from a real competing reading.
  if new.conflict_state = 'conflict' then
    select o.source_classification_code into conflict_code
      from public.source_property_observations o
     where o.id = new.conflicting_observation_id;

    select m.outcome into conflict_mapped_outcome
      from public.provider_classification_policy_mappings m
     where m.provider = new.policy_provider
       and m.version = new.policy_version
       and m.field = new.policy_field
       and m.source_code = conflict_code;
    conflict_mapping_found := found;

    if not conflict_mapping_found then
      raise exception
        'the conflicting observation carries %, which policy % does not map. An unresolved observation is not a competing claim and cannot manufacture a conflict.',
        coalesce(quote_literal(conflict_code), 'NULL'), new.policy_version
        using errcode = 'check_violation';
    end if;

    if new.conflicting_outcome is distinct from conflict_mapped_outcome then
      raise exception
        'conflicting_outcome says % but policy % maps the conflicting observation''s code % to %.',
        new.conflicting_outcome, new.policy_version,
        coalesce(quote_literal(conflict_code), 'NULL'), conflict_mapped_outcome
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_star_revision_integrity() from public;

create trigger source_property_star_resolution_revisions_integrity
  before insert on public.source_property_star_resolution_revisions
  for each row execute function public.enforce_star_revision_integrity();

create or replace function public.enforce_location_revision_integrity()
returns trigger
language plpgsql
as $$
declare
  lat numeric; lon numeric; plausible boolean;
  clat numeric; clon numeric; cplausible boolean;
begin
  select o.source_latitude, o.source_longitude, o.source_coordinates_plausible
    into lat, lon, plausible
    from public.source_property_observations o
   where o.id = new.evidence_observation_id;

  if new.outcome = 'resolved' then
    if new.resolved_latitude is distinct from lat
       or new.resolved_longitude is distinct from lon then
      raise exception
        'location resolution claims (%, %) but the cited observation carries (%, %). Resolved coordinates are copied from the evidence, never adjusted, geocoded or substituted.',
        new.resolved_latitude, new.resolved_longitude, lat, lon
        using errcode = 'check_violation';
    end if;
    if lat is null or lon is null or plausible is distinct from true then
      raise exception
        'cannot resolve a location from an observation whose coordinates are missing or implausible (lat %, lon %, plausible %).',
        lat, lon, plausible
        using errcode = 'check_violation';
    end if;
  else
    -- Each unresolved reason must be the one the evidence actually supports —
    -- in BOTH directions, so a usable coordinate cannot be reported implausible.
    if new.unresolved_reason = 'coordinates_missing' and lat is not null and lon is not null then
      raise exception
        'reports coordinates_missing, but the cited observation carries (%, %).', lat, lon
        using errcode = 'check_violation';
    end if;
    if new.unresolved_reason = 'coordinates_implausible' then
      if lat is null or lon is null then
        raise exception
          'reports coordinates_implausible, but the cited observation supplies no coordinates at all — those are different facts.'
          using errcode = 'check_violation';
      end if;
      if plausible is true then
        raise exception
          'reports coordinates_implausible, but the cited observation was audited as PLAUSIBLE (lat %, lon %). A usable coordinate cannot be discarded as implausible.',
          lat, lon
          using errcode = 'check_violation';
      end if;
    end if;
  end if;

  -- A location conflict requires a genuinely competing, usable coordinate pair.
  if new.conflict_state = 'conflict' then
    select o.source_latitude, o.source_longitude, o.source_coordinates_plausible
      into clat, clon, cplausible
      from public.source_property_observations o
     where o.id = new.conflicting_observation_id;

    if clat is null or clon is null or cplausible is distinct from true then
      raise exception
        'the conflicting observation has no usable coordinates (lat %, lon %, plausible %). Missing or implausible coordinates are not a competing claim.',
        clat, clon, cplausible
        using errcode = 'check_violation';
    end if;
    if clat = new.resolved_latitude and clon = new.resolved_longitude then
      raise exception
        'the conflicting observation carries the SAME coordinates (%, %). Agreement is not a conflict.',
        clat, clon
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_location_revision_integrity() from public;

create trigger source_property_location_resolution_revisions_integrity
  before insert on public.source_property_location_resolution_revisions
  for each row execute function public.enforce_location_revision_integrity();

-- ---------------------------------------------------------------------------
-- IMMUTABILITY
-- ---------------------------------------------------------------------------
-- The head pointer moves. A revision does not. Enforced in a trigger as well as
-- in the grants below, so the guarantee survives a future migration that widens
-- a privilege by mistake — and holds for the table owner too.
create or replace function public.forbid_resolution_revision_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    '% is IMMUTABLE (attempted %). A future D062 publication cites a resolution revision as the evidence that authorised it; rewriting the revision would make the publication appear to rest on evidence that did not exist at the time. Record a NEW revision and move the head pointer instead.',
    tg_table_name, tg_op
    using errcode = 'restrict_violation';
end;
$$;

revoke all on function public.forbid_resolution_revision_mutation() from public;

create trigger source_property_star_resolution_revisions_no_update
  before update or delete on public.source_property_star_resolution_revisions
  for each row execute function public.forbid_resolution_revision_mutation();
create trigger source_property_location_resolution_revisions_no_update
  before update or delete on public.source_property_location_resolution_revisions
  for each row execute function public.forbid_resolution_revision_mutation();

-- ===========================================================================
-- 6. RLS — admin/editor + service_role, exactly like 0027
-- ===========================================================================
alter table public.provider_classification_policies enable row level security;
alter table public.provider_classification_policy_mappings enable row level security;
alter table public.source_property_star_resolution_revisions enable row level security;
alter table public.source_property_location_resolution_revisions enable row level security;
alter table public.source_property_star_resolutions enable row level security;
alter table public.source_property_location_resolutions enable row level security;

create policy provider_classification_policies_admin on public.provider_classification_policies
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy provider_classification_policy_mappings_admin on public.provider_classification_policy_mappings
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy source_property_star_resolution_revisions_admin on public.source_property_star_resolution_revisions
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy source_property_location_resolution_revisions_admin on public.source_property_location_resolution_revisions
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy source_property_star_resolutions_admin on public.source_property_star_resolutions
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy source_property_location_resolutions_admin on public.source_property_location_resolutions
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());

-- ===========================================================================
-- 7. PRIVILEGES — stated, not inherited (D046)
-- ===========================================================================
-- No anon grant anywhere: these are editorial internals.
--
-- Revisions are APPEND-ONLY, so no role holds UPDATE or DELETE on them — the
-- same treatment `source_property_observations` gets in 0027, and for the same
-- reason. Head pointers are meant to move, so they carry the full set.
grant select, insert on
  public.source_property_star_resolution_revisions,
  public.source_property_location_resolution_revisions
to authenticated;
grant select, insert on
  public.source_property_star_resolution_revisions,
  public.source_property_location_resolution_revisions
to service_role;

grant select, insert, update, delete on
  public.provider_classification_policies,
  public.provider_classification_policy_mappings,
  public.source_property_star_resolutions,
  public.source_property_location_resolutions
to authenticated;

grant all privileges on
  public.provider_classification_policies,
  public.provider_classification_policy_mappings,
  public.source_property_star_resolutions,
  public.source_property_location_resolutions
to service_role;

grant select on
  public.source_property_current_star_resolutions,
  public.source_property_current_location_resolutions
to authenticated, service_role;
