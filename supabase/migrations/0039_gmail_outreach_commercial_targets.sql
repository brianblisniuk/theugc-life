-- ===========================================================================
-- 0039 — B05: GMAIL PRIVATE CREATOR-OUTREACH INTERPRETATION
-- ===========================================================================
-- B04 turned B03's raw Gmail evidence into a deterministic, replay-safe
-- normalized projection and interpreted none of it. B05 is the first layer
-- that answers a business question over that evidence: is a normalized
-- thread creator-commercial outreach, who or what was the creator trying to
-- reach, and which recipients were actually targeted as commercial contacts?
--
-- D070 governs this migration. Two epistemic layers, never conflated:
--
--   MACHINE  — versioned, replaceable, advisory. Never creator truth.
--   HUMAN    — immutable decision events + a current projection. Authoritative.
--     A machine re-run NEVER overwrites a human decision on any axis.
--
-- Four independently-decidable human axes: outreach, target_scope, target,
-- target_contact.
--
-- A commercial target is first a PRIVATE FACT (`gmail_outreach_target_
-- observations`), independent of canonical inventory — it may have zero, one
-- or many canonical hotel/organization candidates, and a creator confirms the
-- private fact, never a canonical row directly. Symmetrically, an observed
-- recipient (`gmail_outreach_observed_recipients`, every To/Cc/Bcc occurrence
-- on creator-SENT evidence, unfiltered) may have zero, one or many canonical
-- contact candidates, and "this recipient is a commercial target contact" is
-- a separate semantic fact from "this recipient's address matches a canonical
-- contact record" — an exact address match is evidence, never target/contact
-- identity (D028).
--
-- WHAT THIS MIGRATION DOES NOT CREATE, on purpose:
--
--   no sent/reply/timing fact, no parent/child message relationship — B06;
--   no outcome, correction taxonomy or creator correction loop beyond the
--     confirm/correct decisions this contract itself defines — B07;
--   no incremental sync/watch state — B08;
--   no network-intelligence (G3) row, aggregate or eligibility flag;
--   no write to public.pipeline_items, public.outreach_events or
--     public.collaborations — B05 builds a private plane, not the live CRM;
--   no canonical hotel, organization, brand or contact row is ever created
--     or mutated by anything in this migration;
--   no Gmail network activity: zero Google calls, zero OAuth changes, zero
--     quota consumption. Every input already lives in B04's normalized
--     tables; B05 is local computation over rows B04 wrote.
--
-- 0035–0038 are UNCHANGED. This migration extends the schema additively.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. FAIL BEFORE CHOICE
-- ---------------------------------------------------------------------------
do $$
declare
  colliding text[];
begin
  select array_agg(c.relname order by c.relname) into colliding
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'private'
     and c.relkind = 'r'
     and c.relname in (
       'gmail_outreach_catalog_epoch_lock',
       'gmail_outreach_thread_signals',
       'gmail_outreach_observed_recipients',
       'gmail_outreach_observed_recipient_canonical_links',
       'gmail_outreach_target_contact_signals',
       'gmail_outreach_target_contact_candidates',
       'gmail_outreach_target_observations',
       'gmail_outreach_target_canonical_links',
       'gmail_outreach_target_scope_signals',
       'gmail_outreach_creator_decisions',
       'gmail_outreach_target_confirmations',
       'gmail_outreach_target_contact_confirmed_members',
       'gmail_outreach_creator_decision_events'
     );

  if colliding is not null then
    raise exception
      '0039 refuses to install: private table(s) % already exist. B05 is the first outreach-interpretation layer, so pre-existing tables of these names hold state this migration did not create and cannot interpret.',
      array_to_string(colliding, ', ')
      using errcode = 'restrict_violation';
  end if;
end;
$$;

-- ===========================================================================
-- 1. CATALOG EPOCH — coarse, cheap "the candidate universe might have changed"
-- ===========================================================================
-- A single monotonic sequence spanning every table that can change B05's
-- canonical candidate universe, exactly analogous to B02's
-- `mail_account_lifecycle_intent_seq`. Bumping it means only "recheck the
-- relevant candidates for anything you evaluated before this number" — never
-- "every previous result is wrong". A per-result relevant candidate-set
-- fingerprint (computed by the caller, stored alongside `evaluated_epoch`)
-- is what actually decides whether a specific stored result is stale.
create sequence private.gmail_outreach_catalog_epoch_seq;

-- PRIME IT. A sequence's OWN first `nextval()` call always returns exactly
-- its START value (1) — identical to the value `last_value` already reads
-- BEFORE that call, since `is_called` starts false. Reading bare `last_value`
-- (the only cheap, lock-free way to inspect a sequence) therefore cannot
-- distinguish "never bumped" from "bumped exactly once" until a SECOND call
-- moves it to 2 — which would make the very first real catalog mutation in a
-- fresh database invisible to every epoch comparison in this migration. One
-- throwaway call here, at migration time, means every call site is dealing
-- with a sequence that has already been advanced at least once, so mutation
-- #1 in production always produces a value distinguishable from "never
-- touched".
select nextval('private.gmail_outreach_catalog_epoch_seq');

-- ---------------------------------------------------------------------------
-- EXTERNAL AUDIT AMENDMENT #2, Finding 3: a REAL transactional fence.
-- ---------------------------------------------------------------------------
-- The bare sequence above is fine for a CHEAP, lock-free, approximate read
-- (§11a's candidate-offering query — reading `last_value` there costs nothing
-- and being off by one bump for one query is harmless: it only decides
-- whether a thread is OFFERED for re-evaluation, never whether a write
-- happens). It is NOT fine as the actual commit-time fence: reading
-- `last_value` and later writing, with no lock held in between, is a classic
-- TOCTOU gap — a catalog mutation between the read and the write is
-- invisible to the check.
--
-- This ONE ROW is the real fence. `gmail_outreach_commit_interpretation`
-- takes a `for share` lock on it before comparing epochs and before any of
-- its own writes, and holds that lock until its own transaction ends. A
-- concurrent catalog mutation's trigger UPDATEs this SAME row (taking the
-- conflicting exclusive lock ordinary UPDATE always takes), so the two can
-- never interleave: whichever transaction reaches this row first forces the
-- other to wait for it to fully finish, and only then read the row's real,
-- final value. There is no window in which a commit can observe an epoch
-- that a concurrent mutation is in the process of changing.
create table private.gmail_outreach_catalog_epoch_lock (
  id boolean primary key default true,
  current_epoch bigint not null,
  constraint gmail_outreach_catalog_epoch_lock_singleton check (id)
);

insert into private.gmail_outreach_catalog_epoch_lock (id, current_epoch)
values (true, (select last_value from private.gmail_outreach_catalog_epoch_seq));

comment on table private.gmail_outreach_catalog_epoch_lock is
  'B05: the ONE lockable row backing the catalog-epoch transactional fence (EXTERNAL AUDIT AMENDMENT #2, Finding 3). gmail_outreach_commit_interpretation takes `for share` on this row before comparing/writing; a catalog-mutation trigger UPDATEs it under the same transaction it bumps the epoch sequence in, so the two can never interleave. Never read this table directly for a cheap/approximate epoch check — use gmail_outreach_current_catalog_epoch() or the bare sequence for that.';

-- SECURITY DEFINER: this fires as an AFTER STATEMENT trigger on ordinary
-- catalog writes to `public.hotels` etc, made by editor/admin roles that have
-- no reason to hold USAGE on a `private` schema sequence or UPDATE on a
-- `private` schema table. Without definer rights, an editor's routine hotel
-- edit would fail with "permission denied" — an unrelated, unintended side
-- effect of B05 existing at all. Owned by the migration role, which does
-- hold the privilege.
create or replace function private.bump_gmail_outreach_catalog_epoch()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_epoch bigint;
begin
  v_epoch := nextval('private.gmail_outreach_catalog_epoch_seq');
  -- Same transaction, same statement's trigger: the lock row and the
  -- sequence advance together atomically from the point of view of any
  -- concurrent `for share` reader on the lock row.
  update private.gmail_outreach_catalog_epoch_lock set current_epoch = v_epoch where id = true;
  return null;
end;
$$;

revoke all on function private.bump_gmail_outreach_catalog_epoch() from public;

do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'public.hotels', 'public.hotel_source_identities', 'public.hotel_contacts',
    'public.organizations', 'public.hotel_organizations', 'public.organization_contacts'
  ] loop
    execute format(
      'create trigger %I after insert or update or delete on %s
         for each statement execute function private.bump_gmail_outreach_catalog_epoch()',
      replace(tbl, '.', '_') || '_bump_outreach_catalog_epoch', tbl
    );
  end loop;
end;
$$;

-- Deliberately reads the LOCK ROW (not the bare sequence) so this cheap,
-- unlocked read and the real fence in gmail_outreach_commit_interpretation
-- always report the same number — the sequence itself is now only the
-- mechanism that generates a fresh value, never a value B05 compares against.
create or replace function public.gmail_outreach_current_catalog_epoch()
returns bigint
language sql
security definer
set search_path = public, private, pg_temp
stable
as $$
  select current_epoch from private.gmail_outreach_catalog_epoch_lock where id = true;
$$;

revoke all on function public.gmail_outreach_current_catalog_epoch() from public;
grant execute on function public.gmail_outreach_current_catalog_epoch() to service_role;

-- ===========================================================================
-- 2. MACHINE — THREAD-LEVEL OUTREACH SIGNAL
-- ===========================================================================
-- One current, replaceable machine projection per account-scoped normalized
-- thread. `evidence_digest` is the source-evidence fence token: a deterministic
-- digest over the exact set of (normalized_message_id, source_payload_sha256,
-- provider_sent) tuples the classifier actually read, re-verified under lock
-- at commit time (§9b) so a result can never be bound to evidence that moved
-- underneath it.
create table private.gmail_outreach_thread_signals (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null references public.users(id) on delete cascade,
  mail_account_id uuid not null,
  normalized_thread_id uuid not null,

  outreach_status text not null check (outreach_status in (
    'qualified_outreach', 'not_outreach', 'needs_review', 'insufficient_evidence'
  )),
  reason_codes text[] not null default '{}',

  detector_version text not null check (detector_version ~ '^[a-z][a-z0-9_]{0,63}$'),
  evidence_digest text not null check (evidence_digest ~ '^[0-9a-f]{64}$'),
  evidence_message_count integer not null check (evidence_message_count >= 0),

  evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gmail_outreach_thread_signals_thread_fk
    foreign key (normalized_thread_id, mail_account_id)
    references private.gmail_normalized_threads (id, mail_account_id) on delete cascade,

  constraint gmail_outreach_thread_signals_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  constraint gmail_outreach_thread_signals_identity_uidx
    unique (mail_account_id, normalized_thread_id)
);

comment on table private.gmail_outreach_thread_signals is
  'B05 MACHINE layer: current, replaceable outreach classification per thread. Advisory only — never creator-confirmed truth. See gmail_outreach_creator_decisions for the human layer.';

create index gmail_outreach_thread_signals_account_idx
  on private.gmail_outreach_thread_signals (mail_account_id);

create or replace function private.touch_gmail_outreach_row()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.touch_gmail_outreach_row() from public;

create trigger gmail_outreach_thread_signals_touch
  before update on private.gmail_outreach_thread_signals
  for each row execute function private.touch_gmail_outreach_row();

