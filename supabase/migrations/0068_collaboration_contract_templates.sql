-- 0068 — G01 collaboration contract templates (D114).
--
-- Migration number: 0068. origin/main at branch time ended at 0062 (D108).
-- 0063–0067 were free on main. This block is D114.
--
-- A deal the caller owns, currently in status won, with its collaboration, can
-- become a private draft agreement. Three owner-private templates: hotel stay /
-- barter, paid, and usage rights. The draft is filled only from facts already
-- stored for that creator. A missing fact is the marker "[to be filled in]".
-- Nothing here sends a message, calls an e-sign vendor, or calls a model.
-- The text says it is not legal advice. private_value_* is not read.

-- ---------------------------------------------------------------------------
-- Same-owner keys. id is already unique; (id, creator_id) lets a contract
-- reference a deal, a collaboration, a trip, or a template only together with
-- the same creator.
-- ---------------------------------------------------------------------------
-- collaborations (id, creator_id) already exists as collaborations_id_creator_key (0053).

alter table public.pipeline_items
  add constraint pipeline_items_id_creator_key unique (id, creator_id);

alter table public.trips
  add constraint trips_id_creator_key unique (id, creator_id);

-- ---------------------------------------------------------------------------
-- Plain-text helpers. Not security definer. Clients cannot execute them.
-- ---------------------------------------------------------------------------
create or replace function public.contract_or_blank(p_value text)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select case
    when p_value is null or btrim(p_value) = '' then '[to be filled in]'
    else p_value
  end;
$$;

comment on function public.contract_or_blank(text) is
  'D114. Whitespace and null become the fill-in marker. Any other stored text is returned unchanged, including a recorded zero.';

create or replace function public.apply_contract_tokens(p_body text, p_tokens jsonb)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $$
declare
  v_out text := '';
  v_rest text := coalesce(p_body, '');
  v_start integer;
  v_end integer;
  v_key text;
  v_value text;
begin
  -- One left-to-right pass. A fact that itself contains {{...}} is copied
  -- into the output and is not scanned again, so one fact cannot overwrite
  -- another.
  loop
    v_start := position('{{' in v_rest);
    exit when v_start = 0;
    v_out := v_out || substring(v_rest from 1 for v_start - 1);
    v_rest := substring(v_rest from v_start + 2);
    v_end := position('}}' in v_rest);
    if v_end = 0 then
      v_out := v_out || '{{' || v_rest;
      v_rest := '';
      exit;
    end if;
    v_key := substring(v_rest from 1 for v_end - 1);
    v_rest := substring(v_rest from v_end + 2);
    if p_tokens is null or jsonb_typeof(p_tokens) <> 'object' or not (p_tokens ? v_key) then
      v_out := v_out || '{{' || v_key || '}}';
    else
      v_value := p_tokens ->> v_key;
      v_out := v_out || coalesce(v_value, '');
    end if;
  end loop;
  return v_out || v_rest;
end;
$$;

comment on function public.apply_contract_tokens(text, jsonb) is
  'D114. Replaces known {{tokens}} once. A missing key is left as written. A JSON null value becomes an empty string and is not a guessed fact.';

create or replace function public.contract_starter_body(p_kind text)
returns text
language plpgsql
immutable
security invoker
set search_path = ''
as $fn$
declare
  v_notice text := $notice$This template is not legal advice and it is not a signed contract. It does not create a legal obligation by itself. Check every line against what you and the hotel actually agreed. A line that says "[to be filled in]" means that fact was not recorded. This template does not add an amount, a date, an audience number, or a legal term.$notice$;
  v_facts text := $facts$Creator: {{creator_name}}
Home: {{creator_home}}
Languages: {{creator_languages}}
Instagram: {{creator_instagram}}
TikTok: {{creator_tiktok}}
YouTube: {{creator_youtube}}
Website: {{creator_website}}
Self-reported followers: {{audience_followers}}
Self-reported engagement: {{audience_engagement}}

Hotel: {{hotel_name}}
Destination: {{hotel_destination}}
Country: {{hotel_country}}
Address: {{hotel_address}}

