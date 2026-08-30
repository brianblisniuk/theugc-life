-- ===========================================================================
-- 0037 — B03: GMAIL HISTORICAL IMPORT (private raw provider staging)
-- ===========================================================================
-- B01 drew the boundary. B02 obtained the credential. B03 is the first layer
-- that actually holds Gmail CONTENT, and it is deliberately nothing more than a
-- data pipe: it acquires a bounded historical slice of a creator's own
-- conversations into a private staging layer, resumably and idempotently, and
-- interprets none of it.
--
-- WHAT THIS MIGRATION DOES NOT CREATE, on purpose:
--
--   no hotel, hotel_contact, pipeline_item, outreach_event or collaboration;
--   no normalized thread/message/participant model (that is B04);
--   no outreach detection or hotel match (B05);
--   no sent/reply timing facts (B06);
--   no outcome classification (B07);
--   no incremental sync/history cursor (B08);
--   no network-intelligence eligibility of any kind.
--
-- It also creates no mailbox, no consent, no credential and no import run. A
-- migration that connected a mailbox or inferred a permission would be making a
-- decision only a human may make.
--
-- THE ACQUISITION BOUNDARY IS SENT-ROOTED. B03 does not enumerate an inbox. A
-- thread is a candidate iff the creator sent at least one message in it inside
-- an explicit window — see `acquisition_strategy` below, which is a CHECK
-- rather than a convention precisely so V1 cannot quietly become "whole inbox".
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. FAIL BEFORE CHOICE
-- ---------------------------------------------------------------------------
-- B03 is the first import layer, so the expected pre-existing row count is
-- zero. If anything resembling B03 state already exists, this migration must
-- not guess whose it is or what it meant.
do $$
declare
  colliding text[];
begin
  select array_agg(c.relname order by c.relname) into colliding
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'private'
     and c.relkind = 'r'
     and c.relname in ('gmail_historical_import_runs',
                       'gmail_historical_import_threads',
                       'gmail_raw_messages');

  if colliding is not null then
    raise exception
      '0037 refuses to install: private table(s) % already exist. B03 is the first Gmail import layer, so pre-existing tables of these names hold state this migration did not create and cannot interpret. Resolve them explicitly rather than letting a migration adopt, alter or drop somebody else''s data.',
      array_to_string(colliding, ', ')
      using errcode = 'restrict_violation';
  end if;
end;
$$;

-- ===========================================================================
-- 1. THE IMPORT RUN
-- ===========================================================================
-- One explicit historical acquisition of one mailbox over one FIXED window.
--
-- The window is the part worth being exact about. `window_end_at` is set by the
-- database when the run is created and never moves. A worker that re-read "now"
-- on every restart would be importing a window that grows while it runs, so two
-- restarts of the same run would not be the same operation and "resumable"
-- would be a word rather than a property.
create table private.gmail_historical_import_runs (
  id uuid primary key default gen_random_uuid(),

  -- B01's provenance spine. The composite FK means a run cannot lose either the
  -- mailbox or the human, and cascades with both.
  user_id uuid not null references public.users(id) on delete cascade,
  mail_account_id uuid not null,

  -- THE WINDOW, FIXED AT CREATION.
  --
  -- `window_start_at` is supplied explicitly by the caller. B03 does NOT invent
  -- 12/24/36 months or "all history": which lookbacks a human is offered is a
  -- product decision, and hiding one in a data pipe is how it becomes permanent
  -- without anyone deciding it.
  window_start_at timestamptz not null,
  window_end_at timestamptz not null,
  constraint gmail_historical_import_runs_window_order
    check (window_start_at < window_end_at),

  -- WHAT THIS RUN IS ALLOWED TO ASK GOOGLE FOR.
  --
  -- A CHECK rather than a comment. B03 V1 acquires threads rooted in a message
  -- the creator SENT inside the window; it may not silently become an inbox
  -- crawl because a later writer passed a different string. Widening this is a
  -- contract change, and it has to look like one.
  acquisition_strategy text not null default 'sent_rooted_threads_v1'
    check (acquisition_strategy = 'sent_rooted_threads_v1'),

  -- THE LIFECYCLE.
  --
  --   runnable                      work may be claimed
  --   paused_reauth                 B02 said the stored authorization died
  --   paused_consent                private-processing consent is not current
  --   cancelled_connection_stopped  the human disconnected, or a deletion owns
  --                                 the mailbox now
  --   failed                        a permanent error this run cannot pass
  --   completed                     enumeration finished, no work left, and no
  --                                 permanent thread failure was ignored
  --
  -- `completed` is the one that must not lie: a partial import is not a
  -- completed import, however tidy the counters look.
  status text not null default 'runnable'
    check (status in ('runnable', 'paused_reauth', 'paused_consent',
                      'cancelled_connection_stopped', 'failed', 'completed')),

  phase text not null default 'enumerating'
    check (phase in ('enumerating', 'fetching', 'finished')),

  -- THE ENUMERATION CURSOR. An opaque provider page token: never parsed, never
  -- logged, and meaningless to anything but Google.
  enumeration_page_token text,
  enumeration_completed_at timestamptz,

  -- THE ENUMERATION RETRY BUDGET, and it has to live HERE.
  --
  -- A thread fetch has a work-item row to carry its attempt count; a listing
  -- page has nothing but the run. Without these two columns a `messages.list`
  -- that keeps answering 429 is retried by whatever process happens to poll
  -- next, forever, with no memory of how many times it already failed and no
  -- schedule for when to try again — an unbounded loop wearing the costume of a
  -- retry policy. They belong to the CURRENT cursor position: a successful page
  -- commit resets them, because the next page is a different provider
  -- operation with its own budget.
  enumeration_attempt_count integer not null default 0
    check (enumeration_attempt_count >= 0),
  enumeration_next_attempt_at timestamptz,

  -- WHAT HAPPENED, in counts only. No subject, no address, no body.
  candidate_sent_messages_seen integer not null default 0 check (candidate_sent_messages_seen >= 0),
  unique_threads_discovered integer not null default 0 check (unique_threads_discovered >= 0),
  threads_completed integer not null default 0 check (threads_completed >= 0),
  threads_gone integer not null default 0 check (threads_gone >= 0),
  messages_stored integer not null default 0 check (messages_stored >= 0),
  messages_updated integer not null default 0 check (messages_updated >= 0),

  -- HOW OFTEN CONTENT WAS UNAVAILABLE. Kept because a later evaluation needs to
  -- know how much of the historical record B03 could not see — an import that
  -- silently dropped half the bodies would otherwise look identical to one that
  -- captured everything.
  text_parts_omitted_external integer not null default 0 check (text_parts_omitted_external >= 0),
  attachment_or_nontext_parts_omitted integer not null
    default 0 check (attachment_or_nontext_parts_omitted >= 0),

  -- An ESTIMATE built from the provider's published per-method costs. It is not
  -- a billing statement and the column comment says so.
  estimated_gmail_quota_units bigint not null default 0 check (estimated_gmail_quota_units >= 0),

  -- A sanitized code. Never a provider message, never a response body.
  last_error_code text
    constraint gmail_historical_import_runs_error_code_shape
    check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),

  -- THE DURABLE STEP LEASE — see §4. A worker is a process that can die; the
  -- database is what remembers whether its work is still outstanding.
  lease_token uuid,
  lease_expires_at timestamptz,
  lease_step text check (lease_step in ('enumerate_page', 'fetch_thread', 'complete_run')),
  lease_thread_id text,
  lease_authorization_revision bigint,

  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),

  constraint gmail_historical_import_runs_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  -- A lease is all of its parts or none of them.
  constraint gmail_historical_import_runs_lease_shape check (
    (lease_token is null and lease_expires_at is null and lease_step is null
     and lease_thread_id is null and lease_authorization_revision is null)
    or (lease_token is not null and lease_expires_at is not null and lease_step is not null)
  ),

  -- A `fetch_thread` lease names the thread it claimed; the other steps do not.
  constraint gmail_historical_import_runs_lease_thread_iff check (
    lease_step is distinct from 'fetch_thread' or lease_thread_id is not null
  ),

  -- A terminal run has an end time, and a non-terminal one does not claim to.
  constraint gmail_historical_import_runs_terminal_shape check (
    (status in ('cancelled_connection_stopped', 'failed', 'completed')) = (completed_at is not null)
  )
);

comment on table private.gmail_historical_import_runs is
  'B03: one explicit historical Gmail acquisition of one mailbox over one FIXED window. Private: no client role may reach it. Holds counters and cursors, never message content.';

comment on column private.gmail_historical_import_runs.window_end_at is
  'B03: set by the database at run creation and never moved. Re-reading "now" per restart would make each resumption a different operation.';

comment on column private.gmail_historical_import_runs.estimated_gmail_quota_units is
  'B03: an ESTIMATE from the provider''s published per-method quota costs (messages.list=5, threads.get=40 at the time of writing). Google publishes these and may change them; this is not a billing statement.';

comment on column private.gmail_historical_import_runs.enumeration_page_token is
  'B03: opaque Gmail page token. Never parsed, never logged, meaningless outside Google.';

-- ONE ACTIVE HISTORICAL RUN PER MAILBOX. Two live runs over the same mailbox
-- are not two decisions, they are a race for the same quota and the same rows.
-- Terminal runs coexist freely: a mailbox may be imported many times over its
-- life, and that history is worth keeping.
create unique index gmail_historical_import_runs_active_uidx
  on private.gmail_historical_import_runs (mail_account_id)
  where status in ('runnable', 'paused_reauth', 'paused_consent');

