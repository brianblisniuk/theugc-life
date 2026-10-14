-- ===========================================================================
-- 0092 — FOLLOW-UP SCHEDULE (D171–D177, Proposed)
-- ===========================================================================
-- A creator opts in per sent pitch thread. At most two follow-ups. The
-- text stored here is the text they submitted. The existing send queue
-- (D168, D169) is what calls Gmail. 0089, 0090, and 0091 are not edited.

alter table private.gmail_send_attempts
  drop constraint gmail_send_attempts_kind_check;

alter table private.gmail_send_attempts
  add constraint gmail_send_attempts_kind_check
  check (kind in ('pitch', 'reply', 'follow_up'));

alter table private.gmail_sent_events
  drop constraint gmail_sent_events_kind_check;

alter table private.gmail_sent_events
  add constraint gmail_sent_events_kind_check
  check (kind in ('pitch', 'reply', 'follow_up'));

alter table private.gmail_send_attempts
  drop constraint gmail_send_attempts_failure_check;

alter table private.gmail_send_attempts
  add constraint gmail_send_attempts_failure_check
  check (
    (status = 'failed' and failure_code in (
      'plan_required', 'scope_missing', 'not_connected', 'token_revoked',
      'quota', 'rate_limited', 'allowlist', 'kill_switch', 'provider_error',
      'invalid_recipient', 'mailbox_unusable', 'followup_stopped'
    ))
    or (status in ('reserved', 'provider_called', 'sent', 'unknown', 'queued') and failure_code is null)
  );

create table private.gmail_followups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  mail_account_id uuid not null,
  source_event_id uuid not null references private.gmail_sent_events (id) on delete cascade,
  provider_thread_id text not null,
  sequence smallint not null,
  recipient text not null,
  subject text not null,
  body text not null,
  hotel_id uuid,
  pipeline_item_id uuid,
  trip_id uuid,
  status text not null,
  stop_reason text,
  earliest_send_at timestamptz not null,
  send_attempt_id uuid,
  approved_at timestamptz not null default now(),
  stopped_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gmail_followups_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,
  constraint gmail_followups_attempt_fk
    foreign key (send_attempt_id)
    references private.gmail_send_attempts (id) on delete set null,
  constraint gmail_followups_hotel_fk
    foreign key (hotel_id) references public.hotels (id) on delete set null,
  constraint gmail_followups_pipeline_fk
    foreign key (pipeline_item_id) references public.pipeline_items (id) on delete set null,
  constraint gmail_followups_trip_fk
    foreign key (trip_id) references public.trips (id) on delete set null,
  constraint gmail_followups_sequence_check check (sequence in (1, 2)),
  constraint gmail_followups_thread_check check (
    char_length(btrim(provider_thread_id)) between 1 and 256
  ),
  constraint gmail_followups_status_check check (
    status in ('scheduled', 'queued', 'sent', 'stopped', 'cancelled')
  ),
  constraint gmail_followups_stop_check check (
    (
      status in ('stopped', 'cancelled')
      and stopped_at is not null
      and stop_reason in (
        'hotel_replied', 'bounced', 'pipeline_closed', 'cancelled', 'recipient_rejected'
      )
    )
    or (
      status in ('scheduled', 'queued', 'sent')
      and stop_reason is null
      and stopped_at is null
    )
  )
);

create unique index gmail_followups_sequence_uidx
  on private.gmail_followups (user_id, provider_thread_id, sequence)
  where status <> 'cancelled';

create index gmail_followups_open_idx
  on private.gmail_followups (user_id, earliest_send_at)
  where status in ('scheduled', 'queued');

comment on table private.gmail_followups is
  'D171–D177 Proposed. One opted-in follow-up on a pitch the creator already sent. Deleted with the user and with the source sent event.';

alter table private.gmail_followups enable row level security;

revoke all on private.gmail_followups from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Helpers. Not security definer. Callers are the definer functions below.
-- ---------------------------------------------------------------------------

