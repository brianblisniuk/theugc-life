-- ===========================================================================
-- 0089 — GMAIL SEND FROM THE OS (D04, D156–D161)
-- ===========================================================================
-- A creator on Pro or Max can send one pitch or reply through their own
-- connected Gmail. The send is an explicit action. A template or an AI draft
-- is not sent by this migration. Nothing here schedules a follow-up (D05).
--
-- gmail.send is requested only by a grant_send authorization, never by
-- connect or reconnect. Widening the granted set still requires a new
-- private-processing receipt, and that receipt must use the send policy
-- version when the mailbox holds gmail.send.
--
-- A successful send writes one private sent event with Gmail's message id
-- and thread id, linked to the hotel, pipeline item, trip, and draft the
-- creator named. It does not change pipeline_items.status and it does not
-- insert outreach_events. When the creator named a pipeline item, the
-- existing D06 bind runs once the thread is stored. A conflicting bind is
-- left where the creator put it.
--
-- 0001–0088 are not edited.

-- ---------------------------------------------------------------------------
-- 1. Incremental authorization purpose
-- ---------------------------------------------------------------------------

alter table private.gmail_oauth_transactions
  drop constraint gmail_oauth_transactions_purpose_check;

alter table private.gmail_oauth_transactions
  add constraint gmail_oauth_transactions_purpose_check
  check (purpose in ('connect', 'reconnect', 'grant_send'));

alter table private.gmail_oauth_transactions
  drop constraint gmail_oauth_transactions_purpose_target_iff;

alter table private.gmail_oauth_transactions
  add constraint gmail_oauth_transactions_purpose_target_iff
  check (
    (purpose = 'connect'
      and target_mail_account_id is null
      and target_authorization_revision is null)
    or (purpose in ('reconnect', 'grant_send')
      and target_mail_account_id is not null
      and target_authorization_revision is not null)
  );

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