create index gmail_historical_import_runs_user_idx
  on private.gmail_historical_import_runs (user_id, status);

-- THE WINDOW AND THE SUBJECT OF A RUN ARE FIXED AT CREATION.
--
-- Everything a run means — which mailbox, which human, which slice of history,
-- by which acquisition rule — is decided once. A writer that could edit them
-- afterwards could widen an import silently, which is exactly the thing this
-- layer must not be able to do.
create or replace function private.forbid_gmail_import_run_identity_change()
returns trigger
language plpgsql
as $$
begin
  if new.user_id is distinct from old.user_id
     or new.mail_account_id is distinct from old.mail_account_id
     or new.window_start_at is distinct from old.window_start_at
     or new.window_end_at is distinct from old.window_end_at
     or new.acquisition_strategy is distinct from old.acquisition_strategy then
    raise exception
      'historical import run % cannot change its owner, mailbox, window or acquisition strategy. Those four facts are what the run IS; editing them would silently redefine an import that has already been partly performed.',
      old.id
      using errcode = 'restrict_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.forbid_gmail_import_run_identity_change() from public;

create trigger gmail_historical_import_runs_identity_fixed
  before update on private.gmail_historical_import_runs
  for each row execute function private.forbid_gmail_import_run_identity_change();

-- ===========================================================================
-- 2. THREAD WORK
-- ===========================================================================
-- One durable work item per deduped provider thread per run. This is the queue,
-- and it lives in PostgreSQL rather than in a process because a process is the
-- thing that crashes.
create table private.gmail_historical_import_threads (
  id uuid primary key default gen_random_uuid(),

  run_id uuid not null references private.gmail_historical_import_runs(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  mail_account_id uuid not null,

  -- Private provider metadata. Not shown in ordinary operator output.
  provider_thread_id text not null check (length(btrim(provider_thread_id)) > 0),

  status text not null default 'pending'
    check (status in ('pending', 'complete', 'gone', 'failed')),

  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),

  last_error_code text
    constraint gmail_historical_import_threads_error_code_shape
    check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),

  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gmail_historical_import_threads_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  -- REPLAYING A LISTING PAGE CANNOT CREATE DUPLICATE WORK. This is the
  -- constraint that makes "the same page may be applied twice safely" true
  -- rather than intended, and it is why the enumeration commit can use a plain
  -- `on conflict do nothing`.
  constraint gmail_historical_import_threads_run_thread_uk unique (run_id, provider_thread_id),

  constraint gmail_historical_import_threads_terminal_shape check (
    (status in ('complete', 'gone', 'failed')) = (completed_at is not null)
  )
);

comment on table private.gmail_historical_import_threads is
  'B03: durable per-run work queue of deduped provider thread ids. Private. Provider thread ids are private metadata, not operator output.';

create index gmail_historical_import_threads_claimable_idx
  on private.gmail_historical_import_threads (run_id, next_attempt_at)
  where status = 'pending';

create index gmail_historical_import_threads_account_idx
  on private.gmail_historical_import_threads (mail_account_id);

create or replace function private.touch_gmail_import_thread()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.touch_gmail_import_thread() from public;

create trigger gmail_historical_import_threads_touch
  before update on private.gmail_historical_import_threads
  for each row execute function private.touch_gmail_import_thread();

-- ===========================================================================
-- 3. RAW PROVIDER MESSAGES
-- ===========================================================================
-- The first Gmail CONTENT this system stores. G1 private content in B01's
-- vocabulary: never contributed to any shared or network intelligence, never
-- reachable by a client role, never read by staff, and deletion-addressable.
--
-- IDENTITY IS (mailbox, provider message id) — NOT (run, message).
--
-- The same Gmail message observed in ten imports is one message. Keying on the
-- run would produce ten snapshots of one fact, and every later layer would have
-- to guess which is current. Provider ids are ACCOUNT-SCOPED: a message id from
-- mailbox A says nothing about mailbox B, so the mailbox is part of the key.
create table private.gmail_raw_messages (
  mail_account_id uuid not null,
  user_id uuid not null references public.users(id) on delete cascade,

  provider_message_id text not null check (length(btrim(provider_message_id)) > 0),
  provider_thread_id text not null check (length(btrim(provider_thread_id)) > 0),

  -- Gmail's own `internalDate`. The LOCAL window filter is authoritative for
  -- what is persisted; Gmail's search semantics decide only what is offered.
  internal_date timestamptz not null,

  -- Provider metadata, deliberately uninterpreted. B08 owns incremental sync;
  -- B03 keeps the value and draws no conclusion from it.
  provider_history_id text,

  label_ids text[] not null default '{}',

  -- The sanitized provider-shaped payload. What may appear inside it is decided
  -- by ONE deterministic sanitizer in the application, and asserted by tests:
  -- approved headers, inline text bodies, structural metadata for omitted
  -- parts. No `raw`, no `snippet`, no `attachmentId`, no attachment bytes.
  sanitized_payload jsonb not null,

  -- Digest of the canonicalized sanitized payload. Metadata, not content: it
  -- lets a replay skip a meaningless write without comparing bodies.
  payload_sha256 text not null check (payload_sha256 ~ '^[0-9a-f]{64}$'),

  -- WHICH IMPORT FIRST SAW IT, AND WHICH SAW IT LAST. Provenance across runs,
  -- without duplicating the message once per run.
  first_import_run_id uuid references private.gmail_historical_import_runs(id) on delete set null,
  last_import_run_id uuid references private.gmail_historical_import_runs(id) on delete set null,

  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gmail_raw_messages_pkey primary key (mail_account_id, provider_message_id),

  constraint gmail_raw_messages_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade
);

comment on table private.gmail_raw_messages is
  'B03: private raw Gmail message snapshots (G1 content). Identity is (mail_account_id, provider_message_id) so one message is one row across every import. No normalized participants, no body columns, no reply/outcome fields, no hotel reference — those are B04+.';

comment on column private.gmail_raw_messages.sanitized_payload is
  'B03: provider-shaped payload after the deterministic sanitizer. Contains approved headers and inline text bodies only. Never `raw`, `snippet`, `attachmentId` or attachment bytes.';

create index gmail_raw_messages_thread_idx
  on private.gmail_raw_messages (mail_account_id, provider_thread_id);

create index gmail_raw_messages_user_idx
  on private.gmail_raw_messages (user_id);

-- A MESSAGE DOES NOT MOVE BETWEEN THREADS.
--
-- Gmail's thread membership is part of the message's identity as far as this
-- layer is concerned. If the same account/message id is ever presented with a
-- different thread id, something upstream is wrong — a mixed-up response, a
-- confused caller, a fake in a test that does not model reality — and quietly
-- rewriting the row would bury it. Fail closed instead.
create or replace function private.forbid_gmail_raw_message_thread_move()
returns trigger
language plpgsql
as $$
begin
  if new.provider_thread_id is distinct from old.provider_thread_id then
    raise exception
      'raw Gmail message %/% was presented with provider thread % having been stored under %. A message does not change conversation; this is a provider or caller integrity error, and silently moving it would hide the disagreement.',
      old.mail_account_id, old.provider_message_id, new.provider_thread_id, old.provider_thread_id
      using errcode = 'integrity_constraint_violation';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.forbid_gmail_raw_message_thread_move() from public;

create trigger gmail_raw_messages_thread_is_stable
  before update on private.gmail_raw_messages
  for each row execute function private.forbid_gmail_raw_message_thread_move();

-- ===========================================================================
-- 3a. `deleted` MUST MEAN NO B03 DATA SURVIVES
-- ===========================================================================
-- B01 defines `deleted` as an assertion that stored Gmail data was removed.
-- B03 is the first layer that makes that assertion falsifiable, so it is the
-- first layer that has to be checked.
--
-- DEFERRED, because a legitimate deletion transaction purges rows and moves the
-- state in separate statements and is momentarily inconsistent between them.
--
-- REGISTERED ON BOTH ORIGINS — the mailbox lifecycle AND every B03 table — for
-- the reason A04.6 and B02 both paid for: an invariant hung off one side is a
-- habit of whoever writes that side. The same broken state is reachable by
-- retiring an account that still has rows, or by inserting rows under an
-- account already retired.
--
-- It reads FINAL database state. If the account row is gone there is nothing
-- left to be coherent with. No `pg_trigger_depth()`: cascade detection by
-- recursion depth is a guess about how you got here, and the question is only
-- ever where you ended up.
create or replace function public.assert_gmail_import_data_absent_when_deleted()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  account_id uuid;
  account_state text;
  raw_count integer;
  run_count integer;
begin
  -- Separate branches, not one CASE expression: plpgsql resolves record fields
  -- against the record's actual type, so a single expression naming both `id`
  -- and `mail_account_id` cannot compile for both trigger tables.
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

  if not found then
    -- The mailbox itself is gone; the cascade took its Gmail data with it.
    return null;
  end if;

  if account_state <> 'deleted' then
    return null;
  end if;

  select count(*)::int into raw_count
    from private.gmail_raw_messages r where r.mail_account_id = account_id;

  select count(*)::int into run_count
    from private.gmail_historical_import_runs x where x.mail_account_id = account_id;

  if raw_count > 0 or run_count > 0 then
    raise exception
      'mail account % is `deleted` while % raw Gmail message(s) and % historical import run(s) remain. B01 defines that state as an assertion that stored Gmail data was removed, and this is the layer that stores it — the word and the rows cannot both stand.',
      account_id, raw_count, run_count
      using errcode = 'integrity_constraint_violation';
  end if;

  return null;
