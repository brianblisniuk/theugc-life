-- ===========================================================================
-- 0088 — DEC-DEL account deletion (D151–D155)
-- ===========================================================================
-- A creator can ask for account deletion. Personal data is removed by
-- delete_after, which is exactly 30 days after deletion_requested_at.
-- Identifier-free stored counters (hotel_intelligence, destination_intelligence)
-- are not rewritten and are not filled from the creator's private rows.
-- Facts that still name the creator are removed with the user.
--
-- This file does not edit 0080–0087. It does not call Google, send mail,
-- or change a price.
-- ===========================================================================

alter table public.users
  add column deletion_requested_at timestamptz,
  add column delete_after timestamptz;

alter table public.users
  add constraint users_deletion_clock_pair check (
    (deletion_requested_at is null and delete_after is null)
    or (deletion_requested_at is not null and delete_after is not null)
  );

alter table public.users
  add constraint users_deletion_clock_window check (
    delete_after is null
    or (
      delete_after > deletion_requested_at
      and delete_after <= deletion_requested_at + interval '30 days'
    )
  );

comment on column public.users.deletion_requested_at is
  'D151. When the creator asked to delete the account. Null means no request.';

comment on column public.users.delete_after is
  'D152. Hard-delete deadline. Exactly deletion_requested_at plus 30 days. The erase job refuses to run before this instant.';

create index users_delete_after_idx
  on public.users (delete_after)
  where delete_after is not null;

-- Authenticated sessions can update their own users row. They cannot move
-- this clock. The request function sets theugc.account_deletion for its
-- own write. service_role and the table owner may move delete_after earlier
-- so the job can be proven without waiting 30 days; they cannot pass the
-- 30-day check above.
create or replace function public.users_guard_deletion_clock()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and (
       new.deletion_requested_at is distinct from old.deletion_requested_at
       or new.delete_after is distinct from old.delete_after
     )
     and pg_catalog.current_setting('theugc.account_deletion', true) is distinct from 'on'
     and current_user in ('anon', 'authenticated')
  then
    raise exception 'not authorized to change the account deletion schedule'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.users_guard_deletion_clock() is
  'D152. anon and authenticated cannot set deletion_requested_at or delete_after. The request function opts in with a transaction-local setting.';

revoke all on function public.users_guard_deletion_clock() from public, anon, authenticated, service_role;
grant execute on function public.users_guard_deletion_clock() to authenticated, service_role;

create trigger users_guard_deletion_clock
  before update on public.users
  for each row execute function public.users_guard_deletion_clock();

-- ---------------------------------------------------------------------------
-- Append-only ledgers may disappear only with the owning user.
-- A direct delete while the user row still exists is still refused.
-- PostgreSQL removes the parent before it applies ON DELETE CASCADE, which
-- is the same test B01 uses for consent receipts.
-- ---------------------------------------------------------------------------

create or replace function public.credit_ledger_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.users u where u.id = old.user_id
  ) then
    return old;
  end if;
  raise exception 'credit_ledger is append-only' using errcode = '55000';
end;
$$;

create or replace function public.ai_usage_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.users u where u.id = old.user_id
  ) then
    return old;
  end if;
  raise exception 'ai_usage is append-only' using errcode = '55000';
end;
$$;

-- Personal rows that did not cascade, and the one ledger child that would
-- block the ledger cascade. Editorial reviewer columns stay NO ACTION:
-- those tables are append-only staff evidence, and this path does not
-- rewrite them. A creator id on one of them stops erasure instead.
do $$
declare
  v_name text;
