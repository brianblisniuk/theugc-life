-- 0031_prepublication_lifecycle_evidence.sql
--
-- PRE-PUBLICATION LIFECYCLE / CLOSURE EVIDENCE.
--
-- D062's condition 4 is "the property is not known inactive / closed", and there
-- was no evidence path to it. This migration builds one, and builds ONLY that.
--
-- THE QUESTION THIS LAYER ANSWERS
--
--   Does the LATEST COMPLETE provider evidence contain a CURRENT property-level
--   closure window for this source property, AS OF an explicit date?
--
-- THE QUESTIONS IT DOES NOT ANSWER
--
--   "Is the hotel active?"           — absence of closure evidence is not proof
--                                      of operation, and nothing here says it is.
--   "Is this hotel permanently closed?" — no provider date range means forever.
--   "Should this be published?"      — D062 will compose this with everything
--                                      else; this layer composes nothing.
--
-- WHY THE ANSWER CANNOT BE A STORED BOOLEAN
-- -----------------------------------------
-- A closure window changes its CURRENT meaning because the CALENDAR MOVED, with
-- no new provider statement at all. `2026-05-31 → 2026-08-31` means closed on
-- 2026-08-17 and not closed on 2026-09-01, and nothing about the evidence
-- differs between those two readings.
--
-- So a durable `hotel_active` / `current_lifecycle_status` column would be false
-- the day after it was written, and refreshing it would mean re-deriving 4,110
-- rows every calendar day to record a fact nobody stated. This migration stores
-- the EVIDENCE — the provider's own intervals — and the outcome is computed by
-- an evaluator that is HANDED an explicit `as_of` date. D062's receipt will
-- later record which date it used.
--
-- Additive only. Nothing existing is altered or dropped, and
-- `source_property_observations.source_lifecycle_status` is neither read nor
-- written by anything here: that column is a DIFFERENT provider field which is
-- NULL on all 4,110 current observations, and "no issues" must never be
-- laundered into "lifecycle = active".

-- ===========================================================================
-- 1. THE PROVIDER POLICY, AS DATA
-- ===========================================================================
-- The same shape 0028 and 0029 established, and for the same reason: the
-- mapping from a provider's vocabulary to our semantics is a REVIEWED PRODUCT
-- DECISION, and a reviewed decision that lives in a TypeScript literal cannot be
-- cited by an immutable record.
--
-- The rule this registry exists to make impossible to get wrong:
--
--   `issueType = CLOSED` DOES NOT MEAN THE HOTEL IS CLOSED.
--
-- Hotelbeds documents `issues[]` as incidences reported by the hotel about ITS
-- FACILITIES, and its own examples are facility-scoped — `OUTDOORPOOL` +
-- `CLOSED`. In the real cached Bali/Dubai evidence there are 13 `CLOSED` rows
-- and ELEVEN of them are a water park, a restaurant, a spa or a car park. A
-- generic "type = CLOSED → hotel closed" rule would therefore have closed eleven
-- operating hotels.
--
-- So the mapping is keyed on the PAIR (issue_code, issue_type), and only a pair
-- explicitly reviewed and inserted here carries lifecycle meaning.
create table public.provider_lifecycle_issue_policies (
  provider text not null,
  version text not null,
  -- The TWO provider fields this policy is contracted to read. Both are named
  -- because the pair is the key: reading only the type is the error above.
  issue_code_field text not null,
  issue_type_field text not null,
  -- The reviewed reading of the provider's date interval. Recorded rather than
  -- assumed, because "does dateTo include the last day?" is a policy question
  -- whose answer changes real outcomes at a boundary.
  date_semantics text not null
    check (date_semantics in ('inclusive_day_interval')),
  notes text,
  -- NULL = DRAFT: assemblable, and refused as the basis of any evaluation.
  -- Once set, the fields and the complete mapping set are immutable.
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (provider, version),
  constraint provider_lifecycle_issue_policies_fields_uk
    unique (provider, version, issue_code_field, issue_type_field)
);

comment on table public.provider_lifecycle_issue_policies is
  'Reviewed per-provider lifecycle-issue policies. Draft while approved_at is NULL; frozen and citable once set.';
comment on column public.provider_lifecycle_issue_policies.date_semantics is
  'How the provider''s interval is read. `inclusive_day_interval` = dateFrom <= as_of <= dateTo, both endpoints inside.';

