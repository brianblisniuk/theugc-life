-- 0093_preprod_jobs.sql
-- PREPROD-1. Netlify schedules the jobs. This migration does not create a
-- cron row. It refuses Gmail connect, reconnect, grant-send, new sends, and
-- new syncs while the account deletion clock is set, and it adds the annual
-- credit refresh that job calls. 0088 through 0092 are not edited.

create function public.account_gmail_blocked(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.users u
     where u.id = p_user_id
       and u.deletion_requested_at is not null
  );
$$;

comment on function public.account_gmail_blocked(uuid) is
  'D178 Proposed. True when this creator has a pending account deletion. Not granted to client roles.';

revoke all on function public.account_gmail_blocked(uuid)
  from public, anon, authenticated, service_role;

create function private.refuse_gmail_credential_while_deleting()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if public.account_gmail_blocked(new.user_id) then
    raise exception 'gmail is blocked while account deletion is pending'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function private.refuse_gmail_credential_while_deleting() is
  'D178 Proposed. Refuses a new or replaced Gmail credential or OAuth transaction while account deletion is pending. Does not call Google.';

revoke all on function private.refuse_gmail_credential_while_deleting()
  from public, anon, authenticated, service_role;

create trigger gmail_oauth_credentials_block_deleting
  before insert or update on private.gmail_oauth_credentials
  for each row
  execute function private.refuse_gmail_credential_while_deleting();

create trigger gmail_oauth_transactions_block_deleting
  before insert or update on private.gmail_oauth_transactions
  for each row
  execute function private.refuse_gmail_credential_while_deleting();

alter table private.gmail_send_attempts
  drop constraint gmail_send_attempts_failure_check;

alter table private.gmail_send_attempts
  add constraint gmail_send_attempts_failure_check
  check (
    (status = 'failed' and failure_code in (
      'plan_required', 'scope_missing', 'not_connected', 'token_revoked',
      'quota', 'rate_limited', 'allowlist', 'kill_switch', 'provider_error',
      'invalid_recipient', 'mailbox_unusable', 'followup_stopped', 'deletion_pending'
    ))
    or (status in ('reserved', 'provider_called', 'sent', 'unknown', 'queued') and failure_code is null)
  );

-- ---------------------------------------------------------------------------
-- Annual credit windows. Monthly plans are refreshed by the payment webhook.
-- An annual plan has no monthly payment, so this job calls the same
-- idempotent grant. A pending deletion is skipped so the reversal is not
-- undone. A signed-in session is refused.
-- ---------------------------------------------------------------------------

create function public.refresh_annual_credit_periods()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_count integer := 0;
begin
  if public.account_deletion_caller() is not null then
    return pg_catalog.jsonb_build_object('result', 'forbidden', 'users', 0);
  end if;

  for v_user in
    select u.id
      from public.users u
     where u.role = 'creator'
       and u.deletion_requested_at is null
       and exists (
         select 1
           from public.subscriptions s
          where s.user_id = u.id
            and s.billing_interval = 'year'
            and s.status in ('active', 'past_due')
       )
     order by u.id
  loop
    perform public.ensure_credit_grants(v_user);
    v_count := v_count + 1;
  end loop;

  return pg_catalog.jsonb_build_object('result', 'ok', 'users', v_count);
end;
$$;

comment on function public.refresh_annual_credit_periods() is
  'D178 Proposed. Calls ensure_credit_grants for creators on an active or past-due annual subscription. Skips a pending deletion. Does not grant the same 30-day key twice. service_role only. A signed-in session is forbidden.';

revoke all on function public.refresh_annual_credit_periods()
  from public, anon, authenticated;
grant execute on function public.refresh_annual_credit_periods() to service_role;

-- ---------------------------------------------------------------------------
-- OAuth start. Connect, reconnect, and grant-send all refuse.
-- ---------------------------------------------------------------------------