-- Land gmail.send on a mailbox that is already connected. A missing send
-- scope writes nothing. A wider set moves the mailbox to consent_required
-- until a receipt names that set. The refresh token is replaced because
-- Google issued a new one for this grant.
create or replace function public.gmail_send_scope_persist(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_expected_revision bigint,
  p_oauth_intent_seq bigint,
  p_provider_account_subject text,
  p_email_address text,
  p_granted_scopes text[],
  p_refresh_ciphertext text,
  p_refresh_iv text,
  p_refresh_auth_tag text,
  p_key_version text,
  p_provider_refresh_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_account public.mail_accounts%rowtype;
  v_scopes text[];
  v_consent_state text;
  v_consent_scopes text[];
begin
  if p_user_id is null or p_mail_account_id is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select m.* into v_account
    from public.mail_accounts m
   where m.id = p_mail_account_id
     and m.user_id = p_user_id
     and m.provider = 'gmail'
   for no key update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_account.provider_account_subject <> p_provider_account_subject then
    return jsonb_build_object('result', 'account_mismatch');
  end if;

  if private.gmail_flow_superseded_by_disconnect(v_account, p_oauth_intent_seq) then
    return jsonb_build_object(
      'result', 'superseded_by_disconnect',
      'connection_state', v_account.connection_state,
      'mail_account_id', v_account.id
    );
  end if;

  if v_account.authorization_revision is distinct from p_expected_revision
     or v_account.connection_state <> 'connected' then
    return jsonb_build_object(
      'result', 'state_changed',
      'connection_state', v_account.connection_state
    );
  end if;

  v_scopes := public.canonical_scope_set(p_granted_scopes);
  if not (v_scopes <@ public.approved_gmail_scopes()) then
    return jsonb_build_object('result', 'scope_refused', 'detail', 'forbidden_scope');
  end if;
  if not ('https://www.googleapis.com/auth/gmail.readonly' = any (v_scopes)) then
    return jsonb_build_object('result', 'scope_refused', 'detail', 'missing_read');
  end if;
  if not ('https://www.googleapis.com/auth/gmail.send' = any (v_scopes)) then
    return jsonb_build_object('result', 'scope_refused', 'detail', 'missing_send');
  end if;

  select c.state, r.granted_scopes_at_decision
    into v_consent_state, v_consent_scopes
    from public.mail_account_consents c
    join public.mail_account_consent_receipts r on r.id = c.current_receipt_id
   where c.mail_account_id = v_account.id
     and c.consent_kind = 'private_gmail_processing';

  perform set_config('b02.authorization_revision_bump', 'requested', true);

  update public.mail_accounts
     set granted_scopes = v_scopes,
         email_address = coalesce(p_email_address, email_address),
         connection_state = case
           when v_consent_state = 'granted' and v_consent_scopes is not distinct from v_scopes
             then 'connected'
           else 'consent_required'
         end,
         last_state_change_at = now()
   where id = v_account.id;

  insert into private.gmail_oauth_credentials
    (mail_account_id, user_id, refresh_token_ciphertext, refresh_token_iv,
     refresh_token_auth_tag, encryption_key_version, provider_refresh_token_expires_at)
  values
    (v_account.id, p_user_id, p_refresh_ciphertext, p_refresh_iv,
     p_refresh_auth_tag, p_key_version, p_provider_refresh_expires_at)
  on conflict (mail_account_id) do update
     set refresh_token_ciphertext = excluded.refresh_token_ciphertext,
         refresh_token_iv = excluded.refresh_token_iv,
         refresh_token_auth_tag = excluded.refresh_token_auth_tag,
         encryption_key_version = excluded.encryption_key_version,
         provider_refresh_token_expires_at = excluded.provider_refresh_token_expires_at,
         credential_generation = nextval('private.gmail_credential_generation_seq'),
         updated_at = now();

  if v_consent_state = 'granted' and v_consent_scopes is not distinct from v_scopes then
    return jsonb_build_object('result', 'connected', 'mail_account_id', v_account.id);
  end if;

  return jsonb_build_object('result', 'consent_required', 'mail_account_id', v_account.id);
end;
$$;

-- The send policy version is required when the mailbox holds gmail.send.
-- A readonly grant keeps accepting the policy version the caller records.
create or replace function public.gmail_grant_private_processing_consent(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_policy_version text,
  p_consent_text_digest text,
  p_receipt_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_account public.mail_accounts%rowtype;
  v_receipt_id uuid;
  v_event_seq bigint;
  v_has_credential boolean;
  v_has_send boolean;
begin
  select m.* into v_account
    from public.mail_accounts m
   where m.id = p_mail_account_id
     and m.user_id = p_user_id
   for no key update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_account.connection_state = 'deleted' then
    return jsonb_build_object('result', 'account_retired');
  end if;

  if v_account.connection_state <> 'consent_required' then
    return jsonb_build_object(
      'result', 'consent_not_applicable',
      'connection_state', v_account.connection_state
    );
  end if;

  select exists (
    select 1 from private.gmail_oauth_credentials c where c.mail_account_id = p_mail_account_id
  ) into v_has_credential;

  if not v_has_credential then
    return jsonb_build_object('result', 'no_credential');
  end if;

  v_has_send := 'https://www.googleapis.com/auth/gmail.send' = any (v_account.granted_scopes);
  -- A mailbox that holds gmail.send cannot be covered by any other policy
  -- version. Readonly grants keep the versions callers already recorded.
  if v_has_send and p_policy_version is distinct from 'gmail-private-processing/2026-10-14-send' then
    return jsonb_build_object('result', 'policy_mismatch');
  end if;

  insert into public.mail_account_consent_receipts
    (mail_account_id, user_id, consent_kind, decision, policy_version,
     consent_text_digest, granted_scopes_at_decision, decided_by_user_id,
     decided_at, receipt_digest)
  values
    (p_mail_account_id, p_user_id, 'private_gmail_processing', 'granted',
     p_policy_version, p_consent_text_digest, v_account.granted_scopes,
     p_user_id, now(), p_receipt_digest)
  returning id, event_seq into v_receipt_id, v_event_seq;

  insert into public.mail_account_consents
    (mail_account_id, user_id, consent_kind, state, current_receipt_id, current_event_seq)
  values
    (p_mail_account_id, p_user_id, 'private_gmail_processing', 'granted',
     v_receipt_id, v_event_seq)
  on conflict (mail_account_id, consent_kind) do update
     set state = excluded.state,
         current_receipt_id = excluded.current_receipt_id,
         current_event_seq = excluded.current_event_seq;

  update public.mail_accounts
     set connection_state = 'connected',
         connected_at = now(),
         last_state_change_at = now()
   where id = p_mail_account_id;

  return jsonb_build_object(
    'result', 'connected',
    'mail_account_id', p_mail_account_id,
    'receipt_id', v_receipt_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Private send attempts and the exact sent event
-- ---------------------------------------------------------------------------

create table private.gmail_send_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  mail_account_id uuid not null,
  idempotency_key text not null,
  payload_sha256 text not null,
  kind text not null,
  status text not null,
  failure_code text,
  hotel_id uuid,
  pipeline_item_id uuid,
  trip_id uuid,
  pitch_draft_id uuid,
  recipient text not null,
  subject text not null,
  body text not null,
  provider_thread_hint text,
  provider_started_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gmail_send_attempts_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,
  constraint gmail_send_attempts_key_uidx unique (user_id, idempotency_key),
  constraint gmail_send_attempts_kind_check check (kind in ('pitch', 'reply')),
  constraint gmail_send_attempts_status_check check (
    status in ('reserved', 'provider_called', 'sent', 'failed', 'unknown')
  ),
  constraint gmail_send_attempts_failure_check check (
    (status = 'failed' and failure_code in (
      'plan_required', 'scope_missing', 'not_connected', 'token_revoked',
      'quota', 'rate_limited', 'allowlist', 'kill_switch', 'provider_error',
      'invalid_recipient', 'mailbox_unusable'
    ))
    or (status in ('reserved', 'provider_called', 'sent', 'unknown') and failure_code is null)
  ),
  constraint gmail_send_attempts_hotel_fk
    foreign key (hotel_id) references public.hotels (id) on delete set null,
  constraint gmail_send_attempts_pipeline_fk
    foreign key (pipeline_item_id) references public.pipeline_items (id) on delete set null,
  constraint gmail_send_attempts_trip_fk
    foreign key (trip_id) references public.trips (id) on delete set null,
  constraint gmail_send_attempts_draft_fk
    foreign key (pitch_draft_id) references public.pitch_drafts (id) on delete set null
);

create index gmail_send_attempts_user_started_idx
  on private.gmail_send_attempts (user_id, provider_started_at);

comment on table private.gmail_send_attempts is
  'D157. One explicit Gmail send attempt. The idempotency key is unique per creator. provider_called is written before the Gmail call. A second call with the same key does not send again.';

create table private.gmail_sent_events (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null unique
    references private.gmail_send_attempts (id) on delete cascade,
  user_id uuid not null,
  mail_account_id uuid not null,
  kind text not null,
  hotel_id uuid,
  pipeline_item_id uuid,
  trip_id uuid,
  pitch_draft_id uuid,
  recipient text not null,
  subject text not null,
  provider_message_id text not null,
  provider_thread_id text not null,
  binding_status text not null,
  sent_at timestamptz not null default now(),
  constraint gmail_sent_events_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,
  constraint gmail_sent_events_message_uidx unique (mail_account_id, provider_message_id),
  constraint gmail_sent_events_kind_check check (kind in ('pitch', 'reply')),
  constraint gmail_sent_events_binding_check check (
    binding_status in ('not_requested', 'pending_thread', 'bound', 'conflict')
  ),
  constraint gmail_sent_events_ids_check check (
    char_length(btrim(provider_message_id)) between 1 and 256
    and char_length(btrim(provider_thread_id)) between 1 and 256
  )
);

create index gmail_sent_events_user_idx
  on private.gmail_sent_events (user_id, sent_at desc);

comment on table private.gmail_sent_events is
  'D158. The exact sent event: Gmail message id, thread id, and the hotel, pipeline item, trip, and draft it belongs to. It does not change pipeline status.';

alter table private.gmail_send_attempts enable row level security;
alter table private.gmail_sent_events enable row level security;

revoke all on private.gmail_send_attempts from public, anon, authenticated, service_role;
revoke all on private.gmail_sent_events from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Reserve, mark, commit, fail
-- ---------------------------------------------------------------------------

create or replace function public.gmail_send_payload_hash(
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
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select encode(public.digest(convert_to(
    coalesce(p_kind, '') || '|' ||
    lower(btrim(coalesce(p_recipient, ''))) || '|' ||
    coalesce(p_subject, '') || '|' ||
    coalesce(p_body, '') || '|' ||
    coalesce(p_hotel_id::text, '') || '|' ||
    coalesce(p_pipeline_item_id::text, '') || '|' ||
    coalesce(p_trip_id::text, '') || '|' ||
    coalesce(p_pitch_draft_id::text, '') || '|' ||
    coalesce(p_provider_thread_id, ''),
    'UTF8'), 'sha256'), 'hex');
$$;

revoke all on function public.gmail_send_payload_hash(text, text, text, text, uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;

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
set search_path = public, private, pg_temp
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
    if v_existing.status = 'reserved'
       and v_existing.updated_at > now() - interval '2 minutes' then
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
       and lower(btrim(c.email)) = lower(p_recipient)
       and c.status <> 'invalid'
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

  if v_existing.id is not null and v_existing.status = 'reserved' then
    update private.gmail_send_attempts
       set status = case when v_failure is null then 'reserved' else 'failed' end,
           failure_code = v_failure,
           updated_at = now()
     where id = v_existing.id;
    if v_failure is not null then
      return jsonb_build_object(
        'result', 'failed',
        'call_provider', false,
        'attempt_id', v_existing.id,
        'failure_code', v_failure
      );
    end if;
    return jsonb_build_object(
      'result', 'reserved',
      'call_provider', true,
      'attempt_id', v_existing.id,
      'mail_account_id', v_existing.mail_account_id,
      'from_email', v_account.email_address,
      'recipient', v_existing.recipient,
      'subject', v_existing.subject,
      'body', v_existing.body,
      'provider_thread_id', v_thread
    );
  end if;

  insert into private.gmail_send_attempts (
    user_id, mail_account_id, idempotency_key, payload_sha256, kind, status,
    failure_code, hotel_id, pipeline_item_id, trip_id, pitch_draft_id,
    recipient, subject, body, provider_thread_hint
  ) values (
    p_user_id, p_mail_account_id, p_idempotency_key, v_hash, p_kind,
    case when v_failure is null then 'reserved' else 'failed' end,
    v_failure, p_hotel_id, p_pipeline_item_id, p_trip_id, p_pitch_draft_id,
    p_recipient, p_subject, p_body, v_thread
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
    'result', 'reserved',
    'call_provider', true,
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
  p_daily_cap integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_row private.gmail_send_attempts%rowtype;
  v_account public.mail_accounts%rowtype;
  v_cap integer;
  v_day timestamptz;
  v_used integer;
  v_last timestamptz;
  v_paid boolean;
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

  v_cap := coalesce(p_daily_cap, 20);
  if v_cap > 40 then
    v_cap := 40;
  end if;
  if v_cap < 1 then
    v_cap := 1;
  end if;

  v_day := date_trunc('day', now() at time zone 'utc') at time zone 'utc';

  select count(*)::int, max(provider_started_at)
    into v_used, v_last
    from private.gmail_send_attempts a
   where a.user_id = p_user_id
     and a.id <> v_row.id
     and a.provider_started_at is not null
     and a.provider_started_at >= v_day;

  if v_last is not null and v_last > now() - interval '10 seconds' then
    update private.gmail_send_attempts
       set status = 'failed', failure_code = 'rate_limited', updated_at = now()
     where id = v_row.id;
    return jsonb_build_object(
      'result', 'failed',
      'call_provider', false,
      'failure_code', 'rate_limited',
      'daily_cap', v_cap
    );
  end if;

  if v_used >= v_cap then
    update private.gmail_send_attempts
       set status = 'failed', failure_code = 'rate_limited', updated_at = now()
     where id = v_row.id;
    return jsonb_build_object(
      'result', 'failed',
      'call_provider', false,
      'failure_code', 'rate_limited',
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

create or replace function public.gmail_send_fail(
  p_user_id uuid,
  p_attempt_id uuid,
  p_code text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_row private.gmail_send_attempts%rowtype;
begin
  if p_user_id is null or p_attempt_id is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select a.* into v_row
    from private.gmail_send_attempts a
   where a.id = p_attempt_id
     and a.user_id = p_user_id
   for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_row.status = 'sent' then
    return jsonb_build_object('result', 'sent', 'attempt_id', v_row.id);
  end if;
  if v_row.status = 'unknown' then
    return jsonb_build_object('result', 'unknown', 'attempt_id', v_row.id, 'failure_code', 'unknown');
  end if;
  if v_row.status = 'failed' then
    return jsonb_build_object(
      'result', 'failed',
      'attempt_id', v_row.id,
      'failure_code', v_row.failure_code
    );
  end if;

  if p_code = 'unknown' and v_row.status = 'provider_called' then
    update private.gmail_send_attempts
       set status = 'unknown', updated_at = now()
     where id = v_row.id;
    return jsonb_build_object('result', 'unknown', 'attempt_id', v_row.id, 'failure_code', 'unknown');
  end if;

  if p_code not in (
    'plan_required', 'scope_missing', 'not_connected', 'token_revoked',
    'quota', 'rate_limited', 'allowlist', 'kill_switch', 'provider_error',
    'invalid_recipient', 'mailbox_unusable'
  ) then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  if v_row.status = 'reserved' and p_code in ('token_revoked', 'quota', 'provider_error') then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  update private.gmail_send_attempts
     set status = 'failed', failure_code = p_code, updated_at = now()
   where id = v_row.id;

  return jsonb_build_object('result', 'failed', 'attempt_id', v_row.id, 'failure_code', p_code);
end;
$$;

create or replace function public.gmail_send_bind_pending(
  p_user_id uuid,
  p_mail_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_event private.gmail_sent_events%rowtype;
  v_bind jsonb;
  v_result text;
  v_status text;
  v_bound integer := 0;
begin
  if p_user_id is null or p_mail_account_id is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  if not exists (
    select 1 from public.mail_accounts m
     where m.id = p_mail_account_id and m.user_id = p_user_id
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  for v_event in
    select e.*
      from private.gmail_sent_events e
     where e.user_id = p_user_id
       and e.mail_account_id = p_mail_account_id
       and e.binding_status = 'pending_thread'
       and e.pipeline_item_id is not null
     order by e.sent_at
  loop
    v_bind := public.bind_pipeline_inbox_thread(
      p_user_id, v_event.pipeline_item_id, p_mail_account_id, v_event.provider_thread_id
    );
    v_result := v_bind->>'result';
    if v_bind ? 'binding_id' or v_result = 'already_bound' then
      v_status := 'bound';
    elsif v_result in ('item_already_bound', 'thread_already_bound') then
      v_status := 'conflict';
    else
      v_status := 'pending_thread';
    end if;
    if v_status is distinct from 'pending_thread' then
      update private.gmail_sent_events
         set binding_status = v_status
       where id = v_event.id;
      v_bound := v_bound + 1;
    end if;
  end loop;

  return jsonb_build_object('result', 'ok', 'updated', v_bound);
end;
$$;

create or replace function public.gmail_send_commit(
  p_user_id uuid,
  p_attempt_id uuid,
  p_provider_message_id text,
  p_provider_thread_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_row private.gmail_send_attempts%rowtype;
  v_event private.gmail_sent_events%rowtype;
  v_status_before text;
  v_pitched timestamptz;
  v_outreach integer;
begin
  if p_user_id is null or p_attempt_id is null
     or p_provider_message_id is null
     or p_provider_thread_id is null
     or char_length(btrim(p_provider_message_id)) not between 1 and 256
     or char_length(btrim(p_provider_thread_id)) not between 1 and 256
     or p_provider_message_id is distinct from btrim(p_provider_message_id)
     or p_provider_thread_id is distinct from btrim(p_provider_thread_id)
  then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select a.* into v_row
    from private.gmail_send_attempts a
   where a.id = p_attempt_id
     and a.user_id = p_user_id
   for update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_row.status = 'sent' then
    select e.* into v_event from private.gmail_sent_events e where e.attempt_id = v_row.id;
    return jsonb_build_object(
      'result', 'sent',
      'event_id', v_event.id,
      'provider_message_id', v_event.provider_message_id,
      'provider_thread_id', v_event.provider_thread_id,
      'binding_status', v_event.binding_status
    );
  end if;

  if v_row.status <> 'provider_called' then
    return jsonb_build_object('result', 'not_ready', 'status', v_row.status);
  end if;

  if v_row.pipeline_item_id is not null then
    select pi.status, pi.first_pitched_at into v_status_before, v_pitched
      from public.pipeline_items pi
     where pi.id = v_row.pipeline_item_id;
  end if;
  select count(*)::int into v_outreach
    from public.outreach_events oe
   where oe.creator_id = (
     select cp.id from public.creator_profiles cp where cp.user_id = p_user_id
   );

  insert into private.gmail_sent_events (
    attempt_id, user_id, mail_account_id, kind, hotel_id, pipeline_item_id,
    trip_id, pitch_draft_id, recipient, subject, provider_message_id,
    provider_thread_id, binding_status
  ) values (
    v_row.id, v_row.user_id, v_row.mail_account_id, v_row.kind, v_row.hotel_id,
    v_row.pipeline_item_id, v_row.trip_id, v_row.pitch_draft_id, v_row.recipient,
    v_row.subject, p_provider_message_id, p_provider_thread_id,
    case when v_row.pipeline_item_id is null then 'not_requested' else 'pending_thread' end
  )
  returning * into v_event;

  update private.gmail_send_attempts
     set status = 'sent', updated_at = now()
   where id = v_row.id;

  -- D06 bind only. pipeline status and outreach_events stay as they were.
  if v_row.pipeline_item_id is not null then
    perform public.gmail_send_bind_pending(p_user_id, v_row.mail_account_id);
    select e.* into v_event from private.gmail_sent_events e where e.id = v_event.id;
  end if;

  if v_row.pipeline_item_id is not null then
    if exists (
      select 1 from public.pipeline_items pi
       where pi.id = v_row.pipeline_item_id
         and (pi.status is distinct from v_status_before
              or pi.first_pitched_at is distinct from v_pitched)
    ) then
      raise exception 'gmail send changed pipeline state'
        using errcode = '55000';
    end if;
  end if;

  if (
    select count(*)::int from public.outreach_events oe
     where oe.creator_id = (
       select cp.id from public.creator_profiles cp where cp.user_id = p_user_id
     )
  ) is distinct from v_outreach then
    raise exception 'gmail send wrote an outreach event'
      using errcode = '55000';
  end if;

  return jsonb_build_object(
    'result', 'sent',
    'event_id', v_event.id,
    'attempt_id', v_row.id,
    'provider_message_id', v_event.provider_message_id,
    'provider_thread_id', v_event.provider_thread_id,
    'binding_status', v_event.binding_status,
    'hotel_id', v_event.hotel_id,
    'pipeline_item_id', v_event.pipeline_item_id,
    'trip_id', v_event.trip_id,
    'pitch_draft_id', v_event.pitch_draft_id
  );
end;
$$;

create or replace function public.gmail_send_list_own()
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user uuid;
begin
  v_user := auth.uid();
  if v_user is null then
    return jsonb_build_object('result', 'signed_out');
  end if;

  return jsonb_build_object(
    'result', 'ok',
    'events', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id,
        'kind', e.kind,
        'hotel_id', e.hotel_id,
        'pipeline_item_id', e.pipeline_item_id,
        'trip_id', e.trip_id,
        'pitch_draft_id', e.pitch_draft_id,
        'provider_message_id', e.provider_message_id,
        'provider_thread_id', e.provider_thread_id,
        'binding_status', e.binding_status,
        'sent_at', e.sent_at,
        'subject', e.subject
      ) order by e.sent_at desc)
        from private.gmail_sent_events e
       where e.user_id = v_user
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Deletion
-- ---------------------------------------------------------------------------

create or replace function public.gmail_send_purge_for_deletion(
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
  v_events integer;
  v_attempts integer;
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
    delete from private.gmail_sent_events where mail_account_id = p_mail_account_id returning 1
  ) select count(*)::int into v_events from removed;

  with removed as (
    delete from private.gmail_send_attempts where mail_account_id = p_mail_account_id returning 1
  ) select count(*)::int into v_attempts from removed;

  return jsonb_build_object('result', 'ok', 'events', v_events, 'attempts', v_attempts);
end;
$$;

create or replace function public.erase_creator_account(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
  v_requested timestamptz;
  v_after timestamptz;
  v_mail record;
  v_purge jsonb;
begin
  if public.account_deletion_caller() is not null then
    return pg_catalog.jsonb_build_object('result', 'forbidden');
  end if;

  if p_user_id is null then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  select u.role, u.deletion_requested_at, u.delete_after
    into v_role, v_requested, v_after
    from public.users u
   where u.id = p_user_id
   for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  if v_role is distinct from 'creator' then
    return pg_catalog.jsonb_build_object('result', 'not_creator');
  end if;

  if v_requested is null or v_after is null then
    return pg_catalog.jsonb_build_object('result', 'not_scheduled');
  end if;

  if v_after > pg_catalog.now() then
    return pg_catalog.jsonb_build_object('result', 'not_due');
  end if;

  perform public.account_deletion_stop_gmail(p_user_id);

  for v_mail in
    select m.id, m.current_deletion_request_id as request_id
      from public.mail_accounts m
     where m.user_id = p_user_id
       and m.connection_state is distinct from 'deleted'
     order by m.id
  loop
    if v_mail.request_id is null then
      raise exception 'account erasure has no gmail deletion request'
        using errcode = '55000';
    end if;

    v_purge := public.gmail_historical_import_purge_for_deletion(
      p_user_id, v_mail.id, v_mail.request_id
    );
    if coalesce(v_purge->>'result', '') is distinct from 'ok' then
      raise exception 'gmail historical purge returned %', v_purge->>'result'
        using errcode = '55000';
    end if;

    v_purge := public.gmail_normalize_purge_for_deletion(
      p_user_id, v_mail.id, v_mail.request_id
    );
    if coalesce(v_purge->>'result', '') is distinct from 'ok' then
      raise exception 'gmail normalize purge returned %', v_purge->>'result'
        using errcode = '55000';
    end if;

    v_purge := public.gmail_outreach_purge_for_deletion(
      p_user_id, v_mail.id, v_mail.request_id
    );
    if coalesce(v_purge->>'result', '') is distinct from 'ok' then
      raise exception 'gmail outreach purge returned %', v_purge->>'result'
        using errcode = '55000';
    end if;

    v_purge := public.gmail_reply_purge_for_deletion(
      p_user_id, v_mail.id, v_mail.request_id
    );
    if coalesce(v_purge->>'result', '') is distinct from 'ok' then
      raise exception 'gmail reply purge returned %', v_purge->>'result'
        using errcode = '55000';
    end if;

    v_purge := public.gmail_commercial_purge_for_deletion(
      p_user_id, v_mail.id, v_mail.request_id
    );
    if coalesce(v_purge->>'result', '') is distinct from 'ok' then
      raise exception 'gmail commercial purge returned %', v_purge->>'result'
        using errcode = '55000';
    end if;

    v_purge := public.gmail_incremental_sync_purge_for_deletion(
      p_user_id, v_mail.id, v_mail.request_id
    );
    if coalesce(v_purge->>'result', '') is distinct from 'ok' then
      raise exception 'gmail sync purge returned %', v_purge->>'result'
        using errcode = '55000';
    end if;

    v_purge := public.gmail_send_purge_for_deletion(
      p_user_id, v_mail.id, v_mail.request_id
    );
    if coalesce(v_purge->>'result', '') is distinct from 'ok' then
      raise exception 'gmail send purge returned %', v_purge->>'result'
        using errcode = '55000';
    end if;
  end loop;

  perform pg_catalog.set_config('b07.purge', 'on', true);

  delete from public.users where id = p_user_id;
  delete from auth.users where id = p_user_id;

  return pg_catalog.jsonb_build_object('result', 'erased');
end;
$$;

comment on function public.erase_creator_account(uuid) is
  'D151 and D161. Removes one due creator and the personal rows that name them, including Gmail send attempts and sent events. service_role only.';

-- ---------------------------------------------------------------------------
-- 5. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.gmail_send_scope_persist(uuid, uuid, bigint, bigint, text, text, text[], text, text, text, text, timestamptz)
  from public, anon, authenticated, service_role;
grant execute on function public.gmail_send_scope_persist(uuid, uuid, bigint, bigint, text, text, text[], text, text, text, text, timestamptz)
  to service_role;

revoke all on function public.gmail_send_reserve(uuid, uuid, text, text, text, text, text, uuid, uuid, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.gmail_send_reserve(uuid, uuid, text, text, text, text, text, uuid, uuid, uuid, uuid, text)
  to service_role;

revoke all on function public.gmail_send_mark_provider(uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.gmail_send_mark_provider(uuid, uuid, integer)
  to service_role;

revoke all on function public.gmail_send_fail(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.gmail_send_fail(uuid, uuid, text)
  to service_role;

revoke all on function public.gmail_send_commit(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.gmail_send_commit(uuid, uuid, text, text)
  to service_role;

revoke all on function public.gmail_send_bind_pending(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.gmail_send_bind_pending(uuid, uuid)
  to service_role;

revoke all on function public.gmail_send_purge_for_deletion(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.gmail_send_purge_for_deletion(uuid, uuid, uuid)
  to service_role;

revoke all on function public.gmail_send_list_own()
  from public, anon, authenticated, service_role;
grant execute on function public.gmail_send_list_own()
  to authenticated, service_role;

comment on function public.gmail_send_reserve(uuid, uuid, text, text, text, text, text, uuid, uuid, uuid, uuid, text) is
  'D156–D158. Reserves one explicit send for the named creator. Free, a Destination Pass, and a missing gmail.send scope do not reach the provider. service_role only.';

comment on function public.gmail_send_list_own() is
  'D158. The signed-in creator''s sent events. Another creator''s rows are not selected. No message body.';
