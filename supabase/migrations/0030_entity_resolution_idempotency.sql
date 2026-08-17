-- 0030_entity_resolution_idempotency.sql
--
-- ENTITY-RESOLUTION EVIDENCE: the two things 0027's candidate table could not
-- express, and nothing else.
--
-- 0027 already models everything this block needs — candidate kinds, the
-- evidence vocabulary, the generated `agreeing_dimensions`, the review status
-- vocabulary, the provenance composite FKs. This migration adds NO table, NO
-- column and NO new concept. It adds two constraints, because both encode a
-- rule that application code cannot keep on its own.
--
-- Additive only. Nothing existing is altered or dropped.

-- ===========================================================================
-- 1. A CANDIDATE PAIR IS ONE ROW
-- ===========================================================================
-- Without this, re-running candidate discovery over unchanged evidence inserts
-- a second row for every pair it already found, and the review queue grows by
-- one duplicate per replay. Dedup could be done by selecting first and
-- inserting after, but that is a race and a convention rather than a guarantee:
-- two concurrent runs, or one interrupted mid-transaction, still double.
--
-- Keyed on the PAIR rather than on the pair plus the reason it surfaced. A pair
-- that both shares a domain and shares a phone is ONE candidate for review with
-- two reasons recorded in `match_method`, not two candidates — a reviewer
-- deciding the same pair twice is exactly the duplicated work this queue exists
-- to prevent, and it would also read as two findings in any count.
--
-- The index alone is DIRECTIONAL, and that is not what "one row" means. It stops
-- `A -> B` twice; it does not stop `A -> B` and `B -> A`, which are the same
-- pair recorded as two candidates for a reviewer to decide twice — and possibly
-- to decide differently. Today's discovery orients pairs lexicographically, but
-- that is an application convention, and a future writer, a Provider B workflow,
-- a manual tool or plain psql are not bound by it.
--
-- So the ORIENTATION is the invariant, and the index is only unambiguous
-- because of it: for a source↔source candidate the left identity must sort
-- before the right. UUID ordering carries no meaning of its own, which is
-- exactly what makes it a safe canonical form.
alter table public.source_match_candidates
  add constraint source_match_candidates_source_pair_orientation check (
    candidate_kind <> 'source_identity'
    or source_property_identity_id < candidate_source_property_identity_id
  );

comment on constraint source_match_candidates_source_pair_orientation
  on public.source_match_candidates is
  'A source-to-source pair has ONE canonical orientation, so the pair unique index below is genuinely unordered: B -> A is refused, not merely deduplicated.';

-- Partial indexes, one per kind, because the target column differs and NULL
-- does not deduplicate.
create unique index source_match_candidates_source_pair_uk
  on public.source_match_candidates
     (source_property_identity_id, candidate_source_property_identity_id)
  where candidate_kind = 'source_identity';

create unique index source_match_candidates_hotel_pair_uk
  on public.source_match_candidates (source_property_identity_id, candidate_hotel_id)
  where candidate_kind = 'canonical_hotel';

-- One explicit "this is a new property" finding per identity. A second one is
-- not new information; it is the same finding recorded twice.
create unique index source_match_candidates_new_property_uk
  on public.source_match_candidates (source_property_identity_id)
  where candidate_kind = 'new_property';

-- ===========================================================================
-- 2. `new_property` IS A FINDING, NOT A DEFAULT
-- ===========================================================================
-- The dangerous inference in entity resolution is:
--
--     the sweep produced no candidate  ->  therefore this is a new property
--
-- It is not. Absence of a generated candidate means the blocking rules found
-- nothing to compare — which is a statement about the RULES, not about the
-- world. Recording it as `new_property` would convert "we did not look hard
-- enough" into "we looked and there is nothing", and D062 would later read that
-- as authorisation to create a canonical hotel.
--
-- So a `new_property` row must carry a written justification. A sweep has none
-- to write; a reviewer does. This does not stop a determined caller from
-- inventing a note, but it does stop the failure mode that actually happens:
-- a bulk INSERT ... SELECT over every identity with no candidate.
--
-- `candidate_kind` DEFAULTS to 'new_property' in 0027, so this also closes the
-- quieter version of the same accident — a candidate inserted without naming
-- its kind at all.
alter table public.source_match_candidates
  add constraint source_match_candidates_new_property_requires_finding check (
    candidate_kind <> 'new_property' or review_note is not null
  );

comment on constraint source_match_candidates_new_property_requires_finding
  on public.source_match_candidates is
  'A new_property candidate is an explicit search/review finding and must say who found what. Absence of a machine candidate is NOT a finding.';

-- ===========================================================================
-- 3. A MACHINE CANDIDATE THAT IS NO LONGER CURRENT
-- ===========================================================================
-- A pending candidate is a claim about the CURRENT evidence: "these two are
-- worth comparing, because right now they share a domain". When the provider
-- corrects one of them and that stops being true, the row is a claim nothing
-- supports any more — and because discovery no longer returns the pair, a
-- generator that only visits current pairs would never revisit it. It would sit
-- in the review queue forever, and D062 cannot read a queue like that.
--
-- `superseded` already exists in 0027's status vocabulary for exactly this
-- shape. What it could not express is WHO superseded the row, and that
-- distinction is load-bearing: the pipeline must be able to reactivate a pair it
-- itself stood down when the evidence returns, and must never touch a decision a
-- human made. So the reason is recorded, and the machine's own reason is the
-- ONLY value it may write or clear.
--
-- `source_match_candidates` is a MUTABLE CURRENT record — 0027 gave it `status`,
-- `resolved_at` and `review_note` and never declared it append-only — so this
-- is a status transition on that record, not a rewrite of history: no row is
-- deleted, and the evidence that was current when the pair stood is left exactly
-- as it was.
alter table public.source_match_candidates
  add column superseded_reason text
    check (superseded_reason is null or superseded_reason in ('no_current_blocking_rule'));

alter table public.source_match_candidates
  add constraint source_match_candidates_superseded_reason_shape check (
    superseded_reason is null or status = 'superseded'
  );

comment on column public.source_match_candidates.superseded_reason is
  'Set ONLY by candidate generation, and only to `no_current_blocking_rule`: no current blocking rule supports this pair any more. A human decision never carries a reason here, which is what keeps the generator from reactivating one.';
