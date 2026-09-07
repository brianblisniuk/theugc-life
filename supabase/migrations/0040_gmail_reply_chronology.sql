-- ===========================================================================
-- 0040 — B06: GMAIL PRIVATE REPLY CHRONOLOGY
-- ===========================================================================
-- D071 governs this migration (docs/DECISIONS.md, docs/B06_GMAIL_REPLY_
-- CHRONOLOGY_CONTRACT.md). B05 answered which threads are creator-commercial
-- outreach and who/what was targeted. B06 answers only: what happened
-- CHRONOLOGICALLY after creator-SENT messages in an eligible thread — which
-- later messages are plausible responses, which are qualifying human replies
-- versus automated/delivery noise or ambiguity, and how much observed time
-- elapsed relative to the creator's sends.
--
-- B06 is LOCAL computation over rows B03/B04/B05 already wrote. Zero Gmail
-- API calls, zero OAuth changes, zero quota use, and no mutation of any
-- B03/B04/B05 row.
--
-- WHAT THIS MIGRATION DOES NOT CREATE, on purpose:
--
--   no positive/negative, interest, rejection, negotiation, rate/barter/
--     hosted/paid/hybrid, won/lost/ghosted or sentiment classification —
--     all B07;
--   no creator correction table — B07 owns creator correction of reply/
--     outcome meaning; B06 leaves it a stable anchor, nothing more;
--   no incremental sync/watch state — B08;
--   no network-intelligence (G3) row, aggregate or eligibility flag;
--   no write to public.pipeline_items, public.outreach_events or
--     public.collaborations, and no canonical hotel/organization/contact
--     row is ever created or mutated by anything in this migration;
--   no widening of B03's retained-header allow-list. `Auto-Submitted`,
--     `Precedence` and similar automation headers were never stored, and
--     their absence is never treated as evidence a message is human.
--
-- 0035–0039 are UNCHANGED. This migration extends the schema additively.
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
     and c.relname in ('gmail_reply_message_observations', 'gmail_reply_thread_summaries');

  if colliding is not null then
    raise exception
      '0040 refuses to install: private table(s) % already exist. B06 is the first reply-chronology layer, so pre-existing tables of these names hold state this migration did not create and cannot interpret.',
      array_to_string(colliding, ', ')
      using errcode = 'restrict_violation';
  end if;
end;
$$;

