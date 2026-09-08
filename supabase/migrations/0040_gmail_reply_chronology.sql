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
  -- §10) for a qualifying human reply. THIS COLUMN AND THE NEXT ARE
  -- DB-DERIVED (closure pass finding, §14/§15/§17): computed by
  -- `gmail_reply_commit_interpretation` directly from the locked, current
  -- creator-sent internal_date values for this thread — never trusted from
  -- caller JSON. Null when there is no preceding creator send, OR when two or
  -- more creator sends TIE for the latest preceding position (closure pass
  -- §17 — a tie means the TIMESTAMP is known but the SINGULAR identity is
  -- not; `latest_preceding_creator_sent_at` still carries the known
  -- timestamp in that case).
  latest_preceding_creator_sent_provider_message_id text,
  latest_preceding_creator_sent_at timestamptz,

  -- `internal_date` said this response preceded its own referenced creator
  -- send. The relation is preserved; timing is not trusted (contract §10 —
  -- "Timestamp conflicts"). DB-DERIVED (closure pass finding, §14): computed
  -- from the locked referenced creator send's own `internal_date`, never
  -- trusted from caller JSON.
  chronology_conflict boolean not null default false,

  relation_rule_version text not null check (relation_rule_version ~ '^[a-z][a-z0-9_]{0,63}$'),
  classification_rule_version text not null check (classification_rule_version ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- Null for `creator_sent_touch`: no reply-text extraction applies to a
  -- creator's own send.
  -- Closure pass §20: this version string HONESTLY embeds the upstream B05
  -- text-transform version it depends on (`gmail_reply_text_transform_v1+
  -- gmail_outreach_text_v4`, computed in TS from B05's own exported
  -- constant) — a wider shape than the other two rule-version columns so a
  -- future B05 text-transform bump changes this string and therefore
  -- participates in staleness (contract §19) automatically.
  text_transform_version text check (text_transform_version ~ '^[a-z][a-z0-9_.+]{0,127}$'),

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
      and latest_preceding_creator_sent_at is null
      and chronology_conflict = false
      and text_transform_version is null)
    or
    (response_class <> 'creator_sent_touch'
      and relation_status is not null
      and text_transform_version is not null)
  ),

  -- Closure pass §15: a referenced id is present IFF relation_status is
  -- direct/references — the ORIGINAL one-directional check let a
  -- `direct_in_reply_to`/`references_chain` claim through with no
  -- referenced id at all, which the contract's own schema treats as
  -- incoherent (those two statuses exist ONLY to carry a resolved id).
  constraint gmail_reply_message_observations_referenced_shape check (
    (referenced_creator_sent_provider_message_id is not null)
    = (relation_status in ('direct_in_reply_to', 'references_chain'))
  ),

  -- Closure pass §17: a known timestamp with an ambiguous (tied) singular
  -- identity is `latest_preceding_creator_sent_at is not null and
  -- latest_preceding_creator_sent_provider_message_id is null` — never the
  -- reverse (an id can never be stored without its own timestamp).
  constraint gmail_reply_message_observations_latest_preceding_shape check (
    latest_preceding_creator_sent_provider_message_id is null
    or latest_preceding_creator_sent_at is not null
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

  -- Closure pass §17 (equal-time/tie semantics): a `_tied` flag true means
  -- two or more messages shared the deciding timestamp — the TIMESTAMP
  -- column stays populated (still knowable and reported) but the paired
  -- provider-message-id column is NULL (the SINGULAR identity is not safely
  -- knowable). A tie is never resolved by falling back to lexical/reading
  -- order — D071/contract §10 explicitly forbids treating deterministic
  -- ordering as proof of causal order.
  first_creator_sent_provider_message_id text,
  first_creator_sent_at timestamptz,
  first_creator_sent_tied boolean not null default false,
  first_qualifying_human_reply_provider_message_id text,
  first_qualifying_human_reply_at timestamptz,
  first_qualifying_human_reply_tied boolean not null default false,
  creator_sent_count_before_first_human_reply integer check (creator_sent_count_before_first_human_reply >= 0),
  latest_creator_sent_before_reply_provider_message_id text,
  latest_creator_sent_before_reply_tied boolean not null default false,

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

  -- FINAL CLOSURE, BLOCKER A: the mailbox's own routing address is a
  -- classification DEPENDENCY (contract §8.1's external-participant
  -- requirement reads it directly) that lives on `mail_accounts`, entirely
  -- outside the B04 message-evidence digest. `private.gmail_reply_routing_
  -- context_digest` normalizes it (lowercased/trimmed, or an explicit null
  -- sentinel) to a sha256 fingerprint — the SAME shape as `evidence_digest`
  -- — so a routing-address change participates in staleness/currentness
  -- exactly like a source-evidence change, never silently forgotten.
  routing_context_digest text not null check (routing_context_digest ~ '^[0-9a-f]{64}$'),

  relation_rule_version text not null check (relation_rule_version ~ '^[a-z][a-z0-9_]{0,63}$'),
  classification_rule_version text not null check (classification_rule_version ~ '^[a-z][a-z0-9_]{0,63}$'),
  -- Closure pass §20: see the identical-shape comment on
  -- gmail_reply_message_observations.text_transform_version above.
  text_transform_version text not null check (text_transform_version ~ '^[a-z][a-z0-9_.+]{0,127}$'),

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

  -- A qualifying reply was observed iff its timestamp is populated; the
  -- provider-message-id is populated XOR the tie flag is set (closure pass
  -- §17 — known timestamp, possibly-ambiguous identity).
  constraint gmail_reply_thread_summaries_reply_shape check (
    (observation_state = 'qualifying_human_reply_observed') = (first_qualifying_human_reply_at is not null)
    and (
      observation_state <> 'qualifying_human_reply_observed'
      or ((first_qualifying_human_reply_provider_message_id is not null) <> first_qualifying_human_reply_tied)
    )
    and (observation_state = 'qualifying_human_reply_observed' or not first_qualifying_human_reply_tied)
  ),

  -- A creator send exists (at all, regardless of observation_state) iff its
  -- timestamp is populated; same known-timestamp/ambiguous-identity shape.
  constraint gmail_reply_thread_summaries_creator_sent_shape check (
    (first_creator_sent_at is null and first_creator_sent_provider_message_id is null and not first_creator_sent_tied)
    or (first_creator_sent_at is not null
        and ((first_creator_sent_provider_message_id is not null) <> first_creator_sent_tied))
  ),

  -- The latest-preceding-creator-send tie flag only ever applies alongside an
  -- observed qualifying reply, and only ever nulls the id (the CLOCK B
  -- latency itself, derived from the known tied timestamp, is untouched —
  -- closure pass §17: "do not destroy a valid timestamp latency merely
  -- because singular message identity is ambiguous").
  constraint gmail_reply_thread_summaries_latest_before_reply_shape check (
    not latest_creator_sent_before_reply_tied
    or (observation_state = 'qualifying_human_reply_observed'
        and latest_creator_sent_before_reply_provider_message_id is null)
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
-- 4b. ROUTING-CONTEXT FINGERPRINT (FINAL CLOSURE, BLOCKER A)
-- ===========================================================================
-- `mail_accounts.email_address` is a classification DEPENDENCY read directly
-- by the external-participant test (contract §8.1) — entirely independent of
-- the B04 message-evidence digest, and therefore capable of changing between
-- evidence-read and commit with ZERO change to that digest. Normalizes to
-- the SAME sha256-hex shape as `evidence_digest` so the two fences compose
-- identically everywhere they are compared. An explicit, distinct sentinel
-- byte for NULL email ensures "no routing address" can never collide with
-- any real (however short) normalized address string.
create or replace function private.gmail_reply_routing_context_digest(
  p_mail_account_id uuid
)
returns text
language sql
stable
as $$
  select encode(
           digest(
             coalesce(lower(btrim(m.email_address)), E'\\x00_no_routing_email'),
             'sha256'
           ),
           'hex'
         )
    from public.mail_accounts m
   where m.id = p_mail_account_id;
$$;

revoke all on function private.gmail_reply_routing_context_digest(uuid) from public;

-- ===========================================================================
-- 4c. THE ONE DEFINITION OF "IS THIS STORED SUMMARY CURRENT" (FINAL CLOSURE,
-- BLOCKER C)
-- ===========================================================================
-- Every dependency B06's semantic output can possibly depend on, compared in
-- ONE place: B04 source evidence, B03 observation horizon, B05 eligibility,
-- the routing-context fingerprint (§4b), and all three rule/shared-transform
-- versions. `gmail_reply_list_candidates`, `gmail_reply_get_thread_evidence`
-- and `gmail_reply_status` all call THIS function rather than each keeping
-- its own copy of the staleness formula — the exact defect the final
-- external audit found (three independently-written formulas that could
-- silently drift apart). A thread with NO stored summary at all is,
-- trivially, stale (a candidate for first evaluation).
create or replace function private.gmail_reply_thread_summary_is_stale(
  p_mail_account_id uuid,
  p_normalized_thread_id uuid,
  p_relation_version text,
  p_classification_version text,
  p_text_transform_version text
)
returns boolean
language sql
stable
as $$
  select coalesce(
    (
      select
        sm.evidence_digest is distinct from cur.evidence_digest
        or sm.observed_through_at is distinct from
           private.gmail_reply_observed_through_at(p_mail_account_id, t.provider_thread_id)
        or sm.eligibility is distinct from
           private.gmail_reply_thread_eligibility(p_mail_account_id, p_normalized_thread_id)
        or sm.routing_context_digest is distinct from
           private.gmail_reply_routing_context_digest(p_mail_account_id)
        or sm.relation_rule_version is distinct from p_relation_version
        or sm.classification_rule_version is distinct from p_classification_version
        or sm.text_transform_version is distinct from p_text_transform_version
      from private.gmail_reply_thread_summaries sm
      join private.gmail_normalized_threads t
        on t.id = sm.normalized_thread_id and t.mail_account_id = sm.mail_account_id
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
         where m.normalized_thread_id = sm.normalized_thread_id
      ) cur on true
      where sm.mail_account_id = p_mail_account_id
        and sm.normalized_thread_id = p_normalized_thread_id
    ),
    true
  );
$$;

revoke all on function private.gmail_reply_thread_summary_is_stale(uuid, uuid, text, text, text) from public;

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
     or p_text_transform_version !~ '^[a-z][a-z0-9_.+]{0,127}$' then
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

  -- FINAL CLOSURE, BLOCKER C: the WHERE-clause offer decision below calls
  -- the SAME `private.gmail_reply_thread_summary_is_stale` that
  -- `gmail_reply_get_thread_evidence` and `gmail_reply_status` call — one
  -- definition of "current", never three independently-written formulas
  -- that could drift apart. The per-dimension flags in the payload
  -- (`source_stale`/`rules_stale`/`horizon_stale`/`routing_stale`) remain
  -- informational breakdowns of that SAME underlying comparison, computed
  -- inline here only because a caller may find the breakdown useful; the
  -- OFFER decision itself never re-derives its own copy of the formula.
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
               ),
               'horizon_stale', (
                 sm.id is null
                 or sm.observed_through_at is distinct from
                    private.gmail_reply_observed_through_at(p_mail_account_id, t.provider_thread_id)
               ),
               'routing_stale', (
                 sm.id is null
                 or sm.routing_context_digest is distinct from
                    private.gmail_reply_routing_context_digest(p_mail_account_id)
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
         and private.gmail_reply_thread_summary_is_stale(
               p_mail_account_id, t.id, p_relation_version, p_classification_version, p_text_transform_version
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
  p_normalized_thread_id uuid,
  -- FINAL CLOSURE, BLOCKER C: the caller already knows the B06 semantic
  -- versions actually running now — currentness must be judged against
  -- those, not against whatever an already-stored row happens to remember.
  -- Required (no default): a caller that omits them gets a clear argument
  -- error, never a silently-wrong "always current" answer.
  p_relation_version text,
  p_classification_version text,
  p_text_transform_version text
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
  v_routing_context_digest text;
  v_messages jsonb;
  v_reference_tokens jsonb;
  v_participants jsonb;
  v_text_parts jsonb;
  v_subjects jsonb;
  v_current_digest text;
  v_current_summary jsonb;
  v_current_summary_is_stale boolean;
  v_current_observations jsonb;
begin
  if p_relation_version !~ '^[a-z][a-z0-9_]{0,63}$'
     or p_classification_version !~ '^[a-z][a-z0-9_]{0,63}$'
     or p_text_transform_version !~ '^[a-z][a-z0-9_.+]{0,127}$' then
    raise exception 'invalid relation/classification/text-transform version' using errcode = 'invalid_parameter_value';
  end if;

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
  v_routing_context_digest := private.gmail_reply_routing_context_digest(p_mail_account_id);

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

  -- CLOSURE PASS §18/§19, FINAL CLOSURE BLOCKER C: `current_summary_is_stale`
  -- distinguishes a RETAINED summary from a CURRENTLY-VALID one, using the
  -- SAME `private.gmail_reply_thread_summary_is_stale` that
  -- `gmail_reply_list_candidates`/`gmail_reply_status` call — never an
  -- independent, potentially-drifting copy of the formula. A caller must
  -- never present a stale summary as describing the CURRENT state.
  select to_jsonb(sm) - 'id' - 'user_id' - 'mail_account_id' - 'normalized_thread_id'
    into v_current_summary
    from private.gmail_reply_thread_summaries sm
   where sm.mail_account_id = p_mail_account_id
     and sm.normalized_thread_id = p_normalized_thread_id;

  v_current_summary_is_stale := private.gmail_reply_thread_summary_is_stale(
    p_mail_account_id, p_normalized_thread_id,
    p_relation_version, p_classification_version, p_text_transform_version
  );

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
    'routing_context_digest', v_routing_context_digest,
    'current_summary', v_current_summary,
    'current_summary_is_stale', coalesce(v_current_summary_is_stale, false),
    'current_message_observations', v_current_observations
  );
end;
$$;

revoke all on function public.gmail_reply_get_thread_evidence(uuid, uuid, uuid, text, text, text) from public;

-- ---------------------------------------------------------------------------
-- 7c. COMMIT ONE THREAD'S REPLY-CHRONOLOGY INTERPRETATION — atomic, fenced
-- ---------------------------------------------------------------------------
-- CLOSURE PASS REWRITE. TS supplies only SEMANTIC interpretation it alone can
-- derive (`response_class` for non-SENT messages, `relation_status`, which
-- creator-sent message a direct/references relationship points at). Every
-- LITERAL source fact — `internal_date`, `source_payload_sha256`,
-- `provider_sent`, current normalized-message identity, thread/account
-- membership — is looked up HERE from the locked, current row, never trusted
-- from caller JSON (closure pass §14). `latest_preceding_creator_sent_*` and
-- `chronology_conflict` are likewise DB-DERIVED from the same locked rows
-- (closure pass §15/§17) — a pure function of already-validated timestamps,
-- so there is nothing left for a caller to lie about. The thread summary
-- (first creator send, first qualifying reply, counts, both clocks) is
-- DERIVED ENTIRELY HERE from the just-written, just-validated observation
-- rows (closure pass §16) — there is no `p_thread_summary` parameter any
-- more; a caller cannot invent arithmetic this function does not itself
-- recompute.
--
-- VALIDATE EVERYTHING, THEN WRITE EVERYTHING (closure pass §12): every
-- refusal below — `stale_source` (staleness, an ordinary expected outcome)
-- and a raised exception (a caller-side data-shape violation that can never
-- legitimately occur once the evidence digest has matched, per the analysis
-- in each check's own comment) — happens strictly BEFORE the two INSERT
-- statements. Each INSERT is a SINGLE atomic set-based statement over every
-- message in the thread at once (never a per-message loop with an early
-- RETURN partway through), so either the whole thread's interpretation
-- becomes current or nothing does.
--
-- CLOSURE PASS §6/§13: the `for update` lock below is the REAL transactional
-- fence closing the "concurrent B05 human rejection / machine eligibility
-- change races this commit" gap a plain re-SELECT cannot close — a
-- check-then-act gap remains a gap no matter how fresh the check, unless
-- something forces genuine serialization against every other writer that
-- could flip the answer. `private.gmail_outreach_assert_may_process_locked`
-- (reused, unmodified from 0039) takes `for share` on `public.mail_accounts`
-- as its OWN last step; every OTHER B05/B06 writer that touches this thread
-- reaches that exact same call (`gmail_outreach_record_creator_decision`,
-- `gmail_outreach_commit_interpretation`, and this function). Upgrading THIS
-- call's hold on that row to `for update` — in the SAME relative position in
-- the lock order (consent, then mail_accounts) every caller already uses, so
-- it introduces no new deadlock against B01's consent-withdrawal/deletion-
-- start writers — forces total serialization against every one of them:
-- whichever transaction reaches this point first fully completes (commits or
-- rolls back) before any other proceeds, so a decision that "wins" before
-- this commit's write is always visible to the immediately-following fresh
-- eligibility re-check, and a decision that lands after this commit's own
-- completion correctly governs only the NEXT commit. Two concurrent B06
-- commits on the SAME mail account (both already holding `for share` via
-- their own `assert_may_process_locked` call, both then requesting `for
-- update`) is the one live self-deadlock this creates; Postgres detects it
-- (error `40P01`) and aborts one — the caller (`commitInterpretation` in
-- service.ts) treats that exactly like `stale_source` and retries the whole
-- read-compute-commit cycle, the same shape B05's own CAS retry already
-- uses.
create or replace function public.gmail_reply_commit_interpretation(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_normalized_thread_id uuid,
  p_relation_version text,
  p_classification_version text,
  p_text_transform_version text,
  p_expected_evidence_digest text,
  -- FINAL CLOSURE, BLOCKER A: the routing-context fingerprint TS evaluated
  -- at read time — re-verified against the CURRENT, locked value below.
  p_expected_routing_context_digest text,
  p_message_observations jsonb
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
  v_current_routing_context_digest text;
  v_current_account_email text;
  v_observed_through_at timestamptz;
  v_payload_count integer;
  v_payload_distinct_count integer;
  v_set_mismatch boolean;
  v_shape_mismatch boolean;
  v_bad_reference boolean;
  v_already_current boolean;
begin
  if p_relation_version !~ '^[a-z][a-z0-9_]{0,63}$'
     or p_classification_version !~ '^[a-z][a-z0-9_]{0,63}$'
     or p_text_transform_version !~ '^[a-z][a-z0-9_.+]{0,127}$' then
    raise exception 'invalid relation/classification/text-transform version' using errcode = 'invalid_parameter_value';
  end if;

  -- THE REAL LIFECYCLE + CONSENT FENCE — reused unmodified from 0039. See
  -- §6 above for why this reuse is provably generic.
  v_may_process := private.gmail_outreach_assert_may_process_locked(p_mail_account_id);
  if v_may_process <> 'ok' then
    return jsonb_build_object('result', v_may_process);
  end if;

  -- THE ELIGIBILITY-RACE FENCE. See this function's own header comment for
  -- the full deadlock-safety argument. Must come immediately after the call
  -- above (same relative lock order: consent, then mail_accounts) and
  -- strictly before the eligibility re-check below. Reading `email_address`
  -- from THIS locked row (rather than a separate, later, unlocked SELECT)
  -- is what makes the routing-context comparison below a real fence, not
  -- merely a fresh-looking read (FINAL CLOSURE, BLOCKER A).
  select email_address into v_current_account_email
    from public.mail_accounts where id = p_mail_account_id for update;

  select t.* into v_thread
    from private.gmail_normalized_threads t
   where t.id = p_normalized_thread_id and t.mail_account_id = p_mail_account_id;

  if not found then
    return jsonb_build_object('result', 'thread_not_found');
  end if;

  -- ELIGIBILITY, RE-VERIFIED UNDER THE EXCLUSIVE LOCK ABOVE. A concurrent B05
  -- human `outreach_rejected` decision, or a concurrent machine eligibility
  -- change with no human override, that reaches `for update` on
  -- `mail_accounts` before this statement is now GUARANTEED visible here —
  -- not merely likely, per the header comment's serialization argument.
  v_eligibility := private.gmail_reply_thread_eligibility(p_mail_account_id, p_normalized_thread_id);
  if v_eligibility = 'not_eligible' then
    return jsonb_build_object('result', 'not_eligible');
  end if;

  -- FINAL CLOSURE, BLOCKER A: the routing-context fingerprint, computed from
  -- the SAME locked row read above — never a second, separate, unlocked
  -- SELECT that could observe a DIFFERENT value than what was actually
  -- serialized against concurrent writers.
  v_current_routing_context_digest := encode(
    digest(coalesce(lower(btrim(v_current_account_email)), E'\\x00_no_routing_email'), 'sha256'),
    'hex'
  );
  if v_current_routing_context_digest is distinct from p_expected_routing_context_digest then
    return jsonb_build_object('result', 'stale_source', 'current_evidence_digest', null);
  end if;

  v_observed_through_at := private.gmail_reply_observed_through_at(p_mail_account_id, v_thread.provider_thread_id);

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

  -- FINAL CLOSURE, BLOCKER B: EXACT, ZERO-WRITE REPLAY. Every dependency
  -- this commit's derivation could possibly depend on — source, routing
  -- context, horizon, eligibility, all three rule/shared-transform versions
  -- — is ALREADY computed above, under the SAME locks/fences that protect
  -- an ordinary write. If a stored summary already reflects this EXACT
  -- tuple, the derivation below is PROVABLY byte-identical to what is
  -- already current (both are the same pure function of the same inputs) —
  -- writing it again would only move `evaluated_at`/`updated_at` for no
  -- semantic reason. Nothing is written; not even the observation rows.
  select true into v_already_current
    from private.gmail_reply_thread_summaries sm
   where sm.mail_account_id = p_mail_account_id
     and sm.normalized_thread_id = p_normalized_thread_id
     and sm.evidence_digest = v_current_digest
     and sm.routing_context_digest = v_current_routing_context_digest
     and sm.observed_through_at is not distinct from v_observed_through_at
     and sm.eligibility = v_eligibility
     and sm.relation_rule_version = p_relation_version
     and sm.classification_rule_version = p_classification_version
     and sm.text_transform_version = p_text_transform_version;

  if v_already_current then
    return jsonb_build_object(
      'result', 'already_current', 'evidence_digest', v_current_digest, 'committed', false
    );
  end if;

  -- CLOSURE PASS §13: EXACT SET EQUALITY. `locked` below re-issues the SAME
  -- `for key share` request the digest computation above already made —
  -- idempotent within one transaction, not a second lock acquisition. No
  -- missing message, no duplicate payload entry, no foreign/extra provider
  -- id may become — or silently fail to become — part of the current
  -- projection.
  with locked as (
    select m.provider_message_id
      from private.gmail_normalized_messages m
     where m.normalized_thread_id = p_normalized_thread_id
     for key share
  ),
  payload as (
    select elem ->> 'provider_message_id' as provider_message_id
      from jsonb_array_elements(coalesce(p_message_observations, '[]'::jsonb)) as elem
  )
  select
    count(*)::int,
    count(distinct provider_message_id)::int,
    exists (select 1 from locked l where not exists (select 1 from payload p where p.provider_message_id = l.provider_message_id))
    or exists (select 1 from payload p where not exists (select 1 from locked l where l.provider_message_id = p.provider_message_id))
    into v_payload_count, v_payload_distinct_count, v_set_mismatch
    from payload;

  if v_payload_count <> v_payload_distinct_count or v_set_mismatch then
    -- A duplicate payload entry, a missing current message, or a foreign/
    -- extra provider id: refuse the whole commit rather than write a
    -- partial, possibly evidence-mismatched result.
    return jsonb_build_object('result', 'stale_source', 'current_evidence_digest', v_current_digest);
  end if;

  -- CLOSURE PASS §14: `actual provider_sent = true IFF response_class =
  -- 'creator_sent_touch'`. Once the digest above has matched, `locked`'s
  -- `provider_sent` is PROVABLY identical to what TS read to decide
  -- `response_class` — so a mismatch here can only be a caller-side logic
  -- defect, never a legitimate race outcome, and is a loud failure, not a
  -- silent coercion or a soft refusal.
  with locked as (
    select m.provider_message_id, m.provider_sent
      from private.gmail_normalized_messages m
     where m.normalized_thread_id = p_normalized_thread_id
     for key share
  )
  select exists (
    select 1
      from jsonb_array_elements(coalesce(p_message_observations, '[]'::jsonb)) as elem
      join locked l on l.provider_message_id = elem ->> 'provider_message_id'
     where (l.provider_sent and elem ->> 'response_class' <> 'creator_sent_touch')
        or (not l.provider_sent and elem ->> 'response_class' = 'creator_sent_touch')
  ) into v_shape_mismatch;

  if v_shape_mismatch then
    raise exception 'response_class does not match the actual provider_sent state for one or more messages'
      using errcode = 'invalid_parameter_value';
  end if;

  -- CLOSURE PASS §15: any supplied `referenced_creator_sent_provider_message_id`
  -- must exist in the current locked set for THIS mail account/thread and be
  -- an actual creator-sent message. (A referenced send's TIMESTAMP being at
  -- or after the candidate's own is NOT rejected here — that is exactly
  -- `chronology_conflict`, contract §10's preserved, expected case, derived
  -- below.)
  with locked as (
    select m.provider_message_id, m.provider_sent
      from private.gmail_normalized_messages m
     where m.normalized_thread_id = p_normalized_thread_id
     for key share
  )
  select exists (
    select 1
      from jsonb_array_elements(coalesce(p_message_observations, '[]'::jsonb)) as elem
     where elem ->> 'referenced_creator_sent_provider_message_id' is not null
       and not exists (
         select 1 from locked l
          where l.provider_message_id = elem ->> 'referenced_creator_sent_provider_message_id'
            and l.provider_sent
       )
  ) into v_bad_reference;

  if v_bad_reference then
    raise exception 'referenced_creator_sent_provider_message_id does not resolve to a current creator-sent message in this thread'
      using errcode = 'invalid_parameter_value';
  end if;

  -- EVERYTHING VALIDATED. FROM HERE ON, ONLY WRITES — nothing above this
  -- point has mutated any B06 row.

  -- MESSAGE OBSERVATIONS: one atomic set-based upsert on the STABLE identity
  -- (mail_account_id, provider_message_id) — never on this row's own id.
  -- `latest_preceding_creator_sent_*` and `chronology_conflict` are DERIVED
  -- here, from the locked rows' own `internal_date`/`provider_sent` — never
  -- taken from caller JSON (closure pass §14/§15/§17).
  with locked as (
    select m.id as normalized_message_id, m.provider_message_id, m.source_payload_sha256,
           m.provider_sent, m.internal_date
      from private.gmail_normalized_messages m
     where m.normalized_thread_id = p_normalized_thread_id
     for key share
  ),
  payload as (
    select elem ->> 'provider_message_id' as provider_message_id,
           elem ->> 'response_class' as response_class,
           elem ->> 'relation_status' as relation_status,
           elem ->> 'referenced_creator_sent_provider_message_id' as referenced_creator_sent_provider_message_id
      from jsonb_array_elements(coalesce(p_message_observations, '[]'::jsonb)) as elem
  )
  insert into private.gmail_reply_message_observations (
    user_id, mail_account_id, normalized_thread_id, provider_message_id, internal_date,
    current_normalized_message_id, last_evaluated_source_payload_sha256,
    response_class, relation_status,
    referenced_creator_sent_provider_message_id,
    latest_preceding_creator_sent_provider_message_id, latest_preceding_creator_sent_at,
    chronology_conflict, relation_rule_version, classification_rule_version, text_transform_version
  )
  select
    p_user_id, p_mail_account_id, p_normalized_thread_id, l.provider_message_id, l.internal_date,
    l.normalized_message_id, l.source_payload_sha256,
    py.response_class, py.relation_status, py.referenced_creator_sent_provider_message_id,
    lp.provider_message_id, lp.at,
    coalesce(ref.internal_date >= l.internal_date, false),
    p_relation_version, p_classification_version,
    case when l.provider_sent then null else p_text_transform_version end
    from locked l
    join payload py on py.provider_message_id = l.provider_message_id
    left join locked ref on ref.provider_message_id = py.referenced_creator_sent_provider_message_id
    left join lateral (
      -- The creator-sent touch with the greatest internal_date STRICTLY
      -- before `l` — tie-aware (closure pass §17): if two or more
      -- creator-sent messages share that maximal preceding timestamp,
      -- `provider_message_id` is null while `at` still carries the known
      -- timestamp, so CLOCK B's latency need not be destroyed merely
      -- because the singular identity is ambiguous.
      with preceding as (
        select cs.provider_message_id, cs.internal_date
          from locked cs
         where cs.provider_sent and cs.internal_date < l.internal_date
      ),
      maxed as (
        select max(internal_date) as at from preceding
      )
      select maxed.at,
             case when count(preceding.provider_message_id) = 1 then min(preceding.provider_message_id) end
               as provider_message_id
        from maxed
        left join preceding on preceding.internal_date = maxed.at
       group by maxed.at
    ) lp on not l.provider_sent
  on conflict (mail_account_id, provider_message_id) do update
    set normalized_thread_id = excluded.normalized_thread_id,
        internal_date = excluded.internal_date,
        current_normalized_message_id = excluded.current_normalized_message_id,
        last_evaluated_source_payload_sha256 = excluded.last_evaluated_source_payload_sha256,
        response_class = excluded.response_class,
        relation_status = excluded.relation_status,
        referenced_creator_sent_provider_message_id = excluded.referenced_creator_sent_provider_message_id,
        latest_preceding_creator_sent_provider_message_id = excluded.latest_preceding_creator_sent_provider_message_id,
        latest_preceding_creator_sent_at = excluded.latest_preceding_creator_sent_at,
        chronology_conflict = excluded.chronology_conflict,
        relation_rule_version = excluded.relation_rule_version,
        classification_rule_version = excluded.classification_rule_version,
        text_transform_version = excluded.text_transform_version,
        evaluated_at = now();

  -- `v_observed_through_at` was already computed earlier (before the
  -- already-current/no-op check) under the same locks — reused here as-is,
  -- never recomputed a second time within the same transaction.

  -- THREAD SUMMARY: DERIVED ENTIRELY HERE (closure pass §16) from the
  -- observation rows just written above — a caller cannot invent a first-
  -- reply id, a latency, a creator-send count or a horizon this function
  -- does not itself recompute. Ties (closure pass §17) null the identity
  -- column while keeping the timestamp/latency/count, which depend only on
  -- the KNOWN timestamp, fully populated.
  with obs as (
    select * from private.gmail_reply_message_observations
     where mail_account_id = p_mail_account_id and normalized_thread_id = p_normalized_thread_id
  ),
  creator as (
    select provider_message_id, internal_date from obs where response_class = 'creator_sent_touch'
  ),
  first_creator_at as (
    select min(internal_date) as at from creator
  ),
  first_creator_rows as (
    select c.provider_message_id from creator c, first_creator_at fca where c.internal_date = fca.at
  ),
  qualifying as (
    select provider_message_id, internal_date, chronology_conflict,
           latest_preceding_creator_sent_provider_message_id, latest_preceding_creator_sent_at
      from obs where response_class = 'qualifying_human_reply'
  ),
  first_reply_at as (
    select min(internal_date) as at from qualifying
  ),
  first_reply_rows as (
    select q.* from qualifying q, first_reply_at fra where q.internal_date = fra.at
  ),
  summary as (
    select
      fca.at as first_creator_sent_at,
      (select count(*)::int from first_creator_rows) as first_creator_row_count,
      (select provider_message_id from first_creator_rows limit 1) as first_creator_id_if_unique,
      fra.at as first_reply_at,
      (select count(*)::int from first_reply_rows) as first_reply_row_count,
      (select provider_message_id from first_reply_rows limit 1) as first_reply_id_if_unique,
      -- Two or more first-reply rows share the IDENTICAL first_reply_at
      -- timestamp by construction, so "which creator sends precede it" is
      -- the SAME question for every one of them — they cannot legitimately
      -- disagree on latest-preceding identity/timestamp, or on whether
      -- their OWN relation evidence contradicted its timestamp. Reading any
      -- one tied row's already-correct (possibly itself tie-null) fields is
      -- therefore exact, not an approximation.
      (select latest_preceding_creator_sent_provider_message_id from first_reply_rows limit 1) as first_reply_lp_id,
      (select latest_preceding_creator_sent_at from first_reply_rows limit 1) as first_reply_lp_at,
      (select bool_or(chronology_conflict) from first_reply_rows) as first_reply_any_conflict,
      exists (select 1 from obs where response_class = 'ambiguous_inbound') as has_ambiguous,
      exists (select 1 from obs where response_class in ('automated_response', 'delivery_status')) as has_auto_or_delivery
    from first_creator_at fca, first_reply_at fra
  ),
  -- `conflicted` (contract §10): the relation survives on the per-message
  -- row, but this THREAD's latency/latest-preceding-identity fields must be
  -- NULL, never fabricated, whenever the first reply's own relation evidence
  -- contradicted its timestamp, or there is no creator send for CLOCK A to
  -- measure from, or the resulting CLOCK A latency would be negative.
  summary2 as (
    select s.*,
      s.first_reply_at is not null and (
        s.first_creator_sent_at is null
        or extract(epoch from (s.first_reply_at - s.first_creator_sent_at)) < 0
        or s.first_reply_any_conflict
      ) as conflicted
    from summary s
  )
  insert into private.gmail_reply_thread_summaries (
    user_id, mail_account_id, normalized_thread_id, eligibility, observation_state,
    first_creator_sent_provider_message_id, first_creator_sent_at, first_creator_sent_tied,
    first_qualifying_human_reply_provider_message_id, first_qualifying_human_reply_at, first_qualifying_human_reply_tied,
    creator_sent_count_before_first_human_reply,
    latest_creator_sent_before_reply_provider_message_id, latest_creator_sent_before_reply_tied,
    latency_from_first_creator_sent_ms, latency_from_latest_creator_sent_ms, reply_chronology_conflict,
    observed_through_at, evidence_digest, evidence_message_count, routing_context_digest,
    relation_rule_version, classification_rule_version, text_transform_version
  )
  select
    p_user_id, p_mail_account_id, p_normalized_thread_id, v_eligibility,
    case
      when s.first_reply_at is not null then 'qualifying_human_reply_observed'
      when s.has_ambiguous then 'ambiguous_response_observed'
      when s.has_auto_or_delivery then 'only_automated_or_delivery_observed'
      when v_observed_through_at is not null then 'no_qualifying_response_observed_in_window'
      else 'observation_horizon_unknown'
    end,
    case when s.first_creator_row_count = 1 then s.first_creator_id_if_unique end,
    s.first_creator_sent_at,
    s.first_creator_row_count > 1,
    case when s.first_reply_row_count = 1 then s.first_reply_id_if_unique end,
    s.first_reply_at,
    s.first_reply_row_count > 1,
    case when s.first_reply_at is not null then
      (select count(*)::int from creator c where c.internal_date < s.first_reply_at)
    end,
    -- Under `conflicted`, CLOCK B's identity/tie/latency are ALL withheld —
    -- not merely the latency (contract §10: the relation survives on the
    -- per-message row; nothing about it may be reported as thread-level
    -- timing once the thread's OWN first-reply timing is already unsound).
    case when not s.conflicted then s.first_reply_lp_id end,
    not s.conflicted and s.first_reply_at is not null
      and s.first_reply_lp_id is null and s.first_reply_lp_at is not null,
    case
      when s.conflicted then null
      when s.first_reply_at is null then null
      when s.first_creator_sent_at is null then null
      else (extract(epoch from (s.first_reply_at - s.first_creator_sent_at)) * 1000)::bigint
    end,
    -- `preceding.internal_date < l.internal_date` in the per-message lateral
    -- above makes a negative CLOCK B latency structurally impossible once
    -- `first_reply_lp_at` is non-null — nothing further to guard here.
    case
      when s.conflicted then null
      when s.first_reply_at is null or s.first_reply_lp_at is null then null
      else (extract(epoch from (s.first_reply_at - s.first_reply_lp_at)) * 1000)::bigint
    end,
    s.conflicted,
    v_observed_through_at, v_current_digest, v_current_count, v_current_routing_context_digest,
    p_relation_version, p_classification_version, p_text_transform_version
    from summary2 s
  on conflict (mail_account_id, normalized_thread_id) do update
    set eligibility = excluded.eligibility,
        observation_state = excluded.observation_state,
        first_creator_sent_provider_message_id = excluded.first_creator_sent_provider_message_id,
        first_creator_sent_at = excluded.first_creator_sent_at,
        first_creator_sent_tied = excluded.first_creator_sent_tied,
        first_qualifying_human_reply_provider_message_id = excluded.first_qualifying_human_reply_provider_message_id,
        first_qualifying_human_reply_at = excluded.first_qualifying_human_reply_at,
        first_qualifying_human_reply_tied = excluded.first_qualifying_human_reply_tied,
        creator_sent_count_before_first_human_reply = excluded.creator_sent_count_before_first_human_reply,
        latest_creator_sent_before_reply_provider_message_id = excluded.latest_creator_sent_before_reply_provider_message_id,
        latest_creator_sent_before_reply_tied = excluded.latest_creator_sent_before_reply_tied,
        latency_from_first_creator_sent_ms = excluded.latency_from_first_creator_sent_ms,
        latency_from_latest_creator_sent_ms = excluded.latency_from_latest_creator_sent_ms,
        reply_chronology_conflict = excluded.reply_chronology_conflict,
        observed_through_at = excluded.observed_through_at,
        evidence_digest = excluded.evidence_digest,
        evidence_message_count = excluded.evidence_message_count,
        routing_context_digest = excluded.routing_context_digest,
        relation_rule_version = excluded.relation_rule_version,
        classification_rule_version = excluded.classification_rule_version,
        text_transform_version = excluded.text_transform_version,
        evaluated_at = now();

  -- `committed: true` — a genuinely new (or changed) projection was written.
  -- The `already_current` path above is the ONLY way this function reports
  -- `committed: false`, and it does so having written nothing at all.
  return jsonb_build_object('result', 'ok', 'evidence_digest', v_current_digest, 'committed', true);
end;
$$;

revoke all on function public.gmail_reply_commit_interpretation(
  uuid, uuid, uuid, text, text, text, text, text, jsonb
) from public;

-- ---------------------------------------------------------------------------
-- 7d. STATUS COUNTS (operator/CLI visibility, no content)
-- ---------------------------------------------------------------------------
create or replace function public.gmail_reply_status(
  p_user_id uuid,
  p_mail_account_id uuid,
  -- FINAL CLOSURE, BLOCKER C: required, no default — see the identical
  -- rationale on `gmail_reply_get_thread_evidence`.
  p_relation_version text,
  p_classification_version text,
  p_text_transform_version text
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
    ),
    -- CLOSURE PASS §18/§19, FINAL CLOSURE BLOCKER C: how much of the
    -- retained history above is CURRENTLY stale — an operator/B07 signal,
    -- never a reason to delete anything on its own. Uses the SAME
    -- `private.gmail_reply_thread_summary_is_stale` that
    -- `gmail_reply_list_candidates`/`gmail_reply_get_thread_evidence` call —
    -- one definition of "current", everywhere.
    'stale_thread_summaries', (
      select count(*) from private.gmail_reply_thread_summaries sm
       where sm.user_id = p_user_id and sm.mail_account_id = p_mail_account_id
         and private.gmail_reply_thread_summary_is_stale(
               sm.mail_account_id, sm.normalized_thread_id,
               p_relation_version, p_classification_version, p_text_transform_version
             )
    )
  );
$$;

revoke all on function public.gmail_reply_status(uuid, uuid, text, text, text) from public;

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
    'public.gmail_reply_get_thread_evidence(uuid,uuid,uuid,text,text,text)',
    'public.gmail_reply_commit_interpretation(uuid,uuid,uuid,text,text,text,text,text,jsonb)',
    'public.gmail_reply_status(uuid,uuid,text,text,text)',
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
