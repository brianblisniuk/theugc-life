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
       'gmail_outreach_thread_signals',
       'gmail_outreach_observed_recipients',
       'gmail_outreach_observed_recipient_canonical_links',
       'gmail_outreach_target_contact_signals',
       'gmail_outreach_target_contact_candidates',
       'gmail_outreach_target_observations',
       'gmail_outreach_target_canonical_links',
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

-- SECURITY DEFINER: this fires as an AFTER STATEMENT trigger on ordinary
-- catalog writes to `public.hotels` etc, made by editor/admin roles that have
-- no reason to hold USAGE on a `private` schema sequence. Without definer
-- rights, an editor's routine hotel edit would fail with "permission denied
-- for sequence" — an unrelated, unintended side effect of B05 existing at
-- all. Owned by the migration role, which does hold the privilege.
create or replace function private.bump_gmail_outreach_catalog_epoch()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  perform nextval('private.gmail_outreach_catalog_epoch_seq');
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

create or replace function public.gmail_outreach_current_catalog_epoch()
returns bigint
language sql
security definer
set search_path = public, private, pg_temp
stable
as $$
  select last_value from private.gmail_outreach_catalog_epoch_seq;
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
-- STABILITY: keyed on `source_participant_id`, the exact B04 participant row
-- it was extracted from. Re-extraction upserts (ON CONFLICT DO NOTHING) — the
-- row's id never changes across re-runs, so a human target-contact
-- confirmation referencing it (gmail_outreach_target_contact_confirmed_
-- members) is never orphaned by a B05 re-run.
create table private.gmail_outreach_observed_recipients (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null references public.users(id) on delete cascade,
  mail_account_id uuid not null,
  normalized_thread_id uuid not null,

  source_normalized_message_id uuid not null references private.gmail_normalized_messages(id) on delete cascade,
  source_header_id uuid not null references private.gmail_normalized_headers(id) on delete cascade,
  source_participant_id uuid not null references private.gmail_normalized_participants(id) on delete cascade,

  role text not null check (role in ('to', 'cc', 'bcc')),
  display_name text,
  addr_spec text,
  local_part text,
  domain text,
  domain_lower text,
  parse_status text not null check (parse_status in ('parsed', 'malformed', 'empty_group')),

  created_at timestamptz not null default now(),

  constraint gmail_outreach_observed_recipients_thread_fk
    foreign key (normalized_thread_id, mail_account_id)
    references private.gmail_normalized_threads (id, mail_account_id) on delete cascade,

  constraint gmail_outreach_observed_recipients_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  -- THE STABILITY KEY. One observed-recipient row per B04 participant row,
  -- forever.
  constraint gmail_outreach_observed_recipients_participant_uidx
    unique (source_participant_id)
);

comment on table private.gmail_outreach_observed_recipients is
  'B05: every To/Cc/Bcc occurrence on creator-SENT evidence, unfiltered. Deterministic extraction, not a machine judgement. A recipient here is NOT a commercial target contact by itself — see gmail_outreach_target_contact_candidates and gmail_outreach_target_contact_confirmed_members.';

create index gmail_outreach_observed_recipients_thread_idx
  on private.gmail_outreach_observed_recipients (normalized_thread_id);

