-- 0099 — Keep a pitch on the opportunity it was saved for.
--
-- 0098 is not edited. A draft whose pipeline_item_id is already set cannot
-- move, including a move to null. gmail_send_reserve no longer picks an
-- arbitrary open row when the caller omits the id and more than one is open.

create or replace function public.pitch_owner_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if auth.uid() is not null then
    v_owner := public.current_creator_id();
    if v_owner is null then
      raise exception 'pitch rows require a creator profile'
        using errcode = '42501';
    end if;
    if new.creator_id is not null and new.creator_id is distinct from v_owner then
      raise exception 'pitch owner cannot change'
        using errcode = '42501';
    end if;
    new.creator_id := v_owner;
  end if;

  if tg_table_name = 'pitch_drafts' then
    if tg_op = 'UPDATE'
       and old.pipeline_item_id is not null
       and new.pipeline_item_id is distinct from old.pipeline_item_id
    then
      raise exception 'pitch draft opportunity cannot change'
        using errcode = '23514';
    end if;

    if new.variables_used is null then
      new.variables_used := '[]'::jsonb;
    end if;
    if jsonb_typeof(new.variables_used) is distinct from 'array' then
      raise exception 'pitch variables must be an array'
        using errcode = '23514';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(new.variables_used) as elem
      where jsonb_typeof(elem) <> 'string'
         or (elem #>> '{}') <> all (array[
           'creator_name',
           'niche',
           'instagram_handle',
           'hotel_name',
           'destination_name',
           'trip_name',
           'trip_start',
           'trip_end',
           'portfolio_title',
           'portfolio_url',
           'contact_name',
           'intelligence_note',
           'past_collaboration'
         ])
    ) then
      raise exception 'pitch variable is not allowed'
        using errcode = '23514';
    end if;

    if new.trip_id is not null and not exists (
      select 1
      from public.trips t
      where t.id = new.trip_id
        and t.creator_id = new.creator_id
    ) then
      raise exception 'pitch draft trip must belong to the same creator'
        using errcode = '23514';
    end if;

    if new.template_id is not null and not exists (
      select 1
      from public.pitch_templates p
      where p.id = new.template_id
        and p.creator_id = new.creator_id
        and p.archived_at is null
    ) then
      raise exception 'pitch draft template must belong to the same creator'
        using errcode = '23514';
    end if;

    if new.pipeline_item_id is not null and not exists (
      select 1
      from public.pipeline_items as pipeline
      where pipeline.id = new.pipeline_item_id
        and pipeline.creator_id = new.creator_id
        and pipeline.hotel_id = new.hotel_id
    ) then
      raise exception 'pitch draft opportunity must belong to the same creator and hotel'
        using errcode = '23514';
    end if;
  end if;

  return new;
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
  v_open_count integer;
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
    select count(*)::integer into v_open_count
      from public.pipeline_items pi
     where pi.creator_id = v_creator
       and pi.hotel_id = p_hotel_id
       and pi.status <> 'closed';
    if v_open_count > 1 then
      return jsonb_build_object('result', 'invalid_input', 'call_provider', false);
    end if;
    if v_open_count = 1 then
      select pi.id, pi.trip_id into p_pipeline_item_id, v_item_trip
        from public.pipeline_items pi
       where pi.creator_id = v_creator
         and pi.hotel_id = p_hotel_id
         and pi.status <> 'closed';
    end if;
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

comment on function public.pitch_owner_guard() is
  'D110. Forces the session creator, rejects another creator''s trip, template, or opportunity, and rejects any change away from a draft opportunity, including clearing it.';

comment on function public.gmail_send_reserve(uuid, uuid, text, text, text, text, text, uuid, uuid, uuid, uuid, text) is
  'D157, D168, and D182. Service role only. Omitting the pipeline item is invalid when more than one open row exists for that hotel. A single open row may still be resolved.';
