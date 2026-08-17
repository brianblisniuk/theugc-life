-- 0029_prepublication_hospitality_scope.sql
--
-- V1 PRE-PUBLICATION PHYSICAL-HOSPITALITY RESOLUTION.
--
-- 0028 resolved two of D062's inputs — star classification and coordinates.
-- Condition 3, "it is a physical hospitality property", still had nowhere to
-- come from. This migration gives it one, and NOTHING ELSE.
--
-- WHAT THIS DIMENSION IS NOT
-- --------------------------
-- It is not V1 eligibility, and no column here says `eligible`, `publishable` or
-- `resolved_eligible`. D060 is explicit that PROPERTY TYPE ALONE DOES NOT DECIDE
-- V1 ELIGIBILITY: the gate is physical hospitality property AND a resolved exact
-- 4/5 hospitality classification AND a supported destination, composed later at
-- the D062 preview. So:
--
--   physical_hospitality + 3 stars   is still not eligible;
--   physical_hospitality + 5 stars   is still not published here;
--   unresolved scope     + 5 stars   is a HOLD for D062, not an exclusion.
--
-- This is also NOT a hotel-type whitelist standing in for D060. `S` Hostel is
-- mapped `physical_hospitality`, because type and star eligibility are
-- independent dimensions and excluding a hostel here would smuggle a
-- classification judgement into a type resolver.
--
-- Structurally this is 0028's pattern applied to a third dimension: a reviewed
-- provider policy as DATA, frozen once approved; append-only immutable
-- revisions; a head pointer; a security_invoker read model.
--
-- Additive only. No existing column is altered or dropped.

-- ===========================================================================
-- 1. THE REVIEWED HOSPITALITY-SCOPE POLICY, AS DATA
-- ===========================================================================
-- Separate tables from the classification policy rather than a shared one with a
-- `dimension` column: the two answer different questions with different
-- vocabularies, and a shared outcome domain would have to admit every value of
-- both — which is exactly how `exact_five` becomes insertable as a scope answer.
create table public.provider_hospitality_scope_policies (
  provider text not null,
  version text not null,
  -- The ONE provider field this policy is contracted to read.
  field text not null,
  notes text,
  -- NULL = DRAFT: still assemblable, and refused by §3 as the basis of any
  -- resolution. Once set, the field and the complete mapping set are immutable.
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (provider, version),
  constraint provider_hospitality_scope_policies_field_uk unique (provider, version, field)
);

comment on table public.provider_hospitality_scope_policies is
  'Reviewed per-provider physical-hospitality scope policies. Draft while approved_at is NULL; frozen and citable once set.';
comment on column public.provider_hospitality_scope_policies.approved_at is
  'NULL = draft, not citable. Once set the version and its whole mapping set are immutable — a semantic change needs a NEW version.';

create table public.provider_hospitality_scope_policy_mappings (
  provider text not null,
  version text not null,
  field text not null,
  source_code text not null,
  -- `unresolved` is deliberately NOT in this domain. Absence of a row IS
  -- unresolved; storing it would make "we reviewed this type and it tells us
  -- nothing" and "we never reviewed this type" the same row — and it would let
  -- an unreviewed type look adjudicated.
  outcome text not null check (outcome in ('physical_hospitality', 'not_physical_hospitality')),
  primary key (provider, version, source_code),
  constraint provider_hospitality_scope_policy_mappings_policy_fk
    foreign key (provider, version, field)
    references public.provider_hospitality_scope_policies (provider, version, field)
    on delete restrict
);

comment on table public.provider_hospitality_scope_policy_mappings is
  'Allow-list of reviewed provider accommodation types. A type that is ABSENT resolves to `unresolved` — never to `not_physical_hospitality`.';

-- --------------------------------------------------------------------------
-- A POLICY VERSION IS FROZEN ONCE APPROVED
-- --------------------------------------------------------------------------
-- Same reasoning as 0028 §2, and it is not optional here either: an immutable
-- revision saying `H -> physical_hospitality` is worthless if `H` can be
-- remapped inside the version the revision cites.
create or replace function public.forbid_approved_scope_policy_mutation()
returns trigger
language plpgsql
as $$
begin
  if old.approved_at is not null then
    raise exception
      'hospitality-scope policy %/% was approved at % and is IMMUTABLE (attempted %). Create a NEW version instead.',
      old.provider, old.version, old.approved_at, tg_op
      using errcode = 'restrict_violation';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.forbid_approved_scope_policy_mutation() from public;

create trigger provider_hospitality_scope_policies_freeze
  before update or delete on public.provider_hospitality_scope_policies
  for each row execute function public.forbid_approved_scope_policy_mutation();

