-- 0101 — Gmail send in-flight, sync withhold, and consent receipt.
--
-- 0099 and 0100 are reserved by other PRs. Applied migrations are not edited.
--
-- unknown and provider_called stay in flight: cancel and schedule do not open
-- another follow-up, and reserve does not call the provider again for the
-- same creator, hotel, and recipient. A provider message id stored on the
-- attempt is committed again and is not sent again. A provider_called row
-- older than 15 minutes with no message id becomes failed so it can be
-- cancelled. Deletion fails provider_called when no message id is stored.
-- A gone sync thread still withholds the history cursor when a snapshot sent
-- id was not stored. The consent receipt must match the text implied by the
-- locked mailbox.


alter table private.gmail_send_attempts
  add column provider_message_id text,
  add column provider_thread_id text;

alter table private.gmail_send_attempts
  add constraint gmail_send_attempts_provider_ids_check
  check (
    (
      provider_message_id is null
      and provider_thread_id is null
    )
    or (
      provider_message_id is not null
      and provider_thread_id is not null
      and char_length(btrim(provider_message_id)) between 1 and 256
      and provider_message_id = btrim(provider_message_id)
      and char_length(btrim(provider_thread_id)) between 1 and 256
      and provider_thread_id = btrim(provider_thread_id)
    )
  );

comment on column private.gmail_send_attempts.provider_message_id is
  'Set when Gmail has returned a message id and before the sent event is committed. Null means that id was never stored. A later dispatch commits this id and does not call Gmail again.';

drop index private.gmail_followups_sequence_uidx;

create unique index gmail_followups_sequence_uidx
  on private.gmail_followups (user_id, mail_account_id, provider_thread_id, sequence)
  where status <> 'cancelled';

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
  v_expected_version text;
  v_expected_text text;
  v_expected_digest text;
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

  v_has_send := 'https://www.googleapis.com/auth/gmail.send' = any (coalesce(v_account.granted_scopes, '{}'));
  if v_has_send then
    v_expected_version := 'gmail-private-processing/2026-10-14-send';
    v_expected_text := $ugc_send$Allow TheUGC to send email from this Gmail account only when you explicitly choose Send. Drafts, templates, and AI drafts are not sent on their own. This applies to your own workspace only. Your Gmail data is not shared with other creators and does not contribute to any shared or network intelligence. You can withdraw this permission, disconnect the mailbox, or request deletion of the data derived from it at any time.$ugc_send$;
  else
    v_expected_version := 'gmail-private-processing/2026-08-27';
    v_expected_text := $ugc_read$Allow TheUGC to securely process this Gmail account to find and organize your travel collaboration conversations and build your private creator intelligence. This applies to your own workspace only. Your Gmail data is not shared with other creators and does not contribute to any shared or network intelligence. You can withdraw this permission, disconnect the mailbox, or request deletion of the data derived from it at any time.$ugc_read$;
  end if;
  v_expected_digest := encode(public.digest(convert_to(v_expected_text, 'utf8'), 'sha256'), 'hex');
  -- The form posts the version and digest it showed. The locked row is what
  -- those must match. A reconnect that added gmail.send after the form was
  -- rendered does not get a receipt for text the creator did not see.
  if p_policy_version is distinct from v_expected_version
     or p_consent_text_digest is distinct from v_expected_digest then
    return jsonb_build_object('result', 'consent_stale');
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

