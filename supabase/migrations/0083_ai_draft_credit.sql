-- 0083 — D03 AI draft charge, budget, and selected mail (D141–D145).
--
-- The new credit reason was added in 0082 and is usable only after that
-- transaction commits.
--
-- A draft charge is an ordinary negative ledger row, so the existing spend
-- walk (plan, then weekly, then durable) applies. Free and a Destination
-- Pass cannot charge. The call does not send mail.

create or replace function public.charge_own_ai_draft(p_idempotency_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_cost integer;
  v_balance integer;
  v_ledger_id uuid;
  v_allowed boolean;
begin
  if v_uid is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_idempotency_key is null
     or char_length(btrim(p_idempotency_key)) < 1
     or char_length(p_idempotency_key) > 200 then
    raise exception 'idempotency key is required' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('theugc.ai_draft'),
    pg_catalog.hashtext(v_uid::text)
  );

  v_allowed := exists (
    select 1
      from public.access_entitlements e
     where e.user_id = v_uid
       and e.access_type in ('pro', 'max')
       and e.status = 'active'
       and e.starts_at <= pg_catalog.now()
       and (e.expires_at is null or e.expires_at > pg_catalog.now())
  );
  if not v_allowed then
    return jsonb_build_object('status', 'forbidden');
  end if;

  perform public.ensure_credit_grants(v_uid);

  select l.id
    into v_ledger_id
    from public.credit_ledger l
   where l.user_id = v_uid
     and l.idempotency_key = p_idempotency_key;

  v_balance := public.credit_balance(v_uid);

  if v_ledger_id is not null then
    return jsonb_build_object(
      'status', 'already_charged',
      'balance', v_balance,
      'ledger_id', v_ledger_id
    );
  end if;

  select ai_draft_cost
    into v_cost
    from public.credit_config
   where id;

  if v_cost is null or v_cost <= 0 then
    raise exception 'credit config missing' using errcode = '55000';
  end if;

  if v_balance < v_cost then
    return jsonb_build_object('status', 'out_of_credits', 'balance', v_balance);
  end if;

  insert into public.credit_ledger (user_id, delta, reason, idempotency_key)
  values (v_uid, -v_cost, 'ai_draft', p_idempotency_key)
  returning id into v_ledger_id;

  return jsonb_build_object(
    'status', 'charged',
    'balance', public.credit_balance(v_uid),
    'ledger_id', v_ledger_id
  );
end;
$$;

comment on function public.charge_own_ai_draft(text) is
  'D143. Debits credit_config.ai_draft_cost for auth.uid() after a successful assistant draft. Pro or Max only. Idempotent. Does not send mail.';

revoke all on function public.charge_own_ai_draft(text) from public, anon, authenticated, service_role;
grant execute on function public.charge_own_ai_draft(text) to authenticated, service_role;

