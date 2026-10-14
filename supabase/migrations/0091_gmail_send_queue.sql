-- ===========================================================================
-- 0091 — GMAIL SEND QUEUE, SOFT CAPS, BOUNCE PAUSE (D168–D170)
-- ===========================================================================
-- A Send click enqueues. A dispatcher claims one row per creator inside
-- local business hours, 3 to 5 minutes after the previous claim.
-- 0089 is not edited. D160's allowlist and kill switch stay in the server.

alter table private.gmail_send_attempts
  add column dispatch_not_before timestamptz;

alter table private.gmail_send_attempts
  drop constraint gmail_send_attempts_status_check;

alter table private.gmail_send_attempts
  add constraint gmail_send_attempts_status_check
  check (status in ('reserved', 'provider_called', 'sent', 'failed', 'unknown', 'queued'));

alter table private.gmail_send_attempts
  drop constraint gmail_send_attempts_failure_check;

alter table private.gmail_send_attempts
  add constraint gmail_send_attempts_failure_check
  check (
    (status = 'failed' and failure_code in (
      'plan_required', 'scope_missing', 'not_connected', 'token_revoked',
      'quota', 'rate_limited', 'allowlist', 'kill_switch', 'provider_error',
      'invalid_recipient', 'mailbox_unusable'
    ))
    or (status in ('reserved', 'provider_called', 'sent', 'unknown', 'queued') and failure_code is null)
  );

create index gmail_send_attempts_queued_idx
  on private.gmail_send_attempts (user_id, dispatch_not_before)
  where status = 'queued';

create table private.gmail_send_schedule (
  user_id uuid primary key references public.users (id) on delete cascade,
  next_eligible_at timestamptz not null
);

comment on table private.gmail_send_schedule is
  'D168. The next time this creator may have one queued send claimed. Deleted with the user.';

create table private.gmail_send_pauses (
  user_id uuid primary key references public.users (id) on delete cascade,
  reason text not null check (reason = 'bounce_rate'),
  paused_at timestamptz not null default now(),
  unpaused_at timestamptz,
  unpaused_by uuid
);

comment on table private.gmail_send_pauses is
  'D169. Sends stay queued until an admin clears this pause. AI is not paused. Deleted with the user.';

create table private.gmail_send_bounces (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null unique references private.gmail_send_attempts (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  recorded_at timestamptz not null default now()
);

comment on table private.gmail_send_bounces is
  'D169. One bounce for a sent attempt. Deleted with the attempt and with the user.';

alter table private.gmail_send_schedule enable row level security;
alter table private.gmail_send_pauses enable row level security;
alter table private.gmail_send_bounces enable row level security;

revoke all on private.gmail_send_schedule from public, anon, authenticated, service_role;
revoke all on private.gmail_send_pauses from public, anon, authenticated, service_role;
revoke all on private.gmail_send_bounces from public, anon, authenticated, service_role;

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
         or lower(split_part(btrim(c.email), '@', 2)) = lower(split_part(p_recipient, '@', 2))
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


comment on function public.gmail_send_reserve(uuid, uuid, text, text, text, text, text, uuid, uuid, uuid, uuid, text) is
  'D157 and D168. Service role only. A new pitch is queued. The same key does not call Gmail. A hotel recipient must match a contact or that contact''s domain.';

drop function if exists public.gmail_send_mark_provider(uuid, uuid, integer);

create function public.gmail_send_mark_provider(
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

comment on function public.gmail_send_mark_provider(uuid, uuid, integer, integer) is
  'D168. Service role only. Marks provider_called or defers a queued send. A soft cap does not fail the attempt. Sends no mail by itself.';

revoke all on function public.gmail_send_mark_provider(uuid, uuid, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.gmail_send_mark_provider(uuid, uuid, integer, integer)
  to service_role;

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
  'D168. Service role only. Claims at most one queued send per creator inside local 09:00–18:00. Does not call Gmail.';

revoke all on function public.gmail_send_claim_due(timestamptz, integer, integer, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.gmail_send_claim_due(timestamptz, integer, integer, integer, integer)
  to service_role;

create or replace function public.gmail_send_record_bounce(
  p_user_id uuid,
  p_attempt_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer;
  v_bounced integer;
begin
  if p_user_id is null or p_attempt_id is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if not exists (
    select 1 from private.gmail_send_attempts a
     where a.id = p_attempt_id
       and a.user_id = p_user_id
       and a.status = 'sent'
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  insert into private.gmail_send_bounces (attempt_id, user_id)
  values (p_attempt_id, p_user_id)
  on conflict (attempt_id) do nothing;

  with recent as (
    select a.id
      from private.gmail_send_attempts a
     where a.user_id = p_user_id
       and a.status = 'sent'
       and a.provider_started_at >= pg_catalog.now() - interval '30 days'
     order by a.provider_started_at desc
     limit 20
  )
  select count(*)::integer,
         count(*) filter (
           where exists (
             select 1 from private.gmail_send_bounces b where b.attempt_id = recent.id
           )
         )::integer
    into v_total, v_bounced
    from recent;

  if v_total >= 20 and v_bounced * 100 > v_total * 5 then
    insert into private.gmail_send_pauses (user_id, reason)
    values (p_user_id, 'bounce_rate')
    on conflict (user_id) do update
      set reason = 'bounce_rate',
          paused_at = pg_catalog.now(),
          unpaused_at = null,
          unpaused_by = null
    where private.gmail_send_pauses.unpaused_at is not null;
    return jsonb_build_object('result', 'paused', 'bounces', v_bounced, 'window', v_total);
  end if;

  return jsonb_build_object('result', 'recorded', 'bounces', v_bounced, 'window', v_total);
end;
$$;

comment on function public.gmail_send_record_bounce(uuid, uuid) is
  'D169. Service role only. Records a bounce. More than 5 percent of the last 20 sends in 30 days pauses sends for that creator only.';

revoke all on function public.gmail_send_record_bounce(uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.gmail_send_record_bounce(uuid, uuid) to service_role;

create or replace function public.admin_unpause_sends(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null or not exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'admin'
  ) then
    return jsonb_build_object('result', 'forbidden');
  end if;
  update private.gmail_send_pauses
     set unpaused_at = pg_catalog.now(),
         unpaused_by = auth.uid()
   where user_id = p_user_id
     and unpaused_at is null;
  return jsonb_build_object('result', 'ok');
end;
$$;

comment on function public.admin_unpause_sends(uuid) is
  'D169. The signed-in admin clears a bounce pause. An editor or a creator is forbidden.';

revoke all on function public.admin_unpause_sends(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_unpause_sends(uuid)
  to authenticated, service_role;
