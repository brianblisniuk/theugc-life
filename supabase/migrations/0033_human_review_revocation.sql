-- ===========================================================================
-- 0033 — HUMAN REVIEW REVOCATION (A04.6)
-- ===========================================================================
-- A04.5 gave a human decision a durable, evidence-bound home. It deliberately
-- refused correction/supersession, which was right for a pilot that publishes
-- nothing — but A05 turns an authorized D062 PASS into a canonical hotel, and a
-- human must have an emergency brake BEFORE publication exists.
--
-- The one question this migration serves:
--
--   How can a human withdraw a previous `approve_create` so that it immediately
--   stops authorizing D062, WITHOUT modifying the immutable historical receipt,
--   WITHOUT deleting history, and WITHOUT publishing anything?
--
-- A revocation is NOT a rejection. It does not assert "this property is wrong".
-- It asserts exactly one thing: "the previous human approval is no longer valid
-- authorization." Nothing here writes a canonical row.
--
-- The three lifetimes A04.5 established are preserved unchanged:
--
--   source_property_review_receipts   immutable review-event history
--   source_property_reviews           the ONE current projection per identity
--   human `new_property` finding      entity-level, reused
--
-- Migrations 0027–0032 are NOT modified.
-- ===========================================================================

-- ===========================================================================
-- 1. AN ADDITIVE UNIQUE TARGET, SO THE POINTER CAN BE DECLARATIVE
-- ===========================================================================
-- `id` is already the receipt's primary key, so this pair is unique today. The
-- constraint carries no new data; it exists so a composite FK can prove that a
-- projection's receipt belongs to the SAME identity, rather than trusting an
-- unconstrained UUID to point somewhere sensible.
alter table public.source_property_review_receipts
  add constraint source_property_review_receipts_id_identity_uk
  unique (id, source_property_identity_id);

-- ===========================================================================
-- 2. THE CURRENT PROJECTION LEARNS TWO THINGS
-- ===========================================================================
-- `decision` and `review_status` answer DIFFERENT questions, and conflating
-- them is the mistake this migration exists to avoid:
--
--   decision       what the human concluded
--   review_status  whether that conclusion is currently authorized for use
--
-- So a revoked row legitimately remains `decision = 'approve_create'` with
-- `review_status = 'revoked'`. That is not a contradiction; it is the audit
-- trail. Rewriting `decision` to hide the withdrawal would destroy the record of
-- what was actually decided, and reusing `decision = 'defer'` as a revocation
-- state would claim the human said something they never said.
alter table public.source_property_reviews
  add column review_status text not null default 'active'
    check (review_status in ('active', 'revoked'));

-- Which immutable receipt this projection currently represents. NULL is honest
-- for legacy/manual rows that were never created by A04.5 and therefore have no
-- receipt at all.
alter table public.source_property_reviews
  add column current_receipt_id uuid;

alter table public.source_property_reviews
  add constraint source_property_reviews_current_receipt_fk
  foreign key (current_receipt_id, source_property_identity_id)
  references public.source_property_review_receipts (id, source_property_identity_id);

create index source_property_reviews_status_idx
  on public.source_property_reviews (review_status);

comment on column public.source_property_reviews.review_status is
  'Whether this current decision is authorized for use. `revoked` means a human withdrew it; the decision column still records what was concluded. See A04_6_HUMAN_REVIEW_REVOCATION_CONTRACT.md.';
comment on column public.source_property_reviews.current_receipt_id is
  'The immutable A04.5 receipt this projection currently represents. NULL only for legacy/manual rows with no receipt.';

-- ===========================================================================
-- 3. THE COHERENCE INVARIANT, ENFORCED BY THE DATABASE
-- ===========================================================================
-- The composite FK in §2 proves the pointed receipt belongs to the SAME
-- IDENTITY. That is necessary and it is not sufficient.
--
-- An identity legitimately accumulates several receipts — one per reviewed
-- observation. So "same identity" permits this, which is exactly the state this
-- section exists to forbid:
--
--   observation A -> receipt A          observation B -> receipt B
--   projection advances to B, decided_in_run_id = run B
--   ...then current_receipt_id is pointed back at receipt A
--
-- Both receipts belong to the identity, so the FK is satisfied and the row is
-- schema-valid. But the projection would then claim to be represented by a
-- receipt describing a DIFFERENT decision about DIFFERENT evidence, and A05
-- could consume authorization from one while the current human record names the
-- other. The pointer must not merely reference a receipt; it must reference the
-- receipt this projection actually IS.
--
-- Four requirements, and each one is load-bearing:
--
--   * the projection is `approve_create` — this pilot owns no other kind of
--     receipt-backed authorization
--   * the receipt is `approve_create` — a `defer` receipt authorizes nothing
--   * destinations agree — the destination is a HUMAN decision, so the receipt
--     must carry the same one
--   * `receipt.evidence_source_run_id = review.decided_in_run_id` — THE
--     distinction between receipt A and receipt B for one identity
--
-- Deliberately absent: `reviewed_at`. Wall-clock order is not authority here or
-- anywhere else in this layer.
--
-- `is not distinct from` throughout, so NULL is compared honestly rather than
-- silently passing. A projection whose `decided_in_run_id` is NULL names no run,
-- so it can carry no receipt pointer at all — which is the correct answer for a
-- legacy row, not an inconvenience to work around.
--
-- A `revoked` projection MUST keep pointing at the receipt that was withdrawn,
-- so status is deliberately not part of this predicate.
create or replace function public.enforce_review_projection_receipt_coherence()
returns trigger
language plpgsql
as $$
declare
  r record;