create table public.provider_lifecycle_issue_policy_mappings (
  provider text not null,
  version text not null,
  issue_code_field text not null,
  issue_type_field text not null,
  issue_code text not null,
  issue_type text not null,
  -- ONE outcome exists, and that is the point. There is no `facility_closed`
  -- and no `open` in this domain:
  --
  --   * a facility closure is not lifecycle evidence, so it gets NO ROW rather
  --     than a row saying it is harmless — an unreviewed pair and a reviewed
  --     harmless one must not look identical;
  --   * nothing may map to "open", because no provider issue is evidence that a
  --     hotel is OPERATING. Absence of a closure is absence of a closure.
  outcome text not null check (outcome in ('property_closed_window')),
  primary key (provider, version, issue_code, issue_type),
  constraint provider_lifecycle_issue_policy_mappings_policy_fk
    foreign key (provider, version, issue_code_field, issue_type_field)
    references public.provider_lifecycle_issue_policies
      (provider, version, issue_code_field, issue_type_field)
    on delete restrict
);

comment on table public.provider_lifecycle_issue_policy_mappings is
  'Allow-list of reviewed (issue_code, issue_type) pairs that carry PROPERTY-LEVEL lifecycle meaning. An ABSENT pair is not lifecycle evidence — it is never "open" and never "closed".';

-- --------------------------------------------------------------------------
-- A POLICY VERSION IS FROZEN ONCE APPROVED
-- --------------------------------------------------------------------------
-- Same reasoning as 0028 §2 and 0029: an evaluation that cites
-- `hotelbeds/v1 → HOTEL+CLOSED = property_closed_window` is worthless if that
-- mapping can be edited inside the version the evaluation cites. A changed
-- semantic needs a NEW version, so the old reading stays readable.
create or replace function public.forbid_approved_lifecycle_policy_mutation()
returns trigger
language plpgsql
as $$
begin
  if old.approved_at is not null then
    raise exception
      'lifecycle-issue policy %/% was approved at % and is IMMUTABLE (attempted %). Create a NEW version instead.',
      old.provider, old.version, old.approved_at, tg_op
      using errcode = 'restrict_violation';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.forbid_approved_lifecycle_policy_mutation() from public;

create trigger provider_lifecycle_issue_policies_freeze
  before update or delete on public.provider_lifecycle_issue_policies
  for each row execute function public.forbid_approved_lifecycle_policy_mutation();

-- Both sides: the version a mapping LEAVES and the version it ARRIVES at. A
-- mapping moved INTO an approved version would extend a frozen policy after the
-- fact, which is the same falsification by a different route.
create or replace function public.forbid_approved_lifecycle_mapping_mutation()
returns trigger
language plpgsql
as $$
declare
  target record;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select provider, version, approved_at into target
      from public.provider_lifecycle_issue_policies
     where provider = old.provider and version = old.version;
    if found and target.approved_at is not null then
      raise exception
        'lifecycle-issue policy %/% is approved and its mappings are IMMUTABLE (attempted % on %/%).',
        old.provider, old.version, tg_op, old.issue_code, old.issue_type
        using errcode = 'restrict_violation';
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    select provider, version, approved_at into target
      from public.provider_lifecycle_issue_policies
     where provider = new.provider and version = new.version;
    if found and target.approved_at is not null then
      raise exception
        'lifecycle-issue policy %/% is approved and cannot gain mappings (attempted % of %/%).',
        new.provider, new.version, tg_op, new.issue_code, new.issue_type
        using errcode = 'restrict_violation';
    end if;
    return new;
  end if;

  return old;
end;
$$;

revoke all on function public.forbid_approved_lifecycle_mapping_mutation() from public;

create trigger provider_lifecycle_issue_policy_mappings_freeze
  before insert or update or delete on public.provider_lifecycle_issue_policy_mappings
  for each row execute function public.forbid_approved_lifecycle_mapping_mutation();

