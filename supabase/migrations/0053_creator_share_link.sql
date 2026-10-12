-- 0053 — D09 creator profile share link for hotels (D089–D091, Accepted).
--
-- Migration number: 0053. 0051 is E04 on main (PR #62) and is not edited.
-- 0052 is D08 and is not edited. This migration does not send mail,
-- create a hotel account, record a view, or set public_profile_enabled.
--
-- The hotel read is one creator-controlled link. The raw token is returned
-- once, from create or rotate, and is not stored. The table keeps a SHA-256
-- digest. Revoke and rotate set revoked_at immediately. An optional
-- expires_at is the only other way a stored digest stops working. Invalid,
-- revoked, rotated, and expired tokens all return the same not_found object.
--
-- Anon has no privilege on the new tables and no new privilege on
-- creator_profiles, collaborations, deliverables, compensation, opt-ins, or
-- mail. The public read is one SECURITY DEFINER function. It does not
-- consult public_profile_enabled.

-- ---------------------------------------------------------------------------
-- pgcrypto lives in extensions on hosted Supabase and in public in the test
-- harness. Pin a schema-qualified wrapper so the share functions can keep
-- search_path empty.
-- ---------------------------------------------------------------------------
do $share_crypto$
declare
  v_digest text;
  v_random text;
begin
  select n.nspname || '.digest'
    into v_digest
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where p.proname = 'digest'
     and pg_get_function_identity_arguments(p.oid) = 'bytea, text'
     and n.nspname in ('extensions', 'public')
   order by case n.nspname when 'extensions' then 0 else 1 end
   limit 1;

  select n.nspname || '.gen_random_bytes'
    into v_random
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where p.proname = 'gen_random_bytes'
     and pg_get_function_identity_arguments(p.oid) = 'integer'
     and n.nspname in ('extensions', 'public')
   order by case n.nspname when 'extensions' then 0 else 1 end
   limit 1;

  if v_digest is null or v_random is null then
    raise exception 'pgcrypto digest(bytea, text) and gen_random_bytes(integer) are required';
  end if;

  execute format($fn$
    create or replace function public.creator_share_token_hash(p_token text)
    returns bytea
    language sql
    immutable
    security invoker
    set search_path = ''
    as $body$
      select %s(convert_to(coalesce(p_token, ''), 'UTF8'), 'sha256');
    $body$
  $fn$, v_digest);

  execute format($fn$
    create or replace function public.creator_share_random_token()
    returns text
    language sql
    volatile
    security invoker
    set search_path = ''
    as $body$
      select encode(%s(32), 'hex');
    $body$
  $fn$, v_random);
end
$share_crypto$;

comment on function public.creator_share_token_hash(text) is
  'D089. SHA-256 of a share token. Not granted to anon or authenticated. The raw token is not stored.';

comment on function public.creator_share_random_token() is
  'D089. 32 random bytes, hex-encoded (64 characters). Not granted to anon or authenticated.';

revoke all on function public.creator_share_token_hash(text) from public, anon, authenticated, service_role;
revoke all on function public.creator_share_random_token() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Close the field keys D086 left open. D090 is the allow-list.
-- ---------------------------------------------------------------------------
alter table public.creator_profile_field_opt_ins
  drop constraint creator_profile_field_opt_ins_key_shape;

alter table public.creator_profile_field_opt_ins
  add constraint creator_profile_field_opt_ins_key_allowlist
  check (field_key in (
    'bio',
    'niche',
    'social_links',
    'audience',
    'past_collaborations',
    'content_examples',
    'compensation'
  ));

comment on table public.creator_profile_field_opt_ins is
  'D090 Accepted. Creator-owned per-field opt-in for the hotel share link. Private by default. No row, opted_in false, or revoked_at set means the field is not shared. field_key is the D090 allow-list.';

comment on column public.creator_profile_field_opt_ins.field_key is
  'D090 allow-list: bio, niche, social_links, audience, past_collaborations, content_examples, compensation.';

-- ---------------------------------------------------------------------------
-- Self-reported audience. A separate table so public_profile_enabled cannot
-- expose it. Null is unknown, never zero.
-- ---------------------------------------------------------------------------
create table public.creator_self_reported_audience (
  creator_id uuid primary key references public.creator_profiles(id) on delete cascade,
  follower_count bigint,
  engagement text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint creator_self_reported_audience_followers_check check (
    follower_count is null
    or (follower_count >= 0 and follower_count <= 9007199254740991)
  ),
  constraint creator_self_reported_audience_engagement_check check (
    engagement is null
    or (
      char_length(engagement) between 1 and 40
      and engagement = btrim(engagement)
    )
  )
);

comment on table public.creator_self_reported_audience is
  'D090. Followers and engagement as entered by the creator. Not verified. Null is unknown, not zero. Anon has no privilege.';

comment on column public.creator_self_reported_audience.follower_count is
  'Self-reported follower count. Null means unknown. Zero is a number the creator entered.';

comment on column public.creator_self_reported_audience.engagement is
  'Self-reported engagement, in the creator''s own words. Null means unknown. Not parsed into a rate.';

create trigger creator_self_reported_audience_set_updated_at
  before update on public.creator_self_reported_audience
  for each row execute function public.set_updated_at();

alter table public.creator_self_reported_audience enable row level security;

create policy creator_self_reported_audience_all
  on public.creator_self_reported_audience
  for all
  using (creator_id = public.current_creator_id())
  with check (creator_id = public.current_creator_id());

revoke all on table public.creator_self_reported_audience from public, anon, authenticated;
grant select, insert, update, delete on table public.creator_self_reported_audience to authenticated;
grant select, insert, update, delete on table public.creator_self_reported_audience to service_role;

-- ---------------------------------------------------------------------------
-- One share link. The digest is the only copy of the token.
-- ---------------------------------------------------------------------------
create table public.creator_share_links (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  token_hash bytea not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  constraint creator_share_links_hash_len check (octet_length(token_hash) = 32),
  constraint creator_share_links_expiry_after_create check (
    expires_at is null or expires_at > created_at
  )
);

comment on table public.creator_share_links is
  'D089 Accepted. One creator-controlled hotel share link. Stores a SHA-256 digest, never the raw token. Revoked and expired digests reveal nothing.';

comment on column public.creator_share_links.token_hash is
  'SHA-256 of the hex token. The raw token is returned only from create or rotate and is not stored.';

comment on column public.creator_share_links.expires_at is
  'Optional. Null means the link does not expire. A past instant is not usable. It is not a revocation.';

comment on column public.creator_share_links.revoked_at is
  'When set, the digest stops working immediately, including after rotate.';

create unique index creator_share_links_token_hash_uidx
  on public.creator_share_links (token_hash);

create unique index creator_share_links_one_active
  on public.creator_share_links (creator_id)
  where revoked_at is null;

alter table public.creator_share_links enable row level security;

create policy creator_share_links_select
  on public.creator_share_links
  for select
  using (creator_id = public.current_creator_id());

revoke all on table public.creator_share_links from public, anon, authenticated;
grant select on table public.creator_share_links to authenticated;
grant select, insert, update, delete on table public.creator_share_links to service_role;

-- ---------------------------------------------------------------------------
-- Explicit per-row marks. No row means the collaboration or example is not
-- shared, even when the field opt-in is on.
-- ---------------------------------------------------------------------------
alter table public.collaborations
  add constraint collaborations_id_creator_key unique (id, creator_id);

alter table public.collaboration_deliverables
  add constraint collaboration_deliverables_id_creator_key unique (id, creator_id);

create table public.creator_collaboration_share_marks (
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  collaboration_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (creator_id, collaboration_id),
  foreign key (collaboration_id, creator_id)
    references public.collaborations (id, creator_id)
    on delete cascade
);

comment on table public.creator_collaboration_share_marks is
  'D090. The creator explicitly marked this past collaboration shareable. Absence means it is not on the hotel link.';

create table public.creator_deliverable_share_marks (
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  deliverable_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (creator_id, deliverable_id),
  foreign key (deliverable_id, creator_id)
    references public.collaboration_deliverables (id, creator_id)
    on delete cascade
);

comment on table public.creator_deliverable_share_marks is
  'D090. The creator explicitly marked this deliverable shareable. The public read still requires an https proof link.';

create or replace function public.creator_collaboration_share_marks_past_only()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1
      from public.collaborations c
     where c.id = new.collaboration_id
       and c.creator_id = new.creator_id
       and c.status in ('completed', 'cancelled')
  ) then
    raise exception 'share mark requires a completed or cancelled collaboration'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.creator_collaboration_share_marks_past_only() is
  'D090. A share mark cannot point at an agreed, scheduled, or active collaboration.';