begin
  -- A projection with no receipt is honest legacy state, not an error. 0033 will
  -- not invent a receipt for a row that never had one.
  if new.current_receipt_id is null then
    return new;
  end if;

  select decision, destination_id, evidence_source_run_id
    into r
    from public.source_property_review_receipts
   where id = new.current_receipt_id;

  -- Unreachable while the composite FK stands; checked anyway, because a NOT
  -- FOUND here would mean silently skipping the whole invariant.
  if not found then
    raise exception
      'source_property_reviews.current_receipt_id % names no receipt (review_projection_receipt_incoherent).',
      new.current_receipt_id
      using errcode = 'integrity_constraint_violation';
  end if;

  if new.decision <> 'approve_create' or r.decision <> 'approve_create' then
    raise exception
      'review_projection_receipt_incoherent: projection decision % and receipt decision % — only an approve_create projection may name an approve_create receipt.',
      new.decision, r.decision
      using errcode = 'integrity_constraint_violation';
  end if;

  if r.destination_id is distinct from new.destination_id then
    raise exception
      'review_projection_receipt_incoherent: receipt % records destination %, the projection records destination %. The destination is a human decision and the receipt must carry the same one.',
      new.current_receipt_id, r.destination_id, new.destination_id
      using errcode = 'integrity_constraint_violation';
  end if;

  if r.evidence_source_run_id is distinct from new.decided_in_run_id then
    raise exception
      'review_projection_receipt_incoherent: receipt % is evidence from run %, the projection decided in run %. A current projection may not point back at a receipt from a different run.',
      new.current_receipt_id, r.evidence_source_run_id, new.decided_in_run_id
      using errcode = 'integrity_constraint_violation';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_review_projection_receipt_coherence() from public;

-- Fires on every INSERT and every UPDATE, NOT only when `current_receipt_id`
-- changes. Moving `decision`, `destination_id` or `decided_in_run_id` while
-- leaving the pointer alone breaks the invariant just as effectively, and a
-- `when (...)` clause naming only the pointer column would miss exactly that.
create trigger source_property_reviews_receipt_coherence
  before insert or update on public.source_property_reviews
  for each row execute function public.enforce_review_projection_receipt_coherence();

-- ===========================================================================
-- 4. AMBIGUITY IS REFUSED BEFORE ANYTHING IS CHOSEN
-- ===========================================================================
-- This block runs BEFORE the backfill, deliberately. "UPDATE first, discover the
-- ambiguity afterwards" would be safe only because the migration happens to be
-- transactional; the CONTRACT is that a binding nobody can prove is never
-- computed in the first place.
--
-- The predicate below is the SAME one §3 enforces and §5 binds on. One
-- definition of "this receipt represents this projection", used in all three
-- places — a second definition is how the two drift apart.
do $$
declare
  ambiguous integer;
begin
  select count(*) into ambiguous
    from (
      select rv.id
        from public.source_property_reviews rv
        join public.source_property_review_receipts r
          on r.source_property_identity_id = rv.source_property_identity_id
         and r.decision = 'approve_create'
         and r.evidence_source_run_id is not distinct from rv.decided_in_run_id
         and r.destination_id is not distinct from rv.destination_id
       where rv.decision = 'approve_create'
         and rv.decided_in_run_id is not null
       group by rv.id
      having count(r.id) > 1
    ) ambiguous_rows;

  if ambiguous > 0 then
    raise exception
      '0033 backfill is ambiguous for % source_property_reviews row(s): more than one compatible approve_create receipt could represent the projection. Refusing to guess which receipt currently authorizes D062, and refusing to break the tie on reviewed_at. Resolve the duplicates and re-run.',
      ambiguous
      using errcode = 'data_exception';
  end if;
end;
$$;