create index gmail_outreach_observed_recipients_addr_idx
  on private.gmail_outreach_observed_recipients (lower(addr_spec)) where addr_spec is not null;

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
-- STABILITY: `observation_fingerprint` is a deterministic digest over the
-- normalized identity evidence (name/domain), computed by the caller.
-- Re-extraction upserts by (thread, fingerprint) — a recognized observation's
-- IDENTITY fields are never rewritten, so a creator confirmation referencing
-- it (gmail_outreach_target_confirmations) is never orphaned. Only the
-- ADVISORY columns (machine_canonical_link_assessment, matcher_version,
-- evaluated_epoch, candidate_set_fingerprint) may be updated in place by a
-- later re-run; an evidence set that produces a different fingerprint creates
-- a NEW, additional observation rather than overwriting the old one.
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
  source_message_ids uuid[] not null default '{}',

  -- ADVISORY FIELDS — machine-replaceable, never authoritative.
  machine_canonical_link_assessment text check (machine_canonical_link_assessment in (
    'strong_match', 'needs_review', 'ambiguous', 'insufficient_evidence'
  )),
  matcher_version text check (matcher_version ~ '^[a-z][a-z0-9_]{0,63}$'),
  evaluated_epoch bigint,
  candidate_set_fingerprint text check (candidate_set_fingerprint ~ '^[0-9a-f]{64}$'),

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

  target_scope_decision text check (target_scope_decision in (
    'single_target', 'multiple_targets', 'portfolio_target', 'unresolved'
  )),
  current_target_scope_event_id uuid references private.gmail_outreach_creator_decision_events(id),

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
  'B05 HUMAN layer: current scalar creator decisions (outreach, target_scope) per thread. Authoritative. Never overwritten by a machine re-run. Consistency between target_scope_decision and the confirmed-target-member set (gmail_outreach_target_confirmations) is surfaced as a read-time status, never enforced as a write-time order.';

create trigger gmail_outreach_creator_decisions_touch
  before update on private.gmail_outreach_creator_decisions
  for each row execute function private.touch_gmail_outreach_row();

-- 9b. Confirmed target set (may be many rows per thread — multi/portfolio scope).
create table private.gmail_outreach_target_confirmations (
  id uuid primary key default gen_random_uuid(),

  mail_account_id uuid not null,
  normalized_thread_id uuid not null,
  target_observation_id uuid not null references private.gmail_outreach_target_observations(id) on delete cascade,
  confirming_event_id uuid not null references private.gmail_outreach_creator_decision_events(id),

  created_at timestamptz not null default now(),

  constraint gmail_outreach_target_confirmations_thread_fk
    foreign key (normalized_thread_id, mail_account_id)
    references private.gmail_normalized_threads (id, mail_account_id) on delete cascade,

  -- Presence of a row IS the confirmation; a 'remove' event deletes it.
  constraint gmail_outreach_target_confirmations_uidx
    unique (normalized_thread_id, target_observation_id)
);

comment on table private.gmail_outreach_target_confirmations is
  'B05 HUMAN layer: the creator-confirmed set of commercial targets for a thread, each anchored to a private target observation — never a canonical hotel/organization row directly. A canonical link added or changed later never rewrites this row.';

-- 9c. Confirmed target-contact set (may be many — multiple legitimate contacts).
create table private.gmail_outreach_target_contact_confirmed_members (
  id uuid primary key default gen_random_uuid(),

  mail_account_id uuid not null,
  normalized_thread_id uuid not null,
  observed_recipient_id uuid not null references private.gmail_outreach_observed_recipients(id) on delete cascade,
  confirming_event_id uuid not null references private.gmail_outreach_creator_decision_events(id),

  created_at timestamptz not null default now(),

  constraint gmail_outreach_target_contact_confirmed_members_thread_fk
    foreign key (normalized_thread_id, mail_account_id)
    references private.gmail_normalized_threads (id, mail_account_id) on delete cascade,

  constraint gmail_outreach_target_contact_confirmed_members_uidx
    unique (normalized_thread_id, observed_recipient_id)
);

