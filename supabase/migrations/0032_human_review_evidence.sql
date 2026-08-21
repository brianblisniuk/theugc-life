-- ===========================================================================
-- 0032 — HUMAN PRE-PUBLICATION REVIEW EVIDENCE (A04.5)
-- ===========================================================================
-- A04 previews D062's eleven conditions. Two of them — canonical property
-- identity (1) and supported canonical destination (2) — cannot be satisfied by
-- provider evidence at all: they require a human to say "this source identity
-- is a distinct property, and it belongs to THIS supported destination".
--
-- 0027 already stores the DECISION (`source_property_reviews`) and the FINDING
-- (`source_match_candidates.candidate_kind = 'new_property'`). Neither is a
-- RECEIPT. Both are mutable current-state rows, neither names the observation
-- the human actually looked at, and neither records what was checked. So an
-- approved decision could not be distinguished from the same decision made
-- against evidence that has since been replaced — which is precisely the
-- failure A04 spent three amendments removing from the machine layers.
--
-- This migration adds the missing durable half, and nothing else:
--
--   * `source_property_review_receipts`             what was decided, against WHICH evidence
--   * `source_property_review_verifications`        what the human checked, per dimension
--   * `source_property_review_evidence_references`  what the human consulted
--
-- All three are APPEND-ONLY. A receipt describes a decision taken at a moment
-- that has already passed; a later decision is a later receipt.
--
-- NOT in this migration: canonical publication, `hotels`, `hotel_source_identities`,
-- `resolution_state` transitions, approve_match, review supersession/correction,
-- or any automatic destination inference.

-- ===========================================================================
-- 1. ADDITIVE UNIQUE TARGETS FOR COMPOSITE PROVENANCE
-- ===========================================================================
-- 0031 established the pattern: a composite FK is how "this evidence belongs to
-- THAT exact row" stops being a convention and becomes unrepresentable-if-wrong.
-- Both column pairs below are already unique via the primary key, so these add
-- a reference target and no new restriction. 0027–0031 are not modified.

-- Lets a receipt require that the observation it cites belongs to the identity
-- it claims to be about. Without it, a receipt could cite another identity's
-- observation and every column would still be individually valid.
alter table public.source_property_observations
  add constraint source_property_observations_id_identity_uk
  unique (id, source_property_identity_id);

-- Same, for the accepted human `new_property` finding a receipt cites.
alter table public.source_match_candidates
  add constraint source_match_candidates_id_identity_uk
  unique (id, source_property_identity_id);

