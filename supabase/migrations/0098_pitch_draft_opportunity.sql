-- 0098 — Bind a pitch draft to one opportunity.
--
-- pitch_drafts was one row per hotel. Two open opportunities for that hotel
-- could show and overwrite the same draft. pipeline_item_id is the
-- opportunity. Null means the draft was not assigned: either it was saved
-- when no opportunity was open, or backfill found more than one open
-- opportunity and refused to guess.
--
-- Backfill assigns a draft only when that creator and hotel have exactly one
-- open pipeline row. A closed row is not a candidate. Existing migrations
-- 0064–0097 are not edited. RLS stays creator_id = current_creator_id().

alter table public.pitch_drafts
  add column pipeline_item_id uuid;

alter table public.pitch_drafts
  add constraint pitch_drafts_pipeline_item_fk
  foreign key (pipeline_item_id)
  references public.pipeline_items (id)
  on delete set null;

comment on column public.pitch_drafts.pipeline_item_id is
  'The opportunity this draft belongs to. Null is unassigned and must not be shown as another opportunity''s draft. Set only when the pipeline row is the same creator and hotel.';

create index pitch_drafts_opportunity_idx
  on public.pitch_drafts (creator_id, pipeline_item_id, updated_at desc)
  where pipeline_item_id is not null;

-- Exactly one open opportunity: that row owns the existing hotel drafts.
-- Two or more open rows: leave the drafts unassigned.
update public.pitch_drafts as draft
   set pipeline_item_id = only_one.id
  from (
    select pipeline.creator_id,
           pipeline.hotel_id,
           (array_agg(pipeline.id))[1] as id
      from public.pipeline_items as pipeline
     where pipeline.status <> 'closed'
     group by pipeline.creator_id, pipeline.hotel_id
    having count(*) = 1
  ) as only_one
 where draft.creator_id = only_one.creator_id
   and draft.hotel_id = only_one.hotel_id
   and draft.pipeline_item_id is null;

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
    if tg_op = 'UPDATE'
       and old.pipeline_item_id is not null
       and new.pipeline_item_id is not null
       and new.pipeline_item_id is distinct from old.pipeline_item_id
    then
      raise exception 'pitch draft opportunity cannot change'
        using errcode = '23514';
    end if;

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

    if new.pipeline_item_id is not null and not exists (
      select 1
      from public.pipeline_items as pipeline
      where pipeline.id = new.pipeline_item_id
        and pipeline.creator_id = new.creator_id
        and pipeline.hotel_id = new.hotel_id
    ) then
      raise exception 'pitch draft opportunity must belong to the same creator and hotel'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.pitch_owner_guard() is
  'D110. Forces the session creator, rejects another creator''s trip, template, or opportunity, and rejects moving a draft from one opportunity to another.';

revoke all on function public.pitch_owner_guard() from public, anon, authenticated, service_role;
grant execute on function public.pitch_owner_guard() to authenticated, service_role;