-- ===========================================================================
-- 2. THE SNAPSHOT — "WE EXTRACTED THIS OBSERVATION'S ISSUES COMPLETELY"
-- ===========================================================================
-- A child table of issue rows on its own CANNOT support this layer, because zero
-- rows would mean two incompatible things:
--
--   A) the provider reported no issues for this property;
--   B) nobody ever extracted the issues.
--
-- (A) is evidence. (B) is ignorance. Collapsing them would let an unextracted
-- property read as "no known closure", which is precisely the false negative
-- D062 must never act on.
--
-- So COMPLETENESS IS ITS OWN ROW. A snapshot exists only when a complete
-- provider record for that observation was processed; its absence is ignorance,
-- and the evaluator returns `unresolved` rather than guessing.
--
-- This matters concretely for Hotelbeds: the provider OMITS the `issues` key
-- entirely rather than sending an empty array — 3,936 of the 4,110 cached
-- records have no such key. `provider_issue_count = 0` on a snapshot therefore
-- means "the complete record carried no issues", which is a real provider
-- statement; no snapshot at all means nobody looked.
-- The FK below needs a unique target. `id` is already the primary key, so this
-- adds no new uniqueness rule and cannot fail on existing data — it exists
-- purely so `(observation, payload digest)` is referenceable. 0027 is untouched.
alter table public.source_property_observations
  add constraint source_property_observations_id_payload_uk
  unique (id, source_payload_digest);

create table public.source_property_issue_snapshots (
  id uuid primary key default gen_random_uuid(),

  source_property_identity_id uuid not null,
  source text not null,
  source_environment text not null check (source_environment in ('evaluation', 'production')),

  -- The observation whose provider record was processed. UNIQUE, because a
  -- second complete extraction of one immutable observation would be a second
  -- answer to a settled question.
  evidence_observation_id uuid not null,

  -- Only one status exists on purpose: a row here IS the completeness claim.
  -- An incomplete extraction does not get a row saying so, because a row saying
  -- "incomplete" would invite a reader to treat its zero issues as evidence.
  extraction_status text not null default 'complete'
    check (extraction_status in ('complete')),

  -- What the provider record actually carried. 0 is a statement, not a gap.
  provider_issue_count integer not null check (provider_issue_count >= 0),

  -- THE PROVENANCE BOUNDARY.
  --
  -- The digest of the WHOLE provider record this extraction read, which is the
  -- same value `source_property_observations.source_payload_digest` carries for
  -- the observation that record produced. Recording it is what makes the
  -- binding checkable rather than assumed: without it, "extract cached artifact
  -- A" and "attach to whichever observation is newest" are the same operation,
  -- and re-running an OLD artifact after a NEWER run exists would silently move
  -- old issue evidence onto a new observation and change the current lifecycle
  -- answer.
  --
  -- A digest of `issues[]` alone would not do: two runs can agree about the
  -- issues and disagree about everything else, so it does not identify the
  -- record. NOT NULL, because a snapshot that cannot say which provider record
  -- it came from is not provenance.
  source_payload_digest text not null,
  extraction_method text not null,
  extracted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint source_property_issue_snapshots_observation_uk unique (evidence_observation_id),
  constraint source_property_issue_snapshots_identity_fk
    foreign key (source_property_identity_id, source, source_environment)
    references public.source_property_identities (id, source, source_environment)
    on delete cascade,
  -- Composite, so the snapshot provably describes an observation OF THIS
  -- IDENTITY. A plain `-> observations(id)` would let a snapshot cite another
  -- property's evidence with every constraint satisfied.
  constraint source_property_issue_snapshots_evidence_fk
    foreign key (evidence_observation_id, source_property_identity_id)
    references public.source_property_observations (id, source_property_identity_id)
    on delete restrict,
  -- And the digest must be THAT observation's own. The composite FK above proves
  -- the snapshot describes an observation of the right PROPERTY; this one proves
  -- it describes the right MOMENT of that property. Both are needed: a property
  -- observed twice has two observations that satisfy the first constraint and
  -- only one that satisfies this.
  constraint source_property_issue_snapshots_payload_fk
    foreign key (evidence_observation_id, source_payload_digest)
    references public.source_property_observations (id, source_payload_digest)
    on delete restrict,
  -- Needed by the child table below, so an issue row cannot attach itself to a
  -- snapshot belonging to a different identity.
  constraint source_property_issue_snapshots_identity_uk unique (id, source_property_identity_id)
);

create index source_property_issue_snapshots_identity_idx
  on public.source_property_issue_snapshots (source_property_identity_id);
create index source_property_issue_snapshots_source_idx
  on public.source_property_issue_snapshots (source, source_environment);

comment on table public.source_property_issue_snapshots is
  'One row per source observation whose provider issue list was extracted COMPLETELY. Absence of a row is ignorance, not "no issues" — the evaluator returns unresolved.';