-- ===========================================================================
-- 2. THE RECEIPT
-- ===========================================================================
create table public.source_property_review_receipts (
  id uuid primary key default gen_random_uuid(),

  source_property_identity_id uuid not null,
  -- Denormalised so the receipt stays readable standalone, and CONSTRAINED to
  -- equal the identity's own values by the composite FK below. A denormalised
  -- column nobody constrains is a second truth waiting to drift.
  source text not null,
  source_environment text not null check (source_environment in ('evaluation', 'production')),
  source_property_id text not null,

  -- THE CURRENTNESS BOUNDARY.
  --
  -- The observation the human actually reviewed, plus the run that produced it
  -- and the whole-record digest that observation carried. A04 compares these to
  -- the identity's CURRENT observation: when they differ, the receipt describes
  -- a decision about evidence that is no longer current, and conditions 1 and 2
  -- HOLD rather than silently inheriting the old judgement.
  evidence_observation_id uuid not null,
  evidence_source_run_id uuid not null,
  source_payload_digest text not null,

  -- A04's pre-review preview fingerprint, taken at prepare time over the same
  -- identity/as-of. Apply refuses when it no longer matches: the coordinates,
  -- star revision or entity state can move without the observation changing.
  prereview_fingerprint text not null
    check (prereview_fingerprint ~ '^[0-9a-f]{64}$'),
  prereview_fingerprint_algorithm text not null default 'sha256'
    check (prereview_fingerprint_algorithm = 'sha256'),
  prereview_as_of date not null,

  -- V1 PILOT VOCABULARY. `approve_match` is deliberately absent: it requires an
  -- existing canonical hotel, `hotels` is empty, and the first publication in
  -- system history must therefore begin with `approve_create`. `reject` is
  -- absent because a final exclusion is a different decision with different
  -- consequences, and this pilot does not implement it.
  decision text not null check (decision in ('approve_create', 'defer')),

  -- The reviewed canonical destination. Never inferred from provider geography.
  destination_id uuid references public.destinations(id),
  -- The accepted human `new_property` finding this decision rests on.
  new_property_finding_id uuid,

  reviewer_user_id uuid references public.users(id),
  reviewer_label text not null check (length(btrim(reviewer_label)) > 0),
  review_note text,

  -- Content digest of the semantic decision, computed by the writer over the
  -- same fields listed in the A04.5 contract. Used to tell an EXACT replay
  -- (same digest -> already applied, write nothing) from a materially different
  -- second review of the same evidence (different digest -> refused). Stored
  -- rather than GENERATED because `timestamptz` has no immutable text cast, so
  -- a generated expression over `reviewed_at` could not be indexed; this
  -- follows 0031's `source_payload_digest`, which is stored for the same reason.
  receipt_digest text not null check (receipt_digest ~ '^[0-9a-f]{64}$'),

  reviewed_at timestamptz not null,
  created_at timestamptz not null default now(),

  -- APPROVE_CREATE needs a destination and a finding; DEFER must have neither,
  -- and must say why. "Uncertainty remains uncertainty" is only true if the
  -- schema refuses to let a defer carry the artefacts of an approval.
  constraint source_property_review_receipts_decision_shape check (
    (decision = 'approve_create'
       and destination_id is not null
       and new_property_finding_id is not null)
    or (decision = 'defer'
       and destination_id is null
       and new_property_finding_id is null
       and review_note is not null and length(btrim(review_note)) > 0)
  ),

  -- PROVENANCE — four bindings, none of them convention.
  constraint source_property_review_receipts_identity_fk
    foreign key (source_property_identity_id, source, source_environment, source_property_id)
    references public.source_property_identities (id, source, source_environment, source_property_id)
    on delete restrict,
  -- the observation belongs to THIS identity
  constraint source_property_review_receipts_observation_fk
    foreign key (evidence_observation_id, source_property_identity_id)
    references public.source_property_observations (id, source_property_identity_id)
    on delete restrict,
  -- ...and carried THIS digest
  constraint source_property_review_receipts_payload_fk
    foreign key (evidence_observation_id, source_payload_digest)
    references public.source_property_observations (id, source_payload_digest)
    on delete restrict,
  -- ...and came from THIS run
  constraint source_property_review_receipts_run_fk
    foreign key (evidence_observation_id, evidence_source_run_id)
    references public.source_property_observations (id, source_run_id)
    on delete restrict,
  -- the cited finding belongs to THIS identity too
  constraint source_property_review_receipts_finding_fk
    foreign key (new_property_finding_id, source_property_identity_id)
    references public.source_match_candidates (id, source_property_identity_id)
    on delete restrict
);

-- ONE receipt per (identity, reviewed observation). A second decision about the
-- SAME evidence is not a replay, it is a contradiction, and the writer refuses
-- it before reaching this index; the index is the layer that does not depend on
-- the writer being correct. A new observation may of course be reviewed again.
create unique index source_property_review_receipts_identity_observation_uk
  on public.source_property_review_receipts
     (source_property_identity_id, evidence_observation_id);

create index source_property_review_receipts_identity_idx
  on public.source_property_review_receipts (source_property_identity_id);
create index source_property_review_receipts_digest_idx
  on public.source_property_review_receipts (receipt_digest);

comment on table public.source_property_review_receipts is
  'Immutable receipt of a human pre-publication review, bound to the exact observation/run/digest reviewed. A04 conditions 1 and 2 cite it; a receipt bound to a non-current observation HOLDS them.';