Trip: {{trip_name}}
Trip start: {{trip_start}}
Trip end: {{trip_end}}

Collaboration type: {{collaboration_type}}
Collaboration start: {{collaboration_start}}
Collaboration end: {{collaboration_end}}

Compensation recorded on the deal:
{{compensation}}

Deliverables recorded on the deal:
{{deliverables}}

The people named above still have to agree before this draft is a contract between them.$facts$;
begin
  if p_kind = 'hotel_stay_barter' then
    return v_notice || E'\n\n' || $stay$Hotel stay / barter
This draft is for a stay or other barter. The in-kind description and any cash amount are copied from the compensation recorded on this deal. When that record is missing, the compensation line stays "[to be filled in]". No rate is added here.$stay$ || E'\n\n' || v_facts;
  elsif p_kind = 'paid' then
    return v_notice || E'\n\n' || $paid$Paid collaboration
The cash figure below is copied from the compensation recorded on this deal. When that record has no cash amount, the compensation line stays "[to be filled in]" and no fee is added here.$paid$ || E'\n\n' || v_facts;
  elsif p_kind = 'usage_rights' then
    return v_notice || E'\n\n' || $usage$Usage rights
This draft is about use of the deliverables recorded below. Territory, duration, and exclusivity are not stored on the deal.

Where the content may be used: [to be filled in]
How long that use lasts: [to be filled in]
Exclusivity: [to be filled in]

No fee is added by this template.$usage$ || E'\n\n' || v_facts;
  end if;
  return null;
end;
$fn$;

comment on function public.contract_starter_body(text) is
  'D114 starter text for one template kind. Tokens are filled later from stored facts. Unknown kinds return null.';

