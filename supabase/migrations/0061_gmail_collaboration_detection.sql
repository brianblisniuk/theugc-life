-- 0061_gmail_collaboration_detection.sql
-- F01 (D107). Gmail-assisted collaboration detection.
--
-- A linked stored thread can suggest a pitch, a human reply, or a
-- collaboration. The suggestion is not a hotel fact and not a CRM
-- collaboration. Refresh writes nothing for a Free user (the same paid
-- gate as 0060). Confirming a pitch or a human reply calls the existing
-- manual transition. Confirming a collaboration records the acknowledgement
-- and writes no outreach event, no collaboration row, and no pipeline change.
-- An automated reply never becomes a human reply. Disconnect does not purge.
-- Every Gmail deletion purge still does, because it already calls
-- private.purge_network_gmail_for_mailbox.

create table public.gmail_collaboration_suggestions (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  pipeline_item_id uuid not null references public.pipeline_items(id) on delete cascade,
  binding_id uuid not null references public.pipeline_inbox_bindings(id) on delete cascade,
  mail_account_id uuid not null references public.mail_accounts(id) on delete cascade,
  provider_thread_id text not null check (
    char_length(provider_thread_id) between 1 and 256
    and provider_thread_id = btrim(provider_thread_id)
  ),
  kind text not null check (kind in ('pitch_sent', 'human_reply', 'collaboration')),
  status text not null check (status in (
    'pending', 'confirmed', 'dismissed', 'manual_overrides', 'superseded'
  )),
  classifier text not null default 'heuristic' check (classifier = 'heuristic'),
  evidence_key text not null check (char_length(evidence_key) between 1 and 512),
  pitch_at timestamptz,
  reply_at timestamptz,
  pitch_message_id text,
  reply_message_id text,
  commercial_state text,
  source_attempt_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint gmail_collaboration_suggestions_evidence_uidx
    unique (binding_id, kind, evidence_key),
  constraint gmail_collaboration_suggestions_shape check (
    (
      kind = 'pitch_sent'
      and pitch_at is not null
      and pitch_message_id is not null
      and reply_at is null
      and reply_message_id is null
      and commercial_state is null
      and source_attempt_id is null
      and evidence_key = pitch_message_id
    )
    or (
      kind = 'human_reply'
      and reply_at is not null
      and reply_message_id is not null
      and pitch_at is null
      and pitch_message_id is null
      and commercial_state is null
      and source_attempt_id is null
      and evidence_key = reply_message_id
    )
    or (
      kind = 'collaboration'
      and pitch_at is not null
      and reply_at is not null
      and pitch_message_id is not null
      and reply_message_id is not null
      and commercial_state = 'agreement_observed'
      and source_attempt_id is not null
      and evidence_key = pitch_message_id || '|' || reply_message_id || '|' || source_attempt_id::text
    )
  )
);

comment on table public.gmail_collaboration_suggestions is
  'D107 suggestions from a linked Gmail thread. Pending is visible to a paid owner. Confirming a pitch or a human reply uses the existing manual transition. Confirming a collaboration writes no CRM row and no hotel fact. Automated replies are not suggestions. Manual events stay the source of truth.';

create index gmail_collaboration_suggestions_creator_idx
  on public.gmail_collaboration_suggestions (creator_id, status);

create index gmail_collaboration_suggestions_mail_idx
  on public.gmail_collaboration_suggestions (mail_account_id);

create trigger gmail_collaboration_suggestions_set_updated_at
  before update on public.gmail_collaboration_suggestions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Paid gate. Same predicate as migration 0060: active Pro, or any active