-- ===========================================================================
-- 1. STABLE MESSAGE OBSERVATIONS
-- ===========================================================================
-- B06's durable anchor is the Gmail provider message identity, NOT a
-- replaceable B04 row id. A raw-digest replacement deletes and rebuilds the
-- normalized projection (0038 §7's invalidation trigger) while the Gmail
-- message itself is the same communication — so a future B07 human
-- correction anchored to `gmail_normalized_messages.id` would be silently
-- orphaned by the next B04 rebuild. `(mail_account_id, provider_message_id)`
-- never moves.
--
-- `current_normalized_message_id` doubles as the per-message currency
-- signal: an `on delete set null` foreign key to `gmail_normalized_messages`
-- means this column goes NULL the instant B04 invalidates that exact
-- message's projection (the delete this migration does not need to know
-- about happens in the SAME transaction as the raw row's own UPDATE), with
-- no extra bookkeeping trigger required. A null value means "this
-- observation's evidence is not currently present" — a genuine re-evaluation
-- candidate, never evidence of anything about the message itself.
--
-- ONE ROW PER MESSAGE B06 HAS EVALUATED IN AN ELIGIBLE THREAD, creator-sent
-- touches included (`response_class = 'creator_sent_touch'`) — a uniform
-- anchor, so a future B07 correction is never restricted to non-SENT
-- messages only.
create table private.gmail_reply_message_observations (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null references public.users(id) on delete cascade,
  mail_account_id uuid not null,
  normalized_thread_id uuid not null,

  provider_message_id text not null check (length(btrim(provider_message_id)) > 0),

  -- Durable copy of Gmail's own `internalDate`. Evidence, not omniscient
  -- chronology (§17/contract §10) — kept here so history remains readable
  -- even while `current_normalized_message_id` is transiently null.
  internal_date timestamptz not null,

  -- THE PER-MESSAGE CURRENCY SIGNAL. See the table comment above.
  current_normalized_message_id uuid references private.gmail_normalized_messages(id) on delete set null,
  -- The source digest this observation was LAST evaluated against. Kept even
  -- once `current_normalized_message_id` goes null, for audit/debugging —
  -- never itself the currency signal.
  last_evaluated_source_payload_sha256 text not null check (last_evaluated_source_payload_sha256 ~ '^[0-9a-f]{64}$'),

  -- B06 V1 response classes (contract §6). No binary `replied` field is the
  -- sole source of truth.
  response_class text not null check (response_class in (
    'creator_sent_touch', 'qualifying_human_reply', 'automated_response',
    'delivery_status', 'ambiguous_inbound', 'not_reply'
  )),

  -- Reply-relationship evidence, PRESERVED SEPARATELY from the classification
  -- above (contract §7) — never collapsed into one judgement. Null only for
  -- `creator_sent_touch`: a creator's own send has no "relationship to prior
  -- creator activity" axis in B06's scope.
  relation_status text check (relation_status in (
    'direct_in_reply_to', 'references_chain', 'thread_sequence_only',
    'ambiguous_reference', 'no_preceding_creator_sent'
  )),

  -- The unambiguous creator-sent provider message id this row's `In-Reply-To`
  -- or `References` evidence resolved to, when `relation_status` is
  -- `direct_in_reply_to` or `references_chain`. `Message-ID` is evidence
  -- only (contract §7) — provider message identity remains
  -- `(mail_account_id, provider_message_id)`.
  referenced_creator_sent_provider_message_id text,

  -- The latest creator-sent touch strictly preceding this message in the
  -- stored chronology, when determinable — independent of whether a direct/
  -- references relationship was ALSO established. Feeds CLOCK B (contract
  -- §10) for a qualifying human reply.
  latest_preceding_creator_sent_provider_message_id text,

  -- `internal_date` said this response preceded its own referenced creator
  -- send. The relation is preserved; timing is not trusted (contract §10 —
  -- "Timestamp conflicts").
  chronology_conflict boolean not null default false,

  relation_rule_version text not null check (relation_rule_version ~ '^[a-z][a-z0-9_]{0,63}$'),
  classification_rule_version text not null check (classification_rule_version ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- Null for `creator_sent_touch`: no reply-text extraction applies to a
  -- creator's own send.
  text_transform_version text check (text_transform_version ~ '^[a-z][a-z0-9_]{0,63}$'),

  evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gmail_reply_message_observations_thread_fk
    foreign key (normalized_thread_id, mail_account_id)
    references private.gmail_normalized_threads (id, mail_account_id) on delete cascade,

  constraint gmail_reply_message_observations_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  -- THE STABLE IDENTITY. Account-scoped, exactly like B03/B04's own message
  -- identity — never the row's own `id`, never `normalized_thread_id`.
  constraint gmail_reply_message_observations_identity_uidx
    unique (mail_account_id, provider_message_id),

  constraint gmail_reply_message_observations_creator_sent_shape check (
    (response_class = 'creator_sent_touch'
      and relation_status is null
      and referenced_creator_sent_provider_message_id is null
      and latest_preceding_creator_sent_provider_message_id is null
      and chronology_conflict = false
      and text_transform_version is null)
    or
    (response_class <> 'creator_sent_touch'
      and relation_status is not null
      and text_transform_version is not null)
  ),

  constraint gmail_reply_message_observations_referenced_shape check (
    referenced_creator_sent_provider_message_id is null
    or relation_status in ('direct_in_reply_to', 'references_chain')
  )
);

comment on table private.gmail_reply_message_observations is
  'B06: one stable row per Gmail provider message identity B06 has evaluated in an eligible thread. Identity is (mail_account_id, provider_message_id) — never gmail_normalized_messages.id, which is replaceable on a B04 rebuild. current_normalized_message_id going null (via ON DELETE SET NULL) is the per-message currency signal. Machine interpretation (response_class/relation_status/...) is replaceable; the row identity is not.';

create index gmail_reply_message_observations_thread_idx
  on private.gmail_reply_message_observations (mail_account_id, normalized_thread_id, internal_date, provider_message_id);

create index gmail_reply_message_observations_current_message_idx
  on private.gmail_reply_message_observations (current_normalized_message_id);

create or replace function private.touch_gmail_reply_row()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.touch_gmail_reply_row() from public;

create trigger gmail_reply_message_observations_touch
  before update on private.gmail_reply_message_observations
  for each row execute function private.touch_gmail_reply_row();

-- ===========================================================================
-- 2. THREAD-LEVEL CURRENT SUMMARY
-- ===========================================================================
-- A replaceable machine summary over one currently-eligible thread, derived
-- atomically from the message observations above. `evidence_digest` is the
-- exact same content-addressed fence shape B05 uses (contract §13/§19):
-- `sha256` over the sorted `(id, source_payload_sha256, provider_sent)`
-- tuples of the thread's current normalized messages, re-verified under lock
-- at commit time by `gmail_reply_commit_interpretation` below.
create table private.gmail_reply_thread_summaries (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null references public.users(id) on delete cascade,
  mail_account_id uuid not null,
  normalized_thread_id uuid not null,

  -- WHY this thread was eligible for the evaluation that produced this
  -- summary (contract §3/§5) — informational. Eligibility is re-checked
  -- fresh on every new commit; a later ineligibility never deletes or
  -- rewrites this row (retention vs. new-processing, contract §4).
  eligibility text not null check (eligibility in (
    'eligible_confirmed', 'eligible_qualified_machine', 'eligible_needs_review_advisory'
  )),

  -- Outcome-neutral observation state (contract §12). Never won/lost/
  -- ghosted/rejected/interested.
  observation_state text not null check (observation_state in (
    'qualifying_human_reply_observed', 'ambiguous_response_observed',
    'only_automated_or_delivery_observed', 'no_qualifying_response_observed_in_window',
    'observation_horizon_unknown'
  )),

  first_creator_sent_provider_message_id text,
  first_creator_sent_at timestamptz,
  first_qualifying_human_reply_provider_message_id text,
  first_qualifying_human_reply_at timestamptz,
  creator_sent_count_before_first_human_reply integer check (creator_sent_count_before_first_human_reply >= 0),
  latest_creator_sent_before_reply_provider_message_id text,

  -- CLOCK A (contract §10): first creator-SENT -> first qualifying human reply.
  latency_from_first_creator_sent_ms bigint check (latency_from_first_creator_sent_ms >= 0),
  -- CLOCK B (contract §10): latest creator-SENT strictly before that reply -> that reply.
  latency_from_latest_creator_sent_ms bigint check (latency_from_latest_creator_sent_ms >= 0),

  -- Reference evidence said "reply", but internal_date placed it before its
  -- referenced creator send. The relation survives on the message
  -- observation; this thread's latency fields are NULL, never negative.
  reply_chronology_conflict boolean not null default false,

  -- The proven historical observation horizon (contract §11/§18) — the
  -- greatest window_end_at among COMPLETED B03 runs whose thread-work row
  -- for this exact provider thread is `complete`. Null iff observation_state
  -- is `observation_horizon_unknown`.
  observed_through_at timestamptz,

  evidence_digest text not null check (evidence_digest ~ '^[0-9a-f]{64}$'),
  evidence_message_count integer not null check (evidence_message_count >= 0),

  relation_rule_version text not null check (relation_rule_version ~ '^[a-z][a-z0-9_]{0,63}$'),
  classification_rule_version text not null check (classification_rule_version ~ '^[a-z][a-z0-9_]{0,63}$'),
  text_transform_version text not null check (text_transform_version ~ '^[a-z][a-z0-9_]{0,63}$'),

  evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gmail_reply_thread_summaries_thread_fk
    foreign key (normalized_thread_id, mail_account_id)
    references private.gmail_normalized_threads (id, mail_account_id) on delete cascade,

  constraint gmail_reply_thread_summaries_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  constraint gmail_reply_thread_summaries_identity_uidx
    unique (mail_account_id, normalized_thread_id),

  -- A qualifying reply was observed iff its provider id/time are populated.
  constraint gmail_reply_thread_summaries_reply_shape check (
    (observation_state = 'qualifying_human_reply_observed')
    = (first_qualifying_human_reply_provider_message_id is not null
       and first_qualifying_human_reply_at is not null)
  ),

  -- Latency is meaningful ONLY for an observed qualifying reply, and (contract
  -- §10) is NULL rather than negative/fabricated on a chronology conflict.
  constraint gmail_reply_thread_summaries_latency_shape check (
    (observation_state = 'qualifying_human_reply_observed' and not reply_chronology_conflict)
    or (latency_from_first_creator_sent_ms is null and latency_from_latest_creator_sent_ms is null)
  ),

  -- Absence is window-bounded (contract §11): claiming "no reply in window"
  -- requires a proven horizon.
  constraint gmail_reply_thread_summaries_horizon_known_shape check (
    observation_state <> 'no_qualifying_response_observed_in_window' or observed_through_at is not null
  ),

  -- Unknown horizon means exactly that — no reply claim of any shape, and no
  -- horizon timestamp to cite.
  constraint gmail_reply_thread_summaries_horizon_unknown_shape check (
    observation_state <> 'observation_horizon_unknown'
    or (observed_through_at is null and first_qualifying_human_reply_provider_message_id is null)
  )
);

comment on table private.gmail_reply_thread_summaries is
  'B06: current, replaceable machine summary per eligible thread. Outcome-neutral (contract §12) — never won/lost/ghosted/interested/rejected. evidence_digest is the source-evidence fence, re-verified under lock at commit time exactly like B05''s thread_signals.evidence_digest.';

create index gmail_reply_thread_summaries_account_idx
  on private.gmail_reply_thread_summaries (mail_account_id);

create trigger gmail_reply_thread_summaries_touch
  before update on private.gmail_reply_thread_summaries
  for each row execute function private.touch_gmail_reply_row();

-- ===========================================================================
-- 3. ELIGIBILITY (contract §3/§5) — reads B05 human/machine truth, writes nothing
-- ===========================================================================
-- Human B05 truth is authoritative when present; without it, machine
-- `qualified_outreach`/`needs_review` are eligible (advisory for the latter),
-- `not_outreach`/`insufficient_evidence`/no signal at all are not.
create or replace function private.gmail_reply_thread_eligibility(
  p_mail_account_id uuid,
  p_normalized_thread_id uuid
)
returns text
language plpgsql
stable
as $$
declare
  v_outreach_decision text;
  v_outreach_status text;
begin
  select d.outreach_decision into v_outreach_decision
    from private.gmail_outreach_creator_decisions d
   where d.mail_account_id = p_mail_account_id
     and d.normalized_thread_id = p_normalized_thread_id;

  if v_outreach_decision = 'outreach_confirmed' then
    return 'eligible_confirmed';
  end if;
  if v_outreach_decision = 'not_outreach_confirmed' then
    return 'not_eligible';
  end if;

  select s.outreach_status into v_outreach_status
    from private.gmail_outreach_thread_signals s
   where s.mail_account_id = p_mail_account_id
     and s.normalized_thread_id = p_normalized_thread_id;

  if v_outreach_status = 'qualified_outreach' then
    return 'eligible_qualified_machine';
  end if;
  if v_outreach_status = 'needs_review' then
    return 'eligible_needs_review_advisory';
  end if;

  return 'not_eligible';
end;
$$;

revoke all on function private.gmail_reply_thread_eligibility(uuid, uuid) from public;

-- ===========================================================================
-- 4. HISTORICAL OBSERVATION HORIZON (contract §11/§18)
-- ===========================================================================
-- The accepted V1 definition, verbatim: the greatest window_end_at among
-- COMPLETED B03 import runs whose thread-work row for this EXACT mailbox/
-- provider_thread_id is `complete`. Never "latest mailbox import end" — a
-- later run may never have fetched this specific thread.
create or replace function private.gmail_reply_observed_through_at(
  p_mail_account_id uuid,
  p_provider_thread_id text
)
returns timestamptz
language sql
stable
as $$
  select max(r.window_end_at)
    from private.gmail_historical_import_threads t
    join private.gmail_historical_import_runs r on r.id = t.run_id
   where t.mail_account_id = p_mail_account_id
     and t.provider_thread_id = p_provider_thread_id
     and t.status = 'complete'
     and r.status = 'completed';
$$;

revoke all on function private.gmail_reply_observed_through_at(uuid, text) from public;

-- ===========================================================================
-- 5. DELETION MUST PURGE B06 TOO (extends D067's invariant)
-- ===========================================================================
-- Identical shape to B05's own `assert_gmail_outreach_data_absent_when_
-- deleted` (0039 §10) — an independent, deferred constraint trigger, because
-- a `deleted` mail account cannot finish deletion while ANY B0X layer's
-- Gmail-derived rows remain, and each layer owns proving its own absence.
create or replace function public.assert_gmail_reply_data_absent_when_deleted()
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
    (select count(*) from private.gmail_reply_message_observations where mail_account_id = account_id)
    + (select count(*) from private.gmail_reply_thread_summaries where mail_account_id = account_id)
    into remaining_count;

  if remaining_count > 0 then
    raise exception
      'mail account % is `deleted` while B06 reply-chronology state remains (% top-level row(s) across message observations/thread summaries). B06-derived Gmail data must not survive a completed deletion.',
      account_id, remaining_count
      using errcode = 'integrity_constraint_violation';
  end if;

  return null;
end;
$$;

revoke all on function public.assert_gmail_reply_data_absent_when_deleted() from public;
revoke all on function public.assert_gmail_reply_data_absent_when_deleted() from anon, authenticated;

create constraint trigger mail_accounts_gmail_reply_absent_when_deleted
  after insert or update on public.mail_accounts
  deferrable initially deferred
  for each row execute function public.assert_gmail_reply_data_absent_when_deleted();

create constraint trigger gmail_reply_message_observations_absent_when_deleted
  after insert or update on private.gmail_reply_message_observations
  deferrable initially deferred
  for each row execute function public.assert_gmail_reply_data_absent_when_deleted();

create constraint trigger gmail_reply_thread_summaries_absent_when_deleted
  after insert or update on private.gmail_reply_thread_summaries
  deferrable initially deferred
  for each row execute function public.assert_gmail_reply_data_absent_when_deleted();

-- ===========================================================================
-- 6. THE CONSENT/LIFECYCLE FENCE — REUSED, NOT RE-IMPLEMENTED
-- ===========================================================================
-- B06 outputs are G2, exactly like B05's (contract §4): before every new
-- derivation/commit, the database must authoritatively establish that the
-- mailbox belongs to the creator, current `private_gmail_processing` consent
-- is granted, and deletion has not started — the SAME permission boundary
-- B05 already established, with the SAME lock-ordering safety argument.
--
-- `private.gmail_outreach_may_process(p_mail_account_id)` (0039 §10b,
-- unlocked/cheap) and `private.gmail_outreach_assert_may_process_locked
-- (p_mail_account_id)` (0039 §10c, the real transactional fence) are
-- PROVABLY generic despite their name: their bodies touch only
-- `public.mail_accounts` and `public.mail_account_consents` — no B05 table,
-- no B05-specific column — and the consent kind they check
-- (`'private_gmail_processing'`) is the EXACT SAME kind contract §4 requires
-- of B06. Reimplementing the identical two-lock, identical-order fence here
-- would duplicate lock-ordering-sensitive logic for zero behavioral gain and
-- a real risk of drifting out of sync with B05's copy. B06 therefore calls
-- both functions directly, unmodified, from 0039. If a future need ever
-- makes B06's permission semantics diverge from B05's, that is the moment to
-- extract a truly-shared, neutrally-named helper — not before.
--
-- Nothing below deletes/hides EXISTING gmail_reply_* rows on a withdrawal or
-- deletion-pending transition — only NEW processing is refused from that
-- moment forward (retention vs. new-processing, contract §4). Purging
-- existing rows is `gmail_reply_purge_for_deletion` alone, driven by an
-- explicit deletion request, exactly like B05's `gmail_outreach_purge_for_
-- deletion`.

-- ===========================================================================
-- 7. RPC SURFACE
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 7a. WHICH THREADS NEED (RE)EVALUATION
-- ---------------------------------------------------------------------------
-- Cheap, per-thread digest/version comparison — never timestamp ordering
-- (contract §13/§19, mirroring B05's own Amendment #4 lesson exactly). A
-- thread that is currently `not_eligible` is never offered.
create or replace function public.gmail_reply_list_candidates(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_relation_version text,
  p_classification_version text,
  p_text_transform_version text,
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
  if p_relation_version !~ '^[a-z][a-z0-9_]{0,63}$'
     or p_classification_version !~ '^[a-z][a-z0-9_]{0,63}$'
     or p_text_transform_version !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'invalid relation/classification/text-transform version' using errcode = 'invalid_parameter_value';
  end if;

  if p_limit is null or p_limit < 1 or p_limit <> trunc(p_limit) then
    raise exception 'p_limit must be a positive integer, got %', p_limit
      using errcode = 'invalid_parameter_value';
  end if;

  v_may_process := private.gmail_outreach_may_process(p_mail_account_id);
  if v_may_process <> 'ok' then
    return jsonb_build_object('result', v_may_process, 'candidates', '[]'::jsonb);
  end if;

  select coalesce(jsonb_agg(row), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
               'normalized_thread_id', t.id,
               'provider_thread_id', t.provider_thread_id,
               'eligibility', private.gmail_reply_thread_eligibility(p_mail_account_id, t.id),
               'source_stale', (
                 sm.id is null or sm.evidence_digest is distinct from cur.evidence_digest
               ),
               'rules_stale', (
                 sm.id is null
                 or sm.relation_rule_version is distinct from p_relation_version
                 or sm.classification_rule_version is distinct from p_classification_version
                 or sm.text_transform_version is distinct from p_text_transform_version
               )
             ) as row
        from private.gmail_normalized_threads t
        left join private.gmail_reply_thread_summaries sm
          on sm.normalized_thread_id = t.id and sm.mail_account_id = t.mail_account_id
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
         and private.gmail_reply_thread_eligibility(p_mail_account_id, t.id) <> 'not_eligible'
         and (
           sm.id is null
           or sm.evidence_digest is distinct from cur.evidence_digest
           or sm.relation_rule_version is distinct from p_relation_version
           or sm.classification_rule_version is distinct from p_classification_version
           or sm.text_transform_version is distinct from p_text_transform_version
         )
       order by t.id asc
       limit p_limit
    ) candidates;

  return jsonb_build_object('result', 'ok', 'candidates', v_rows);
end;
$$;

revoke all on function public.gmail_reply_list_candidates(uuid, uuid, text, text, text, integer, uuid[]) from public;

-- ---------------------------------------------------------------------------
-- 7b. THREAD EVIDENCE FOR EVALUATION
-- ---------------------------------------------------------------------------
-- Everything TS needs to compute relation/classification for every message
-- in the thread: every message's identity/provider_sent/digest, every
-- Message-ID/In-Reply-To/References token (ALL messages, not just SENT —
-- relation evidence is symmetric), From/Sender/Reply-To participants of
-- EVERY message (external-participant evidence, contract §10.1), decoded
-- text of NON-SENT messages only (reply-text extraction has no use for a
-- creator's own SENT body), subjects of every message, the connected
-- mailbox's own routing address, current B05 eligibility, the proven
-- observation horizon, and the currently-stored B06 summary/observations (so
-- TS can decide the cheapest honest re-evaluation path).
create or replace function public.gmail_reply_get_thread_evidence(
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
  v_account_email text;
  v_eligibility text;
  v_observed_through_at timestamptz;
  v_messages jsonb;
  v_reference_tokens jsonb;
  v_participants jsonb;
  v_text_parts jsonb;
  v_subjects jsonb;
  v_current_digest text;
  v_current_summary jsonb;
  v_current_observations jsonb;
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

  select m.email_address into v_account_email from public.mail_accounts m where m.id = p_mail_account_id;

  v_eligibility := private.gmail_reply_thread_eligibility(p_mail_account_id, p_normalized_thread_id);
  v_observed_through_at := private.gmail_reply_observed_through_at(p_mail_account_id, v_thread.provider_thread_id);

  select coalesce(jsonb_agg(jsonb_build_object(
           'provider_message_id', m.provider_message_id,
           'provider_sent', m.provider_sent,
           'internal_date_ms', (extract(epoch from m.internal_date) * 1000)::bigint,
           'source_payload_sha256', m.source_payload_sha256
         ) order by m.internal_date asc, m.provider_message_id asc), '[]'::jsonb)
    into v_messages
    from private.gmail_normalized_messages m
   where m.normalized_thread_id = p_normalized_thread_id;

  select encode(
           digest(
             coalesce(
               string_agg(m.id::text || ':' || m.source_payload_sha256 || ':' || m.provider_sent::text, '|' order by m.id),
               ''
             ),
             'sha256'
           ),
           'hex'
         )
    into v_current_digest
    from private.gmail_normalized_messages m
   where m.normalized_thread_id = p_normalized_thread_id;

  -- Message-ID / In-Reply-To / References tokens for EVERY message.
  select coalesce(jsonb_agg(jsonb_build_object(
           'provider_message_id', m.provider_message_id,
           'header_role', rt.header_role,
           'token_order', rt.token_order,
           'raw_token', rt.raw_token,
           'parse_status', rt.parse_status
         ) order by m.provider_message_id, rt.header_role, rt.token_order), '[]'::jsonb)
    into v_reference_tokens
    from private.gmail_normalized_reference_tokens rt
    join private.gmail_normalized_messages m on m.id = rt.normalized_message_id
   where m.normalized_thread_id = p_normalized_thread_id;

  -- From/Sender/Reply-To participants for EVERY message (external-participant evidence).
  select coalesce(jsonb_agg(jsonb_build_object(
           'provider_message_id', m.provider_message_id,
           'role', p.header_role,
           'addr_spec', p.addr_spec,
           'domain_lower', p.domain_lower,
           'parse_status', p.parse_status
         ) order by m.provider_message_id, p.header_role, p.participant_order), '[]'::jsonb)
    into v_participants
    from private.gmail_normalized_participants p
    join private.gmail_normalized_messages m on m.id = p.normalized_message_id
   where m.normalized_thread_id = p_normalized_thread_id
     and p.header_role in ('from', 'sender', 'reply-to');

  -- Decoded text of NON-SENT messages only.
  select coalesce(jsonb_agg(jsonb_build_object(
           'provider_message_id', m.provider_message_id,
           'mime_type', tp.mime_type,
           'decode_status', tp.decode_status,
           'decoded_text', tp.decoded_text
         ) order by m.provider_message_id, tp.part_path), '[]'::jsonb)
    into v_text_parts
    from private.gmail_normalized_text_parts tp
    join private.gmail_normalized_messages m on m.id = tp.normalized_message_id
   where m.normalized_thread_id = p_normalized_thread_id
     and m.provider_sent = false;

  select coalesce(jsonb_agg(jsonb_build_object(
           'provider_message_id', m.provider_message_id,
           'raw_value', h.raw_value
         ) order by m.provider_message_id), '[]'::jsonb)
    into v_subjects
    from private.gmail_normalized_headers h
    join private.gmail_normalized_messages m on m.id = h.normalized_message_id
   where m.normalized_thread_id = p_normalized_thread_id
     and h.header_name = 'subject';

  select to_jsonb(sm) - 'id' - 'user_id' - 'mail_account_id' - 'normalized_thread_id'
    into v_current_summary
    from private.gmail_reply_thread_summaries sm
   where sm.mail_account_id = p_mail_account_id
     and sm.normalized_thread_id = p_normalized_thread_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'provider_message_id', o.provider_message_id,
           'response_class', o.response_class,
           'relation_status', o.relation_status,
           'is_current_source', o.current_normalized_message_id is not null
         ) order by o.provider_message_id), '[]'::jsonb)
    into v_current_observations
    from private.gmail_reply_message_observations o
   where o.mail_account_id = p_mail_account_id
     and o.normalized_thread_id = p_normalized_thread_id;

  return jsonb_build_object(
    'result', 'ok',
    'normalized_thread_id', v_thread.id,
    'provider_thread_id', v_thread.provider_thread_id,
    'mail_account_email', v_account_email,
    'eligibility', v_eligibility,
    'observed_through_at', v_observed_through_at,
    'messages', v_messages,
    'reference_tokens', v_reference_tokens,
    'participants', v_participants,
    'text_parts', v_text_parts,
    'subjects', v_subjects,
    'evidence_digest', v_current_digest,
    'current_summary', v_current_summary,
    'current_message_observations', v_current_observations
  );
end;
$$;

revoke all on function public.gmail_reply_get_thread_evidence(uuid, uuid, uuid) from public;

-- ---------------------------------------------------------------------------
-- 7c. COMMIT ONE THREAD'S REPLY-CHRONOLOGY INTERPRETATION — atomic, fenced
-- ---------------------------------------------------------------------------
-- TS has already computed, from the evidence above, one response_class/
-- relation_status/... row for every message in the thread and the resulting
-- thread summary. This function is the sole authority on whether that work
-- may become the current MACHINE projection, and it writes no HUMAN table
-- (there is none in B06 — B07 owns creator correction).
--
-- p_expected_evidence_digest is the fence, re-verified here under a `for key
-- share` lock on the thread's current normalized messages, exactly like
-- B05's `gmail_outreach_commit_interpretation`. Eligibility is ALSO
-- re-verified here, under the SAME transaction, so a concurrent B05 human
-- `outreach_rejected` decision racing this commit is caught rather than
-- silently written past.
create or replace function public.gmail_reply_commit_interpretation(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_normalized_thread_id uuid,
  p_relation_version text,
  p_classification_version text,
  p_text_transform_version text,
  p_expected_evidence_digest text,
  p_message_observations jsonb,
  p_thread_summary jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_may_process text;
  v_eligibility text;
  v_thread private.gmail_normalized_threads%rowtype;
  v_current_digest text;
  v_current_count integer;
  v_obs jsonb;
  v_normalized_message_id uuid;
  v_provider_message_id text;
begin
  if p_relation_version !~ '^[a-z][a-z0-9_]{0,63}$'
     or p_classification_version !~ '^[a-z][a-z0-9_]{0,63}$'
     or p_text_transform_version !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'invalid relation/classification/text-transform version' using errcode = 'invalid_parameter_value';
  end if;

  -- THE REAL LIFECYCLE + CONSENT FENCE — reused unmodified from 0039. See
  -- §6 above for why this reuse is provably generic.
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

  -- ELIGIBILITY, RE-VERIFIED UNDER THIS SAME TRANSACTION. A concurrent B05
  -- human `outreach_rejected` decision racing this commit must win — new
  -- B06 processing is refused, exactly like a concurrent consent withdrawal.
  v_eligibility := private.gmail_reply_thread_eligibility(p_mail_account_id, p_normalized_thread_id);
  if v_eligibility = 'not_eligible' then
    return jsonb_build_object('result', 'not_eligible');
  end if;

  -- THE SOURCE-EVIDENCE FENCE, identical shape to B05's own.
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

  -- MESSAGE OBSERVATIONS. Upsert on the STABLE identity
  -- (mail_account_id, provider_message_id) — never on this row's own id.
  for v_obs in select * from jsonb_array_elements(coalesce(p_message_observations, '[]'::jsonb))
  loop
    v_provider_message_id := v_obs ->> 'provider_message_id';

    select m.id into v_normalized_message_id
      from private.gmail_normalized_messages m
     where m.mail_account_id = p_mail_account_id
       and m.normalized_thread_id = p_normalized_thread_id
       and m.provider_message_id = v_provider_message_id;

    if not found then
      -- Evidence named a message no longer (or never) present in THIS
      -- thread under lock. Refuse the whole commit rather than write a
      -- partial, possibly evidence-mismatched result.
      return jsonb_build_object('result', 'stale_source', 'current_evidence_digest', v_current_digest);
    end if;

    insert into private.gmail_reply_message_observations (
      user_id, mail_account_id, normalized_thread_id, provider_message_id, internal_date,
      current_normalized_message_id, last_evaluated_source_payload_sha256,
      response_class, relation_status,
      referenced_creator_sent_provider_message_id, latest_preceding_creator_sent_provider_message_id,
      chronology_conflict, relation_rule_version, classification_rule_version, text_transform_version
    ) values (
      p_user_id, p_mail_account_id, p_normalized_thread_id, v_provider_message_id,
      to_timestamp((v_obs ->> 'internal_date_ms')::numeric / 1000.0),
      v_normalized_message_id, v_obs ->> 'source_payload_sha256',
      v_obs ->> 'response_class', v_obs ->> 'relation_status',
      v_obs ->> 'referenced_creator_sent_provider_message_id',
      v_obs ->> 'latest_preceding_creator_sent_provider_message_id',
      coalesce((v_obs ->> 'chronology_conflict')::boolean, false),
      p_relation_version, p_classification_version,
      case when v_obs ->> 'response_class' = 'creator_sent_touch' then null else p_text_transform_version end
    )
    on conflict (mail_account_id, provider_message_id) do update
      set normalized_thread_id = excluded.normalized_thread_id,
          internal_date = excluded.internal_date,
          current_normalized_message_id = excluded.current_normalized_message_id,
          last_evaluated_source_payload_sha256 = excluded.last_evaluated_source_payload_sha256,
          response_class = excluded.response_class,
          relation_status = excluded.relation_status,
          referenced_creator_sent_provider_message_id = excluded.referenced_creator_sent_provider_message_id,
          latest_preceding_creator_sent_provider_message_id = excluded.latest_preceding_creator_sent_provider_message_id,
          chronology_conflict = excluded.chronology_conflict,
          relation_rule_version = excluded.relation_rule_version,
          classification_rule_version = excluded.classification_rule_version,
          text_transform_version = excluded.text_transform_version,
          evaluated_at = now();
  end loop;

  -- THREAD SUMMARY. One current row per thread, replaced wholesale — the
  -- exact same replace-atomically shape as B05's thread_signals.
  insert into private.gmail_reply_thread_summaries (
    user_id, mail_account_id, normalized_thread_id, eligibility, observation_state,
    first_creator_sent_provider_message_id, first_creator_sent_at,
    first_qualifying_human_reply_provider_message_id, first_qualifying_human_reply_at,
    creator_sent_count_before_first_human_reply, latest_creator_sent_before_reply_provider_message_id,
    latency_from_first_creator_sent_ms, latency_from_latest_creator_sent_ms, reply_chronology_conflict,
    observed_through_at, evidence_digest, evidence_message_count,
    relation_rule_version, classification_rule_version, text_transform_version
  ) values (
    p_user_id, p_mail_account_id, p_normalized_thread_id, v_eligibility,
    p_thread_summary ->> 'observation_state',
    p_thread_summary ->> 'first_creator_sent_provider_message_id',
    case when p_thread_summary ->> 'first_creator_sent_at_ms' is not null
      then to_timestamp((p_thread_summary ->> 'first_creator_sent_at_ms')::numeric / 1000.0) end,
    p_thread_summary ->> 'first_qualifying_human_reply_provider_message_id',
    case when p_thread_summary ->> 'first_qualifying_human_reply_at_ms' is not null
      then to_timestamp((p_thread_summary ->> 'first_qualifying_human_reply_at_ms')::numeric / 1000.0) end,
    (p_thread_summary ->> 'creator_sent_count_before_first_human_reply')::integer,
    p_thread_summary ->> 'latest_creator_sent_before_reply_provider_message_id',
    (p_thread_summary ->> 'latency_from_first_creator_sent_ms')::bigint,
    (p_thread_summary ->> 'latency_from_latest_creator_sent_ms')::bigint,
    coalesce((p_thread_summary ->> 'reply_chronology_conflict')::boolean, false),
    case when p_thread_summary ->> 'observed_through_at_ms' is not null
      then to_timestamp((p_thread_summary ->> 'observed_through_at_ms')::numeric / 1000.0) end,
    v_current_digest, v_current_count,
    p_relation_version, p_classification_version, p_text_transform_version
  )
  on conflict (mail_account_id, normalized_thread_id) do update
    set eligibility = excluded.eligibility,
        observation_state = excluded.observation_state,
        first_creator_sent_provider_message_id = excluded.first_creator_sent_provider_message_id,
        first_creator_sent_at = excluded.first_creator_sent_at,
        first_qualifying_human_reply_provider_message_id = excluded.first_qualifying_human_reply_provider_message_id,
        first_qualifying_human_reply_at = excluded.first_qualifying_human_reply_at,
        creator_sent_count_before_first_human_reply = excluded.creator_sent_count_before_first_human_reply,
        latest_creator_sent_before_reply_provider_message_id = excluded.latest_creator_sent_before_reply_provider_message_id,
        latency_from_first_creator_sent_ms = excluded.latency_from_first_creator_sent_ms,
        latency_from_latest_creator_sent_ms = excluded.latency_from_latest_creator_sent_ms,
        reply_chronology_conflict = excluded.reply_chronology_conflict,
        observed_through_at = excluded.observed_through_at,
        evidence_digest = excluded.evidence_digest,
        evidence_message_count = excluded.evidence_message_count,
        relation_rule_version = excluded.relation_rule_version,
        classification_rule_version = excluded.classification_rule_version,
        text_transform_version = excluded.text_transform_version,
        evaluated_at = now();

  return jsonb_build_object('result', 'ok', 'evidence_digest', v_current_digest);
end;
$$;

revoke all on function public.gmail_reply_commit_interpretation(
  uuid, uuid, uuid, text, text, text, text, jsonb, jsonb
) from public;

-- ---------------------------------------------------------------------------
-- 7d. STATUS COUNTS (operator/CLI visibility, no content)
-- ---------------------------------------------------------------------------
create or replace function public.gmail_reply_status(
  p_user_id uuid,
  p_mail_account_id uuid
)
returns jsonb
language sql
security definer
set search_path = public, private, pg_temp
stable
as $$
  select jsonb_build_object(
    'result', 'ok',
    'message_observations', (
      select count(*) from private.gmail_reply_message_observations
       where user_id = p_user_id and mail_account_id = p_mail_account_id
    ),
    'thread_summaries', (
      select count(*) from private.gmail_reply_thread_summaries
       where user_id = p_user_id and mail_account_id = p_mail_account_id
    ),
    'qualifying_human_reply_observed', (
      select count(*) from private.gmail_reply_thread_summaries
       where user_id = p_user_id and mail_account_id = p_mail_account_id
         and observation_state = 'qualifying_human_reply_observed'
    ),
    'ambiguous_response_observed', (
      select count(*) from private.gmail_reply_thread_summaries
       where user_id = p_user_id and mail_account_id = p_mail_account_id
         and observation_state = 'ambiguous_response_observed'
    ),
    'only_automated_or_delivery_observed', (
      select count(*) from private.gmail_reply_thread_summaries
       where user_id = p_user_id and mail_account_id = p_mail_account_id
         and observation_state = 'only_automated_or_delivery_observed'
    ),
    'no_qualifying_response_observed_in_window', (
      select count(*) from private.gmail_reply_thread_summaries
       where user_id = p_user_id and mail_account_id = p_mail_account_id
         and observation_state = 'no_qualifying_response_observed_in_window'
    ),
    'observation_horizon_unknown', (
      select count(*) from private.gmail_reply_thread_summaries
       where user_id = p_user_id and mail_account_id = p_mail_account_id
         and observation_state = 'observation_horizon_unknown'
    )
  );
$$;

revoke all on function public.gmail_reply_status(uuid, uuid) from public;

-- ---------------------------------------------------------------------------
-- 7e. DELETION PURGE (explicit deletion request only)
-- ---------------------------------------------------------------------------
create or replace function public.gmail_reply_purge_for_deletion(
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
  v_observations integer;
  v_summaries integer;
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

  with removed as (
    delete from private.gmail_reply_message_observations where mail_account_id = p_mail_account_id returning 1
  ) select count(*)::int into v_observations from removed;

  with removed as (
    delete from private.gmail_reply_thread_summaries where mail_account_id = p_mail_account_id returning 1
  ) select count(*)::int into v_summaries from removed;

  return jsonb_build_object(
    'result', 'ok',
    'message_observations_removed', v_observations,
    'thread_summaries_removed', v_summaries
  );
end;
$$;

revoke all on function public.gmail_reply_purge_for_deletion(uuid, uuid, uuid) from public;

-- ===========================================================================
-- 8. EXECUTE PRIVILEGES
-- ===========================================================================
-- Every B06 RPC is MACHINE/OBSERVED only (contract §14) — service_role only,
-- never authenticated, never anon. There is no creator-decision RPC in this
-- round: B07 owns creator correction.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.gmail_reply_list_candidates(uuid,uuid,text,text,text,integer,uuid[])',
    'public.gmail_reply_get_thread_evidence(uuid,uuid,uuid)',
    'public.gmail_reply_commit_interpretation(uuid,uuid,uuid,text,text,text,text,jsonb,jsonb)',
    'public.gmail_reply_status(uuid,uuid)',
    'public.gmail_reply_purge_for_deletion(uuid,uuid,uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- ===========================================================================
-- 9. WHAT 0040 DOES NOT CREATE
-- ===========================================================================
-- No positive/negative, interest, rejection, negotiation, rate/barter/
--   hosted/paid/hybrid, won/lost/ghosted or sentiment classification — B07.
-- No creator-correction table of any kind — B07 owns it; B06 leaves only a
--   stable message-observation anchor.
-- No incremental sync/watch state — B08.
-- No network-intelligence (G3) row, aggregate or eligibility flag.
-- No write to public.pipeline_items, public.outreach_events or
--   public.collaborations, anywhere in this migration.
-- No canonical hotel, organization, brand or contact row is ever created or
--   mutated by anything above.
-- No widening of B03's retained-header allow-list, and no inference of
--   humanity from the absence of a header B03 never stored.