-- Both sides again: the version a mapping LEAVES and the one it ARRIVES at.
create or replace function public.forbid_approved_scope_mapping_mutation()
returns trigger
language plpgsql
as $$
declare
  approved timestamptz;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select p.approved_at into approved from public.provider_hospitality_scope_policies p
     where p.provider = old.provider and p.version = old.version;
    if approved is not null then
      raise exception
        'hospitality-scope policy %/% was approved at % and its mapping set is IMMUTABLE (attempted % on %). Create a NEW version instead.',
        old.provider, old.version, approved, tg_op, old.source_code
        using errcode = 'restrict_violation';
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    select p.approved_at into approved from public.provider_hospitality_scope_policies p
     where p.provider = new.provider and p.version = new.version;
    if approved is not null then
      raise exception
        'hospitality-scope policy %/% was approved at % and its mapping set is IMMUTABLE (attempted % of %). Create a NEW version instead.',
        new.provider, new.version, approved, tg_op, new.source_code
        using errcode = 'restrict_violation';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.forbid_approved_scope_mapping_mutation() from public;

create trigger provider_hospitality_scope_policy_mappings_freeze
  before insert or update or delete on public.provider_hospitality_scope_policy_mappings
  for each row execute function public.forbid_approved_scope_mapping_mutation();

-- --------------------------------------------------------------------------
-- The Hotelbeds hospitality-scope policy v1, exactly as reviewed in
-- docs/PROPERTY_SOURCE_HOSPITALITY_SCOPE_POLICY.md. A parity test fails if this
-- and the TypeScript policy ever drift.
--
-- Assembled as a draft and approved at the end — the only way any version can be
-- built, including this one.
-- --------------------------------------------------------------------------
insert into public.provider_hospitality_scope_policies (provider, version, field, notes) values
  ('hotelbeds', 'hotelbeds-hospitality-scope/1', 'accommodationTypeCode',
   'Reviewed against the 24-code accommodations master retrieved to exhaustion in PR #21. Mapped to physical_hospitality only where the master names an operated accommodation business; bare dwelling labels and the "Vacation *" family stay unresolved because the master does not establish that a unit is a hospitality operation.');

insert into public.provider_hospitality_scope_policy_mappings
  (provider, version, field, source_code, outcome) values
  -- PHYSICAL HOSPITALITY: the master names an operated establishment.
  ('hotelbeds', 'hotelbeds-hospitality-scope/1', 'accommodationTypeCode', 'H', 'physical_hospitality'), -- Hotel
  ('hotelbeds', 'hotelbeds-hospitality-scope/1', 'accommodationTypeCode', 'W', 'physical_hospitality'), -- Resort
  ('hotelbeds', 'hotelbeds-hospitality-scope/1', 'accommodationTypeCode', 'P', 'physical_hospitality'), -- Aparthotel
  ('hotelbeds', 'hotelbeds-hospitality-scope/1', 'accommodationTypeCode', 'G', 'physical_hospitality'), -- Guest house
  ('hotelbeds', 'hotelbeds-hospitality-scope/1', 'accommodationTypeCode', 'K', 'physical_hospitality'), -- Bed and breakfast
  ('hotelbeds', 'hotelbeds-hospitality-scope/1', 'accommodationTypeCode', 'S', 'physical_hospitality'), -- Hostel
  ('hotelbeds', 'hotelbeds-hospitality-scope/1', 'accommodationTypeCode', 'M', 'physical_hospitality'), -- Motel
  ('hotelbeds', 'hotelbeds-hospitality-scope/1', 'accommodationTypeCode', 'D', 'physical_hospitality'), -- Lodge
  ('hotelbeds', 'hotelbeds-hospitality-scope/1', 'accommodationTypeCode', 'Z', 'physical_hospitality'), -- Rural hotel
  ('hotelbeds', 'hotelbeds-hospitality-scope/1', 'accommodationTypeCode', 'X', 'physical_hospitality'), -- Historical hotel Luxurious
  -- NOT PHYSICAL HOSPITALITY: a vessel or an itinerary, not a property.
  ('hotelbeds', 'hotelbeds-hospitality-scope/1', 'accommodationTypeCode', 'U', 'not_physical_hospitality'), -- Cruise
  ('hotelbeds', 'hotelbeds-hospitality-scope/1', 'accommodationTypeCode', 'L', 'not_physical_hospitality'); -- Boat

-- Frozen. From here the only way to change any of the above is a new version.
update public.provider_hospitality_scope_policies
   set approved_at = now()
 where provider = 'hotelbeds' and version = 'hotelbeds-hospitality-scope/1';

