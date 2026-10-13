-- 0074 — G03 travel portfolio reads and the share-link addition (D125).
--
-- 0053 is not edited. read_creator_share_profile is replaced here so a hotel
-- with the existing link also sees portfolio entries the creator published.
-- D090 fields are unchanged. The key is omitted when there is nothing to show.
-- Owner writes take no user id. The creator is auth.uid() via current_creator_id().

-- ---------------------------------------------------------------------------
-- Owner read. Security invoker, so RLS applies. A missing profile is JSON
-- null, not an empty list. A successful read of no rows is an empty array.
-- Gmail suggestion rows are not selected.
-- ---------------------------------------------------------------------------
create or replace function public.read_own_creator_portfolio()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_creator uuid;
  v_template text;
  v_suggestions jsonb;
  v_published jsonb;
  v_dismissed jsonb;
  v_withheld jsonb;
begin
  v_creator := public.current_creator_id();
  if v_creator is null then
    return null;
  end if;

  select s.template_key
    into v_template
    from public.creator_portfolio_settings s
   where s.creator_id = v_creator;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'collaboration_id', c.id,
               'hotel_name', h.name,
               'destination_name', d.name,
               'collaboration_type', c.collaboration_type,
               'status', c.status,
               'start_date', c.start_date,
               'end_date', c.end_date
             )
             order by c.end_date desc nulls last, c.start_date desc nulls last, h.name asc, c.id asc
           ),
           '[]'::jsonb
         )
    into v_suggestions
    from public.collaborations c
    join public.hotels h on h.id = c.hotel_id
    join public.destinations d on d.id = h.destination_id
   where c.creator_id = v_creator
     and c.status in ('agreed', 'scheduled', 'active', 'completed')
     and not exists (
       select 1
         from public.creator_portfolio_entries e
        where e.collaboration_id = c.id
          and e.creator_id = c.creator_id
     );

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'collaboration_id', c.id,
               'hotel_name', h.name,
               'destination_name', d.name,
               'collaboration_type', c.collaboration_type,
               'status', c.status,
               'start_date', c.start_date,
               'end_date', c.end_date
             )
             order by c.end_date desc nulls last, c.start_date desc nulls last, h.name asc, c.id asc
           ),
           '[]'::jsonb
         )
    into v_published
    from public.creator_portfolio_entries e
    join public.collaborations c
      on c.id = e.collaboration_id
     and c.creator_id = e.creator_id
    join public.hotels h on h.id = c.hotel_id
    join public.destinations d on d.id = h.destination_id
   where e.creator_id = v_creator
     and e.decision = 'published'
     and c.status in ('agreed', 'scheduled', 'active', 'completed');

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'collaboration_id', c.id,
               'hotel_name', h.name,
               'destination_name', d.name,
               'collaboration_type', c.collaboration_type,
               'status', c.status,
               'start_date', c.start_date,
               'end_date', c.end_date
             )
             order by c.end_date desc nulls last, c.start_date desc nulls last, h.name asc, c.id asc
           ),
           '[]'::jsonb
         )
    into v_dismissed
    from public.creator_portfolio_entries e
    join public.collaborations c
      on c.id = e.collaboration_id
     and c.creator_id = e.creator_id
    join public.hotels h on h.id = c.hotel_id
    join public.destinations d on d.id = h.destination_id
   where e.creator_id = v_creator
     and e.decision = 'dismissed'
     and c.status in ('agreed', 'scheduled', 'active', 'completed');

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'collaboration_id', c.id,
               'hotel_name', h.name,
               'destination_name', d.name,
               'collaboration_type', c.collaboration_type,
               'status', c.status,
               'start_date', c.start_date,
               'end_date', c.end_date,
               'decision', e.decision
             )
             order by c.end_date desc nulls last, c.start_date desc nulls last, h.name asc, c.id asc
           ),
           '[]'::jsonb
         )
    into v_withheld
    from public.creator_portfolio_entries e
    join public.collaborations c
      on c.id = e.collaboration_id
     and c.creator_id = e.creator_id
    join public.hotels h on h.id = c.hotel_id
    join public.destinations d on d.id = h.destination_id
   where e.creator_id = v_creator
     and e.decision in ('published', 'dismissed')
     and c.status = 'cancelled';

  return jsonb_build_object(
    'template', v_template,
    'suggestions', v_suggestions,
    'published', v_published,
    'dismissed', v_dismissed,
    'withheld', v_withheld
  );
end;
$$;

comment on function public.read_own_creator_portfolio() is
  'D125. Caller-only portfolio. JSON null when the caller has no profile. Empty arrays are a successful read. Gmail detections are not selected. Compensation and contacts are not selected.';