begin
  select con.conname into v_name
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class rel on rel.oid = con.conrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = rel.relnamespace
    join pg_catalog.pg_attribute att
      on att.attrelid = rel.oid and att.attnum = any (con.conkey)
   where nsp.nspname = 'public'
     and rel.relname = 'credit_ledger'
     and att.attname = 'user_id'
     and con.contype = 'f';
  execute format('alter table public.credit_ledger drop constraint %I', v_name);
  alter table public.credit_ledger
    add constraint credit_ledger_user_id_fkey
    foreign key (user_id) references public.users (id) on delete cascade;

  select con.conname into v_name
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class rel on rel.oid = con.conrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = rel.relnamespace
    join pg_catalog.pg_attribute att
      on att.attrelid = rel.oid and att.attnum = any (con.conkey)
   where nsp.nspname = 'public'
     and rel.relname = 'contact_unlocks'
     and att.attname = 'user_id'
     and con.contype = 'f';
  execute format('alter table public.contact_unlocks drop constraint %I', v_name);
  alter table public.contact_unlocks
    add constraint contact_unlocks_user_id_fkey
    foreign key (user_id) references public.users (id) on delete cascade;

  select con.conname into v_name
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class rel on rel.oid = con.conrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = rel.relnamespace
    join pg_catalog.pg_attribute att
      on att.attrelid = rel.oid and att.attnum = any (con.conkey)
   where nsp.nspname = 'public'
     and rel.relname = 'contact_unlocks'
     and att.attname = 'ledger_id'
     and con.contype = 'f';
  execute format('alter table public.contact_unlocks drop constraint %I', v_name);
  alter table public.contact_unlocks
    add constraint contact_unlocks_ledger_id_fkey
    foreign key (ledger_id) references public.credit_ledger (id) on delete cascade;

  select con.conname into v_name
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class rel on rel.oid = con.conrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = rel.relnamespace
    join pg_catalog.pg_attribute att
      on att.attrelid = rel.oid and att.attnum = any (con.conkey)
   where nsp.nspname = 'public'
     and rel.relname = 'contact_reports'
     and att.attname = 'user_id'
     and con.contype = 'f';
  execute format('alter table public.contact_reports drop constraint %I', v_name);
  alter table public.contact_reports
    add constraint contact_reports_user_id_fkey
    foreign key (user_id) references public.users (id) on delete cascade;

  select con.conname into v_name
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class rel on rel.oid = con.conrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = rel.relnamespace
    join pg_catalog.pg_attribute att
      on att.attrelid = rel.oid and att.attnum = any (con.conkey)
   where nsp.nspname = 'public'
     and rel.relname = 'contact_reports'
     and att.attname = 'reviewed_by'
     and con.contype = 'f';
  execute format('alter table public.contact_reports drop constraint %I', v_name);
  alter table public.contact_reports
    add constraint contact_reports_reviewed_by_fkey
    foreign key (reviewed_by) references public.users (id) on delete set null;

  select con.conname into v_name
    from pg_catalog.pg_constraint con
    join pg_catalog.pg_class rel on rel.oid = con.conrelid
    join pg_catalog.pg_namespace nsp on nsp.oid = rel.relnamespace
    join pg_catalog.pg_attribute att
      on att.attrelid = rel.oid and att.attnum = any (con.conkey)
   where nsp.nspname = 'private'
     and rel.relname = 'gmail_outreach_creator_decision_events'
     and att.attname = 'decided_by_user_id'
     and con.contype = 'f';
  execute format(
    'alter table private.gmail_outreach_creator_decision_events drop constraint %I',
    v_name
  );
  alter table private.gmail_outreach_creator_decision_events
    add constraint gmail_outreach_creator_decision_events_decided_by_fkey
    foreign key (decided_by_user_id) references public.users (id) on delete cascade;
end;
$$;

-- The credential invariant is a deferred constraint trigger. It runs at COMMIT
-- as the session user. A creator's request is security definer, then the
-- session commits as authenticated, which cannot read the private credential
-- table. The check itself does not return a token. Running it as the owner
-- keeps the same rule and lets the legitimate state change commit.
alter function public.assert_gmail_credential_state_coherent()
  security definer
  set search_path = '';

revoke all on function public.assert_gmail_credential_state_coherent()
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Stop Gmail the way B01 already represents deletion: one open request,
-- deletion_pending, scopes cleared, stored refresh token removed.
-- Sync cancellation is the existing lifecycle trigger on that state.
-- This does not call Google. Disconnect prepare/finalize is unchanged.
-- ---------------------------------------------------------------------------