-- ===========================================================================
-- 2. IMMUTABLE SCOPE-RESOLUTION REVISIONS + HEAD POINTER
-- ===========================================================================
-- D062 will cite a scope revision as part of the evidence that authorised a
-- publication, exactly as it will cite a star revision. Same guarantee, same
-- shape: append-only revisions, a head that moves, and a read model over it.
create table public.source_property_scope_resolution_revisions (
  id uuid primary key default gen_random_uuid(),

  source_property_identity_id uuid not null,
  source text not null,
  source_environment text not null check (source_environment in ('evaluation', 'production')),

  evidence_observation_id uuid not null,

  policy_provider text not null,
  policy_version text not null,
  policy_field text not null,
  source_value text,

  outcome text not null check (outcome in
    ('physical_hospitality', 'not_physical_hospitality', 'unresolved')),

  supersedes_revision_id uuid,

  resolved_by_user_id uuid references public.users(id),
  resolved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  -- The idempotency key: what this revision concludes, and what from.
  revision_digest text generated always as (
    md5(
      evidence_observation_id::text || '|' ||
      policy_provider || '|' || policy_version || '|' || policy_field || '|' ||
      coalesce(source_value, '~null~') || '|' || outcome
    )
  ) stored,

  -- A provider's policy applies to THAT provider's observations.
  constraint source_property_scope_resolution_revisions_policy_source_ck check (
    policy_provider = source
  ),
  constraint source_property_scope_resolution_revisions_supersedes_self check (
    supersedes_revision_id is distinct from id
  ),
  constraint source_property_scope_resolution_revisions_digest_uk
    unique (source_property_identity_id, revision_digest),
  constraint source_property_scope_resolution_revisions_identity_uk
    unique (id, source_property_identity_id),

  constraint source_property_scope_resolution_revisions_identity_fk
    foreign key (source_property_identity_id, source, source_environment)
    references public.source_property_identities (id, source, source_environment)
    on delete cascade,
  constraint source_property_scope_resolution_revisions_evidence_fk
    foreign key (evidence_observation_id, source_property_identity_id)
    references public.source_property_observations (id, source_property_identity_id)
    on delete restrict,
  constraint source_property_scope_resolution_revisions_policy_fk
    foreign key (policy_provider, policy_version, policy_field)
    references public.provider_hospitality_scope_policies (provider, version, field)
    on delete restrict,
  constraint source_property_scope_resolution_revisions_supersedes_fk
    foreign key (supersedes_revision_id, source_property_identity_id)
    references public.source_property_scope_resolution_revisions (id, source_property_identity_id)
    on delete restrict
);

create index source_property_scope_resolution_revisions_identity_idx
  on public.source_property_scope_resolution_revisions (source_property_identity_id, resolved_at desc);
create index source_property_scope_resolution_revisions_outcome_idx
  on public.source_property_scope_resolution_revisions (outcome);

comment on table public.source_property_scope_resolution_revisions is
  'IMMUTABLE pre-publication physical-hospitality revisions. NOT V1 eligibility: D060 says property type alone does not decide it.';

create table public.source_property_scope_resolutions (
  source_property_identity_id uuid primary key,
  current_revision_id uuid not null,
  updated_at timestamptz not null default now(),
  constraint source_property_scope_resolutions_revision_fk
    foreign key (current_revision_id, source_property_identity_id)
    references public.source_property_scope_resolution_revisions (id, source_property_identity_id)
    on delete restrict,
  constraint source_property_scope_resolutions_identity_fk
    foreign key (source_property_identity_id)
    references public.source_property_identities (id) on delete cascade
);

create trigger source_property_scope_resolutions_set_updated_at
  before update on public.source_property_scope_resolutions
  for each row execute function public.set_updated_at();

comment on table public.source_property_scope_resolutions is
  'HEAD POINTER: the current physical-hospitality revision per candidate. The pointer moves; the revisions do not.';

create view public.source_property_current_scope_resolutions
with (security_invoker = true) as
  select r.*, h.updated_at as head_updated_at
    from public.source_property_scope_resolutions h
    join public.source_property_scope_resolution_revisions r on r.id = h.current_revision_id;

-- ===========================================================================
-- 3. A REVISION MUST MATCH ITS EVIDENCE *AND* ITS POLICY
-- ===========================================================================
create or replace function public.enforce_scope_revision_integrity()
returns trigger
language plpgsql
as $$
declare
  observed_code text;
  policy_approved timestamptz;
  policy_exists boolean;
  mapped_outcome text;
  mapping_found boolean;