-- Budget and daily caps are arguments because the dollar cap lives in server
-- env, not in a client-writable column. authenticated cannot call this.
-- A non-positive budget refuses. Caps above the ceiling are clamped down.
create or replace function public.prepare_ai_usage(
  p_user_id uuid,
  p_request_id uuid,
  p_model text,
  p_estimate_micros bigint,
  p_budget_micros bigint,
  p_daily_call_cap integer,
  p_daily_token_cap integer,
  p_estimate_input_tokens integer,
  p_estimate_output_tokens integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month timestamptz;
  v_day timestamptz;
  v_calls integer;
  v_tokens bigint;
  v_spent bigint;
  v_call_cap integer;
  v_token_cap integer;
begin
  if p_user_id is null or p_request_id is null or p_model is null then
    raise exception 'ai usage requires a user, request, and model' using errcode = '22023';
  end if;
  if p_model !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$' then
    raise exception 'ai model id is not allowed' using errcode = '22023';
  end if;
  if p_estimate_micros is null or p_estimate_micros <= 0 or p_estimate_micros > 1000000000 then
    raise exception 'ai estimate is not allowed' using errcode = '22023';
  end if;
  if p_budget_micros is null or p_budget_micros <= 0 then
    return jsonb_build_object('status', 'budget');
  end if;
  if p_daily_call_cap is null or p_daily_call_cap <= 0
     or p_daily_token_cap is null or p_daily_token_cap <= 0
     or p_estimate_input_tokens is null or p_estimate_input_tokens < 0
     or p_estimate_output_tokens is null or p_estimate_output_tokens < 0 then
    raise exception 'ai caps are required' using errcode = '22023';
  end if;

  if not exists (select 1 from public.users u where u.id = p_user_id) then
    raise exception 'ai user is missing' using errcode = '22023';
  end if;

  v_call_cap := least(p_daily_call_cap, 40);
  v_token_cap := least(p_daily_token_cap, 80000);

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext('theugc.ai_budget_month'), 1);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('theugc.ai_budget'),
    pg_catalog.hashtext(p_user_id::text)
  );

  if exists (
    select 1
      from public.ai_usage u
     where u.request_id = p_request_id
       and u.status = 'reserved'
  ) then
    return jsonb_build_object('status', 'already_reserved');
  end if;

  if exists (
    select 1
      from public.ai_usage u
     where u.user_id = p_user_id
       and u.created_at > pg_catalog.now() - interval '3 seconds'
  ) then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  v_day := (date_trunc('day', pg_catalog.now() at time zone 'utc') at time zone 'utc');
  v_month := (date_trunc('month', pg_catalog.now() at time zone 'utc') at time zone 'utc');

  select count(distinct u.request_id)::integer
    into v_calls
    from public.ai_usage u
   where u.user_id = p_user_id
     and u.created_at >= v_day;

  if v_calls >= v_call_cap then
    return jsonb_build_object('status', 'daily_calls');
  end if;

  select coalesce(sum(u.input_tokens + u.output_tokens), 0)
    into v_tokens
    from public.ai_usage u
   where u.user_id = p_user_id
     and u.created_at >= v_day
     and u.status in ('completed', 'failed');

  if v_tokens + p_estimate_input_tokens + p_estimate_output_tokens > v_token_cap then
    return jsonb_build_object('status', 'daily_tokens');
  end if;

  select coalesce(sum(picked.estimated_cost_micros), 0)
    into v_spent
    from (
      select distinct on (u.request_id) u.estimated_cost_micros
        from public.ai_usage u
       where u.created_at >= v_month
       order by u.request_id,
         case u.status when 'completed' then 0 when 'failed' then 1 else 2 end,
         u.created_at desc
    ) picked;

  if v_spent + p_estimate_micros > p_budget_micros then
    return jsonb_build_object('status', 'budget');
  end if;

  insert into public.ai_usage (
    request_id, user_id, task, model,
    input_tokens, output_tokens, estimated_cost_micros, status
  ) values (
    p_request_id, p_user_id, 'compose_pitch', p_model,
    0, 0, p_estimate_micros, 'reserved'
  );

  return jsonb_build_object('status', 'reserved');
end;
$$;

comment on function public.prepare_ai_usage(uuid, uuid, text, bigint, bigint, integer, integer, integer, integer) is
  'D145. Service role only. Reserves estimated spend or refuses for the monthly cap, the daily cap, or a 3-second per-user gap. Stores no prompt.';

