-- ===========================================================================
-- 0047 — B08 incremental Gmail sync (D076)
-- ===========================================================================
-- Polls Gmail history.list forward from the last completed historical-import
-- window end. Same sent-rooted inclusion rule as D068. No Pub/Sub, no
-- gmail.send, no new scope. 0045 is B07.1 on main. 0046 is D01 on main
-- (PR #52). This file stays 0047.
--
-- The 15-minute cadence is a database due-time, discharged by the same
-- operator-worker entrypoint the repo already uses for Gmail jobs. There is
-- no cron daemon in this repository (B03). Creator login sets the due flag.
--
-- A bounded re-scan captures users.getProfile before messages.list and
-- threads.get, and completion stores that earlier historyId. That
-- messages.list omits before:, because before:ceil(window_end) drops a sent
-- message already inside the snapshot. Committing the profile snapshot, or a
-- history.list page, moves window_end_at to that same clock before those
-- later reads filter on it. A non-draft sent message that was inside the
-- snapshot is stored even when its internalDate is slightly later than that
-- clock. A snapshot sent message dated before window_start_at is an
-- intentional exclusion and does not freeze the cursor. Completion does not
-- advance history_id past a non-draft sent snapshot message this run did not
-- store for any other reason. The pipeline step
-- holds a cursor lease, renewed while the pipeline is still running, so two
-- workers cannot both insert attempts.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table private.gmail_sync_cursors (
  mail_account_id uuid primary key,
  user_id uuid not null,
  -- Gmail's mailbox historyId. Null until the first successful capture, and
  -- cleared when that id is rejected with 404 so the next step is a bounded
  -- re-scan rather than a retry of a dead cursor.
  history_id text
    check (history_id is null or length(btrim(history_id)) > 0),
  -- The forward edge. Starts at the greatest completed B03 window_end_at and
  -- advances only when a sync run completes. Half-open with the next run.
  horizon_end_at timestamptz not null,
  next_sync_at timestamptz not null,
  login_sync_requested boolean not null default false,
  pipeline_pending boolean not null default false,
  -- Held while a worker runs the local pipeline. A concurrent login and
  -- gmail:sync:work both see this lease and only one of them inserts
  -- commercial attempts. Cleared by mark_pipeline_done when the token matches,
  -- or by release_pipeline when the pipeline is not finished. An expired
  -- lease can be taken by the next claim.
  pipeline_lease_token uuid,
  pipeline_lease_expires_at timestamptz,
  constraint gmail_sync_cursors_pipeline_lease_pair check (
    (pipeline_lease_token is null) = (pipeline_lease_expires_at is null)
  ),
  updated_at timestamptz not null default pg_catalog.now(),

  constraint gmail_sync_cursors_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade
);

comment on table private.gmail_sync_cursors is
  'B08: one resumable historyId and forward horizon per mailbox. No message content.';

create table private.gmail_sync_runs (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  user_id uuid not null,
  mail_account_id uuid not null,
  status text not null default 'runnable'
    check (status in (
      'runnable', 'paused_reauth', 'paused_consent',
      'cancelled_connection_stopped', 'failed', 'completed'
    )),
  mode text not null
    check (mode in ('history_list', 'bounded_rescan')),
  acquisition_strategy text not null default 'sent_rooted_threads_v1'
    check (acquisition_strategy = 'sent_rooted_threads_v1'),
  window_start_at timestamptz not null,
  window_end_at timestamptz not null,
  constraint gmail_sync_runs_window_order check (window_start_at < window_end_at),
  history_id_start text,
  history_id_latest text,
  -- True when a non-draft SENT message from this snapshot was seen and not stored.
  snapshot_sent_withheld boolean not null default false,
  page_token text,
  enumeration_complete boolean not null default false,
  known_threads_enqueued boolean not null default false,
  known_threads_after text,
  step_attempt_count integer not null default 0 check (step_attempt_count >= 0),
  next_attempt_at timestamptz,
  messages_stored integer not null default 0 check (messages_stored >= 0),
  messages_updated integer not null default 0 check (messages_updated >= 0),
  threads_filtered_out integer not null default 0 check (threads_filtered_out >= 0),
  estimated_gmail_quota_units bigint not null default 0 check (estimated_gmail_quota_units >= 0),
  last_error_code text
    check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  lease_token uuid,
  lease_expires_at timestamptz,
  lease_step text
    check (lease_step is null or lease_step in (
      'enumerate_history', 'enumerate_sent', 'enqueue_known',
      'fetch_thread', 'capture_history', 'complete_run'
    )),
  lease_thread_id text,
  lease_authorization_revision bigint,
  created_at timestamptz not null default pg_catalog.now(),
  completed_at timestamptz,

  constraint gmail_sync_runs_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,
  constraint gmail_sync_runs_lease_shape check (
    (lease_token is null and lease_expires_at is null and lease_step is null
     and lease_thread_id is null and lease_authorization_revision is null)
    or (lease_token is not null and lease_expires_at is not null and lease_step is not null
        and lease_authorization_revision is not null)
  ),
  constraint gmail_sync_runs_lease_thread_iff check (
    lease_step is distinct from 'fetch_thread' or lease_thread_id is not null
  ),
  constraint gmail_sync_runs_terminal_shape check (
    (status in ('cancelled_connection_stopped', 'failed', 'completed')) = (completed_at is not null)
  )
);

comment on table private.gmail_sync_runs is
  'B08: one forward sync of one mailbox. window_end_at starts at claim and moves to the history snapshot commit. history_list, or a bounded re-scan when the historyId is missing or rejected.';

create unique index gmail_sync_runs_one_active_uidx
  on private.gmail_sync_runs (mail_account_id)
  where status in ('runnable', 'paused_reauth', 'paused_consent');

create table private.gmail_sync_threads (
  id uuid primary key default pg_catalog.gen_random_uuid(),
  run_id uuid not null references private.gmail_sync_runs (id) on delete cascade,
  user_id uuid not null,
  mail_account_id uuid not null,
  provider_thread_id text not null check (length(btrim(provider_thread_id)) > 0),
  -- Ids history.list included in this snapshot. Empty on a bounded re-scan.
  snapshot_message_ids text[] not null default '{}',
  snapshot_sent_message_ids text[] not null default '{}',
  -- Snapshot sent ids whose internalDate is before the forward window.
  -- Those are excluded on purpose and do not freeze the cursor.
  snapshot_sent_excluded_ids text[] not null default '{}',
  status text not null default 'pending'
    check (status in ('pending', 'complete', 'filtered_out', 'gone', 'failed')),
  completed_at timestamptz,
  last_error_code text
    check (last_error_code is null or last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint gmail_sync_threads_run_thread_uk unique (run_id, provider_thread_id),
  constraint gmail_sync_threads_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade
);

comment on table private.gmail_sync_threads is
  'B08: per-run thread work. filtered_out means the thread was not sent-rooted under D068 and nothing from it was stored.';

create table private.gmail_sync_thread_coverage (
  mail_account_id uuid not null,
  user_id uuid not null,
  provider_thread_id text not null check (length(btrim(provider_thread_id)) > 0),
  run_id uuid not null references private.gmail_sync_runs (id) on delete cascade,
  observed_through_at timestamptz not null,
  primary key (mail_account_id, provider_thread_id, run_id),
  constraint gmail_sync_thread_coverage_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade
);

comment on table private.gmail_sync_thread_coverage is
  'B08: threads this sync actually fetched and accepted. B06 reads it only for completed runs, so the horizon moves per thread rather than for the whole mailbox.';

create index gmail_sync_thread_coverage_thread_idx
  on private.gmail_sync_thread_coverage (mail_account_id, provider_thread_id);

-- ---------------------------------------------------------------------------
-- Lifecycle: a disconnect cancels sync. Reconnect does not resurrect it.
-- A paused reauth/consent run becomes runnable again once the mailbox is
-- connected, because continuous sync while connected is the standing rule.
-- ---------------------------------------------------------------------------

create or replace function private.apply_gmail_lifecycle_to_sync_runs()
returns trigger
language plpgsql
set search_path = public, private, pg_temp
as $$
begin
  if new.connection_state is not distinct from old.connection_state then
    return null;
  end if;

  if new.connection_state in ('disconnecting', 'disconnected', 'deletion_pending', 'deleted') then
    update private.gmail_sync_runs
       set status = 'cancelled_connection_stopped',
           completed_at = pg_catalog.now(),
           last_error_code = 'connection_stopped',
           lease_token = null,
           lease_expires_at = null,
           lease_step = null,
           lease_thread_id = null,
           lease_authorization_revision = null
     where mail_account_id = new.id
       and status in ('runnable', 'paused_reauth', 'paused_consent');
    update private.gmail_sync_cursors
       set login_sync_requested = false,
           updated_at = pg_catalog.now()
     where mail_account_id = new.id;

  elsif new.connection_state in ('reauth_required', 'pending_authorization') then
    update private.gmail_sync_runs
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
    update private.gmail_sync_runs
       set status = 'paused_consent',
           last_error_code = 'consent_missing',
           lease_token = null,
           lease_expires_at = null,
           lease_step = null,
           lease_thread_id = null,
           lease_authorization_revision = null
     where mail_account_id = new.id
       and status = 'runnable';

  elsif new.connection_state = 'connected' then
    update private.gmail_sync_runs
       set status = 'runnable',
           last_error_code = null,
           next_attempt_at = null
     where mail_account_id = new.id
       and status in ('paused_reauth', 'paused_consent');
  end if;

  return null;
end;
$$;

revoke all on function private.apply_gmail_lifecycle_to_sync_runs() from public, anon, authenticated;

create trigger gmail_lifecycle_stops_sync_runs
  after update of connection_state on public.mail_accounts
  for each row execute function private.apply_gmail_lifecycle_to_sync_runs();

-- ---------------------------------------------------------------------------
-- Deleted mailbox cannot keep sync state
-- ---------------------------------------------------------------------------

create or replace function public.assert_gmail_sync_data_absent_when_deleted()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid;
  account_state text;
  cursor_count integer;
  run_count integer;
  thread_count integer;
  coverage_count integer;
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

  select count(*)::int into cursor_count
    from private.gmail_sync_cursors c where c.mail_account_id = account_id;
  select count(*)::int into run_count
    from private.gmail_sync_runs r where r.mail_account_id = account_id;
  select count(*)::int into thread_count
    from private.gmail_sync_threads t where t.mail_account_id = account_id;
  select count(*)::int into coverage_count
    from private.gmail_sync_thread_coverage c where c.mail_account_id = account_id;

  if cursor_count > 0 or run_count > 0 or thread_count > 0 or coverage_count > 0 then
    raise exception
      'mail account % is `deleted` while B08 sync state remains (% cursor, % run, % thread, % coverage). Deletion asserts stored Gmail sync state was removed.',
      account_id, cursor_count, run_count, thread_count, coverage_count
      using errcode = 'integrity_constraint_violation';
  end if;

  return null;
end;
$$;

revoke all on function public.assert_gmail_sync_data_absent_when_deleted() from public, anon, authenticated;

create constraint trigger mail_accounts_gmail_sync_absent_when_deleted
  after insert or update on public.mail_accounts
  deferrable initially deferred
  for each row execute function public.assert_gmail_sync_data_absent_when_deleted();

create constraint trigger gmail_sync_cursors_absent_when_deleted
  after insert or update on private.gmail_sync_cursors
  deferrable initially deferred
  for each row execute function public.assert_gmail_sync_data_absent_when_deleted();

create constraint trigger gmail_sync_runs_absent_when_deleted
  after insert or update on private.gmail_sync_runs
  deferrable initially deferred
  for each row execute function public.assert_gmail_sync_data_absent_when_deleted();

create constraint trigger gmail_sync_threads_absent_when_deleted
  after insert or update on private.gmail_sync_threads
  deferrable initially deferred
  for each row execute function public.assert_gmail_sync_data_absent_when_deleted();

create constraint trigger gmail_sync_coverage_absent_when_deleted
  after insert or update on private.gmail_sync_thread_coverage
  deferrable initially deferred
  for each row execute function public.assert_gmail_sync_data_absent_when_deleted();

-- ---------------------------------------------------------------------------
-- B06 horizon also sees a completed B08 fetch of this exact thread.
-- Unfetched threads stay at their B03 horizon. B06 already recomputes when
-- observed_through_at changes.
-- ---------------------------------------------------------------------------

create or replace function private.gmail_reply_observed_through_at(
  p_mail_account_id uuid,
  p_provider_thread_id text
)
returns timestamptz
language sql
stable
set search_path = public, private, pg_temp
as $$
  select greatest(
    (
      select max(r.window_end_at)
        from private.gmail_historical_import_threads t
        join private.gmail_historical_import_runs r on r.id = t.run_id
       where t.mail_account_id = p_mail_account_id
         and t.provider_thread_id = p_provider_thread_id
         and t.status = 'complete'
         and r.status = 'completed'
    ),
    (
      select max(c.observed_through_at)
        from private.gmail_sync_thread_coverage c
        join private.gmail_sync_runs r on r.id = c.run_id
       where c.mail_account_id = p_mail_account_id
         and c.provider_thread_id = p_provider_thread_id
         and r.status = 'completed'
    )
  );
$$;

revoke all on function private.gmail_reply_observed_through_at(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Lease helpers. search_path is pinned; callers are SECURITY DEFINER with
-- search_path '' and schema-qualify these names. Locks are held until the
-- outer transaction commits.
-- ---------------------------------------------------------------------------

create or replace function private.gmail_sync_release_lease(p_run_id uuid)
returns void
language sql
set search_path = public, private, pg_temp
as $$
  update private.gmail_sync_runs
     set lease_token = null,
         lease_expires_at = null,
         lease_step = null,
         lease_thread_id = null,
         lease_authorization_revision = null
   where id = p_run_id;
$$;

revoke all on function private.gmail_sync_release_lease(uuid) from public, anon, authenticated;

create or replace function private.gmail_sync_begin_commit(
  p_user_id uuid,
  p_run_id uuid,
  p_lease_token uuid,
  p_expected_step text,
  p_expected_authorization_revision bigint,
  p_expected_thread_id text
)
returns jsonb
language plpgsql
set search_path = public, private, pg_temp
as $$
declare
  v_run private.gmail_sync_runs%rowtype;
  v_auth text;
  v_state text;
begin
  if p_expected_authorization_revision is null then
    return jsonb_build_object('result', 'authorization_revision_required');
  end if;

  select r.* into v_run
    from private.gmail_sync_runs r
   where r.id = p_run_id and r.user_id = p_user_id
   for no key update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  select m.connection_state into v_state
    from public.mail_accounts m where m.id = v_run.mail_account_id;

  if v_run.lease_token is null
     or p_lease_token is null
     or v_run.lease_token <> p_lease_token
     or v_run.lease_expires_at <= pg_catalog.now()
     or v_run.lease_step is distinct from p_expected_step
     or (p_expected_step = 'fetch_thread' and v_run.lease_thread_id is distinct from p_expected_thread_id)
     or (p_expected_step <> 'fetch_thread' and p_expected_thread_id is not null) then
    return jsonb_build_object(
      'result', 'stale_lease',
      'run_status', v_run.status,
      'connection_state', v_state
    );
  end if;

  if v_run.status <> 'runnable' then
    return jsonb_build_object(
      'result', 'not_runnable',
      'run_status', v_run.status,
      'connection_state', v_state
    );
  end if;

  v_auth := private.gmail_import_authorization_state(
    v_run.mail_account_id, p_expected_authorization_revision);

  if v_auth <> 'ok' then
    if v_auth not in ('not_found', 'stale_lease', 'authorization_revision_required') then
      perform private.gmail_sync_release_lease(p_run_id);
    end if;
    return jsonb_build_object(
      'result', v_auth,
      'run_status', v_run.status,
      'connection_state', v_state
    );
  end if;

  return jsonb_build_object('result', 'ok');
end;
$$;

revoke all on function private.gmail_sync_begin_commit(uuid, uuid, uuid, text, bigint, text)
  from public, anon, authenticated;

create or replace function private.gmail_sync_backoff_cursor(p_mail_account_id uuid)
returns void
language sql
set search_path = public, private, pg_temp
as $$
  update private.gmail_sync_cursors
     set next_sync_at = pg_catalog.clock_timestamp() + interval '15 minutes',
         login_sync_requested = false,
         updated_at = pg_catalog.now()
   where mail_account_id = p_mail_account_id;
$$;

revoke all on function private.gmail_sync_backoff_cursor(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Horizon gate shared by claim and login.
-- Returns ok + horizon, or a refusal result.
-- ---------------------------------------------------------------------------

create or replace function private.gmail_sync_horizon(p_mail_account_id uuid)
returns jsonb
language plpgsql
stable
set search_path = public, private, pg_temp
as $$
declare
  v_horizon timestamptz;
  v_active boolean;
begin
  select exists (
    select 1 from private.gmail_historical_import_runs r
     where r.mail_account_id = p_mail_account_id
       and r.status in ('runnable', 'paused_reauth', 'paused_consent')
  ) into v_active;

  if v_active then
    return jsonb_build_object('result', 'historical_import_active');
  end if;

  select max(r.window_end_at) into v_horizon
    from private.gmail_historical_import_runs r
   where r.mail_account_id = p_mail_account_id
     and r.status = 'completed';

  if v_horizon is null then
    return jsonb_build_object('result', 'no_historical_horizon');
  end if;

  return jsonb_build_object('result', 'ok', 'horizon_end_at', v_horizon);
end;
$$;

revoke all on function private.gmail_sync_horizon(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Login: mark connected, horizon-backed mailboxes due. Does not read Gmail.
-- ---------------------------------------------------------------------------

create or replace function public.gmail_incremental_sync_request_login(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account record;
  v_horizon jsonb;
  v_ids uuid[] := '{}'::uuid[];
begin
  if p_user_id is null then
    raise exception 'gmail_incremental_sync_request_login requires a user'
      using errcode = 'invalid_parameter_value';
  end if;

  for v_account in
    select m.id, m.user_id
      from public.mail_accounts m
     where m.user_id = p_user_id
       and m.connection_state = 'connected'
     order by m.id
     for update
  loop
    v_horizon := private.gmail_sync_horizon(v_account.id);
    if v_horizon ->> 'result' <> 'ok' then
      continue;
    end if;

    insert into private.gmail_sync_cursors
      (mail_account_id, user_id, horizon_end_at, next_sync_at, login_sync_requested)
    values (
      v_account.id,
      v_account.user_id,
      (v_horizon ->> 'horizon_end_at')::timestamptz,
      pg_catalog.clock_timestamp(),
      true
    )
    on conflict (mail_account_id) do update
      set login_sync_requested = true,
          updated_at = pg_catalog.now();
    v_ids := array_append(v_ids, v_account.id);
  end loop;

  return jsonb_build_object(
    'result', 'ok',
    'mailboxes_marked', coalesce(array_length(v_ids, 1), 0),
    'mail_account_ids', to_jsonb(v_ids)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Due mailboxes for the operator worker. Ids only. No message content.
-- ---------------------------------------------------------------------------

create or replace function public.gmail_incremental_sync_list_due(p_limit integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'gmail_incremental_sync_list_due limit must be 1..100'
      using errcode = 'invalid_parameter_value';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', s.user_id,
           'mail_account_id', s.mail_account_id
         ) order by s.mail_account_id), '[]'::jsonb)
    into v_rows
    from (
      select m.user_id, m.id as mail_account_id
        from public.mail_accounts m
       where m.connection_state = 'connected'
         and exists (
           select 1 from private.gmail_historical_import_runs r
            where r.mail_account_id = m.id and r.status = 'completed'
         )
         and not exists (
           select 1 from private.gmail_historical_import_runs r
            where r.mail_account_id = m.id
              and r.status in ('runnable', 'paused_reauth', 'paused_consent')
         )
         and (
           not exists (
             select 1 from private.gmail_sync_cursors c where c.mail_account_id = m.id
           )
           or exists (
             select 1 from private.gmail_sync_cursors c
              where c.mail_account_id = m.id
                and (
                  c.login_sync_requested
                  or c.pipeline_pending
                  or c.next_sync_at <= pg_catalog.clock_timestamp()
                )
           )
           or exists (
             select 1 from private.gmail_sync_runs r
              where r.mail_account_id = m.id and r.status = 'runnable'
           )
         )
       order by m.id
       limit p_limit
    ) s;

  return jsonb_build_object('result', 'ok', 'accounts', v_rows);
end;
$$;

-- ---------------------------------------------------------------------------
-- Claim one step, or report why this mailbox is not being read.
-- ---------------------------------------------------------------------------

create or replace function public.gmail_incremental_sync_claim_step(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account public.mail_accounts%rowtype;
  v_cursor private.gmail_sync_cursors%rowtype;
  v_run private.gmail_sync_runs%rowtype;
  v_horizon jsonb;
  v_horizon_at timestamptz;
  v_auth text;
  v_step text;
  v_thread text;
  v_window_end timestamptz;
  v_token uuid;
  v_cursor_found boolean := false;
begin
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 600 then
    raise exception 'gmail_incremental_sync_claim_step lease must be 1..600 seconds'
      using errcode = 'invalid_parameter_value';
  end if;

  select m.* into v_account
    from public.mail_accounts m
   where m.id = p_mail_account_id and m.user_id = p_user_id
   for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_account.connection_state <> 'connected' then
    return jsonb_build_object(
      'result', 'not_connected',
      'connection_state', v_account.connection_state
    );
  end if;

  v_auth := private.gmail_import_authorization_state(v_account.id, v_account.authorization_revision);
  if v_auth <> 'ok' then
    return jsonb_build_object(
      'result', v_auth,
      'connection_state', v_account.connection_state
    );
  end if;

  -- Local pipeline catch-up never reads Gmail. It runs before a new poll so a
  -- crash between acquisition and normalization is not skipped for 15 minutes.
  select c.* into v_cursor
    from private.gmail_sync_cursors c
   where c.mail_account_id = v_account.id
   for update;

  v_cursor_found := found;

  if v_cursor_found and v_cursor.pipeline_pending
     and not exists (
       select 1 from private.gmail_sync_runs r
        where r.mail_account_id = v_account.id and r.status = 'runnable'
     ) then
    if v_cursor.pipeline_lease_token is not null
       and v_cursor.pipeline_lease_expires_at > pg_catalog.clock_timestamp() then
      return jsonb_build_object('result', 'leased');
    end if;

    v_token := pg_catalog.gen_random_uuid();
    update private.gmail_sync_cursors
       set pipeline_lease_token = v_token,
           pipeline_lease_expires_at =
             pg_catalog.clock_timestamp() + make_interval(secs => p_lease_seconds),
           updated_at = pg_catalog.now()
     where mail_account_id = v_account.id;

    return jsonb_build_object(
      'result', 'ok',
      'step', 'run_pipeline',
      'lease_token', v_token,
      'mail_account_id', v_account.id,
      'user_id', v_account.user_id
    );
  end if;

  v_horizon := private.gmail_sync_horizon(v_account.id);
  if v_horizon ->> 'result' <> 'ok' then
    return v_horizon;
  end if;
  v_horizon_at := (v_horizon ->> 'horizon_end_at')::timestamptz;

  if not v_cursor_found then
    insert into private.gmail_sync_cursors
      (mail_account_id, user_id, horizon_end_at, next_sync_at, login_sync_requested)
    values (v_account.id, v_account.user_id, v_horizon_at, pg_catalog.clock_timestamp(), false)
    returning * into v_cursor;
  end if;

  select r.* into v_run
    from private.gmail_sync_runs r
   where r.mail_account_id = v_account.id
     and r.status = 'runnable'
   for no key update;

  if not found then
    if v_cursor.login_sync_requested = false
       and v_cursor.next_sync_at > pg_catalog.clock_timestamp()
       and v_cursor.pipeline_pending = false then
      return jsonb_build_object('result', 'not_due', 'next_sync_at', v_cursor.next_sync_at);
    end if;

    -- A paused run holds the one-active slot. Do not start another.
    if exists (
      select 1 from private.gmail_sync_runs r
       where r.mail_account_id = v_account.id
         and r.status in ('paused_reauth', 'paused_consent')
    ) then
      return jsonb_build_object('result', 'paused');
    end if;

    v_window_end := pg_catalog.clock_timestamp();
    if v_window_end <= v_cursor.horizon_end_at then
      perform private.gmail_sync_backoff_cursor(v_account.id);
      return jsonb_build_object('result', 'empty_window');
    end if;

    insert into private.gmail_sync_runs (
      user_id, mail_account_id, status, mode, window_start_at, window_end_at,
      history_id_start, known_threads_enqueued
    ) values (
      v_account.user_id,
      v_account.id,
      'runnable',
      case when v_cursor.history_id is null then 'bounded_rescan' else 'history_list' end,
      v_cursor.horizon_end_at,
      v_window_end,
      v_cursor.history_id,
      v_cursor.history_id is not null
    )
    returning * into v_run;
  end if;

  if v_run.next_attempt_at is not null and v_run.next_attempt_at > pg_catalog.clock_timestamp() then
    return jsonb_build_object('result', 'waiting', 'next_attempt_at', v_run.next_attempt_at);
  end if;

  if v_run.lease_token is not null and v_run.lease_expires_at > pg_catalog.clock_timestamp() then
    return jsonb_build_object('result', 'leased');
  end if;

  if v_run.mode = 'history_list' and not v_run.enumeration_complete then
    v_step := 'enumerate_history';
    v_thread := null;
  elsif v_run.mode = 'bounded_rescan'
        and v_run.history_id_latest is null
        and not v_run.enumeration_complete
        and not v_run.known_threads_enqueued
        and not exists (
          select 1 from private.gmail_sync_threads t where t.run_id = v_run.id
        ) then
    -- Profile historyId is taken before messages.list / threads.get.
    -- Committing it moves window_end_at to that same clock. A profile read
    -- after those fetches is not stored: mail that arrives during the scan
    -- is outside this run, and the next history.list starts at this id.
    v_step := 'capture_history';
    v_thread := null;
  elsif v_run.mode = 'bounded_rescan' and not v_run.enumeration_complete then
    v_step := 'enumerate_sent';
    v_thread := null;
  elsif v_run.mode = 'bounded_rescan' and not v_run.known_threads_enqueued then
    v_step := 'enqueue_known';
    v_thread := null;
  elsif exists (
    select 1 from private.gmail_sync_threads t
     where t.run_id = v_run.id and t.status = 'pending'
  ) then
    select t.provider_thread_id into v_thread
      from private.gmail_sync_threads t
     where t.run_id = v_run.id and t.status = 'pending'
     order by t.provider_thread_id
     limit 1;
    v_step := 'fetch_thread';
  else
    v_step := 'complete_run';
    v_thread := null;
  end if;

  v_token := pg_catalog.gen_random_uuid();
  update private.gmail_sync_runs
     set lease_token = v_token,
         lease_expires_at = pg_catalog.clock_timestamp() + make_interval(secs => p_lease_seconds),
         lease_step = v_step,
         lease_thread_id = v_thread,
         lease_authorization_revision = v_account.authorization_revision
   where id = v_run.id;

  return jsonb_build_object(
    'result', 'ok',
    'step', v_step,
    'run_id', v_run.id,
    'lease_token', v_token,
    'mail_account_id', v_account.id,
    'authorization_revision', v_account.authorization_revision,
    'window_start_at', v_run.window_start_at,
    'window_end_at', v_run.window_end_at,
    'page_token', v_run.page_token,
    'history_id_start', v_run.history_id_start,
    'provider_thread_id', v_thread,
    'mode', v_run.mode,
    'known_threads_after', v_run.known_threads_after
  );
end;
$$;

create or replace function public.gmail_incremental_sync_validate_claim(
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
set search_path = ''
as $$
begin
  return private.gmail_sync_begin_commit(
    p_user_id, p_run_id, p_lease_token, p_expected_step,
    p_expected_authorization_revision, p_expected_provider_thread_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- history.list page. The database, not the caller, decides which threads are
-- sent-rooted enough to fetch.
-- ---------------------------------------------------------------------------

create or replace function public.gmail_incremental_sync_commit_history_page(
  p_user_id uuid,
  p_run_id uuid,
  p_lease_token uuid,
  p_expected_authorization_revision bigint,
  p_page_token_used text,
  p_next_page_token text,
  p_history_id text,
  p_threads jsonb,
  p_quota_units integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_began jsonb;
  v_run private.gmail_sync_runs%rowtype;
  v_item jsonb;
  v_thread text;
  v_want_pending boolean;
  v_stored boolean;
  v_status text;
  v_ids text[];
  v_sent_ids text[];
  v_mid text;
  v_message jsonb;
begin
  if p_history_id is null or length(btrim(p_history_id)) = 0 then
    raise exception 'history page is missing historyId'
      using errcode = 'invalid_parameter_value';
  end if;
  if p_threads is null or jsonb_typeof(p_threads) <> 'array' then
    raise exception 'history page threads must be a json array'
      using errcode = 'invalid_parameter_value';
  end if;

  v_began := private.gmail_sync_begin_commit(
    p_user_id, p_run_id, p_lease_token, 'enumerate_history',
    p_expected_authorization_revision, null);
  if v_began ->> 'result' <> 'ok' then
    return v_began;
  end if;

  select r.* into v_run from private.gmail_sync_runs r where r.id = p_run_id;
  if v_run.mode <> 'history_list'
     or v_run.enumeration_complete
     or v_run.page_token is distinct from p_page_token_used then
    perform private.gmail_sync_release_lease(p_run_id);
    return jsonb_build_object('result', 'already_applied');
  end if;

  for v_item in select value from jsonb_array_elements(p_threads) as t(value)
  loop
    v_thread := btrim(v_item ->> 'provider_thread_id');
    if v_thread = '' or v_item -> 'messages' is null or jsonb_typeof(v_item -> 'messages') <> 'array' then
      raise exception 'history thread entry is malformed'
        using errcode = 'invalid_parameter_value';
    end if;

    if exists (
      select 1
        from jsonb_array_elements(v_item -> 'messages') m
       where jsonb_typeof(m -> 'label_ids') is distinct from 'array'
    ) then
      raise exception 'history message is missing labelIds'
        using errcode = 'invalid_parameter_value';
    end if;

    select exists (
      select 1
        from jsonb_array_elements(v_item -> 'messages') m
       where (m -> 'label_ids') ? 'SENT'
         and not ((m -> 'label_ids') ? 'DRAFT')
    ) into v_want_pending;

    select exists (
      select 1 from private.gmail_raw_messages raw
       where raw.mail_account_id = v_run.mail_account_id
         and raw.provider_thread_id = v_thread
         and 'SENT' = any(raw.label_ids)
         and not ('DRAFT' = any(raw.label_ids))
    ) into v_stored;

    v_status := case when v_want_pending or v_stored then 'pending' else 'filtered_out' end;

    v_ids := '{}'::text[];
    v_sent_ids := '{}'::text[];
    for v_message in
      select value from jsonb_array_elements(v_item -> 'messages') as m(value)
    loop
      v_mid := btrim(coalesce(v_message ->> 'provider_message_id', ''));
      if v_mid <> '' then
        v_ids := v_ids || v_mid;
        if (v_message -> 'label_ids') ? 'SENT'
           and not ((v_message -> 'label_ids') ? 'DRAFT') then
          v_sent_ids := v_sent_ids || v_mid;
        end if;
      end if;
    end loop;

    insert into private.gmail_sync_threads
      (run_id, user_id, mail_account_id, provider_thread_id, status, completed_at,
       snapshot_message_ids, snapshot_sent_message_ids)
    values (
      p_run_id, v_run.user_id, v_run.mail_account_id, v_thread, v_status,
      case when v_status = 'filtered_out' then pg_catalog.now() else null end,
      v_ids, v_sent_ids
    )
    on conflict (run_id, provider_thread_id) do update
      set snapshot_message_ids = (
            select coalesce(array_agg(distinct item), '{}'::text[])
              from unnest(
                private.gmail_sync_threads.snapshot_message_ids || excluded.snapshot_message_ids
              ) as item
          ),
          snapshot_sent_message_ids = (
            select coalesce(array_agg(distinct item), '{}'::text[])
              from unnest(
                private.gmail_sync_threads.snapshot_sent_message_ids
                || excluded.snapshot_sent_message_ids
              ) as item
          ),
          status = case
            when private.gmail_sync_threads.status = 'filtered_out'
             and excluded.status = 'pending' then 'pending'
            else private.gmail_sync_threads.status
          end,
          completed_at = case
            when private.gmail_sync_threads.status = 'filtered_out'
             and excluded.status = 'pending' then null
            else private.gmail_sync_threads.completed_at
          end;
  end loop;

  update private.gmail_sync_runs
     set page_token = p_next_page_token,
         enumeration_complete = p_next_page_token is null,
         history_id_latest = p_history_id,
         window_end_at = greatest(window_end_at, pg_catalog.clock_timestamp()),
         threads_filtered_out = (
           select count(*)::int from private.gmail_sync_threads t
            where t.run_id = p_run_id and t.status = 'filtered_out'
         ),
         estimated_gmail_quota_units =
           estimated_gmail_quota_units + greatest(coalesce(p_quota_units, 0), 0),
         step_attempt_count = 0,
         next_attempt_at = null,
         last_error_code = null,
         lease_token = null,
         lease_expires_at = null,
         lease_step = null,
         lease_thread_id = null,
         lease_authorization_revision = null
   where id = p_run_id;

  return jsonb_build_object('result', 'ok');
end;
$$;

create or replace function public.gmail_incremental_sync_history_expired(
  p_user_id uuid,
  p_run_id uuid,
  p_lease_token uuid,
  p_expected_authorization_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_began jsonb;
begin
  v_began := private.gmail_sync_begin_commit(
    p_user_id, p_run_id, p_lease_token, 'enumerate_history',
    p_expected_authorization_revision, null);
  if v_began ->> 'result' <> 'ok' then
    return v_began;
  end if;

  delete from private.gmail_sync_threads t
   where t.run_id = p_run_id and t.status in ('pending', 'filtered_out');

  update private.gmail_sync_cursors c
     set history_id = null,
         updated_at = pg_catalog.now()
    from private.gmail_sync_runs r
   where r.id = p_run_id and c.mail_account_id = r.mail_account_id;

  update private.gmail_sync_runs
     set mode = 'bounded_rescan',
         history_id_start = null,
         history_id_latest = null,
         page_token = null,
         enumeration_complete = false,
         known_threads_enqueued = false,
         known_threads_after = null,
         step_attempt_count = 0,
         next_attempt_at = null,
         last_error_code = 'history_id_expired',
         lease_token = null,
         lease_expires_at = null,
         lease_step = null,
         lease_thread_id = null,
         lease_authorization_revision = null
   where id = p_run_id;

  return jsonb_build_object('result', 'ok', 'mode', 'bounded_rescan');
end;
$$;

create or replace function public.gmail_incremental_sync_commit_sent_page(
  p_user_id uuid,
  p_run_id uuid,
  p_lease_token uuid,
  p_expected_authorization_revision bigint,
  p_page_token_used text,
  p_next_page_token text,
  p_thread_ids text[],
  p_quota_units integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_began jsonb;
  v_run private.gmail_sync_runs%rowtype;
begin
  v_began := private.gmail_sync_begin_commit(
    p_user_id, p_run_id, p_lease_token, 'enumerate_sent',
    p_expected_authorization_revision, null);
  if v_began ->> 'result' <> 'ok' then
    return v_began;
  end if;

  select r.* into v_run from private.gmail_sync_runs r where r.id = p_run_id;
  if v_run.mode <> 'bounded_rescan'
     or v_run.enumeration_complete
     or v_run.page_token is distinct from p_page_token_used then
    perform private.gmail_sync_release_lease(p_run_id);
    return jsonb_build_object('result', 'already_applied');
  end if;

  insert into private.gmail_sync_threads
    (run_id, user_id, mail_account_id, provider_thread_id, status)
  select p_run_id, v_run.user_id, v_run.mail_account_id, btrim(t), 'pending'
    from unnest(coalesce(p_thread_ids, '{}'::text[])) as t
   where btrim(t) <> ''
  on conflict (run_id, provider_thread_id) do update
    set status = 'pending', completed_at = null
    where private.gmail_sync_threads.status = 'filtered_out';

  update private.gmail_sync_runs
     set page_token = p_next_page_token,
         enumeration_complete = p_next_page_token is null,
         estimated_gmail_quota_units =
           estimated_gmail_quota_units + greatest(coalesce(p_quota_units, 0), 0),
         step_attempt_count = 0,
         next_attempt_at = null,
         last_error_code = null,
         lease_token = null,
         lease_expires_at = null,
         lease_step = null,
         lease_thread_id = null,
         lease_authorization_revision = null
   where id = p_run_id;

  return jsonb_build_object('result', 'ok');
end;
$$;

create or replace function public.gmail_incremental_sync_commit_enqueue_known(
  p_user_id uuid,
  p_run_id uuid,
  p_lease_token uuid,
  p_expected_authorization_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_began jsonb;
  v_run private.gmail_sync_runs%rowtype;
  v_last text;
  v_count integer := 0;
begin
  v_began := private.gmail_sync_begin_commit(
    p_user_id, p_run_id, p_lease_token, 'enqueue_known',
    p_expected_authorization_revision, null);
  if v_began ->> 'result' <> 'ok' then
    return v_began;
  end if;

  select r.* into v_run from private.gmail_sync_runs r where r.id = p_run_id;

  with page as (
    select distinct raw.provider_thread_id
      from private.gmail_raw_messages raw
     where raw.mail_account_id = v_run.mail_account_id
       and 'SENT' = any(raw.label_ids)
       and not ('DRAFT' = any(raw.label_ids))
       and (v_run.known_threads_after is null or raw.provider_thread_id > v_run.known_threads_after)
     order by raw.provider_thread_id
     limit 100
  ),
  inserted as (
    insert into private.gmail_sync_threads
      (run_id, user_id, mail_account_id, provider_thread_id, status)
    select p_run_id, v_run.user_id, v_run.mail_account_id, page.provider_thread_id, 'pending'
      from page
    on conflict (run_id, provider_thread_id) do update
      set status = 'pending', completed_at = null
      where private.gmail_sync_threads.status = 'filtered_out'
    returning provider_thread_id
  )
  select count(*)::int, max(provider_thread_id)
    into v_count, v_last
    from (
      select provider_thread_id from page
    ) s;

  update private.gmail_sync_runs
     set known_threads_after = coalesce(v_last, known_threads_after),
         known_threads_enqueued = v_count < 100,
         step_attempt_count = 0,
         lease_token = null,
         lease_expires_at = null,
         lease_step = null,
         lease_thread_id = null,
         lease_authorization_revision = null
   where id = p_run_id;

  return jsonb_build_object('result', 'ok', 'enqueued_batch', v_count);
end;
$$;

-- ---------------------------------------------------------------------------
-- Thread commit. Candidacy is proved from the rows and the payload, never
-- from a caller boolean. Drafts are not stored. Identity is the B03 primary
-- key, so a concurrent or repeated run cannot insert a second message row.
-- ---------------------------------------------------------------------------

create or replace function public.gmail_incremental_sync_commit_thread(
  p_user_id uuid,
  p_run_id uuid,
  p_lease_token uuid,
  p_expected_authorization_revision bigint,
  p_provider_thread_id text,
  p_messages jsonb,
  p_quota_units integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_began jsonb;
  v_run private.gmail_sync_runs%rowtype;
  v_thread private.gmail_sync_threads%rowtype;
  v_msg jsonb;
  v_internal timestamptz;
  v_has_sent boolean;
  v_stored integer := 0;
  v_updated integer := 0;
  v_existing private.gmail_raw_messages%rowtype;
  v_id_match boolean;
  v_history_match boolean;
  v_withheld boolean := false;
  v_excluded text[] := '{}'::text[];
begin
  v_began := private.gmail_sync_begin_commit(
    p_user_id, p_run_id, p_lease_token, 'fetch_thread',
    p_expected_authorization_revision, p_provider_thread_id);
  if v_began ->> 'result' <> 'ok' then
    return v_began;
  end if;

  select r.* into v_run from private.gmail_sync_runs r where r.id = p_run_id;
  select t.* into v_thread
    from private.gmail_sync_threads t
   where t.run_id = p_run_id and t.provider_thread_id = p_provider_thread_id
   for no key update;

  if not found then
    perform private.gmail_sync_release_lease(p_run_id);
    return jsonb_build_object('result', 'thread_not_found');
  end if;

  if v_thread.status <> 'pending' then
    perform private.gmail_sync_release_lease(p_run_id);
    return jsonb_build_object('result', 'already_applied');
  end if;

  if p_messages is null or jsonb_typeof(p_messages) <> 'array' then
    raise exception 'commit_thread messages must be a json array'
      using errcode = 'invalid_parameter_value';
  end if;

  for v_msg in select value from jsonb_array_elements(p_messages) as t(value)
  loop
    if coalesce(btrim(v_msg ->> 'provider_message_id'), '') = ''
       or (v_msg ->> 'provider_thread_id') is distinct from p_provider_thread_id
       or (v_msg ->> 'internal_date') is null
       or v_msg -> 'sanitized_payload' is null
       or jsonb_typeof(coalesce(v_msg -> 'label_ids', 'null'::jsonb)) <> 'array'
       or coalesce(v_msg ->> 'payload_sha256', '') !~ '^[0-9a-f]{64}$' then
      raise exception 'gmail_incremental_sync_commit_thread received a malformed sanitized message'
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;

  select
    exists (
      select 1
        from jsonb_array_elements(p_messages) m
       where (m ->> 'internal_date')::timestamptz >= v_run.window_start_at
         and (m ->> 'internal_date')::timestamptz < v_run.window_end_at
         and (m -> 'label_ids') ? 'SENT'
         and not ((m -> 'label_ids') ? 'DRAFT')
    )
    or exists (
      select 1
        from jsonb_array_elements(p_messages) m
       where (m -> 'label_ids') ? 'SENT'
         and not ((m -> 'label_ids') ? 'DRAFT')
         and (
           (
             (m ->> 'provider_message_id') = any (v_thread.snapshot_message_ids)
             and (m ->> 'internal_date')::timestamptz >= v_run.window_start_at
           )
           or (
             (m ->> 'internal_date')::timestamptz >= v_run.window_start_at
             and coalesce(m ->> 'provider_history_id', '') ~ '^[0-9]+$'
             and coalesce(v_run.history_id_latest, '') ~ '^[0-9]+$'
             and (m ->> 'provider_history_id')::numeric
               <= (v_run.history_id_latest)::numeric
           )
         )
    )
    or exists (
      select 1 from private.gmail_raw_messages raw
       where raw.mail_account_id = v_run.mail_account_id
         and raw.provider_thread_id = p_provider_thread_id
         and 'SENT' = any(raw.label_ids)
         and not ('DRAFT' = any(raw.label_ids))
    )
  into v_has_sent;

  select coalesce(array_agg(distinct btrim(m ->> 'provider_message_id')), '{}'::text[])
    into v_excluded
    from jsonb_array_elements(p_messages) as m
   where btrim(coalesce(m ->> 'provider_message_id', '')) <> ''
     and (m ->> 'provider_message_id') = any (v_thread.snapshot_sent_message_ids)
     and (m -> 'label_ids') ? 'SENT'
     and not ((m -> 'label_ids') ? 'DRAFT')
     and (m ->> 'internal_date')::timestamptz < v_run.window_start_at;

  if not v_has_sent then
    update private.gmail_sync_threads
       set status = 'filtered_out',
           completed_at = pg_catalog.now(),
           snapshot_sent_excluded_ids = v_excluded
     where id = v_thread.id;
    update private.gmail_sync_runs
       set snapshot_sent_withheld = snapshot_sent_withheld or exists (
             select 1
               from unnest(v_thread.snapshot_sent_message_ids) as mid(provider_message_id)
              where not (mid.provider_message_id = any (v_excluded))
                and not exists (
                  select 1 from private.gmail_raw_messages raw
                   where raw.mail_account_id = v_run.mail_account_id
                     and raw.provider_message_id = mid.provider_message_id
                )
           ),
           threads_filtered_out = (
             select count(*)::int from private.gmail_sync_threads t
              where t.run_id = p_run_id and t.status = 'filtered_out'
           ),
           estimated_gmail_quota_units =
             estimated_gmail_quota_units + greatest(coalesce(p_quota_units, 0), 0),
           step_attempt_count = 0,
           lease_token = null,
           lease_expires_at = null,
           lease_step = null,
           lease_thread_id = null,
           lease_authorization_revision = null
     where id = p_run_id;
    return jsonb_build_object('result', 'filtered_out', 'stored', 0, 'updated', 0);
  end if;

  for v_msg in select value from jsonb_array_elements(p_messages) as t(value)
  loop
    if (v_msg -> 'label_ids') ? 'DRAFT' then
      continue;
    end if;
    v_internal := (v_msg ->> 'internal_date')::timestamptz;
    v_id_match := (v_msg ->> 'provider_message_id') = any (v_thread.snapshot_message_ids);
    v_history_match :=
      v_internal >= v_run.window_start_at
      and coalesce(v_msg ->> 'provider_history_id', '') ~ '^[0-9]+$'
      and coalesce(v_run.history_id_latest, '') ~ '^[0-9]+$'
      and (v_msg ->> 'provider_history_id')::numeric <= (v_run.history_id_latest)::numeric;
    if v_internal < v_run.window_start_at
       or (v_internal >= v_run.window_end_at and not v_id_match and not v_history_match) then
      continue;
    end if;

    select raw.* into v_existing
      from private.gmail_raw_messages raw
     where raw.mail_account_id = v_run.mail_account_id
       and raw.provider_message_id = (v_msg ->> 'provider_message_id');

    if not found then
      insert into private.gmail_raw_messages (
        mail_account_id, user_id, provider_message_id, provider_thread_id, internal_date,
        provider_history_id, label_ids, sanitized_payload, payload_sha256
      ) values (
        v_run.mail_account_id, v_run.user_id,
        v_msg ->> 'provider_message_id', v_msg ->> 'provider_thread_id', v_internal,
        v_msg ->> 'provider_history_id',
        coalesce(
          (select array_agg(value) from jsonb_array_elements_text(v_msg -> 'label_ids')),
          '{}'::text[]
        ),
        v_msg -> 'sanitized_payload',
        v_msg ->> 'payload_sha256'
      );
      v_stored := v_stored + 1;
    elsif v_existing.payload_sha256 is distinct from (v_msg ->> 'payload_sha256') then
      update private.gmail_raw_messages
         set provider_thread_id = v_msg ->> 'provider_thread_id',
             internal_date = v_internal,
             provider_history_id = v_msg ->> 'provider_history_id',
             label_ids = coalesce(
               (select array_agg(value) from jsonb_array_elements_text(v_msg -> 'label_ids')),
               '{}'::text[]
             ),
             sanitized_payload = v_msg -> 'sanitized_payload',
             payload_sha256 = v_msg ->> 'payload_sha256',
             last_seen_at = pg_catalog.now()
       where mail_account_id = v_run.mail_account_id
         and provider_message_id = (v_msg ->> 'provider_message_id');
      v_updated := v_updated + 1;
    else
      update private.gmail_raw_messages
         set last_seen_at = pg_catalog.now()
       where mail_account_id = v_run.mail_account_id
         and provider_message_id = (v_msg ->> 'provider_message_id');
    end if;
  end loop;

  insert into private.gmail_sync_thread_coverage
    (mail_account_id, user_id, provider_thread_id, run_id, observed_through_at)
  values (
    v_run.mail_account_id, v_run.user_id, p_provider_thread_id, p_run_id, v_run.window_end_at
  )
  on conflict (mail_account_id, provider_thread_id, run_id) do update
    set observed_through_at = excluded.observed_through_at;

  update private.gmail_sync_threads
     set status = 'complete',
         completed_at = pg_catalog.now(),
         last_error_code = null,
         snapshot_sent_excluded_ids = v_excluded
   where id = v_thread.id;

  if v_withheld
     or exists (
       select 1
         from unnest(v_thread.snapshot_sent_message_ids) as mid(provider_message_id)
        where not (mid.provider_message_id = any (v_excluded))
          and not exists (
            select 1 from private.gmail_raw_messages raw
             where raw.mail_account_id = v_run.mail_account_id
               and raw.provider_message_id = mid.provider_message_id
          )
     ) then
    v_withheld := true;
  end if;

  update private.gmail_sync_runs
     set messages_stored = messages_stored + v_stored,
         messages_updated = messages_updated + v_updated,
         snapshot_sent_withheld = snapshot_sent_withheld or v_withheld,
         estimated_gmail_quota_units =
           estimated_gmail_quota_units + greatest(coalesce(p_quota_units, 0), 0),
         step_attempt_count = 0,
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

create or replace function public.gmail_incremental_sync_record_thread_gone(
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
set search_path = ''
as $$
declare
  v_began jsonb;
begin
  v_began := private.gmail_sync_begin_commit(
    p_user_id, p_run_id, p_lease_token, 'fetch_thread',
    p_expected_authorization_revision, p_provider_thread_id);
  if v_began ->> 'result' <> 'ok' then
    return v_began;
  end if;

  update private.gmail_sync_threads
     set status = 'gone', completed_at = pg_catalog.now()
   where run_id = p_run_id and provider_thread_id = p_provider_thread_id and status = 'pending';

  update private.gmail_sync_runs
     set estimated_gmail_quota_units =
           estimated_gmail_quota_units + greatest(coalesce(p_quota_units, 0), 0),
         step_attempt_count = 0,
         lease_token = null,
         lease_expires_at = null,
         lease_step = null,
         lease_thread_id = null,
         lease_authorization_revision = null
   where id = p_run_id;

  return jsonb_build_object('result', 'ok');
end;
$$;

create or replace function public.gmail_incremental_sync_record_retry(
  p_user_id uuid,
  p_run_id uuid,
  p_lease_token uuid,
  p_expected_authorization_revision bigint,
  p_expected_step text,
  p_provider_thread_id text,
  p_error_code text,
  p_delay_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_began jsonb;
  v_run private.gmail_sync_runs%rowtype;
  v_next integer;
begin
  if p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'retry error code is not in the allowed vocabulary'
      using errcode = 'invalid_parameter_value';
  end if;

  v_began := private.gmail_sync_begin_commit(
    p_user_id, p_run_id, p_lease_token, p_expected_step,
    p_expected_authorization_revision, p_provider_thread_id);
  if v_began ->> 'result' <> 'ok' then
    return v_began;
  end if;

  select r.* into v_run from private.gmail_sync_runs r where r.id = p_run_id;
  v_next := v_run.step_attempt_count + 1;

  if v_next >= 5 then
    update private.gmail_sync_runs
       set status = 'failed',
           completed_at = pg_catalog.now(),
           last_error_code = p_error_code,
           step_attempt_count = v_next,
           lease_token = null,
           lease_expires_at = null,
           lease_step = null,
           lease_thread_id = null,
           lease_authorization_revision = null
     where id = p_run_id;
    perform private.gmail_sync_backoff_cursor(v_run.mail_account_id);
    return jsonb_build_object('result', 'failed');
  end if;

  update private.gmail_sync_runs
     set step_attempt_count = v_next,
         next_attempt_at = pg_catalog.clock_timestamp()
           + make_interval(secs => greatest(coalesce(p_delay_seconds, 1), 1)),
         last_error_code = p_error_code,
         lease_token = null,
         lease_expires_at = null,
         lease_step = null,
         lease_thread_id = null,
         lease_authorization_revision = null
   where id = p_run_id;

  return jsonb_build_object('result', 'retry_scheduled', 'attempt_count', v_next);
end;
$$;

create or replace function public.gmail_incremental_sync_fail_run(
  p_user_id uuid,
  p_run_id uuid,
  p_lease_token uuid,
  p_expected_authorization_revision bigint,
  p_expected_step text,
  p_provider_thread_id text,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_began jsonb;
  v_mail uuid;
begin
  if p_error_code is null or p_error_code !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'fail error code is not in the allowed vocabulary'
      using errcode = 'invalid_parameter_value';
  end if;

  v_began := private.gmail_sync_begin_commit(
    p_user_id, p_run_id, p_lease_token, p_expected_step,
    p_expected_authorization_revision, p_provider_thread_id);
  if v_began ->> 'result' <> 'ok' then
    return v_began;
  end if;

  select mail_account_id into v_mail from private.gmail_sync_runs where id = p_run_id;

  if p_provider_thread_id is not null then
    update private.gmail_sync_threads
       set status = 'failed', completed_at = pg_catalog.now(), last_error_code = p_error_code
     where run_id = p_run_id and provider_thread_id = p_provider_thread_id and status = 'pending';
  end if;

  update private.gmail_sync_runs
     set status = 'failed',
         completed_at = pg_catalog.now(),
         last_error_code = p_error_code,
         lease_token = null,
         lease_expires_at = null,
         lease_step = null,
         lease_thread_id = null,
         lease_authorization_revision = null
   where id = p_run_id;

  perform private.gmail_sync_backoff_cursor(v_mail);
  return jsonb_build_object('result', 'failed');
end;
$$;

create or replace function public.gmail_incremental_sync_commit_profile_history(
  p_user_id uuid,
  p_run_id uuid,
  p_lease_token uuid,
  p_expected_authorization_revision bigint,
  p_history_id text,
  p_quota_units integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_began jsonb;
begin
  if p_history_id is null or length(btrim(p_history_id)) = 0 then
    raise exception 'profile historyId is required'
      using errcode = 'invalid_parameter_value';
  end if;

  v_began := private.gmail_sync_begin_commit(
    p_user_id, p_run_id, p_lease_token, 'capture_history',
    p_expected_authorization_revision, null);
  if v_began ->> 'result' <> 'ok' then
    return v_began;
  end if;

  -- The pre-scan id is the one completion stores. A later profile response
  -- must not replace it.
  if exists (
    select 1 from private.gmail_sync_runs r
     where r.id = p_run_id and r.history_id_latest is not null
  ) then
    perform private.gmail_sync_release_lease(p_run_id);
    return jsonb_build_object('result', 'ok', 'replaced', false);
  end if;

  update private.gmail_sync_runs
     set history_id_latest = p_history_id,
         window_end_at = greatest(window_end_at, pg_catalog.clock_timestamp()),
         estimated_gmail_quota_units =
           estimated_gmail_quota_units + greatest(coalesce(p_quota_units, 0), 0),
         step_attempt_count = 0,
         last_error_code = null,
         lease_token = null,
         lease_expires_at = null,
         lease_step = null,
         lease_thread_id = null,
         lease_authorization_revision = null
   where id = p_run_id;

  return jsonb_build_object('result', 'ok');
end;
$$;

create or replace function public.gmail_incremental_sync_commit_completion(
  p_user_id uuid,
  p_run_id uuid,
  p_lease_token uuid,
  p_expected_authorization_revision bigint
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_began jsonb;
  v_run private.gmail_sync_runs%rowtype;
  v_failed integer;
  v_pending integer;
  v_withheld boolean;
begin
  v_began := private.gmail_sync_begin_commit(
    p_user_id, p_run_id, p_lease_token, 'complete_run',
    p_expected_authorization_revision, null);
  if v_began ->> 'result' <> 'ok' then
    return v_began;
  end if;

  select r.* into v_run from private.gmail_sync_runs r where r.id = p_run_id;

  select count(*) filter (where status = 'failed')::int,
         count(*) filter (where status = 'pending')::int
    into v_failed, v_pending
    from private.gmail_sync_threads t
   where t.run_id = p_run_id;

  if v_failed > 0 or v_pending > 0 or v_run.history_id_latest is null or not v_run.enumeration_complete then
    perform private.gmail_sync_release_lease(p_run_id);
    return jsonb_build_object('result', 'not_complete');
  end if;

  select v_run.snapshot_sent_withheld
      or exists (
        select 1
          from private.gmail_sync_threads t
          cross join lateral unnest(t.snapshot_sent_message_ids) as mid(provider_message_id)
         where t.run_id = p_run_id
           and t.status is distinct from 'gone'
           and not (mid.provider_message_id = any (t.snapshot_sent_excluded_ids))
           and not exists (
             select 1 from private.gmail_raw_messages raw
              where raw.mail_account_id = v_run.mail_account_id
                and raw.provider_message_id = mid.provider_message_id
           )
      )
    into v_withheld;

  update private.gmail_sync_runs
     set status = 'completed',
         completed_at = pg_catalog.now(),
         last_error_code = null,
         lease_token = null,
         lease_expires_at = null,
         lease_step = null,
         lease_thread_id = null,
         lease_authorization_revision = null
   where id = p_run_id;

  update private.gmail_sync_cursors
     set history_id = case
           when v_withheld then history_id
           else v_run.history_id_latest
         end,
         horizon_end_at = case
           when v_withheld then horizon_end_at
           else v_run.window_end_at
         end,
         next_sync_at = pg_catalog.clock_timestamp() + interval '15 minutes',
         login_sync_requested = false,
         pipeline_pending = true,
         updated_at = pg_catalog.now()
   where mail_account_id = v_run.mail_account_id
     and user_id = v_run.user_id;

  return jsonb_build_object(
    'result', 'ok',
    'status', 'completed',
    'history_id_advanced', not v_withheld,
    'messages_stored', v_run.messages_stored
  );
end;
$$;

create or replace function public.gmail_incremental_sync_release_claim(
  p_user_id uuid,
  p_run_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run private.gmail_sync_runs%rowtype;
begin
  select r.* into v_run
    from private.gmail_sync_runs r
   where r.id = p_run_id and r.user_id = p_user_id
   for no key update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_run.lease_token is distinct from p_lease_token then
    return jsonb_build_object('result', 'stale_lease');
  end if;
  perform private.gmail_sync_release_lease(p_run_id);
  return jsonb_build_object('result', 'ok');
end;
$$;

create or replace function public.gmail_incremental_sync_pause(
  p_user_id uuid,
  p_run_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  if p_reason = 'reauth' then
    v_status := 'paused_reauth';
  elsif p_reason = 'consent' then
    v_status := 'paused_consent';
  else
    raise exception 'pause reason must be reauth or consent'
      using errcode = 'invalid_parameter_value';
  end if;

  update private.gmail_sync_runs
     set status = v_status,
         last_error_code = case when p_reason = 'reauth' then 'reauth_required' else 'consent_missing' end,
         lease_token = null,
         lease_expires_at = null,
         lease_step = null,
         lease_thread_id = null,
         lease_authorization_revision = null
   where id = p_run_id and user_id = p_user_id and status = 'runnable';

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  return jsonb_build_object('result', 'ok', 'status', v_status);
end;
$$;

create or replace function public.gmail_incremental_sync_cancel_connection_stopped(
  p_user_id uuid,
  p_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  update private.gmail_sync_runs
     set status = 'cancelled_connection_stopped',
         completed_at = pg_catalog.now(),
         last_error_code = 'connection_stopped',
         lease_token = null,
         lease_expires_at = null,
         lease_step = null,
         lease_thread_id = null,
         lease_authorization_revision = null
   where id = p_run_id and user_id = p_user_id
     and status in ('runnable', 'paused_reauth', 'paused_consent');
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  return jsonb_build_object('result', 'ok');
end;
$$;

create or replace function public.gmail_incremental_sync_mark_pipeline_done(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_auth text;
  v_account public.mail_accounts%rowtype;
  v_cursor private.gmail_sync_cursors%rowtype;
begin
  select m.* into v_account
    from public.mail_accounts m
   where m.id = p_mail_account_id and m.user_id = p_user_id
   for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  v_auth := private.gmail_import_authorization_state(v_account.id, v_account.authorization_revision);
  if v_auth <> 'ok' then
    return jsonb_build_object('result', v_auth, 'connection_state', v_account.connection_state);
  end if;

  select c.* into v_cursor
    from private.gmail_sync_cursors c
   where c.mail_account_id = p_mail_account_id and c.user_id = p_user_id
   for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_cursor.pipeline_lease_token is distinct from p_lease_token then
    return jsonb_build_object('result', 'stale_lease');
  end if;

  update private.gmail_sync_cursors
     set pipeline_pending = false,
         pipeline_lease_token = null,
         pipeline_lease_expires_at = null,
         updated_at = pg_catalog.now()
   where mail_account_id = p_mail_account_id and user_id = p_user_id;

  return jsonb_build_object('result', 'ok');
end;
$$;

create or replace function public.gmail_incremental_sync_release_pipeline(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_lease_token uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cursor private.gmail_sync_cursors%rowtype;
begin
  if not exists (
    select 1 from public.mail_accounts m
     where m.id = p_mail_account_id and m.user_id = p_user_id
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  select c.* into v_cursor
    from private.gmail_sync_cursors c
   where c.mail_account_id = p_mail_account_id and c.user_id = p_user_id
   for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_cursor.pipeline_lease_token is distinct from p_lease_token then
    return jsonb_build_object('result', 'stale_lease');
  end if;

  update private.gmail_sync_cursors
     set pipeline_lease_token = null,
         pipeline_lease_expires_at = null,
         updated_at = pg_catalog.now()
   where mail_account_id = p_mail_account_id and user_id = p_user_id;

  return jsonb_build_object('result', 'ok');
end;
$$;

-- Extends the pipeline lease while the worker is still inside run_pipeline.
-- A token that no longer matches is left alone, so a late renew cannot put
-- another worker's lease back.
create or replace function public.gmail_incremental_sync_renew_pipeline(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_lease_token uuid,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if p_lease_seconds is null or p_lease_seconds < 1 or p_lease_seconds > 600 then
    raise exception 'gmail_incremental_sync_renew_pipeline lease must be 1..600 seconds'
      using errcode = 'invalid_parameter_value';
  end if;

  if not exists (
    select 1 from public.mail_accounts m
     where m.id = p_mail_account_id and m.user_id = p_user_id
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  update private.gmail_sync_cursors
     set pipeline_lease_expires_at =
           pg_catalog.clock_timestamp() + make_interval(secs => p_lease_seconds),
         updated_at = pg_catalog.now()
   where mail_account_id = p_mail_account_id
     and user_id = p_user_id
     and pipeline_pending
     and pipeline_lease_token = p_lease_token;
  get diagnostics v_updated = row_count;

  if v_updated = 1 then
    return jsonb_build_object('result', 'ok');
  end if;
  return jsonb_build_object('result', 'stale_lease');
end;
$$;

create or replace function public.gmail_incremental_sync_list_pipeline_threads(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_rows jsonb;
  v_run uuid;
begin
  if p_limit is null or p_limit < 1 or p_limit > 200 then
    raise exception 'pipeline thread limit must be 1..200'
      using errcode = 'invalid_parameter_value';
  end if;

  if not exists (
    select 1 from public.mail_accounts m
     where m.id = p_mail_account_id and m.user_id = p_user_id
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  select r.id into v_run
    from private.gmail_sync_runs r
   where r.mail_account_id = p_mail_account_id
     and r.user_id = p_user_id
     and r.status = 'completed'
   order by r.completed_at desc
   limit 1;

  select coalesce(jsonb_agg(jsonb_build_object(
           'normalized_thread_id', s.id
         ) order by s.id), '[]'::jsonb)
    into v_rows
    from (
      select t.id
        from private.gmail_normalized_threads t
       where t.mail_account_id = p_mail_account_id
         and t.user_id = p_user_id
         and (
           (
             exists (
               select 1 from private.gmail_sync_thread_coverage c
                where c.run_id = v_run
                  and c.mail_account_id = t.mail_account_id
                  and c.provider_thread_id = t.provider_thread_id
             )
             and not exists (
               select 1 from private.gmail_commercial_thread_current cur
                where cur.mail_account_id = t.mail_account_id
                  and cur.provider_thread_id = t.provider_thread_id
                  and (
                    cur.stale = false
                    or cur.stale_reason = 'b05_not_eligible'
                  )
             )
           )
           or exists (
             select 1 from private.gmail_commercial_thread_current cur
              where cur.mail_account_id = t.mail_account_id
                and cur.provider_thread_id = t.provider_thread_id
                and cur.stale
                and cur.stale_reason is distinct from 'b05_not_eligible'
           )
         )
       order by t.id
       limit p_limit
    ) s;

  return jsonb_build_object('result', 'ok', 'threads', v_rows);
end;
$$;

create or replace function public.gmail_incremental_sync_purge_for_deletion(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_deletion_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account public.mail_accounts%rowtype;
  v_request public.mail_account_deletion_requests%rowtype;
  v_cursors integer;
  v_runs integer;
  v_threads integer;
  v_coverage integer;
begin
  select m.* into v_account
    from public.mail_accounts m
   where m.id = p_mail_account_id and m.user_id = p_user_id
   for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_account.connection_state <> 'deletion_pending' then
    return jsonb_build_object('result', 'not_deleting', 'connection_state', v_account.connection_state);
  end if;
  if v_account.current_deletion_request_id is distinct from p_deletion_request_id then
    return jsonb_build_object('result', 'stale_deletion_request');
  end if;

  select r.* into v_request
    from public.mail_account_deletion_requests r
   where r.id = p_deletion_request_id;

  if not found
     or v_request.mail_account_id <> p_mail_account_id
     or v_request.user_id <> p_user_id
     or v_request.status not in ('requested', 'in_progress')
     or v_request.scope not in ('gmail_derived_data', 'account_and_gmail_derived_data') then
    return jsonb_build_object('result', 'stale_deletion_request');
  end if;

  with removed as (
    delete from private.gmail_sync_thread_coverage c
     where c.mail_account_id = p_mail_account_id returning 1
  ) select count(*)::int into v_coverage from removed;
  with removed as (
    delete from private.gmail_sync_threads t
     where t.mail_account_id = p_mail_account_id returning 1
  ) select count(*)::int into v_threads from removed;
  with removed as (
    delete from private.gmail_sync_runs r
     where r.mail_account_id = p_mail_account_id returning 1
  ) select count(*)::int into v_runs from removed;
  with removed as (
    delete from private.gmail_sync_cursors c
     where c.mail_account_id = p_mail_account_id returning 1
  ) select count(*)::int into v_cursors from removed;

  return jsonb_build_object(
    'result', 'ok',
    'cursors_removed', v_cursors,
    'runs_removed', v_runs,
    'threads_removed', v_threads,
    'coverage_removed', v_coverage
  );
end;
$$;

create or replace function public.gmail_incremental_sync_status(
  p_user_id uuid,
  p_mail_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cursor private.gmail_sync_cursors%rowtype;
begin
  if not exists (
    select 1 from public.mail_accounts m
     where m.id = p_mail_account_id and m.user_id = p_user_id
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  select c.* into v_cursor
    from private.gmail_sync_cursors c
   where c.mail_account_id = p_mail_account_id and c.user_id = p_user_id;

  if not found then
    return jsonb_build_object('result', 'ok', 'cursor', false);
  end if;

  return jsonb_build_object(
    'result', 'ok',
    'cursor', true,
    'has_history_id', v_cursor.history_id is not null,
    'horizon_end_at', v_cursor.horizon_end_at,
    'next_sync_at', v_cursor.next_sync_at,
    'login_sync_requested', v_cursor.login_sync_requested,
    'pipeline_pending', v_cursor.pipeline_pending
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. service_role only. The deleted-assertion trigger is owner-only.
-- ---------------------------------------------------------------------------

do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.gmail_incremental_sync_request_login(uuid)',
    'public.gmail_incremental_sync_list_due(integer)',
    'public.gmail_incremental_sync_claim_step(uuid,uuid,integer)',
    'public.gmail_incremental_sync_validate_claim(uuid,uuid,uuid,bigint,text,text)',
    'public.gmail_incremental_sync_commit_history_page(uuid,uuid,uuid,bigint,text,text,text,jsonb,integer)',
    'public.gmail_incremental_sync_history_expired(uuid,uuid,uuid,bigint)',
    'public.gmail_incremental_sync_commit_sent_page(uuid,uuid,uuid,bigint,text,text,text[],integer)',
    'public.gmail_incremental_sync_commit_enqueue_known(uuid,uuid,uuid,bigint)',
    'public.gmail_incremental_sync_commit_thread(uuid,uuid,uuid,bigint,text,jsonb,integer)',
    'public.gmail_incremental_sync_record_thread_gone(uuid,uuid,uuid,bigint,text,integer)',
    'public.gmail_incremental_sync_record_retry(uuid,uuid,uuid,bigint,text,text,text,integer)',
    'public.gmail_incremental_sync_fail_run(uuid,uuid,uuid,bigint,text,text,text)',
    'public.gmail_incremental_sync_commit_profile_history(uuid,uuid,uuid,bigint,text,integer)',
    'public.gmail_incremental_sync_commit_completion(uuid,uuid,uuid,bigint)',
    'public.gmail_incremental_sync_release_claim(uuid,uuid,uuid)',
    'public.gmail_incremental_sync_pause(uuid,uuid,text)',
    'public.gmail_incremental_sync_cancel_connection_stopped(uuid,uuid)',
    'public.gmail_incremental_sync_mark_pipeline_done(uuid,uuid,uuid)',
    'public.gmail_incremental_sync_release_pipeline(uuid,uuid,uuid)',
    'public.gmail_incremental_sync_renew_pipeline(uuid,uuid,uuid,integer)',
    'public.gmail_incremental_sync_list_pipeline_threads(uuid,uuid,integer)',
    'public.gmail_incremental_sync_purge_for_deletion(uuid,uuid,uuid)',
    'public.gmail_incremental_sync_status(uuid,uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- RLS. Owner may read sync metadata. Nobody writes it from a client role.
-- ---------------------------------------------------------------------------

alter table private.gmail_sync_cursors enable row level security;
alter table private.gmail_sync_runs enable row level security;
alter table private.gmail_sync_threads enable row level security;
alter table private.gmail_sync_thread_coverage enable row level security;

create policy gmail_sync_cursors_select on private.gmail_sync_cursors
  for select to authenticated using (user_id = (select auth.uid()));
create policy gmail_sync_runs_select on private.gmail_sync_runs
  for select to authenticated using (user_id = (select auth.uid()));
create policy gmail_sync_threads_select on private.gmail_sync_threads
  for select to authenticated using (user_id = (select auth.uid()));
create policy gmail_sync_coverage_select on private.gmail_sync_thread_coverage
  for select to authenticated using (user_id = (select auth.uid()));

grant usage on schema private to authenticated;
revoke all on table
  private.gmail_sync_cursors,
  private.gmail_sync_runs,
  private.gmail_sync_threads,
  private.gmail_sync_thread_coverage
  from public, anon, authenticated;
grant select on table
  private.gmail_sync_cursors,
  private.gmail_sync_runs,
  private.gmail_sync_threads,
  private.gmail_sync_thread_coverage
  to authenticated;

-- ===========================================================================
-- What 0047 does not create
-- ===========================================================================
-- No Pub/Sub watch, no gmail.send, no new OAuth scope.
-- No pilot KPI table. No production cron schedule.
-- No change to D072 commercial-meaning rules.
