-- ===========================================================================
-- 0090 — MONTHLY AI BUDGET, RATE PAUSE, ABUSE FLAGS (D162–D167, D170)
-- ===========================================================================
-- Replaces the per-user daily call and token caps with a monthly USD budget.
-- The global pool alerts the owner. It does not refuse a user who is still
-- inside their own budget. 0082 and 0083 are not edited.

alter table public.ai_usage
  add column hotel_id uuid references public.hotels (id) on delete restrict,
  add column budget_micros bigint not null default 0
    check (budget_micros >= 0 and budget_micros <= 1000000000);

do $drop_status$
declare
  v_name text;
begin
  select con.conname into v_name
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class rel on rel.oid = con.conrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = rel.relnamespace
   where nsp.nspname = 'public'
     and rel.relname = 'ai_usage'
     and con.contype = 'c'
     and pg_catalog.pg_get_constraintdef(con.oid) ~* 'status';
  if v_name is not null then
    execute format('alter table public.ai_usage drop constraint %I', v_name);
  end if;
end
$drop_status$;

alter table public.ai_usage
  add constraint ai_usage_status_check
  check (status in ('reserved', 'completed', 'failed', 'rejected'));

comment on column public.ai_usage.budget_micros is
  'D162. Weighted micros charged to this user''s monthly budget. Real token cost stays in estimated_cost_micros. No prompt.';

comment on column public.ai_usage.hotel_id is
  'D166. The unlocked hotel this generation was for. Null on rows written before this column existed. ON DELETE RESTRICT: ai_usage is append-only, so a hotel delete cannot null this column.';

-- ---------------------------------------------------------------------------
-- Pause, flags, pool alerts. No client grants. RLS on, no policies.
-- ---------------------------------------------------------------------------

create table private.ai_account_pauses (
  user_id uuid primary key references public.users (id) on delete cascade,
  reason text not null check (reason = 'generation_rate'),
  paused_at timestamptz not null default now(),
  unpaused_at timestamptz,
  unpaused_by uuid
);

comment on table private.ai_account_pauses is
  'D165. One active pause stops AI and sends until an admin clears unpaused_at. Deleted with the user.';

create table private.abuse_flags (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  hotel_id uuid references public.hotels (id) on delete set null,
  signal text not null check (signal in (
    'high_regen_send_ratio',
    'generation_without_recent_unlock',
    'injection_attempt'
  )),
  created_at timestamptz not null default now()
);

create index abuse_flags_user_created_idx
  on private.abuse_flags (user_id, created_at desc);

comment on table private.abuse_flags is
  'D167. Admin-visible abuse signals. No prompt and no message body. Deleted with the user.';

create table private.ai_pool_alerts (
  month_start date not null,
  level text not null check (level in ('nearing', 'exhausted')),
  pool_micros bigint not null check (pool_micros >= 0),
  spent_micros bigint not null check (spent_micros >= 0),
  created_at timestamptz not null default now(),
  primary key (month_start, level)
);

comment on table private.ai_pool_alerts is
  'D163. One owner alert per UTC month and level. No user id. Not removed when a creator is deleted.';

alter table private.ai_account_pauses enable row level security;
alter table private.abuse_flags enable row level security;
alter table private.ai_pool_alerts enable row level security;

revoke all on private.ai_account_pauses from public, anon, authenticated, service_role;
revoke all on private.abuse_flags from public, anon, authenticated, service_role;
revoke all on private.ai_pool_alerts from public, anon, authenticated, service_role;

-- Resolves a timezone name. Invalid or blank becomes UTC. Not security definer.
create or replace function public.ai_zone_name(p_timezone text)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_zone text := coalesce(nullif(btrim(p_timezone), ''), 'UTC');
begin
  perform pg_catalog.now() at time zone v_zone;
  return v_zone;
exception when others then
  return 'UTC';
end;
$$;

revoke all on function public.ai_zone_name(text) from public, anon, authenticated;
grant execute on function public.ai_zone_name(text) to service_role;