-- ===========================================================================
-- 5. BACKFILL — ON THE FULL COHERENCE PREDICATE, OR NOT AT ALL
-- ===========================================================================
-- A04.5 sets `source_property_reviews.decided_in_run_id` to the run of the
-- observation that was reviewed, and every receipt records that same run as
-- `evidence_source_run_id`. So the projection and its receipt agree on real
-- provenance columns, and the binding is a FACT rather than a guess.
--
-- Deliberately NOT `order by reviewed_at desc limit 1`. Wall-clock recency is a
-- heuristic; two receipts written in the same transaction, or a clock that moved,
-- would silently bind the wrong one. Run provenance cannot.
--
-- And deliberately not the run alone: a receipt that agrees on the run but
-- records a different destination does not represent this projection, so it is
-- not bound. A projection with no uniquely compatible receipt keeps
-- `current_receipt_id = NULL`, which is the honest legacy answer.
--
-- The pair (identity, evidence_source_run_id) is unique among receipts by
-- construction — 0027 makes observations unique per (source_run_id, identity),
-- and 0032 makes receipts unique per (identity, evidence_observation_id) — so at
-- most one receipt can match. §4 above PROVED that rather than assuming it, and
-- §3's trigger validates every row this statement writes.
update public.source_property_reviews rv
   set current_receipt_id = r.id
  from public.source_property_review_receipts r
 where r.source_property_identity_id = rv.source_property_identity_id
   and r.decision = 'approve_create'
   and r.evidence_source_run_id is not distinct from rv.decided_in_run_id
   and r.destination_id is not distinct from rv.destination_id
   and rv.decision = 'approve_create'
   and rv.decided_in_run_id is not null;

-- ===========================================================================
-- 6. THE IMMUTABLE REVOCATION EVENT
-- ===========================================================================
-- One row means exactly: "this exact receipt's approval was withdrawn by this
-- reviewer, at this time, for this stated reason." It is a new fact, not an edit
-- of an old one, which is why the receipt it revokes stays byte-identical.
create table public.source_property_review_revocations (
  id uuid primary key default gen_random_uuid(),
  source_property_identity_id uuid not null,
  source text not null,
  source_environment text not null
    check (source_environment in ('evaluation', 'production')),

  -- The exact approval being withdrawn.
  revoked_receipt_id uuid not null,

  reviewer_user_id uuid references public.users(id),
  reviewer_label text not null check (length(btrim(reviewer_label)) > 0),
  -- A withdrawal with no stated reason is not auditable. Required, not optional.
  revocation_note text not null check (length(btrim(revocation_note)) > 0),

  revoked_at timestamptz not null,
  -- Computed in the application and stored, following 0031/0032: `timestamptz`
  -- has no immutable text cast, so a generated column is not available here.
  revocation_digest text not null check (revocation_digest ~ '^[0-9a-f]{64}$'),
  revocation_digest_algorithm text not null default 'sha256'
    check (revocation_digest_algorithm = 'sha256'),
  created_at timestamptz not null default now(),

  constraint source_property_review_revocations_identity_fk
    foreign key (source_property_identity_id, source, source_environment)
    references public.source_property_identities (id, source, source_environment),

  -- The revoked receipt must belong to THIS identity. A revocation that could
  -- cite someone else's approval would be worse than no revocation at all.
  constraint source_property_review_revocations_receipt_fk
    foreign key (revoked_receipt_id, source_property_identity_id)
    references public.source_property_review_receipts (id, source_property_identity_id),

  -- ONE revocation per receipt. A second withdrawal of the same approval is not
  -- new information, and the application-level idempotency check is not allowed
  -- to be the only thing standing between us and a duplicate.
  constraint source_property_review_revocations_receipt_uk unique (revoked_receipt_id)
);

create index source_property_review_revocations_identity_idx
  on public.source_property_review_revocations (source_property_identity_id, revoked_at desc);

comment on table public.source_property_review_revocations is
  'APPEND-ONLY. A human withdrawing a previous approve_create so it stops authorizing D062. Not a rejection, not a deletion, not a publication action. See A04_6_HUMAN_REVIEW_REVOCATION_CONTRACT.md.';

-- ===========================================================================
-- 7. APPEND-ONLY BY TRIGGER
-- ===========================================================================
-- The grants in §8 are the first layer; this is the second. A revocation records
-- that a human withdrew authorization at a moment that has passed. Editing it
-- would change what is recorded as having happened.
create or replace function public.forbid_review_revocation_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    '% on % is refused: a human review revocation is APPEND-ONLY. There is no un-revoke; a later approval is a fresh review of fresh evidence.',
    tg_op, tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

revoke all on function public.forbid_review_revocation_mutation() from public;

create trigger source_property_review_revocations_append_only
  before update or delete on public.source_property_review_revocations
  for each row execute function public.forbid_review_revocation_mutation();

-- ===========================================================================
-- 8. RLS AND GRANTS — EDITORIAL INTERNALS
-- ===========================================================================
-- Identical posture to 0027–0032: admin/editor through RLS plus `service_role`,
-- NO anon grant, and an ordinary creator sees nothing. Append-only, so no role —
-- `service_role` included — holds UPDATE or DELETE.
alter table public.source_property_review_revocations enable row level security;

create policy source_property_review_revocations_admin
  on public.source_property_review_revocations
  for all using (public.is_admin_or_editor()) with check (public.is_admin_or_editor());

grant select, insert on public.source_property_review_revocations to authenticated;
grant select, insert on public.source_property_review_revocations to service_role;