begin
  -- (a) The source value must be the cited observation's own type code.
  select o.source_property_type_code into observed_code
    from public.source_property_observations o
   where o.id = new.evidence_observation_id;

  if new.source_value is distinct from observed_code then
    raise exception
      'scope resolution claims source value % but the cited observation carries %. A resolution may only restate what its evidence says.',
      coalesce(quote_literal(new.source_value), 'NULL'),
      coalesce(quote_literal(observed_code), 'NULL')
      using errcode = 'check_violation';
  end if;

  -- (b) The policy cited must be APPROVED, not a draft still being assembled.
  select p.approved_at into policy_approved
    from public.provider_hospitality_scope_policies p
   where p.provider = new.policy_provider
     and p.version = new.policy_version
     and p.field = new.policy_field;
  policy_exists := found;

  if not policy_exists or policy_approved is null then
    raise exception
      '%/% on field % is not an APPROVED hospitality-scope policy (%). A resolution may only cite a frozen, reviewed version.',
      new.policy_provider, new.policy_version, quote_literal(new.policy_field),
      case when policy_exists then 'still a draft' else 'no such policy' end
      using errcode = 'check_violation';
  end if;

  -- (c) The OUTCOME must be the one the approved policy reaches from that value.
  select m.outcome into mapped_outcome
    from public.provider_hospitality_scope_policy_mappings m
   where m.provider = new.policy_provider
     and m.version = new.policy_version
     and m.field = new.policy_field
     and m.source_code = new.source_value;
  mapping_found := found;

  if mapping_found then
    if new.outcome is distinct from mapped_outcome then
      raise exception
        'policy % maps % to % but this resolution claims %. The approved policy decides the outcome, not the caller.',
        new.policy_version, quote_literal(new.source_value), mapped_outcome, new.outcome
        using errcode = 'check_violation';
    end if;
  else
    -- An UNMAPPED type means one thing: we have not reviewed it. It does NOT
    -- mean the property is not hospitality — that is a finding, and this is the
    -- absence of one.
    if new.outcome <> 'unresolved' then
      raise exception
        'policy % has no mapping for % under field %, so it can only resolve to `unresolved` — not to %. An unreviewed accommodation type never acquires a meaning by accident.',
        new.policy_version, coalesce(quote_literal(new.source_value), 'NULL'),
        quote_literal(new.policy_field), new.outcome
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_scope_revision_integrity() from public;

create trigger source_property_scope_resolution_revisions_integrity
  before insert on public.source_property_scope_resolution_revisions
  for each row execute function public.enforce_scope_revision_integrity();

-- Immutability, reusing 0028's function: the head pointer moves, a revision
-- never does, and the guarantee holds for the table owner too.
create trigger source_property_scope_resolution_revisions_no_update
  before update or delete on public.source_property_scope_resolution_revisions
  for each row execute function public.forbid_resolution_revision_mutation();

-- ===========================================================================
-- 4. RLS — admin/editor + service_role, exactly like 0027 and 0028
-- ===========================================================================
alter table public.provider_hospitality_scope_policies enable row level security;
alter table public.provider_hospitality_scope_policy_mappings enable row level security;
alter table public.source_property_scope_resolution_revisions enable row level security;
alter table public.source_property_scope_resolutions enable row level security;

create policy provider_hospitality_scope_policies_admin on public.provider_hospitality_scope_policies
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy provider_hospitality_scope_policy_mappings_admin on public.provider_hospitality_scope_policy_mappings
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy source_property_scope_resolution_revisions_admin on public.source_property_scope_resolution_revisions
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy source_property_scope_resolutions_admin on public.source_property_scope_resolutions
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());

-- ===========================================================================
-- 5. PRIVILEGES — stated, not inherited (D046)
-- ===========================================================================
-- No anon grant anywhere. Revisions are APPEND-ONLY, so no role — service_role
-- included — holds UPDATE or DELETE on them.
grant select, insert on
  public.source_property_scope_resolution_revisions
to authenticated;
grant select, insert on
  public.source_property_scope_resolution_revisions
to service_role;

-- The policy tables keep the full set so a NEW version can be assembled and
-- approved; the freeze triggers hold the already-approved one, which a grant
-- could not do without also blocking the draft.
grant select, insert, update, delete on
  public.provider_hospitality_scope_policies,
  public.provider_hospitality_scope_policy_mappings,
  public.source_property_scope_resolutions
to authenticated;

grant all privileges on
  public.provider_hospitality_scope_policies,
  public.provider_hospitality_scope_policy_mappings,
  public.source_property_scope_resolutions
to service_role;

grant select on
  public.source_property_current_scope_resolutions
to authenticated, service_role;