comment on table private.gmail_outreach_target_contact_confirmed_members is
  'B05 HUMAN layer: the creator-confirmed set of commercial target-contact recipients, each anchored to a stable observed recipient — never a canonical contact row directly.';

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
    into remaining_count;

  if remaining_count > 0 then
    raise exception
      'mail account % is `deleted` while B05 outreach-interpretation state remains (% top-level row(s) across signals/decisions/observations/recipients). B05-derived Gmail data must not survive a completed deletion.',
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
-- 11. RPC SURFACE
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 11a. WHICH THREADS NEED (RE)INTERPRETATION
-- ---------------------------------------------------------------------------
create or replace function public.gmail_outreach_list_candidates(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_detector_version text,
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
begin
  if p_detector_version !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'invalid detector version %', p_detector_version
      using errcode = 'invalid_parameter_value';
  end if;

  if p_limit is null or p_limit < 1 or p_limit <> trunc(p_limit) then
    raise exception 'p_limit must be a positive integer, got %', p_limit
      using errcode = 'invalid_parameter_value';
  end if;

  select coalesce(jsonb_agg(row), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
               'normalized_thread_id', t.id,
               'provider_thread_id', t.provider_thread_id
             ) as row
        from private.gmail_normalized_threads t
        left join private.gmail_outreach_thread_signals s
          on s.normalized_thread_id = t.id and s.mail_account_id = t.mail_account_id
       where t.mail_account_id = p_mail_account_id
         and t.user_id = p_user_id
         and not (t.id = any(coalesce(p_exclude_normalized_thread_ids, '{}'::uuid[])))
         and (
           s.id is null
           or s.detector_version is distinct from p_detector_version
           or s.evidence_message_count <> (
                select count(*)::int from private.gmail_normalized_messages m
                 where m.normalized_thread_id = t.id
              )
           or exists (
                select 1 from private.gmail_normalized_messages m
                 where m.normalized_thread_id = t.id
                   and m.normalized_at > s.evaluated_at
              )
         )
       order by t.id asc
       limit p_limit
    ) candidates;

  return jsonb_build_object('result', 'ok', 'candidates', v_rows);
end;
$$;

revoke all on function public.gmail_outreach_list_candidates(uuid, uuid, text, integer, uuid[]) from public;

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
  v_thread private.gmail_normalized_threads%rowtype;
  v_messages jsonb;
  v_sent_text_parts jsonb;
  v_sent_recipients jsonb;
  v_subjects jsonb;