revoke all on function public.contract_or_blank(text) from public, anon, authenticated;
revoke all on function public.apply_contract_tokens(text, jsonb) from public, anon, authenticated;
revoke all on function public.contract_starter_body(text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Owner-private templates and drafts.
-- ---------------------------------------------------------------------------
create table public.contract_templates (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  kind text not null check (kind in ('hotel_stay_barter', 'paid', 'usage_rights')),
  title text not null,
  body text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint contract_templates_kind_uidx unique (creator_id, kind),
  constraint contract_templates_id_creator_key unique (id, creator_id),
  constraint contract_templates_title_shape check (
    char_length(title) between 1 and 200
    and title = btrim(title)
  ),
  constraint contract_templates_body_shape check (
    char_length(body) between 1 and 50000
    and position('This template is not legal advice' in body) > 0
  )
);

comment on table public.contract_templates is
  'D114. One private starter per creator and kind. Another creator cannot read or reference it. The body says the template is not legal advice.';

create index contract_templates_creator_idx
  on public.contract_templates (creator_id);

create trigger contract_templates_set_updated_at
  before update on public.contract_templates
  for each row execute function public.set_updated_at();

create table public.collaboration_contracts (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  template_id uuid not null,
  collaboration_id uuid not null,
  pipeline_item_id uuid not null,
  trip_id uuid,
  kind text not null check (kind in ('hotel_stay_barter', 'paid', 'usage_rights')),
  status text not null default 'draft' check (status = 'draft'),
  title text not null,
  body text not null,
  facts_snapshot jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint collaboration_contracts_template_owner_fkey
    foreign key (template_id, creator_id)
    references public.contract_templates (id, creator_id)
    on delete cascade,
  constraint collaboration_contracts_collaboration_owner_fkey
    foreign key (collaboration_id, creator_id)
    references public.collaborations (id, creator_id)
    on delete cascade,
  constraint collaboration_contracts_pipeline_owner_fkey
    foreign key (pipeline_item_id, creator_id)
    references public.pipeline_items (id, creator_id)
    on delete cascade,
  constraint collaboration_contracts_trip_owner_fkey
    foreign key (trip_id, creator_id)
    references public.trips (id, creator_id)
    on delete restrict,
  constraint collaboration_contracts_title_shape check (
    char_length(title) between 1 and 200
    and title = btrim(title)
  ),
  constraint collaboration_contracts_body_shape check (
    char_length(body) between 1 and 50000
    and position('This template is not legal advice' in body) > 0
  ),
  constraint collaboration_contracts_snapshot_object check (
    jsonb_typeof(facts_snapshot) = 'object'
  )
);

comment on table public.collaboration_contracts is
  'D114. A private draft agreement for one won deal. Status is draft only: nothing is sent and nothing is signed. facts_snapshot is what was stored at generation. Null there means the fact was missing.';

comment on column public.collaboration_contracts.facts_snapshot is
  'Facts copied at generation. Null fields were not recorded. Editing the draft does not rewrite this snapshot and does not invent a value for a null field.';

comment on column public.collaboration_contracts.trip_id is
  'The deal trip when the draft was generated, or null when that deal had no trip. Cleared if the trip is deleted. Not a trip that belongs to someone else.';

create index collaboration_contracts_creator_pipeline_idx
  on public.collaboration_contracts (creator_id, pipeline_item_id, updated_at desc);

create trigger collaboration_contracts_set_updated_at
  before update on public.collaboration_contracts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Scope fence. Fires for every writer, including service_role.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_collaboration_contract_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_template_kind text;
  v_pipeline_status text;
  v_pipeline_trip uuid;
  v_pipeline_creator uuid;
  v_collab_creator uuid;
  v_collab_pipeline uuid;
  v_trip_creator uuid;
begin
  if new.status is distinct from 'draft' then
    raise exception 'contract_scope: draft only'
      using errcode = '23514';
  end if;

  if tg_op = 'UPDATE' then
    if new.creator_id is distinct from old.creator_id
       or new.template_id is distinct from old.template_id
       or new.collaboration_id is distinct from old.collaboration_id
       or new.pipeline_item_id is distinct from old.pipeline_item_id
       or new.kind is distinct from old.kind
       or new.facts_snapshot is distinct from old.facts_snapshot
    then
      raise exception 'contract_scope: source is frozen'
        using errcode = '23514';
    end if;
    if new.trip_id is distinct from old.trip_id and new.trip_id is not null then
      raise exception 'contract_scope: trip cannot be reassigned'
        using errcode = '23514';
    end if;
  end if;

  select t.kind
    into v_template_kind
    from public.contract_templates t
   where t.id = new.template_id
     and t.creator_id = new.creator_id;

  if v_template_kind is null or v_template_kind is distinct from new.kind then
    raise exception 'contract_scope: template'
      using errcode = '23514';
  end if;

  select pi.status, pi.trip_id, pi.creator_id
    into v_pipeline_status, v_pipeline_trip, v_pipeline_creator
    from public.pipeline_items pi
   where pi.id = new.pipeline_item_id;

  if v_pipeline_creator is distinct from new.creator_id then
    raise exception 'contract_scope: pipeline'
      using errcode = '23514';
  end if;

  if tg_op = 'INSERT' and v_pipeline_status is distinct from 'won' then
    raise exception 'contract_scope: not won'
      using errcode = '23514';
  end if;

  select c.creator_id, c.pipeline_item_id
    into v_collab_creator, v_collab_pipeline
    from public.collaborations c
   where c.id = new.collaboration_id;

  if v_collab_creator is distinct from new.creator_id
     or v_collab_pipeline is distinct from new.pipeline_item_id
  then
    raise exception 'contract_scope: collaboration'
      using errcode = '23514';
  end if;

  if new.trip_id is not null then
    select tr.creator_id
      into v_trip_creator
      from public.trips tr
     where tr.id = new.trip_id;

    if v_trip_creator is distinct from new.creator_id
       or v_pipeline_trip is distinct from new.trip_id
    then
      raise exception 'contract_scope: trip'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.enforce_collaboration_contract_scope() is
  'D114. A draft can reference only this creator''s template, won deal, collaboration, and that deal''s trip. Source ids and the generation snapshot cannot move later. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.enforce_collaboration_contract_scope()
  from public, anon, authenticated;
grant execute on function public.enforce_collaboration_contract_scope()
  to service_role;

create trigger collaboration_contracts_scope
  before insert or update on public.collaboration_contracts
  for each row execute function public.enforce_collaboration_contract_scope();

-- A deleted trip drops the live reference and keeps the draft. The body still
-- shows the dates that were true when the draft was generated.
create or replace function public.clear_collaboration_contract_trip()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  update public.collaboration_contracts
     set trip_id = null
   where trip_id = old.id;
  return old;
end;
$$;

comment on function public.clear_collaboration_contract_trip() is
  'D114. Before a trip row disappears, drafts that pointed at it keep their text and lose only the live trip id.';

revoke all on function public.clear_collaboration_contract_trip()
  from public, anon, authenticated;
grant execute on function public.clear_collaboration_contract_trip()
  to service_role;

create trigger trips_clear_collaboration_contract_trip
  before delete on public.trips
  for each row execute function public.clear_collaboration_contract_trip();

-- ---------------------------------------------------------------------------
-- RLS. The owner may read and write their own rows. The scope trigger still
-- refuses a draft that points at someone else's deal or at a deal that is
-- not won. service_role bypasses RLS; the trigger and the composite foreign
-- keys are that fence.
-- ---------------------------------------------------------------------------
alter table public.contract_templates enable row level security;
alter table public.collaboration_contracts enable row level security;

create policy contract_templates_owner
  on public.contract_templates
  for all
  using (creator_id = public.current_creator_id())
  with check (creator_id = public.current_creator_id());

create policy collaboration_contracts_owner
  on public.collaboration_contracts
  for all
  using (creator_id = public.current_creator_id())
  with check (creator_id = public.current_creator_id());

revoke all on table public.contract_templates, public.collaboration_contracts
  from public, anon, authenticated;

grant select, insert, update, delete on table
  public.contract_templates,
  public.collaboration_contracts
  to authenticated;

grant select, insert, update, delete on table
  public.contract_templates,
  public.collaboration_contracts
  to service_role;

-- ---------------------------------------------------------------------------
-- Generate. Reads only the caller's rows. Writes one draft.
-- ---------------------------------------------------------------------------
create or replace function public.generate_collaboration_contract(
  p_user_id uuid,
  p_pipeline_item_id uuid,
  p_kind text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_kind text;
  v_status text;
  v_trip_id uuid;
  v_hotel_id uuid;
  v_item_creator uuid;
  v_count integer;
  v_collab_id uuid;
  v_collab_creator uuid;
  v_collab_hotel uuid;
  v_collab_type text;
  v_collab_start date;
  v_collab_end date;
  v_trip_creator uuid;
  v_trip_name text;
  v_trip_start date;
  v_trip_end date;
  v_contract_trip uuid;
  v_display_name text;
  v_home_city text;
  v_home_country text;
  v_languages text[];
  v_instagram text;
  v_tiktok text;
  v_youtube text;
  v_website text;
  v_home text;
  v_language_text text;
  v_followers bigint;
  v_engagement text;
  v_followers_text text;
  v_hotel_name text;
  v_destination_name text;
  v_country_name text;
  v_country_code text;
  v_address text;
  v_country_text text;
  v_structure text;
  v_cash_minor bigint;
  v_cash_currency text;
  v_in_kind text;
  v_estimate_minor bigint;
  v_estimate_currency text;
  v_payment text;
  v_payment_label text;
  v_compensation text;
  v_deliverables text;
  v_deliverable_snapshot jsonb;
  v_blank text := '[to be filled in]';
  v_template_id uuid;
  v_template_body text;
  v_title text;
  v_filled text;
  v_snapshot jsonb;
  v_saved uuid;
begin
  if p_user_id is null or p_pipeline_item_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  v_kind := nullif(btrim(coalesce(p_kind, '')), '');
  if v_kind is null or v_kind not in ('hotel_stay_barter', 'paid', 'usage_rights') then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id
    into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return jsonb_build_object('result', 'creator_profile_missing');
  end if;

  perform 1 from public.creator_profiles where id = v_creator_id for update;

  select pi.status, pi.trip_id, pi.hotel_id, pi.creator_id
    into v_status, v_trip_id, v_hotel_id, v_item_creator
    from public.pipeline_items pi
   where pi.id = p_pipeline_item_id
   for update;

  if v_item_creator is null or v_item_creator is distinct from v_creator_id then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_status is distinct from 'won' then
    return jsonb_build_object('result', 'not_won');
  end if;

  select count(*)::integer
    into v_count
    from public.collaborations c
   where c.pipeline_item_id = p_pipeline_item_id;

  if v_count = 0 then
    return jsonb_build_object('result', 'collaboration_not_found');
  end if;
  if v_count <> 1 then
    return jsonb_build_object('result', 'integrity_error');
  end if;

  select c.id, c.creator_id, c.hotel_id, c.collaboration_type, c.start_date, c.end_date
    into v_collab_id, v_collab_creator, v_collab_hotel, v_collab_type, v_collab_start, v_collab_end
    from public.collaborations c
   where c.pipeline_item_id = p_pipeline_item_id
   for update;

  if v_collab_creator is distinct from v_creator_id or v_collab_hotel is distinct from v_hotel_id then
    return jsonb_build_object('result', 'integrity_error');
  end if;

  v_contract_trip := null;
  v_trip_name := null;
  v_trip_start := null;
  v_trip_end := null;
  if v_trip_id is not null then
    select tr.creator_id, tr.name, tr.start_date, tr.end_date
      into v_trip_creator, v_trip_name, v_trip_start, v_trip_end
      from public.trips tr
     where tr.id = v_trip_id;
    if v_trip_creator is distinct from v_creator_id then
      return jsonb_build_object('result', 'integrity_error');
    end if;
    v_contract_trip := v_trip_id;
  end if;

  select cp.display_name, cp.home_city, cp.home_country, cp.languages,
         cp.instagram_handle, cp.tiktok_handle, cp.youtube_url, cp.website_url
    into v_display_name, v_home_city, v_home_country, v_languages,
         v_instagram, v_tiktok, v_youtube, v_website
    from public.creator_profiles cp
   where cp.id = v_creator_id;

  v_home := null;
  if nullif(btrim(coalesce(v_home_city, '')), '') is not null
     and nullif(btrim(coalesce(v_home_country, '')), '') is not null then
    v_home := btrim(v_home_city) || ', ' || btrim(v_home_country);
  elsif nullif(btrim(coalesce(v_home_city, '')), '') is not null then
    v_home := btrim(v_home_city);
  elsif nullif(btrim(coalesce(v_home_country, '')), '') is not null then
    v_home := btrim(v_home_country);
  end if;

  select nullif(string_agg(item, ', ' order by item), '')
    into v_language_text
    from (
      select btrim(lang) as item
        from unnest(coalesce(v_languages, array[]::text[])) as lang
       where btrim(lang) <> ''
    ) names;

  select a.follower_count, a.engagement
    into v_followers, v_engagement
    from public.creator_self_reported_audience a
   where a.creator_id = v_creator_id;

  if v_followers is null then
    v_followers_text := v_blank;
  else
    v_followers_text := v_followers::text;
  end if;

  select h.name, d.name, d.country_name, h.country_code, h.address
    into v_hotel_name, v_destination_name, v_country_name, v_country_code, v_address
    from public.hotels h
    join public.destinations d on d.id = h.destination_id
   where h.id = v_hotel_id;

  if v_hotel_name is null then
    return jsonb_build_object('result', 'integrity_error');
  end if;

  if nullif(btrim(coalesce(v_country_name, '')), '') is not null then
    v_country_text := btrim(v_country_name);
  elsif nullif(btrim(coalesce(v_country_code, '')), '') is not null then
    v_country_text := btrim(v_country_code);
  else
    v_country_text := null;
  end if;

  select c.structure, c.cash_amount_minor, c.cash_currency, c.in_kind_description,
         c.in_kind_estimate_minor, c.in_kind_estimate_currency, c.payment_status
    into v_structure, v_cash_minor, v_cash_currency, v_in_kind,
         v_estimate_minor, v_estimate_currency, v_payment
    from public.collaboration_agreed_compensations c
   where c.collaboration_id = v_collab_id
     and c.creator_id = v_creator_id;

  if v_structure is null then
    v_compensation := v_blank;
  elsif v_structure = 'paid' then
    if v_cash_minor is null or v_cash_currency is null then
      return jsonb_build_object('result', 'integrity_error');
    end if;
    v_payment_label := case v_payment
      when 'pending' then 'Pending'
      when 'partially_paid' then 'Partially paid'
      when 'paid' then 'Paid'
      else v_payment
    end;
    v_compensation := 'Paid. Cash recorded: ' || v_cash_minor::text
      || ' minor units of ' || v_cash_currency
      || '. Payment status: ' || v_payment_label || '.';
  elsif v_structure = 'in_kind' then
    if v_in_kind is null then
      return jsonb_build_object('result', 'integrity_error');
    end if;
    v_compensation := 'In-kind. ' || v_in_kind;
    if v_estimate_minor is null or v_estimate_currency is null then
      v_compensation := v_compensation || ' In-kind estimate was not recorded.';
    else
      v_compensation := v_compensation || ' In-kind estimate recorded: '
        || v_estimate_minor::text || ' minor units of ' || v_estimate_currency || '.';
    end if;
  elsif v_structure = 'hybrid' then
    if v_cash_minor is null or v_cash_currency is null or v_in_kind is null then
      return jsonb_build_object('result', 'integrity_error');
    end if;
    v_payment_label := case v_payment
      when 'pending' then 'Pending'
      when 'partially_paid' then 'Partially paid'
      when 'paid' then 'Paid'
      else v_payment
    end;
    v_compensation := 'Hybrid. Cash recorded: ' || v_cash_minor::text
      || ' minor units of ' || v_cash_currency
      || '. Payment status: ' || v_payment_label
      || '. In-kind: ' || v_in_kind;
    if v_estimate_minor is null or v_estimate_currency is null then
      v_compensation := v_compensation || ' In-kind estimate was not recorded.';
    else
      v_compensation := v_compensation || ' In-kind estimate recorded: '
        || v_estimate_minor::text || ' minor units of ' || v_estimate_currency || '.';
    end if;
  elsif v_structure = 'unpaid' then
    v_compensation := 'Unpaid. No cash amount is stored.';
  elsif v_structure = 'other' then
    v_compensation := 'Other. No amount is stored. ' || v_blank;
  else
    v_compensation := 'Unknown. No amount is stored. ' || v_blank;
  end if;

  select string_agg(
           d.quantity::text || ' ' ||
           case d.deliverable_type
             when 'reel' then 'Reel'
             when 'story' then 'Story'
             when 'post' then 'Post'
             when 'tiktok' then 'TikTok'
             when 'youtube' then 'YouTube'
             when 'photo_set' then 'Photo set'
             when 'ugc_video' then 'UGC video'
             when 'other' then 'Other'
             else d.deliverable_type
           end
           || case
                when nullif(btrim(coalesce(d.platform, '')), '') is not null
                  then ' on ' || d.platform
                else ''
              end
           || case
                when d.due_on is not null
                  then ', due ' || to_char(d.due_on, 'YYYY-MM-DD')
                else ''
              end
           || ', status ' ||
           case d.status
             when 'pending' then 'Pending'
             when 'submitted' then 'Submitted'
             when 'approved' then 'Approved'
             when 'rejected' then 'Rejected'
             else d.status
           end
           || case
                when nullif(btrim(coalesce(d.notes, '')), '') is not null
                  then '. Notes: ' || d.notes
                else ''
              end
           || case
                when nullif(btrim(coalesce(d.proof_url, '')), '') is not null
                  then '. Proof: ' || d.proof_url
                else ''
              end,
           E'\n' order by d.created_at, d.id
         )
    into v_deliverables
    from public.collaboration_deliverables d
   where d.collaboration_id = v_collab_id
     and d.creator_id = v_creator_id;

  if v_deliverables is null then
    v_deliverables := v_blank;
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'deliverable_type', d.deliverable_type,
               'quantity', d.quantity,
               'platform', d.platform,
               'due_on', d.due_on,
               'status', d.status,
               'notes', d.notes,
               'proof_url', d.proof_url
             )
             order by d.created_at, d.id
           ),
           '[]'::jsonb
         )
    into v_deliverable_snapshot
    from public.collaboration_deliverables d
   where d.collaboration_id = v_collab_id
     and d.creator_id = v_creator_id;

  v_title := case v_kind
    when 'hotel_stay_barter' then 'Hotel stay / barter'
    when 'paid' then 'Paid collaboration'
    else 'Usage rights'
  end;

  insert into public.contract_templates (creator_id, kind, title, body)
  values (v_creator_id, v_kind, v_title, public.contract_starter_body(v_kind))
  on conflict on constraint contract_templates_kind_uidx do nothing;

  select t.id, t.body
    into v_template_id, v_template_body
    from public.contract_templates t
   where t.creator_id = v_creator_id
     and t.kind = v_kind
   for update;

  if v_template_id is null or v_template_body is null then
    return jsonb_build_object('result', 'integrity_error');
  end if;

  v_filled := public.apply_contract_tokens(
    v_template_body,
    jsonb_build_object(
      'creator_name', public.contract_or_blank(v_display_name),
      'creator_home', public.contract_or_blank(v_home),
      'creator_languages', public.contract_or_blank(v_language_text),
      'creator_instagram', public.contract_or_blank(v_instagram),
      'creator_tiktok', public.contract_or_blank(v_tiktok),
      'creator_youtube', public.contract_or_blank(v_youtube),
      'creator_website', public.contract_or_blank(v_website),
      'audience_followers', v_followers_text,
      'audience_engagement', public.contract_or_blank(v_engagement),
      'hotel_name', public.contract_or_blank(v_hotel_name),
      'hotel_destination', public.contract_or_blank(v_destination_name),
      'hotel_country', public.contract_or_blank(v_country_text),
      'hotel_address', public.contract_or_blank(v_address),
      'trip_name', public.contract_or_blank(v_trip_name),
      'trip_start', case when v_trip_start is null then v_blank else to_char(v_trip_start, 'YYYY-MM-DD') end,
      'trip_end', case when v_trip_end is null then v_blank else to_char(v_trip_end, 'YYYY-MM-DD') end,
      'collaboration_type', case v_collab_type
        when 'stay' then 'Stay'
        when 'product' then 'Product'
        when 'paid' then 'Paid'
        when 'stay_plus_paid' then 'Stay plus paid'
        when 'other' then 'Other'
        else public.contract_or_blank(v_collab_type)
      end,
      'collaboration_start', case when v_collab_start is null then v_blank else to_char(v_collab_start, 'YYYY-MM-DD') end,
      'collaboration_end', case when v_collab_end is null then v_blank else to_char(v_collab_end, 'YYYY-MM-DD') end,
      'compensation', v_compensation,
      'deliverables', v_deliverables
    )
  );

  if position('This template is not legal advice' in v_filled) = 0 then
    v_filled := 'This template is not legal advice and it is not a signed contract.'
      || E'\n\n' || v_filled;
  end if;

  if char_length(v_filled) > 50000 or nullif(btrim(v_filled), '') is null then
    return jsonb_build_object('result', 'too_long');
  end if;

  v_snapshot := jsonb_build_object(
    'creator_name', v_display_name,
    'creator_home_city', v_home_city,
    'creator_home_country', v_home_country,
    'creator_languages', to_jsonb(coalesce(v_languages, array[]::text[])),
    'instagram_handle', v_instagram,
    'tiktok_handle', v_tiktok,
    'youtube_url', v_youtube,
    'website_url', v_website,
    'audience_followers', v_followers,
    'audience_engagement', v_engagement,
    'hotel_name', v_hotel_name,
    'hotel_destination', v_destination_name,
    'hotel_country_name', v_country_name,
    'hotel_country_code', v_country_code,
    'hotel_address', v_address,
    'trip_id', v_contract_trip,
    'trip_name', v_trip_name,
    'trip_start', v_trip_start,
    'trip_end', v_trip_end,
    'collaboration_type', v_collab_type,
    'collaboration_start', v_collab_start,
    'collaboration_end', v_collab_end,
    'compensation', case
      when v_structure is null then null
      else jsonb_build_object(
        'structure', v_structure,
        'cash_amount_minor', v_cash_minor,
        'cash_currency', v_cash_currency,
        'in_kind_description', v_in_kind,
        'in_kind_estimate_minor', v_estimate_minor,
        'in_kind_estimate_currency', v_estimate_currency,
        'payment_status', v_payment
      )
    end,
    'deliverables', v_deliverable_snapshot
  );

  insert into public.collaboration_contracts (
    creator_id, template_id, collaboration_id, pipeline_item_id, trip_id,
    kind, status, title, body, facts_snapshot
  ) values (
    v_creator_id, v_template_id, v_collab_id, p_pipeline_item_id, v_contract_trip,
    v_kind, 'draft', v_title, v_filled, v_snapshot
  )
  returning id into v_saved;

  return jsonb_build_object(
    'result', 'created',
    'contract_id', v_saved,
    'title', v_title,
    'kind', v_kind,
    'body', v_filled
  );