-- Destination Pass. Free is paused. Not granted to client roles.
-- ---------------------------------------------------------------------------
create or replace function private.gmail_collab_is_paid(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select p_user_id is not null
    and (
      public._has_active_pro(p_user_id)
      or exists (
        select 1
          from public.access_entitlements e
         where e.user_id = p_user_id
           and e.access_type = 'destination'
           and e.status = 'active'
           and e.starts_at <= pg_catalog.now()
           and (e.expires_at is null or e.expires_at > pg_catalog.now())
      )
    );
$$;

revoke all on function private.gmail_collab_is_paid(uuid)
  from public, anon, authenticated, service_role;

comment on function private.gmail_collab_is_paid(uuid) is
  'True when the user has active Pro or an active Destination Pass. Free is false. SECURITY DEFINER. search_path is pinned empty.';

-- ---------------------------------------------------------------------------
-- Writer fence. Direct writes, including service_role, are refused unless a
-- detection function set the transaction-local flag. Deletes stay open so
-- purge and ON DELETE CASCADE can remove the row.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_gmail_collaboration_writer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_writer text := pg_catalog.current_setting('gmail_collab.writer', true);
  v_item_creator uuid;
  v_binding_creator uuid;
  v_binding_item uuid;
  v_binding_mail uuid;
  v_binding_thread text;
  v_mail_user uuid;
  v_creator_user uuid;
begin
  if v_writer is null or v_writer not in ('refresh', 'confirm', 'dismiss') then
    raise exception 'gmail collaboration suggestions are written by the detection functions'
      using errcode = '42501';
  end if;

  select pi.creator_id into v_item_creator
    from public.pipeline_items pi
   where pi.id = new.pipeline_item_id;
  if v_item_creator is null or v_item_creator is distinct from new.creator_id then
    raise exception 'collaboration suggestion must belong to the pipeline item owner'
      using errcode = '23514';
  end if;

  select b.creator_id, b.pipeline_item_id, b.mail_account_id, b.provider_thread_id
    into v_binding_creator, v_binding_item, v_binding_mail, v_binding_thread
    from public.pipeline_inbox_bindings b
   where b.id = new.binding_id;
  if v_binding_creator is null
     or v_binding_creator is distinct from new.creator_id
     or v_binding_item is distinct from new.pipeline_item_id
     or v_binding_mail is distinct from new.mail_account_id
     or v_binding_thread is distinct from new.provider_thread_id then
    raise exception 'collaboration suggestion must stay on its own inbox link'
      using errcode = '23514';
  end if;

  select m.user_id into v_mail_user
    from public.mail_accounts m
   where m.id = new.mail_account_id;
  select cp.user_id into v_creator_user
    from public.creator_profiles cp
   where cp.id = new.creator_id;
  if v_mail_user is null
     or v_creator_user is null
     or v_mail_user is distinct from v_creator_user then
    raise exception 'collaboration suggestion mailbox must belong to the creator'
      using errcode = '23514';
  end if;

  if v_writer = 'refresh' then
    if tg_op = 'INSERT' and new.status not in ('pending', 'manual_overrides') then
      raise exception 'refresh cannot confirm or dismiss a suggestion'
        using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' then
      if old.status in ('confirmed', 'dismissed')
         and new.status is distinct from old.status then
        raise exception 'refresh cannot reopen a confirmed or dismissed suggestion'
          using errcode = '42501';
      end if;
      if new.creator_id is distinct from old.creator_id
         or new.pipeline_item_id is distinct from old.pipeline_item_id
         or new.binding_id is distinct from old.binding_id
         or new.mail_account_id is distinct from old.mail_account_id
         or new.provider_thread_id is distinct from old.provider_thread_id
         or new.kind is distinct from old.kind
         or new.evidence_key is distinct from old.evidence_key
         or new.classifier is distinct from old.classifier then
        raise exception 'refresh cannot retarget a suggestion'
          using errcode = '42501';
      end if;
    end if;
    return new;
  end if;

  if tg_op <> 'UPDATE' then
    raise exception 'confirm and dismiss only update a pending suggestion'
      using errcode = '42501';
  end if;
  if old.status is distinct from 'pending' then
    raise exception 'only a pending suggestion can be confirmed or dismissed'
      using errcode = '42501';
  end if;
  if new.creator_id is distinct from old.creator_id
     or new.pipeline_item_id is distinct from old.pipeline_item_id
     or new.binding_id is distinct from old.binding_id
     or new.mail_account_id is distinct from old.mail_account_id
     or new.kind is distinct from old.kind
     or new.evidence_key is distinct from old.evidence_key
     or new.classifier is distinct from old.classifier
     or new.pitch_at is distinct from old.pitch_at
     or new.reply_at is distinct from old.reply_at
     or new.pitch_message_id is distinct from old.pitch_message_id
     or new.reply_message_id is distinct from old.reply_message_id
     or new.commercial_state is distinct from old.commercial_state
     or new.source_attempt_id is distinct from old.source_attempt_id then
    raise exception 'confirm and dismiss only change status'
      using errcode = '42501';
  end if;
  if v_writer = 'confirm' and new.status not in ('confirmed', 'manual_overrides') then
    raise exception 'confirm stores confirmed or manual_overrides'
      using errcode = '42501';
  end if;
  if v_writer = 'dismiss' and new.status is distinct from 'dismissed' then
    raise exception 'dismiss stores dismissed'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

comment on function public.enforce_gmail_collaboration_writer() is
  'Rejects a collaboration suggestion write that skips the detection functions or points at another creator. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.enforce_gmail_collaboration_writer()
  from public, anon, authenticated;
grant execute on function public.enforce_gmail_collaboration_writer()
  to service_role;

create trigger gmail_collaboration_suggestions_writer
  before insert or update on public.gmail_collaboration_suggestions
  for each row execute function public.enforce_gmail_collaboration_writer();

alter table public.gmail_collaboration_suggestions enable row level security;

create policy gmail_collaboration_suggestions_select
  on public.gmail_collaboration_suggestions
  for select
  using (creator_id = public.current_creator_id());

revoke all on table public.gmail_collaboration_suggestions
  from public, anon, authenticated;

grant select on table public.gmail_collaboration_suggestions to authenticated;

grant select, insert, update, delete on table public.gmail_collaboration_suggestions
  to service_role;

-- ---------------------------------------------------------------------------
-- Heuristic refresh. No model, no HTTP, no new Gmail scope. Evidence is the
-- existing B05 outreach status, the earliest creator-SENT message, the B06
-- qualifying human reply, and the current non-stale B07 thread state.
-- ---------------------------------------------------------------------------
create or replace function public.refresh_gmail_collaboration_suggestions(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_normalized_thread_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_thread text;
  v_binding uuid;
  v_item uuid;
  v_outreach text;
  v_pitch_id text;
  v_pitch_at timestamptz;
  v_state text;
  v_reply_state text;
  v_reply_at timestamptz;
  v_reply_id text;
  v_reply_tied boolean := false;
  v_axis text;
  v_commercial text;
  v_attempt uuid;
  v_stale boolean;
  v_pitch boolean := false;
  v_human boolean := false;
  v_collab boolean := false;
  v_manual_pitch boolean := false;
  v_manual_reply boolean := false;
  v_manual_collab boolean := false;
  v_collab_key text;
  v_written integer := 0;
begin
  if p_user_id is null or p_mail_account_id is null or p_normalized_thread_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;
  if not private.gmail_collab_is_paid(p_user_id) then
    return jsonb_build_object('result', 'paused', 'suggestions', 0);
  end if;

  select cp.id into v_creator
    from public.creator_profiles cp
   where cp.user_id = p_user_id;
  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  if not exists (
    select 1
      from public.mail_accounts m
     where m.id = p_mail_account_id
       and m.user_id = p_user_id
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  select t.provider_thread_id into v_thread
    from private.gmail_normalized_threads t
   where t.id = p_normalized_thread_id
     and t.mail_account_id = p_mail_account_id
     and t.user_id = p_user_id;
  if v_thread is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select b.id, b.pipeline_item_id
    into v_binding, v_item
    from public.pipeline_inbox_bindings b
   where b.mail_account_id = p_mail_account_id
     and b.provider_thread_id = v_thread
     and b.creator_id = v_creator
   for update;
  if v_binding is null then
    return jsonb_build_object('result', 'no_binding');
  end if;

  select s.outreach_status into v_outreach
    from private.gmail_outreach_thread_signals s
   where s.mail_account_id = p_mail_account_id
     and s.normalized_thread_id = p_normalized_thread_id
     and s.user_id = p_user_id;

  select nm.provider_message_id, nm.internal_date
    into v_pitch_id, v_pitch_at
    from private.gmail_normalized_messages nm
   where nm.mail_account_id = p_mail_account_id
     and nm.normalized_thread_id = p_normalized_thread_id
     and nm.user_id = p_user_id
     and nm.provider_sent
   order by nm.internal_date asc, nm.provider_message_id asc
   limit 1;

  v_pitch := v_outreach = 'qualified_outreach'
    and v_pitch_id is not null
    and v_pitch_at is not null
    and pg_catalog.char_length(v_pitch_id) <= 200;

  select r.observation_state,
         r.first_qualifying_human_reply_at,
         r.first_qualifying_human_reply_provider_message_id,
         r.first_qualifying_human_reply_tied
    into v_reply_state, v_reply_at, v_reply_id, v_reply_tied
    from private.gmail_reply_thread_summaries r
   where r.mail_account_id = p_mail_account_id
     and r.normalized_thread_id = p_normalized_thread_id
     and r.user_id = p_user_id;

  -- A human reply is only a suggestion on a thread that is already a pitch.
  v_human := v_pitch
    and v_reply_state = 'qualifying_human_reply_observed'
    and v_reply_at is not null
    and v_reply_id is not null
    and v_reply_tied is false
    and pg_catalog.char_length(v_reply_id) <= 200;

  if v_human then
    select ma.axis_a_basis into v_axis
      from private.gmail_commercial_message_current mc
      join private.gmail_commercial_message_attempts ma
        on ma.id = mc.current_attempt_id
       and ma.mail_account_id = mc.mail_account_id
       and ma.provider_message_id = mc.provider_message_id
     where mc.mail_account_id = p_mail_account_id
       and mc.provider_message_id = v_reply_id
       and mc.user_id = p_user_id
       and mc.stale = false
       and mc.suppressed = false;
    if v_axis in ('automated', 'delivery', 'not_reply') then
      v_human := false;
    end if;
  end if;

  select a.commercial_state, a.id, c.stale
    into v_commercial, v_attempt, v_stale
    from private.gmail_commercial_thread_current c
    join private.gmail_commercial_thread_attempts a
      on a.id = c.current_attempt_id
     and a.mail_account_id = c.mail_account_id
     and a.provider_thread_id = c.provider_thread_id
   where c.mail_account_id = p_mail_account_id
     and c.provider_thread_id = v_thread
     and c.user_id = p_user_id;

  v_collab_key := case
    when v_pitch and v_human and v_attempt is not null
      then v_pitch_id || '|' || v_reply_id || '|' || v_attempt::text
    else null
  end;
  v_collab := v_pitch
    and v_human
    and v_stale is false
    and v_commercial = 'agreement_observed'
    and v_collab_key is not null
    and pg_catalog.char_length(v_collab_key) <= 512;
  v_pitch := coalesce(v_pitch, false);
  v_human := coalesce(v_human, false);
  v_collab := coalesce(v_collab, false);

  v_manual_pitch := exists (
    select 1
      from public.outreach_events oe
     where oe.pipeline_item_id = v_item
       and oe.event_type = 'pitch_sent'
       and oe.source = 'manual_creator'
  );
  v_manual_reply := exists (
    select 1
      from public.outreach_events oe
     where oe.pipeline_item_id = v_item
       and oe.event_type = 'reply_received'
       and oe.source = 'manual_creator'
  );
  v_manual_collab := exists (
    select 1
      from public.collaborations c
     where c.pipeline_item_id = v_item
  );

  perform pg_catalog.set_config('gmail_collab.writer', 'refresh', true);

  insert into public.gmail_collaboration_suggestions (
    creator_id, pipeline_item_id, binding_id, mail_account_id, provider_thread_id,
    kind, status, classifier, evidence_key,
    pitch_at, reply_at, pitch_message_id, reply_message_id,
    commercial_state, source_attempt_id
  )
  select v_creator, v_item, v_binding, p_mail_account_id, v_thread,
         d.kind, d.status, 'heuristic', d.evidence_key,
         d.pitch_at, d.reply_at, d.pitch_message_id, d.reply_message_id,
         d.commercial_state, d.source_attempt_id
    from (
      select 'pitch_sent'::text as kind,
             case when v_manual_pitch then 'manual_overrides' else 'pending' end as status,
             v_pitch_id as evidence_key,
             v_pitch_at as pitch_at,
             null::timestamptz as reply_at,
             v_pitch_id as pitch_message_id,
             null::text as reply_message_id,
             null::text as commercial_state,
             null::uuid as source_attempt_id
       where v_pitch
      union all
      select 'human_reply'::text,
             case when v_manual_reply then 'manual_overrides' else 'pending' end,
             v_reply_id,
             null::timestamptz,
             v_reply_at,
             null::text,
             v_reply_id,
             null::text,
             null::uuid
       where v_human
      union all
      select 'collaboration'::text,
             case when v_manual_collab then 'manual_overrides' else 'pending' end,
             v_collab_key,
             v_pitch_at,
             v_reply_at,
             v_pitch_id,
             v_reply_id,
             'agreement_observed'::text,
             v_attempt
       where v_collab
    ) d
  on conflict (binding_id, kind, evidence_key) do update
    set status = case
          when public.gmail_collaboration_suggestions.status in ('confirmed', 'dismissed')
            then public.gmail_collaboration_suggestions.status
          when excluded.status = 'manual_overrides' then 'manual_overrides'
          when public.gmail_collaboration_suggestions.status = 'manual_overrides'
            then 'manual_overrides'
          when public.gmail_collaboration_suggestions.status = 'superseded' then 'pending'
          else public.gmail_collaboration_suggestions.status
        end,
        pitch_at = excluded.pitch_at,
        reply_at = excluded.reply_at,
        pitch_message_id = excluded.pitch_message_id,
        reply_message_id = excluded.reply_message_id,
        commercial_state = excluded.commercial_state,
        source_attempt_id = excluded.source_attempt_id,
        updated_at = pg_catalog.now();

  update public.gmail_collaboration_suggestions s
     set status = 'superseded'
   where s.binding_id = v_binding
     and s.status = 'pending'
     and not (
       (v_pitch and s.kind = 'pitch_sent' and s.evidence_key = v_pitch_id)
       or (v_human and s.kind = 'human_reply' and s.evidence_key = v_reply_id)
       or (v_collab and s.kind = 'collaboration' and s.evidence_key = v_collab_key)
     );

  select count(*)::int into v_written
    from public.gmail_collaboration_suggestions s
   where s.binding_id = v_binding
     and s.status = 'pending';

  return jsonb_build_object(
    'result', 'ok',
    'pitch', v_pitch,
    'human_reply', v_human,
    'collaboration', v_collab,
    'pending', v_written
  );
end;
$$;

comment on function public.refresh_gmail_collaboration_suggestions(uuid, uuid, uuid) is
  'Heuristic detection for one stored thread the creator already linked. Free returns paused and writes nothing. No inferred hotel match. No outreach event. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.refresh_gmail_collaboration_suggestions(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.refresh_gmail_collaboration_suggestions(uuid, uuid, uuid)
  to service_role;

create or replace function public.refresh_gmail_collaboration_by_provider_thread(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_provider_thread_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_user_id is null or p_mail_account_id is null or p_provider_thread_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;
  if not private.gmail_collab_is_paid(p_user_id) then
    return jsonb_build_object('result', 'paused', 'suggestions', 0);
  end if;

  select t.id into v_id
    from private.gmail_normalized_threads t
   where t.mail_account_id = p_mail_account_id
     and t.provider_thread_id = p_provider_thread_id
     and t.user_id = p_user_id;
  if v_id is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  return public.refresh_gmail_collaboration_suggestions(
    p_user_id, p_mail_account_id, v_id
  );
end;
$$;

comment on function public.refresh_gmail_collaboration_by_provider_thread(uuid, uuid, text) is
  'Resolves a stored provider thread and runs the heuristic refresh. Free returns paused. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.refresh_gmail_collaboration_by_provider_thread(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.refresh_gmail_collaboration_by_provider_thread(uuid, uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Confirm. Pitch and human reply map onto the existing manual transitions.
-- A manual event of that type is left alone. Collaboration confirmation
-- changes only this row.
-- The engaged-limit argument is the written Free allowance of 5
-- (FREE_LIMITS.activePipelineItems). Pro, and a Pass that covers the hotel,
-- are exempt inside the transition.
-- ---------------------------------------------------------------------------
create or replace function public.confirm_gmail_collaboration_suggestion(
  p_user_id uuid,
  p_pipeline_item_id uuid,
  p_suggestion_id uuid,
  p_sentiment text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_kind text;
  v_status text;
  v_pitch_at timestamptz;
  v_reply_at timestamptz;
  v_pipeline text;
  v_events integer;
  v_collabs integer;
  v_facts integer;
  v_transition jsonb;
  v_gmail_events integer;
begin
  if p_user_id is null or p_pipeline_item_id is null or p_suggestion_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator
    from public.creator_profiles cp
   where cp.user_id = p_user_id;
  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select s.kind, s.status, s.pitch_at, s.reply_at
    into v_kind, v_status, v_pitch_at, v_reply_at
    from public.gmail_collaboration_suggestions s
   where s.id = p_suggestion_id
     and s.pipeline_item_id = p_pipeline_item_id
     and s.creator_id = v_creator
   for update;
  if v_kind is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if not private.gmail_collab_is_paid(p_user_id) then
    return jsonb_build_object('result', 'paused');
  end if;
  if v_status is distinct from 'pending' then
    return jsonb_build_object('result', 'not_pending', 'kind', v_kind);
  end if;

  select pi.status into v_pipeline
    from public.pipeline_items pi
   where pi.id = p_pipeline_item_id
     and pi.creator_id = v_creator
   for update;
  if v_pipeline is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_kind = 'pitch_sent' then
    if exists (
      select 1
        from public.outreach_events oe
       where oe.pipeline_item_id = p_pipeline_item_id
         and oe.event_type = 'pitch_sent'
         and oe.source = 'manual_creator'
    ) then
      perform pg_catalog.set_config('gmail_collab.writer', 'confirm', true);
      update public.gmail_collaboration_suggestions
         set status = 'manual_overrides'
       where id = p_suggestion_id
         and creator_id = v_creator
         and status = 'pending';
      return jsonb_build_object('result', 'manual_overrides', 'kind', v_kind);
    end if;
    v_transition := public.transition_pipeline_item(
      p_user_id, p_pipeline_item_id, 'mark_pitched', v_pitch_at, 'email',
      null, null, null, 5
    );
  elsif v_kind = 'human_reply' then
    if p_sentiment is null or p_sentiment not in ('positive', 'negative', 'unclear') then
      return jsonb_build_object('result', 'invalid_input', 'kind', v_kind);
    end if;
    if exists (
      select 1
        from public.outreach_events oe
       where oe.pipeline_item_id = p_pipeline_item_id
         and oe.event_type = 'reply_received'
         and oe.source = 'manual_creator'
    ) then
      perform pg_catalog.set_config('gmail_collab.writer', 'confirm', true);
      update public.gmail_collaboration_suggestions
         set status = 'manual_overrides'
       where id = p_suggestion_id
         and creator_id = v_creator
         and status = 'pending';
      return jsonb_build_object('result', 'manual_overrides', 'kind', v_kind);
    end if;
    v_transition := public.transition_pipeline_item(
      p_user_id, p_pipeline_item_id, 'mark_replied', v_reply_at, 'email',
      p_sentiment, null, null, 5
    );
  elsif v_kind = 'collaboration' then
    select count(*)::int into v_events
      from public.outreach_events oe
     where oe.pipeline_item_id = p_pipeline_item_id;
    select count(*)::int into v_collabs
      from public.collaborations c
     where c.pipeline_item_id = p_pipeline_item_id;
    select count(*)::int into v_facts
      from private.intelligence_facts f
     where f.owner_user_id = p_user_id
       and f.pipeline_item_id = p_pipeline_item_id;

    perform pg_catalog.set_config('gmail_collab.writer', 'confirm', true);
    update public.gmail_collaboration_suggestions
       set status = 'confirmed'
     where id = p_suggestion_id
       and creator_id = v_creator
       and status = 'pending';

    if exists (
      select 1
        from public.pipeline_items pi
       where pi.id = p_pipeline_item_id
         and pi.status is distinct from v_pipeline
    ) or (select count(*)::int from public.outreach_events oe
           where oe.pipeline_item_id = p_pipeline_item_id) is distinct from v_events
       or (select count(*)::int from public.collaborations c
            where c.pipeline_item_id = p_pipeline_item_id) is distinct from v_collabs
       or (select count(*)::int from private.intelligence_facts f
            where f.owner_user_id = p_user_id
              and f.pipeline_item_id = p_pipeline_item_id) is distinct from v_facts then
      raise exception 'collaboration confirmation changed the ledger'
        using errcode = '23514';
    end if;
    return jsonb_build_object(
      'result', 'confirmed',
      'kind', 'collaboration',
      'pipeline_status', v_pipeline
    );
  else
    return jsonb_build_object('result', 'invalid_input');
  end if;

  if v_transition ->> 'result' = 'applied' then
    select count(*)::int into v_gmail_events
      from public.outreach_events oe
     where oe.pipeline_item_id = p_pipeline_item_id
       and oe.source = 'gmail';
    if v_gmail_events <> 0 then
      raise exception 'gmail detection must not write a gmail-sourced event'
        using errcode = '23514';
    end if;
    perform pg_catalog.set_config('gmail_collab.writer', 'confirm', true);
    update public.gmail_collaboration_suggestions
       set status = 'confirmed'
     where id = p_suggestion_id
       and creator_id = v_creator
       and status = 'pending';
  elsif v_transition ->> 'result' = 'already_applied' then
    perform pg_catalog.set_config('gmail_collab.writer', 'confirm', true);
    update public.gmail_collaboration_suggestions
       set status = 'manual_overrides'
     where id = p_suggestion_id
       and creator_id = v_creator
       and status = 'pending';
  end if;

  return v_transition || jsonb_build_object('kind', v_kind, 'suggestion_id', p_suggestion_id);
end;
$$;

comment on function public.confirm_gmail_collaboration_suggestion(uuid, uuid, uuid, text) is
  'Creator confirmation. Pitch and human reply call the existing manual transitions and do not copy a machine sentiment. An existing manual event wins. Collaboration confirmation writes no event, no collaboration, and no fact. Free returns paused. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.confirm_gmail_collaboration_suggestion(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.confirm_gmail_collaboration_suggestion(uuid, uuid, uuid, text)
  to service_role;

create or replace function public.dismiss_gmail_collaboration_suggestion(
  p_user_id uuid,
  p_pipeline_item_id uuid,
  p_suggestion_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_status text;
  v_events integer;
begin
  if p_user_id is null or p_pipeline_item_id is null or p_suggestion_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator
    from public.creator_profiles cp
   where cp.user_id = p_user_id;
  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select s.status into v_status
    from public.gmail_collaboration_suggestions s
   where s.id = p_suggestion_id
     and s.pipeline_item_id = p_pipeline_item_id
     and s.creator_id = v_creator
   for update;
  if v_status is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if not private.gmail_collab_is_paid(p_user_id) then
    return jsonb_build_object('result', 'paused');
  end if;
  if v_status is distinct from 'pending' then
    return jsonb_build_object('result', 'not_pending');
  end if;

  select count(*)::int into v_events
    from public.outreach_events oe
   where oe.pipeline_item_id = p_pipeline_item_id;

  perform pg_catalog.set_config('gmail_collab.writer', 'dismiss', true);
  update public.gmail_collaboration_suggestions
     set status = 'dismissed'
   where id = p_suggestion_id
     and creator_id = v_creator
     and status = 'pending';

  if (select count(*)::int from public.outreach_events oe
       where oe.pipeline_item_id = p_pipeline_item_id) is distinct from v_events then
    raise exception 'dismiss wrote an outreach event'
      using errcode = '23514';
  end if;

  return jsonb_build_object('result', 'dismissed', 'suggestion_id', p_suggestion_id);
end;
$$;

comment on function public.dismiss_gmail_collaboration_suggestion(uuid, uuid, uuid) is
  'Dismisses one pending suggestion. Writes no outreach event. A later refresh of the same evidence does not reopen it. Free returns paused. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.dismiss_gmail_collaboration_suggestion(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.dismiss_gmail_collaboration_suggestion(uuid, uuid, uuid)
  to service_role;

create or replace function public.read_gmail_collaboration_suggestions(
  p_pipeline_item_id uuid
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
  v_rows jsonb;
begin
  if v_user is null or p_pipeline_item_id is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if not private.gmail_collab_is_paid(v_user) then
    return jsonb_build_object('result', 'paused', 'suggestions', '[]'::jsonb);
  end if;

  select cp.id into v_creator
    from public.creator_profiles cp
   where cp.user_id = v_user;
  if v_creator is null or not exists (
    select 1
      from public.pipeline_items pi
     where pi.id = p_pipeline_item_id
       and pi.creator_id = v_creator
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id,
           'kind', s.kind
         ) order by s.kind, s.id), '[]'::jsonb)
    into v_rows
    from public.gmail_collaboration_suggestions s
   where s.pipeline_item_id = p_pipeline_item_id
     and s.creator_id = v_creator
     and s.status = 'pending';

  return jsonb_build_object('result', 'ok', 'suggestions', v_rows);
end;
$$;

comment on function public.read_gmail_collaboration_suggestions(uuid) is
  'Pending suggestions for the signed-in owner. Free returns paused and no ids. Another creator gets not_found. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.read_gmail_collaboration_suggestions(uuid)
  from public, anon;
grant execute on function public.read_gmail_collaboration_suggestions(uuid)
  to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- The existing deletion purge already calls this function. Suggestions leave
-- with the mailbox's other Gmail-derived rows. Manual events are not here.
-- ---------------------------------------------------------------------------
create or replace function private.purge_network_gmail_for_mailbox(p_mail_account_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_mail_account_id is null then
    return;
  end if;
  delete from private.intelligence_facts
   where mail_account_id = p_mail_account_id
     and source_family = 'gmail';
  delete from private.intelligence_gmail_confirmations
   where mail_account_id = p_mail_account_id;
  delete from public.gmail_collaboration_suggestions
   where mail_account_id = p_mail_account_id;
end;
$$;

revoke all on function private.purge_network_gmail_for_mailbox(uuid)
  from public, anon, authenticated, service_role;

comment on function private.purge_network_gmail_for_mailbox(uuid) is
  'Deletes Gmail network facts, Gmail confirmations, and Gmail collaboration suggestions bound to one mailbox. Manual facts and manual outreach events are not bound here. Called by every Gmail deletion purge and by the mailbox deleted transition.';