create or replace function public.gmail_oauth_begin(
  p_user_id uuid,
  p_state_digest text,
  p_nonce_digest text,
  p_verifier_ciphertext text,
  p_verifier_iv text,
  p_verifier_auth_tag text,
  p_key_version text,
  p_purpose text,
  p_target_mail_account_id uuid,
  p_requested_scopes text[],
  p_return_path text,
  p_ttl_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_id uuid;
  v_target public.mail_accounts%rowtype;
  v_revision bigint;
  v_requested text[];
  v_send_scopes text[];
begin
  if p_user_id is null then
    raise exception 'gmail_oauth_begin requires an authenticated user'
      using errcode = 'invalid_parameter_value';
  end if;

  if public.account_gmail_blocked(p_user_id) then
    return jsonb_build_object('result', 'deletion_pending');
  end if;

  v_requested := public.canonical_scope_set(p_requested_scopes);
  v_send_scopes := public.canonical_scope_set(array[
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/gmail.readonly',
    'https://www.googleapis.com/auth/gmail.send'
  ]);

  -- Connect and reconnect stay on the B02 set. Asking for gmail.send there
  -- is refused before a transaction row exists.
  if p_purpose in ('connect', 'reconnect')
     and 'https://www.googleapis.com/auth/gmail.send' = any (v_requested) then
    return jsonb_build_object('result', 'scope_refused');
  end if;

  if p_purpose = 'reconnect' then
    if p_target_mail_account_id is null then
      return jsonb_build_object('result', 'invalid_target');
    end if;

    select m.* into v_target
      from public.mail_accounts m
     where m.id = p_target_mail_account_id
       and m.user_id = p_user_id
       and m.provider = 'gmail'
     for no key update;

    if not found then
      return jsonb_build_object('result', 'invalid_target');
    end if;

    if v_target.connection_state not in
       ('disconnected', 'reauth_required', 'pending_authorization', 'consent_required') then
      return jsonb_build_object(
        'result', 'not_reconnectable',
        'connection_state', v_target.connection_state
      );
    end if;

    v_revision := v_target.authorization_revision;
  elsif p_purpose = 'grant_send' then
    if p_target_mail_account_id is null then
      return jsonb_build_object('result', 'invalid_target');
    end if;
    if v_requested is distinct from v_send_scopes then
      return jsonb_build_object('result', 'scope_refused');
    end if;

    select m.* into v_target
      from public.mail_accounts m
     where m.id = p_target_mail_account_id
       and m.user_id = p_user_id
       and m.provider = 'gmail'
     for no key update;

    if not found then
      return jsonb_build_object('result', 'invalid_target');
    end if;

    if v_target.connection_state <> 'connected' then
      return jsonb_build_object(
        'result', 'not_connected',
        'connection_state', v_target.connection_state
      );
    end if;

    v_revision := v_target.authorization_revision;
  elsif p_purpose is distinct from 'connect' then
    return jsonb_build_object('result', 'invalid_target');
  elsif p_target_mail_account_id is not null then
    return jsonb_build_object('result', 'invalid_target');
  end if;

  delete from private.gmail_oauth_transactions where expires_at <= now();

  insert into private.gmail_oauth_transactions
    (user_id, state_digest, nonce_digest, code_verifier_ciphertext,
     code_verifier_iv, code_verifier_auth_tag, encryption_key_version,
     purpose, target_mail_account_id, target_authorization_revision,
     requested_scopes, return_path, expires_at)
  values
    (p_user_id, p_state_digest, p_nonce_digest, p_verifier_ciphertext,
     p_verifier_iv, p_verifier_auth_tag, p_key_version,
     p_purpose,
     case when p_purpose in ('reconnect', 'grant_send') then p_target_mail_account_id end,
     v_revision,
     v_requested, p_return_path,
     now() + make_interval(secs => greatest(p_ttl_seconds, 1)))
  returning id into v_id;

  return jsonb_build_object(
    'result', 'ok',
    'id', v_id,
    'target_authorization_revision', v_revision
  );
end;
$$;

comment on function public.gmail_oauth_begin(uuid, text, text, text, text, text, text, text, uuid, text[], text, integer) is
  'Starts connect, reconnect, or grant-send. Refuses all three while account deletion is pending, and writes no transaction.';

-- ---------------------------------------------------------------------------
-- Sync. The due list and the login mark skip a pending deletion. Claim
-- reports deletion_pending before it opens a run or reads Gmail.
-- ---------------------------------------------------------------------------

create or replace function private.gmail_import_authorization_state(
  p_mail_account_id uuid,
  p_expected_authorization_revision bigint
)
returns text
language plpgsql
stable
set search_path = ''
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

  if public.account_gmail_blocked(v_account.user_id) then
    return 'deletion_pending';
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
  v_paid boolean;
begin
  if p_user_id is null then
    raise exception 'gmail_incremental_sync_request_login requires a user'
      using errcode = 'invalid_parameter_value';
  end if;

  if public.account_gmail_blocked(p_user_id) then
    return jsonb_build_object(
      'result', 'deletion_pending',
      'mailboxes_marked', 0,
      'mail_account_ids', to_jsonb('{}'::uuid[])
    );
  end if;

  v_paid := public._has_active_pro(p_user_id)
    or exists (
      select 1
      from public.access_entitlements e
      where e.user_id = p_user_id
        and e.access_type = 'destination'
        and e.status = 'active'
        and e.starts_at <= pg_catalog.now()
        and (e.expires_at is null or e.expires_at > pg_catalog.now())
    );

  if not v_paid then
    return jsonb_build_object(
      'result', 'ok',
      'mailboxes_marked', 0,
      'mail_account_ids', to_jsonb('{}'::uuid[])
    );
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
         and not public.account_gmail_blocked(m.user_id)
         and (
           public._has_active_pro(m.user_id)
           or exists (
             select 1
             from public.access_entitlements e
             where e.user_id = m.user_id
               and e.access_type = 'destination'
               and e.status = 'active'
               and e.starts_at <= pg_catalog.now()
               and (e.expires_at is null or e.expires_at > pg_catalog.now())
           )
         )
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

comment on function public.gmail_incremental_sync_request_login(uuid) is
  'Marks this user''s connected mailboxes due when they have active Pro or an active Destination Pass. A pending account deletion marks nothing.';

comment on function public.gmail_incremental_sync_list_due(integer) is
  'Due mailbox ids for the sync worker. Free users and pending deletions are omitted. No message content and no deletes.';

-- A pending deletion is held, not enqueued. The existing hold code is reused
-- so the page does not gain a new state.
create or replace function private.gmail_followup_hold(p_user_id uuid, p_mail_account_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_account public.mail_accounts%rowtype;
begin
  if public.account_gmail_blocked(p_user_id) then
    return 'mailbox';
  end if;
  if exists (
    select 1 from private.ai_account_pauses p
     where p.user_id = p_user_id and p.unpaused_at is null
  ) then
    return 'account_paused';
  end if;
  if exists (
    select 1 from private.gmail_send_pauses p
     where p.user_id = p_user_id and p.unpaused_at is null
  ) then
    return 'sends_paused';
  end if;
  if not exists (
    select 1 from public.access_entitlements e
     where e.user_id = p_user_id
       and e.access_type in ('pro', 'max')
       and e.status = 'active'
       and e.starts_at <= pg_catalog.now()
       and (e.expires_at is null or e.expires_at > pg_catalog.now())
  ) then
    return 'plan_required';
  end if;
  select m.* into v_account
    from public.mail_accounts m
   where m.id = p_mail_account_id
     and m.user_id = p_user_id
     and m.provider = 'gmail';
  if not found
     or v_account.connection_state is distinct from 'connected'
     or v_account.email_address is null
     or position('@' in v_account.email_address) = 0
     or not ('https://www.googleapis.com/auth/gmail.send' = any (v_account.granted_scopes))
     or not ('https://www.googleapis.com/auth/gmail.readonly' = any (v_account.granted_scopes))
  then
    return 'mailbox';
  end if;
  return null;
end;
$$;

-- Send reserve, the provider mark, and the claim. A pending deletion writes
-- no new queued row, does not set call_provider, and fails a queued or
-- reserved attempt before Gmail is called.
create or replace function public.gmail_send_reserve(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_idempotency_key text,
  p_kind text,
  p_recipient text,
  p_subject text,
  p_body text,
  p_hotel_id uuid,
  p_pipeline_item_id uuid,
  p_trip_id uuid,
  p_pitch_draft_id uuid,
  p_provider_thread_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_hash text;
  v_existing private.gmail_send_attempts%rowtype;
  v_account public.mail_accounts%rowtype;
  v_item_hotel uuid;
  v_item_trip uuid;
  v_thread text;
  v_paid boolean;
  v_failure text;
  v_not_before timestamptz;
  v_eligible timestamptz;
begin
  if p_user_id is null
     or p_idempotency_key is null
     or p_idempotency_key !~ '^[A-Za-z0-9_-]{16,80}$'
     or p_kind not in ('pitch', 'reply')
     or p_recipient is null
     or p_recipient <> btrim(p_recipient)
     or char_length(p_recipient) > 320
     or p_recipient !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
     or position(E'\n' in p_recipient) > 0
     or position(E'\r' in p_recipient) > 0
     or p_subject is null
     or char_length(btrim(p_subject)) < 1
     or char_length(p_subject) > 200
     or position(E'\n' in p_subject) > 0
     or position(E'\r' in p_subject) > 0
     or p_body is null
     or char_length(p_body) < 1
     or char_length(p_body) > 8000
  then
    return jsonb_build_object('result', 'invalid_input', 'call_provider', false);
  end if;

  if p_kind = 'pitch' and p_hotel_id is null then
    return jsonb_build_object('result', 'invalid_input', 'call_provider', false);
  end if;

  perform 1 from public.users where id = p_user_id for update;

  v_hash := public.gmail_send_payload_hash(
    p_kind, p_recipient, p_subject, p_body, p_hotel_id, p_pipeline_item_id,
    p_trip_id, p_pitch_draft_id, p_provider_thread_id
  );

  select a.* into v_existing
    from private.gmail_send_attempts a
   where a.user_id = p_user_id
     and a.idempotency_key = p_idempotency_key;

  if found then
    if v_existing.payload_sha256 is distinct from v_hash then
      return jsonb_build_object('result', 'idempotency_conflict', 'call_provider', false);
    end if;
    if v_existing.status = 'sent' then
      return (
        select jsonb_build_object(
          'result', 'sent',
          'call_provider', false,
          'attempt_id', e.attempt_id,
          'event_id', e.id,
          'provider_message_id', e.provider_message_id,
          'provider_thread_id', e.provider_thread_id,
          'binding_status', e.binding_status,
          'pipeline_item_id', e.pipeline_item_id,
          'trip_id', e.trip_id,
          'hotel_id', e.hotel_id
        )
          from private.gmail_sent_events e
         where e.attempt_id = v_existing.id
      );
    end if;
    if v_existing.status in ('provider_called', 'unknown') then
      return jsonb_build_object(
        'result', 'unknown',
        'call_provider', false,
        'attempt_id', v_existing.id,
        'failure_code', 'unknown'
      );
    end if;
    if v_existing.status in ('reserved', 'queued') then
      return jsonb_build_object(
        'result', 'in_progress',
        'call_provider', false,
        'attempt_id', v_existing.id
      );
    end if;
    if v_existing.status = 'failed' then
      return jsonb_build_object(
        'result', 'failed',
        'call_provider', false,
        'attempt_id', v_existing.id,
        'failure_code', v_existing.failure_code
      );
    end if;
  end if;

  if public.account_gmail_blocked(p_user_id) then
    return jsonb_build_object('result', 'deletion_pending', 'call_provider', false);
  end if;

  if exists (
    select 1 from private.ai_account_pauses p
     where p.user_id = p_user_id and p.unpaused_at is null
  ) then
    return jsonb_build_object('result', 'paused', 'call_provider', false, 'reason', 'account');
  end if;
  if exists (
    select 1 from private.gmail_send_pauses p
     where p.user_id = p_user_id and p.unpaused_at is null
  ) then
    return jsonb_build_object('result', 'paused', 'call_provider', false, 'reason', 'sends');
  end if;

  select cp.id into v_creator
    from public.creator_profiles cp
   where cp.user_id = p_user_id;
  if v_creator is null then
    return jsonb_build_object('result', 'not_found', 'call_provider', false);
  end if;

  select m.* into v_account
    from public.mail_accounts m
   where m.id = p_mail_account_id
     and m.user_id = p_user_id
     and m.provider = 'gmail';
  if not found then
    return jsonb_build_object('result', 'not_found', 'call_provider', false);
  end if;

  if p_hotel_id is not null and not exists (
    select 1 from public.hotels h where h.id = p_hotel_id
  ) then
    return jsonb_build_object('result', 'not_found', 'call_provider', false);
  end if;

  if p_kind = 'pitch' and not exists (
    select 1 from public.contact_unlocks u
     where u.user_id = p_user_id and u.hotel_id = p_hotel_id
  ) then
    return jsonb_build_object('result', 'not_found', 'call_provider', false);
  end if;

  if p_pipeline_item_id is not null then
    select pi.hotel_id, pi.trip_id into v_item_hotel, v_item_trip
      from public.pipeline_items pi
     where pi.id = p_pipeline_item_id
       and pi.creator_id = v_creator;
    if not found then
      return jsonb_build_object('result', 'not_found', 'call_provider', false);
    end if;
    if p_hotel_id is not null and v_item_hotel is distinct from p_hotel_id then
      return jsonb_build_object('result', 'invalid_input', 'call_provider', false);
    end if;
    p_hotel_id := coalesce(p_hotel_id, v_item_hotel);
  elsif p_kind = 'pitch' then
    select pi.id, pi.trip_id into p_pipeline_item_id, v_item_trip
      from public.pipeline_items pi
     where pi.creator_id = v_creator
       and pi.hotel_id = p_hotel_id
       and pi.status <> 'closed'
     limit 1;
  end if;

  if p_trip_id is not null and not exists (
    select 1 from public.trips t
     where t.id = p_trip_id and t.creator_id = v_creator
  ) then
    return jsonb_build_object('result', 'not_found', 'call_provider', false);
  end if;
  if p_trip_id is null then
    p_trip_id := v_item_trip;
  end if;

  if p_pitch_draft_id is not null and not exists (
    select 1
      from public.pitch_drafts d
      join public.creator_profiles cp on cp.id = d.creator_id
     where d.id = p_pitch_draft_id
       and cp.user_id = p_user_id
       and (p_hotel_id is null or d.hotel_id = p_hotel_id)
  ) then
    return jsonb_build_object('result', 'not_found', 'call_provider', false);
  end if;

  v_thread := null;
  if p_provider_thread_id is not null
     and char_length(btrim(p_provider_thread_id)) between 1 and 256
     and exists (
       select 1 from private.gmail_normalized_threads t
        where t.mail_account_id = p_mail_account_id
          and t.user_id = p_user_id
          and t.provider_thread_id = btrim(p_provider_thread_id)
     ) then
    v_thread := btrim(p_provider_thread_id);
  end if;

  v_failure := null;
  if p_kind = 'pitch' and not exists (
    select 1 from public.hotel_contacts c
     where c.hotel_id = p_hotel_id
       and c.email is not null
       and c.status <> 'invalid'
       and position('@' in c.email) > 0
       and (
         lower(btrim(c.email)) = lower(p_recipient)
         or (
           lower(split_part(btrim(c.email), '@', 2)) = lower(split_part(p_recipient, '@', 2))
           and not public.gmail_send_consumer_domain(lower(split_part(btrim(c.email), '@', 2)))
         )
       )
       and char_length(split_part(p_recipient, '@', 2)) > 0
  ) then
    v_failure := 'invalid_recipient';
  end if;

  if v_failure is null then
    select exists (
      select 1 from public.access_entitlements e
       where e.user_id = p_user_id
         and e.access_type in ('pro', 'max')
         and e.status = 'active'
         and e.starts_at <= now()
         and (e.expires_at is null or e.expires_at > now())
    ) into v_paid;
    if not v_paid then
      v_failure := 'plan_required';
    elsif v_account.connection_state <> 'connected' then
      v_failure := 'not_connected';
    elsif v_account.email_address is null or position('@' in v_account.email_address) = 0 then
      v_failure := 'mailbox_unusable';
    elsif not (
      'https://www.googleapis.com/auth/gmail.send' = any (v_account.granted_scopes)
      and 'https://www.googleapis.com/auth/gmail.readonly' = any (v_account.granted_scopes)
    ) then
      v_failure := 'scope_missing';
    end if;
  end if;

  v_not_before := pg_catalog.now();
  if v_failure is null then
    select s.next_eligible_at into v_eligible
      from private.gmail_send_schedule s
     where s.user_id = p_user_id;
    if v_eligible is not null and v_eligible > v_not_before then
      v_not_before := v_eligible;
    end if;
  end if;

  insert into private.gmail_send_attempts (
    user_id, mail_account_id, idempotency_key, payload_sha256, kind, status,
    failure_code, hotel_id, pipeline_item_id, trip_id, pitch_draft_id,
    recipient, subject, body, provider_thread_hint, dispatch_not_before
  ) values (
    p_user_id, p_mail_account_id, p_idempotency_key, v_hash, p_kind,
    case when v_failure is null then 'queued' else 'failed' end,
    v_failure, p_hotel_id, p_pipeline_item_id, p_trip_id, p_pitch_draft_id,
    p_recipient, p_subject, p_body, v_thread,
    case when v_failure is null then v_not_before else null end
  )
  returning * into v_existing;

  if v_failure is not null then
    return jsonb_build_object(
      'result', 'failed',
      'call_provider', false,
      'attempt_id', v_existing.id,
      'failure_code', v_failure
    );
  end if;

  return jsonb_build_object(
    'result', 'queued',
    'call_provider', false,
    'attempt_id', v_existing.id,
    'mail_account_id', v_existing.mail_account_id,
    'from_email', v_account.email_address,
    'recipient', v_existing.recipient,
    'subject', v_existing.subject,
    'body', v_existing.body,
    'provider_thread_id', v_thread,
    'pipeline_item_id', v_existing.pipeline_item_id,
    'trip_id', v_existing.trip_id,
    'hotel_id', v_existing.hotel_id
  );
end;
$$;


create or replace function public.gmail_send_mark_provider(
  p_user_id uuid,
  p_attempt_id uuid,
  p_pro_cap integer,
  p_max_cap integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row private.gmail_send_attempts%rowtype;
  v_account public.mail_accounts%rowtype;
  v_cap integer;
  v_pro integer;
  v_max integer;
  v_used integer;
  v_paid boolean;
  v_is_max boolean;
  v_zone text;
  v_local timestamp;
  v_hour integer;
  v_day_start timestamptz;
  v_open timestamp;
begin
  if p_user_id is null or p_attempt_id is null then
    return jsonb_build_object('result', 'not_found', 'call_provider', false);
  end if;

  perform 1 from public.users where id = p_user_id for update;

  select a.* into v_row
    from private.gmail_send_attempts a
   where a.id = p_attempt_id
     and a.user_id = p_user_id
   for update;

  if not found then
    return jsonb_build_object('result', 'not_found', 'call_provider', false);
  end if;

  if v_row.status = 'sent' then
    return jsonb_build_object('result', 'sent', 'call_provider', false, 'attempt_id', v_row.id);
  end if;
  if v_row.status in ('provider_called', 'unknown') then
    return jsonb_build_object('result', 'unknown', 'call_provider', false, 'attempt_id', v_row.id);
  end if;
  if v_row.status = 'failed' then
    return jsonb_build_object(
      'result', 'failed',
      'call_provider', false,
      'attempt_id', v_row.id,
      'failure_code', v_row.failure_code
    );
  end if;
  if v_row.status = 'queued' then
    return jsonb_build_object('result', 'deferred', 'call_provider', false, 'attempt_id', v_row.id);
  end if;

  if public.account_gmail_blocked(p_user_id) then
    update private.gmail_send_attempts
       set status = 'failed',
           failure_code = 'deletion_pending',
           updated_at = pg_catalog.now()
     where id = v_row.id
       and status in ('queued', 'reserved');
    return jsonb_build_object(
      'result', 'failed',
      'call_provider', false,
      'attempt_id', v_row.id,
      'failure_code', 'deletion_pending'
    );
  end if;

  select exists (
    select 1 from public.access_entitlements e
     where e.user_id = p_user_id
       and e.access_type in ('pro', 'max')
       and e.status = 'active'
       and e.starts_at <= now()
       and (e.expires_at is null or e.expires_at > now())
  ) into v_paid;

  select m.* into v_account
    from public.mail_accounts m
   where m.id = v_row.mail_account_id
     and m.user_id = p_user_id;

  if not v_paid then
    update private.gmail_send_attempts
       set status = 'failed', failure_code = 'plan_required', updated_at = now()
     where id = v_row.id;
    return jsonb_build_object('result', 'failed', 'call_provider', false, 'failure_code', 'plan_required');
  end if;
  if v_account.connection_state is distinct from 'connected'
     or not ('https://www.googleapis.com/auth/gmail.send' = any (coalesce(v_account.granted_scopes, '{}'))) then
    update private.gmail_send_attempts
       set status = 'failed',
           failure_code = case
             when v_account.connection_state is distinct from 'connected' then 'not_connected'
             else 'scope_missing'
           end,
           updated_at = now()
     where id = v_row.id;
    return jsonb_build_object(
      'result', 'failed',
      'call_provider', false,
      'failure_code', case
        when v_account.connection_state is distinct from 'connected' then 'not_connected'
        else 'scope_missing'
      end
    );
  end if;

  if exists (
    select 1 from private.ai_account_pauses p
     where p.user_id = p_user_id and p.unpaused_at is null
  ) or exists (
    select 1 from private.gmail_send_pauses p
     where p.user_id = p_user_id and p.unpaused_at is null
  ) then
    update private.gmail_send_attempts
       set status = 'queued', updated_at = now()
     where id = v_row.id;
    return jsonb_build_object('result', 'paused', 'call_provider', false, 'attempt_id', v_row.id);
  end if;

  v_pro := coalesce(p_pro_cap, 120);
  if v_pro < 1 then v_pro := 120; end if;
  if v_pro > 240 then v_pro := 240; end if;
  v_max := coalesce(p_max_cap, 300);
  if v_max < 1 then v_max := 300; end if;
  if v_max > 600 then v_max := 600; end if;

  select exists (
    select 1 from public.access_entitlements e
     where e.user_id = p_user_id
       and e.access_type = 'max'
       and e.status = 'active'
       and e.starts_at <= now()
       and (e.expires_at is null or e.expires_at > now())
  ) into v_is_max;
  v_cap := case when v_is_max then v_max else v_pro end;

  select public.ai_zone_name(u.timezone) into v_zone
    from public.users u where u.id = p_user_id;
  v_local := now() at time zone v_zone;
  v_hour := extract(hour from v_local)::integer;
  v_day_start := date_trunc('day', v_local) at time zone v_zone;

  select count(*)::integer into v_used
    from private.gmail_send_attempts a
   where a.user_id = p_user_id
     and a.id <> v_row.id
     and a.provider_started_at is not null
     and a.provider_started_at >= v_day_start
     and a.provider_started_at < v_day_start + interval '1 day';

  if v_hour < 9 or v_hour >= 18 or v_used >= v_cap then
    if v_hour < 9 then
      v_open := date_trunc('day', v_local) + interval '9 hours';
    else
      v_open := date_trunc('day', v_local) + interval '1 day 9 hours';
    end if;
    update private.gmail_send_attempts
       set status = 'queued',
           dispatch_not_before = v_open at time zone v_zone,
           updated_at = now()
     where id = v_row.id;
    return jsonb_build_object(
      'result', 'deferred',
      'call_provider', false,
      'attempt_id', v_row.id,
      'daily_cap', v_cap
    );
  end if;

  update private.gmail_send_attempts
     set status = 'provider_called',
         provider_started_at = now(),
         updated_at = now()
   where id = v_row.id
     and status = 'reserved';

  return jsonb_build_object(
    'result', 'ok',
    'call_provider', true,
    'attempt_id', v_row.id,
    'daily_cap', v_cap
  );
end;
$$;


create or replace function public.gmail_send_claim_due(
  p_now timestamptz,
  p_limit integer,
  p_spacing_seconds integer,
  p_pro_cap integer,
  p_max_cap integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 10), 1), 25);
  v_spacing integer := coalesce(p_spacing_seconds, 240);
  v_pro integer;
  v_max integer;
  v_user uuid;
  v_zone text;
  v_local timestamp;
  v_hour integer;
  v_attempt private.gmail_send_attempts%rowtype;
  v_account public.mail_accounts%rowtype;
  v_cap integer;
  v_used integer;
  v_day_start timestamptz;
  v_claims jsonb := '[]'::jsonb;
  v_open timestamp;
  v_is_max boolean;
  v_seen integer := 0;
begin
  if p_now is null then
    return jsonb_build_object('result', 'invalid_input', 'claims', '[]'::jsonb);
  end if;
  if v_spacing < 180 or v_spacing > 300 then
    v_spacing := 240;
  end if;
  v_pro := coalesce(p_pro_cap, 120);
  if v_pro < 1 then v_pro := 120; end if;
  if v_pro > 240 then v_pro := 240; end if;
  v_max := coalesce(p_max_cap, 300);
  if v_max < 1 then v_max := 300; end if;
  if v_max > 600 then v_max := 600; end if;

  update private.gmail_send_attempts
     set status = 'unknown',
         updated_at = p_now
   where status = 'reserved'
     and updated_at < p_now - interval '15 minutes';

  perform public.gmail_followup_settle(p_now, null);

  update private.gmail_send_attempts a
     set status = 'failed',
         failure_code = 'deletion_pending',
         updated_at = p_now
   where a.status in ('queued', 'reserved')
     and public.account_gmail_blocked(a.user_id);


  for v_user in
    select a.user_id
      from private.gmail_send_attempts a
     where a.status = 'queued'
       and coalesce(a.dispatch_not_before, '-infinity'::timestamptz) <= p_now
     group by a.user_id
     order by min(a.dispatch_not_before), a.user_id
     limit 100
  loop
    exit when jsonb_array_length(v_claims) >= v_limit;
    v_seen := v_seen + 1;
    exit when v_seen > 100;

    perform 1 from public.users u where u.id = v_user for update;

    if exists (
      select 1 from private.ai_account_pauses p
       where p.user_id = v_user and p.unpaused_at is null
    ) or exists (
      select 1 from private.gmail_send_pauses p
       where p.user_id = v_user and p.unpaused_at is null
    ) then
      continue;
    end if;

    if exists (
      select 1 from private.gmail_send_schedule s
       where s.user_id = v_user and s.next_eligible_at > p_now
    ) then
      continue;
    end if;

    select public.ai_zone_name(u.timezone) into v_zone
      from public.users u where u.id = v_user;
    v_local := p_now at time zone v_zone;
    v_hour := extract(hour from v_local)::integer;

    if v_hour < 9 or v_hour >= 18 then
      if v_hour < 9 then
        v_open := date_trunc('day', v_local) + interval '9 hours';
      else
        v_open := date_trunc('day', v_local) + interval '1 day 9 hours';
      end if;
      update private.gmail_send_attempts
         set dispatch_not_before = v_open at time zone v_zone,
             updated_at = p_now
       where user_id = v_user
         and status = 'queued'
         and coalesce(dispatch_not_before, '-infinity'::timestamptz) <= p_now;
      continue;
    end if;

    select exists (
      select 1 from public.access_entitlements e
       where e.user_id = v_user
         and e.access_type = 'max'
         and e.status = 'active'
         and e.starts_at <= p_now
         and (e.expires_at is null or e.expires_at > p_now)
    ) into v_is_max;
    v_cap := case when v_is_max then v_max else v_pro end;
    v_day_start := date_trunc('day', v_local) at time zone v_zone;

    select count(*)::integer into v_used
      from private.gmail_send_attempts a
     where a.user_id = v_user
       and a.provider_started_at is not null
       and a.provider_started_at >= v_day_start
       and a.provider_started_at < v_day_start + interval '1 day';

    if v_used >= v_cap then
      v_open := date_trunc('day', v_local) + interval '1 day 9 hours';
      update private.gmail_send_attempts
         set dispatch_not_before = v_open at time zone v_zone,
             updated_at = p_now
       where user_id = v_user
         and status = 'queued';
      continue;
    end if;

    select a.* into v_attempt
      from private.gmail_send_attempts a
     where a.user_id = v_user
       and a.status = 'queued'
       and coalesce(a.dispatch_not_before, '-infinity'::timestamptz) <= p_now
     order by a.created_at, a.id
     limit 1
     for update skip locked;

    if not found then
      continue;
    end if;

    select m.* into v_account
      from public.mail_accounts m
     where m.id = v_attempt.mail_account_id
       and m.user_id = v_user;

    update private.gmail_send_attempts
       set status = 'reserved',
           updated_at = p_now
     where id = v_attempt.id;

    insert into private.gmail_send_schedule (user_id, next_eligible_at)
    values (v_user, p_now + make_interval(secs => v_spacing))
    on conflict (user_id) do update
      set next_eligible_at = excluded.next_eligible_at;

    update private.gmail_send_attempts
       set dispatch_not_before = p_now + make_interval(secs => v_spacing),
           updated_at = p_now
     where user_id = v_user
       and status = 'queued'
       and id <> v_attempt.id
       and coalesce(dispatch_not_before, '-infinity'::timestamptz)
           < p_now + make_interval(secs => v_spacing);

    v_claims := v_claims || jsonb_build_array(jsonb_build_object(
      'result', 'reserved',
      'call_provider', true,
      'attempt_id', v_attempt.id,
      'user_id', v_user,
      'mail_account_id', v_attempt.mail_account_id,
      'from_email', v_account.email_address,
      'recipient', v_attempt.recipient,
      'subject', v_attempt.subject,
      'body', v_attempt.body,
      'provider_thread_id', v_attempt.provider_thread_hint,
      'kind', v_attempt.kind,
      'pipeline_item_id', v_attempt.pipeline_item_id,
      'trip_id', v_attempt.trip_id,
      'hotel_id', v_attempt.hotel_id,
      'daily_cap', v_cap
    ));
  end loop;

  return jsonb_build_object('result', 'ok', 'claims', v_claims);
end;
$$;


comment on function public.gmail_send_reserve(uuid, uuid, text, text, text, text, text, uuid, uuid, uuid, uuid, text) is
  'D157 and D168. Service role only. A new pitch is queued. Refuses a new row while account deletion is pending. A hotel recipient must match a contact exactly, or that contact''s domain when the domain is not a consumer mailbox.';

comment on function public.gmail_send_mark_provider(uuid, uuid, integer, integer) is
  'D168. Service role only. Marks provider_called or defers a queued send. Refuses the provider call while account deletion is pending. A soft cap does not fail the attempt. Sends no mail by itself.';

comment on function public.gmail_send_claim_due(timestamptz, integer, integer, integer, integer) is
  'D168. Service role only. Settles due follow-ups first, fails queued or reserved attempts for a pending account deletion, then claims at most one queued send per remaining creator inside local 09:00–18:00. Does not call Gmail.';