end;
$$;

revoke all on function public.assert_gmail_import_data_absent_when_deleted() from public;
revoke all on function public.assert_gmail_import_data_absent_when_deleted() from anon, authenticated;

create constraint trigger mail_accounts_gmail_import_absent_when_deleted
  after insert or update on public.mail_accounts
  deferrable initially deferred
  for each row execute function public.assert_gmail_import_data_absent_when_deleted();

create constraint trigger gmail_raw_messages_absent_when_deleted
  after insert or update on private.gmail_raw_messages
  deferrable initially deferred
  for each row execute function public.assert_gmail_import_data_absent_when_deleted();

create constraint trigger gmail_historical_import_runs_absent_when_deleted
  after insert or update on private.gmail_historical_import_runs
  deferrable initially deferred
  for each row execute function public.assert_gmail_import_data_absent_when_deleted();

create constraint trigger gmail_historical_import_threads_absent_when_deleted
  after insert or update on private.gmail_historical_import_threads
  deferrable initially deferred
  for each row execute function public.assert_gmail_import_data_absent_when_deleted();

-- ===========================================================================
-- 3b. A HUMAN DECISION MUST NOT DEPEND ON WHETHER A WORKER WAS POLLING
-- ===========================================================================
-- Everything else in B03 asks "may we read this mailbox?" at the moment a
-- worker happens to look. That is enough to stop a stale response being
-- persisted, and it is NOT enough to record that a human made a decision.
--
-- The gap it leaves is a real sequence, not a theoretical one:
--
--   run R is runnable
--   the person Disconnects            no worker is running
--   the person Reconnects             no worker is running
--   a worker finally polls
--
-- Every question the worker can ask is answered by the CURRENT row, and the
-- current row says `connected`. The Disconnect happened, B03 has no record of
-- it, and R simply carries on — which contradicts the rule that a disconnect
-- ends a historical run and that starting again is explicit.
--
-- The fix is to stop treating a lifecycle change as something to be observed
-- and start treating it as something that HAPPENS. The transition itself
-- carries the run forward, inside the same transaction that moved the mailbox,
-- so the outcome does not depend on anybody being awake.
--
-- Scope: this trigger owns B03 RUN LIFECYCLE and nothing else. It reads
-- `mail_accounts` and writes only `private.gmail_historical_import_runs`. It
-- never touches B01 consent, B02 credentials, or the mailbox row itself, and it
-- never deletes imported data — a Disconnect is not a deletion.
create or replace function private.apply_gmail_lifecycle_to_import_runs()
returns trigger
language plpgsql
as $$
begin
  if new.connection_state is not distinct from old.connection_state then
    return null;
  end if;

  if new.connection_state in ('disconnecting', 'disconnected', 'deletion_pending', 'deleted') then
    -- THE CONNECTION IS OVER, or a deletion owns the mailbox now. Every
    -- non-terminal run stops, including one that was already paused: a paused
    -- run is a run waiting for the human to answer a question, and this IS the
    -- answer. Terminal runs are left exactly as they are — a `completed` import
    -- does not become `cancelled` because the person later disconnected.
    update private.gmail_historical_import_runs
       set status = 'cancelled_connection_stopped',
           phase = 'finished',
           completed_at = now(),
           last_error_code = 'connection_stopped',
           lease_token = null,
           lease_expires_at = null,
           lease_step = null,
           lease_thread_id = null,
           lease_authorization_revision = null
     where mail_account_id = new.id
       and status in ('runnable', 'paused_reauth', 'paused_consent');

  elsif new.connection_state in ('reauth_required', 'pending_authorization') then
    update private.gmail_historical_import_runs
       set status = 'paused_reauth',
           last_error_code = 'reauth_required',
           lease_token = null,
           lease_expires_at = null,
           lease_step = null,
           lease_thread_id = null,
           lease_authorization_revision = null
     where mail_account_id = new.id
       and status = 'runnable';

  elsif new.connection_state = 'consent_required' then
    update private.gmail_historical_import_runs
       set status = 'paused_consent',
           last_error_code = 'consent_missing',
           lease_token = null,
           lease_expires_at = null,
           lease_step = null,
           lease_thread_id = null,
           lease_authorization_revision = null
     where mail_account_id = new.id
       and status = 'runnable';
  end if;

  -- `connected` DELIBERATELY DOES NOTHING.
  --
  -- Reconnecting a mailbox answers "may we read your mail again"; it does not
  -- answer "please resume the import you stopped". A paused run stays paused
  -- until somebody resumes it, and a cancelled run stays cancelled forever —
  -- starting again means starting a new run, which is a decision somebody makes
  -- rather than a side effect of a state name coming back.
  return null;
end;
$$;

revoke all on function private.apply_gmail_lifecycle_to_import_runs() from public;

comment on function private.apply_gmail_lifecycle_to_import_runs() is
  'B03: carries a mail_accounts lifecycle transition into historical import runs in the SAME transaction, so a Disconnect or consent withdrawal is durable rather than dependent on a worker polling at that moment. Writes only B03 run rows.';

create trigger gmail_lifecycle_stops_import_runs
  after update of connection_state on public.mail_accounts
  for each row execute function private.apply_gmail_lifecycle_to_import_runs();

-- ===========================================================================
-- 4. MAY WE STILL READ THIS MAILBOX?
-- ===========================================================================
-- One predicate, asked at claim time and asked AGAIN at every commit.
--
-- The gap between them is a Gmail network call, and the human can Disconnect or
-- withdraw consent while it is on the wire. PostgreSQL cannot cancel a request
-- already in flight, and B03 does not pretend otherwise. What it guarantees is
-- the strongest honest property available: THE RESPONSE OF A STALE STEP MAY NOT
-- BE PERSISTED.
--
-- Four things must all still hold:
--
--   the mailbox is `connected`                      B02's state authority
--   private-processing consent is granted           B01's permission authority
--   that consent covers the CURRENT scope set       B01's exact-scope rule: a
--                                                   grant for a narrower set is
--                                                   not permission for a wider
--   the authorization revision is unchanged         B02's database-owned clock;
--                                                   a Disconnect advances it
--
-- The revision is what makes this a compare-and-swap rather than a re-read. A
-- state name can leave and return; the revision cannot go backwards.
create or replace function private.gmail_import_authorization_state(
  p_mail_account_id uuid,
  p_expected_authorization_revision bigint
)
returns text
language plpgsql
stable
as $$
declare
  v_account public.mail_accounts%rowtype;
  v_consent_state text;
  v_consent_scopes text[];
begin
  select m.* into v_account from public.mail_accounts m where m.id = p_mail_account_id;
  if not found then
    return 'not_found';
  end if;

  if v_account.connection_state <> 'connected' then
    return 'not_connected';
  end if;

  select c.state, r.granted_scopes_at_decision
    into v_consent_state, v_consent_scopes
    from public.mail_account_consents c
    join public.mail_account_consent_receipts r on r.id = c.current_receipt_id
   where c.mail_account_id = p_mail_account_id
     and c.consent_kind = 'private_gmail_processing';

  if v_consent_state is distinct from 'granted' then
    return 'consent_missing';
  end if;

  -- EXACT SCOPE. B01 requires a renewed decision when the granted set widens,
  -- so a consent snapshotted against a narrower set does not authorize reading
  -- under a wider one.
  if v_consent_scopes is distinct from public.canonical_scope_set(v_account.granted_scopes) then
    return 'consent_scope_changed';
  end if;

  if p_expected_authorization_revision is not null
     and v_account.authorization_revision <> p_expected_authorization_revision then
    return 'authorization_changed';
  end if;

  return 'ok';
end;
$$;

revoke all on function private.gmail_import_authorization_state(uuid, bigint) from public;

-- ===========================================================================
-- 5. THE RPC SURFACE
-- ===========================================================================
-- Definer-rights doors into a schema no client may enter. Each pins its
-- `search_path`, each is one transaction, and each takes the owner as part of
-- the LOOKUP rather than comparing it afterwards.