create or replace function public.account_deletion_stop_gmail(p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account public.mail_accounts%rowtype;
  v_request uuid;
begin
  if p_user_id is null then
    return;
  end if;

  delete from private.gmail_oauth_credentials where user_id = p_user_id;
  delete from private.gmail_oauth_transactions where user_id = p_user_id;

  for v_account in
    select m.*
      from public.mail_accounts m
     where m.user_id = p_user_id
     order by m.id
     for update
  loop
    if v_account.connection_state = 'deleted' then
      continue;
    end if;

    select r.id
      into v_request
      from public.mail_account_deletion_requests r
     where r.mail_account_id = v_account.id
       and r.status in ('requested', 'in_progress')
     order by r.requested_at desc, r.id desc
     limit 1;

    if v_request is null then
      insert into public.mail_account_deletion_requests (
        mail_account_id,
        user_id,
        scope,
        requested_by_user_id,
        requested_at,
        status
      ) values (
        v_account.id,
        p_user_id,
        'account_and_gmail_derived_data',
        p_user_id,
        pg_catalog.clock_timestamp(),
        'in_progress'
      )
      returning id into v_request;
    end if;

    update public.mail_accounts
       set connection_state = 'deletion_pending',
           current_deletion_request_id = v_request,
           disconnected_at = coalesce(disconnected_at, pg_catalog.clock_timestamp()),
           granted_scopes = '{}'
     where id = v_account.id
       and user_id = p_user_id;
  end loop;
end;
$$;

comment on function public.account_deletion_stop_gmail(uuid) is
  'D153. Puts each of this creator''s mailboxes on the existing deletion request and removes stored OAuth material. Not granted to client roles. Does not call Google.';

revoke all on function public.account_deletion_stop_gmail(uuid)
  from public, anon, authenticated, service_role;

-- A blank claims string is not a signed-in user. auth.uid() casts that
-- string to jsonb and raises. These functions treat it as no caller.
create or replace function public.account_deletion_caller()
returns uuid
language sql
stable
set search_path = ''
as $$
  select case
    when pg_catalog.btrim(coalesce(pg_catalog.current_setting('request.jwt.claims', true), '')) = ''
      then null::uuid
    else nullif(pg_catalog.current_setting('request.jwt.claims', true)::jsonb ->> 'sub', '')::uuid
  end;
$$;

revoke all on function public.account_deletion_caller()
  from public, anon, authenticated, service_role;

comment on function public.account_deletion_caller() is
  'D155. The signed-in user for account deletion, or null when the claims are missing or blank. Not granted to client roles.';

-- ---------------------------------------------------------------------------
-- The creator asks. Identity is the session. There is no user-id argument.
-- ---------------------------------------------------------------------------

create or replace function public.request_own_account_deletion(p_confirmation text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := public.account_deletion_caller();
  v_role text;
  v_requested timestamptz;
  v_after timestamptz;
  v_balance integer;
begin
  if v_user is null then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  select u.role, u.deletion_requested_at, u.delete_after
    into v_role, v_requested, v_after
    from public.users u
   where u.id = v_user
   for update;

  if not found then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  if v_role is distinct from 'creator' then
    return pg_catalog.jsonb_build_object('result', 'not_creator');
  end if;

  if v_requested is not null and v_after is not null then
    return pg_catalog.jsonb_build_object(
      'result', 'already_scheduled',
      'deletion_requested_at', v_requested,
      'delete_after', v_after
    );
  end if;

  if p_confirmation is distinct from 'DELETE' then
    return pg_catalog.jsonb_build_object('result', 'confirmation_required');
  end if;

  perform public.account_deletion_stop_gmail(v_user);

  update public.creator_share_links as link
     set revoked_at = pg_catalog.clock_timestamp()
    from public.creator_profiles as profile
   where link.creator_id = profile.id
     and profile.user_id = v_user
     and link.revoked_at is null;

  delete from public.pitch_drafts as draft
   using public.creator_profiles as profile
   where draft.creator_id = profile.id
     and profile.user_id = v_user
     and draft.origin = 'assistant';

  select coalesce(pg_catalog.sum(entry.delta), 0)::integer
    into v_balance
    from public.credit_ledger as entry
   where entry.user_id = v_user;

  if v_balance > 0 then
    insert into public.credit_ledger (user_id, delta, reason, idempotency_key)
    values (
      v_user,
      -v_balance,
      'reversal',
      'account-deletion:' || v_user::text
    )
    on conflict (user_id, idempotency_key) do nothing;
  end if;

  v_requested := pg_catalog.clock_timestamp();
  v_after := v_requested + interval '30 days';

  perform pg_catalog.set_config('theugc.account_deletion', 'on', true);
  update public.users
     set deletion_requested_at = v_requested,
         delete_after = v_after
   where id = v_user;

  return pg_catalog.jsonb_build_object(
    'result', 'scheduled',
    'deletion_requested_at', v_requested,
    'delete_after', v_after
  );
end;
$$;

comment on function public.request_own_account_deletion(text) is
  'D151. Schedules the signed-in creator''s deletion 30 days out. Stops Gmail, revokes share links, removes assistant drafts, and reverses a positive credit balance. Does not take a user id.';

revoke all on function public.request_own_account_deletion(text)
  from public, anon, authenticated;
grant execute on function public.request_own_account_deletion(text)
  to authenticated, service_role;

create or replace function public.read_own_account_deletion()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := public.account_deletion_caller();
  v_requested timestamptz;
  v_after timestamptz;
begin
  if v_user is null then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  select u.deletion_requested_at, u.delete_after
    into v_requested, v_after
    from public.users u
   where u.id = v_user;

  if not found or v_requested is null or v_after is null then
    return pg_catalog.jsonb_build_object('result', 'none');
  end if;

  return pg_catalog.jsonb_build_object(
    'result', 'scheduled',
    'deletion_requested_at', v_requested,
    'delete_after', v_after
  );
end;
$$;

comment on function public.read_own_account_deletion() is
  'D152. The caller''s own deletion clock, or none. No other creator and no email.';

revoke all on function public.read_own_account_deletion()
  from public, anon, authenticated;
grant execute on function public.read_own_account_deletion()
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Hard delete. Service role only. Refuses a signed-in session, a missing
-- clock, and a deadline that has not arrived. Does not recompute aggregates.
-- ---------------------------------------------------------------------------

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
  end loop;

  perform pg_catalog.set_config('b07.purge', 'on', true);

  delete from public.users where id = p_user_id;
  delete from auth.users where id = p_user_id;

  return pg_catalog.jsonb_build_object('result', 'erased');
end;
$$;

comment on function public.erase_creator_account(uuid) is
  'D151. Removes one due creator and the personal rows that name them. Refuses a signed-in caller and a deadline that has not arrived. Does not recompute hotel_intelligence. service_role only.';

revoke all on function public.erase_creator_account(uuid)
  from public, anon, authenticated;
grant execute on function public.erase_creator_account(uuid) to service_role;

create or replace function public.erase_due_creator_accounts()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid;
  v_one jsonb;
  v_count integer := 0;
begin
  if public.account_deletion_caller() is not null then
    return pg_catalog.jsonb_build_object('result', 'forbidden');
  end if;

  for v_user in
    select u.id
      from public.users u
     where u.role = 'creator'
       and u.delete_after is not null
       and u.delete_after <= pg_catalog.now()
     order by u.delete_after, u.id
     for update skip locked
  loop
    v_one := public.erase_creator_account(v_user);
    if v_one->>'result' = 'not_creator' or v_one->>'result' = 'not_found' then
      continue;
    end if;
    if v_one->>'result' is distinct from 'erased' then
      raise exception 'account erasure stopped on %', v_one->>'result'
        using errcode = '55000';
    end if;
    v_count := v_count + 1;
  end loop;

  return pg_catalog.jsonb_build_object('result', 'ok', 'erased', v_count);
end;
$$;

comment on function public.erase_due_creator_accounts() is
  'D151 operator path. Erases creators whose delete_after has arrived. Returns a count only. service_role only. A signed-in session is forbidden.';

revoke all on function public.erase_due_creator_accounts()
  from public, anon, authenticated;
grant execute on function public.erase_due_creator_accounts() to service_role;