-- ===========================================================================
-- 3. STABLE OBSERVED RECIPIENTS — deterministic, never filtered
-- ===========================================================================
-- Every To/Cc/Bcc participant occurrence on a creator-SENT message in a
-- thread B05 has evaluated, with NO exception: the creator's own second
-- address, a manager/assistant CC, a malformed participant B04 preserved. No
-- interpretation happens here — filtering IS the interpretation this layer
-- must not perform (see gmail_outreach_target_contact_candidates for that).
--
-- STABILITY (EXTERNAL AUDIT AMENDMENT #1, Finding 1): B04 is an explicitly
-- REPLACEABLE deterministic projection (0038 §7) — a raw-payload correction
-- or a normalizer-version bump DELETES AND RECREATES the entire message row
-- and everything FK'd to it (headers, participants, text parts) under a NEW
-- uuid, even when nothing a human cares about changed. `gmail_normalized_
-- threads.id` is the one thing that survives that rebuild (0038's commit
-- function resolves the thread row `on conflict (mail_account_id, provider_
-- thread_id) do nothing`), so it remains safe to key on; a B04 participant
-- row is not.
--
-- The original version of this table keyed identity on `source_participant_
-- id` with `on delete cascade` — which meant an ordinary B04 rebuild (no
-- content the creator would recognize as different) could silently delete a
-- human's target-contact confirmation by cascading through a row B04 never
-- promised to keep stable. Identity now lives in DURABLE coordinates instead:
-- `provider_message_id` (Gmail's own permanent message id — untouched by a
-- B04 rebuild), `role` + `header_occurrence_index` (which To/Cc/Bcc header,
-- 0-based among headers of that name) + `participant_order` (position within
-- that header's parsed address list) — the exact structural position B04
-- itself derives deterministically from the same raw payload, so the same
-- raw content reproduces the same coordinate after ANY number of rebuilds.
--
-- The `current_*` columns are a CONVENIENCE cross-reference to whichever B04
-- row currently occupies that position, `on delete set null` rather than
-- cascade: a rebuild nulls them out and the next B05 re-commit reattaches
-- them, but a human decision anchored to this row's `id` is never at risk,
-- because nothing about this row's identity or existence depends on them.
--
-- EXTERNAL AUDIT AMENDMENT #2, Finding 1: the coordinate above is DURABLE
-- structure, not evidence — it says WHERE in the thread a recipient sits,
-- never WHO that recipient actually is. The original Amendment #1 fix let
-- the evidence columns be mutated in place whenever a B04 rebuild reoccupied
-- a coordinate, which silently rewrote a human's confirmed recipient to
-- different real-world evidence (a raw-payload correction that changes
-- `marketing@hotel-a.com` to `manager@hotel-b.com` at the same structural
-- position) with no new human decision event. `recipient_fingerprint` is a
-- second, SEMANTIC identity axis over the MATERIAL observed evidence (the
-- address itself — never the cosmetic `display_name`, which a hotel can
-- render differently between two sends of literally the same mailbox without
-- that being a different real-world recipient). The row's true identity is
-- now the PAIR (durable coordinate, recipient_fingerprint):
--
--   SAME coordinate, SAME fingerprint   the same real recipient reobserved —
--                                       upsert reconciles the SAME row, and
--                                       any human confirmation of it is
--                                       naturally still about the same
--                                       real-world evidence.
--   SAME coordinate, DIFFERENT fingerprint   a materially different
--                                       recipient now occupies that position
--                                       — a NEW row is created for the new
--                                       evidence; the OLD row (and any human
--                                       confirmation anchored to its `id`)
--                                       is left completely untouched, and is
--                                       marked `is_current = false` since it
--                                       no longer reflects live B04 evidence.
--
-- No human decision event is ever fabricated by this reconciliation — a
-- stale `is_current = false` row's existing confirmation, if any, simply
-- continues to describe the (now superseded) evidence it was always about.
-- Explicit account deletion purges every row regardless of `is_current`,
-- exactly like today (gmail_outreach_purge_for_deletion deletes by
-- mail_account_id wholesale).
create table private.gmail_outreach_observed_recipients (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null references public.users(id) on delete cascade,
  mail_account_id uuid not null,
  normalized_thread_id uuid not null,

  -- THE DURABLE STABILITY KEY — survives a B04 rebuild by construction.
  provider_message_id text not null,
  role text not null check (role in ('to', 'cc', 'bcc')),
  header_occurrence_index integer not null check (header_occurrence_index >= 0),
  participant_order integer not null check (participant_order >= 0),

  -- THE SEMANTIC IDENTITY AXIS (Finding 1) — a digest over the MATERIAL
  -- observed evidence only (addr_spec/local_part/domain/domain_lower/
  -- parse_status, lower-cased; never display_name). Computed by the commit
  -- RPC itself, never trusted from the caller.
  recipient_fingerprint text not null check (recipient_fingerprint ~ '^[0-9a-f]{64}$'),

  -- OBSERVED EVIDENCE — identical for every row sharing a fingerprint;
  -- refreshed (not overwritten with different values) on reconciliation.
  display_name text,
  addr_spec text,
  local_part text,
  domain text,
  domain_lower text,
  parse_status text not null check (parse_status in ('parsed', 'malformed', 'empty_group')),

  -- CURRENT PROJECTION LINK — convenience only, never identity. Null after a
  -- B04 rebuild until the next B05 re-commit reattaches it, and PERMANENTLY
  -- null on a row a fingerprint change has superseded (Finding 1) — at most
  -- ONE row per durable coordinate may ever hold a non-null value here.
  current_normalized_message_id uuid references private.gmail_normalized_messages(id) on delete set null,
  current_source_header_id uuid references private.gmail_normalized_headers(id) on delete set null,
  current_source_participant_id uuid references private.gmail_normalized_participants(id) on delete set null,

  -- Whether this row reflects the CURRENT live B04 evidence at its
  -- coordinate (Finding 1). A rebuild that reproduces the SAME fingerprint
  -- keeps this true on the same row; a rebuild with DIFFERENT evidence sets
  -- this false on the old row and creates a new, current row alongside it.
  is_current boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gmail_outreach_observed_recipients_thread_fk
    foreign key (normalized_thread_id, mail_account_id)
    references private.gmail_normalized_threads (id, mail_account_id) on delete cascade,

  constraint gmail_outreach_observed_recipients_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  -- THE STABILITY KEY. One observed-recipient row per (durable source
  -- coordinate, material evidence fingerprint), forever — independent of
  -- which B04 row currently occupies the coordinate.
  constraint gmail_outreach_observed_recipients_durable_uidx
    unique (mail_account_id, normalized_thread_id, provider_message_id, role, header_occurrence_index, participant_order, recipient_fingerprint)
);

comment on table private.gmail_outreach_observed_recipients is
  'B05: every To/Cc/Bcc occurrence on creator-SENT evidence, unfiltered. Deterministic extraction, not a machine judgement. Identity is the PAIR (durable source coordinate, recipient_fingerprint over material evidence) — independent of B04''s own replaceable row lifecycle, so a B04 rebuild can never orphan a human target-contact confirmation, AND a materially different recipient later occupying the same coordinate creates a new row rather than silently rewriting the old one''s evidence (EXTERNAL AUDIT AMENDMENT #2, Finding 1). `is_current = false` marks a row a fingerprint change has superseded; its own id and any human confirmation of it remain permanently valid. A recipient here is NOT a commercial target contact by itself — see gmail_outreach_target_contact_candidates and gmail_outreach_target_contact_confirmed_members.';

create index gmail_outreach_observed_recipients_thread_idx
  on private.gmail_outreach_observed_recipients (normalized_thread_id);

create index gmail_outreach_observed_recipients_addr_idx
  on private.gmail_outreach_observed_recipients (lower(addr_spec)) where addr_spec is not null;

create index gmail_outreach_observed_recipients_coordinate_idx
  on private.gmail_outreach_observed_recipients (
    mail_account_id, normalized_thread_id, provider_message_id, role, header_occurrence_index, participant_order
  );

create trigger gmail_outreach_observed_recipients_touch
  before update on private.gmail_outreach_observed_recipients
  for each row execute function private.touch_gmail_outreach_row();

-- ===========================================================================
-- 4. ZERO/ONE/MANY CANONICAL CONTACT LINKS — evidence only, never identity
-- ===========================================================================
-- An observed recipient's address may exactly match zero, one or several
-- existing canonical contact records. Recorded here as evidence; NEVER as a
-- single forced FK on the recipient row (a generic inbox can legitimately
-- belong to several properties; an agency contact can represent several
-- businesses). D028 applies identically here: an exact match justifies only
-- "this address corresponds to this canonical contact", never "therefore
-- this thread targeted the entity that contact belongs to."
create table private.gmail_outreach_observed_recipient_canonical_links (
  id uuid primary key default gen_random_uuid(),

  observed_recipient_id uuid not null references private.gmail_outreach_observed_recipients(id) on delete cascade,

  canonical_contact_kind text not null check (canonical_contact_kind in ('hotel_contact', 'organization_contact')),
  hotel_contact_id uuid references public.hotel_contacts(id) on delete cascade,
  organization_contact_id uuid references public.organization_contacts(id) on delete cascade,

  match_basis text not null check (match_basis in ('exact_email')),
  evaluated_epoch bigint not null,

  created_at timestamptz not null default now(),

  constraint gmail_outreach_observed_recipient_canonical_links_shape
    check (
      (canonical_contact_kind = 'hotel_contact'
        and hotel_contact_id is not null and organization_contact_id is null)
      or
      (canonical_contact_kind = 'organization_contact'
        and organization_contact_id is not null and hotel_contact_id is null)
    )
);

comment on table private.gmail_outreach_observed_recipient_canonical_links is
  'B05 MACHINE: zero/one/many exact-email links from an observed recipient to an existing hotel_contacts or organization_contacts row. Evidence only — never proof of target or target-contact identity (D028). Wholesale replaced each re-evaluation.';

create index gmail_outreach_observed_recipient_canonical_links_recipient_idx
  on private.gmail_outreach_observed_recipient_canonical_links (observed_recipient_id);

-- ===========================================================================
-- 5. MACHINE — TARGET-CONTACT INTERPRETATION (which recipient is the contact)
-- ===========================================================================
-- "Which observed recipient(s), if any, were actually targeted as commercial
-- contacts?" is a separate judgement from "who appeared in the headers"
-- (table 3). Every candidate references a stable observed recipient, never a
-- canonical contact directly.
create table private.gmail_outreach_target_contact_signals (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null references public.users(id) on delete cascade,
  mail_account_id uuid not null,
  normalized_thread_id uuid not null,

  match_quality text not null check (match_quality in (
    'strong_match', 'needs_review', 'ambiguous', 'insufficient_evidence'
  )),
  matcher_version text not null check (matcher_version ~ '^[a-z][a-z0-9_]{0,63}$'),
  evaluated_epoch bigint not null,
  candidate_set_fingerprint text not null check (candidate_set_fingerprint ~ '^[0-9a-f]{64}$'),

  evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gmail_outreach_target_contact_signals_thread_fk
    foreign key (normalized_thread_id, mail_account_id)
    references private.gmail_normalized_threads (id, mail_account_id) on delete cascade,

  constraint gmail_outreach_target_contact_signals_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  constraint gmail_outreach_target_contact_signals_identity_uidx
    unique (mail_account_id, normalized_thread_id)
);

comment on table private.gmail_outreach_target_contact_signals is
  'B05 MACHINE: overall target-contact match-quality assessment per thread. Qualitative only — never a fabricated calibrated percentage.';

create trigger gmail_outreach_target_contact_signals_touch
  before update on private.gmail_outreach_target_contact_signals
  for each row execute function private.touch_gmail_outreach_row();

create table private.gmail_outreach_target_contact_candidates (
  id uuid primary key default gen_random_uuid(),

  normalized_thread_id uuid not null,
  mail_account_id uuid not null,
  observed_recipient_id uuid not null references private.gmail_outreach_observed_recipients(id) on delete cascade,

  role_evidence text not null check (role_evidence in ('agrees', 'differs', 'unavailable')),
  address_pattern_evidence text not null check (address_pattern_evidence in ('named_person', 'generic_inbox', 'unavailable')),
  rank integer not null check (rank >= 0),

  created_at timestamptz not null default now(),

  constraint gmail_outreach_target_contact_candidates_thread_fk
    foreign key (normalized_thread_id, mail_account_id)
    references private.gmail_normalized_threads (id, mail_account_id) on delete cascade
);

comment on table private.gmail_outreach_target_contact_candidates is
  'B05 MACHINE: ranked target-contact candidates, each a real observed recipient. Wholesale replaced each re-evaluation. No numeric score — evidence columns only.';

create index gmail_outreach_target_contact_candidates_thread_idx
  on private.gmail_outreach_target_contact_candidates (normalized_thread_id);

-- ===========================================================================
-- 6. PRIVATE TARGET OBSERVATIONS — stable, independent of canonical inventory
-- ===========================================================================
-- "The Gmail evidence supports that this commercial target was part of the
-- creator's historical outreach" — independently of whether theugc.life's
-- canonical inventory currently contains a matching hotel or organization.
--
-- STABILITY (EXTERNAL AUDIT AMENDMENT #3, Finding 3): `observation_
-- fingerprint` is a deterministic digest over every MATERIAL semantic
-- identity/matching-evidence dimension the caller extracted — domain AND
-- normalized observed name (`computeTargetObservationFingerprint` in
-- target-extraction.ts) — never domain alone. `observed_name` is not
-- cosmetic here (unlike an observed recipient's `display_name`): `matchTarget
-- Observation` reads it as an independent canonical-matching evidence
-- dimension, so it MUST be part of the fact's identity/version — the same
-- epistemic principle Amendment #2's Finding 1 already applied to observed
-- recipients. Re-extraction upserts by (thread, fingerprint) — a recognized
-- observation's IDENTITY fields (`observed_name`, `observed_domain`,
-- `target_kind_hint`) are never rewritten, so a creator confirmation
-- referencing it (gmail_outreach_target_confirmations) is never orphaned or
-- silently reassigned to different real-world evidence. Only the ADVISORY
-- columns (machine_canonical_link_assessment, matcher_version,
-- evaluated_epoch, candidate_set_fingerprint) may be updated in place by a
-- later re-run; MATERIALLY DIFFERENT evidence at the same domain (a
-- different fingerprint) creates a NEW, additional observation — old
-- confirmation intact, new observation unconfirmed — rather than rewriting
-- the old one's identity while its advisory fields silently drift to
-- reflect the new evidence.
create table private.gmail_outreach_target_observations (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null references public.users(id) on delete cascade,
  mail_account_id uuid not null,
  normalized_thread_id uuid not null,

  observation_fingerprint text not null check (observation_fingerprint ~ '^[0-9a-f]{64}$'),

  -- IDENTITY FIELDS — written once, never rewritten by a later re-run.
  observed_name text,
  observed_domain text,
  target_kind_hint text not null default 'unknown' check (target_kind_hint in ('hotel', 'organization', 'unknown')),
  -- EXTERNAL AUDIT AMENDMENT #5, Finding 1: the explicit observation-source
  -- distinction. `recipient_domain` (the historical shape) is derived purely
  -- from a non-freemail `to`-recipient's domain; `authored_text_name` is a
  -- commercial target the creator's OWN authored SENT text explicitly, exactly
  -- named in a target-directed context, independent of any recipient address
  -- (`observed_domain` is null for this kind). Part of the fingerprint's own
  -- input (see `computeTargetObservationFingerprint`), so the two kinds can
  -- never collide even when they end up naming the same canonical business —
  -- the canonical row remains only ever a 0..N LINK (table 7), never this
  -- fact's identity, for either kind.
  observation_source_kind text not null default 'recipient_domain'
    check (observation_source_kind in ('recipient_domain', 'authored_text_name')),

  -- DURABLE, VERIFIED, EVOLVING PROVENANCE (Finding 1/12; grows per
  -- Amendment #3 Finding 3). `provider_message_id` — Gmail's own permanent
  -- id, not a B04 row uuid — so provenance survives a B04 rebuild exactly
  -- like the observed-recipient coordinates above. The commit RPC verifies
  -- every entry here actually belongs to this exact thread/account BEFORE
  -- it is added; a caller cannot assert provenance the database has not
  -- itself confirmed. Unlike the IDENTITY fields above, this array is
  -- allowed to GROW on reconciliation (a distinct union, never a rewrite or
  -- a shrink) — an additional SENT follow-up naming the SAME target fact
  -- honestly adds to its supporting evidence rather than being silently
  -- dropped.
  source_provider_message_ids text[] not null,
  constraint gmail_outreach_target_observations_source_nonempty
    check (cardinality(source_provider_message_ids) > 0),

  -- ADVISORY FIELDS — machine-replaceable, never authoritative.
  machine_canonical_link_assessment text check (machine_canonical_link_assessment in (
    'strong_match', 'needs_review', 'ambiguous', 'insufficient_evidence'
  )),
  matcher_version text check (matcher_version ~ '^[a-z][a-z0-9_]{0,63}$'),
  evaluated_epoch bigint,
  candidate_set_fingerprint text check (candidate_set_fingerprint ~ '^[0-9a-f]{64}$'),
  -- EXTERNAL AUDIT AMENDMENT #6, Finding 3: explicit MACHINE current-
  -- membership, distinct from durable historical existence. Human-history
  -- preservation (this row is never deleted just because a later
  -- interpretation stops supporting it) is correct and unchanged — but
  -- without this flag there was no way to tell "the machine's CURRENT
  -- interpretation still includes this fact" apart from "this fact was ever
  -- observed". `gmail_outreach_commit_interpretation` sets this `true` for
  -- every observation fingerprint present in the COMPLETE current set it
  -- was given for a thread, and `false` for every OTHER previously-current
  -- row for that thread absent from it — never touching identity fields or
  -- any human confirmation. A fact that later genuinely reappears in current
  -- evidence simply flips back to `true` on the SAME durable row.
  machine_is_current boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gmail_outreach_target_observations_thread_fk
    foreign key (normalized_thread_id, mail_account_id)
    references private.gmail_normalized_threads (id, mail_account_id) on delete cascade,

  constraint gmail_outreach_target_observations_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  -- THE RECONCILIATION KEY.
  constraint gmail_outreach_target_observations_fingerprint_uidx
    unique (mail_account_id, normalized_thread_id, observation_fingerprint)
);

comment on table private.gmail_outreach_target_observations is
  'B05: a private, stable commercial-target fact, independent of canonical inventory. Never automatically creates a hotel, organization, brand or business. A creator confirms THIS row (gmail_outreach_target_confirmations), never a canonical row directly, so a later canonical link never rewrites a creator''s historical confirmation.';

create index gmail_outreach_target_observations_thread_idx
  on private.gmail_outreach_target_observations (normalized_thread_id);

create trigger gmail_outreach_target_observations_touch
  before update on private.gmail_outreach_target_observations
  for each row execute function private.touch_gmail_outreach_row();

-- ===========================================================================
-- 7. ZERO/ONE/MANY CANONICAL TARGET LINKS
-- ===========================================================================
-- A private target observation may resolve to no canonical candidate, one
-- strong candidate, or several ambiguous ones. `target_kind` is closed and
-- additively extensible: adding a future kind (brand, restaurant, airline...)
-- is a new CHECK value plus one new nullable FK column, and never
-- reinterprets an existing row's kind or FK. Never creates or mutates
-- canonical inventory.
create table private.gmail_outreach_target_canonical_links (
  id uuid primary key default gen_random_uuid(),

  target_observation_id uuid not null references private.gmail_outreach_target_observations(id) on delete cascade,

  target_kind text not null check (target_kind in ('hotel', 'organization')),
  target_hotel_id uuid references public.hotels(id) on delete cascade,
  target_organization_id uuid references public.organizations(id) on delete cascade,

  name_evidence text not null check (name_evidence in ('agrees', 'differs', 'unavailable')),
  domain_evidence text not null check (domain_evidence in ('agrees', 'differs', 'unavailable')),
  address_evidence text not null check (address_evidence in ('agrees', 'differs', 'unavailable')),
  contact_evidence text not null check (contact_evidence in ('agrees', 'differs', 'unavailable')),
  -- EXTERNAL AUDIT AMENDMENT #4, Finding 2: an INDEPENDENT evidence
  -- dimension from a deterministic exact-name match between the creator's
  -- own authored SENT text and this real canonical business's name — never
  -- derived from the recipient's address/domain/contact at all. `agrees`
  -- means the creator's own text explicitly named THIS business; `differs`
  -- means the creator's text explicitly named a DIFFERENT real canonical
  -- business instead (a genuine, honest contradiction with whatever
  -- domain/contact evidence this row otherwise carries); `unavailable` means
  -- no deterministic exact business-name evidence was found in the text at
  -- all. See `matchTargetObservation`'s contradiction handling: a candidate
  -- with `differs` here can never be assessed `strong_match`, regardless of
  -- how strong its domain/contact evidence is — weaker positional evidence
  -- must never silently overrule what the creator explicitly wrote.
  authored_text_evidence text not null default 'unavailable' check (authored_text_evidence in ('agrees', 'differs', 'unavailable')),
  rank integer not null check (rank >= 0),

  created_at timestamptz not null default now(),

  constraint gmail_outreach_target_canonical_links_shape
    check (
      (target_kind = 'hotel' and target_hotel_id is not null and target_organization_id is null)
      or
      (target_kind = 'organization' and target_organization_id is not null and target_hotel_id is null)
    )
);

comment on table private.gmail_outreach_target_canonical_links is
  'B05 MACHINE: zero/one/many canonical hotel/organization candidates for a private target observation. Conservative evidence columns only, no numeric score (D063 §12.2). Wholesale replaced per observation each re-evaluation.';

create index gmail_outreach_target_canonical_links_observation_idx
  on private.gmail_outreach_target_canonical_links (target_observation_id);

-- ===========================================================================
-- 7b. MACHINE — THREAD-LEVEL TARGET-SCOPE SIGNAL (EXTERNAL AUDIT AMENDMENT #1, Finding 6)
-- ===========================================================================
-- D070 accepted target_scope as its own axis with a MACHINE-advisory half and
-- a CREATOR-authoritative half (§9a's `target_scope_decision`); the original
-- 0039 implemented only the creator half. This is the missing machine half —
-- thread-level (never duplicated per observation), conservative, and it
-- NEVER decides anything: the creator's decision is authoritative regardless
-- of what this table says, and the two may permanently disagree (the Ogilvy/
-- Marriott-Caribbean-Partnerships case — the same organization can be a
-- `single_target` in one creator's judgement on one thread and a `portfolio_
-- target` on another).
create table private.gmail_outreach_target_scope_signals (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null references public.users(id) on delete cascade,
  mail_account_id uuid not null,
  normalized_thread_id uuid not null,

  machine_target_scope text not null check (machine_target_scope in (
    'single_target', 'multiple_targets', 'portfolio_target', 'unresolved'
  )),
  reason_codes text[] not null default '{}',
  matcher_version text not null check (matcher_version ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- EXTERNAL AUDIT AMENDMENT #2, Finding 4: scope evidence now reads
  -- `hotel_organizations` portfolio relationships (part of the catalog), so
  -- this signal is catalog-epoch-sensitive exactly like target_contact_
  -- signals already was — the two-level fast path needs this to tell "the
  -- matcher version is the same but the catalog moved" apart from "nothing
  -- relevant changed at all".
  evaluated_epoch bigint not null,

  evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gmail_outreach_target_scope_signals_thread_fk
    foreign key (normalized_thread_id, mail_account_id)
    references private.gmail_normalized_threads (id, mail_account_id) on delete cascade,

  constraint gmail_outreach_target_scope_signals_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  constraint gmail_outreach_target_scope_signals_identity_uidx
    unique (mail_account_id, normalized_thread_id)
);

comment on table private.gmail_outreach_target_scope_signals is
  'B05 MACHINE: advisory, thread-level target-scope hint. Never authoritative — see gmail_outreach_creator_decisions.target_scope_decision for the creator''s (possibly disagreeing) authoritative answer. A conservative V1 baseline may legitimately return unresolved whenever the evidence does not honestly support a stronger inference.';

create trigger gmail_outreach_target_scope_signals_touch
  before update on private.gmail_outreach_target_scope_signals
  for each row execute function private.touch_gmail_outreach_row();

-- ===========================================================================
-- 8. HUMAN — IMMUTABLE DECISION EVENTS (all four axes, one ledger)
-- ===========================================================================
-- Append-only. `event_seq` is the ONLY thing that decides "latest" — never a
-- caller timestamp, never `created_at` (identical for two events written in
-- the same transaction), never UUID order. A machine worker can NEVER insert
-- here: no machine commit function in this migration references this table.
create table private.gmail_outreach_creator_decision_events (
  id uuid primary key default gen_random_uuid(),
  event_seq bigint generated always as identity,

  user_id uuid not null references public.users(id) on delete cascade,
  mail_account_id uuid not null,
  normalized_thread_id uuid not null,

  axis text not null check (axis in ('outreach', 'target_scope', 'target', 'target_contact')),
  decided_by_user_id uuid not null references public.users(id),

  -- axis = 'outreach'
  outreach_decision text check (outreach_decision in ('outreach_confirmed', 'not_outreach_confirmed')),
  -- axis = 'target_scope'
  target_scope_decision text check (target_scope_decision in (
    'single_target', 'multiple_targets', 'portfolio_target', 'unresolved'
  )),
  -- axis in ('target', 'target_contact')
  target_action text check (target_action in ('confirm', 'remove')),
  -- axis = 'target'
  target_observation_id uuid references private.gmail_outreach_target_observations(id),
  -- axis = 'target_contact'
  observed_recipient_id uuid references private.gmail_outreach_observed_recipients(id),

  -- Context only, never authorization.
  observed_machine_state text,
  observed_version text,

  decided_at timestamptz not null default now(),

  constraint gmail_outreach_creator_decision_events_thread_fk
    foreign key (normalized_thread_id, mail_account_id)
    references private.gmail_normalized_threads (id, mail_account_id) on delete cascade,

  constraint gmail_outreach_creator_decision_events_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  -- decided_by_user_id must be the mailbox owner — no delegation, mirroring
  -- B01's consent receipts exactly.
  constraint gmail_outreach_creator_decision_events_owner_only
    check (decided_by_user_id = user_id),

  constraint gmail_outreach_creator_decision_events_shape
    check (
      (axis = 'outreach' and outreach_decision is not null and target_scope_decision is null
        and target_action is null and target_observation_id is null and observed_recipient_id is null)
      or
      (axis = 'target_scope' and target_scope_decision is not null and outreach_decision is null
        and target_action is null and target_observation_id is null and observed_recipient_id is null)
      or
      (axis = 'target' and target_action is not null and target_observation_id is not null
        and outreach_decision is null and target_scope_decision is null and observed_recipient_id is null)
      or
      (axis = 'target_contact' and target_action is not null and observed_recipient_id is not null
        and outreach_decision is null and target_scope_decision is null and target_observation_id is null)
    )
);

comment on table private.gmail_outreach_creator_decision_events is
  'B05 HUMAN layer: immutable, append-only creator decision history across all four axes (outreach, target_scope, target, target_contact). event_seq is the sole ordering authority. No machine function writes here.';

create index gmail_outreach_creator_decision_events_thread_idx
  on private.gmail_outreach_creator_decision_events (normalized_thread_id, axis, event_seq);

-- ===========================================================================
-- 9. HUMAN — CURRENT PROJECTIONS
-- ===========================================================================

-- 9a. Scalar decisions: outreach + target_scope, one row per thread.
create table private.gmail_outreach_creator_decisions (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null references public.users(id) on delete cascade,
  mail_account_id uuid not null,
  normalized_thread_id uuid not null,

  outreach_decision text check (outreach_decision in ('outreach_confirmed', 'not_outreach_confirmed')),
  current_outreach_event_id uuid references private.gmail_outreach_creator_decision_events(id),
  -- EXTERNAL AUDIT AMENDMENT #1, Finding 3: the event's own `event_seq`,
  -- denormalized here so the projection UPDATE below can compare orderings
  -- without a second lookup. This is what makes "the projection may only
  -- advance, never move backwards" enforceable under real concurrency: two
  -- correcting transactions racing to record seq 100 and seq 101 are
  -- serialized by the row lock this table's own unique index takes, and
  -- whichever one carries the LOWER seq loses the `where` guard below,
  -- however the two transactions actually finish.
  current_outreach_event_seq bigint,

  target_scope_decision text check (target_scope_decision in (
    'single_target', 'multiple_targets', 'portfolio_target', 'unresolved'
  )),
  current_target_scope_event_id uuid references private.gmail_outreach_creator_decision_events(id),
  current_target_scope_event_seq bigint,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gmail_outreach_creator_decisions_thread_fk
    foreign key (normalized_thread_id, mail_account_id)
    references private.gmail_normalized_threads (id, mail_account_id) on delete cascade,

  constraint gmail_outreach_creator_decisions_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  constraint gmail_outreach_creator_decisions_identity_uidx
    unique (mail_account_id, normalized_thread_id)
);

comment on table private.gmail_outreach_creator_decisions is
  'B05 HUMAN layer: current scalar creator decisions (outreach, target_scope) per thread. Authoritative. Never overwritten by a machine re-run, and never moved backwards by a concurrent correction with a lower event_seq (Finding 3). Consistency between target_scope_decision and the confirmed-target-member set (gmail_outreach_target_confirmations) is surfaced as a read-time status, never enforced as a write-time order.';

create trigger gmail_outreach_creator_decisions_touch
  before update on private.gmail_outreach_creator_decisions
  for each row execute function private.touch_gmail_outreach_row();

-- 9b. Confirmed target set (may be many rows per thread — multi/portfolio scope).
--
-- EXTERNAL AUDIT AMENDMENT #1, Finding 3: a bare insert-on-confirm/delete-on-
-- remove design destroys the only ordering evidence a 'remove' had, so a
-- late-arriving stale 'confirm' (event_seq 100, delayed in flight) could
-- resurrect a row after a newer 'remove' (event_seq 101) already deleted it
-- — silently reverting a later decision. This table instead keeps ONE row
-- per (thread, observation) for as long as any decision on it has ever been
-- made — confirm and remove both UPDATE it — with `is_confirmed` carrying
-- the current membership fact and `current_event_seq` guarding every write
-- the same way §9a's scalar axes are guarded: a write only applies when its
-- event_seq is strictly greater than the row's current one.
create table private.gmail_outreach_target_confirmations (
  id uuid primary key default gen_random_uuid(),

  mail_account_id uuid not null,
  normalized_thread_id uuid not null,
  target_observation_id uuid not null references private.gmail_outreach_target_observations(id) on delete cascade,

  is_confirmed boolean not null,
  current_event_id uuid not null references private.gmail_outreach_creator_decision_events(id),
  current_event_seq bigint not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gmail_outreach_target_confirmations_thread_fk
    foreign key (normalized_thread_id, mail_account_id)
    references private.gmail_normalized_threads (id, mail_account_id) on delete cascade,

  -- ONE ROW PER (thread, observation), for as long as it has ever been
  -- decided. Membership is `is_confirmed = true`, never row presence.
  constraint gmail_outreach_target_confirmations_uidx
    unique (normalized_thread_id, target_observation_id)
);

comment on table private.gmail_outreach_target_confirmations is
  'B05 HUMAN layer: the creator''s current confirm/remove decision per (thread, target observation), each anchored to a private target observation — never a canonical hotel/organization row directly. `is_confirmed = true` is the confirmed-target membership test, never row presence — a row survives a `remove` as a tombstone so a stale, delayed `confirm` from an earlier event_seq can never resurrect it (Finding 3). A canonical link added or changed later never rewrites this row.';

create trigger gmail_outreach_target_confirmations_touch
  before update on private.gmail_outreach_target_confirmations
  for each row execute function private.touch_gmail_outreach_row();

-- 9c. Confirmed target-contact set (may be many — multiple legitimate contacts).
-- Same tombstone-and-monotonic-seq design as 9b, for the identical reason.
create table private.gmail_outreach_target_contact_confirmed_members (
  id uuid primary key default gen_random_uuid(),

  mail_account_id uuid not null,
  normalized_thread_id uuid not null,
  observed_recipient_id uuid not null references private.gmail_outreach_observed_recipients(id) on delete cascade,

  is_confirmed boolean not null,
  current_event_id uuid not null references private.gmail_outreach_creator_decision_events(id),
  current_event_seq bigint not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gmail_outreach_target_contact_confirmed_members_thread_fk
    foreign key (normalized_thread_id, mail_account_id)
    references private.gmail_normalized_threads (id, mail_account_id) on delete cascade,

  constraint gmail_outreach_target_contact_confirmed_members_uidx
    unique (normalized_thread_id, observed_recipient_id)
);

comment on table private.gmail_outreach_target_contact_confirmed_members is
  'B05 HUMAN layer: the creator''s current confirm/remove decision per (thread, observed recipient), each anchored to a stable observed recipient — never a canonical contact row directly. `is_confirmed = true` is the confirmed-membership test, never row presence (Finding 3, same tombstone rationale as gmail_outreach_target_confirmations).';

create trigger gmail_outreach_target_contact_confirmed_members_touch
  before update on private.gmail_outreach_target_contact_confirmed_members
  for each row execute function private.touch_gmail_outreach_row();

-- ===========================================================================
-- 10. `deleted` MUST NOT COEXIST WITH B05 DATA
-- ===========================================================================
-- Same falsifiable assertion B03/B04 enforce, extended to this layer.
-- Checking `gmail_outreach_thread_signals` and `gmail_outreach_creator_
-- decisions` is sufficient: every other B05 table requires one of those two
-- (directly or transitively via a thread/observation/recipient FK), or the
-- thread itself, so if neither survives for the account nothing beneath
-- either can. Registered on `mail_accounts` and on both top-level tables, and
-- separately on `gmail_outreach_target_observations` and `gmail_outreach_
-- observed_recipients` since a thread could in principle carry observations/
-- recipients with no signal/decision row yet (e.g. a partially-purged or
-- never-classified thread should not be able to retain them either).
create or replace function public.assert_gmail_outreach_data_absent_when_deleted()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  account_id uuid;
  account_state text;
  remaining_count integer;
begin
  if tg_table_name = 'mail_accounts' then
    account_id := coalesce(new.id, old.id);
  else
    account_id := coalesce(new.mail_account_id, old.mail_account_id);
  end if;

  if account_id is null then
    return null;
  end if;

  select m.connection_state into account_state
    from public.mail_accounts m where m.id = account_id;

  if not found or account_state <> 'deleted' then
    return null;
  end if;

  select
    (select count(*) from private.gmail_outreach_thread_signals where mail_account_id = account_id)
    + (select count(*) from private.gmail_outreach_creator_decisions where mail_account_id = account_id)
    + (select count(*) from private.gmail_outreach_target_observations where mail_account_id = account_id)
    + (select count(*) from private.gmail_outreach_observed_recipients where mail_account_id = account_id)
    + (select count(*) from private.gmail_outreach_target_scope_signals where mail_account_id = account_id)
    into remaining_count;

  if remaining_count > 0 then
    raise exception
      'mail account % is `deleted` while B05 outreach-interpretation state remains (% top-level row(s) across signals/decisions/observations/recipients/scope-signals). B05-derived Gmail data must not survive a completed deletion.',
      account_id, remaining_count
      using errcode = 'integrity_constraint_violation';
  end if;

  return null;
end;
$$;

revoke all on function public.assert_gmail_outreach_data_absent_when_deleted() from public;
revoke all on function public.assert_gmail_outreach_data_absent_when_deleted() from anon, authenticated;

create constraint trigger mail_accounts_gmail_outreach_absent_when_deleted
  after insert or update on public.mail_accounts
  deferrable initially deferred
  for each row execute function public.assert_gmail_outreach_data_absent_when_deleted();

create constraint trigger gmail_outreach_thread_signals_absent_when_deleted
  after insert or update on private.gmail_outreach_thread_signals
  deferrable initially deferred
  for each row execute function public.assert_gmail_outreach_data_absent_when_deleted();

create constraint trigger gmail_outreach_creator_decisions_absent_when_deleted
  after insert or update on private.gmail_outreach_creator_decisions
  deferrable initially deferred
  for each row execute function public.assert_gmail_outreach_data_absent_when_deleted();

create constraint trigger gmail_outreach_target_observations_absent_when_deleted
  after insert or update on private.gmail_outreach_target_observations
  deferrable initially deferred
  for each row execute function public.assert_gmail_outreach_data_absent_when_deleted();

create constraint trigger gmail_outreach_observed_recipients_absent_when_deleted
  after insert or update on private.gmail_outreach_observed_recipients
  deferrable initially deferred
  for each row execute function public.assert_gmail_outreach_data_absent_when_deleted();

-- ===========================================================================
-- 10b. MAY WE PROCESS THIS MAILBOX'S CONTENT RIGHT NOW? (EXTERNAL AUDIT
-- AMENDMENT #2, Finding 2)
-- ===========================================================================
-- B04 gates on `connection_state <> 'deleted'` alone, and that is defensible
-- for a projection that performs no new judgement over private content — it
-- normalizes structure, nothing more. B05 is different: it reads message
-- text, classifies commercial intent and matches business identity, which
-- is exactly the kind of new judgement B01's consent boundary exists to
-- gate. "B05 follows B04's precedent" is therefore not a fix — B05 binds to
-- the actual authoritative answer instead: `public.mail_account_has_
-- consent(account_id, 'private_gmail_processing')`.
--
-- RETENTION vs NEW PROCESSING (explicit, not implied): withdrawing consent,
-- or a mailbox entering `deletion_pending`, NEVER deletes or hides EXISTING
-- gmail_outreach_* rows — that remains a decision solely for gmail_outreach_
-- purge_for_deletion, driven by an explicit deletion request. This predicate
-- gates only whether NEW machine work (offering a thread, reading its
-- evidence, or committing a fresh interpretation) may happen from this
-- moment forward. `gmail_outreach_status` and `gmail_outreach_purge_for_
-- deletion` never call this — reading counts and purging on request are not
-- "new processing" and must keep working regardless of current consent.
--
-- This unlocked, `stable` form is for the two READ paths (list_candidates,
-- get_thread_evidence): nothing is committed there, so a race against a
-- concurrent withdrawal is harmless — the WRITE path's own fence (inside
-- gmail_outreach_commit_interpretation) is what actually has to be airtight,
-- and that one takes a real `for share` lock on the exact consent row rather
-- than calling this function (see that function's own comment).
create or replace function private.gmail_outreach_may_process(
  p_mail_account_id uuid
)
returns text
language plpgsql
stable
as $$
declare
  v_state text;
begin
  select connection_state into v_state from public.mail_accounts where id = p_mail_account_id;

  if not found then
    return 'not_found';
  end if;
  if v_state = 'deleted' then
    return 'account_deleted';
  end if;
  if v_state = 'deletion_pending' then
    return 'deletion_pending';
  end if;
  if not public.mail_account_has_consent(p_mail_account_id, 'private_gmail_processing') then
    return 'consent_missing';
  end if;

  return 'ok';
end;
$$;

revoke all on function private.gmail_outreach_may_process(uuid) from public;

-- ---------------------------------------------------------------------------
-- 10c. THE REAL LOCKED FENCE FOR B05's TWO WRITE PATHS (EXTERNAL AUDIT
-- AMENDMENT #3, Findings 1 & 2)
-- ---------------------------------------------------------------------------
-- `gmail_outreach_may_process` above is an unlocked, best-effort read — fine
-- for the two paths that commit nothing. Both of B05's WRITE paths
-- (`gmail_outreach_commit_interpretation`, the sole MACHINE writer, and
-- `gmail_outreach_record_creator_decision`, the sole HUMAN writer — a
-- creator confirmation/correction is itself NEW Gmail-derived processing,
-- exactly like a machine commit) must hold a transactionally stable answer
-- to BOTH "is private_gmail_processing currently granted" and "does the
-- mailbox's lifecycle currently permit new processing" at the moment they
-- write — not a value read earlier in the same function that a concurrent
-- withdrawal or deletion-start could have already invalidated.
--
-- LOCK ORDER IS THE WHOLE SAFETY ARGUMENT. B01's own consent-withdrawal
-- writer (`tests/gmail-import/harness.ts`'s `withdrawConsent`, mirroring the
-- real product flow) updates `mail_account_consents` FIRST, then
-- `mail_accounts` SECOND. This function locks the SAME TWO ROWS in that
-- SAME order — consent, then mail_accounts — so it can never be the
-- "reverse-order" half of a lock-order deadlock against that writer: two
-- transactions that always acquire shared resources in the same relative
-- order can never form a wait-for cycle. B01's deletion-start writer
-- (`startDeletion`) never touches the consent row at all — it only updates
-- `mail_accounts` — so it can only ever conflict with the SECOND lock this
-- function takes, never create a cycle either.
--
-- `deleted` is checked once, early, WITHOUT a lock: it is a terminal state
-- with no path back (0039 §10's own absent-when-deleted assertion means
-- nothing B05-shaped can exist for a `deleted` account regardless), so no
-- concurrent transition into or out of it is possible to race against.
-- `deletion_pending` is the one live transition (`connected` ->
-- `deletion_pending`) a concurrent deletion-start can make WHILE this
-- function is running, which is exactly why its check is the one that must
-- be locked.
create or replace function private.gmail_outreach_assert_may_process_locked(
  p_mail_account_id uuid
)
returns text
language plpgsql
as $$
declare
  v_consent_state text;
  v_connection_state text;
begin
  -- LOCK 1 of 2: the consent projection row.
  select c.state into v_consent_state
    from public.mail_account_consents c
   where c.mail_account_id = p_mail_account_id
     and c.consent_kind = 'private_gmail_processing'
   for share;

  if v_consent_state is distinct from 'granted' then
    return 'consent_missing';
  end if;

  -- LOCK 2 of 2: the mail account lifecycle row, taken AFTER the consent
  -- lock above, never before — the ordering a concurrent deletion-start
  -- (which never touches consent) cannot violate, and the same ordering
  -- B01's own withdrawal writer already uses.
  select m.connection_state into v_connection_state
    from public.mail_accounts m
   where m.id = p_mail_account_id
   for share;

  if not found then
    return 'not_found';
  end if;
  if v_connection_state = 'deleted' then
    return 'account_deleted';
  end if;
  if v_connection_state = 'deletion_pending' then
    return 'deletion_pending';
  end if;

  return 'ok';
end;
$$;

revoke all on function private.gmail_outreach_assert_may_process_locked(uuid) from public;

-- ===========================================================================
-- 11. RPC SURFACE
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 11a. WHICH THREADS NEED (RE)INTERPRETATION
-- ---------------------------------------------------------------------------
-- EXTERNAL AUDIT AMENDMENT #1, Finding 4: staleness now also considers the
-- MATCHER version and the coarse catalog epoch, not detector version alone —
-- a matcher-version bump (target/contact matching rules changed) or a moved
-- catalog epoch (the canonical universe might have changed) must schedule a
-- thread for re-evaluation exactly like a detector-version bump already did.
-- This is deliberately still a CHEAP, coarse filter: it decides only whether
-- a thread is OFFERED for re-evaluation, never whether the expensive
-- semantic re-match actually runs — that decision is the per-observation
-- `candidate_set_fingerprint` comparison TS performs once it has read the
-- thread's actual evidence (§11c/service.ts), so an unrelated catalog change
-- elsewhere still costs this function nothing beyond one integer comparison
-- per thread.
create or replace function public.gmail_outreach_list_candidates(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_detector_version text,
  p_matcher_version text,
  p_current_catalog_epoch bigint,
  p_limit integer,
  p_exclude_normalized_thread_ids uuid[] default '{}'::uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_rows jsonb;
  v_may_process text;
begin
  if p_detector_version !~ '^[a-z][a-z0-9_]{0,63}$' or p_matcher_version !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'invalid detector/matcher version' using errcode = 'invalid_parameter_value';
  end if;

  if p_limit is null or p_limit < 1 or p_limit <> trunc(p_limit) then
    raise exception 'p_limit must be a positive integer, got %', p_limit
      using errcode = 'invalid_parameter_value';
  end if;

  v_may_process := private.gmail_outreach_may_process(p_mail_account_id);
  if v_may_process <> 'ok' then
    return jsonb_build_object('result', v_may_process, 'candidates', '[]'::jsonb);
  end if;

  -- EXTERNAL AUDIT AMENDMENT #2, Finding 4: each candidate now carries WHY it
  -- is stale, so TS can pick the cheapest honest path instead of always
  -- rerunning full interpretation on every offered thread:
  --
  --   source_stale    B04 evidence itself moved (new/changed messages) or
  --                   the detector was never run / bumped — the classifier
  --                   MUST rerun; nothing about the old outreach_status can
  --                   be trusted.
  --   matcher_stale    source is fresh, but the matching rules changed (or
  --                   target/target-contact signals were never computed) —
  --                   the classifier is skipped, only matching reruns.
  --   catalog_stale    source AND matcher are both fresh; only the coarse
  --                   catalog epoch moved. TS regenerates the bounded
  --                   catalog snapshot cheaply and compares its fingerprint
  --                   before deciding whether matching needs to rerun at
  --                   all (service.ts's interpretOneThread).
  --
  -- EXTERNAL AUDIT AMENDMENT #4, Finding 4: `source_stale` used to compare
  -- `m.normalized_at > s.evaluated_at` — timestamp ORDERING, not evidence
  -- IDENTITY. A concurrent B04 rebuild transaction that begins before, but
  -- commits after, this account's own commit can carry a `normalized_at`
  -- from its transaction START, which can sort BEFORE the signal's
  -- `evaluated_at` even though the content genuinely changed — a stale
  -- machine projection could then never be offered for re-evaluation again.
  -- `s.evidence_digest` is already the exact same deterministic, content-
  -- addressed fence `gmail_outreach_commit_interpretation` itself recomputes
  -- and verifies at commit time (§11c) — comparing the CURRENT digest
  -- against it here is correct regardless of any transaction's timing,
  -- because it depends only on the actual committed content of
  -- `gmail_normalized_messages`, never on when anything happened to commit.
  select coalesce(jsonb_agg(row), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
               'normalized_thread_id', t.id,
               'provider_thread_id', t.provider_thread_id,
               'source_stale', (
                 s.id is null
                 or s.detector_version is distinct from p_detector_version
                 or s.evidence_digest is distinct from cur.evidence_digest
               ),
               'matcher_stale', (
                 tc.id is null
                 or tc.matcher_version is distinct from p_matcher_version
                 or ts.id is null
                 or ts.matcher_version is distinct from p_matcher_version
               ),
               'catalog_stale', (
                 tc.evaluated_epoch is distinct from p_current_catalog_epoch
                 or ts.evaluated_epoch is distinct from p_current_catalog_epoch
               )
             ) as row
        from private.gmail_normalized_threads t
        left join private.gmail_outreach_thread_signals s
          on s.normalized_thread_id = t.id and s.mail_account_id = t.mail_account_id
        left join private.gmail_outreach_target_contact_signals tc
          on tc.normalized_thread_id = t.id and tc.mail_account_id = t.mail_account_id
        left join private.gmail_outreach_target_scope_signals ts
          on ts.normalized_thread_id = t.id and ts.mail_account_id = t.mail_account_id
        left join lateral (
          select encode(
                   digest(
                     coalesce(
                       string_agg(
                         m.id::text || ':' || m.source_payload_sha256 || ':' || m.provider_sent::text,
                         '|' order by m.id
                       ),
                       ''
                     ),
                     'sha256'
                   ),
                   'hex'
                 ) as evidence_digest
            from private.gmail_normalized_messages m
           where m.normalized_thread_id = t.id
        ) cur on true
       where t.mail_account_id = p_mail_account_id
         and t.user_id = p_user_id
         and not (t.id = any(coalesce(p_exclude_normalized_thread_ids, '{}'::uuid[])))
         and (
           s.id is null
           or s.detector_version is distinct from p_detector_version
           or s.evidence_digest is distinct from cur.evidence_digest
           or tc.id is null
           or tc.matcher_version is distinct from p_matcher_version
           or tc.evaluated_epoch is distinct from p_current_catalog_epoch
           or ts.id is null
           or ts.matcher_version is distinct from p_matcher_version
           or ts.evaluated_epoch is distinct from p_current_catalog_epoch
         )
       order by t.id asc
       limit p_limit
    ) candidates;

  return jsonb_build_object('result', 'ok', 'candidates', v_rows);
end;
$$;

revoke all on function public.gmail_outreach_list_candidates(uuid, uuid, text, text, bigint, integer, uuid[]) from public;

-- ---------------------------------------------------------------------------
-- 11a-bis. BOUNDED, EXACT CATALOG SNAPSHOT (EXTERNAL AUDIT AMENDMENT #2, Finding 8)
-- ---------------------------------------------------------------------------
-- `getCatalogSnapshot` (service.ts) used to build its own PostgREST `.or()`
-- filter strings with `email.ilike.<address>` / `website_url.ilike.%<domain>%`
-- literals. `escapeOrFilterValue()` stripped only the filter-DSL's OWN
-- delimiters (commas/parens), never ILIKE's own wildcard metacharacters
-- (`%`/`_`) inside the literal itself — a legally-shaped local-part or
-- domain containing either character would silently broaden the match
-- (never an injection, but a real lookup-broadening/lookalike risk). This
-- one RPC replaces both filter strings with parameterized, exact
-- comparisons instead: email lookup is `lower(email) = any(...)` — no
-- wildcard semantics of any kind, exact equality only — and the
-- website-domain substring test escapes `%`, `_` and the escape character
-- itself before building its ILIKE pattern, so a domain containing those
-- characters is matched LITERALLY rather than as wildcards.
create or replace function private.escape_like_pattern(value text)
returns text
language sql
immutable
as $$
  select replace(replace(replace(value, '\', '\\'), '%', '\%'), '_', '\_');
$$;

revoke all on function private.escape_like_pattern(text) from public;

-- EXTERNAL AUDIT AMENDMENT #4, Finding 2: mirrors `normalizeName()` in
-- target-extraction.ts EXACTLY (lower-case, collapse every run of non-
-- alphanumeric characters to one space, trim) so a deterministic candidate
-- phrase extracted from creator-authored text and a real catalog name can be
-- compared for TRUE equality on both the SQL bounding side and the TS
-- evidence-assignment side without the two ever silently disagreeing.
create or replace function private.normalize_business_name(value text)
returns text
language sql
immutable
as $$
  select trim(regexp_replace(lower(coalesce(value, '')), '[^a-z0-9]+', ' ', 'g'));
$$;

revoke all on function private.normalize_business_name(text) from public;

create or replace function public.gmail_outreach_catalog_snapshot(
  p_addresses text[],
  p_domains text[],
  p_candidate_names text[] default '{}'::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
stable
as $$
declare
  v_addresses text[];
  v_domains text[];
  v_candidate_names text[];
  v_hotel_contacts jsonb;
  v_organization_contacts jsonb;
  v_matched_hotel_ids uuid[];
  v_matched_organization_ids uuid[];
  v_hotels jsonb;
  v_organizations jsonb;
  v_hotel_organization_links jsonb;
begin
  select coalesce(array_agg(distinct lower(a)), '{}') into v_addresses
    from unnest(coalesce(p_addresses, '{}'::text[])) a;
  select coalesce(array_agg(distinct lower(d)), '{}') into v_domains
    from unnest(coalesce(p_domains, '{}'::text[])) d;
  -- EXTERNAL AUDIT AMENDMENT #4, Finding 2: a canonical business explicitly
  -- named in the creator's own authored text must enter the candidate
  -- universe even when its domain/contact is unrelated to the recipient —
  -- normalized here so the comparison below is exact, never a wildcard/ILIKE
  -- broadening of any kind.
  select coalesce(array_agg(distinct private.normalize_business_name(n)), '{}') into v_candidate_names
    from unnest(coalesce(p_candidate_names, '{}'::text[])) n
   where private.normalize_business_name(n) <> '';

  if coalesce(array_length(v_addresses, 1), 0) = 0
     and coalesce(array_length(v_domains, 1), 0) = 0
     and coalesce(array_length(v_candidate_names, 1), 0) = 0 then
    return jsonb_build_object(
      'hotels', '[]'::jsonb, 'organizations', '[]'::jsonb,
      'hotel_contacts', '[]'::jsonb, 'organization_contacts', '[]'::jsonb,
      'hotel_organization_links', '[]'::jsonb
    );
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('hotel_id', hc.hotel_id, 'email', hc.email)), '[]'::jsonb),
         coalesce(array_agg(distinct hc.hotel_id), '{}')
    into v_hotel_contacts, v_matched_hotel_ids
    from public.hotel_contacts hc
   where hc.email is not null and lower(hc.email) = any(v_addresses);

  select coalesce(jsonb_agg(jsonb_build_object('organization_id', oc.organization_id, 'email', oc.email)), '[]'::jsonb),
         coalesce(array_agg(distinct oc.organization_id), '{}')
    into v_organization_contacts, v_matched_organization_ids
    from public.organization_contacts oc
   where oc.email is not null and lower(oc.email) = any(v_addresses);

  select coalesce(jsonb_agg(jsonb_build_object('id', h.id, 'name', h.name, 'website_url', h.website_url)), '[]'::jsonb)
    into v_hotels
    from public.hotels h
   where h.id = any(v_matched_hotel_ids)
      or private.normalize_business_name(h.name) = any(v_candidate_names)
      or exists (
           select 1 from unnest(v_domains) d
            where h.website_url is not null
              and h.website_url ilike '%' || private.escape_like_pattern(d) || '%' escape '\'
         );

  select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'name', o.name, 'website_url', o.website_url)), '[]'::jsonb)
    into v_organizations
    from public.organizations o
   where o.id = any(v_matched_organization_ids)
      or private.normalize_business_name(o.name) = any(v_candidate_names)
      or exists (
           select 1 from unnest(v_domains) d
            where o.website_url is not null
              and o.website_url ilike '%' || private.escape_like_pattern(d) || '%' escape '\'
         );

  -- `hotel_organizations` portfolio-relationship rows relevant to the bounded
  -- hotel/organization universe just resolved above (Finding 4/5).
  select coalesce(jsonb_agg(jsonb_build_object(
           'hotel_id', ho.hotel_id, 'organization_id', ho.organization_id, 'relationship', ho.relationship
         )), '[]'::jsonb)
    into v_hotel_organization_links
    from public.hotel_organizations ho
   where ho.hotel_id in (select (elem ->> 'id')::uuid from jsonb_array_elements(v_hotels) elem)
      or ho.organization_id in (select (elem ->> 'id')::uuid from jsonb_array_elements(v_organizations) elem);

  return jsonb_build_object(
    'hotels', v_hotels,
    'organizations', v_organizations,
    'hotel_contacts', v_hotel_contacts,
    'organization_contacts', v_organization_contacts,
    'hotel_organization_links', v_hotel_organization_links
  );
end;
$$;

revoke all on function public.gmail_outreach_catalog_snapshot(text[], text[], text[]) from public, anon, authenticated;
grant execute on function public.gmail_outreach_catalog_snapshot(text[], text[], text[]) to service_role;

-- ---------------------------------------------------------------------------
-- 11b. FULL B04 EVIDENCE BUNDLE FOR ONE THREAD
-- ---------------------------------------------------------------------------
-- B04 exposes no read RPC for its own normalized content (by design — the
-- normalizer only ever writes). B05 is the first consumer, so this migration
-- adds the read path B05 needs: every SENT message's text parts, every
-- SENT-message To/Cc/Bcc participant, and the subject header raw value of
-- every message, scoped to one account-owned thread.
create or replace function public.gmail_outreach_get_thread_evidence(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_normalized_thread_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_may_process text;
  v_thread private.gmail_normalized_threads%rowtype;
  v_messages jsonb;
  v_sent_text_parts jsonb;
  v_sent_recipients jsonb;
  v_subjects jsonb;
  v_machine_state jsonb;
begin
  v_may_process := private.gmail_outreach_may_process(p_mail_account_id);
  if v_may_process <> 'ok' then
    return jsonb_build_object('result', v_may_process);
  end if;

  select t.* into v_thread
    from private.gmail_normalized_threads t
   where t.id = p_normalized_thread_id
     and t.mail_account_id = p_mail_account_id
     and t.user_id = p_user_id;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'normalized_message_id', m.id,
           'provider_message_id', m.provider_message_id,
           'provider_sent', m.provider_sent,
           'internal_date_ms', (extract(epoch from m.internal_date) * 1000)::bigint,
           'source_payload_sha256', m.source_payload_sha256
         ) order by m.internal_date asc, m.provider_message_id asc), '[]'::jsonb)
    into v_messages
    from private.gmail_normalized_messages m
   where m.normalized_thread_id = p_normalized_thread_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'normalized_message_id', tp.normalized_message_id,
           'part_path', to_jsonb(tp.part_path),
           'mime_type', tp.mime_type,
           'decode_status', tp.decode_status,
           'decoded_text', tp.decoded_text
         ) order by tp.normalized_message_id, tp.part_path), '[]'::jsonb)
    into v_sent_text_parts
    from private.gmail_normalized_text_parts tp
    join private.gmail_normalized_messages m on m.id = tp.normalized_message_id
   where m.normalized_thread_id = p_normalized_thread_id
     and m.provider_sent = true;

  select coalesce(jsonb_agg(jsonb_build_object(
           'normalized_message_id', p.normalized_message_id,
           'source_header_id', p.source_header_id,
           'source_participant_id', p.id,
           'role', p.header_role,
           'display_name', p.display_name,
           'addr_spec', p.addr_spec,
           'local_part', p.local_part,
           'domain', p.domain,
           'domain_lower', p.domain_lower,
           'parse_status', p.parse_status
         ) order by p.normalized_message_id, p.source_header_id, p.participant_order), '[]'::jsonb)
    into v_sent_recipients
    from private.gmail_normalized_participants p
    join private.gmail_normalized_messages m on m.id = p.normalized_message_id
   where m.normalized_thread_id = p_normalized_thread_id
     and m.provider_sent = true
     and p.header_role in ('to', 'cc', 'bcc');

  select coalesce(jsonb_agg(jsonb_build_object(
           'normalized_message_id', h.normalized_message_id,
           'raw_value', h.raw_value
         ) order by h.normalized_message_id), '[]'::jsonb)
    into v_subjects
    from private.gmail_normalized_headers h
    join private.gmail_normalized_messages m on m.id = h.normalized_message_id
   where m.normalized_thread_id = p_normalized_thread_id
     and h.header_name = 'subject';

  -- EXTERNAL AUDIT AMENDMENT #2, Finding 4: the currently-stored MACHINE
  -- state, so TS can decide the CHEAPEST honest re-evaluation path (skip the
  -- classifier when only the catalog moved, skip matching entirely when the
  -- freshly-recomputed relevant fingerprint is unchanged) instead of always
  -- re-deriving everything from scratch — see service.ts's interpretOneThread.
  select jsonb_build_object(
           'thread_signal', (
             select jsonb_build_object(
                      'outreach_status', s.outreach_status,
                      'reason_codes', s.reason_codes,
                      'detector_version', s.detector_version
                    )
               from private.gmail_outreach_thread_signals s
              where s.normalized_thread_id = p_normalized_thread_id
                and s.mail_account_id = p_mail_account_id
           ),
           'target_contact_signal', (
             select jsonb_build_object(
                      'match_quality', tc.match_quality,
                      'matcher_version', tc.matcher_version,
                      'evaluated_epoch', tc.evaluated_epoch,
                      'candidate_set_fingerprint', tc.candidate_set_fingerprint
                    )
               from private.gmail_outreach_target_contact_signals tc
              where tc.normalized_thread_id = p_normalized_thread_id
                and tc.mail_account_id = p_mail_account_id
           ),
           'target_scope_signal', (
             select jsonb_build_object(
                      'machine_target_scope', ts.machine_target_scope,
                      'matcher_version', ts.matcher_version,
                      'evaluated_epoch', ts.evaluated_epoch
                    )
               from private.gmail_outreach_target_scope_signals ts
              where ts.normalized_thread_id = p_normalized_thread_id
                and ts.mail_account_id = p_mail_account_id
           ),
           'target_observations', (
             select coalesce(jsonb_agg(jsonb_build_object(
                      'observation_fingerprint', o.observation_fingerprint,
                      'matcher_version', o.matcher_version,
                      'evaluated_epoch', o.evaluated_epoch,
                      'candidate_set_fingerprint', o.candidate_set_fingerprint,
                      'machine_canonical_link_assessment', o.machine_canonical_link_assessment,
                      -- The EXISTING rank-0 canonical link (Finding 4/6): lets
                      -- TS reconstruct target-scope and target-contact
                      -- corroboration evidence for an observation it decides
                      -- to REUSE (unchanged relevant fingerprint) without
                      -- re-running matchTargetObservation just to recover
                      -- which canonical row it had already matched.
                      'best_canonical_link', (
                        select jsonb_build_object(
                                 'target_kind', l.target_kind,
                                 'target_hotel_id', l.target_hotel_id,
                                 'target_organization_id', l.target_organization_id,
                                 'contact_evidence', l.contact_evidence
                               )
                          from private.gmail_outreach_target_canonical_links l
                         where l.target_observation_id = o.id
                           and l.rank = 0
                      )
                    ) order by o.observation_fingerprint), '[]'::jsonb)
               from private.gmail_outreach_target_observations o
              where o.normalized_thread_id = p_normalized_thread_id
                and o.mail_account_id = p_mail_account_id
           )
         )
    into v_machine_state;

  return jsonb_build_object(
    'result', 'ok',
    'normalized_thread_id', v_thread.id,
    'provider_thread_id', v_thread.provider_thread_id,
    'messages', v_messages,
    'sent_text_parts', v_sent_text_parts,
    'sent_recipients', v_sent_recipients,
    'subjects', v_subjects,
    'machine_state', v_machine_state
  );
end;
$$;

revoke all on function public.gmail_outreach_get_thread_evidence(uuid, uuid, uuid) from public;

-- ---------------------------------------------------------------------------
-- 11c. COMMIT ONE THREAD'S MACHINE INTERPRETATION — atomic, fenced
-- ---------------------------------------------------------------------------
-- TS has already: classified outreach, extracted which participants are
-- recipients to preserve, matched canonical target candidates conservatively
-- against a snapshot of hotels/organizations it queried directly, and scored
-- target-contact candidates. This function is the sole authority on whether
-- that work may become the current MACHINE projection, and it never touches
-- any HUMAN table.
--
-- p_expected_evidence_digest is the fence: computed by TS from the evidence
-- bundle it read, and re-verified here — under a `for key share` lock on the
-- thread's current normalized messages — against a freshly recomputed digest.
-- A mismatch (the thread's B04 evidence changed since TS read it) refuses the
-- whole commit; nothing is written from stale evidence.
-- EXTERNAL AUDIT AMENDMENT #1: Finding 1 (durable recipient/observation
-- provenance), Finding 4 (catalog-epoch CAS — `stale_catalog`), Finding 6
-- (machine target-scope signal) all land in this one function, since it
-- remains the sole writer of every MACHINE row.
create or replace function public.gmail_outreach_commit_interpretation(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_normalized_thread_id uuid,
  p_detector_version text,
  p_matcher_version text,
  p_expected_evidence_digest text,
  p_outreach_status text,
  p_reason_codes text[],
  p_recipient_participant_ids uuid[],
  p_target_contact_match_quality text,
  p_target_contact_candidate_set_fingerprint text,
  p_target_contact_candidates jsonb,
  p_target_observations jsonb,
  p_target_canonical_links jsonb,
  p_machine_target_scope text,
  p_target_scope_reason_codes text[],
  p_catalog_epoch bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_account public.mail_accounts%rowtype;
  v_thread private.gmail_normalized_threads%rowtype;
  v_may_process text;
  v_current_digest text;
  v_current_count integer;
  v_current_catalog_epoch bigint;
  v_recipient_row jsonb;
  v_participant record;
  v_observation jsonb;
  v_observation_id uuid;
  v_existing_observation_fingerprint text;
  v_link jsonb;
  v_candidate jsonb;
  v_provider_message_id text;
  v_proven_count integer;
  v_asserted_count integer;
  v_recipient_fingerprint text;
begin
  if p_detector_version !~ '^[a-z][a-z0-9_]{0,63}$' or p_matcher_version !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'invalid detector/matcher version' using errcode = 'invalid_parameter_value';
  end if;

  if p_outreach_status not in ('qualified_outreach', 'not_outreach', 'needs_review', 'insufficient_evidence') then
    raise exception 'invalid outreach status %', p_outreach_status using errcode = 'invalid_parameter_value';
  end if;

  if p_machine_target_scope not in ('single_target', 'multiple_targets', 'portfolio_target', 'unresolved') then
    raise exception 'invalid machine target scope %', p_machine_target_scope using errcode = 'invalid_parameter_value';
  end if;

  select m.* into v_account from public.mail_accounts m
   where m.id = p_mail_account_id and m.user_id = p_user_id;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_account.connection_state = 'deleted' then
    return jsonb_build_object('result', 'account_deleted');
  end if;

  -- THE REAL LIFECYCLE + CONSENT FENCE (EXTERNAL AUDIT AMENDMENT #2 Finding
  -- 2, hardened by AMENDMENT #3 Finding 1). `connection_state <> 'deleted'`
  -- alone (B04's own precedent for a projection with no new judgement over
  -- private content) is not enough for B05, which does form new judgements.
  -- This is RETENTION-vs-NEW-PROCESSING aware by construction: nothing here
  -- ever deletes or hides EXISTING gmail_outreach_* rows — only this
  -- function (the sole MACHINE writer) refuses NEW work.
  --
  -- The EARLIER `v_account` read above is NOT itself a lifecycle fence — it
  -- is unlocked, so a concurrent deletion-start committing between that read
  -- and this point would be invisible to it. `private.gmail_outreach_
  -- assert_may_process_locked` is the real fence: it takes `for share` on
  -- the consent row and THEN the mail_accounts row (that exact order matters
  -- — see its own comment for why it can never deadlock against B01's
  -- withdrawal or deletion-start writers), so a concurrent withdrawal OR a
  -- concurrent deletion-start racing this commit is caught under lock, not
  -- inferred from a stale unlocked read.
  v_may_process := private.gmail_outreach_assert_may_process_locked(p_mail_account_id);
  if v_may_process <> 'ok' then
    return jsonb_build_object('result', v_may_process);
  end if;

  select t.* into v_thread
    from private.gmail_normalized_threads t
   where t.id = p_normalized_thread_id and t.mail_account_id = p_mail_account_id;

  if not found then
    return jsonb_build_object('result', 'thread_not_found');
  end if;

  -- THE SOURCE-EVIDENCE FENCE. Lock every currently-existing normalized
  -- message row for this thread (blocks a concurrent B04 invalidation delete
  -- until this transaction resolves; a message deleted just before this lock
  -- simply will not appear here, which changes the digest and correctly
  -- fails the CAS below), then recompute the exact same digest shape TS used.
  with locked as (
    select m.id, m.source_payload_sha256, m.provider_sent
      from private.gmail_normalized_messages m
     where m.normalized_thread_id = p_normalized_thread_id
     for key share
  )
  select
    encode(digest(coalesce(string_agg(id::text || ':' || source_payload_sha256 || ':' || provider_sent::text, '|' order by id), ''), 'sha256'), 'hex'),
    count(*)::int
    into v_current_digest, v_current_count
    from locked;

  if v_current_digest is distinct from p_expected_evidence_digest then
    return jsonb_build_object('result', 'stale_source', 'current_evidence_digest', v_current_digest);
  end if;

  -- THE CATALOG-EPOCH FENCE (Finding 4). TS read the catalog (hotels/
  -- organizations/contacts) at `p_catalog_epoch` to compute every canonical
  -- link and target-contact/target-scope result below. If the catalog moved
  -- since — a relevant insert/update/delete somewhere in the six catalog
  -- tables §1's triggers watch — those results were computed against a
  -- universe that no longer exists, and none of them may become current.
  -- This is a whole-commit refusal, exactly like `stale_source`: nothing
  -- (not even the outreach classification, to keep this function's atomicity
  -- simple and total) is written, and the caller re-reads a fresh snapshot
  -- and retries — the same retry-on-staleness shape B02's CAS RPCs already
  -- use.
  -- REAL TRANSACTIONAL FENCE (EXTERNAL AUDIT AMENDMENT #2, Finding 3): `for
  -- share` on the ONE lock row private.gmail_outreach_catalog_epoch_lock —
  -- never the bare sequence's `last_value` (which is just a number, lockable
  -- by nothing). A concurrent catalog mutation's trigger UPDATEs this exact
  -- row in the same statement it advances the sequence, so this read and
  -- that write can never interleave: whichever transaction gets here first
  -- forces the other to wait for it to fully finish before it can proceed,
  -- eliminating the check-then-act gap a bare unlocked read would leave open.
  select current_epoch into v_current_catalog_epoch
    from private.gmail_outreach_catalog_epoch_lock
   where id = true
   for share;

  if v_current_catalog_epoch <> p_catalog_epoch then
    return jsonb_build_object('result', 'stale_catalog', 'current_catalog_epoch', v_current_catalog_epoch);
  end if;

  -- MACHINE LAYER ONLY, FROM HERE. Nothing below touches a HUMAN table.
  insert into private.gmail_outreach_thread_signals (
    user_id, mail_account_id, normalized_thread_id, outreach_status, reason_codes,
    detector_version, evidence_digest, evidence_message_count
  ) values (
    p_user_id, p_mail_account_id, p_normalized_thread_id, p_outreach_status, coalesce(p_reason_codes, '{}'),
    p_detector_version, v_current_digest, v_current_count
  )
  on conflict (mail_account_id, normalized_thread_id) do update
    set outreach_status = excluded.outreach_status,
        reason_codes = excluded.reason_codes,
        detector_version = excluded.detector_version,
        evidence_digest = excluded.evidence_digest,
        evidence_message_count = excluded.evidence_message_count,
        evaluated_at = now();

  -- OBSERVED RECIPIENTS — upsert on (DURABLE coordinate, material-evidence
  -- fingerprint), never on a B04 row id (Finding 1/12). A rebuild that
  -- reproduces the SAME evidence at the SAME coordinate reconciles the SAME
  -- row; a rebuild whose evidence is MATERIALLY DIFFERENT at that coordinate
  -- forks a NEW row and leaves the old one (and any human confirmation of
  -- it) completely untouched, only marking it `is_current = false`.
  for v_recipient_row in select * from jsonb_array_elements(
    (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from unnest(coalesce(p_recipient_participant_ids, '{}'::uuid[])) as x)
  )
  loop
    select m.provider_message_id, p.header_role, h.occurrence_index, p.participant_order,
           p.display_name, p.addr_spec, p.local_part, p.domain, p.domain_lower, p.parse_status,
           m.id as normalized_message_id, h.id as source_header_id, p.id as source_participant_id
      into v_participant
      from private.gmail_normalized_participants p
      join private.gmail_normalized_messages m on m.id = p.normalized_message_id
      join private.gmail_normalized_headers h on h.id = p.source_header_id
     where p.id = (v_recipient_row #>> '{}')::uuid
       and m.normalized_thread_id = p_normalized_thread_id
       and p.header_role in ('to', 'cc', 'bcc');

    if not found then
      continue;
    end if;

    -- MATERIAL EVIDENCE ONLY — never `display_name`, which is cosmetic and
    -- can legitimately render differently between two sends of the exact
    -- same mailbox without that being a different real-world recipient.
    v_recipient_fingerprint := encode(digest(
      lower(coalesce(v_participant.addr_spec, '')) || '|' ||
      lower(coalesce(v_participant.local_part, '')) || '|' ||
      lower(coalesce(v_participant.domain_lower, v_participant.domain, '')) || '|' ||
      v_participant.parse_status,
      'sha256'
    ), 'hex');

    update private.gmail_outreach_observed_recipients
       set is_current = false,
           current_normalized_message_id = null,
           current_source_header_id = null,
           current_source_participant_id = null,
           updated_at = now()
     where mail_account_id = p_mail_account_id
       and normalized_thread_id = p_normalized_thread_id
       and provider_message_id = v_participant.provider_message_id
       and role = v_participant.header_role
       and header_occurrence_index = v_participant.occurrence_index
       and participant_order = v_participant.participant_order
       and recipient_fingerprint <> v_recipient_fingerprint
       and is_current = true;

    insert into private.gmail_outreach_observed_recipients (
      user_id, mail_account_id, normalized_thread_id,
      provider_message_id, role, header_occurrence_index, participant_order, recipient_fingerprint,
      display_name, addr_spec, local_part, domain, domain_lower, parse_status,
      current_normalized_message_id, current_source_header_id, current_source_participant_id, is_current
    ) values (
      p_user_id, p_mail_account_id, p_normalized_thread_id,
      v_participant.provider_message_id, v_participant.header_role, v_participant.occurrence_index, v_participant.participant_order, v_recipient_fingerprint,
      v_participant.display_name, v_participant.addr_spec, v_participant.local_part, v_participant.domain, v_participant.domain_lower, v_participant.parse_status,
      v_participant.normalized_message_id, v_participant.source_header_id, v_participant.source_participant_id, true
    )
    on conflict (mail_account_id, normalized_thread_id, provider_message_id, role, header_occurrence_index, participant_order, recipient_fingerprint)
    do update set
      display_name = excluded.display_name,
      addr_spec = excluded.addr_spec,
      local_part = excluded.local_part,
      domain = excluded.domain,
      domain_lower = excluded.domain_lower,
      parse_status = excluded.parse_status,
      current_normalized_message_id = excluded.current_normalized_message_id,
      current_source_header_id = excluded.current_source_header_id,
      current_source_participant_id = excluded.current_source_participant_id,
      is_current = true,
      updated_at = now();
  end loop;

  -- CANONICAL CONTACT LINKS — deterministic exact-email match, computed here
  -- (not trusted from the caller), wholesale replaced for this thread's
  -- recipients. Naturally 0..N per recipient: no map collapses it.
  delete from private.gmail_outreach_observed_recipient_canonical_links l
   using private.gmail_outreach_observed_recipients r
   where l.observed_recipient_id = r.id
     and r.normalized_thread_id = p_normalized_thread_id;

  -- `is_current = true` only (Finding 1): a row a fingerprint change has
  -- superseded no longer reflects live evidence, so it earns no fresh
  -- canonical-contact evidence on this or any future re-evaluation.
  insert into private.gmail_outreach_observed_recipient_canonical_links (
    observed_recipient_id, canonical_contact_kind, hotel_contact_id, match_basis, evaluated_epoch
  )
  select r.id, 'hotel_contact', hc.id, 'exact_email', p_catalog_epoch
    from private.gmail_outreach_observed_recipients r
    join public.hotel_contacts hc on lower(hc.email) = lower(r.addr_spec)
   where r.normalized_thread_id = p_normalized_thread_id
     and r.is_current = true
     and r.addr_spec is not null
     and hc.email is not null;

  insert into private.gmail_outreach_observed_recipient_canonical_links (
    observed_recipient_id, canonical_contact_kind, organization_contact_id, match_basis, evaluated_epoch
  )
  select r.id, 'organization_contact', oc.id, 'exact_email', p_catalog_epoch
    from private.gmail_outreach_observed_recipients r
    join public.organization_contacts oc on lower(oc.email) = lower(r.addr_spec)
   where r.normalized_thread_id = p_normalized_thread_id
     and r.is_current = true
     and r.addr_spec is not null
     and oc.email is not null;

  -- TARGET-CONTACT SIGNAL + CANDIDATES.
  insert into private.gmail_outreach_target_contact_signals (
    user_id, mail_account_id, normalized_thread_id, match_quality, matcher_version,
    evaluated_epoch, candidate_set_fingerprint
  ) values (
    p_user_id, p_mail_account_id, p_normalized_thread_id, p_target_contact_match_quality, p_matcher_version,
    p_catalog_epoch, p_target_contact_candidate_set_fingerprint
  )
  on conflict (mail_account_id, normalized_thread_id) do update
    set match_quality = excluded.match_quality,
        matcher_version = excluded.matcher_version,
        evaluated_epoch = excluded.evaluated_epoch,
        candidate_set_fingerprint = excluded.candidate_set_fingerprint,
        evaluated_at = now();

  delete from private.gmail_outreach_target_contact_candidates
   where normalized_thread_id = p_normalized_thread_id;

  for v_candidate in select * from jsonb_array_elements(coalesce(p_target_contact_candidates, '[]'::jsonb))
  loop
    -- Matched via `current_source_participant_id`: valid because TS derived
    -- `source_participant_id` from the SAME evidence bundle this same commit
    -- just (re)attached above, in the same transaction.
    insert into private.gmail_outreach_target_contact_candidates (
      normalized_thread_id, mail_account_id, observed_recipient_id, role_evidence, address_pattern_evidence, rank
    )
    select p_normalized_thread_id, p_mail_account_id, r.id,
           v_candidate ->> 'role_evidence', v_candidate ->> 'address_pattern_evidence', (v_candidate ->> 'rank')::int
      from private.gmail_outreach_observed_recipients r
     where r.current_source_participant_id = (v_candidate ->> 'source_participant_id')::uuid
       and r.normalized_thread_id = p_normalized_thread_id
       and r.is_current = true;
  end loop;

  -- MACHINE TARGET-SCOPE SIGNAL (Finding 6) — thread-level, advisory only.
  insert into private.gmail_outreach_target_scope_signals (
    user_id, mail_account_id, normalized_thread_id, machine_target_scope, reason_codes,
    matcher_version, evaluated_epoch
  ) values (
    p_user_id, p_mail_account_id, p_normalized_thread_id, p_machine_target_scope,
    coalesce(p_target_scope_reason_codes, '{}'), p_matcher_version, p_catalog_epoch
  )
  on conflict (mail_account_id, normalized_thread_id) do update
    set machine_target_scope = excluded.machine_target_scope,
        reason_codes = excluded.reason_codes,
        matcher_version = excluded.matcher_version,
        evaluated_epoch = excluded.evaluated_epoch,
        evaluated_at = now();

  -- TARGET OBSERVATIONS — reconcile, never overwrite identity fields.
  for v_observation in select * from jsonb_array_elements(coalesce(p_target_observations, '[]'::jsonb))
  loop
    -- DURABLE, VERIFIED PROVENANCE (Finding 1/12): every asserted source
    -- provider_message_id must actually belong to THIS thread/account's
    -- CURRENT B04 evidence. A caller cannot assert provenance the database
    -- has not itself proven — this is checked BEFORE the row can be created,
    -- every time, regardless of whether this observation turns out to be new
    -- or already reconciled below.
    select array_length(coalesce((select array_agg(x) from jsonb_array_elements_text(v_observation -> 'source_provider_message_ids') x), '{}'), 1)
      into v_asserted_count;

    select count(distinct pm.x) into v_proven_count
      from jsonb_array_elements_text(v_observation -> 'source_provider_message_ids') pm(x)
      join private.gmail_normalized_messages m
        on m.provider_message_id = pm.x
       and m.mail_account_id = p_mail_account_id
       and m.normalized_thread_id = p_normalized_thread_id;

    if v_asserted_count is null or v_asserted_count = 0 or v_proven_count <> v_asserted_count then
      raise exception
        'target observation source provenance unproven: % of % asserted provider_message_id(s) actually belong to thread %',
        coalesce(v_proven_count, 0), coalesce(v_asserted_count, 0), p_normalized_thread_id
        using errcode = 'invalid_parameter_value';
    end if;

    insert into private.gmail_outreach_target_observations (
      user_id, mail_account_id, normalized_thread_id, observation_fingerprint,
      observed_name, observed_domain, target_kind_hint, observation_source_kind,
      source_provider_message_ids
    ) values (
      p_user_id, p_mail_account_id, p_normalized_thread_id, v_observation ->> 'observation_fingerprint',
      v_observation ->> 'observed_name', v_observation ->> 'observed_domain',
      coalesce(v_observation ->> 'target_kind_hint', 'unknown'),
      coalesce(v_observation ->> 'observation_source_kind', 'recipient_domain'),
      (select array_agg(x) from jsonb_array_elements_text(v_observation -> 'source_provider_message_ids') x)
    )
    on conflict (mail_account_id, normalized_thread_id, observation_fingerprint) do nothing
    returning id into v_observation_id;

    if v_observation_id is null then
      -- Already existed — capture its PRIOR candidate_set_fingerprint before
      -- overwriting it below, so the fast-path check right after can tell
      -- whether the relevant candidate universe actually changed.
      select id, candidate_set_fingerprint into v_observation_id, v_existing_observation_fingerprint
        from private.gmail_outreach_target_observations
       where mail_account_id = p_mail_account_id
         and normalized_thread_id = p_normalized_thread_id
         and observation_fingerprint = v_observation ->> 'observation_fingerprint';
    else
      -- Brand new row — there is no prior fingerprint to compare against, so
      -- the canonical-links reconciliation below always applies.
      v_existing_observation_fingerprint := null;
    end if;

    -- EXTERNAL AUDIT AMENDMENT #3, Finding 3 (test B): `source_provider_
    -- message_ids` is the EVOLVING evidence supporting this stable private
    -- fact, not a frozen snapshot of whichever message first created the
    -- row — an additional SENT follow-up message naming the SAME target
    -- (same observation_fingerprint) must have its provenance HONESTLY
    -- represented, not silently dropped. It only ever GROWS (a distinct
    -- union), never loses a previously-proven id, and every id in it has
    -- already been proven above to belong to this exact thread/account.
    -- EXTERNAL AUDIT AMENDMENT #6, Finding 3: every observation present in
    -- THIS call's complete current set is (re)marked current — including one
    -- that had gone `machine_is_current = false` after an earlier run
    -- stopped supporting it and has now genuinely reappeared (a real fact
    -- reactivation, never a fabricated human decision).
    update private.gmail_outreach_target_observations
       set machine_canonical_link_assessment = v_observation ->> 'machine_canonical_link_assessment',
           matcher_version = p_matcher_version,
           evaluated_epoch = p_catalog_epoch,
           candidate_set_fingerprint = v_observation ->> 'candidate_set_fingerprint',
           machine_is_current = true,
           source_provider_message_ids = (
             select array_agg(distinct x)
               from unnest(
                 source_provider_message_ids
                 || (select array_agg(y) from jsonb_array_elements_text(v_observation -> 'source_provider_message_ids') y)
               ) x
           )
     where id = v_observation_id;

    -- EXTERNAL AUDIT AMENDMENT #2, Finding 4: when the caller's own
    -- fast-path decided the relevant candidate universe is UNCHANGED for
    -- this observation (same candidate_set_fingerprint as what was already
    -- stored), it sends no fresh links for it — the EXISTING canonical_links
    -- rows are left completely alone rather than deleted and immediately
    -- reinserted with identical content. A genuinely different fingerprint
    -- (or a brand-new observation) always reconciles as before.
    if v_existing_observation_fingerprint is distinct from (v_observation ->> 'candidate_set_fingerprint') then
      delete from private.gmail_outreach_target_canonical_links where target_observation_id = v_observation_id;

      for v_link in select * from jsonb_array_elements(coalesce(p_target_canonical_links, '[]'::jsonb))
      loop
        if v_link ->> 'observation_fingerprint' = v_observation ->> 'observation_fingerprint' then
          insert into private.gmail_outreach_target_canonical_links (
            target_observation_id, target_kind, target_hotel_id, target_organization_id,
            name_evidence, domain_evidence, address_evidence, contact_evidence,
            authored_text_evidence, rank
          ) values (
            v_observation_id,
            v_link ->> 'target_kind',
            nullif(v_link ->> 'target_hotel_id', '')::uuid,
            nullif(v_link ->> 'target_organization_id', '')::uuid,
            v_link ->> 'name_evidence', v_link ->> 'domain_evidence',
            v_link ->> 'address_evidence', v_link ->> 'contact_evidence',
            coalesce(v_link ->> 'authored_text_evidence', 'unavailable'),
            (v_link ->> 'rank')::int
          );
        end if;
      end loop;
    end if;

    v_observation_id := null;
    v_existing_observation_fingerprint := null;
  end loop;

  -- EXTERNAL AUDIT AMENDMENT #6, Finding 3: `p_target_observations` is
  -- ALWAYS the COMPLETE current set for this thread — target/recipient
  -- extraction runs unconditionally on every evaluation (EXTERNAL AUDIT
  -- AMENDMENT #1, Finding 7), never a partial delta — so every OTHER
  -- previously-current row for this thread that this call did NOT include
  -- genuinely no longer has current support and is marked historical here.
  -- This NEVER deletes the row (durable historical existence is preserved,
  -- exactly like a fingerprint fork leaves an old fact's row alone) and
  -- NEVER touches a human confirmation — only the MACHINE `machine_is_
  -- current` advisory flag changes.
  update private.gmail_outreach_target_observations o
     set machine_is_current = false
   where o.mail_account_id = p_mail_account_id
     and o.normalized_thread_id = p_normalized_thread_id
     and o.machine_is_current = true
     and not exists (
       select 1 from jsonb_array_elements(coalesce(p_target_observations, '[]'::jsonb)) v
        where v ->> 'observation_fingerprint' = o.observation_fingerprint
     );

  return jsonb_build_object('result', 'ok', 'normalized_thread_id', p_normalized_thread_id);
end;
$$;

revoke all on function public.gmail_outreach_commit_interpretation(
  uuid, uuid, uuid, text, text, text, text, text[], uuid[], text, text, jsonb, jsonb, jsonb, text, text[], bigint
) from public;

-- ---------------------------------------------------------------------------
-- 11d. CREATOR DECISIONS — the ONLY writer of the human ledger
-- ---------------------------------------------------------------------------
-- One generic, exhaustively-validated entrypoint for all four axes, rather
-- than four near-identical functions.
--
-- EXTERNAL AUDIT AMENDMENT #1, Finding 2: the original version accepted
-- `p_user_id` as a caller-supplied parameter and trusted it as the decision's
-- author — indistinguishable, at the database, from any other service-role
-- capability, including a machine worker. This is the one B05 write that
-- claims to be unforgeable human truth, so it now derives the actor from
-- `auth.uid()` — Postgres's read of the verified JWT claims PostgREST (or an
-- explicit `set_config('request.jwt.claims', ...)`) attaches to THIS
-- session — never from a parameter. `auth.uid() is null` (a service-role
-- caller that never established a real end-user identity, e.g. any B05
-- MACHINE RPC's own connection) is rejected outright: a machine path has no
-- legitimate way to reach this function. The repository's own precedent for
-- "acting as the user" is `@/lib/supabase/server`'s cookie-bound client
-- (anon key + the caller's session, so `auth.uid()` is the real signed-in
-- user) — `service.server.ts`'s `defaultCreatorDecisionDeps()` uses exactly
-- that client for this one call, while every other B05 RPC keeps the
-- service-role admin client B01-B04 already use for machine/system work.
--
-- EXTERNAL AUDIT AMENDMENT #1, Finding 3: every projection write below is
-- now guarded by `event_seq` ordering — see gmail_outreach_creator_decisions,
-- gmail_outreach_target_confirmations and gmail_outreach_target_contact_
-- confirmed_members's own comments for why a bare upsert/delete was unsafe
-- under real concurrency.
create or replace function public.gmail_outreach_record_creator_decision(
  p_mail_account_id uuid,
  p_normalized_thread_id uuid,
  p_axis text,
  p_outreach_decision text default null,
  p_target_scope_decision text default null,
  p_target_action text default null,
  p_target_observation_id uuid default null,
  p_observed_recipient_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user_id uuid;
  v_account public.mail_accounts%rowtype;
  v_thread private.gmail_normalized_threads%rowtype;
  v_may_process text;
  v_event_id uuid;
  v_event_seq bigint;
  v_observed_state text;
begin
  v_user_id := auth.uid();
  if v_user_id is null then
    return jsonb_build_object('result', 'unauthenticated');
  end if;

  if p_axis not in ('outreach', 'target_scope', 'target', 'target_contact') then
    raise exception 'invalid axis %', p_axis using errcode = 'invalid_parameter_value';
  end if;

  select m.* into v_account from public.mail_accounts m
   where m.id = p_mail_account_id and m.user_id = v_user_id;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_account.connection_state = 'deleted' then
    return jsonb_build_object('result', 'account_deleted');
  end if;

  -- EXTERNAL AUDIT AMENDMENT #3, Finding 2: a creator confirmation/
  -- correction is ITSELF new Gmail-derived processing, not merely a fact
  -- about who owns the mailbox — `auth.uid()` proves authorship, never
  -- authorization to process. This is the SAME real, locked fence
  -- `gmail_outreach_commit_interpretation` uses (consent row, then
  -- mail_accounts row, in that exact order — see that function's own
  -- comment for why this order can never deadlock against B01's withdrawal
  -- or deletion-start writers). RETENTION is unaffected: existing decision
  -- events/projections are never touched here — only a NEW event is refused.
  v_may_process := private.gmail_outreach_assert_may_process_locked(p_mail_account_id);
  if v_may_process <> 'ok' then
    return jsonb_build_object('result', v_may_process);
  end if;

  select t.* into v_thread from private.gmail_normalized_threads t
   where t.id = p_normalized_thread_id and t.mail_account_id = p_mail_account_id and t.user_id = v_user_id;

  if not found then
    return jsonb_build_object('result', 'thread_not_found');
  end if;

  if p_axis = 'outreach' then
    if p_outreach_decision not in ('outreach_confirmed', 'not_outreach_confirmed') then
      raise exception 'invalid outreach decision %', p_outreach_decision using errcode = 'invalid_parameter_value';
    end if;

    select outreach_status into v_observed_state from private.gmail_outreach_thread_signals
     where mail_account_id = p_mail_account_id and normalized_thread_id = p_normalized_thread_id;

    insert into private.gmail_outreach_creator_decision_events (
      user_id, mail_account_id, normalized_thread_id, axis, decided_by_user_id, outreach_decision, observed_machine_state
    ) values (
      v_user_id, p_mail_account_id, p_normalized_thread_id, 'outreach', v_user_id, p_outreach_decision, v_observed_state
    ) returning id, event_seq into v_event_id, v_event_seq;

    insert into private.gmail_outreach_creator_decisions (
      user_id, mail_account_id, normalized_thread_id, outreach_decision, current_outreach_event_id, current_outreach_event_seq
    ) values (
      v_user_id, p_mail_account_id, p_normalized_thread_id, p_outreach_decision, v_event_id, v_event_seq
    )
    on conflict (mail_account_id, normalized_thread_id) do update
      set outreach_decision = excluded.outreach_decision,
          current_outreach_event_id = excluded.current_outreach_event_id,
          current_outreach_event_seq = excluded.current_outreach_event_seq,
          updated_at = now()
      where excluded.current_outreach_event_seq > private.gmail_outreach_creator_decisions.current_outreach_event_seq
         or private.gmail_outreach_creator_decisions.current_outreach_event_seq is null;

  elsif p_axis = 'target_scope' then
    if p_target_scope_decision not in ('single_target', 'multiple_targets', 'portfolio_target', 'unresolved') then
      raise exception 'invalid target scope decision %', p_target_scope_decision using errcode = 'invalid_parameter_value';
    end if;

    insert into private.gmail_outreach_creator_decision_events (
      user_id, mail_account_id, normalized_thread_id, axis, decided_by_user_id, target_scope_decision
    ) values (
      v_user_id, p_mail_account_id, p_normalized_thread_id, 'target_scope', v_user_id, p_target_scope_decision
    ) returning id, event_seq into v_event_id, v_event_seq;

    insert into private.gmail_outreach_creator_decisions (
      user_id, mail_account_id, normalized_thread_id, target_scope_decision, current_target_scope_event_id, current_target_scope_event_seq
    ) values (
      v_user_id, p_mail_account_id, p_normalized_thread_id, p_target_scope_decision, v_event_id, v_event_seq
    )
    on conflict (mail_account_id, normalized_thread_id) do update
      set target_scope_decision = excluded.target_scope_decision,
          current_target_scope_event_id = excluded.current_target_scope_event_id,
          current_target_scope_event_seq = excluded.current_target_scope_event_seq,
          updated_at = now()
      where excluded.current_target_scope_event_seq > private.gmail_outreach_creator_decisions.current_target_scope_event_seq
         or private.gmail_outreach_creator_decisions.current_target_scope_event_seq is null;

  elsif p_axis = 'target' then
    if p_target_action not in ('confirm', 'remove') or p_target_observation_id is null then
      raise exception 'invalid target decision' using errcode = 'invalid_parameter_value';
    end if;

    perform 1 from private.gmail_outreach_target_observations
     where id = p_target_observation_id
       and mail_account_id = p_mail_account_id
       and normalized_thread_id = p_normalized_thread_id;
    if not found then
      return jsonb_build_object('result', 'observation_not_found');
    end if;

    insert into private.gmail_outreach_creator_decision_events (
      user_id, mail_account_id, normalized_thread_id, axis, decided_by_user_id, target_action, target_observation_id
    ) values (
      v_user_id, p_mail_account_id, p_normalized_thread_id, 'target', v_user_id, p_target_action, p_target_observation_id
    ) returning id, event_seq into v_event_id, v_event_seq;

    insert into private.gmail_outreach_target_confirmations (
      mail_account_id, normalized_thread_id, target_observation_id, is_confirmed, current_event_id, current_event_seq
    ) values (
      p_mail_account_id, p_normalized_thread_id, p_target_observation_id, (p_target_action = 'confirm'), v_event_id, v_event_seq
    )
    on conflict (normalized_thread_id, target_observation_id) do update
      set is_confirmed = excluded.is_confirmed,
          current_event_id = excluded.current_event_id,
          current_event_seq = excluded.current_event_seq,
          updated_at = now()
      where excluded.current_event_seq > private.gmail_outreach_target_confirmations.current_event_seq;

  else -- target_contact
    if p_target_action not in ('confirm', 'remove') or p_observed_recipient_id is null then
      raise exception 'invalid target-contact decision' using errcode = 'invalid_parameter_value';
    end if;

    perform 1 from private.gmail_outreach_observed_recipients
     where id = p_observed_recipient_id
       and mail_account_id = p_mail_account_id
       and normalized_thread_id = p_normalized_thread_id;
    if not found then
      return jsonb_build_object('result', 'recipient_not_found');
    end if;

    insert into private.gmail_outreach_creator_decision_events (
      user_id, mail_account_id, normalized_thread_id, axis, decided_by_user_id, target_action, observed_recipient_id
    ) values (
      v_user_id, p_mail_account_id, p_normalized_thread_id, 'target_contact', v_user_id, p_target_action, p_observed_recipient_id
    ) returning id, event_seq into v_event_id, v_event_seq;

    insert into private.gmail_outreach_target_contact_confirmed_members (
      mail_account_id, normalized_thread_id, observed_recipient_id, is_confirmed, current_event_id, current_event_seq
    ) values (
      p_mail_account_id, p_normalized_thread_id, p_observed_recipient_id, (p_target_action = 'confirm'), v_event_id, v_event_seq
    )
    on conflict (normalized_thread_id, observed_recipient_id) do update
      set is_confirmed = excluded.is_confirmed,
          current_event_id = excluded.current_event_id,
          current_event_seq = excluded.current_event_seq,
          updated_at = now()
      where excluded.current_event_seq > private.gmail_outreach_target_contact_confirmed_members.current_event_seq;
  end if;

  return jsonb_build_object('result', 'ok', 'event_id', v_event_id, 'event_seq', v_event_seq);
end;
$$;

revoke all on function public.gmail_outreach_record_creator_decision(
  uuid, uuid, text, text, text, text, uuid, uuid
) from public;

-- ---------------------------------------------------------------------------
-- 11e. STATUS — counts only
-- ---------------------------------------------------------------------------
create or replace function public.gmail_outreach_status(
  p_user_id uuid,
  p_mail_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_threads_classified integer;
  v_qualified integer;
  v_observations integer;
  v_confirmed_targets integer;
  v_recipients integer;
  v_confirmed_contacts integer;
  v_normalized_threads integer;
begin
  perform 1 from public.mail_accounts where id = p_mail_account_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  select count(*)::int into v_normalized_threads
    from private.gmail_normalized_threads where mail_account_id = p_mail_account_id;

  select count(*)::int into v_threads_classified
    from private.gmail_outreach_thread_signals where mail_account_id = p_mail_account_id;

  select count(*)::int into v_qualified
    from private.gmail_outreach_thread_signals
   where mail_account_id = p_mail_account_id and outreach_status = 'qualified_outreach';

  select count(*)::int into v_observations
    from private.gmail_outreach_target_observations where mail_account_id = p_mail_account_id;

  -- `is_confirmed = true`, never row presence — a 'remove' leaves a
  -- tombstone row behind (Finding 3), so counting rows would over-count.
  select count(*)::int into v_confirmed_targets
    from private.gmail_outreach_target_confirmations
   where mail_account_id = p_mail_account_id and is_confirmed = true;

  select count(*)::int into v_recipients
    from private.gmail_outreach_observed_recipients where mail_account_id = p_mail_account_id;

  select count(*)::int into v_confirmed_contacts
    from private.gmail_outreach_target_contact_confirmed_members
   where mail_account_id = p_mail_account_id and is_confirmed = true;

  return jsonb_build_object(
    'result', 'ok',
    'normalized_threads', v_normalized_threads,
    'threads_classified', v_threads_classified,
    'qualified_outreach_threads', v_qualified,
    'target_observations', v_observations,
    'confirmed_targets', v_confirmed_targets,
    'observed_recipients', v_recipients,
    'confirmed_target_contacts', v_confirmed_contacts
  );
end;
$$;

revoke all on function public.gmail_outreach_status(uuid, uuid) from public;

-- ---------------------------------------------------------------------------
-- 11f. DELETION — purge both layers together
-- ---------------------------------------------------------------------------
create or replace function public.gmail_outreach_purge_for_deletion(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_deletion_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_account public.mail_accounts%rowtype;
  v_request public.mail_account_deletion_requests%rowtype;
  v_signals integer;
  v_decisions integer;
  v_observations integer;
  v_recipients integer;
begin
  select m.* into v_account from public.mail_accounts m
   where m.id = p_mail_account_id and m.user_id = p_user_id
   for no key update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_account.connection_state <> 'deletion_pending' then
    return jsonb_build_object('result', 'not_deleting', 'connection_state', v_account.connection_state);
  end if;

  if v_account.current_deletion_request_id is distinct from p_deletion_request_id then
    return jsonb_build_object('result', 'stale_deletion_request');
  end if;

  select r.* into v_request from public.mail_account_deletion_requests r where r.id = p_deletion_request_id;

  if not found or v_request.mail_account_id <> p_mail_account_id or v_request.user_id <> p_user_id then
    return jsonb_build_object('result', 'stale_deletion_request');
  end if;

  if v_request.status not in ('requested', 'in_progress') then
    return jsonb_build_object('result', 'request_not_running', 'status', v_request.status);
  end if;

  if v_request.scope not in ('gmail_derived_data', 'account_and_gmail_derived_data') then
    return jsonb_build_object('result', 'scope_excludes_gmail_data', 'scope', v_request.scope);
  end if;

  -- HUMAN layer first (its FKs point into the machine layer's identity rows).
  with removed as (
    delete from private.gmail_outreach_creator_decisions where mail_account_id = p_mail_account_id returning 1
  ) select count(*)::int into v_decisions from removed;

  delete from private.gmail_outreach_target_confirmations where mail_account_id = p_mail_account_id;
  delete from private.gmail_outreach_target_contact_confirmed_members where mail_account_id = p_mail_account_id;
  delete from private.gmail_outreach_creator_decision_events where mail_account_id = p_mail_account_id;

  -- MACHINE layer.
  with removed as (
    delete from private.gmail_outreach_thread_signals where mail_account_id = p_mail_account_id returning 1
  ) select count(*)::int into v_signals from removed;

  with removed as (
    delete from private.gmail_outreach_target_observations where mail_account_id = p_mail_account_id returning 1
  ) select count(*)::int into v_observations from removed;

  with removed as (
    delete from private.gmail_outreach_observed_recipients where mail_account_id = p_mail_account_id returning 1
  ) select count(*)::int into v_recipients from removed;

  delete from private.gmail_outreach_target_contact_signals where mail_account_id = p_mail_account_id;

  -- Standalone thread-level row (no FK into any other B05 table), so it has
  -- no cascade to rely on — must be purged explicitly.
  delete from private.gmail_outreach_target_scope_signals where mail_account_id = p_mail_account_id;

  return jsonb_build_object(
    'result', 'ok',
    'thread_signals_removed', v_signals,
    'creator_decisions_removed', v_decisions,
    'target_observations_removed', v_observations,
    'observed_recipients_removed', v_recipients
  );
end;
$$;

revoke all on function public.gmail_outreach_purge_for_deletion(uuid, uuid, uuid) from public;

-- ===========================================================================
-- 12. EXECUTE PRIVILEGES
-- ===========================================================================
-- MACHINE RPCs: service_role only. Never authenticated, never anon — these
-- are the functions that can write the MACHINE layer, and none of them ever
-- touches the HUMAN ledger (Finding 2).
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.gmail_outreach_current_catalog_epoch()',
    'public.gmail_outreach_list_candidates(uuid,uuid,text,text,bigint,integer,uuid[])',
    'public.gmail_outreach_get_thread_evidence(uuid,uuid,uuid)',
    'public.gmail_outreach_commit_interpretation(uuid,uuid,uuid,text,text,text,text,text[],uuid[],text,text,jsonb,jsonb,jsonb,text,text[],bigint)',
    'public.gmail_outreach_status(uuid,uuid)',
    'public.gmail_outreach_purge_for_deletion(uuid,uuid,uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- THE CREATOR-DECISION RPC (EXTERNAL AUDIT AMENDMENT #1, Finding 2): the one
-- write that claims to be unforgeable human truth derives its actor from
-- `auth.uid()`, never a parameter, so it is safe to expose to `authenticated`
-- — and IS granted to it, because a real end-user session (the repository's
-- `@/lib/supabase/server` client) is how the actual product calls it.
-- `service_role` keeps EXECUTE too, for the same reason every other B0X
-- consent/decision RPC does — but the function's own `auth.uid()` check,
-- not this grant, is what actually decides whether a call may proceed: a
-- service-role connection that never established a real end-user identity
-- gets `unauthenticated` regardless of this grant.
revoke all on function public.gmail_outreach_record_creator_decision(
  uuid, uuid, text, text, text, text, uuid, uuid
) from public, anon;
grant execute on function public.gmail_outreach_record_creator_decision(
  uuid, uuid, text, text, text, text, uuid, uuid
) to authenticated, service_role;

-- ===========================================================================
-- 13. WHAT 0039 DOES NOT CREATE
-- ===========================================================================
-- No sent/reply/timing fact, no parent/child message relationship — B06.
-- No outcome/correction taxonomy beyond the four decision axes above — B07.
-- No incremental sync/watch state — B08.
-- No network-intelligence (G3) row, aggregate or eligibility flag.
-- No write to public.pipeline_items, public.outreach_events or
--   public.collaborations, anywhere in this migration.
-- No canonical hotel, organization, brand or contact row is ever created or
--   mutated by anything above.
-- No client-readable view of B05 content, for any role.