create or replace function public.record_abuse_flag(
  p_user_id uuid,
  p_hotel_id uuid,
  p_signal text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null or p_signal not in (
    'high_regen_send_ratio',
    'generation_without_recent_unlock',
    'injection_attempt'
  ) then
    return;
  end if;
  if not exists (select 1 from public.users u where u.id = p_user_id) then
    return;
  end if;
  if exists (
    select 1
      from private.abuse_flags f
     where f.user_id = p_user_id
       and f.signal = p_signal
       and f.hotel_id is not distinct from p_hotel_id
       and f.created_at > pg_catalog.now() - interval '24 hours'
  ) then
    return;
  end if;
  insert into private.abuse_flags (user_id, hotel_id, signal)
  values (p_user_id, p_hotel_id, p_signal);
end;
$$;

comment on function public.record_abuse_flag(uuid, uuid, text) is
  'D167. Service role only. Records one abuse signal. Stores no prompt. A repeat inside 24 hours is ignored.';

revoke all on function public.record_abuse_flag(uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.record_abuse_flag(uuid, uuid, text) to service_role;

create or replace function public.read_admin_abuse_flags(p_limit integer)
returns table (
  id uuid,
  user_id uuid,
  hotel_id uuid,
  signal text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
begin
  if not exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'admin'
  ) then
    return;
  end if;
  return query
  select f.id, f.user_id, f.hotel_id, f.signal, f.created_at
    from private.abuse_flags f
   order by f.created_at desc, f.id
   limit v_limit;
end;
$$;

comment on function public.read_admin_abuse_flags(integer) is
  'D167. Admin only. A creator or an editor receives no rows.';

revoke all on function public.read_admin_abuse_flags(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.read_admin_abuse_flags(integer)
  to authenticated, service_role;

create or replace function public.read_admin_ai_pool_alerts(p_limit integer)
returns table (
  month_start date,
  level text,
  pool_micros bigint,
  spent_micros bigint,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 12), 1), 24);
begin
  if not exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'admin'
  ) then
    return;
  end if;
  return query
  select a.month_start, a.level, a.pool_micros, a.spent_micros, a.created_at
    from private.ai_pool_alerts a
   order by a.month_start desc, a.level
   limit v_limit;
end;
$$;

comment on function public.read_admin_ai_pool_alerts(integer) is
  'D163. Admin only. Alerts have no user id.';

