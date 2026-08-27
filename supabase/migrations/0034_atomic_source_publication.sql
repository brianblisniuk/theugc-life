-- ===========================================================================
-- 0034 — ATOMIC SOURCE PUBLICATION (A05)
-- ===========================================================================
-- A04 previews D062's eleven conditions. A04.5 records the human decision two
-- of them depend on. A04.6 lets a human withdraw that decision. None of them
-- publishes anything, and none of them writes a canonical row.
--
-- A05 crosses the irreversible boundary:
--
--   an explicitly PUBLICATION-AUTHORIZED, PRODUCTION source identity carrying a
--   current 11/11 D062 PASS becomes a canonical hotel, an ACTIVE canonical
--   source link and a `resolved_eligible` source identity — in ONE transaction,
--   with immutable publication provenance, or not at all.
--
-- A D062 PASS is NECESSARY and is NOT authorization. "Everything checks out" and
-- "publish this" are different sentences, and the second one is a human's to
-- say. That separation is why this migration adds an authorization-bearing
-- receipt rather than a `published` boolean on something that already exists.
--
-- WHAT THIS MIGRATION ADDS
--   * `source_property_publication_receipts` — the immutable publication event
--   * one additive unique target so a receipt can composite-FK the review
--     receipt's own accepted finding
--   * `enforce_publication_receipt_evidence()` — the canonical row must be
--     supported by the evidence the receipt cites, checked at INSERT
--   * `assert_publication_state_coherent()` — deferred to COMMIT, on BOTH
--     tables: a publication receipt exists IFF its identity is `resolved_eligible`
--     against that exact hotel
--
-- WHAT IT DOES NOT ADD
--   No `approve_match` publication. No `hotel_contacts`. No media, website,
--   description or intelligence policy. No `publication_status` column and no
--   draft-canonical tier (D062: a row in `hotels` IS publication). No change to
--   migrations 0027–0033.
--
-- MIGRATIONS NEVER PUBLISH. This file creates structure only: it inserts no
-- `hotels` row, creates no link, and moves no `resolution_state`. An existing
-- database — including one carrying the A04.7 evaluation pilot's eight 11/11
-- PASS identities — migrates with hotels still 0 and links still 0.

-- ===========================================================================
-- 1. ADDITIVE UNIQUE TARGET FOR COMPOSITE PROVENANCE
-- ===========================================================================
-- Every other binding this receipt needs already has a target: 0028 made the
-- star and location revisions unique on `(id, source_property_identity_id)`,
-- 0029 did the same for scope, 0032 for observations and match candidates, 0033
-- for review receipts, and 0027 for the canonical link pair
-- `(source_property_identity_id, hotel_id)`.
--
-- The one that does not exist yet is the pair below. It lets the publication
-- receipt require that the finding it cites is the finding THAT REVIEW RECEIPT
-- rests on, rather than merely some accepted finding of the same identity. `id`
-- is already the primary key, so this adds a reference target and no new
-- restriction, and 0033 is not modified.
alter table public.source_property_review_receipts
  add constraint source_property_review_receipts_id_finding_uk
  unique (id, new_property_finding_id);