create function private.gmail_followup_recipient_ok(p_hotel uuid, p_recipient text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select p_hotel is not null
     and p_recipient is not null
     and exists (
       select 1
         from public.hotel_contacts c
        where c.hotel_id = p_hotel
          and c.email is not null
          and c.status <> 'invalid'
          and position('@' in c.email) > 0
          and (
            lower(btrim(c.email)) = lower(p_recipient)
            or (
              lower(split_part(btrim(c.email), '@', 2)) = lower(split_part(p_recipient, '@', 2))
              and not public.gmail_send_consumer_domain(
                lower(split_part(btrim(c.email), '@', 2))
              )
            )
          )
          and char_length(split_part(p_recipient, '@', 2)) > 0
     );
$$;

revoke all on function private.gmail_followup_recipient_ok(uuid, text)
  from public, anon, authenticated, service_role;

create function private.gmail_followup_thread_stop(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_provider_thread_id text,
  p_pipeline_item_id uuid
)
returns text
language sql
stable
set search_path = ''
as $$
  select case
    when exists (
      select 1
        from private.gmail_reply_message_observations o
        join private.gmail_normalized_threads t
          on t.id = o.normalized_thread_id
         and t.mail_account_id = o.mail_account_id
       where o.user_id = p_user_id
         and o.mail_account_id = p_mail_account_id
         and t.provider_thread_id = p_provider_thread_id
         and o.response_class in ('qualifying_human_reply', 'ambiguous_inbound')
    ) then 'hotel_replied'
    when exists (
      select 1
        from private.gmail_send_bounces b
        join private.gmail_sent_events e on e.attempt_id = b.attempt_id
       where e.user_id = p_user_id
         and e.mail_account_id = p_mail_account_id
         and e.provider_thread_id = p_provider_thread_id
    ) then 'bounced'
    when p_pipeline_item_id is not null and exists (
      select 1
        from public.pipeline_items pi
        join public.creator_profiles cp on cp.id = pi.creator_id
       where pi.id = p_pipeline_item_id
         and cp.user_id = p_user_id
         and pi.status in ('won', 'closed')
    ) then 'pipeline_closed'
    else null
  end;
$$;

revoke all on function private.gmail_followup_thread_stop(uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;

create function private.gmail_followup_hold(p_user_id uuid, p_mail_account_id uuid)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_account public.mail_accounts%rowtype;
begin
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

revoke all on function private.gmail_followup_hold(uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.gmail_followup_earliest(
  p_from timestamptz,
  p_zone text,
  p_days integer
)
returns timestamptz
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_zone text;
  v_date date;
  v_left integer;
  v_guard integer := 0;
begin
  if p_from is null or p_days is null or p_days < 1 or p_days > 10 then
    return null;
  end if;
  v_zone := public.ai_zone_name(p_zone);
  v_date := (p_from at time zone v_zone)::date;
  v_left := p_days;
  while v_left > 0 loop
    v_guard := v_guard + 1;
    if v_guard > 40 then
      return null;
    end if;
    v_date := v_date + 1;
    if extract(isodow from v_date) < 6 then
      v_left := v_left - 1;
    end if;
  end loop;
  return (v_date + time '09:00') at time zone v_zone;
end;
$$;

comment on function public.gmail_followup_earliest(timestamptz, text, integer) is
  'D172 Proposed. Weekdays after p_from, at 09:00 in the creator zone. Saturday and Sunday are not business days. Blank zones are UTC.';

revoke all on function public.gmail_followup_earliest(timestamptz, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.gmail_followup_earliest(timestamptz, text, integer)
  to service_role;

create or replace function public.gmail_send_fail(
  p_user_id uuid,
  p_attempt_id uuid,
  p_code text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
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
    'invalid_recipient', 'mailbox_unusable', 'followup_stopped'
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

-- ---------------------------------------------------------------------------
-- Schedule, cancel, settle, list, block
-- ---------------------------------------------------------------------------

create function public.gmail_followup_schedule(
  p_user_id uuid,
  p_event_id uuid,
  p_subject text,
  p_body text
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
  v_zone text;
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
     and f.provider_thread_id = v_event.provider_thread_id
     and f.status in ('scheduled', 'queued')
   order by f.sequence
   limit 1
   for update;
  if found then
    if v_open.subject = v_subject and v_open.body = p_body then
      return jsonb_build_object(
        'result', 'already_scheduled',
        'followup_id', v_open.id,
        'sequence', v_open.sequence,
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
       and f.provider_thread_id = v_event.provider_thread_id
       and f.sequence = 1
       and f.status = 'sent'
  ) then
    if exists (
      select 1 from private.gmail_followups f
       where f.user_id = p_user_id
         and f.provider_thread_id = v_event.provider_thread_id
         and f.sequence = 2
         and f.status = 'sent'
    ) then
      return jsonb_build_object('result', 'limit_reached');
    end if;
    v_next := 2;
    v_days := 4;
    select e.sent_at into v_anchor
      from private.gmail_followups f
      join private.gmail_sent_events e on e.attempt_id = f.send_attempt_id
     where f.user_id = p_user_id
       and f.provider_thread_id = v_event.provider_thread_id
       and f.sequence = 1
       and f.status = 'sent';
    if v_anchor is null then
      return jsonb_build_object('result', 'not_ready');
    end if;
  else
    v_next := 1;
    v_days := 3;
    v_anchor := v_event.sent_at;
  end if;

  select public.ai_zone_name(u.timezone) into v_zone
    from public.users u where u.id = p_user_id;
  v_earliest := public.gmail_followup_earliest(v_anchor, v_zone, v_days);
  if v_earliest is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select f.* into v_slot
    from private.gmail_followups f
   where f.user_id = p_user_id
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
       set source_event_id = v_event.id,
           recipient = v_event.recipient,
           subject = v_subject,
           body = p_body,
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
      user_id, mail_account_id, source_event_id, provider_thread_id, sequence,
      recipient, subject, body, hotel_id, pipeline_item_id, trip_id,
      status, earliest_send_at, approved_at
    ) values (
      p_user_id, v_event.mail_account_id, v_event.id, v_event.provider_thread_id, v_next,
      v_event.recipient, v_subject, p_body, v_event.hotel_id, v_event.pipeline_item_id,
      v_event.trip_id, 'scheduled', v_earliest, pg_catalog.now()
    )
    returning * into v_slot;
  end if;

  return jsonb_build_object(
    'result', 'scheduled',
    'followup_id', v_slot.id,
    'sequence', v_slot.sequence,
    'earliest_send_at', v_slot.earliest_send_at,
    'recipient', v_slot.recipient,
    'subject', v_slot.subject,
    'status', v_slot.status
  );
end;
$$;

comment on function public.gmail_followup_schedule(uuid, uuid, text, text) is
  'D171–D174 Proposed. Service role only. Stores the submitted text on the creator''s own pitch thread. The recipient is copied from that send. No Gmail call.';

revoke all on function public.gmail_followup_schedule(uuid, uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.gmail_followup_schedule(uuid, uuid, text, text)
  to service_role;

create function public.gmail_followup_cancel(p_user_id uuid, p_followup_id uuid)
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
    if v_attempt_status = 'provider_called' then
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

comment on function public.gmail_followup_cancel(uuid, uuid) is
  'D173 Proposed. Service role only. Cancels a follow-up that has not reached the provider. A queued attempt is not claimed.';

revoke all on function public.gmail_followup_cancel(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.gmail_followup_cancel(uuid, uuid) to service_role;

create function public.gmail_followup_settle(p_now timestamptz, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_row private.gmail_followups%rowtype;
  v_stop text;
  v_hold text;
  v_attempt_id uuid;
  v_key text;
  v_hash text;
  v_stopped integer := 0;
  v_enqueued integer := 0;
begin
  if p_now is null then
    return jsonb_build_object('result', 'invalid_input', 'stopped', 0, 'enqueued', 0);
  end if;

  for v_user in
    select f.user_id
      from private.gmail_followups f
     where f.status in ('scheduled', 'queued')
       and (p_user_id is null or f.user_id = p_user_id)
     group by f.user_id
     order by f.user_id
  loop
    perform 1 from public.users u where u.id = v_user for update;

    for v_row in
      select f.*
        from private.gmail_followups f
       where f.user_id = v_user
         and f.status in ('scheduled', 'queued')
       order by f.sequence, f.id
       for update
    loop
      v_stop := private.gmail_followup_thread_stop(
        v_row.user_id, v_row.mail_account_id, v_row.provider_thread_id, v_row.pipeline_item_id
      );
      if v_stop is null
         and not private.gmail_followup_recipient_ok(v_row.hotel_id, v_row.recipient)
         and (v_row.status = 'queued' or v_row.earliest_send_at <= p_now)
      then
        v_stop := 'recipient_rejected';
      end if;

      if v_stop is not null then
        update private.gmail_followups
           set status = 'stopped',
               stop_reason = v_stop,
               stopped_at = p_now,
               updated_at = p_now
         where id = v_row.id
           and status in ('scheduled', 'queued');
        if v_row.send_attempt_id is not null then
          update private.gmail_send_attempts
             set status = 'failed',
                 failure_code = 'followup_stopped',
                 updated_at = p_now
           where id = v_row.send_attempt_id
             and user_id = v_row.user_id
             and status in ('queued', 'reserved');
        end if;
        v_stopped := v_stopped + 1;
        continue;
      end if;

      if v_row.status = 'queued' or v_row.earliest_send_at > p_now then
        continue;
      end if;

      v_hold := private.gmail_followup_hold(v_row.user_id, v_row.mail_account_id);
      if v_hold is not null then
        continue;
      end if;
      if not private.gmail_followup_recipient_ok(v_row.hotel_id, v_row.recipient) then
        continue;
      end if;
      if v_row.send_attempt_id is not null then
        continue;
      end if;

      v_key := 'fu' || replace(gen_random_uuid()::text, '-', '');
      v_hash := public.gmail_send_payload_hash(
        'follow_up', v_row.recipient, v_row.subject, v_row.body,
        v_row.hotel_id, v_row.pipeline_item_id, v_row.trip_id, null, v_row.provider_thread_id
      );
      insert into private.gmail_send_attempts (
        user_id, mail_account_id, idempotency_key, payload_sha256, kind, status,
        hotel_id, pipeline_item_id, trip_id, recipient, subject, body,
        provider_thread_hint, dispatch_not_before
      ) values (
        v_row.user_id, v_row.mail_account_id, v_key, v_hash, 'follow_up', 'queued',
        v_row.hotel_id, v_row.pipeline_item_id, v_row.trip_id, v_row.recipient,
        v_row.subject, v_row.body, v_row.provider_thread_id, p_now
      )
      returning id into v_attempt_id;

      update private.gmail_followups
         set status = 'queued',
             send_attempt_id = v_attempt_id,
             updated_at = p_now
       where id = v_row.id
         and status = 'scheduled';
      v_enqueued := v_enqueued + 1;
    end loop;
  end loop;

  return jsonb_build_object('result', 'ok', 'stopped', v_stopped, 'enqueued', v_enqueued);
end;
$$;

comment on function public.gmail_followup_settle(timestamptz, uuid) is
  'D172–D173 Proposed. Service role only. Stops follow-ups that must not send, and enqueues a due follow-up into the Gmail send queue. Does not call Gmail. A null user settles every open row.';

revoke all on function public.gmail_followup_settle(timestamptz, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.gmail_followup_settle(timestamptz, uuid) to service_role;

create function public.gmail_followup_block_send(p_user_id uuid, p_attempt_id uuid)
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
  if v_attempt.status in ('sent', 'unknown', 'failed') then
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
     and status in ('queued', 'reserved', 'provider_called');

  return jsonb_build_object('result', 'stopped', 'stop_reason', v_stop, 'attempt_id', v_attempt.id);
end;
$$;

comment on function public.gmail_followup_block_send(uuid, uuid) is
  'D173 Proposed. Service role only. Called immediately before a follow-up provider call. A pitch or a reply is left alone. Does not call Gmail.';

revoke all on function public.gmail_followup_block_send(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.gmail_followup_block_send(uuid, uuid) to service_role;

create function public.gmail_followup_list_for_hotel(p_user_id uuid, p_hotel_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_event private.gmail_sent_events%rowtype;
  v_followup private.gmail_followups%rowtype;
  v_threads jsonb := '[]'::jsonb;
  v_items jsonb;
  v_next jsonb;
  v_stop text;
  v_hold text;
  v_sent integer;
  v_anchor timestamptz;
  v_zone text;
  v_earliest timestamptz;
  v_pipeline text;
  v_open_status text;
  v_open_id uuid;
  v_open_sequence smallint;
  v_open_subject text;
  v_open_body text;
  v_open_earliest timestamptz;
begin
  if p_user_id is null or p_hotel_id is null then
    return jsonb_build_object('result', 'invalid_input', 'threads', '[]'::jsonb);
  end if;
  if not exists (select 1 from public.users u where u.id = p_user_id) then
    return jsonb_build_object('result', 'not_found', 'threads', '[]'::jsonb);
  end if;

  perform public.gmail_followup_settle(pg_catalog.now(), p_user_id);

  select public.ai_zone_name(u.timezone) into v_zone
    from public.users u where u.id = p_user_id;

  for v_event in
    select e.*
      from private.gmail_sent_events e
     where e.user_id = p_user_id
       and e.hotel_id = p_hotel_id
       and e.kind = 'pitch'
     order by e.sent_at, e.id
  loop
    v_items := '[]'::jsonb;
    v_sent := 0;
    v_open_status := null;
    v_open_id := null;
    v_open_sequence := null;
    v_open_subject := null;
    v_open_body := null;
    v_open_earliest := null;
    v_pipeline := null;

    if v_event.pipeline_item_id is not null then
      select pi.status into v_pipeline
        from public.pipeline_items pi
        join public.creator_profiles cp on cp.id = pi.creator_id
       where pi.id = v_event.pipeline_item_id
         and cp.user_id = p_user_id;
    end if;

    for v_followup in
      select f.*
        from private.gmail_followups f
       where f.user_id = p_user_id
         and f.provider_thread_id = v_event.provider_thread_id
         and f.status <> 'cancelled'
       order by f.sequence, f.created_at
    loop
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'id', v_followup.id,
        'sequence', v_followup.sequence,
        'status', v_followup.status,
        'stop_reason', v_followup.stop_reason,
        'subject', v_followup.subject,
        'body', v_followup.body,
        'recipient', v_followup.recipient,
        'earliest_send_at', v_followup.earliest_send_at,
        'stopped_at', v_followup.stopped_at
      ));
      if v_followup.status = 'sent' then
        v_sent := v_sent + 1;
      elsif v_followup.status in ('scheduled', 'queued') and v_open_id is null then
        v_open_status := v_followup.status;
        v_open_id := v_followup.id;
        v_open_sequence := v_followup.sequence;
        v_open_subject := v_followup.subject;
        v_open_body := v_followup.body;
        v_open_earliest := v_followup.earliest_send_at;
      end if;
    end loop;

    v_stop := private.gmail_followup_thread_stop(
      p_user_id, v_event.mail_account_id, v_event.provider_thread_id, v_event.pipeline_item_id
    );
    if v_stop is null then
      select f.stop_reason into v_stop
        from private.gmail_followups f
       where f.user_id = p_user_id
         and f.provider_thread_id = v_event.provider_thread_id
         and f.status = 'stopped'
         and f.stop_reason in ('hotel_replied', 'bounced', 'pipeline_closed', 'recipient_rejected')
       order by f.sequence desc
       limit 1;
    end if;

    if v_stop is not null then
      v_next := jsonb_build_object(
        'state', 'stopped',
        'sequence', v_open_sequence,
        'followup_id', v_open_id,
        'recipient', v_event.recipient,
        'subject', v_open_subject,
        'body', v_open_body,
        'earliest_send_at', v_open_earliest,
        'stop_reason', v_stop,
        'hold', null
      );
    elsif v_open_id is not null then
      v_hold := null;
      if not private.gmail_followup_recipient_ok(v_event.hotel_id, v_event.recipient) then
        v_hold := 'recipient_rejected';
      else
        v_hold := private.gmail_followup_hold(p_user_id, v_event.mail_account_id);
      end if;
      v_next := jsonb_build_object(
        'state', case when v_hold is null then v_open_status else 'held' end,
        'sequence', v_open_sequence,
        'followup_id', v_open_id,
        'recipient', v_event.recipient,
        'subject', v_open_subject,
        'body', v_open_body,
        'earliest_send_at', v_open_earliest,
        'stop_reason', null,
        'hold', v_hold
      );
    elsif v_sent >= 2 then
      v_next := jsonb_build_object(
        'state', 'complete',
        'sequence', null,
        'followup_id', null,
        'recipient', v_event.recipient,
        'subject', null,
        'body', null,
        'earliest_send_at', null,
        'stop_reason', null,
        'hold', null
      );
    else
      if v_sent = 1 then
        select e.sent_at into v_anchor
          from private.gmail_followups f
          join private.gmail_sent_events e on e.attempt_id = f.send_attempt_id
         where f.user_id = p_user_id
           and f.provider_thread_id = v_event.provider_thread_id
           and f.sequence = 1
           and f.status = 'sent';
        v_earliest := public.gmail_followup_earliest(v_anchor, v_zone, 4);
      else
        v_earliest := public.gmail_followup_earliest(v_event.sent_at, v_zone, 3);
      end if;
      v_next := jsonb_build_object(
        'state', 'needs_opt_in',
        'sequence', v_sent + 1,
        'followup_id', null,
        'recipient', v_event.recipient,
        'subject', null,
        'body', null,
        'earliest_send_at', v_earliest,
        'stop_reason', null,
        'hold', null
      );
    end if;

    v_threads := v_threads || jsonb_build_array(jsonb_build_object(
      'event_id', v_event.id,
      'provider_thread_id', v_event.provider_thread_id,
      'recipient', v_event.recipient,
      'original_subject', v_event.subject,
      'sent_at', v_event.sent_at,
      'pipeline_status', v_pipeline,
      'followups', v_items,
      'next', v_next
    ));
  end loop;

  return jsonb_build_object('result', 'ok', 'timezone', v_zone, 'threads', v_threads);
end;
$$;

comment on function public.gmail_followup_list_for_hotel(uuid, uuid) is
  'D176 Proposed. Service role only. One creator, one hotel. Applies stops, then returns what will send, when, or why it stopped. No other creator''s rows.';

revoke all on function public.gmail_followup_list_for_hotel(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.gmail_followup_list_for_hotel(uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- A sent follow-up attempt closes the schedule row. Claim settles first.
-- ---------------------------------------------------------------------------

create function private.gmail_followup_on_attempt_sent()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'follow_up'
     and new.status = 'sent'
     and old.status is distinct from 'sent'
  then
    update private.gmail_followups
       set status = 'sent',
           stop_reason = null,
           stopped_at = null,
           updated_at = pg_catalog.now()
     where send_attempt_id = new.id
       and user_id = new.user_id
       and status = 'queued';
  end if;
  return new;
end;
$$;

revoke all on function private.gmail_followup_on_attempt_sent()
  from public, anon, authenticated, service_role;

create trigger gmail_followup_attempt_sent
  after update of status on private.gmail_send_attempts
  for each row
  execute function private.gmail_followup_on_attempt_sent();

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

comment on function public.gmail_send_claim_due(timestamptz, integer, integer, integer, integer) is
  'D168. Service role only. Settles due follow-ups first (D172, D173), then claims at most one queued send per creator inside local 09:00–18:00. A reserved attempt older than 15 minutes becomes unknown and is not claimed again. Does not call Gmail.';
