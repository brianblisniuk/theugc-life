-- 0059_pause_free_gmail_sync.sql
-- Free Gmail sync is paused (D102). Login and the scheduled due list skip a
-- user who has neither an active Pro entitlement nor an active Destination
-- Pass. Stored mailboxes, credentials, cursors, and messages stay. Claim and
-- completion are unchanged, so a paid mailbox already in a run can finish.
-- 0047 is not edited.

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
  'Marks this user''s connected mailboxes due when they have active Pro or an active Destination Pass. A Free user returns no ids and no cursor is changed.';

comment on function public.gmail_incremental_sync_list_due(integer) is
  'Due mailbox ids for the operator worker. Free users are omitted. No message content and no deletes.';