comment on column public.source_property_issue_snapshots.provider_issue_count is
  'Issues the complete provider record carried. 0 means the provider reported none; it does NOT mean nobody looked.';

-- ===========================================================================
-- 3. THE ISSUE ROWS — STRUCTURED, NOT PROSE
-- ===========================================================================
-- The provider's own fields, kept as fields. Lifecycle is never inferred from
-- `description` text, from a hotel's name, or from a destination label: a
-- free-text reading is not reconstructable and not reviewable, and D062 would be
-- acting on a sentence somebody's parser liked.
create table public.source_property_issue_evidence (
  id uuid primary key default gen_random_uuid(),

  snapshot_id uuid not null,
  source_property_identity_id uuid not null,

  -- The provider's vocabulary, verbatim. Not normalised, not mapped, not
  -- interpreted — the POLICY does the interpreting, at evaluation time, and it
  -- can only interpret what was actually recorded.
  issue_code text not null,
  issue_type text not null,

  -- PROVIDER TEXT, NOT `date`. This is the column the contract's "malformed
  -- evidence is preserved" promise actually rests on, and a `date` column
  -- cannot keep that promise:
  --
  --   * `2026-02-31` matches the shape of a date and IS NOT ONE. Postgres
  --     rejects the cast, so the whole extraction transaction rolls back and
  --     the evidence that should have produced `unresolved` is lost entirely;
  --   * `2026-08-31garbage` would have to be trimmed to fit, which invents a
  --     clean date the provider never sent and turns unreadable evidence into a
  --     confident closure window.
  --
  -- So the provider's bytes are stored verbatim and VALIDATION BELONGS TO THE
  -- EVALUATOR, which can tell "absent" from "present and unreadable" and report
  -- them as different reasons. NULL here means the provider omitted the field.
  date_from_raw text,
  date_to_raw text,

  provider_order integer,
  alternative boolean,
  -- Retained as internal evaluation evidence only: a reviewer looking at an
  -- `unresolved` needs to see what the provider actually said. It is never
  -- parsed, never matched against, and never published.
  description text,

  created_at timestamptz not null default now(),

  -- Content identity, so a replay recognises a row it already wrote. The
  -- provider's own order is part of it: two issues identical in every other
  -- field are two statements, not one.
  -- Over the RAW persisted values, so two issues differing only in a malformed
  -- date are two rows rather than one silently deduplicated one.
  evidence_digest text generated always as (
    md5(
      issue_code || '|' || issue_type || '|' ||
      coalesce(date_from_raw, '~null~') || '|' ||
      coalesce(date_to_raw, '~null~') || '|' ||
      coalesce(provider_order::text, '~null~') || '|' ||
      coalesce(alternative::text, '~null~')
    )
  ) stored,

  constraint source_property_issue_evidence_snapshot_fk
    foreign key (snapshot_id, source_property_identity_id)
    references public.source_property_issue_snapshots (id, source_property_identity_id)
    on delete restrict
);

create unique index source_property_issue_evidence_digest_uk
  on public.source_property_issue_evidence (snapshot_id, evidence_digest);
create index source_property_issue_evidence_identity_idx
  on public.source_property_issue_evidence (source_property_identity_id);
create index source_property_issue_evidence_code_type_idx
  on public.source_property_issue_evidence (issue_code, issue_type);

comment on table public.source_property_issue_evidence is
  'Structured provider issue rows for one snapshot. A malformed date range is PRESERVED, because it is what makes an evaluation unresolved rather than silently clean.';
comment on column public.source_property_issue_evidence.date_from_raw is
  'Provider dateFrom VERBATIM, as text. Never coerced, never trimmed to fit. NULL = the provider omitted it; a non-NULL unreadable value is a DIFFERENT fact, and both make a mapped closure unresolved rather than "no known closure".';

-- ===========================================================================
-- 4. EVIDENCE IS APPEND-ONLY
-- ===========================================================================
-- A snapshot is bound to an IMMUTABLE observation, so rewriting it would change
-- what the provider is recorded as having said at a moment that has already
-- passed. A newer provider statement is a NEW observation and a NEW snapshot —
-- which is exactly how star, location and scope evidence already behave.
create or replace function public.forbid_issue_evidence_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    '% on % is refused: provider issue evidence is APPEND-ONLY. A newer provider statement belongs to a new observation and a new snapshot.',
    tg_op, tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

revoke all on function public.forbid_issue_evidence_mutation() from public;