revoke all on function public.prepare_ai_usage(uuid, uuid, text, bigint, bigint, integer, integer, integer, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.prepare_ai_usage(uuid, uuid, text, bigint, bigint, integer, integer, integer, integer)
  to service_role;

create or replace function public.finish_ai_usage(
  p_user_id uuid,
  p_request_id uuid,
  p_model text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_cost_micros bigint,
  p_status text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null or p_request_id is null or p_model is null then
    raise exception 'ai usage requires a user, request, and model' using errcode = '22023';
  end if;
  if p_status is distinct from 'completed' and p_status is distinct from 'failed' then
    raise exception 'ai usage status is not allowed' using errcode = '22023';
  end if;
  if p_model !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$' then
    raise exception 'ai model id is not allowed' using errcode = '22023';
  end if;
  if p_input_tokens is null or p_input_tokens < 0 or p_input_tokens > 200000
     or p_output_tokens is null or p_output_tokens < 0 or p_output_tokens > 8192
     or p_cost_micros is null or p_cost_micros < 0 or p_cost_micros > 1000000000 then
    raise exception 'ai usage counts are not allowed' using errcode = '22023';
  end if;

  insert into public.ai_usage (
    request_id, user_id, task, model,
    input_tokens, output_tokens, estimated_cost_micros, status
  ) values (
    p_request_id, p_user_id, 'compose_pitch', p_model,
    p_input_tokens, p_output_tokens, p_cost_micros, p_status
  )
  on conflict (request_id, status) do nothing;
end;
$$;

comment on function public.finish_ai_usage(uuid, uuid, text, integer, integer, bigint, text) is
  'D145. Service role only. Records token counts for one call. No prompt and no completion.';

revoke all on function public.finish_ai_usage(uuid, uuid, text, integer, integer, bigint, text)
  from public, anon, authenticated, service_role;
grant execute on function public.finish_ai_usage(uuid, uuid, text, integer, integer, bigint, text)
  to service_role;

-- Plain text only, and only for ids the caller passed that they own.
-- An empty list returns nothing. Another user's id returns nothing.
-- HTML parts are not returned. Each body is cut at 500 characters.
create or replace function public.read_own_selected_gmail_plain(p_message_ids uuid[])
returns table (message_id uuid, plain_text text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if p_message_ids is null or pg_catalog.cardinality(p_message_ids) = 0 then
    return;
  end if;

  return query
  select m.id,
         pg_catalog.left(
           string_agg(tp.decoded_text, E'\n' order by tp.part_path),
           500
         )
    from private.gmail_normalized_messages m
    join private.gmail_normalized_text_parts tp
      on tp.normalized_message_id = m.id
     and tp.mime_type = 'text/plain'
     and tp.decode_status = 'decoded'
     and tp.decoded_text is not null
     and pg_catalog.length(tp.decoded_text) > 0
   where m.user_id = v_caller
     and m.id = any (p_message_ids[1:3])
   group by m.id, m.internal_date
   order by m.internal_date desc
   limit 3;
end;
$$;

comment on function public.read_own_selected_gmail_plain(uuid[]) is
  'D144. Plain text for messages the caller explicitly selected and owns. No HTML. No other user. An empty selection returns no rows.';

revoke all on function public.read_own_selected_gmail_plain(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.read_own_selected_gmail_plain(uuid[]) to authenticated, service_role;

create or replace function public.list_own_mail_subjects(p_limit integer)
returns table (message_id uuid, subject text, internal_date timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
  v_limit integer;
begin
  if v_caller is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  v_limit := least(greatest(coalesce(p_limit, 8), 1), 8);

  return query
  select m.id,
         pg_catalog.left(coalesce(h.raw_value, ''), 80),
         m.internal_date
    from private.gmail_normalized_messages m
    left join private.gmail_normalized_headers h
      on h.normalized_message_id = m.id
     and h.header_name = 'subject'
     and h.occurrence_index = 0
   where m.user_id = v_caller
   order by m.internal_date desc
   limit v_limit;
end;
$$;

comment on function public.list_own_mail_subjects(integer) is
  'D144. Subject lines for the caller''s own messages, so they can choose what to include. The body is not a column.';

revoke all on function public.list_own_mail_subjects(integer) from public, anon, authenticated, service_role;
grant execute on function public.list_own_mail_subjects(integer) to authenticated, service_role;
