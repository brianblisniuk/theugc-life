-- 0052 — D08 private creator profile counts and past collaborations.
--
-- Migration number: 0052. 0051 is reserved by E04 and is not used here.
-- 0050 is D07 and is not edited. The repo does not FORCE row level security.
-- The count reads run as the caller so the existing owner policies stay the
-- row boundary.
--
-- Hotel sharing is in the MVP (D086, Proposed) and is not built here. The
-- new table is the creator's per-field opt-in only. It has no token, no
-- public policy, and no hotel read. A missing row is private. opted_in
-- defaults false. Setting revoked_at requires opted_in false, so a revoked
-- field is not shared. A later block adds the revocable share link and the
-- field allow-list. public_profile_enabled is not that link.
--
-- Counts are creator-recorded outcomes. A machine reading on a linked thread
-- is not a reply, an agreement, a decline, or a ghost. Unknown compensation
-- is not read, so it cannot become zero or unpaid. The payload is counts
-- only: no rate.
--
-- Past collaborations are terminal rows the creator recorded (completed or
-- cancelled). A cancelled collaboration is not a completed one and is not a
-- lost deal. The list does not copy those rows onto a new pipeline item.

-- ---------------------------------------------------------------------------
-- Personal counts. No argument: the caller cannot name another creator.
-- A missing profile is not_found with JSON nulls, which is not a zero.
-- A real zero is returned only after the caller's own rows were read.
-- ---------------------------------------------------------------------------
create or replace function public.creator_personal_counts()
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_creator uuid;
  v_outreach integer;
  v_replies integer;
  v_agreements integer;
  v_completed integer;
  v_done integer;
begin
  v_creator := public.current_creator_id();
  if v_creator is null then
    return jsonb_build_object(
      'result', 'not_found',
      'outreach', null,
      'replies', null,
      'agreements', null,
      'completed_collaborations', null,
      'deliverables_done', null
    );
  end if;

  -- Cycles with a creator-recorded pitch or follow-up. A second event on the
  -- same cycle does not raise the count. Status alone is not a record.
  -- follow_up is not a reply. gmail, system, and admin_correction are not
  -- the creator's record.
  select count(distinct oe.pipeline_item_id)::integer into v_outreach
    from public.outreach_events oe
   where oe.creator_id = v_creator
     and oe.source = 'manual_creator'
     and oe.event_type in ('pitch_sent', 'followup_sent');

  select count(distinct oe.pipeline_item_id)::integer into v_replies
    from public.outreach_events oe
   where oe.creator_id = v_creator
     and oe.source = 'manual_creator'
     and oe.event_type = 'reply_received';

  -- A collaboration row is the creator-recorded agreement (D045). Cancelled
  -- still counts: the deal was agreed, and cancellation is a later fact.
  -- negotiation_started and a machine agreement_observed are not in this set.
  select count(*)::integer into v_agreements
    from public.collaborations c
   where c.creator_id = v_creator;

  select count(*)::integer into v_completed
    from public.collaborations c
   where c.creator_id = v_creator
     and c.status = 'completed';

  -- One approved checklist row is one done deliverable. Quantity is not
  -- summed. pending, submitted, and rejected are not done.
  select count(*)::integer into v_done
    from public.collaboration_deliverables d
   where d.creator_id = v_creator
     and d.status = 'approved';

  return jsonb_build_object(
    'result', 'ok',
    'outreach', v_outreach,
    'replies', v_replies,
    'agreements', v_agreements,
    'completed_collaborations', v_completed,
    'deliverables_done', v_done
  );
end;
$$;

comment on function public.creator_personal_counts() is
  'D08 private counts of creator-recorded outcomes for the caller. JSON null means the profile is missing, which is not zero. No rate, no compensation amount, and no machine disposition. SECURITY INVOKER. search_path is pinned empty.';

revoke all on function public.creator_personal_counts() from public, anon;
grant execute on function public.creator_personal_counts() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Terminal collaborations the caller recorded. p_hotel_id null is the full
-- private list. A hotel filter that matches nothing, including another
-- creator's hotel, is an empty list, not not_found. not_found is only a
-- missing caller profile, and its collaborations value is JSON null.
-- ---------------------------------------------------------------------------
create or replace function public.creator_past_collaborations(p_hotel_id uuid default null)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_creator uuid;
  v_rows jsonb;