-- ===========================================================================
-- 2. THE PUBLICATION RECEIPT
-- ===========================================================================
-- One row means exactly:
--
--   "THIS exact production source identity, against THIS exact D062 PASS and
--    THIS exact human review authorization, created THIS canonical hotel —
--    because THIS human explicitly authorized publication, at this time, for
--    this stated reason."
--
-- It is not a status column and not a cache. It is the answer to "why does this
-- hotel exist?", written once, at the moment it started existing.
create table public.source_property_publication_receipts (
  id uuid primary key default gen_random_uuid(),

  source_property_identity_id uuid not null,
  -- Denormalised so the receipt reads standalone, and CONSTRAINED to equal the
  -- identity's own values by the composite FK below. A denormalised column
  -- nobody constrains is a second truth waiting to drift (0027, 0032).
  source text not null,
  source_environment text not null,
  source_property_id text not null,

  -- The canonical row this publication created. RESTRICT, not CASCADE: deleting
  -- a hotel must not silently delete the record of how it came to exist.
  hotel_id uuid not null references public.hotels(id) on delete restrict,

  -- ---- THE EVIDENCE THIS PUBLICATION RESTS ON -----------------------------
  -- The observation that was current at publication. Every canonical field
  -- copied from provider text (name, address) came from THIS row, and the human
  -- review receipt below cites the same one — checked in §4.
  evidence_observation_id uuid not null,
  -- The A04.5 receipt carrying the human `approve_create`, and the accepted
  -- human-owned `new_property` finding that receipt rests on.
  human_review_receipt_id uuid not null,
  human_new_property_finding_id uuid not null,

  -- The immutable resolution revisions the canonical star, coordinates and
  -- hospitality scope came from. Not "some revision" — §4 requires each to be
  -- the identity's CURRENT head revision at the moment of publication.
  star_revision_id uuid not null,
  location_revision_id uuid not null,
  scope_revision_id uuid not null,

  -- ---- THE D062 VERDICT ---------------------------------------------------
  -- The preview is evaluated AS OF an explicit date; a verdict without its
  -- as-of is not reproducible. The fingerprint is the whole semantic bundle,
  -- so it is what makes "the evidence has not moved" checkable later.
  preview_as_of date not null,
  preview_schema_version text not null check (length(btrim(preview_schema_version)) > 0),
  preview_fingerprint text not null check (preview_fingerprint ~ '^[0-9a-f]{64}$'),
  preview_fingerprint_algorithm text not null default 'sha256'
    check (preview_fingerprint_algorithm = 'sha256'),

  -- ---- THE HUMAN PUBLICATION AUTHORIZATION --------------------------------
  -- Separate from the review authorization above, and deliberately so. A04.5
  -- answers "what did the human decide about identity and destination?"; this
  -- answers "did a human say publish it?". `--apply` is not a human.
  publication_authorized_by_user_id uuid references public.users(id),
  publication_authorized_by_label text not null
    check (length(btrim(publication_authorized_by_label)) > 0),
  -- Required and non-empty, for the same reason 0033's `revocation_note` is: an
  -- irreversible action with no stated reason is not auditable.
  authorization_note text not null check (length(btrim(authorization_note)) > 0),
  authorized_at timestamptz not null,

  -- Content digest of the authorized publication, computed by the application
  -- over the manifest's pins and the human authorization — deliberately NOT
  -- over `authorized_at`, so an exact replay is not called "different" merely
  -- because the clock moved. Stored rather than GENERATED for 0031/0032/0033's
  -- reason: `timestamptz` has no immutable text cast.
  publication_digest text not null check (publication_digest ~ '^[0-9a-f]{64}$'),
  publication_digest_algorithm text not null default 'sha256'
    check (publication_digest_algorithm = 'sha256'),

  created_at timestamptz not null default now(),

  -- EVALUATION DATA NEVER BECOMES CANONICAL DATA. 0027 already makes an
  -- evaluation identity unlinkable and ineligible; this says the same thing
  -- about the publication event, so the wall does not depend on reading two
  -- other tables. The composite FK below is what makes this CHECK true of the
  -- IDENTITY rather than merely of this row's label.
  constraint source_property_publication_receipts_production_only
    check (source_environment = 'production'),

  -- ---- PROVENANCE: NONE OF IT CONVENTION ----------------------------------
  constraint source_property_publication_receipts_identity_fk
    foreign key (source_property_identity_id, source, source_environment, source_property_id)
    references public.source_property_identities (id, source, source_environment, source_property_id)
    on delete restrict,
  -- the published observation belongs to THIS identity
  constraint source_property_publication_receipts_observation_fk
    foreign key (evidence_observation_id, source_property_identity_id)
    references public.source_property_observations (id, source_property_identity_id)
    on delete restrict,
  -- the human review receipt belongs to THIS identity
  constraint source_property_publication_receipts_review_fk
    foreign key (human_review_receipt_id, source_property_identity_id)
    references public.source_property_review_receipts (id, source_property_identity_id)
    on delete restrict,
  -- ...and the finding cited here is THAT receipt's own finding, not merely
  -- another accepted finding belonging to the same identity
  constraint source_property_publication_receipts_review_finding_fk
    foreign key (human_review_receipt_id, human_new_property_finding_id)
    references public.source_property_review_receipts (id, new_property_finding_id)
    on delete restrict,
  -- ...which is in turn a candidate row of THIS identity
  constraint source_property_publication_receipts_finding_fk
    foreign key (human_new_property_finding_id, source_property_identity_id)
    references public.source_match_candidates (id, source_property_identity_id)
    on delete restrict,
  -- each cited resolution revision belongs to THIS identity
  constraint source_property_publication_receipts_star_fk
    foreign key (star_revision_id, source_property_identity_id)
    references public.source_property_star_resolution_revisions (id, source_property_identity_id)
    on delete restrict,
  constraint source_property_publication_receipts_location_fk
    foreign key (location_revision_id, source_property_identity_id)
    references public.source_property_location_resolution_revisions (id, source_property_identity_id)
    on delete restrict,
  constraint source_property_publication_receipts_scope_fk
    foreign key (scope_revision_id, source_property_identity_id)
    references public.source_property_scope_resolution_revisions (id, source_property_identity_id)
    on delete restrict,
  -- THE CANONICAL LINK MUST EXIST, and must be this identity's link to this
  -- exact hotel. Without this a receipt could name a hotel produced by some
  -- other identity's publication and every column would still be valid.
  constraint source_property_publication_receipts_link_fk
    foreign key (source_property_identity_id, hotel_id)
    references public.hotel_source_identities (source_property_identity_id, hotel_id)
    on delete restrict,

  -- ONE canonical hotel per source identity, in this approve_create V1 path. A
  -- second publication of the same identity is not a replay, it is a duplicate
  -- canonical property — the exact failure D063 §12.2 refuses to risk. The
  -- application answers `already_published` before reaching this index; the
  -- index is the layer that does not depend on the application being correct.
  constraint source_property_publication_receipts_identity_uk
    unique (source_property_identity_id),
  -- ...and one publication event per hotel. Two identities cannot both claim to
  -- have created the same canonical row; a second source identity for an
  -- existing hotel is `approve_match`, which V1 does not implement.
  constraint source_property_publication_receipts_hotel_uk unique (hotel_id)
);