create or replace function public.gmail_send_commit(
  p_user_id uuid,
  p_attempt_id uuid,
  p_provider_message_id text,
  p_provider_thread_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
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

  if v_row.status not in ('provider_called', 'unknown') then
    return jsonb_build_object('result', 'not_ready', 'status', v_row.status);
  end if;

  if v_row.provider_message_id is not null
     and (
       v_row.provider_message_id is distinct from p_provider_message_id
       or v_row.provider_thread_id is distinct from p_provider_thread_id
     )
  then
    return jsonb_build_object('result', 'invalid_input');
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

  if exists (
    select 1
      from private.gmail_send_attempts a
     where a.user_id = p_user_id
       and a.recipient = p_recipient
       and a.hotel_id is not distinct from p_hotel_id
       and a.status in ('unknown', 'provider_called')
       and a.idempotency_key is distinct from p_idempotency_key
  ) then
    return jsonb_build_object(
      'result', 'unknown',
      'call_provider', false,
      'failure_code', 'unknown',
      'attempt_id', (
        select a.id
          from private.gmail_send_attempts a
         where a.user_id = p_user_id
           and a.recipient = p_recipient
           and a.hotel_id is not distinct from p_hotel_id
           and a.status in ('unknown', 'provider_called')
         order by a.updated_at desc
         limit 1
      )
    );
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

  -- A provider_called row older than the lease, with no stored provider
  -- message id, did not finish. It becomes a definite failure so a follow-up
  -- can be cancelled. A stored message id stays in flight and is committed
  -- again below, without another provider call.
  update private.gmail_send_attempts
     set status = 'failed',
         failure_code = 'provider_error',
         updated_at = p_now
   where status = 'provider_called'
     and provider_message_id is null
     and coalesce(provider_started_at, updated_at) < p_now - interval '15 minutes';

  perform public.gmail_followup_settle(p_now, null);

  update private.gmail_send_attempts a
     set status = 'failed',
         failure_code = 'deletion_pending',
         updated_at = p_now
   where (
       a.status in ('queued', 'reserved')
       or (a.status = 'provider_called' and a.provider_message_id is null)
     )
     and public.account_gmail_blocked(a.user_id);


  for v_attempt in
    select a.*
      from private.gmail_send_attempts a
     where a.status in ('provider_called', 'unknown')
       and a.provider_message_id is not null
     order by a.updated_at, a.id
     limit v_limit
     for update skip locked
  loop
    v_claims := v_claims || jsonb_build_array(jsonb_build_object(
      'result', 'commit',
      'call_provider', false,
      'retry_commit', true,
      'attempt_id', v_attempt.id,
      'user_id', v_attempt.user_id,
      'mail_account_id', v_attempt.mail_account_id,
      'kind', v_attempt.kind,
      'provider_message_id', v_attempt.provider_message_id,
      'provider_thread_id', v_attempt.provider_thread_id,
      'recipient', v_attempt.recipient,
      'hotel_id', v_attempt.hotel_id
    ));
  end loop;

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

create or replace function public.gmail_followup_schedule(
  p_user_id uuid,
  p_event_id uuid,
  p_subject text,
  p_body text,
  p_delay_days integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event private.gmail_sent_events%rowtype;
  v_open private.gmail_followups%rowtype;
  v_slot private.gmail_followups%rowtype;
  v_subject text;
  v_stop text;
  v_next smallint;
  v_days integer;
  v_anchor timestamptz;
  v_earliest timestamptz;
  v_paid boolean;
begin
  v_subject := btrim(p_subject);
  if p_user_id is null
     or p_event_id is null
     or v_subject is null
     or char_length(v_subject) < 1
     or char_length(v_subject) > 200
     or position(E'\n' in v_subject) > 0
     or position(E'\r' in v_subject) > 0
     or p_body is null
     or char_length(btrim(p_body)) < 1
     or char_length(p_body) > 8000
     or (p_delay_days is not null and (p_delay_days < 1 or p_delay_days > 30))
  then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  perform 1 from public.users where id = p_user_id for update;

  select e.* into v_event
    from private.gmail_sent_events e
   where e.id = p_event_id
     and e.user_id = p_user_id
     and e.kind = 'pitch';
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  select exists (
    select 1 from public.access_entitlements en
     where en.user_id = p_user_id
       and en.access_type in ('pro', 'max')
       and en.status = 'active'
       and en.starts_at <= pg_catalog.now()
       and (en.expires_at is null or en.expires_at > pg_catalog.now())
  ) into v_paid;
  if not v_paid then
    return jsonb_build_object('result', 'plan_required');
  end if;

  if not private.gmail_followup_recipient_ok(v_event.hotel_id, v_event.recipient) then
    return jsonb_build_object('result', 'recipient_rejected', 'recipient', v_event.recipient);
  end if;

  v_stop := private.gmail_followup_thread_stop(
    p_user_id, v_event.mail_account_id, v_event.provider_thread_id, v_event.pipeline_item_id
  );
  if v_stop is not null then
    return jsonb_build_object('result', 'stopped', 'stop_reason', v_stop);
  end if;

  select f.stop_reason into v_stop
    from private.gmail_followups f
   where f.user_id = p_user_id
     and f.mail_account_id = v_event.mail_account_id
       and f.provider_thread_id = v_event.provider_thread_id
     and f.status = 'stopped'
     and f.stop_reason in ('hotel_replied', 'bounced', 'pipeline_closed')
   order by f.sequence desc
   limit 1;
  if v_stop is not null then
    return jsonb_build_object('result', 'stopped', 'stop_reason', v_stop);
  end if;

  select f.* into v_open
    from private.gmail_followups f
   where f.user_id = p_user_id
     and f.mail_account_id = v_event.mail_account_id
       and f.provider_thread_id = v_event.provider_thread_id
     and f.status in ('scheduled', 'queued')
   order by f.sequence
   limit 1
   for update;
  if found then
    v_days := coalesce(p_delay_days, case when v_open.sequence = 2 then 5 else 3 end);
    if v_open.subject = v_subject and v_open.body = p_body and v_open.delay_days = v_days then
      return jsonb_build_object(
        'result', 'already_scheduled',
        'followup_id', v_open.id,
        'sequence', v_open.sequence,
        'delay_days', v_open.delay_days,
        'earliest_send_at', v_open.earliest_send_at,
        'recipient', v_open.recipient,
        'status', v_open.status
      );
    end if;
    return jsonb_build_object('result', 'text_conflict', 'followup_id', v_open.id);
  end if;

  if exists (
    select 1 from private.gmail_followups f
     where f.user_id = p_user_id
       and f.mail_account_id = v_event.mail_account_id
       and f.provider_thread_id = v_event.provider_thread_id
       and f.sequence = 1
       and f.status = 'sent'
  ) then
    if exists (
      select 1 from private.gmail_followups f
       where f.user_id = p_user_id
         and f.mail_account_id = v_event.mail_account_id
       and f.provider_thread_id = v_event.provider_thread_id
         and f.sequence = 2
         and f.status = 'sent'
    ) then
      return jsonb_build_object('result', 'limit_reached');
    end if;
    v_next := 2;
    v_days := coalesce(p_delay_days, 5);
    select e.sent_at into v_anchor
      from private.gmail_followups f
      join private.gmail_sent_events e on e.attempt_id = f.send_attempt_id
     where f.user_id = p_user_id
       and f.mail_account_id = v_event.mail_account_id
       and f.provider_thread_id = v_event.provider_thread_id
       and f.sequence = 1
       and f.status = 'sent';
    if v_anchor is null then
      return jsonb_build_object('result', 'not_ready');
    end if;
  else
    v_next := 1;
    v_days := coalesce(p_delay_days, 3);
    v_anchor := v_event.sent_at;
  end if;

  v_earliest := public.gmail_followup_earliest(v_anchor, v_days);
  if v_earliest is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  if exists (
    select 1
      from private.gmail_send_attempts a
     where a.user_id = p_user_id
       and a.mail_account_id = v_event.mail_account_id
       and (
         a.provider_thread_hint = v_event.provider_thread_id
         or a.id in (
           select f.send_attempt_id
             from private.gmail_followups f
            where f.user_id = p_user_id
              and f.mail_account_id = v_event.mail_account_id
              and f.provider_thread_id = v_event.provider_thread_id
              and f.send_attempt_id is not null
         )
       )
       and a.status in ('unknown', 'provider_called')
  ) then
    return jsonb_build_object('result', 'in_progress');
  end if;

  select f.* into v_slot
    from private.gmail_followups f
   where f.user_id = p_user_id
     and f.mail_account_id = v_event.mail_account_id
       and f.provider_thread_id = v_event.provider_thread_id
     and f.sequence = v_next
     and f.status in ('cancelled', 'stopped')
   order by f.updated_at desc
   limit 1
   for update;

  if found and v_slot.status = 'stopped' and v_slot.stop_reason is distinct from 'recipient_rejected' then
    return jsonb_build_object('result', 'stopped', 'stop_reason', v_slot.stop_reason);
  end if;

  if found then
    update private.gmail_followups
       set mail_account_id = v_event.mail_account_id,
           source_event_id = v_event.id,
           recipient = v_event.recipient,
           subject = v_subject,
           body = p_body,
           delay_days = v_days,
           hotel_id = v_event.hotel_id,
           pipeline_item_id = v_event.pipeline_item_id,
           trip_id = v_event.trip_id,
           status = 'scheduled',
           stop_reason = null,
           earliest_send_at = v_earliest,
           send_attempt_id = null,
           approved_at = pg_catalog.now(),
           stopped_at = null,
           updated_at = pg_catalog.now()
     where id = v_slot.id
    returning * into v_slot;
  else
    insert into private.gmail_followups (
      user_id, mail_account_id, source_event_id, provider_thread_id, sequence, delay_days,
      recipient, subject, body, hotel_id, pipeline_item_id, trip_id,
      status, earliest_send_at, approved_at
    ) values (
      p_user_id, v_event.mail_account_id, v_event.id, v_event.provider_thread_id, v_next, v_days,
      v_event.recipient, v_subject, p_body, v_event.hotel_id, v_event.pipeline_item_id,
      v_event.trip_id, 'scheduled', v_earliest, pg_catalog.now()
    )
    returning * into v_slot;
  end if;

  return jsonb_build_object(
    'result', 'scheduled',
    'followup_id', v_slot.id,
    'sequence', v_slot.sequence,
    'delay_days', v_slot.delay_days,
    'earliest_send_at', v_slot.earliest_send_at,
    'recipient', v_slot.recipient,
    'subject', v_slot.subject,
    'status', v_slot.status
  );
end;
$$;


create or replace function public.gmail_followup_cancel(p_user_id uuid, p_followup_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row private.gmail_followups%rowtype;
  v_attempt_status text;
begin
  if p_user_id is null or p_followup_id is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  perform 1 from public.users where id = p_user_id for update;

  select f.* into v_row
    from private.gmail_followups f
   where f.id = p_followup_id
     and f.user_id = p_user_id
   for update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_row.status = 'cancelled' then
    return jsonb_build_object('result', 'cancelled', 'followup_id', v_row.id, 'stop_reason', 'cancelled');
  end if;
  if v_row.status = 'sent' then
    return jsonb_build_object('result', 'sent', 'followup_id', v_row.id);
  end if;
  if v_row.status = 'stopped' then
    return jsonb_build_object(
      'result', 'stopped', 'followup_id', v_row.id, 'stop_reason', v_row.stop_reason
    );
  end if;

  if v_row.send_attempt_id is not null then
    select a.status into v_attempt_status
      from private.gmail_send_attempts a
     where a.id = v_row.send_attempt_id
       and a.user_id = p_user_id
     for update;
    -- unknown is in flight the same way provider_called is. Clearing the
    -- attempt and scheduling again would send a second message.
    if v_attempt_status in ('provider_called', 'unknown') then
      return jsonb_build_object('result', 'in_progress', 'followup_id', v_row.id);
    end if;
    if v_attempt_status = 'sent' then
      return jsonb_build_object('result', 'sent', 'followup_id', v_row.id);
    end if;
    if v_attempt_status in ('queued', 'reserved') then
      update private.gmail_send_attempts
         set status = 'failed',
             failure_code = 'followup_stopped',
             updated_at = pg_catalog.now()
       where id = v_row.send_attempt_id
         and user_id = p_user_id
         and status in ('queued', 'reserved');
    end if;
  end if;

  update private.gmail_followups
     set status = 'cancelled',
         stop_reason = 'cancelled',
         stopped_at = pg_catalog.now(),
         send_attempt_id = null,
         updated_at = pg_catalog.now()
   where id = v_row.id;

  return jsonb_build_object(
    'result', 'cancelled', 'followup_id', v_row.id, 'stop_reason', 'cancelled'
  );
end;
$$;

create or replace function public.gmail_followup_block_send(p_user_id uuid, p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempt private.gmail_send_attempts%rowtype;
  v_row private.gmail_followups%rowtype;
  v_stop text;
begin
  if p_user_id is null or p_attempt_id is null then
    return jsonb_build_object('result', 'send');
  end if;

  perform 1 from public.users where id = p_user_id for update;

  select a.* into v_attempt
    from private.gmail_send_attempts a
   where a.id = p_attempt_id
     and a.user_id = p_user_id
   for update;
  if not found or v_attempt.kind is distinct from 'follow_up' then
    return jsonb_build_object('result', 'send');
  end if;
  if v_attempt.provider_message_id is not null
     and v_attempt.status in ('provider_called', 'unknown') then
    return jsonb_build_object(
      'result', 'commit',
      'attempt_id', v_attempt.id,
      'provider_message_id', v_attempt.provider_message_id,
      'provider_thread_id', v_attempt.provider_thread_id
    );
  end if;
  if v_attempt.status = 'unknown' then
    return jsonb_build_object('result', 'in_progress', 'attempt_id', v_attempt.id);
  end if;
  if v_attempt.status in ('sent', 'failed') then
    return jsonb_build_object('result', 'send');
  end if;

  select f.* into v_row
    from private.gmail_followups f
   where f.send_attempt_id = v_attempt.id
     and f.user_id = p_user_id
   for update;

  if not found or v_row.status in ('cancelled', 'stopped') then
    v_stop := coalesce(v_row.stop_reason, 'cancelled');
  else
    v_stop := private.gmail_followup_thread_stop(
      v_row.user_id, v_row.mail_account_id, v_row.provider_thread_id, v_row.pipeline_item_id
    );
    if v_stop is null and not private.gmail_followup_recipient_ok(v_row.hotel_id, v_row.recipient) then
      v_stop := 'recipient_rejected';
    end if;
  end if;

  if v_stop is null then
    return jsonb_build_object('result', 'send');
  end if;

  if v_row.id is not null and v_row.status in ('scheduled', 'queued') then
    update private.gmail_followups
       set status = 'stopped',
           stop_reason = v_stop,
           stopped_at = pg_catalog.now(),
           updated_at = pg_catalog.now()
     where id = v_row.id;
  end if;

  update private.gmail_send_attempts
     set status = 'failed',
         failure_code = 'followup_stopped',
         updated_at = pg_catalog.now()
   where id = v_attempt.id
     and user_id = p_user_id
     and provider_message_id is null
     and status in ('queued', 'reserved', 'provider_called');

  return jsonb_build_object('result', 'stopped', 'stop_reason', v_stop, 'attempt_id', v_attempt.id);
end;
$$;

create function public.gmail_send_remember_provider(
  p_user_id uuid,
  p_attempt_id uuid,
  p_provider_message_id text,
  p_provider_thread_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row private.gmail_send_attempts%rowtype;
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
    return jsonb_build_object('result', 'ok', 'attempt_id', v_row.id);
  end if;
  if v_row.status not in ('provider_called', 'unknown') then
    return jsonb_build_object('result', 'not_ready', 'status', v_row.status);
  end if;
  if v_row.provider_message_id is not null
     and (
       v_row.provider_message_id is distinct from p_provider_message_id
       or v_row.provider_thread_id is distinct from p_provider_thread_id
     )
  then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  update private.gmail_send_attempts
     set provider_message_id = p_provider_message_id,
         provider_thread_id = p_provider_thread_id,
         updated_at = pg_catalog.now()
   where id = v_row.id;

  return jsonb_build_object(
    'result', 'ok',
    'attempt_id', v_row.id,
    'provider_message_id', p_provider_message_id,
    'provider_thread_id', p_provider_thread_id
  );
end;
$$;

comment on function public.gmail_send_remember_provider(uuid, uuid, text, text) is
  'Stores the provider message id before the sent-event commit. A later failure retries that commit and does not call Gmail again. service_role only.';

revoke all on function public.gmail_send_remember_provider(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.gmail_send_remember_provider(uuid, uuid, text, text)
  to service_role;

create function public.gmail_send_arm_provider(p_user_id uuid, p_attempt_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row private.gmail_send_attempts%rowtype;
  v_block jsonb;
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

  if v_row.provider_message_id is not null
     and v_row.status in ('provider_called', 'unknown', 'sent') then
    return jsonb_build_object(
      'result', 'commit',
      'call_provider', false,
      'retry_commit', true,
      'attempt_id', v_row.id,
      'provider_message_id', v_row.provider_message_id,
      'provider_thread_id', v_row.provider_thread_id
    );
  end if;

  if v_row.status = 'sent' then
    return jsonb_build_object('result', 'sent', 'call_provider', false, 'attempt_id', v_row.id);
  end if;
  if v_row.status = 'unknown' then
    return jsonb_build_object(
      'result', 'unknown',
      'call_provider', false,
      'attempt_id', v_row.id,
      'failure_code', 'unknown'
    );
  end if;
  if v_row.status = 'failed' then
    return jsonb_build_object(
      'result', 'failed',
      'call_provider', false,
      'attempt_id', v_row.id,
      'failure_code', v_row.failure_code
    );
  end if;
  if v_row.status not in ('reserved', 'provider_called') then
    return jsonb_build_object(
      'result', 'deferred',
      'call_provider', false,
      'attempt_id', v_row.id
    );
  end if;

  if public.account_gmail_blocked(p_user_id) then
    update private.gmail_send_attempts
       set status = 'failed',
           failure_code = 'deletion_pending',
           updated_at = pg_catalog.now()
     where id = v_row.id
       and provider_message_id is null
       and status in ('queued', 'reserved', 'provider_called');
    return jsonb_build_object(
      'result', 'failed',
      'call_provider', false,
      'attempt_id', v_row.id,
      'failure_code', 'deletion_pending'
    );
  end if;

  v_block := public.gmail_followup_block_send(p_user_id, p_attempt_id);
  if v_block ->> 'result' = 'stopped' then
    return jsonb_build_object(
      'result', 'failed',
      'call_provider', false,
      'attempt_id', v_row.id,
      'failure_code', 'followup_stopped'
    );
  end if;
  if v_block ->> 'result' = 'commit' then
    return jsonb_build_object(
      'result', 'commit',
      'call_provider', false,
      'retry_commit', true,
      'attempt_id', v_row.id,
      'provider_message_id', v_block ->> 'provider_message_id',
      'provider_thread_id', v_block ->> 'provider_thread_id'
    );
  end if;
  if v_block ->> 'result' = 'in_progress' then
    return jsonb_build_object(
      'result', 'unknown',
      'call_provider', false,
      'attempt_id', v_row.id,
      'failure_code', 'unknown'
    );
  end if;

  select a.* into v_row
    from private.gmail_send_attempts a
   where a.id = p_attempt_id
     and a.user_id = p_user_id;
  if v_row.status = 'failed' then
    return jsonb_build_object(
      'result', 'failed',
      'call_provider', false,
      'attempt_id', v_row.id,
      'failure_code', v_row.failure_code
    );
  end if;

  return jsonb_build_object(
    'result', 'ok',
    'call_provider', true,
    'attempt_id', v_row.id
  );
end;
$$;

comment on function public.gmail_send_arm_provider(uuid, uuid) is
  'Last locked write before the provider call. Rechecks deletion and the follow-up stop. Fails provider_called when deletion is pending and no provider message id is stored. service_role only.';

revoke all on function public.gmail_send_arm_provider(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.gmail_send_arm_provider(uuid, uuid) to service_role;

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