begin
  v_creator := public.current_creator_id();
  if v_creator is null then
    return jsonb_build_object('result', 'not_found', 'collaborations', null);
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'id', c.id,
               'hotel_id', c.hotel_id,
               'hotel_name', h.name,
               'status', c.status,
               'collaboration_type', c.collaboration_type,
               'start_date', c.start_date,
               'end_date', c.end_date,
               'would_work_again', c.would_work_again,
               'terms_matched', c.terms_matched
             )
             order by c.end_date desc nulls last, c.created_at desc, c.id desc
           ),
           '[]'::jsonb
         )
    into v_rows
    from public.collaborations c
    join public.hotels h on h.id = c.hotel_id
   where c.creator_id = v_creator
     and c.status in ('completed', 'cancelled')
     and (p_hotel_id is null or c.hotel_id = p_hotel_id);

  return jsonb_build_object('result', 'ok', 'collaborations', v_rows);
end;
$$;

comment on function public.creator_past_collaborations(uuid) is
  'D08 private list of the caller''s completed and cancelled collaborations. Does not include compensation, notes, or machine readings. A missing profile is JSON null, not an empty list. SECURITY INVOKER. search_path is pinned empty.';

revoke all on function public.creator_past_collaborations(uuid) from public, anon;
grant execute on function public.creator_past_collaborations(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Per-field opt-in for a later creator-controlled hotel share link.
-- This table is not the link. There is no token column and no policy that
-- lets anon, another creator, or a hotel read a row.
--
-- Private by default:
--   * no row means the field is not shared;
--   * opted_in defaults false, so naming a field does not share it;
--   * revoked_at may be set only when opted_in is false. Clearing revoked_at
--     does not opt the field back in; opted_in must be set true again.
-- The allowed field_key values are not closed. The follow-up that issues a
-- link has to reject keys it has not decided before any hotel can read one.
-- ---------------------------------------------------------------------------
create table public.creator_profile_field_opt_ins (
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  field_key text not null,
  opted_in boolean not null default false,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (creator_id, field_key),
  constraint creator_profile_field_opt_ins_key_shape
    check (field_key ~ '^[a-z][a-z0-9_]{0,63}$'),
  constraint creator_profile_field_opt_ins_revoked_stays_private
    check (revoked_at is null or opted_in = false)
);

comment on table public.creator_profile_field_opt_ins is
  'D086 Proposed. Creator-owned per-field opt-in for a later hotel share link. No token. Private by default: no row, opted_in false, or revoked_at set means the field is not shared. Not readable because public_profile_enabled is true.';

comment on column public.creator_profile_field_opt_ins.field_key is
  'A profile field name. This migration does not decide which keys a hotel may see.';

comment on column public.creator_profile_field_opt_ins.opted_in is
  'Explicit opt-in. Default false. True is the only value that can later be shared, and only while revoked_at is null.';

comment on column public.creator_profile_field_opt_ins.revoked_at is
  'When set, the field is not shared. Must be paired with opted_in false.';

comment on column public.creator_profiles.public_profile_enabled is
  'Coarse flag from 0002. Not the hotel share link and not a per-field opt-in. D08 does not set it.';

comment on column public.creator_profiles.portfolio_visibility is
  'Coarse private/public flag from 0002. Not the hotel share link. D08 does not set it.';

create trigger creator_profile_field_opt_ins_set_updated_at
  before update on public.creator_profile_field_opt_ins
  for each row execute function public.set_updated_at();

alter table public.creator_profile_field_opt_ins enable row level security;

create policy creator_profile_field_opt_ins_all
  on public.creator_profile_field_opt_ins
  for all
  using (creator_id = public.current_creator_id())
  with check (creator_id = public.current_creator_id());

revoke all on table public.creator_profile_field_opt_ins from public, anon, authenticated;

grant select, insert, update, delete on table public.creator_profile_field_opt_ins to authenticated;
grant select, insert, update, delete on table public.creator_profile_field_opt_ins to service_role;