begin
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

  return jsonb_build_object(
    'result', 'ok',
    'normalized_thread_id', v_thread.id,
    'provider_thread_id', v_thread.provider_thread_id,
    'messages', v_messages,
    'sent_text_parts', v_sent_text_parts,
    'sent_recipients', v_sent_recipients,
    'subjects', v_subjects
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
  v_current_digest text;
  v_current_count integer;
  v_recipient_row jsonb;
  v_recipient_ids uuid[] := '{}'::uuid[];
  v_observation jsonb;
  v_observation_id uuid;
  v_link jsonb;
  v_candidate jsonb;
begin
  if p_detector_version !~ '^[a-z][a-z0-9_]{0,63}$' or p_matcher_version !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'invalid detector/matcher version' using errcode = 'invalid_parameter_value';
  end if;

  if p_outreach_status not in ('qualified_outreach', 'not_outreach', 'needs_review', 'insufficient_evidence') then
    raise exception 'invalid outreach status %', p_outreach_status using errcode = 'invalid_parameter_value';
  end if;

  select m.* into v_account from public.mail_accounts m
   where m.id = p_mail_account_id and m.user_id = p_user_id;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_account.connection_state = 'deleted' then
    return jsonb_build_object('result', 'account_deleted');
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

  -- OBSERVED RECIPIENTS — upsert, stable ids preserved.
  for v_recipient_row in select * from jsonb_array_elements(
    (select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) from unnest(coalesce(p_recipient_participant_ids, '{}'::uuid[])) as x)
  )
  loop
    insert into private.gmail_outreach_observed_recipients (
      user_id, mail_account_id, normalized_thread_id,
      source_normalized_message_id, source_header_id, source_participant_id,
      role, display_name, addr_spec, local_part, domain, domain_lower, parse_status
    )
    select p_user_id, p_mail_account_id, p_normalized_thread_id,
           p.normalized_message_id, p.source_header_id, p.id,
           p.header_role, p.display_name, p.addr_spec, p.local_part, p.domain, p.domain_lower, p.parse_status
      from private.gmail_normalized_participants p
      join private.gmail_normalized_messages m on m.id = p.normalized_message_id
     where p.id = (v_recipient_row #>> '{}')::uuid
       and m.normalized_thread_id = p_normalized_thread_id
       and p.header_role in ('to', 'cc', 'bcc')
    on conflict (source_participant_id) do nothing;

    v_recipient_ids := array_append(v_recipient_ids, (v_recipient_row #>> '{}')::uuid);
  end loop;

  -- CANONICAL CONTACT LINKS — deterministic exact-email match, computed here
  -- (not trusted from the caller), wholesale replaced for this thread's
  -- recipients.
  delete from private.gmail_outreach_observed_recipient_canonical_links l
   using private.gmail_outreach_observed_recipients r
   where l.observed_recipient_id = r.id
     and r.normalized_thread_id = p_normalized_thread_id;

  insert into private.gmail_outreach_observed_recipient_canonical_links (
    observed_recipient_id, canonical_contact_kind, hotel_contact_id, match_basis, evaluated_epoch
  )
  select r.id, 'hotel_contact', hc.id, 'exact_email', p_catalog_epoch
    from private.gmail_outreach_observed_recipients r
    join public.hotel_contacts hc on lower(hc.email) = lower(r.addr_spec)
   where r.normalized_thread_id = p_normalized_thread_id
     and r.addr_spec is not null
     and hc.email is not null;

  insert into private.gmail_outreach_observed_recipient_canonical_links (
    observed_recipient_id, canonical_contact_kind, organization_contact_id, match_basis, evaluated_epoch
  )
  select r.id, 'organization_contact', oc.id, 'exact_email', p_catalog_epoch
    from private.gmail_outreach_observed_recipients r
    join public.organization_contacts oc on lower(oc.email) = lower(r.addr_spec)
   where r.normalized_thread_id = p_normalized_thread_id
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
    insert into private.gmail_outreach_target_contact_candidates (
      normalized_thread_id, mail_account_id, observed_recipient_id, role_evidence, address_pattern_evidence, rank
    )
    select p_normalized_thread_id, p_mail_account_id, r.id,
           v_candidate ->> 'role_evidence', v_candidate ->> 'address_pattern_evidence', (v_candidate ->> 'rank')::int
      from private.gmail_outreach_observed_recipients r
     where r.source_participant_id = (v_candidate ->> 'source_participant_id')::uuid
       and r.normalized_thread_id = p_normalized_thread_id;
  end loop;

  -- TARGET OBSERVATIONS — reconcile, never overwrite identity fields.
  for v_observation in select * from jsonb_array_elements(coalesce(p_target_observations, '[]'::jsonb))
  loop
    insert into private.gmail_outreach_target_observations (
      user_id, mail_account_id, normalized_thread_id, observation_fingerprint,
      observed_name, observed_domain, target_kind_hint, source_message_ids
    ) values (
      p_user_id, p_mail_account_id, p_normalized_thread_id, v_observation ->> 'observation_fingerprint',
      v_observation ->> 'observed_name', v_observation ->> 'observed_domain',
      coalesce(v_observation ->> 'target_kind_hint', 'unknown'),
      coalesce((select array_agg(x::uuid) from jsonb_array_elements_text(v_observation -> 'source_message_ids') x), '{}')
    )
    on conflict (mail_account_id, normalized_thread_id, observation_fingerprint) do nothing
    returning id into v_observation_id;

    if v_observation_id is null then
      select id into v_observation_id
        from private.gmail_outreach_target_observations
       where mail_account_id = p_mail_account_id
         and normalized_thread_id = p_normalized_thread_id
         and observation_fingerprint = v_observation ->> 'observation_fingerprint';
    end if;

    update private.gmail_outreach_target_observations
       set machine_canonical_link_assessment = v_observation ->> 'machine_canonical_link_assessment',
           matcher_version = p_matcher_version,
           evaluated_epoch = p_catalog_epoch,
           candidate_set_fingerprint = v_observation ->> 'candidate_set_fingerprint'
     where id = v_observation_id;

    delete from private.gmail_outreach_target_canonical_links where target_observation_id = v_observation_id;

    for v_link in select * from jsonb_array_elements(coalesce(p_target_canonical_links, '[]'::jsonb))
    loop
      if v_link ->> 'observation_fingerprint' = v_observation ->> 'observation_fingerprint' then
        insert into private.gmail_outreach_target_canonical_links (
          target_observation_id, target_kind, target_hotel_id, target_organization_id,
          name_evidence, domain_evidence, address_evidence, contact_evidence, rank
        ) values (
          v_observation_id,
          v_link ->> 'target_kind',
          nullif(v_link ->> 'target_hotel_id', '')::uuid,
          nullif(v_link ->> 'target_organization_id', '')::uuid,
          v_link ->> 'name_evidence', v_link ->> 'domain_evidence',
          v_link ->> 'address_evidence', v_link ->> 'contact_evidence',
          (v_link ->> 'rank')::int
        );
      end if;
    end loop;

    v_observation_id := null;
  end loop;

  return jsonb_build_object('result', 'ok', 'normalized_thread_id', p_normalized_thread_id);
end;
$$;

revoke all on function public.gmail_outreach_commit_interpretation(
  uuid, uuid, uuid, text, text, text, text, text[], uuid[], text, text, jsonb, jsonb, jsonb, bigint
) from public;

-- ---------------------------------------------------------------------------
-- 11d. CREATOR DECISIONS — the ONLY writer of the human ledger
-- ---------------------------------------------------------------------------
-- One generic, exhaustively-validated entrypoint for all four axes, rather
-- than four near-identical functions. `p_decided_by_user_id` must equal
-- `p_user_id` (no delegation) — enforced twice: once here explicitly, once
-- again by the table's own CHECK, so the invariant survives a future caller
-- that forgets this comment.
create or replace function public.gmail_outreach_record_creator_decision(
  p_user_id uuid,
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
  v_account public.mail_accounts%rowtype;
  v_thread private.gmail_normalized_threads%rowtype;
  v_event_id uuid;
  v_observed_state text;
begin
  if p_axis not in ('outreach', 'target_scope', 'target', 'target_contact') then
    raise exception 'invalid axis %', p_axis using errcode = 'invalid_parameter_value';
  end if;

  select m.* into v_account from public.mail_accounts m
   where m.id = p_mail_account_id and m.user_id = p_user_id;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_account.connection_state = 'deleted' then
    return jsonb_build_object('result', 'account_deleted');
  end if;

  select t.* into v_thread from private.gmail_normalized_threads t
   where t.id = p_normalized_thread_id and t.mail_account_id = p_mail_account_id and t.user_id = p_user_id;

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
      p_user_id, p_mail_account_id, p_normalized_thread_id, 'outreach', p_user_id, p_outreach_decision, v_observed_state
    ) returning id into v_event_id;

    insert into private.gmail_outreach_creator_decisions (
      user_id, mail_account_id, normalized_thread_id, outreach_decision, current_outreach_event_id
    ) values (
      p_user_id, p_mail_account_id, p_normalized_thread_id, p_outreach_decision, v_event_id
    )
    on conflict (mail_account_id, normalized_thread_id) do update
      set outreach_decision = excluded.outreach_decision,
          current_outreach_event_id = excluded.current_outreach_event_id;

  elsif p_axis = 'target_scope' then
    if p_target_scope_decision not in ('single_target', 'multiple_targets', 'portfolio_target', 'unresolved') then
      raise exception 'invalid target scope decision %', p_target_scope_decision using errcode = 'invalid_parameter_value';
    end if;

    insert into private.gmail_outreach_creator_decision_events (
      user_id, mail_account_id, normalized_thread_id, axis, decided_by_user_id, target_scope_decision
    ) values (
      p_user_id, p_mail_account_id, p_normalized_thread_id, 'target_scope', p_user_id, p_target_scope_decision
    ) returning id into v_event_id;

    insert into private.gmail_outreach_creator_decisions (
      user_id, mail_account_id, normalized_thread_id, target_scope_decision, current_target_scope_event_id
    ) values (
      p_user_id, p_mail_account_id, p_normalized_thread_id, p_target_scope_decision, v_event_id
    )
    on conflict (mail_account_id, normalized_thread_id) do update
      set target_scope_decision = excluded.target_scope_decision,
          current_target_scope_event_id = excluded.current_target_scope_event_id;

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
      p_user_id, p_mail_account_id, p_normalized_thread_id, 'target', p_user_id, p_target_action, p_target_observation_id
    ) returning id into v_event_id;

    if p_target_action = 'confirm' then
      insert into private.gmail_outreach_target_confirmations (
        mail_account_id, normalized_thread_id, target_observation_id, confirming_event_id
      ) values (
        p_mail_account_id, p_normalized_thread_id, p_target_observation_id, v_event_id
      )
      on conflict (normalized_thread_id, target_observation_id) do update
        set confirming_event_id = excluded.confirming_event_id;
    else
      delete from private.gmail_outreach_target_confirmations
       where normalized_thread_id = p_normalized_thread_id and target_observation_id = p_target_observation_id;
    end if;

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
      p_user_id, p_mail_account_id, p_normalized_thread_id, 'target_contact', p_user_id, p_target_action, p_observed_recipient_id
    ) returning id into v_event_id;

    if p_target_action = 'confirm' then
      insert into private.gmail_outreach_target_contact_confirmed_members (
        mail_account_id, normalized_thread_id, observed_recipient_id, confirming_event_id
      ) values (
        p_mail_account_id, p_normalized_thread_id, p_observed_recipient_id, v_event_id
      )
      on conflict (normalized_thread_id, observed_recipient_id) do update
        set confirming_event_id = excluded.confirming_event_id;
    else
      delete from private.gmail_outreach_target_contact_confirmed_members
       where normalized_thread_id = p_normalized_thread_id and observed_recipient_id = p_observed_recipient_id;
    end if;
  end if;

  return jsonb_build_object('result', 'ok', 'event_id', v_event_id);
end;
$$;

revoke all on function public.gmail_outreach_record_creator_decision(
  uuid, uuid, uuid, text, text, text, text, uuid, uuid
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

  select count(*)::int into v_confirmed_targets
    from private.gmail_outreach_target_confirmations where mail_account_id = p_mail_account_id;

  select count(*)::int into v_recipients
    from private.gmail_outreach_observed_recipients where mail_account_id = p_mail_account_id;

  select count(*)::int into v_confirmed_contacts
    from private.gmail_outreach_target_contact_confirmed_members where mail_account_id = p_mail_account_id;

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
-- 12. EXECUTE PRIVILEGES — service_role AND NOBODY ELSE
-- ===========================================================================
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.gmail_outreach_current_catalog_epoch()',
    'public.gmail_outreach_list_candidates(uuid,uuid,text,integer,uuid[])',
    'public.gmail_outreach_get_thread_evidence(uuid,uuid,uuid)',
    'public.gmail_outreach_commit_interpretation(uuid,uuid,uuid,text,text,text,text,text[],uuid[],text,text,jsonb,jsonb,jsonb,bigint)',
    'public.gmail_outreach_record_creator_decision(uuid,uuid,uuid,text,text,text,text,uuid,uuid)',
    'public.gmail_outreach_status(uuid,uuid)',
    'public.gmail_outreach_purge_for_deletion(uuid,uuid,uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

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