end;
$$;

comment on function public.generate_collaboration_contract(uuid, uuid, text) is
  'D114. Builds one private draft from the caller''s won deal. Missing facts stay marked to be filled in. Does not send, sign, or read another creator.';

revoke all on function public.generate_collaboration_contract(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.generate_collaboration_contract(uuid, uuid, text)
  to service_role;

create or replace function public.update_collaboration_contract(
  p_user_id uuid,
  p_contract_id uuid,
  p_title text,
  p_body text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_title text;
  v_body text;
  v_owner uuid;
begin
  if p_user_id is null or p_contract_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  v_title := nullif(btrim(coalesce(p_title, '')), '');
  v_body := coalesce(p_body, '');
  if v_title is null
     or char_length(v_title) > 200
     or nullif(btrim(v_body), '') is null
  then
    return jsonb_build_object('result', 'invalid_input');
  end if;
  if char_length(v_body) > 50000 then
    return jsonb_build_object('result', 'too_long');
  end if;
  if position('This template is not legal advice' in v_body) = 0 then
    return jsonb_build_object('result', 'disclaimer_required');
  end if;

  select cp.id
    into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return jsonb_build_object('result', 'creator_profile_missing');
  end if;

  select c.creator_id
    into v_owner
    from public.collaboration_contracts c
   where c.id = p_contract_id
   for update;

  if v_owner is null or v_owner is distinct from v_creator_id then
    return jsonb_build_object('result', 'not_found');
  end if;

  update public.collaboration_contracts
     set title = v_title,
         body = v_body
   where id = p_contract_id
     and creator_id = v_creator_id;

  return jsonb_build_object('result', 'saved', 'contract_id', p_contract_id);
end;
$$;

comment on function public.update_collaboration_contract(uuid, uuid, text, text) is
  'D114. The owner may edit the draft title and body. The deal, template, kind, and generation snapshot stay. The not-legal-advice sentence has to remain. Another creator gets not_found.';

revoke all on function public.update_collaboration_contract(uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.update_collaboration_contract(uuid, uuid, text, text)
  to service_role;

create or replace function public.delete_collaboration_contract(
  p_user_id uuid,
  p_contract_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_owner uuid;
begin
  if p_user_id is null or p_contract_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id
    into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return jsonb_build_object('result', 'creator_profile_missing');
  end if;

  select c.creator_id
    into v_owner
    from public.collaboration_contracts c
   where c.id = p_contract_id
   for update;

  if v_owner is null or v_owner is distinct from v_creator_id then
    return jsonb_build_object('result', 'not_found');
  end if;

  delete from public.collaboration_contracts
   where id = p_contract_id
     and creator_id = v_creator_id;

  return jsonb_build_object('result', 'deleted');
end;
$$;

comment on function public.delete_collaboration_contract(uuid, uuid) is
  'D114. The owner may delete their draft. Another creator gets not_found and the row stays.';

revoke all on function public.delete_collaboration_contract(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.delete_collaboration_contract(uuid, uuid)
  to service_role;
