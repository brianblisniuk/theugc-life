-- 0073 — G03 travel portfolio tables (D125).
--
-- This block uses 0073 and 0074. 0069 is G02 on main. 0070 is unused.
-- 0071 and 0072 stay with H01. 0066 (F04) and 0068 (G01) are not edited.
--
-- A row is the creator's decision about one collaboration they already own.
-- Suggestions are computed, not stored. A Gmail detection is not a row here.
-- RLS is enabled and not forced, the same pattern as the other public tables.

create table public.creator_portfolio_settings (
  creator_id uuid primary key references public.creator_profiles(id) on delete cascade,
  template_key text not null check (template_key in ('journey', 'destinations', 'highlights')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.creator_portfolio_settings is
  'D125. The travel layout the creator picked. No row means they have not picked one. The layout adds no facts.';

create trigger creator_portfolio_settings_set_updated_at
  before update on public.creator_portfolio_settings
  for each row execute function public.set_updated_at();

create table public.creator_portfolio_entries (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  collaboration_id uuid not null,
  decision text not null check (decision in ('published', 'dismissed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint creator_portfolio_entries_collaboration_uidx unique (creator_id, collaboration_id),
  constraint creator_portfolio_entries_id_creator_key unique (id, creator_id),
  constraint creator_portfolio_entries_collaboration_fkey
    foreign key (collaboration_id, creator_id)
    references public.collaborations (id, creator_id)
    on delete cascade
);

comment on table public.creator_portfolio_entries is
  'D125. published can appear on the hotel share link after the creator picks a template, and only while the collaboration stays confirmed. dismissed is not suggested again and is not public. No row means the collaboration is still a suggestion. Cancelled is not confirmed.';

create index creator_portfolio_entries_creator_idx
  on public.creator_portfolio_entries (creator_id, decision);

create trigger creator_portfolio_entries_set_updated_at
  before update on public.creator_portfolio_entries
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Confirmed collaborations only. The function does not take a user id.
-- The composite foreign key already requires the same creator. This refuses
-- a cancelled collaboration, which D045 does not treat as confirmed.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_creator_portfolio_entry()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
begin
  select c.status
    into v_status
    from public.collaborations c
   where c.id = new.collaboration_id
     and c.creator_id = new.creator_id;

  if v_status is null or v_status not in ('agreed', 'scheduled', 'active', 'completed') then
    raise exception 'portfolio entries require a confirmed collaboration'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.enforce_creator_portfolio_entry() is
  'D125. A portfolio row can name only a confirmed collaboration of the same creator. Cancelled is not confirmed. SECURITY DEFINER, search_path empty.';

revoke all on function public.enforce_creator_portfolio_entry()
  from public, anon, authenticated;
grant execute on function public.enforce_creator_portfolio_entry()
  to service_role;

create trigger creator_portfolio_entries_confirmed
  before insert or update on public.creator_portfolio_entries
  for each row execute function public.enforce_creator_portfolio_entry();

alter table public.creator_portfolio_settings enable row level security;
alter table public.creator_portfolio_entries enable row level security;

create policy creator_portfolio_settings_owner
  on public.creator_portfolio_settings
  for all
  using (creator_id = public.current_creator_id())
  with check (creator_id = public.current_creator_id());

create policy creator_portfolio_entries_owner
  on public.creator_portfolio_entries
  for all
  using (creator_id = public.current_creator_id())
  with check (creator_id = public.current_creator_id());

revoke all on table public.creator_portfolio_settings, public.creator_portfolio_entries
  from public, anon, authenticated;

grant select on table public.creator_portfolio_settings, public.creator_portfolio_entries
  to authenticated;

grant select, insert, update, delete on table
  public.creator_portfolio_settings,
  public.creator_portfolio_entries
  to service_role;
