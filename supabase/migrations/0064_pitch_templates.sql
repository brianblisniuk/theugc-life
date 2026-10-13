-- 0064 — F02 pitch templates and drafts (D110).
--
-- Migration number: 0064. 0060 is the Free Gmail pause on main. 0061–0063
-- are not this file. This migration does not send mail, does not call a
-- model, and does not write the outreach ledger or pipeline rows.
--
-- A template and a draft belong to one creator. Copy and a mailto draft are
-- delivery marks on the draft. They are not a sent pitch.

-- ---------------------------------------------------------------------------
-- Reusable subject and body. Tokens are filled in the app. The row stores
-- the creator's text, not another creator's facts.
-- ---------------------------------------------------------------------------
create table public.pitch_templates (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles (id) on delete cascade,
  name text not null,
  subject text not null,
  body text not null,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pitch_templates_name_check check (
    char_length(name) between 1 and 80
    and name = btrim(name)
  ),
  constraint pitch_templates_subject_check check (char_length(subject) between 1 and 200),
  constraint pitch_templates_body_check check (char_length(body) between 1 and 8000)
);

comment on table public.pitch_templates is
  'D110. Creator-owned pitch template. Anon has no privilege. A row is not a sent pitch.';

comment on column public.pitch_templates.archived_at is
  'Set when the creator retires the template. The row stays theirs.';

create index pitch_templates_creator_idx
  on public.pitch_templates (creator_id)
  where archived_at is null;

create trigger pitch_templates_set_updated_at
  before update on public.pitch_templates
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- One draft is one hotel for one creator. A trip and a saved template are
-- optional and must belong to the same creator. The guard trigger checks that.
-- ---------------------------------------------------------------------------
create table public.pitch_drafts (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles (id) on delete cascade,
  hotel_id uuid not null references public.hotels (id) on delete cascade,
  trip_id uuid references public.trips (id) on delete set null,
  template_id uuid references public.pitch_templates (id) on delete set null,
  system_template_key text,
  subject text not null,
  body text not null,
  variables_used jsonb not null default '[]'::jsonb,
  delivery text not null default 'unsent',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pitch_drafts_subject_check check (char_length(subject) between 1 and 200),
  constraint pitch_drafts_body_check check (char_length(body) between 1 and 8000),
  constraint pitch_drafts_one_source check (
    template_id is null or system_template_key is null
  ),
  constraint pitch_drafts_system_key_check check (
    system_template_key is null
    or system_template_key in ('introduction', 'stay', 'follow_up', 'return_visit')
  ),
  constraint pitch_drafts_delivery_check check (
    delivery in ('unsent', 'copied', 'mailto_opened')
  ),
  constraint pitch_drafts_variables_array_check check (jsonb_typeof(variables_used) = 'array')
);

comment on table public.pitch_drafts is
  'D110. Creator-owned pitch draft for one hotel. delivery is copied or mailto_opened. Neither is a sent pitch. variables_used stores fact keys, never an address.';

comment on column public.pitch_drafts.delivery is
  'unsent, copied, or mailto_opened. Opening a mailto draft does not record a sent pitch.';

comment on column public.pitch_drafts.variables_used is
  'JSON array of fact keys that were available when the draft was saved. Values are not stored. email is not a key.';

create index pitch_drafts_creator_hotel_idx
  on public.pitch_drafts (creator_id, hotel_id, updated_at desc);

create trigger pitch_drafts_set_updated_at
  before update on public.pitch_drafts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Owner guard. Not security definer. When a session is present, creator_id
-- is the caller's profile. A trip or saved template on a draft must be that
-- same profile. Variable keys are an allow-list, so a client cannot store
-- an email under another name.
-- ---------------------------------------------------------------------------
create or replace function public.pitch_owner_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  if auth.uid() is not null then
    v_owner := public.current_creator_id();
    if v_owner is null then
      raise exception 'pitch rows require a creator profile'
        using errcode = '42501';
    end if;
    if new.creator_id is not null and new.creator_id is distinct from v_owner then
      raise exception 'pitch owner cannot change'
        using errcode = '42501';
    end if;
    new.creator_id := v_owner;
  end if;

  if tg_table_name = 'pitch_drafts' then
    if new.variables_used is null then
      new.variables_used := '[]'::jsonb;
    end if;
    if jsonb_typeof(new.variables_used) is distinct from 'array' then
      raise exception 'pitch variables must be an array'
        using errcode = '23514';
    end if;
    if exists (
      select 1
      from jsonb_array_elements(new.variables_used) as elem
      where jsonb_typeof(elem) <> 'string'
         or (elem #>> '{}') <> all (array[
           'creator_name',
           'niche',
           'instagram_handle',
           'hotel_name',
           'destination_name',
           'trip_name',
           'trip_start',
           'trip_end',
           'portfolio_title',
           'portfolio_url',
           'contact_name',
           'intelligence_note',
           'past_collaboration'
         ])
    ) then
      raise exception 'pitch variable is not allowed'
        using errcode = '23514';
    end if;

    if new.trip_id is not null and not exists (
      select 1
      from public.trips t
      where t.id = new.trip_id
        and t.creator_id = new.creator_id
    ) then
      raise exception 'pitch draft trip must belong to the same creator'
        using errcode = '23514';
    end if;

    if new.template_id is not null and not exists (
      select 1
      from public.pitch_templates p
      where p.id = new.template_id
        and p.creator_id = new.creator_id
        and p.archived_at is null
    ) then
      raise exception 'pitch draft template must belong to the same creator'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.pitch_owner_guard() is
  'D110. Forces the session creator, rejects another creator''s trip or template, and rejects variable keys outside the allow-list.';

revoke all on function public.pitch_owner_guard() from public, anon, authenticated, service_role;
grant execute on function public.pitch_owner_guard() to authenticated, service_role;

create trigger pitch_templates_owner
  before insert or update on public.pitch_templates
  for each row execute function public.pitch_owner_guard();

create trigger pitch_drafts_owner
  before insert or update on public.pitch_drafts
  for each row execute function public.pitch_owner_guard();

alter table public.pitch_templates enable row level security;
alter table public.pitch_drafts enable row level security;

create policy pitch_templates_all
  on public.pitch_templates
  for all
  using (creator_id = public.current_creator_id())
  with check (creator_id = public.current_creator_id());

create policy pitch_drafts_all
  on public.pitch_drafts
  for all
  using (creator_id = public.current_creator_id())
  with check (creator_id = public.current_creator_id());

revoke all on table public.pitch_templates from public, anon, authenticated;
grant select, insert, update, delete on table public.pitch_templates to authenticated;
grant select, insert, update, delete on table public.pitch_templates to service_role;

revoke all on table public.pitch_drafts from public, anon, authenticated;
grant select, insert, update, delete on table public.pitch_drafts to authenticated;
grant select, insert, update, delete on table public.pitch_drafts to service_role;