-- ===========================================================================
-- 3. WHAT THE HUMAN CHECKED
-- ===========================================================================
-- "approved" is not a review. Six dimensions are recorded separately, each with
-- an explicit state, because the failure this layer exists to prevent is a
-- reviewer approving a destination on a name while the coordinates said
-- something else.
--
-- `unavailable` is NOT `supports`. The provider not supplying an address is not
-- evidence that the address agrees, and collapsing the two would turn missing
-- data into a positive finding — the same rule 0027 already applies to machine
-- evidence columns.
create table public.source_property_review_verifications (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null
    references public.source_property_review_receipts(id) on delete restrict,
  dimension text not null check (dimension in (
    'distinct_property',
    'name',
    'city_locality',
    'address',
    'coordinates',
    'destination_membership'
  )),
  verdict text not null check (verdict in ('supports', 'contradicts', 'unavailable')),
  note text,
  created_at timestamptz not null default now(),

  constraint source_property_review_verifications_dimension_uk
    unique (receipt_id, dimension),

  -- A contradiction is allowed — provider coordinates may be wrong while an
  -- official address settles the destination — but it may never pass silently.
  -- The reviewer must say how it was resolved.
  constraint source_property_review_verifications_contradiction_needs_note check (
    verdict <> 'contradicts' or (note is not null and length(btrim(note)) > 0)
  )
);

create index source_property_review_verifications_receipt_idx
  on public.source_property_review_verifications (receipt_id);

comment on table public.source_property_review_verifications is
  'Per-dimension record of what a human actually checked. unavailable is never silently promoted to supports; a contradiction requires a written explanation.';

-- ===========================================================================
-- 4. WHAT THE HUMAN CONSULTED
-- ===========================================================================
-- The references are recorded, never fetched. Nothing in the apply path calls
-- out to any of these locators: a review is the human's assertion about what
-- they read, and a machine re-fetch would be a different claim made at a
-- different time.
create table public.source_property_review_evidence_references (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null
    references public.source_property_review_receipts(id) on delete restrict,
  reference_kind text not null check (reference_kind in (
    'official_property_site',
    'official_brand_page',
    'official_address_page',
    'map_place_source',
    'other_public_authoritative'
  )),
  locator text not null check (length(btrim(locator)) > 0),
  -- Which dimensions this reference bears on. An array rather than a join table
  -- because one authoritative page routinely establishes several facts at once,
  -- and this is not a count anybody may threshold on.
  bears_on_dimensions text[] not null
    check (
      array_length(bears_on_dimensions, 1) >= 1
      and bears_on_dimensions <@ array[
        'distinct_property','name','city_locality','address','coordinates','destination_membership'
      ]::text[]
    ),
  stance text not null check (stance in ('supports', 'contradicts')),
  note text,
  created_at timestamptz not null default now()
);

create index source_property_review_evidence_references_receipt_idx
  on public.source_property_review_evidence_references (receipt_id);

comment on table public.source_property_review_evidence_references is
  'Structured references a human consulted. Never fetched by the apply path. An approve_create receipt with none is refused.';

-- ===========================================================================
-- 5. APPEND-ONLY
-- ===========================================================================
create or replace function public.forbid_review_receipt_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    '% on % is refused: a human review receipt is APPEND-ONLY. A later decision is a later receipt against later evidence.',
    tg_op, tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

revoke all on function public.forbid_review_receipt_mutation() from public;

create trigger source_property_review_receipts_append_only
  before update or delete on public.source_property_review_receipts
  for each row execute function public.forbid_review_receipt_mutation();

create trigger source_property_review_verifications_append_only
  before update or delete on public.source_property_review_verifications
  for each row execute function public.forbid_review_receipt_mutation();

create trigger source_property_review_evidence_references_append_only
  before update or delete on public.source_property_review_evidence_references
  for each row execute function public.forbid_review_receipt_mutation();

