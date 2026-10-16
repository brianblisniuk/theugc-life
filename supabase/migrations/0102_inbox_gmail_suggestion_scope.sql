-- 0102_inbox_gmail_suggestion_scope.sql
-- Inbox reviews Gmail suggestions for the pipeline items on the page.
-- The unscoped home function stays. A later human_reply on a listed thread
-- is not dropped because older rows on other items filled the cap of 100.
-- Truncation is still reported when those listed items themselves exceed 100.

create or replace function public.list_own_pending_gmail_collaboration_suggestions(
  p_pipeline_item_ids uuid[]
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_creator uuid;
  v_ids uuid[] := coalesce(p_pipeline_item_ids, array[]::uuid[]);
  v_count integer;
  v_rows jsonb;
begin
  if v_user is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if not private.gmail_collab_is_paid(v_user) then
    return jsonb_build_object('result', 'paused', 'suggestions', '[]'::jsonb);
  end if;

  select cp.id into v_creator
    from public.creator_profiles cp
   where cp.user_id = v_user;
  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select count(*)::integer into v_count
    from public.gmail_collaboration_suggestions s
    join public.pipeline_items pi
      on pi.id = s.pipeline_item_id
     and pi.creator_id = v_creator
    join public.hotels h
      on h.id = pi.hotel_id
   where s.creator_id = v_creator
     and s.status = 'pending'
     and s.pipeline_item_id = any (v_ids)
     and char_length(btrim(h.name)) > 0;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', listed.id,
           'kind', listed.kind,
           'pipeline_item_id', listed.pipeline_item_id,
           'hotel_id', listed.hotel_id,
           'hotel_name', listed.hotel_name
         ) order by listed.kind_rank, listed.id), '[]'::jsonb)
    into v_rows
    from (
      select s.id, s.kind, s.pipeline_item_id, pi.hotel_id, btrim(h.name) as hotel_name,
             case s.kind
               when 'human_reply' then 1
               when 'pitch_sent' then 2
               when 'collaboration' then 3
               else 4
             end as kind_rank
        from public.gmail_collaboration_suggestions s
        join public.pipeline_items pi
          on pi.id = s.pipeline_item_id
         and pi.creator_id = v_creator
        join public.hotels h
          on h.id = pi.hotel_id
       where s.creator_id = v_creator
         and s.status = 'pending'
         and s.pipeline_item_id = any (v_ids)
         and char_length(btrim(h.name)) > 0
       order by case s.kind
                  when 'human_reply' then 1
                  when 'pitch_sent' then 2
                  when 'collaboration' then 3
                  else 4
                end,
                s.id
       limit 100
    ) listed;

  return jsonb_build_object(
    'result', 'ok',
    'suggestions', v_rows,
    'truncated', v_count > 100
  );
end;
$$;

comment on function public.list_own_pending_gmail_collaboration_suggestions(uuid[]) is
  'Pending Gmail suggestions for the signed-in owner, limited to the pipeline items passed in. An empty array returns no rows. Free returns paused and no ids. The cap of 100 sets truncated. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.list_own_pending_gmail_collaboration_suggestions(uuid[])
  from public, anon;
grant execute on function public.list_own_pending_gmail_collaboration_suggestions(uuid[])
  to authenticated, service_role;