-- ---------------------------------------------------------------------------
-- 5a. START — the only place a run comes into existence
-- ---------------------------------------------------------------------------
create or replace function public.gmail_historical_import_start(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_window_start_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_account public.mail_accounts%rowtype;
  v_auth text;
  v_run_id uuid;
  v_end timestamptz;
begin
  if p_user_id is null or p_mail_account_id is null or p_window_start_at is null then
    raise exception 'gmail_historical_import_start requires a user, a mailbox and an explicit window start'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Owner inside the lookup: a stranger's mailbox id finds nothing.
  select m.* into v_account
    from public.mail_accounts m
   where m.id = p_mail_account_id and m.user_id = p_user_id
   for no key update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  v_auth := private.gmail_import_authorization_state(p_mail_account_id, null);
  if v_auth <> 'ok' then
    return jsonb_build_object('result', v_auth, 'connection_state', v_account.connection_state);
  end if;

  -- The scope that makes reading possible at all. B01's allow-list permits
  -- others; only this one lets B03 do its job.
  if not (v_account.granted_scopes @> array['https://www.googleapis.com/auth/gmail.readonly']::text[]) then
    return jsonb_build_object('result', 'missing_read_scope');
  end if;

  -- THE DATABASE OWNS THE END OF THE WINDOW. Not the caller, and not "now" as
  -- re-read by each restart.
  v_end := now();
  if p_window_start_at >= v_end then
    return jsonb_build_object('result', 'invalid_window');
  end if;

  if exists (
    select 1 from private.gmail_historical_import_runs r
     where r.mail_account_id = p_mail_account_id
       and r.status in ('runnable', 'paused_reauth', 'paused_consent')
  ) then
    return jsonb_build_object('result', 'run_already_active');
  end if;

  insert into private.gmail_historical_import_runs
    (user_id, mail_account_id, window_start_at, window_end_at, started_at)
  values
    (p_user_id, p_mail_account_id, p_window_start_at, v_end, now())
  returning id into v_run_id;

  return jsonb_build_object(
    'result', 'ok',
    'run_id', v_run_id,
    'window_start_at', p_window_start_at,
    'window_end_at', v_end
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5b. CLAIM ONE STEP
-- ---------------------------------------------------------------------------
-- Returns exactly one unit of work and a database-owned lease token. Exactly
-- one provider call is required to discharge it.
--
-- The lease expiry is time-based BECAUSE IT IS A LIVENESS MECHANISM: it answers
-- "has this worker stopped existing?", which is a question about wall clock. It
-- is not used as a causality token for authorization — that is the revision's
-- job, and the two must not be confused.
create or replace function public.gmail_historical_import_claim_step(
  p_user_id uuid,
  p_run_id uuid,
  p_lease_seconds integer default 300
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_run private.gmail_historical_import_runs%rowtype;
  v_account public.mail_accounts%rowtype;
  v_auth text;
  v_token uuid;
  v_expires timestamptz;
  v_thread private.gmail_historical_import_threads%rowtype;
  v_pending integer;
  v_failed integer;
  v_next timestamptz;
begin
  if p_lease_seconds is null or p_lease_seconds <= 0 or p_lease_seconds > 3600 then
    raise exception 'gmail_historical_import_claim_step requires a lease of 1..3600 seconds'
      using errcode = 'invalid_parameter_value';
  end if;

  select r.* into v_run
    from private.gmail_historical_import_runs r
   where r.id = p_run_id and r.user_id = p_user_id
   for no key update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_run.status <> 'runnable' then
    return jsonb_build_object('result', 'not_runnable', 'status', v_run.status);
  end if;

  select m.* into v_account from public.mail_accounts m where m.id = v_run.mail_account_id;

  -- MAY WE READ, RIGHT NOW. Asked before a lease is issued so a worker never
  -- starts a provider call it was never entitled to make.
  v_auth := private.gmail_import_authorization_state(v_run.mail_account_id, null);
  if v_auth <> 'ok' then
    return jsonb_build_object(
      'result', 'authorization_unavailable',
      'reason', v_auth,
      'connection_state', v_account.connection_state
    );
  end if;

  -- AT MOST ONE UNEXPIRED LEASE OWNS A STEP.
  if v_run.lease_token is not null and v_run.lease_expires_at > now() then
    return jsonb_build_object('result', 'leased', 'lease_expires_at', v_run.lease_expires_at);
  end if;

  v_token := gen_random_uuid();
  v_expires := now() + make_interval(secs => p_lease_seconds);

  -- ENUMERATION FIRST. Fetching threads before the candidate set is known would
  -- be working from an answer that is still being computed.
  if v_run.enumeration_completed_at is null then
    -- A DURABLE BACKOFF, not a sleep in a process. The page that failed is
    -- still the page to fetch, and the schedule for retrying it survives the
    -- worker that scheduled it.
    if v_run.enumeration_next_attempt_at is not null
       and v_run.enumeration_next_attempt_at > now() then
      return jsonb_build_object(
        'result', 'waiting',
        'next_attempt_at', v_run.enumeration_next_attempt_at);
    end if;

    update private.gmail_historical_import_runs
       set lease_token = v_token,
           lease_expires_at = v_expires,
           lease_step = 'enumerate_page',
           lease_thread_id = null,
           lease_authorization_revision = v_account.authorization_revision
     where id = p_run_id;

    return jsonb_build_object(
      'result', 'ok',
      'step', 'enumerate_page',
      'lease_token', v_token,
      'lease_expires_at', v_expires,
      'mail_account_id', v_run.mail_account_id,
      'authorization_revision', v_account.authorization_revision,
      'window_start_at', v_run.window_start_at,
      'window_end_at', v_run.window_end_at,
      'page_token', v_run.enumeration_page_token,
      'attempt_count', v_run.enumeration_attempt_count
    );
  end if;

  -- THEN ONE THREAD, oldest claimable first. `skip locked` so two workers on
  -- the same run pick different threads rather than queueing behind each other.
  select t.* into v_thread
    from private.gmail_historical_import_threads t
   where t.run_id = p_run_id
     and t.status = 'pending'
     and t.next_attempt_at <= now()
   order by t.next_attempt_at, t.created_at
   limit 1
   for no key update skip locked;

  if found then
    update private.gmail_historical_import_runs
       set lease_token = v_token,
           lease_expires_at = v_expires,
           lease_step = 'fetch_thread',
           lease_thread_id = v_thread.provider_thread_id,
           lease_authorization_revision = v_account.authorization_revision,
           phase = 'fetching'
     where id = p_run_id;

    return jsonb_build_object(
      'result', 'ok',
      'step', 'fetch_thread',
      'lease_token', v_token,
      'lease_expires_at', v_expires,
      'mail_account_id', v_run.mail_account_id,
      'authorization_revision', v_account.authorization_revision,
      'window_start_at', v_run.window_start_at,
      'window_end_at', v_run.window_end_at,
      'provider_thread_id', v_thread.provider_thread_id,
      'attempt_count', v_thread.attempt_count
    );
  end if;

  -- NOTHING CLAIMABLE. Either work is waiting out a backoff, or there is none
  -- left and the run may be finished.
  select count(*) filter (where status = 'pending'),
         count(*) filter (where status = 'failed'),
         min(next_attempt_at) filter (where status = 'pending')
    into v_pending, v_failed, v_next
    from private.gmail_historical_import_threads
   where run_id = p_run_id;

  if v_pending > 0 then
    return jsonb_build_object('result', 'waiting', 'next_attempt_at', v_next);
  end if;

  update private.gmail_historical_import_runs
     set lease_token = v_token,
         lease_expires_at = v_expires,
         lease_step = 'complete_run',
         lease_thread_id = null,
         lease_authorization_revision = v_account.authorization_revision
   where id = p_run_id;

  return jsonb_build_object(
    'result', 'ok',
    'step', 'complete_run',
    'lease_token', v_token,
    'lease_expires_at', v_expires,
    'mail_account_id', v_run.mail_account_id,
    'authorization_revision', v_account.authorization_revision,
    'failed_threads', v_failed
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5c. THE COMMIT FENCE, shared by every step that persists a provider response
-- ---------------------------------------------------------------------------
-- Locks the run, proves the lease is still ours, and proves the authorization
-- has not moved since the step was claimed. Returns 'ok' or the reason to
-- refuse; the caller persists NOTHING on a refusal.
create or replace function private.gmail_import_commit_guard(
  p_run private.gmail_historical_import_runs,
  p_lease_token uuid,
  p_expected_step text,
  p_expected_authorization_revision bigint
)
returns text
language plpgsql
stable
as $$
declare
  v_auth text;
begin
  -- NO WILDCARD ON A CLAIMED RESULT.
  --
  -- Every caller of this guard is holding something a provider said in answer to
  -- a step the database handed out, and every claim names the authorization
  -- revision it was issued under. A NULL here would mean "compare against
  -- whatever is current", which is precisely the comparison that lets a response
  -- from revision N mutate work under revision N+2. A caller that cannot name
  -- its revision is not holding a claimed result.
  if p_expected_authorization_revision is null then
    return 'authorization_revision_required';
  end if;

  -- A STALE WORKER MAY COMMIT NOTHING. If its lease expired and another worker
  -- reclaimed the step, the token no longer matches and the response it is
  -- holding belongs to work somebody else has taken over.
  if p_run.lease_token is null
     or p_lease_token is null
     or p_run.lease_token <> p_lease_token
     or p_run.lease_expires_at <= now()
     or p_run.lease_step is distinct from p_expected_step then
    return 'stale_lease';
  end if;

  if p_run.status <> 'runnable' then
    return 'not_runnable';
  end if;

  v_auth := private.gmail_import_authorization_state(
    p_run.mail_account_id, p_expected_authorization_revision);

  if v_auth <> 'ok' then
    return v_auth;
  end if;

  return 'ok';
end;
$$;

revoke all on function private.gmail_import_commit_guard(
  private.gmail_historical_import_runs, uuid, text, bigint) from public;

-- Clears a lease without pretending the step succeeded.
create or replace function private.gmail_import_release_lease(p_run_id uuid)
returns void
language sql
as $$
  update private.gmail_historical_import_runs
     set lease_token = null,
         lease_expires_at = null,
         lease_step = null,
         lease_thread_id = null,
         lease_authorization_revision = null
   where id = p_run_id;
$$;

revoke all on function private.gmail_import_release_lease(uuid) from public;

-- ---------------------------------------------------------------------------
-- 5c-bis. THE FINAL CHECK BEFORE WE TOUCH GOOGLE
-- ---------------------------------------------------------------------------
-- THE COMMIT FENCE PROTECTS THE DATABASE. THIS PROTECTS THE MAILBOX.
--
-- A worker claims a step, then does several things that take time before it
-- makes the provider call: it asks B02 for a fresh access token, and it may wait
-- out the quota pacer. A human can Disconnect during that gap. The lifecycle
-- trigger correctly cancels the run and clears the lease — but the WORKER is
-- still holding the claim in memory, and if the person later reconnects, B02
-- will hand it a perfectly valid access token for a mailbox that is once again
-- connected. It then reads Gmail under an import intention that was cancelled.
--
-- Nothing is persisted; the commit fence sees to that. But a read happened, and
-- "a cancelled run does not resume" is a promise about READING somebody's mail,
-- not only about writing rows. A paused run is the same: it must require an
-- explicit resume before another provider read, not merely before another write.
--
-- So this is asked LAST — after the token, after any pacing sleep, immediately
-- before the request. It proves the same six things the commit fence proves, and
-- it mutates nothing.
--
-- IT TAKES NO LOCK. A row lock held across a Gmail call would pin a PostgreSQL
-- transaction to the latency of a third party, and the lock would not buy the
-- guarantee anyway: a decision committed after this returns is the in-flight
-- case, which no amount of locking can prevent and which the commit fence is
-- there to catch. The honest boundary is stated rather than engineered away:
--
--   BEFORE this returns ok   a cancellation prevents the read
--   AFTER  this returns ok   the operation is in flight; a cancellation
--                            prevents the RESULT being persisted
create or replace function public.gmail_historical_import_validate_claim(
  p_user_id uuid,
  p_run_id uuid,
  p_lease_token uuid,
  p_expected_authorization_revision bigint,
  p_expected_step text,
  p_expected_provider_thread_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_run private.gmail_historical_import_runs%rowtype;
  v_guard text;
begin
  if p_expected_step not in ('enumerate_page', 'fetch_thread', 'complete_run') then
    raise exception 'gmail_historical_import_validate_claim requires a known step'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The owner is part of the LOOKUP, not a comparison afterwards.
  select r.* into v_run
    from private.gmail_historical_import_runs r
   where r.id = p_run_id and r.user_id = p_user_id;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  v_guard := private.gmail_import_commit_guard(
    v_run, p_lease_token, p_expected_step, p_expected_authorization_revision);

  if v_guard = 'ok' then
    -- THE STEP AND ITS SUBJECT MUST MATCH. A thread fetch names the thread the
    -- lease was issued for; an enumeration names none. A worker about to fetch
    -- T2 while holding a lease for T1 has already lost track of what it claimed.
    if p_expected_step = 'fetch_thread' then
      if p_expected_provider_thread_id is null
         or v_run.lease_thread_id is distinct from p_expected_provider_thread_id then
        v_guard := 'stale_lease';
      end if;
    elsif p_expected_provider_thread_id is not null then
      v_guard := 'stale_lease';
    end if;
  end if;

  return jsonb_build_object(
    'result', v_guard,
    'run_status', v_run.status,
    'connection_state',
    (select m.connection_state from public.mail_accounts m where m.id = v_run.mail_account_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- 5d. COMMIT ONE ENUMERATION PAGE
-- ---------------------------------------------------------------------------
-- ONE transaction: the discovered thread work AND the cursor advance. Splitting
-- them would allow a state that claims a page was consumed while its work was
-- not created, or work with no record of where to continue.
create or replace function public.gmail_historical_import_commit_page(
  p_user_id uuid,
  p_run_id uuid,
  p_lease_token uuid,
  p_expected_authorization_revision bigint,
  p_page_token_used text,
  p_next_page_token text,
  p_thread_ids text[],
  p_sent_messages_seen integer,
  p_quota_units integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_guard text;
  v_run private.gmail_historical_import_runs%rowtype;
  v_inserted integer := 0;
begin
  select r.* into v_run
    from private.gmail_historical_import_runs r
   where r.id = p_run_id and r.user_id = p_user_id
   for no key update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  v_guard := private.gmail_import_commit_guard(
    v_run, p_lease_token, 'enumerate_page', p_expected_authorization_revision);

  if v_guard <> 'ok' then
    -- NOTHING FETCHED IS PERSISTED. Not the thread ids, not the cursor, not the
    -- counters. A response obtained under an authorization that has since
    -- changed does not enter storage, and it is not logged either.
    if v_guard not in ('not_found', 'stale_lease', 'authorization_revision_required') then
      perform private.gmail_import_release_lease(p_run_id);
    end if;
    -- The connection state travels with the refusal so the worker can tell a
    -- Disconnect from a withdrawn consent without asking a second question.
    -- The connection state AND the run's own status travel with the refusal.
    -- A mailbox lifecycle change stops runs durably now, so by the time a stale
    -- response arrives the run is already cancelled or paused, and the worker
    -- must report THAT rather than "we will try again later".
    return jsonb_build_object(
      'result', v_guard,
      'run_status', v_run.status,
      'connection_state',
      (select m.connection_state from public.mail_accounts m where m.id = v_run.mail_account_id));
  end if;

  -- REPLAY SAFETY. If the cursor is not where this page started, the page has
  -- already been applied and the worker is repeating itself after a crash
  -- between the provider response and the local commit. Answering `ok` would be
  -- claiming an advance that already happened; answering an error would make a
  -- safe replay look like a failure.
  if v_run.enumeration_page_token is distinct from p_page_token_used then
    perform private.gmail_import_release_lease(p_run_id);
    return jsonb_build_object('result', 'already_applied');
  end if;

  if v_run.enumeration_completed_at is not null then
    perform private.gmail_import_release_lease(p_run_id);
    return jsonb_build_object('result', 'already_applied');
  end if;

  with candidate as (
    select distinct btrim(t) as provider_thread_id
      from unnest(coalesce(p_thread_ids, '{}'::text[])) as t
     where btrim(t) <> ''
  ),
  inserted as (
    insert into private.gmail_historical_import_threads
      (run_id, user_id, mail_account_id, provider_thread_id)
    select p_run_id, v_run.user_id, v_run.mail_account_id, c.provider_thread_id
      from candidate c
    on conflict (run_id, provider_thread_id) do nothing
    returning 1
  )
  select count(*)::int into v_inserted from inserted;

  update private.gmail_historical_import_runs
     set enumeration_page_token = p_next_page_token,
         -- ABSENCE OF A NEXT PAGE TOKEN IS THE ONLY COMPLETION SIGNAL. An
         -- estimated result size is an estimate; it has never been a promise
         -- about how many pages remain.
         enumeration_completed_at = case when p_next_page_token is null then now() else null end,
         phase = case when p_next_page_token is null then 'fetching' else 'enumerating' end,
         candidate_sent_messages_seen =
           candidate_sent_messages_seen + greatest(coalesce(p_sent_messages_seen, 0), 0),
         unique_threads_discovered = unique_threads_discovered + v_inserted,
         estimated_gmail_quota_units =
           estimated_gmail_quota_units + greatest(coalesce(p_quota_units, 0), 0),
         last_error_code = null,
         -- A NEW PAGE IS A NEW PROVIDER OPERATION, so it gets its own budget.
         -- Carrying the previous page's failures forward would let a run that
         -- is making steady progress accumulate its way into `failed`.
         enumeration_attempt_count = 0,
         enumeration_next_attempt_at = null,
         lease_token = null,
         lease_expires_at = null,
         lease_step = null,
         lease_thread_id = null,
         lease_authorization_revision = null
   where id = p_run_id;

  return jsonb_build_object(
    'result', 'ok',
    'threads_discovered', v_inserted,
    'enumeration_complete', p_next_page_token is null
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5e. COMMIT ONE FETCHED THREAD
-- ---------------------------------------------------------------------------
-- ONE transaction: the raw message upserts, the thread's completion, and the
-- run counters. A thread marked complete whose messages did not land would be a
-- state claiming success without its data.
--
-- `p_messages` is a jsonb array produced by the application's sanitizer. Its
-- SHAPE is validated here; its CONTENT policy is the sanitizer's job and is
-- asserted by tests against the persisted rows.
create or replace function public.gmail_historical_import_commit_thread(
  p_user_id uuid,
  p_run_id uuid,
  p_lease_token uuid,
  p_expected_authorization_revision bigint,
  p_provider_thread_id text,
  p_messages jsonb,
  p_quota_units integer,
  p_text_parts_omitted_external integer,
  p_attachment_or_nontext_parts_omitted integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_guard text;
  v_run private.gmail_historical_import_runs%rowtype;
  v_thread private.gmail_historical_import_threads%rowtype;
  v_msg jsonb;
  v_stored integer := 0;
  v_updated integer := 0;
  v_existing private.gmail_raw_messages%rowtype;
  v_internal timestamptz;
begin
  select r.* into v_run
    from private.gmail_historical_import_runs r
   where r.id = p_run_id and r.user_id = p_user_id
   for no key update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  v_guard := private.gmail_import_commit_guard(
    v_run, p_lease_token, 'fetch_thread', p_expected_authorization_revision);

  if v_guard <> 'ok' then
    if v_guard not in ('not_found', 'stale_lease', 'authorization_revision_required') then
      perform private.gmail_import_release_lease(p_run_id);
    end if;
    -- The connection state travels with the refusal so the worker can tell a
    -- Disconnect from a withdrawn consent without asking a second question.
    -- The connection state AND the run's own status travel with the refusal.
    -- A mailbox lifecycle change stops runs durably now, so by the time a stale
    -- response arrives the run is already cancelled or paused, and the worker
    -- must report THAT rather than "we will try again later".
    return jsonb_build_object(
      'result', v_guard,
      'run_status', v_run.status,
      'connection_state',
      (select m.connection_state from public.mail_accounts m where m.id = v_run.mail_account_id));
  end if;

  -- THE LEASE NAMES ONE THREAD. Holding a valid token for thread T1 is not
  -- permission to record a result against T2.
  if v_run.lease_thread_id is distinct from p_provider_thread_id then
    return jsonb_build_object('result', 'stale_lease');
  end if;

  select t.* into v_thread
    from private.gmail_historical_import_threads t
   where t.run_id = p_run_id and t.provider_thread_id = p_provider_thread_id
   for no key update;

  if not found then
    perform private.gmail_import_release_lease(p_run_id);
    return jsonb_build_object('result', 'thread_not_found');
  end if;

  if v_thread.status <> 'pending' then
    perform private.gmail_import_release_lease(p_run_id);
    return jsonb_build_object('result', 'already_applied');
  end if;

  for v_msg in select * from jsonb_array_elements(coalesce(p_messages, '[]'::jsonb))
  loop
    if coalesce(btrim(v_msg ->> 'provider_message_id'), '') = ''
       or coalesce(btrim(v_msg ->> 'provider_thread_id'), '') = ''
       or (v_msg ->> 'internal_date') is null
       or (v_msg -> 'sanitized_payload') is null
       or coalesce(v_msg ->> 'payload_sha256', '') !~ '^[0-9a-f]{64}$' then
      raise exception 'gmail_historical_import_commit_thread received a malformed sanitized message'
        using errcode = 'invalid_parameter_value';
    end if;

    -- THE THREAD A MESSAGE CLAIMS MUST BE THE THREAD WE FETCHED. A response
    -- that disagrees with its own request is a provider integrity problem, not
    -- something to normalize away.
    if (v_msg ->> 'provider_thread_id') <> p_provider_thread_id then
      raise exception
        'sanitized message % claims provider thread % inside a fetch of thread %',
        v_msg ->> 'provider_message_id', v_msg ->> 'provider_thread_id', p_provider_thread_id
        using errcode = 'integrity_constraint_violation';
    end if;

    v_internal := (v_msg ->> 'internal_date')::timestamptz;

    -- THE LOCAL WINDOW IS AUTHORITATIVE. Gmail's search decides what is
    -- offered; this decides what is kept. Half-open on purpose, so two adjacent
    -- windows neither overlap nor leave a gap.
    if v_internal < v_run.window_start_at or v_internal >= v_run.window_end_at then
      continue;
    end if;

    select r.* into v_existing
      from private.gmail_raw_messages r
     where r.mail_account_id = v_run.mail_account_id
       and r.provider_message_id = (v_msg ->> 'provider_message_id');

    if not found then
      insert into private.gmail_raw_messages
        (mail_account_id, user_id, provider_message_id, provider_thread_id, internal_date,
         provider_history_id, label_ids, sanitized_payload, payload_sha256,
         first_import_run_id, last_import_run_id)
      values
        (v_run.mail_account_id, v_run.user_id,
         v_msg ->> 'provider_message_id', v_msg ->> 'provider_thread_id', v_internal,
         v_msg ->> 'provider_history_id',
         coalesce(
           (select array_agg(value::text) from jsonb_array_elements_text(v_msg -> 'label_ids')),
           '{}'::text[]),
         v_msg -> 'sanitized_payload', v_msg ->> 'payload_sha256',
         p_run_id, p_run_id);
      v_stored := v_stored + 1;

    elsif v_existing.payload_sha256 is distinct from (v_msg ->> 'payload_sha256') then
      -- The provider's snapshot of this message changed — new labels, a new
      -- history id, an edited approved header. One row, updated.
      update private.gmail_raw_messages
         set provider_thread_id = v_msg ->> 'provider_thread_id',
             internal_date = v_internal,
             provider_history_id = v_msg ->> 'provider_history_id',
             label_ids = coalesce(
               (select array_agg(value::text) from jsonb_array_elements_text(v_msg -> 'label_ids')),
               '{}'::text[]),
             sanitized_payload = v_msg -> 'sanitized_payload',
             payload_sha256 = v_msg ->> 'payload_sha256',
             last_import_run_id = p_run_id,
             last_seen_at = now()
       where mail_account_id = v_run.mail_account_id
         and provider_message_id = (v_msg ->> 'provider_message_id');
      v_updated := v_updated + 1;

    else
      -- Identical snapshot. Record that this run saw it and write nothing else:
      -- an unchanged message is not an event.
      update private.gmail_raw_messages
         set last_import_run_id = p_run_id,
             last_seen_at = now()
       where mail_account_id = v_run.mail_account_id
         and provider_message_id = (v_msg ->> 'provider_message_id');
    end if;
  end loop;

  update private.gmail_historical_import_threads
     set status = 'complete',
         completed_at = now(),
         last_error_code = null
   where id = v_thread.id;

  update private.gmail_historical_import_runs
     set threads_completed = threads_completed + 1,
         messages_stored = messages_stored + v_stored,
         messages_updated = messages_updated + v_updated,
         text_parts_omitted_external =
           text_parts_omitted_external + greatest(coalesce(p_text_parts_omitted_external, 0), 0),
         attachment_or_nontext_parts_omitted =
           attachment_or_nontext_parts_omitted
             + greatest(coalesce(p_attachment_or_nontext_parts_omitted, 0), 0),
         estimated_gmail_quota_units =
           estimated_gmail_quota_units + greatest(coalesce(p_quota_units, 0), 0),
         last_error_code = null,
         lease_token = null,
         lease_expires_at = null,
         lease_step = null,
         lease_thread_id = null,
         lease_authorization_revision = null
   where id = p_run_id;

  return jsonb_build_object('result', 'ok', 'stored', v_stored, 'updated', v_updated);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5f. A THREAD THAT IS NO LONGER THERE
-- ---------------------------------------------------------------------------
-- Gmail can lose a thread between enumeration and retrieval — the human deleted
-- it, or it was purged. That is a terminal outcome for one work item and NOT a
-- run failure, and it certainly does not license inventing a message row. B03
-- is a snapshot of what Gmail exposes at import time, not an archival promise.
create or replace function public.gmail_historical_import_record_thread_gone(
  p_user_id uuid,
  p_run_id uuid,
  p_lease_token uuid,
  p_expected_authorization_revision bigint,
  p_provider_thread_id text,
  p_quota_units integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_guard text;
  v_run private.gmail_historical_import_runs%rowtype;
  v_thread private.gmail_historical_import_threads%rowtype;
begin
  select r.* into v_run
    from private.gmail_historical_import_runs r
   where r.id = p_run_id and r.user_id = p_user_id
   for no key update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- A VANISHED THREAD IS STILL A PROVIDER RESULT. It was obtained by a call made
  -- under one authorization, and marking a work item terminal is a mutation like
  -- any other, so it is fenced like any other.
  v_guard := private.gmail_import_commit_guard(
    v_run, p_lease_token, 'fetch_thread', p_expected_authorization_revision);

  if v_guard <> 'ok' then
    if v_guard not in ('not_found', 'stale_lease', 'authorization_revision_required') then
      perform private.gmail_import_release_lease(p_run_id);
    end if;
    -- The connection state travels with the refusal so the worker can tell a
    -- Disconnect from a withdrawn consent without asking a second question.
    -- The connection state AND the run's own status travel with the refusal.
    -- A mailbox lifecycle change stops runs durably now, so by the time a stale
    -- response arrives the run is already cancelled or paused, and the worker
    -- must report THAT rather than "we will try again later".
    return jsonb_build_object(
      'result', v_guard,
      'run_status', v_run.status,
      'connection_state',
      (select m.connection_state from public.mail_accounts m where m.id = v_run.mail_account_id));
  end if;

  -- THE LEASE NAMES ONE THREAD. Holding a valid token for thread T1 is not
  -- permission to record a result against T2.
  if v_run.lease_thread_id is distinct from p_provider_thread_id then
    return jsonb_build_object('result', 'stale_lease');
  end if;

  select t.* into v_thread
    from private.gmail_historical_import_threads t
   where t.run_id = p_run_id and t.provider_thread_id = p_provider_thread_id
   for no key update;

  if not found or v_thread.status <> 'pending' then
    perform private.gmail_import_release_lease(p_run_id);
    return jsonb_build_object('result', 'already_applied');
  end if;

  update private.gmail_historical_import_threads
     set status = 'gone', completed_at = now(), last_error_code = 'thread_not_found'
   where id = v_thread.id;

  update private.gmail_historical_import_runs
     set threads_gone = threads_gone + 1,
         estimated_gmail_quota_units =
           estimated_gmail_quota_units + greatest(coalesce(p_quota_units, 0), 0),
         lease_token = null,
         lease_expires_at = null,
         lease_step = null,
         lease_thread_id = null,
         lease_authorization_revision = null
   where id = p_run_id;

  return jsonb_build_object('result', 'ok');
end;
$$;

-- ---------------------------------------------------------------------------
-- 5g. RETRY, AND THE END OF RETRYING
-- ---------------------------------------------------------------------------
-- Records a transient provider failure and schedules the next attempt.
--
-- TWO KINDS OF WORK FAIL HERE, and only one of them has a row of its own.
--
-- A thread fetch has a work item, so its attempt count and its next attempt
-- live on that item. An ENUMERATION page has nothing but the run: there is no
-- `messages.list` entity to count against, which is exactly why the run itself
-- has to carry the enumeration attempt count and the enumeration schedule.
-- Without them a listing call that keeps answering 429 is retried by whoever
-- polls next, forever, remembering nothing — an unbounded loop wearing the
-- costume of a retry policy.
--
-- Either way this is a PROVIDER RESULT arriving from a claimed step, so it is
-- fenced exactly like a successful one: the lease token, the lease step, the
-- exact thread when there is one, and the authorization revision the claim was
-- issued under.
create or replace function public.gmail_historical_import_record_retry(
  p_user_id uuid,
  p_run_id uuid,
  p_lease_token uuid,
  p_expected_authorization_revision bigint,
  p_provider_thread_id text,
  p_error_code text,
  p_retry_after_seconds integer,
  p_quota_units integer,
  p_max_attempts integer default 5
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_guard text;
  v_run private.gmail_historical_import_runs%rowtype;
  v_thread private.gmail_historical_import_threads%rowtype;
  v_attempts integer;
  v_max integer := greatest(coalesce(p_max_attempts, 5), 1);
  v_delay integer := greatest(coalesce(p_retry_after_seconds, 1), 0);
  v_terminal boolean := false;
  v_run_failed boolean := false;
begin
  if p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'gmail_historical_import_record_retry requires a sanitized error code'
      using errcode = 'invalid_parameter_value';
  end if;

  select r.* into v_run
    from private.gmail_historical_import_runs r
   where r.id = p_run_id and r.user_id = p_user_id
   for no key update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- THE STEP THE FAILURE BELONGS TO IS DECIDED BY THE PRESENCE OF A THREAD, and
  -- then PROVED against the lease. A caller cannot record an enumeration
  -- failure while holding a thread lease, or the reverse.
  v_guard := private.gmail_import_commit_guard(
    v_run,
    p_lease_token,
    case when p_provider_thread_id is null then 'enumerate_page' else 'fetch_thread' end,
    p_expected_authorization_revision);

  if v_guard <> 'ok' then
    -- NOTHING IS RECORDED. An attempt count is a durable claim that we asked
    -- Google something under a particular authorization; a response from an
    -- authorization that has since changed does not get to make that claim, and
    -- it does not get to push a work item closer to `failed` either.
    if v_guard not in ('not_found', 'stale_lease', 'authorization_revision_required') then
      perform private.gmail_import_release_lease(p_run_id);
    end if;
    -- The connection state AND the run's own status travel with the refusal.
    -- A mailbox lifecycle change stops runs durably now, so by the time a stale
    -- response arrives the run is already cancelled or paused, and the worker
    -- must report THAT rather than "we will try again later".
    return jsonb_build_object(
      'result', v_guard,
      'run_status', v_run.status,
      'connection_state',
      (select m.connection_state from public.mail_accounts m where m.id = v_run.mail_account_id));
  end if;

  if p_provider_thread_id is null then
    -- ENUMERATION. The budget belongs to the CURRENT cursor position.
    v_attempts := v_run.enumeration_attempt_count + 1;
    v_terminal := v_attempts >= v_max;
    v_run_failed := v_terminal;

    update private.gmail_historical_import_runs
       set enumeration_attempt_count = v_attempts,
           enumeration_next_attempt_at =
             case when v_terminal then null else now() + make_interval(secs => v_delay) end,
           status = case when v_terminal then 'failed' else status end,
           phase = case when v_terminal then 'finished' else phase end,
           completed_at = case when v_terminal then now() else completed_at end,
           last_error_code = p_error_code,
           estimated_gmail_quota_units =
             estimated_gmail_quota_units + greatest(coalesce(p_quota_units, 0), 0),
           lease_token = null,
           lease_expires_at = null,
           lease_step = null,
           lease_thread_id = null,
           lease_authorization_revision = null
     where id = p_run_id;

    return jsonb_build_object(
      'result', 'ok',
      'scope', 'enumeration',
      'attempt_count', v_attempts,
      'thread_failed', false,
      'run_failed', v_run_failed);
  end if;

  -- THE LEASE NAMES ONE THREAD. A valid token for T1 may not record a failure
  -- against T2 — that would let one claimed step spend another item's budget.
  if v_run.lease_thread_id is distinct from p_provider_thread_id then
    return jsonb_build_object('result', 'stale_lease');
  end if;

  select t.* into v_thread
    from private.gmail_historical_import_threads t
   where t.run_id = p_run_id and t.provider_thread_id = p_provider_thread_id
   for no key update;

  if found and v_thread.status = 'pending' then
    v_attempts := v_thread.attempt_count + 1;
    v_terminal := v_attempts >= v_max;

    update private.gmail_historical_import_threads
       set attempt_count = v_attempts,
           last_error_code = p_error_code,
           status = case when v_terminal then 'failed' else 'pending' end,
           completed_at = case when v_terminal then now() else null end,
           next_attempt_at = now() + make_interval(secs => v_delay)
     where id = v_thread.id;
  end if;

  update private.gmail_historical_import_runs
     set last_error_code = p_error_code,
         estimated_gmail_quota_units =
           estimated_gmail_quota_units + greatest(coalesce(p_quota_units, 0), 0),
         lease_token = null,
         lease_expires_at = null,
         lease_step = null,
         lease_thread_id = null,
         lease_authorization_revision = null
   where id = p_run_id;

  return jsonb_build_object(
    'result', 'ok',
    'scope', 'thread',
    'attempt_count', coalesce(v_attempts, 0),
    'thread_failed', v_terminal,
    'run_failed', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5h. PAUSE, CANCEL, RESUME
-- ---------------------------------------------------------------------------
-- B02 owns the answer to "may we read this mailbox". B03 only reacts to it, and
-- never by reconnecting or re-granting anything on a human's behalf.
create or replace function public.gmail_historical_import_pause(
  p_user_id uuid,
  p_run_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_run private.gmail_historical_import_runs%rowtype;
  v_status text;
begin
  if p_reason not in ('reauth', 'consent') then
    raise exception 'gmail_historical_import_pause accepts only reauth or consent'
      using errcode = 'invalid_parameter_value';
  end if;

  select r.* into v_run
    from private.gmail_historical_import_runs r
   where r.id = p_run_id and r.user_id = p_user_id
   for no key update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_run.status <> 'runnable' then
    return jsonb_build_object('result', 'not_runnable', 'status', v_run.status);
  end if;

  v_status := case when p_reason = 'reauth' then 'paused_reauth' else 'paused_consent' end;

  update private.gmail_historical_import_runs
     set status = v_status,
         last_error_code = case when p_reason = 'reauth' then 'reauth_required' else 'consent_missing' end,
         lease_token = null,
         lease_expires_at = null,
         lease_step = null,
         lease_thread_id = null,
         lease_authorization_revision = null
   where id = p_run_id;

  return jsonb_build_object('result', 'ok', 'status', v_status);
end;
$$;

-- A Disconnect or a deletion ends the run. It does NOT delete what was already
-- imported: B01 is explicit that stopping access and removing data are
-- different acts, and B02 amendment #5 made the same separation for the
-- credential. A cancelled run does not resurrect itself on reconnection —
-- starting again is a decision, and decisions are explicit here.
create or replace function public.gmail_historical_import_cancel_connection_stopped(
  p_user_id uuid,
  p_run_id uuid,
  p_connection_state text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_run private.gmail_historical_import_runs%rowtype;
begin
  select r.* into v_run
    from private.gmail_historical_import_runs r
   where r.id = p_run_id and r.user_id = p_user_id
   for no key update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_run.status in ('cancelled_connection_stopped', 'failed', 'completed') then
    return jsonb_build_object('result', 'already_terminal', 'status', v_run.status);
  end if;

  update private.gmail_historical_import_runs
     set status = 'cancelled_connection_stopped',
         phase = 'finished',
         completed_at = now(),
         last_error_code = 'connection_stopped',
         lease_token = null,
         lease_expires_at = null,
         lease_step = null,
         lease_thread_id = null,
         lease_authorization_revision = null
   where id = p_run_id;

  return jsonb_build_object('result', 'ok', 'connection_state', p_connection_state);
end;
$$;

-- Resuming is an EXPLICIT operator/server action, and it re-asks the same
-- question a claim asks. A run paused because consent was withdrawn does not
-- restart because a worker happened to poll.
create or replace function public.gmail_historical_import_resume(
  p_user_id uuid,
  p_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_run private.gmail_historical_import_runs%rowtype;
  v_auth text;
begin
  select r.* into v_run
    from private.gmail_historical_import_runs r
   where r.id = p_run_id and r.user_id = p_user_id
   for no key update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_run.status not in ('paused_reauth', 'paused_consent') then
    return jsonb_build_object('result', 'not_paused', 'status', v_run.status);
  end if;

  v_auth := private.gmail_import_authorization_state(v_run.mail_account_id, null);
  if v_auth <> 'ok' then
    return jsonb_build_object('result', v_auth);
  end if;

  update private.gmail_historical_import_runs
     set status = 'runnable', last_error_code = null
   where id = p_run_id;

  return jsonb_build_object('result', 'ok');
end;
$$;

-- ---------------------------------------------------------------------------
-- 5i. COMPLETE — and it has to be true
-- ---------------------------------------------------------------------------
-- `completed` means enumeration finished, nothing is pending, and nothing
-- failed permanently. A run with a permanently failed thread is `failed`, even
-- though most of its work succeeded, because calling a partial import complete
-- is how a later layer ends up reasoning about history it never actually saw.
create or replace function public.gmail_historical_import_commit_completion(
  p_user_id uuid,
  p_run_id uuid,
  p_lease_token uuid,
  p_expected_authorization_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_guard text;
  v_run private.gmail_historical_import_runs%rowtype;
  v_pending integer;
  v_failed integer;
  v_status text;
begin
  select r.* into v_run
    from private.gmail_historical_import_runs r
   where r.id = p_run_id and r.user_id = p_user_id
   for no key update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- NO GMAIL CALL HAPPENS FOR THIS STEP, AND IT IS STILL FENCED.
  --
  -- The gap between claiming `complete_run` and committing it is small, but it
  -- is not zero, and what can change inside it is a HUMAN DECISION: a Disconnect
  -- in that window would otherwise be overwritten by a run declaring itself
  -- `completed` under an authorization that no longer exists. Stamping a
  -- terminal, quotable status onto a run is a mutation, and mutations here name
  -- the revision they were decided under.
  v_guard := private.gmail_import_commit_guard(
    v_run, p_lease_token, 'complete_run', p_expected_authorization_revision);

  if v_guard <> 'ok' then
    if v_guard not in ('not_found', 'stale_lease', 'authorization_revision_required') then
      perform private.gmail_import_release_lease(p_run_id);
    end if;
    -- The connection state AND the run's own status travel with the refusal.
    -- A mailbox lifecycle change stops runs durably now, so by the time a stale
    -- response arrives the run is already cancelled or paused, and the worker
    -- must report THAT rather than "we will try again later".
    return jsonb_build_object(
      'result', v_guard,
      'run_status', v_run.status,
      'connection_state',
      (select m.connection_state from public.mail_accounts m where m.id = v_run.mail_account_id));
  end if;

  if v_run.enumeration_completed_at is null then
    perform private.gmail_import_release_lease(p_run_id);
    return jsonb_build_object('result', 'enumeration_incomplete');
  end if;

  select count(*) filter (where status = 'pending'),
         count(*) filter (where status = 'failed')
    into v_pending, v_failed
    from private.gmail_historical_import_threads
   where run_id = p_run_id;

  if v_pending > 0 then
    perform private.gmail_import_release_lease(p_run_id);
    return jsonb_build_object('result', 'work_remaining', 'pending', v_pending);
  end if;

  v_status := case when v_failed > 0 then 'failed' else 'completed' end;

  update private.gmail_historical_import_runs
     set status = v_status,
         phase = 'finished',
         completed_at = now(),
         last_error_code = case when v_failed > 0 then 'thread_failures' else null end,
         lease_token = null,
         lease_expires_at = null,
         lease_step = null,
         lease_thread_id = null,
         lease_authorization_revision = null
   where id = p_run_id;

  return jsonb_build_object('result', 'ok', 'status', v_status, 'failed_threads', v_failed);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5j. STATUS — counts, never content
-- ---------------------------------------------------------------------------
-- Everything an operator needs to run the pilot, and nothing that would make
-- this a way to read somebody's mail. No subject, no address, no snippet, and
-- no provider thread ids.
create or replace function public.gmail_historical_import_status(
  p_user_id uuid,
  p_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_run private.gmail_historical_import_runs%rowtype;
  v_pending integer;
  v_complete integer;
  v_gone integer;
  v_failed integer;
begin
  select r.* into v_run
    from private.gmail_historical_import_runs r
   where r.id = p_run_id and r.user_id = p_user_id;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  select count(*) filter (where status = 'pending'),
         count(*) filter (where status = 'complete'),
         count(*) filter (where status = 'gone'),
         count(*) filter (where status = 'failed')
    into v_pending, v_complete, v_gone, v_failed
    from private.gmail_historical_import_threads
   where run_id = p_run_id;

  return jsonb_build_object(
    'result', 'ok',
    'run_id', v_run.id,
    'status', v_run.status,
    'phase', v_run.phase,
    'acquisition_strategy', v_run.acquisition_strategy,
    'window_start_at', v_run.window_start_at,
    'window_end_at', v_run.window_end_at,
    'enumeration_complete', v_run.enumeration_completed_at is not null,
    -- Operational counts, so a stalled enumeration is visible as a number
    -- rather than as a run that simply never finishes.
    'enumeration_attempt_count', v_run.enumeration_attempt_count,
    'enumeration_next_attempt_at', v_run.enumeration_next_attempt_at,
    'candidate_sent_messages_seen', v_run.candidate_sent_messages_seen,
    'unique_threads_discovered', v_run.unique_threads_discovered,
    'threads_pending', v_pending,
    'threads_completed', v_complete,
    'threads_gone', v_gone,
    'threads_failed', v_failed,
    'messages_stored', v_run.messages_stored,
    'messages_updated', v_run.messages_updated,
    'text_parts_omitted_external', v_run.text_parts_omitted_external,
    'attachment_or_nontext_parts_omitted', v_run.attachment_or_nontext_parts_omitted,
    'estimated_gmail_quota_units', v_run.estimated_gmail_quota_units,
    'last_error_code', v_run.last_error_code,
    'created_at', v_run.created_at,
    'completed_at', v_run.completed_at
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5k. DELETION PURGE
-- ---------------------------------------------------------------------------
-- B01 promised every future Gmail-derived row would be deletion-addressable.
-- B03 creates the first ones, so the promise stops being prose here.
--
-- This removes B03 data and NOTHING else. It does not touch consent history,
-- does not release provider ownership, does not change the request's scope and
-- does not declare the deletion finished — future deletion orchestration owns
-- that, and a data layer that marked its own request complete would be grading
-- its own homework.
create or replace function public.gmail_historical_import_purge_for_deletion(
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
  v_messages integer;
  v_threads integer;
  v_runs integer;
begin
  select m.* into v_account
    from public.mail_accounts m
   where m.id = p_mail_account_id and m.user_id = p_user_id
   for no key update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- ONLY WHILE A DELETION IS ACTUALLY RUNNING. Purging Gmail content is not a
  -- maintenance operation and must not be reachable as one.
  if v_account.connection_state <> 'deletion_pending' then
    return jsonb_build_object('result', 'not_deleting',
                              'connection_state', v_account.connection_state);
  end if;

  -- AND ONLY FOR THE REQUEST THE MAILBOX IS ACTUALLY WAITING ON. A caller
  -- naming some other request — an older one, one belonging to another mailbox
  -- — is not carrying out this deletion.
  if v_account.current_deletion_request_id is distinct from p_deletion_request_id then
    return jsonb_build_object('result', 'stale_deletion_request');
  end if;

  select r.* into v_request
    from public.mail_account_deletion_requests r
   where r.id = p_deletion_request_id;

  if not found
     or v_request.mail_account_id <> p_mail_account_id
     or v_request.user_id <> p_user_id then
    return jsonb_build_object('result', 'stale_deletion_request');
  end if;

  if v_request.status not in ('requested', 'in_progress') then
    return jsonb_build_object('result', 'request_not_running', 'status', v_request.status);
  end if;

  if v_request.scope not in ('gmail_derived_data', 'account_and_gmail_derived_data') then
    return jsonb_build_object('result', 'scope_excludes_gmail_data', 'scope', v_request.scope);
  end if;

  with removed as (
    delete from private.gmail_raw_messages r
     where r.mail_account_id = p_mail_account_id returning 1
  ) select count(*)::int into v_messages from removed;

  with removed as (
    delete from private.gmail_historical_import_threads t
     where t.mail_account_id = p_mail_account_id returning 1
  ) select count(*)::int into v_threads from removed;

  with removed as (
    delete from private.gmail_historical_import_runs x
     where x.mail_account_id = p_mail_account_id returning 1
  ) select count(*)::int into v_runs from removed;

  return jsonb_build_object(
    'result', 'ok',
    'raw_messages_removed', v_messages,
    'thread_work_removed', v_threads,
    'runs_removed', v_runs
  );
end;
$$;

-- ===========================================================================
-- 6. EXECUTE PRIVILEGES — service_role AND NOBODY ELSE
-- ===========================================================================
-- The same reasoning as 0036 §5, and it has to be repeated rather than
-- inherited: these are definer-rights doors into a schema no client may enter,
-- and hosted Supabase projects may grant EXECUTE to client roles by default.
--
-- `service_role` is a CAPABILITY, not an authorization. Every function above
-- takes the owner as part of its lookup for exactly that reason.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.gmail_historical_import_start(uuid,uuid,timestamptz)',
    'public.gmail_historical_import_claim_step(uuid,uuid,integer)',
    'public.gmail_historical_import_validate_claim(uuid,uuid,uuid,bigint,text,text)',
    'public.gmail_historical_import_commit_page(uuid,uuid,uuid,bigint,text,text,text[],integer,integer)',
    'public.gmail_historical_import_commit_thread(uuid,uuid,uuid,bigint,text,jsonb,integer,integer,integer)',
    'public.gmail_historical_import_record_thread_gone(uuid,uuid,uuid,bigint,text,integer)',
    'public.gmail_historical_import_record_retry(uuid,uuid,uuid,bigint,text,text,integer,integer,integer)',
    'public.gmail_historical_import_pause(uuid,uuid,text)',
    'public.gmail_historical_import_cancel_connection_stopped(uuid,uuid,text)',
    'public.gmail_historical_import_resume(uuid,uuid)',
    'public.gmail_historical_import_commit_completion(uuid,uuid,uuid,bigint)',
    'public.gmail_historical_import_status(uuid,uuid)',
    'public.gmail_historical_import_purge_for_deletion(uuid,uuid,uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- ===========================================================================
-- 7. WHAT 0037 DOES NOT CREATE
-- ===========================================================================
-- No normalized thread, message, participant or address table — B04.
-- No outreach detection, hotel match or canonical hotel write — B05.
-- No sent/reply/timing fact — B06.
-- No outcome, correction or creator feedback — B07.
-- No history cursor, watch subscription or incremental sync state — B08.
-- No network-intelligence eligibility, aggregate or contribution flag.
-- No attachment table, and no column that could hold attachment bytes.
-- No client-readable view of raw Gmail content, for any role.
--
-- And this migration performs no import: it connects no mailbox, fetches
-- nothing, infers no consent and creates no run.