revoke all on function public.read_admin_ai_pool_alerts(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.read_admin_ai_pool_alerts(integer)
  to authenticated, service_role;

create or replace function public.admin_unpause_account(p_user_id uuid)
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
  update private.ai_account_pauses
     set unpaused_at = pg_catalog.now(),
         unpaused_by = auth.uid()
   where user_id = p_user_id
     and unpaused_at is null;
  return jsonb_build_object('result', 'ok');
end;
$$;

comment on function public.admin_unpause_account(uuid) is
  'D165. The signed-in admin clears the generation-rate pause. An editor or a creator is forbidden and changes nothing.';

revoke all on function public.admin_unpause_account(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.admin_unpause_account(uuid)
  to authenticated, service_role;

create or replace function public.read_own_ai_budget()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_caller uuid := auth.uid();
  v_month timestamptz;
  v_spent bigint;
  v_paused boolean;
  v_sends boolean;
begin
  if v_caller is null then
    return jsonb_build_object('result', 'signed_out');
  end if;
  v_month := (date_trunc('month', pg_catalog.now() at time zone 'utc') at time zone 'utc');
  select coalesce(sum(picked.budget_micros), 0)
    into v_spent
    from (
      select distinct on (u.request_id) u.budget_micros
        from public.ai_usage u
       where u.user_id = v_caller
         and u.created_at >= v_month
       order by u.request_id,
         case u.status
           when 'completed' then 0
           when 'rejected' then 1
           when 'failed' then 2
           else 3
         end,
         u.created_at desc
    ) picked;
  select exists (
    select 1 from private.ai_account_pauses p
     where p.user_id = v_caller and p.unpaused_at is null
  ) into v_paused;
  v_sends := false;
  if to_regclass('private.gmail_send_pauses') is not null then
    execute
      'select exists (select 1 from private.gmail_send_pauses p where p.user_id = $1 and p.unpaused_at is null)'
      into v_sends
      using v_caller;
  end if;
  return jsonb_build_object(
    'result', 'ok',
    'paused', v_paused,
    'sends_paused', v_sends,
    'spent_micros', v_spent
  );
end;
$$;

comment on function public.read_own_ai_budget() is
  'D162. The caller''s own monthly weighted spend and pause flags. No other user.';

revoke all on function public.read_own_ai_budget()
  from public, anon, authenticated, service_role;
grant execute on function public.read_own_ai_budget() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- prepare / finish. The old signatures are dropped.
-- ---------------------------------------------------------------------------

drop function if exists public.prepare_ai_usage(
  uuid, uuid, text, bigint, bigint, integer, integer, integer, integer
);

create function public.prepare_ai_usage(
  p_user_id uuid,
  p_request_id uuid,
  p_model text,
  p_hotel_id uuid,
  p_estimate_micros bigint,
  p_user_budget_micros bigint,
  p_regen_weight integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_month timestamptz;
  v_budget bigint;
  v_weight integer;
  v_completed integer;
  v_spent bigint;
  v_charge bigint;
  v_started integer;
  v_unlock timestamptz;
  v_warning text;
begin
  if p_user_id is null or p_request_id is null or p_model is null or p_hotel_id is null then
    raise exception 'ai usage requires a user, request, model, and hotel' using errcode = '22023';
  end if;
  if p_model !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$' then
    raise exception 'ai model id is not allowed' using errcode = '22023';
  end if;
  if p_estimate_micros is null or p_estimate_micros <= 0 or p_estimate_micros > 1000000000 then
    raise exception 'ai estimate is not allowed' using errcode = '22023';
  end if;
  if not exists (select 1 from public.users u where u.id = p_user_id) then
    raise exception 'ai user is missing' using errcode = '22023';
  end if;
  if not exists (select 1 from public.hotels h where h.id = p_hotel_id) then
    return jsonb_build_object('status', 'not_unlocked');
  end if;

  select u.created_at into v_unlock
    from public.contact_unlocks u
   where u.user_id = p_user_id
     and u.hotel_id = p_hotel_id;
  if v_unlock is null then
    return jsonb_build_object('status', 'not_unlocked');
  end if;

  v_budget := coalesce(p_user_budget_micros, 0);
  if v_budget <= 0 then
    return jsonb_build_object('status', 'budget');
  end if;
  if v_budget > 100000000 then
    v_budget := 100000000;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('theugc.ai_budget'),
    pg_catalog.hashtext(p_user_id::text)
  );

  if exists (
    select 1 from private.ai_account_pauses p
     where p.user_id = p_user_id and p.unpaused_at is null
  ) then
    return jsonb_build_object('status', 'paused');
  end if;

  if exists (
    select 1
      from public.ai_usage u
     where u.request_id = p_request_id
       and u.status = 'reserved'
  ) then
    select case
             when u.budget_micros = 0 then 0
             when coalesce(u.estimated_cost_micros, 0) = 0 then 1
             else greatest(1, (u.budget_micros / u.estimated_cost_micros)::integer)
           end
      into v_weight
      from public.ai_usage u
     where u.request_id = p_request_id
       and u.status = 'reserved'
     order by u.created_at desc
     limit 1;
    return jsonb_build_object('status', 'already_reserved', 'weight', coalesce(v_weight, 1));
  end if;

  if exists (
    select 1
      from public.ai_usage u
     where u.user_id = p_user_id
       and u.created_at > pg_catalog.now() - interval '3 seconds'
  ) then
    return jsonb_build_object('status', 'rate_limited');
  end if;

  select count(distinct u.request_id)::integer
    into v_started
    from public.ai_usage u
   where u.user_id = p_user_id
     and u.created_at > pg_catalog.now() - interval '60 seconds';

  if v_started >= 10 then
    insert into private.ai_account_pauses (user_id, reason)
    values (p_user_id, 'generation_rate')
    on conflict (user_id) do update
      set reason = 'generation_rate',
          paused_at = pg_catalog.now(),
          unpaused_at = null,
          unpaused_by = null
    where private.ai_account_pauses.unpaused_at is not null;
    return jsonb_build_object('status', 'paused');
  end if;

  if v_unlock < pg_catalog.now() - interval '30 days' then
    perform public.record_abuse_flag(p_user_id, p_hotel_id, 'generation_without_recent_unlock');
  end if;

  v_month := (date_trunc('month', pg_catalog.now() at time zone 'utc') at time zone 'utc');

  select count(distinct u.request_id)::integer
    into v_completed
    from public.ai_usage u
   where u.user_id = p_user_id
     and u.hotel_id = p_hotel_id
     and u.status = 'completed'
     and u.created_at >= v_month;

  if v_completed = 0 then
    v_weight := 1;
  elsif v_completed <= 3 then
    v_weight := 0;
  else
    v_weight := coalesce(p_regen_weight, 2);
    if v_weight < 2 then
      v_weight := 2;
    end if;
    if v_weight > 5 then
      v_weight := 5;
    end if;
  end if;

  v_charge := p_estimate_micros * v_weight;

  select coalesce(sum(picked.budget_micros), 0)
    into v_spent
    from (
      select distinct on (u.request_id) u.budget_micros
        from public.ai_usage u
       where u.user_id = p_user_id
         and u.created_at >= v_month
       order by u.request_id,
         case u.status
           when 'completed' then 0
           when 'rejected' then 1
           when 'failed' then 2
           else 3
         end,
         u.created_at desc
    ) picked;

  if v_weight = 0 and v_spent >= v_budget then
    return jsonb_build_object('status', 'budget', 'spent_micros', v_spent, 'budget_micros', v_budget, 'weight', 0);
  end if;

  if v_spent + v_charge > v_budget then
    return jsonb_build_object('status', 'budget', 'spent_micros', v_spent, 'budget_micros', v_budget);
  end if;

  v_warning := null;
  if (v_spent + v_charge) * 5 >= v_budget * 4 then
    v_warning := 'budget_80';
  end if;

  insert into public.ai_usage (
    request_id, user_id, task, model, hotel_id,
    input_tokens, output_tokens, estimated_cost_micros, budget_micros, status
  ) values (
    p_request_id, p_user_id, 'compose_pitch', p_model, p_hotel_id,
    0, 0, p_estimate_micros, v_charge, 'reserved'
  );

  return jsonb_build_object(
    'status', 'reserved',
    'warning', v_warning,
    'spent_micros', v_spent + v_charge,
    'budget_micros', v_budget,
    'weight', v_weight
  );
end;
$$;

comment on function public.prepare_ai_usage(uuid, uuid, text, uuid, bigint, bigint, integer) is
  'D162 and D165. Service role only. Reserves a weighted user budget or refuses. Ten starts in a minute pause the account. The global pool is not a refusal. Stores no prompt.';

revoke all on function public.prepare_ai_usage(uuid, uuid, text, uuid, bigint, bigint, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.prepare_ai_usage(uuid, uuid, text, uuid, bigint, bigint, integer)
  to service_role;

drop function if exists public.finish_ai_usage(uuid, uuid, text, integer, integer, bigint, text);

create function public.finish_ai_usage(
  p_user_id uuid,
  p_request_id uuid,
  p_model text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_cost_micros bigint,
  p_status text,
  p_pool_floor_micros bigint,
  p_pool_percent_bps integer
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hotel uuid;
  v_estimate bigint;
  v_reserved_budget bigint;
  v_weighted bigint;
  v_month timestamptz;
  v_prev timestamptz;
  v_revenue numeric;
  v_bps integer;
  v_floor bigint;
  v_pool bigint;
  v_spent bigint;
  v_gens integer;
  v_sends integer;
  v_month_date date;
begin
  if p_user_id is null or p_request_id is null or p_model is null then
    raise exception 'ai usage requires a user, request, and model' using errcode = '22023';
  end if;
  if p_status not in ('completed', 'failed', 'rejected') then
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

  select u.hotel_id, u.estimated_cost_micros, u.budget_micros
    into v_hotel, v_estimate, v_reserved_budget
    from public.ai_usage u
   where u.request_id = p_request_id
     and u.user_id = p_user_id
     and u.status = 'reserved'
   order by u.created_at desc
   limit 1;

  if v_estimate is null then
    raise exception 'ai usage reservation is missing' using errcode = '22023';
  end if;

  if v_estimate = 0 or coalesce(v_reserved_budget, 0) = 0 then
    v_weighted := 0;
  else
    v_weighted := (p_cost_micros * v_reserved_budget) / v_estimate;
    if v_weighted > v_reserved_budget then
      v_weighted := v_reserved_budget;
    end if;
  end if;

  insert into public.ai_usage (
    request_id, user_id, task, model, hotel_id,
    input_tokens, output_tokens, estimated_cost_micros, budget_micros, status
  ) values (
    p_request_id, p_user_id, 'compose_pitch', p_model, v_hotel,
    p_input_tokens, p_output_tokens, p_cost_micros, v_weighted, p_status
  )
  on conflict (request_id, status) do nothing;

  if p_status in ('completed', 'rejected') and v_hotel is not null then
    select count(distinct u.request_id)::integer
      into v_gens
      from public.ai_usage u
     where u.user_id = p_user_id
       and u.status in ('completed', 'rejected')
       and u.created_at >= pg_catalog.now() - interval '7 days';
    select count(*)::integer
      into v_sends
      from private.gmail_send_attempts a
     where a.user_id = p_user_id
       and a.status = 'sent'
       and a.created_at >= pg_catalog.now() - interval '7 days';
    if v_gens >= 6 and (v_sends = 0 or v_gens >= v_sends * 5) then
      perform public.record_abuse_flag(p_user_id, v_hotel, 'high_regen_send_ratio');
    end if;
  end if;

  v_month := (date_trunc('month', pg_catalog.now() at time zone 'utc') at time zone 'utc');
  v_prev := v_month - interval '1 month';
  v_month_date := (v_month at time zone 'utc')::date;

  select coalesce(sum(p.amount), 0)
    into v_revenue
    from public.purchases p
   where p.status = 'approved'
     and p.refunded_at is null
     and upper(coalesce(p.currency, '')) = 'USD'
     and p.purchased_at >= v_prev
     and p.purchased_at < v_month;

  v_bps := coalesce(p_pool_percent_bps, 1500);
  if v_bps < 100 or v_bps > 5000 then
    v_bps := 1500;
  end if;
  v_floor := coalesce(p_pool_floor_micros, 0);
  if v_floor < 0 then
    v_floor := 0;
  end if;
  if v_floor > 100000000000 then
    v_floor := 100000000000;
  end if;
  v_pool := greatest(
    v_floor,
    least(100000000000, greatest(0, round(v_revenue * v_bps * 100)::bigint))
  );

  select coalesce(sum(picked.estimated_cost_micros), 0)
    into v_spent
    from (
      select distinct on (u.request_id) u.estimated_cost_micros
        from public.ai_usage u
       where u.created_at >= v_month
       order by u.request_id,
         case u.status
           when 'completed' then 0
           when 'rejected' then 1
           when 'failed' then 2
           else 3
         end,
         u.created_at desc
    ) picked;

  if v_pool > 0 and v_spent * 5 >= v_pool * 4 then
    insert into private.ai_pool_alerts (month_start, level, pool_micros, spent_micros)
    values (v_month_date, 'nearing', v_pool, v_spent)
    on conflict (month_start, level) do nothing;
  end if;
  if (v_pool > 0 and v_spent >= v_pool) or (v_pool = 0 and v_spent > 0) then
    insert into private.ai_pool_alerts (month_start, level, pool_micros, spent_micros)
    values (v_month_date, 'exhausted', v_pool, v_spent)
    on conflict (month_start, level) do nothing;
  end if;
end;
$$;

comment on function public.finish_ai_usage(uuid, uuid, text, integer, integer, bigint, text, bigint, integer) is
  'D162 and D163. Service role only. Records real token cost and the weighted user charge. A full global pool writes an alert and does not raise. No prompt.';

revoke all on function public.finish_ai_usage(uuid, uuid, text, integer, integer, bigint, text, bigint, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.finish_ai_usage(uuid, uuid, text, integer, integer, bigint, text, bigint, integer)
  to service_role;