create index source_property_publication_receipts_digest_idx
  on public.source_property_publication_receipts (publication_digest);
create index source_property_publication_receipts_authorized_idx
  on public.source_property_publication_receipts (authorized_at desc);

comment on table public.source_property_publication_receipts is
  'APPEND-ONLY. One production source identity, one D062 PASS, one human publication authorization, one canonical hotel. See A05_ATOMIC_D062_PUBLICATION_CONTRACT.md.';
comment on column public.source_property_publication_receipts.preview_fingerprint is
  'The D062 semantic fingerprint recomputed INSIDE the publication transaction. A prepared fingerprint is a pin, never cached authorization.';
comment on column public.source_property_publication_receipts.authorization_note is
  'Required and non-empty. Publication is irreversible in V1; an irreversible action with no stated reason is not auditable.';

-- ===========================================================================
-- 3. APPEND-ONLY BY TRIGGER
-- ===========================================================================
-- The grants in §6 are the first layer; this is the second, and it refuses even
-- the table owner. A publication receipt records that a human authorized an
-- irreversible action at a moment that has passed. Editing it would change what
-- is recorded as having happened, and there is no un-publish in V1 for it to
-- describe.
create or replace function public.forbid_publication_receipt_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    '% on % is refused: a source publication receipt is APPEND-ONLY. Publication is irreversible in V1; correcting a canonical property is a separate, unimplemented workflow.',
    tg_op, tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

revoke all on function public.forbid_publication_receipt_mutation() from public;

create trigger source_property_publication_receipts_append_only
  before update or delete on public.source_property_publication_receipts
  for each row execute function public.forbid_publication_receipt_mutation();

-- ===========================================================================
-- 4. THE CANONICAL ROW MUST BE SUPPORTED BY THE EVIDENCE THE RECEIPT CITES
-- ===========================================================================
-- Every composite FK above proves the cited evidence BELONGS to this identity.
-- None of them proves the published hotel says what that evidence says — a
-- writer could cite the real star revision and still publish 3 stars, cite the
-- real location revision and still publish the raw provider coordinates, or
-- publish into a destination the human never named.
--
-- That is exactly the class of bug the A05 canonical field policy exists to
-- prevent, so the policy is enforced here as well as in the writer. The writer
-- is one program; this is a property of the database.
create or replace function public.enforce_publication_receipt_evidence()
returns trigger
language plpgsql
as $$
declare
  review record;
  finding record;
  star record;
  loc record;
  scope record;
  hotel record;
  head_id uuid;