create trigger creator_collaboration_share_marks_past_only
  before insert or update on public.creator_collaboration_share_marks
  for each row execute function public.creator_collaboration_share_marks_past_only();

alter table public.creator_collaboration_share_marks enable row level security;
alter table public.creator_deliverable_share_marks enable row level security;

create policy creator_collaboration_share_marks_all
  on public.creator_collaboration_share_marks
  for all
  using (creator_id = public.current_creator_id())
  with check (creator_id = public.current_creator_id());

create policy creator_deliverable_share_marks_all
  on public.creator_deliverable_share_marks
  for all
  using (creator_id = public.current_creator_id())
  with check (creator_id = public.current_creator_id());

revoke all on table public.creator_collaboration_share_marks from public, anon, authenticated;
revoke all on table public.creator_deliverable_share_marks from public, anon, authenticated;
grant select, insert, update, delete on table public.creator_collaboration_share_marks to authenticated, service_role;
grant select, insert, update, delete on table public.creator_deliverable_share_marks to authenticated, service_role;

revoke all on function public.creator_collaboration_share_marks_past_only() from public, anon;
grant execute on function public.creator_collaboration_share_marks_past_only() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Owner writes. Each one derives the creator from the session. None of them
-- accepts another creator's id.
-- ---------------------------------------------------------------------------
create or replace function public.create_creator_share_link(p_expires_at timestamptz default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_token text;
  v_id uuid;
begin
  v_creator := public.current_creator_id();
  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if p_expires_at is not null and p_expires_at <= clock_timestamp() then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  perform 1 from public.creator_profiles where id = v_creator for update;

  if exists (
    select 1 from public.creator_share_links
     where creator_id = v_creator and revoked_at is null
  ) then
    return jsonb_build_object('result', 'active_link_exists');
  end if;

  v_token := public.creator_share_random_token();
  insert into public.creator_share_links (creator_id, token_hash, expires_at)
  values (v_creator, public.creator_share_token_hash(v_token), p_expires_at)
  returning id into v_id;

  return jsonb_build_object(
    'result', 'created',
    'token', v_token,
    'link_id', v_id,
    'expires_at', p_expires_at
  );
end;
$$;

comment on function public.create_creator_share_link(timestamptz) is
  'D089. Issues one active share link for the caller. Returns the raw token once. Stores only its SHA-256. Fails when an unrevoked link already exists.';

create or replace function public.rotate_creator_share_link(p_expires_at timestamptz default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_old uuid;
  v_token text;
  v_id uuid;
begin
  v_creator := public.current_creator_id();
  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if p_expires_at is not null and p_expires_at <= clock_timestamp() then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  perform 1 from public.creator_profiles where id = v_creator for update;

  update public.creator_share_links
     set revoked_at = clock_timestamp()
   where creator_id = v_creator
     and revoked_at is null
  returning id into v_old;

  if v_old is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  v_token := public.creator_share_random_token();
  insert into public.creator_share_links (creator_id, token_hash, expires_at)
  values (v_creator, public.creator_share_token_hash(v_token), p_expires_at)
  returning id into v_id;

  return jsonb_build_object(
    'result', 'rotated',
    'token', v_token,
    'link_id', v_id,
    'expires_at', p_expires_at
  );
end;
$$;

comment on function public.rotate_creator_share_link(timestamptz) is
  'D089. Revokes the caller''s active link and issues a new token in the same transaction. The previous digest stops working immediately.';

create or replace function public.revoke_creator_share_link()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_id uuid;
begin
  v_creator := public.current_creator_id();
  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  perform 1 from public.creator_profiles where id = v_creator for update;

  update public.creator_share_links
     set revoked_at = clock_timestamp()
   where creator_id = v_creator
     and revoked_at is null
  returning id into v_id;

  if v_id is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  return jsonb_build_object('result', 'revoked');
end;
$$;

comment on function public.revoke_creator_share_link() is
  'D089. Revokes the caller''s active link immediately. Does not return the token.';

create or replace function public.read_own_creator_share_link()
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_row public.creator_share_links%rowtype;
begin
  v_creator := public.current_creator_id();
  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select *
    into v_row
    from public.creator_share_links
   where creator_id = v_creator
   order by created_at desc, id desc
   limit 1;

  if not found then
    return jsonb_build_object('result', 'none');
  end if;

  return jsonb_build_object(
    'result', 'ok',
    'link_id', v_row.id,
    'created_at', v_row.created_at,
    'expires_at', v_row.expires_at,
    'revoked_at', v_row.revoked_at,
    'usable', (
      v_row.revoked_at is null
      and (v_row.expires_at is null or v_row.expires_at > clock_timestamp())
    )
  );
end;
$$;

comment on function public.read_own_creator_share_link() is
  'D089. The caller''s latest link state. Does not return the token or the digest. A missing profile is not_found. No link is none.';

create or replace function public.set_creator_self_reported_audience(
  p_follower_count bigint,
  p_engagement text
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_engagement text;
begin
  v_creator := public.current_creator_id();
  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if p_follower_count is not null
     and (p_follower_count < 0 or p_follower_count > 9007199254740991) then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  v_engagement := nullif(btrim(coalesce(p_engagement, '')), '');
  if v_engagement is not null and char_length(v_engagement) > 40 then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  insert into public.creator_self_reported_audience (creator_id, follower_count, engagement)
  values (v_creator, p_follower_count, v_engagement)
  on conflict (creator_id) do update
    set follower_count = excluded.follower_count,
        engagement = excluded.engagement;

  return jsonb_build_object('result', 'saved');
end;
$$;

comment on function public.set_creator_self_reported_audience(bigint, text) is
  'D090. Saves the caller''s self-reported followers and engagement. Null stays null. It does not opt the audience field in.';

create or replace function public.set_creator_profile_field_opt_ins(p_opted_in jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_keys text[];
  v_expected text[] := array[
    'audience',
    'bio',
    'compensation',
    'content_examples',
    'niche',
    'past_collaborations',
    'social_links'
  ];
  v_key text;
  v_on boolean;
begin
  v_creator := public.current_creator_id();
  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if p_opted_in is null or jsonb_typeof(p_opted_in) <> 'object' then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select coalesce(array_agg(k order by k), '{}'::text[])
    into v_keys
    from jsonb_object_keys(p_opted_in) as k;

  if v_keys is distinct from v_expected then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  foreach v_key in array v_expected loop
    if jsonb_typeof(p_opted_in -> v_key) is distinct from 'boolean' then
      return jsonb_build_object('result', 'invalid_input');
    end if;
  end loop;

  perform 1 from public.creator_profiles where id = v_creator for update;

  foreach v_key in array v_expected loop
    v_on := (p_opted_in ->> v_key) = 'true';
    insert into public.creator_profile_field_opt_ins (creator_id, field_key, opted_in, revoked_at)
    values (
      v_creator,
      v_key,
      v_on,
      case when v_on then null else clock_timestamp() end
    )
    on conflict (creator_id, field_key) do update
      set opted_in = excluded.opted_in,
          revoked_at = excluded.revoked_at;
  end loop;

  return jsonb_build_object('result', 'saved');
end;
$$;

comment on function public.set_creator_profile_field_opt_ins(jsonb) is
  'D090. Sets every allow-listed field for the caller in one transaction. A false value sets revoked_at. An unknown key writes nothing.';

create or replace function public.set_collaboration_share_mark(
  p_collaboration_id uuid,
  p_shareable boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_status text;
begin
  v_creator := public.current_creator_id();
  if v_creator is null or p_collaboration_id is null or p_shareable is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select c.status
    into v_status
    from public.collaborations c
   where c.id = p_collaboration_id
     and c.creator_id = v_creator;

  if v_status is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_status not in ('completed', 'cancelled') then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  if p_shareable then
    insert into public.creator_collaboration_share_marks (creator_id, collaboration_id)
    values (v_creator, p_collaboration_id)
    on conflict (creator_id, collaboration_id) do nothing;
  else
    delete from public.creator_collaboration_share_marks
     where creator_id = v_creator
       and collaboration_id = p_collaboration_id;
  end if;

  return jsonb_build_object('result', 'saved');
exception
  when foreign_key_violation then
    return jsonb_build_object('result', 'not_found');
end;
$$;

comment on function public.set_collaboration_share_mark(uuid, boolean) is
  'D090. Marks or unmarks the caller''s own completed or cancelled collaboration. Another creator''s id is not_found.';

create or replace function public.set_deliverable_share_mark(
  p_deliverable_id uuid,
  p_shareable boolean
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_found uuid;
begin
  v_creator := public.current_creator_id();
  if v_creator is null or p_deliverable_id is null or p_shareable is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select d.id
    into v_found
    from public.collaboration_deliverables d
   where d.id = p_deliverable_id
     and d.creator_id = v_creator;

  if v_found is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  if p_shareable then
    insert into public.creator_deliverable_share_marks (creator_id, deliverable_id)
    values (v_creator, p_deliverable_id)
    on conflict (creator_id, deliverable_id) do nothing;
  else
    delete from public.creator_deliverable_share_marks
     where creator_id = v_creator
       and deliverable_id = p_deliverable_id;
  end if;

  return jsonb_build_object('result', 'saved');
exception
  when foreign_key_violation then
    return jsonb_build_object('result', 'not_found');
end;
$$;

comment on function public.set_deliverable_share_mark(uuid, boolean) is
  'D090. Marks or unmarks the caller''s own deliverable. The public read still omits a row with no https proof link.';

-- ---------------------------------------------------------------------------
-- Public read. Anon may execute this function and nothing else added here.
-- The lookup hashes the token first, then compares that fixed 32-byte digest.
-- Invalid, revoked, rotated, and expired inputs return the same object.
-- ---------------------------------------------------------------------------
create or replace function public.read_creator_share_profile(p_token text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_hash bytea;
  v_creator uuid;
  v_revoked timestamptz;
  v_expires timestamptz;
  v_bio text;
  v_niches text[];
  v_instagram_url text;
  v_instagram_handle text;
  v_tiktok_url text;
  v_tiktok_handle text;
  v_youtube_url text;
  v_website_url text;
  v_followers bigint;
  v_engagement text;
  v_profile jsonb := '{}'::jsonb;
  v_past boolean;
  v_examples boolean;
  v_compensation boolean;
  v_rows jsonb;
begin
  -- A malformed token is not_found. Hash a fixed stand-in so this branch
  -- still runs the digest. Do not truncate the input into a real token.
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    perform public.creator_share_token_hash('creator-share-link-malformed');
    return jsonb_build_object('result', 'not_found');
  end if;

  v_hash := public.creator_share_token_hash(p_token);

  select l.creator_id, l.revoked_at, l.expires_at
    into v_creator, v_revoked, v_expires
    from public.creator_share_links l
   where l.token_hash = v_hash;

  if v_creator is null
     or v_revoked is not null
     or (v_expires is not null and v_expires <= clock_timestamp()) then
    return jsonb_build_object('result', 'not_found');
  end if;

  select cp.bio,
         cp.creator_niches,
         cp.instagram_url,
         cp.instagram_handle,
         cp.tiktok_url,
         cp.tiktok_handle,
         cp.youtube_url,
         cp.website_url
    into v_bio,
         v_niches,
         v_instagram_url,
         v_instagram_handle,
         v_tiktok_url,
         v_tiktok_handle,
         v_youtube_url,
         v_website_url
    from public.creator_profiles cp
   where cp.id = v_creator;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- A missing audience row is unknown, not a failed profile read. Do not
  -- treat FOUND from this select as the profile's existence.
  select a.follower_count, a.engagement
    into v_followers, v_engagement
    from public.creator_self_reported_audience a
   where a.creator_id = v_creator;

  v_past := exists (
    select 1 from public.creator_profile_field_opt_ins o
     where o.creator_id = v_creator
       and o.field_key = 'past_collaborations'
       and o.opted_in
       and o.revoked_at is null
  );
  v_examples := exists (
    select 1 from public.creator_profile_field_opt_ins o
     where o.creator_id = v_creator
       and o.field_key = 'content_examples'
       and o.opted_in
       and o.revoked_at is null
  );
  v_compensation := exists (
    select 1 from public.creator_profile_field_opt_ins o
     where o.creator_id = v_creator
       and o.field_key = 'compensation'
       and o.opted_in
       and o.revoked_at is null
  );

  if exists (
    select 1 from public.creator_profile_field_opt_ins o
     where o.creator_id = v_creator
       and o.field_key = 'bio'
       and o.opted_in
       and o.revoked_at is null
  ) then
    v_profile := v_profile || jsonb_build_object('bio', v_bio);
  end if;

  if exists (
    select 1 from public.creator_profile_field_opt_ins o
     where o.creator_id = v_creator
       and o.field_key = 'niche'
       and o.opted_in
       and o.revoked_at is null
  ) then
    v_profile := v_profile || jsonb_build_object('niche', to_jsonb(coalesce(v_niches, '{}'::text[])));
  end if;

  if exists (
    select 1 from public.creator_profile_field_opt_ins o
     where o.creator_id = v_creator
       and o.field_key = 'social_links'
       and o.opted_in
       and o.revoked_at is null
  ) then
    v_profile := v_profile || jsonb_build_object(
      'social_links', jsonb_build_object(
        'instagram_url', v_instagram_url,
        'instagram_handle', v_instagram_handle,
        'tiktok_url', v_tiktok_url,
        'tiktok_handle', v_tiktok_handle,
        'youtube_url', v_youtube_url,
        'website_url', v_website_url
      )
    );
  end if;

  if exists (
    select 1 from public.creator_profile_field_opt_ins o
     where o.creator_id = v_creator
       and o.field_key = 'audience'
       and o.opted_in
       and o.revoked_at is null
  ) then
    v_profile := v_profile || jsonb_build_object(
      'audience', jsonb_build_object(
        'followers', v_followers,
        'engagement', v_engagement,
        'attribution', 'self_reported'
      )
    );
  end if;

  if v_past then
    select coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'hotel_name', h.name,
                 'status', c.status,
                 'collaboration_type', c.collaboration_type,
                 'start_date', c.start_date,
                 'end_date', c.end_date
               )
               || case
                    when v_compensation then jsonb_build_object(
                      'compensation',
                      coalesce(
                        (
                          select jsonb_strip_nulls(jsonb_build_object(
                            'structure', comp.structure,
                            'cash_amount_minor', comp.cash_amount_minor,
                            'cash_currency', comp.cash_currency,
                            'in_kind_description', comp.in_kind_description
                          ))
                            from public.collaboration_agreed_compensations comp
                           where comp.collaboration_id = c.id
                             and comp.creator_id = c.creator_id
                        ),
                        jsonb_build_object('structure', 'unknown')
                      )
                    )
                    else '{}'::jsonb
                  end
               order by c.end_date desc nulls last, c.created_at desc, c.id desc
             ),
             '[]'::jsonb
           )
      into v_rows
      from public.collaborations c
      join public.hotels h on h.id = c.hotel_id
      join public.creator_collaboration_share_marks m
        on m.collaboration_id = c.id
       and m.creator_id = c.creator_id
     where c.creator_id = v_creator
       and c.status in ('completed', 'cancelled');

    v_profile := v_profile || jsonb_build_object('past_collaborations', v_rows);
  end if;

  if v_examples then
    select coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'deliverable_type', d.deliverable_type,
                 'platform', d.platform,
                 'proof_url', d.proof_url
               )
               order by d.created_at desc, d.id desc
             ),
             '[]'::jsonb
           )
      into v_rows
      from public.collaboration_deliverables d
      join public.creator_deliverable_share_marks m
        on m.deliverable_id = d.id
       and m.creator_id = d.creator_id
     where d.creator_id = v_creator
       and d.proof_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]]*)?$';

    v_profile := v_profile || jsonb_build_object('content_examples', v_rows);
  end if;

  return jsonb_build_object('result', 'ok', 'profile', v_profile);
