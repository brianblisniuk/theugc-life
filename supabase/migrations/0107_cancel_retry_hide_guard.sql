-- 0107_cancel_retry_hide_guard.sql
-- A Rebill cancel that does not reach cancelled stays pending for the
-- erasure job. Hiding a Forbes photo fails when a public object remains.


create table private.rebill_cancel_queue (
  subscription_id text primary key check (subscription_id ~ '^sub_[A-Za-z0-9]+$'),
  reason text not null check (reason in ('pending', 'provider_error', 'not_configured')),
  created_at timestamptz not null default pg_catalog.now()
);

comment on table private.rebill_cancel_queue is
  'Provider subscription ids whose Rebill cancel is not done. No user id. Not a refund.';

alter table private.rebill_cancel_queue enable row level security;
revoke all on private.rebill_cancel_queue from public, anon, authenticated, service_role;

create or replace function public.rebill_close_local_subscriptions(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ids text[];
begin
  if p_user is null then
    return '[]'::jsonb;
  end if;

  perform public.rebill_remember_closed_account(p_user);

  select coalesce(
           array_agg(s.provider_subscription_id order by s.provider_subscription_id),
           array[]::text[]
         )
    into v_ids
    from public.subscriptions s
   where s.user_id = p_user
     and s.provider = 'rebill'
     and s.provider_subscription_id is not null;

  update public.subscriptions s
     set status = 'canceled',
         cancelled_at = coalesce(s.cancelled_at, pg_catalog.clock_timestamp())
   where s.user_id = p_user
     and s.provider = 'rebill'
     and s.status not in ('canceled', 'expired');

  insert into private.rebill_cancel_queue (subscription_id, reason)
  select id, 'pending'
    from unnest(v_ids) as id
   where id ~ '^sub_[A-Za-z0-9]+$'
  on conflict (subscription_id) do nothing;

  return pg_catalog.to_jsonb(v_ids);
end;
$$;

comment on function public.rebill_close_local_subscriptions(uuid) is
  'Cancels local Rebill subscriptions, remembers provider ids with no user id, and leaves each id pending until Rebill reports cancelled. Does not call Rebill and does not refund.';

revoke all on function public.rebill_close_local_subscriptions(uuid)
  from public, anon, authenticated, service_role;

create or replace function public.rebill_queue_provider_cancel(
  p_subscription_id text,
  p_reason text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_subscription_id is null
     or p_subscription_id !~ '^sub_[A-Za-z0-9]+$'
     or p_reason is null
     or p_reason not in ('pending', 'provider_error', 'not_configured')
  then
    return;
  end if;

  insert into private.rebill_cancel_queue (subscription_id, reason)
  values (p_subscription_id, p_reason)
  on conflict (subscription_id) do update
    set reason = excluded.reason;
end;
$$;

comment on function public.rebill_queue_provider_cancel(text, text) is
  'Records that a provider cancel is not done. Does not refund and does not store a user id.';

revoke all on function public.rebill_queue_provider_cancel(text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.rebill_queue_provider_cancel(text, text) to service_role;

create or replace function public.rebill_finish_provider_cancel(p_subscription_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_subscription_id is null or p_subscription_id !~ '^sub_[A-Za-z0-9]+$' then
    return;
  end if;
  delete from private.rebill_cancel_queue q
   where q.subscription_id = p_subscription_id;
end;
$$;

comment on function public.rebill_finish_provider_cancel(text) is
  'Removes a pending cancel after Rebill reports cancelled. Does not refund.';

revoke all on function public.rebill_finish_provider_cancel(text)
  from public, anon, authenticated, service_role;
grant execute on function public.rebill_finish_provider_cancel(text) to service_role;

create or replace function public.read_rebill_pending_cancels(p_limit integer)
returns table (
  subscription_id text,
  reason text,
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
  return query
  select q.subscription_id, q.reason, q.created_at
    from private.rebill_cancel_queue q
   order by q.created_at, q.subscription_id
   limit v_limit;
end;
$$;

comment on function public.read_rebill_pending_cancels(integer) is
  'Service role only. Provider subscription ids whose cancel is not done. No user id.';

revoke all on function public.read_rebill_pending_cancels(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.read_rebill_pending_cancels(integer) to service_role;

create or replace function public.read_admin_rebill_cancel_queue(p_limit integer)
returns table (
  subscription_id text,
  reason text,
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
  select q.subscription_id, q.reason, q.created_at
    from private.rebill_cancel_queue q
   order by q.created_at, q.subscription_id
   limit v_limit;
end;
$$;

comment on function public.read_admin_rebill_cancel_queue(integer) is
  'Admin-only alert of provider subscription ids whose Rebill cancel is not done. No user id and no refund.';

revoke all on function public.read_admin_rebill_cancel_queue(integer)
  from public, anon, authenticated, service_role;
grant execute on function public.read_admin_rebill_cancel_queue(integer)
  to authenticated, service_role;

create or replace function public.hide_hotel_media(p_id uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.hotel_media%rowtype;
  v_bucket text;
  v_base text;
begin
  if p_id is null or not public.is_admin_or_editor() then
    return false;
  end if;

  select m.*
    into v_row
    from public.hotel_media m
   where m.id = p_id
     and m.status = 'active'
   for update;

  if not found then
    return false;
  end if;

  v_bucket := v_row.storage_bucket;
  if v_row.source = 'forbes'
     and v_row.storage_path is not null
     and pg_catalog.char_length(v_row.storage_path) > 0
     and pg_catalog.to_regclass('storage.objects') is not null
  then
    v_base := v_row.storage_path || '/';
    if exists (
      select 1
        from storage.objects o
       where o.bucket_id = 'hotel-media'
         and pg_catalog.starts_with(o.name, v_base)
    ) then
      if not exists (
        select 1 from storage.buckets b where b.id = 'hotel-media-private'
      ) then
        return false;
      end if;
      begin
        update storage.objects o
           set bucket_id = 'hotel-media-private'
         where o.bucket_id = 'hotel-media'
           and o.name in (
             v_row.storage_path || '/w480.webp',
             v_row.storage_path || '/w1280.webp'
           );
        if exists (
          select 1
            from storage.objects o
           where o.bucket_id = 'hotel-media'
             and pg_catalog.starts_with(o.name, v_base)
        ) then
          raise exception 'hotel media object stayed public';
        end if;
      exception
        when others then
          return false;
      end;
      v_bucket := 'hotel-media-private';
    end if;
  end if;

  update public.hotel_media
     set status = 'hidden',
         storage_bucket = v_bucket
   where id = p_id
     and status = 'active';
  return true;
end;
$$;

comment on function public.hide_hotel_media(uuid) is
  'D189 takedown. Admin or editor only. Moves the Forbes w480 and w1280 objects into hotel-media-private. Returns false and leaves the row unchanged when a public object under that path remains. Does not delete the object. SECURITY DEFINER. search_path is empty.';

revoke all on function public.hide_hotel_media(uuid) from public, anon;
grant execute on function public.hide_hotel_media(uuid) to authenticated, service_role;