revoke all on function public.read_own_creator_portfolio() from public, anon;
grant execute on function public.read_own_creator_portfolio() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Layout. One of three travel templates. The value changes arrangement only.
-- ---------------------------------------------------------------------------
create or replace function public.set_creator_portfolio_template(p_template text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_template text;
begin
  v_creator := public.current_creator_id();
  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  v_template := nullif(btrim(coalesce(p_template, '')), '');
  if v_template is null or v_template not in ('journey', 'destinations', 'highlights') then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  insert into public.creator_portfolio_settings (creator_id, template_key)
  values (v_creator, v_template)
  on conflict (creator_id) do update
    set template_key = excluded.template_key,
        updated_at = pg_catalog.now();

  return jsonb_build_object('result', 'saved', 'template', v_template);
end;
$$;

comment on function public.set_creator_portfolio_template(text) is
  'D125. Stores the caller''s layout. The creator id is auth.uid() via current_creator_id(). An unknown layout writes nothing.';

-- ---------------------------------------------------------------------------
-- Approve one confirmed collaboration for the share link.
-- ---------------------------------------------------------------------------
create or replace function public.publish_creator_portfolio_entry(p_collaboration_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_owner uuid;
  v_status text;
begin
  if p_collaboration_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  v_creator := public.current_creator_id();
  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select c.creator_id, c.status
    into v_owner, v_status
    from public.collaborations c
   where c.id = p_collaboration_id
   for update;

  if v_owner is null or v_owner is distinct from v_creator then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_status not in ('agreed', 'scheduled', 'active', 'completed') then
    return jsonb_build_object('result', 'not_confirmed');
  end if;

  insert into public.creator_portfolio_entries (creator_id, collaboration_id, decision)
  values (v_creator, p_collaboration_id, 'published')
  on conflict (creator_id, collaboration_id) do update
    set decision = 'published',
        updated_at = pg_catalog.now();

  return jsonb_build_object('result', 'published');
end;
$$;

comment on function public.publish_creator_portfolio_entry(uuid) is
  'D125. Publishes the caller''s confirmed collaboration. Another creator''s id is not_found and writes nothing. Cancelled is not_confirmed.';

create or replace function public.dismiss_creator_portfolio_entry(p_collaboration_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_owner uuid;
  v_status text;
begin
  if p_collaboration_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  v_creator := public.current_creator_id();
  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select c.creator_id, c.status
    into v_owner, v_status
    from public.collaborations c
   where c.id = p_collaboration_id
   for update;

  if v_owner is null or v_owner is distinct from v_creator then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_status not in ('agreed', 'scheduled', 'active', 'completed') then
    return jsonb_build_object('result', 'not_confirmed');
  end if;

  insert into public.creator_portfolio_entries (creator_id, collaboration_id, decision)
  values (v_creator, p_collaboration_id, 'dismissed')
  on conflict (creator_id, collaboration_id) do update
    set decision = 'dismissed',
        updated_at = pg_catalog.now();

  return jsonb_build_object('result', 'dismissed');
end;
$$;

comment on function public.dismiss_creator_portfolio_entry(uuid) is
  'D125. Dismisses the caller''s confirmed collaboration so it is not suggested and not public. Another creator''s id is not_found.';

create or replace function public.withdraw_creator_portfolio_entry(p_collaboration_id uuid)
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
  if p_collaboration_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  v_creator := public.current_creator_id();
  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  delete from public.creator_portfolio_entries e
   where e.creator_id = v_creator
     and e.collaboration_id = p_collaboration_id
  returning e.id into v_id;

  if v_id is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  return jsonb_build_object('result', 'withdrawn');
end;
$$;

comment on function public.withdraw_creator_portfolio_entry(uuid) is
  'D125. Removes the caller''s decision. A confirmed collaboration becomes a suggestion again. Another creator''s row is not deleted.';

revoke all on function
  public.set_creator_portfolio_template(text),
  public.publish_creator_portfolio_entry(uuid),
  public.dismiss_creator_portfolio_entry(uuid),
  public.withdraw_creator_portfolio_entry(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.set_creator_portfolio_template(text),
  public.publish_creator_portfolio_entry(uuid),
  public.dismiss_creator_portfolio_entry(uuid),
  public.withdraw_creator_portfolio_entry(uuid)
to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Public share read. D090 fields stay as they were. Portfolio is added only
-- when the creator picked a template and published at least one confirmed
-- collaboration. The new object has no compensation and no contact.
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
  v_template text;
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

  -- D125. Omitted unless the creator picked a layout and at least one
  -- published entry still points at a confirmed collaboration. Confirmed is
  -- agreed, scheduled, active, or completed. Cancelled is not confirmed.
  -- Compensation, contacts, notes, and private values are not selected.
  -- An empty set omits the key. It is not an empty list.
  select s.template_key
    into v_template
    from public.creator_portfolio_settings s
   where s.creator_id = v_creator;

  if v_template in ('journey', 'destinations', 'highlights') then
    select coalesce(
             jsonb_agg(
               jsonb_build_object(
                 'hotel_name', h.name,
                 'destination_name', d.name,
                 'collaboration_type', c.collaboration_type,
                 'status', c.status,
                 'start_date', c.start_date,
                 'end_date', c.end_date
               )
               order by
                 case when v_template = 'destinations' then d.name end asc nulls last,
                 c.end_date desc nulls last,
                 c.start_date desc nulls last,
                 h.name asc,
                 c.id asc
             ),
             '[]'::jsonb
           )
      into v_rows
      from public.creator_portfolio_entries e
      join public.collaborations c
        on c.id = e.collaboration_id
       and c.creator_id = e.creator_id
      join public.hotels h on h.id = c.hotel_id
      join public.destinations d on d.id = h.destination_id
     where e.creator_id = v_creator
       and e.decision = 'published'
       and c.status in ('agreed', 'scheduled', 'active', 'completed');

    if v_rows is not null and jsonb_array_length(v_rows) > 0 then
      v_profile := v_profile || jsonb_build_object(
        'portfolio', jsonb_build_object(
          'template', v_template,
          'entries', v_rows
        )
      );
    end if;
  end if;

  return jsonb_build_object('result', 'ok', 'profile', v_profile);
end;
$$;


comment on function public.read_creator_share_profile(text) is
  'D091 Accepted, plus D125 portfolio. Public read of one share link. SECURITY DEFINER, search_path empty. D090 fields are unchanged. Portfolio is added only when the creator picked a template and published a confirmed collaboration. That object has no compensation, contact, note, or private value. Invalid, revoked, rotated, and expired tokens return not_found. Null audience and compensation are unknown, never zero. An omitted portfolio key is not an empty list.';

revoke all on function public.read_creator_share_profile(text)
  from public, anon, authenticated, service_role;
grant execute on function public.read_creator_share_profile(text)
  to anon, authenticated, service_role;