begin
  select r.decision, r.destination_id, r.evidence_observation_id
    into review
    from public.source_property_review_receipts r
   where r.id = new.human_review_receipt_id;

  -- A `defer` receipt authorizes nothing, and `approve_match`/`reject` are not
  -- in 0032's vocabulary at all. Stated explicitly rather than inferred from the
  -- presence of a finding.
  if review.decision is distinct from 'approve_create' then
    raise exception
      'publication receipt for identity % cites human review receipt % whose decision is %. Only an approve_create authorizes creating a canonical property.',
      new.source_property_identity_id, new.human_review_receipt_id, coalesce(review.decision, 'missing')
      using errcode = 'integrity_constraint_violation';
  end if;

  -- The human reviewed THIS observation. A receipt about superseded evidence is
  -- not a decision about what is being published; D062 already holds conditions
  -- 1 and 2 in that case, and the database says so independently.
  if review.evidence_observation_id is distinct from new.evidence_observation_id then
    raise exception
      'publication receipt for identity % publishes observation % while the cited human review receipt % reviewed observation %. A decision about superseded evidence is not authorization for today''s evidence.',
      new.source_property_identity_id, new.evidence_observation_id,
      new.human_review_receipt_id, review.evidence_observation_id
      using errcode = 'integrity_constraint_violation';
  end if;

  -- The finding must still be the ACCEPTED, HUMAN-OWNED new_property finding.
  -- The composite FKs prove which row it is; this proves what it says.
  select c.candidate_kind, c.status, c.match_method
    into finding
    from public.source_match_candidates c
   where c.id = new.human_new_property_finding_id;
  if finding.candidate_kind is distinct from 'new_property'
     or finding.status is distinct from 'accepted'
     or finding.match_method is distinct from 'human_review:distinct_property' then
    raise exception
      'publication receipt for identity % cites finding % (kind=%, status=%, method=%). Creating a canonical property requires the ACCEPTED human-owned new_property finding; a machine candidate is not a human decision.',
      new.source_property_identity_id, new.human_new_property_finding_id,
      coalesce(finding.candidate_kind, 'missing'), coalesce(finding.status, 'missing'),
      coalesce(finding.match_method, 'missing')
      using errcode = 'integrity_constraint_violation';
  end if;

  select h.destination_id, h.star_rating, h.latitude, h.longitude, h.active_status
    into hotel
    from public.hotels h
   where h.id = new.hotel_id;

  -- The destination is a HUMAN decision (A04.5 §11): never inferred from
  -- provider geography, and therefore never diverging from the receipt either.
  if hotel.destination_id is distinct from review.destination_id then
    raise exception
      'publication receipt for identity % published hotel % into destination % while the human reviewed destination %. The canonical destination is the human decision, not the writer''s.',
      new.source_property_identity_id, new.hotel_id, hotel.destination_id, review.destination_id
      using errcode = 'integrity_constraint_violation';
  end if;

  -- STAR. D062 condition 6 is "exactly four or five", and the value published
  -- must be the resolved one, not a provider shortcut.
  select r.outcome, r.resolved_star_value into star
    from public.source_property_star_resolution_revisions r where r.id = new.star_revision_id;
  select h.current_revision_id into head_id
    from public.source_property_star_resolutions h
   where h.source_property_identity_id = new.source_property_identity_id;
  if head_id is distinct from new.star_revision_id then
    raise exception
      'publication receipt for identity % cites star revision %, which is not that identity''s CURRENT head revision (%). Publication reads current resolution, never history.',
      new.source_property_identity_id, new.star_revision_id, coalesce(head_id::text, 'none')
      using errcode = 'integrity_constraint_violation';
  end if;
  if star.outcome not in ('exact_four', 'exact_five')
     or hotel.star_rating is distinct from star.resolved_star_value then
    raise exception
      'publication receipt for identity % published star_rating % while star revision % resolved % (%). D062 condition 6 admits exactly four or five, taken from the resolution layer.',
      new.source_property_identity_id, coalesce(hotel.star_rating::text, 'null'),
      new.star_revision_id, coalesce(star.resolved_star_value::text, 'null'),
      coalesce(star.outcome, 'missing')
      using errcode = 'integrity_constraint_violation';
  end if;

  -- COORDINATES. D054/D062 make these a publishability precondition, and D063
  -- makes `hotels.latitude` the RESOLVED canonical value — never the raw
  -- provider number copied because it happened to be present.
  select r.outcome, r.resolved_latitude, r.resolved_longitude into loc
    from public.source_property_location_resolution_revisions r where r.id = new.location_revision_id;
  select h.current_revision_id into head_id
    from public.source_property_location_resolutions h
   where h.source_property_identity_id = new.source_property_identity_id;
  if head_id is distinct from new.location_revision_id then
    raise exception
      'publication receipt for identity % cites location revision %, which is not that identity''s CURRENT head revision (%).',
      new.source_property_identity_id, new.location_revision_id, coalesce(head_id::text, 'none')
      using errcode = 'integrity_constraint_violation';
  end if;
  if loc.outcome is distinct from 'resolved'
     or hotel.latitude is distinct from loc.resolved_latitude
     or hotel.longitude is distinct from loc.resolved_longitude then
    raise exception
      'publication receipt for identity % published coordinates (%, %) while location revision % resolved (%, %) with outcome %.',
      new.source_property_identity_id, coalesce(hotel.latitude::text, 'null'),
      coalesce(hotel.longitude::text, 'null'), new.location_revision_id,
      coalesce(loc.resolved_latitude::text, 'null'), coalesce(loc.resolved_longitude::text, 'null'),
      coalesce(loc.outcome, 'missing')
      using errcode = 'integrity_constraint_violation';
  end if;

  -- SCOPE. D062 condition 3. An INPUT to eligibility, never eligibility itself —
  -- which is why it is checked here and not treated as sufficient anywhere.
  select r.outcome into scope
    from public.source_property_scope_resolution_revisions r where r.id = new.scope_revision_id;
  select h.current_revision_id into head_id
    from public.source_property_scope_resolutions h
   where h.source_property_identity_id = new.source_property_identity_id;
  if head_id is distinct from new.scope_revision_id then
    raise exception
      'publication receipt for identity % cites scope revision %, which is not that identity''s CURRENT head revision (%).',
      new.source_property_identity_id, new.scope_revision_id, coalesce(head_id::text, 'none')
      using errcode = 'integrity_constraint_violation';
  end if;
  if scope.outcome is distinct from 'physical_hospitality' then
    raise exception
      'publication receipt for identity % cites scope revision % with outcome %. D062 condition 3 requires a resolved physical hospitality property.',
      new.source_property_identity_id, new.scope_revision_id, coalesce(scope.outcome, 'missing')
      using errcode = 'integrity_constraint_violation';
  end if;

  -- A03's `no_known_closure` is evidence of no KNOWN closure, never evidence of
  -- being active/open/operating. A newly published canonical row therefore says
  -- `unknown`, and this refuses to let it say anything stronger.
  if hotel.active_status is distinct from 'unknown' then
    raise exception
      'publication receipt for identity % published hotel % with active_status %. A03 lifecycle evidence establishes at most "no known closure", which is not evidence of being open; a newly published canonical row says unknown.',
      new.source_property_identity_id, new.hotel_id, hotel.active_status
      using errcode = 'integrity_constraint_violation';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_publication_receipt_evidence() from public;