create trigger source_property_issue_snapshots_append_only
  before update or delete on public.source_property_issue_snapshots
  for each row execute function public.forbid_issue_evidence_mutation();

create trigger source_property_issue_evidence_append_only
  before update or delete on public.source_property_issue_evidence
  for each row execute function public.forbid_issue_evidence_mutation();

-- ===========================================================================
-- 5. ACCESS
-- ===========================================================================
-- Identical posture to 0027–0030: editorial/operational internals. `service_role`
-- plus admin/editor through RLS, NO anon grant, and an ordinary creator sees
-- nothing. A closure window is commercially sensitive operational evidence and
-- has no public reading.
alter table public.provider_lifecycle_issue_policies enable row level security;
alter table public.provider_lifecycle_issue_policy_mappings enable row level security;
alter table public.source_property_issue_snapshots enable row level security;
alter table public.source_property_issue_evidence enable row level security;

create policy provider_lifecycle_issue_policies_admin
  on public.provider_lifecycle_issue_policies
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy provider_lifecycle_issue_policy_mappings_admin
  on public.provider_lifecycle_issue_policy_mappings
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy source_property_issue_snapshots_admin
  on public.source_property_issue_snapshots
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy source_property_issue_evidence_admin
  on public.source_property_issue_evidence
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());

-- PRIVILEGES — stated, not inherited (D046).
--
-- No anon grant anywhere. The evidence tables are APPEND-ONLY, so NO role —
-- service_role included — holds UPDATE or DELETE on them; the triggers above
-- are the second layer, not the only one.
grant select, insert on
  public.source_property_issue_snapshots,
  public.source_property_issue_evidence
to authenticated;

grant select, insert on
  public.source_property_issue_snapshots,
  public.source_property_issue_evidence
to service_role;

-- The policy tables keep the full set so a NEW version can be assembled and
-- approved; the freeze triggers hold the already-approved one, which a grant
-- could not do without also blocking the draft.
grant select, insert, update, delete on
  public.provider_lifecycle_issue_policies,
  public.provider_lifecycle_issue_policy_mappings
to authenticated;

grant all privileges on
  public.provider_lifecycle_issue_policies,
  public.provider_lifecycle_issue_policy_mappings
to service_role;

-- ===========================================================================
-- 6. THE APPROVED HOTELBEDS V1 POLICY
-- ===========================================================================
-- Sourced from the provider's own documentation of `issues[]` —
-- https://developer.hotelbeds.com/documentation/hotels/content-api/issues/ —
-- which defines the array as incidences the hotel reports about its facilities,
-- with `dateFrom` the date the issue starts and `dateTo` the date it ends.
--
-- EXACTLY ONE PAIR is approved as property-level lifecycle evidence.
-- Seeded as a DRAFT, mapped, then approved — the freeze trigger refuses a
-- mapping inserted into an already-approved version, which is the guarantee
-- working exactly as intended.
insert into public.provider_lifecycle_issue_policies
  (provider, version, issue_code_field, issue_type_field, date_semantics, notes)
values (
  'hotelbeds', 'hotelbeds-lifecycle-issue/1', 'issueCode', 'issueType', 'inclusive_day_interval',
  'Hotelbeds documents issues[] as hotel-reported incidences about its FACILITIES, and its own examples are facility-scoped (OUTDOORPOOL + CLOSED). '
  'issueType alone therefore carries no property-level meaning: in the reviewed Bali/Dubai evidence 13 rows are CLOSED and 11 of them are a water park, '
  'restaurant, spa or car park. Only the PAIR (HOTEL, CLOSED) is approved as a property-level closure window. '
  'Dates are read as an inclusive day interval, dateFrom <= as_of <= dateTo, per the documented "date on which the issue starts/ends". '
  'A closure window is a DATE RANGE and never permanent closure, however distant dateTo may be.'
);

insert into public.provider_lifecycle_issue_policy_mappings
  (provider, version, issue_code_field, issue_type_field, issue_code, issue_type, outcome)
values ('hotelbeds', 'hotelbeds-lifecycle-issue/1', 'issueCode', 'issueType',
        'HOTEL', 'CLOSED', 'property_closed_window');

-- Frozen. From here the only way to change any of the above is a new version.
update public.provider_lifecycle_issue_policies
   set approved_at = now()
 where provider = 'hotelbeds' and version = 'hotelbeds-lifecycle-issue/1';