-- ===========================================================================
-- 6. AN APPROVE_CREATE RECEIPT IS COMPLETE OR IT DOES NOT EXIST
-- ===========================================================================
-- The completeness rules span rows, so no CHECK can express them. A DEFERRED
-- constraint trigger can: it runs at COMMIT, by which time the receipt and all
-- its children are visible, and it fails the WHOLE transaction — which is the
-- required behaviour anyway ("no receipt claiming a decision that did not
-- become current").
create or replace function public.enforce_approve_create_receipt_completeness()
returns trigger
language plpgsql
as $$
declare
  dimension_count integer;
  distinct_verdict text;
  destination_verdict text;
  reference_count integer;
begin
  if new.decision <> 'approve_create' then
    return null;
  end if;

  select count(*) into dimension_count
    from public.source_property_review_verifications v
   where v.receipt_id = new.id;

  if dimension_count <> 6 then
    raise exception
      'approve_create receipt % records % of 6 review dimensions. Every dimension needs an explicit state; a dimension whose provider field is NULL is recorded as unavailable, not omitted.',
      new.id, dimension_count
      using errcode = 'restrict_violation';
  end if;

  select v.verdict into distinct_verdict
    from public.source_property_review_verifications v
   where v.receipt_id = new.id and v.dimension = 'distinct_property';
  if distinct_verdict is distinct from 'supports' then
    raise exception
      'approve_create receipt % has distinct_property = %. Creating a canonical property requires an affirmative distinct-property verdict; absence of a machine candidate is not one.',
      new.id, coalesce(distinct_verdict, 'missing')
      using errcode = 'restrict_violation';
  end if;

  select v.verdict into destination_verdict
    from public.source_property_review_verifications v
   where v.receipt_id = new.id and v.dimension = 'destination_membership';
  if destination_verdict is distinct from 'supports' then
    raise exception
      'approve_create receipt % has destination_membership = %. A supported canonical destination requires an affirmative verdict; provider geography is not a destination decision.',
      new.id, coalesce(destination_verdict, 'missing')
      using errcode = 'restrict_violation';
  end if;

  select count(*) into reference_count
    from public.source_property_review_evidence_references r
   where r.receipt_id = new.id;
  if reference_count < 1 then
    raise exception
      'approve_create receipt % cites no external evidence reference. This is not a source count: one authoritative reference may establish several facts, but zero establishes none.',
      new.id
      using errcode = 'restrict_violation';
  end if;

  return null;
end;
$$;

revoke all on function public.enforce_approve_create_receipt_completeness() from public;

create constraint trigger source_property_review_receipts_complete
  after insert on public.source_property_review_receipts
  deferrable initially deferred
  for each row execute function public.enforce_approve_create_receipt_completeness();

-- ===========================================================================
-- 7. ACCESS
-- ===========================================================================
-- Human review evidence is internal operational provenance, not creator-facing
-- hotel intelligence. Identical posture to 0027–0031: admin/editor through RLS
-- plus `service_role`, NO anon grant, and an ordinary creator sees nothing.
--
-- The tables are APPEND-ONLY, so NO role — `service_role` included — holds
-- UPDATE or DELETE. The triggers in §5 are the second layer, not the only one.
alter table public.source_property_review_receipts enable row level security;
alter table public.source_property_review_verifications enable row level security;
alter table public.source_property_review_evidence_references enable row level security;

create policy source_property_review_receipts_admin
  on public.source_property_review_receipts
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy source_property_review_verifications_admin
  on public.source_property_review_verifications
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());
create policy source_property_review_evidence_references_admin
  on public.source_property_review_evidence_references
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());

grant select, insert on
  public.source_property_review_receipts,
  public.source_property_review_verifications,
  public.source_property_review_evidence_references
to authenticated;

grant select, insert on
  public.source_property_review_receipts,
  public.source_property_review_verifications,
  public.source_property_review_evidence_references
to service_role;