create trigger source_property_publication_receipts_evidence
  before insert on public.source_property_publication_receipts
  for each row execute function public.enforce_publication_receipt_evidence();

-- ===========================================================================
-- 5. THE RECEIPT AND THE TERMINAL STATE ARE ONE FACT
-- ===========================================================================
-- 0027 already refuses `resolved_eligible` without an active canonical link to
-- the named hotel. The remaining gap runs the other way: a publication receipt
-- could exist while the identity never reached `resolved_eligible`, or could be
-- left behind by a later demotion — a receipt claiming a publication that the
-- database no longer reflects.
--
--   receipt exists  IFF  identity is resolved_eligible against that same hotel
--
-- DEFERRED, because the legitimate write order is
-- `hotel -> link -> receipt -> promote identity`, so for a few statements the
-- receipt exists while the identity is still `unresolved`. An immediate check
-- would make the correct application path impossible. What must be coherent is
-- the state that survives COMMIT.
--
-- Registered on BOTH tables, for the reason 0033's amendment #3 established: an
-- invariant enforced from only one side is an invariant that can be broken from
-- the other. The identity-side trigger carries a WHEN clause so it fires only
-- when the two columns it cares about actually move — ordinary ingestion, which
-- touches `last_seen_run_id` and `observation_count`, never enqueues it.
create or replace function public.assert_publication_state_coherent()
returns trigger
language plpgsql
as $$
declare
  identity_id uuid;
  receipt record;
  identity record;