end;
$$;

comment on function public.read_creator_share_profile(text) is
  'D091 Accepted. Public read of one share link. SECURITY DEFINER, search_path empty. Returns only D090 fields that are opted in, and only marked past collaborations and proof-backed examples. Invalid, revoked, rotated, and expired tokens return not_found. Null audience and compensation are unknown, never zero. Audience attribution is self_reported.';

revoke all on function
  public.create_creator_share_link(timestamptz),
  public.rotate_creator_share_link(timestamptz),
  public.revoke_creator_share_link(),
  public.read_own_creator_share_link(),
  public.set_creator_self_reported_audience(bigint, text),
  public.set_creator_profile_field_opt_ins(jsonb),
  public.set_collaboration_share_mark(uuid, boolean),
  public.set_deliverable_share_mark(uuid, boolean),
  public.read_creator_share_profile(text)
from public, anon, authenticated, service_role;

grant execute on function
  public.create_creator_share_link(timestamptz),
  public.rotate_creator_share_link(timestamptz),
  public.revoke_creator_share_link(),
  public.read_own_creator_share_link(),
  public.set_creator_self_reported_audience(bigint, text),
  public.set_creator_profile_field_opt_ins(jsonb),
  public.set_collaboration_share_mark(uuid, boolean),
  public.set_deliverable_share_mark(uuid, boolean)
to authenticated, service_role;

grant execute on function public.read_creator_share_profile(text)
  to anon, authenticated, service_role;
