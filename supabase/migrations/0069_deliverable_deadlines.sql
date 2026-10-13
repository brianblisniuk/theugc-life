-- 0069 — G02 deliverable deadlines and in-app reminders (D115).
--
-- Migration number: 0069. 0070 is reserved for this block and is not used:
-- no dismiss or snooze row is stored. 0065–0068 belong to other open PRs
-- and are not this file. 0050 is not edited.
--
-- The read runs as the caller. RLS on collaboration_deliverables is the
-- row boundary. The function takes no user id. It does not send mail,
-- push, or SMS, and it does not call a model.

create index collaboration_deliverables_deadline_idx
  on public.collaboration_deliverables (creator_id, due_on, id)
  where status in ('pending', 'rejected') and due_on is not null;

comment on index public.collaboration_deliverables_deadline_idx is
  'D115. Owner scan of pending and rejected deliverables that have a due date. Submitted, approved, and undated rows are not deadline rows.';

create or replace function public.list_own_deliverable_deadlines(p_limit integer)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_creator uuid;
  v_limit integer;
  v_broken boolean;
  v_total integer;
  v_rows jsonb;
begin
  if p_limit is null or p_limit < 1 or p_limit > 80 then
    return pg_catalog.jsonb_build_object('result', 'invalid_input');
  end if;
  v_limit := p_limit;

  v_creator := public.current_creator_id();
  if v_creator is null then
    return pg_catalog.jsonb_build_object('result', 'not_found');
  end if;

  select exists (
    select 1
      from public.collaboration_deliverables d
     where d.creator_id = v_creator
       and d.status in ('pending', 'rejected')
       and d.due_on is not null
       and not exists (
         select 1
           from public.pipeline_items pi
           join public.hotels h on h.id = pi.hotel_id
          where pi.id = d.pipeline_item_id
            and pi.creator_id = d.creator_id
            and pg_catalog.char_length(pg_catalog.btrim(h.name)) > 0
       )
  )
    into v_broken;

  if v_broken then
    return pg_catalog.jsonb_build_object('result', 'error');
  end if;

  select count(*)::integer
    into v_total
    from public.collaboration_deliverables d
   where d.creator_id = v_creator
     and d.status in ('pending', 'rejected')
     and d.due_on is not null;

  select coalesce(pg_catalog.jsonb_agg(s.obj order by s.due_on, s.id), '[]'::jsonb)
    into v_rows
    from (
      select d.id,
             pg_catalog.to_char(d.due_on, 'YYYY-MM-DD') as due_on,
             pg_catalog.jsonb_build_object(
               'id', d.id,
               'creator_id', d.creator_id,
               'pipeline_item_id', d.pipeline_item_id,
               'hotel_id', h.id,
               'hotel_name', pg_catalog.btrim(h.name),
               'deliverable_type', d.deliverable_type,
               'quantity', d.quantity,
               'platform', d.platform,
               'due_on', pg_catalog.to_char(d.due_on, 'YYYY-MM-DD'),
               'status', d.status
             ) as obj
        from public.collaboration_deliverables d
        join public.pipeline_items pi
          on pi.id = d.pipeline_item_id
         and pi.creator_id = d.creator_id
        join public.hotels h on h.id = pi.hotel_id
       where d.creator_id = v_creator
         and d.status in ('pending', 'rejected')
         and d.due_on is not null
       order by d.due_on, d.id
       limit v_limit
    ) s;

  return pg_catalog.jsonb_build_object(
    'result', 'ok',
    'truncated', v_total > v_limit,
    'deliverables', coalesce(v_rows, '[]'::jsonb)
  );
end;
$$;

comment on function public.list_own_deliverable_deadlines(integer) is
  'D115. The caller''s pending and rejected deliverables that have a due date, earliest first. Runs as the caller so RLS applies. Takes no user id. A missing profile is not_found. A broken hotel link is error, not an empty list. Does not send a message.';

revoke all on function public.list_own_deliverable_deadlines(integer) from public, anon;
grant execute on function public.list_own_deliverable_deadlines(integer) to authenticated, service_role;