begin
  -- Branching statements, not a CASE expression: PL/pgSQL resolves record fields
  -- when the expression is planned, so `new.source_property_identity_id` would
  -- fail on the identity table even in the branch that never runs.
  if tg_table_name = 'source_property_publication_receipts' then
    identity_id := new.source_property_identity_id;
  else
    identity_id := new.id;
  end if;

  select p.id, p.hotel_id into receipt
    from public.source_property_publication_receipts p
   where p.source_property_identity_id = identity_id;

  if receipt.id is null then
    return null;
  end if;

  select i.resolution_state, i.promoted_hotel_id, i.resolution_reason into identity
    from public.source_property_identities i
   where i.id = identity_id;

  if identity.resolution_state is distinct from 'resolved_eligible'
     or identity.promoted_hotel_id is distinct from receipt.hotel_id then
    raise exception
      'source identity % has publication receipt % naming hotel %, but its terminal state is (resolution_state=%, promoted_hotel_id=%). A publication receipt and the identity''s promotion are one fact: no receipt without promotion, and no un-promotion leaving a receipt behind.',
      identity_id, receipt.id, receipt.hotel_id,
      coalesce(identity.resolution_state, 'missing'),
      coalesce(identity.promoted_hotel_id::text, 'null')
      using errcode = 'integrity_constraint_violation';
  end if;

  -- `resolution_reason` is D061 §9 EXCLUSION vocabulary. A published property is
  -- the opposite of an exclusion, so carrying one here would make the terminal
  -- state read as both published and excluded.
  if identity.resolution_reason is not null then
    raise exception
      'source identity % is published (receipt %) but carries resolution_reason %. Publication is not an exclusion, and the two vocabularies must not be held at once.',
      identity_id, receipt.id, identity.resolution_reason
      using errcode = 'integrity_constraint_violation';
  end if;

  return null;
end;
$$;

revoke all on function public.assert_publication_state_coherent() from public;

create constraint trigger source_property_publication_receipts_state
  after insert on public.source_property_publication_receipts
  deferrable initially deferred
  for each row execute function public.assert_publication_state_coherent();

create constraint trigger source_property_identities_publication_state
  after update on public.source_property_identities
  deferrable initially deferred
  for each row
  when (old.resolution_state is distinct from new.resolution_state
        or old.promoted_hotel_id is distinct from new.promoted_hotel_id
        or old.resolution_reason is distinct from new.resolution_reason)
  execute function public.assert_publication_state_coherent();

-- ===========================================================================
-- 6. RLS AND GRANTS — EDITORIAL INTERNALS
-- ===========================================================================
-- Identical posture to 0027–0033: admin/editor through RLS plus `service_role`,
-- NO anon grant, and an ordinary creator sees nothing. The canonical `hotels`
-- row this receipt produced is public; the provenance behind it is not, and a
-- creator has no reason to read which provider run and which reviewer produced
-- their search result.
--
-- Append-only, so NO role — `service_role` included — holds UPDATE or DELETE.
alter table public.source_property_publication_receipts enable row level security;

create policy source_property_publication_receipts_admin
  on public.source_property_publication_receipts
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());

grant select, insert on public.source_property_publication_receipts to authenticated;
grant select, insert on public.source_property_publication_receipts to service_role;
