-- 0049 — D06 inbox and pipeline stay one creator-owned record (D080, Accepted, Brian, 13 Oct 2026).
--
-- Migration number: 0049. 0050 is D07 on main and is not edited.
-- 0047 and 0048 are B08, merged. This file is additive.
--
-- pipeline_items.status is the only CRM status. A Gmail reading is copied
-- beside an explicit creator link as a suggestion. Refresh never calls
-- transition_pipeline_item or progress_pipeline_deal. A redirect is not a
-- rejection. Silence is not ghosted. Accepting a review does not close a
-- cycle and does not create a collaboration.

-- ---------------------------------------------------------------------------
-- Current link. One pipeline item, one stored thread. History is not a
-- second status: unbinding deletes the current link and leaves the pipeline
-- row where the creator put it.
-- ---------------------------------------------------------------------------
create table public.pipeline_inbox_bindings (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  pipeline_item_id uuid not null references public.pipeline_items(id) on delete cascade,
  mail_account_id uuid not null references public.mail_accounts(id) on delete cascade,
  provider_thread_id text not null check (
    char_length(provider_thread_id) between 1 and 256
    and provider_thread_id = btrim(provider_thread_id)
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pipeline_inbox_bindings_item_uidx unique (pipeline_item_id),
  constraint pipeline_inbox_bindings_thread_uidx unique (mail_account_id, provider_thread_id)
);

comment on table public.pipeline_inbox_bindings is
  'D080 creator link between one pipeline cycle and one stored Gmail thread. Not inferred from a hotel name or a recipient. Deleting the link does not change pipeline status.';

create index pipeline_inbox_bindings_creator_idx
  on public.pipeline_inbox_bindings (creator_id);

create trigger pipeline_inbox_bindings_set_updated_at
  before update on public.pipeline_inbox_bindings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Copy of the current non-stale B07 advisory label. No message body.
-- ---------------------------------------------------------------------------
create table public.pipeline_inbox_readings (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  pipeline_item_id uuid not null references public.pipeline_items(id) on delete cascade,
  binding_id uuid not null references public.pipeline_inbox_bindings(id) on delete cascade,
  source_attempt_id uuid not null,
  commercial_state text,
  rule_version text not null check (char_length(rule_version) between 1 and 64),
  has_redirect boolean not null,
  has_rejection boolean not null,
  has_human_reply boolean not null,
  decline_supported boolean not null,
  stale boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pipeline_inbox_readings_binding_uidx unique (binding_id),
  constraint pipeline_inbox_readings_state_vocab check (
    commercial_state is null
    or commercial_state in (
      'unresolved','engaged','negotiating','agreement_observed','declined_observed','ambiguous'
    )
  ),
  constraint pipeline_inbox_readings_decline_shape check (
    decline_supported = false
    or (
      commercial_state = 'declined_observed'
      and has_rejection
      and has_redirect = false
    )
  )
);

comment on table public.pipeline_inbox_readings is
  'D080 copy of the current B07 advisory label for a linked thread. A suggestion source, not CRM state. No message body is stored here.';

comment on column public.pipeline_inbox_readings.has_human_reply is
  'True when a current non-stale message is an effective human reply under B07 section 15. A creator reply-nature of automated, delivery, or not_reply suppresses it.';

comment on column public.pipeline_inbox_readings.decline_supported is
  'True only when the latest current non-sent message carries rejection and does not carry redirect or timing_constraint, and the thread has no redirect. A redirect is not a rejection.';

create index pipeline_inbox_readings_creator_idx
  on public.pipeline_inbox_readings (creator_id);

create trigger pipeline_inbox_readings_set_updated_at
  before update on public.pipeline_inbox_readings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Suggestions. Review kinds cannot apply CRM. Dismissed and accepted rows
-- for one machine attempt are not reopened by a later refresh of that attempt.
-- ---------------------------------------------------------------------------
create table public.pipeline_inbox_suggestions (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  pipeline_item_id uuid not null references public.pipeline_items(id) on delete cascade,
  binding_id uuid not null references public.pipeline_inbox_bindings(id) on delete cascade,
  kind text not null check (kind in (
    'mark_replied','open_negotiation','review_agreement','review_decline'
  )),
  status text not null check (status in (
    'pending','dismissed','accepted','creator_overrides','superseded'
  )),
  applies_crm boolean not null,
  basis text not null check (basis in (
    'human_reply','negotiating','agreement_observed','rejection'
  )),
  source_attempt_id uuid not null,
  source_commercial_state text,
  rule_version text not null check (char_length(rule_version) between 1 and 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pipeline_inbox_suggestions_attempt_kind_uidx
    unique (binding_id, source_attempt_id, kind),
  constraint pipeline_inbox_suggestions_apply_shape check (
    (kind in ('mark_replied','open_negotiation') and applies_crm)
    or (kind in ('review_agreement','review_decline') and not applies_crm)
  ),
  constraint pipeline_inbox_suggestions_basis_shape check (
    (kind = 'mark_replied' and basis = 'human_reply')
    or (kind = 'open_negotiation' and basis = 'negotiating')
    or (kind = 'review_agreement' and basis = 'agreement_observed')
    or (kind = 'review_decline' and basis = 'rejection')
  ),
  constraint pipeline_inbox_suggestions_state_vocab check (
    source_commercial_state is null
    or source_commercial_state in (
      'unresolved','engaged','negotiating','agreement_observed','declined_observed','ambiguous'
    )
  )
);

comment on table public.pipeline_inbox_suggestions is
  'D080 machine proposals for one linked thread. Pending is visible. Accepted mark_replied or open_negotiation is the creator choosing an existing CRM transition. Review acceptance records that the creator saw the reading and writes no CRM row.';

create index pipeline_inbox_suggestions_creator_idx
  on public.pipeline_inbox_suggestions (creator_id, status);

create trigger pipeline_inbox_suggestions_set_updated_at
  before update on public.pipeline_inbox_suggestions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Same-creator fence. Fires for every writer, including service_role.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_pipeline_inbox_same_creator()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_item_creator uuid;
  v_binding_creator uuid;
  v_binding_item uuid;
  v_mail uuid;
  v_thread text;
  v_mail_user uuid;
  v_creator_user uuid;
  v_attempt uuid;
begin
  select pi.creator_id into v_item_creator
    from public.pipeline_items pi
   where pi.id = new.pipeline_item_id;

  if v_item_creator is null or v_item_creator is distinct from new.creator_id then
    raise exception 'inbox link must belong to the pipeline item owner'
      using errcode = '23514';
  end if;

  if tg_table_name = 'pipeline_inbox_bindings' then
    v_mail := new.mail_account_id;
    v_thread := new.provider_thread_id;
    select m.user_id into v_mail_user
      from public.mail_accounts m
     where m.id = v_mail;
    select cp.user_id into v_creator_user
      from public.creator_profiles cp
     where cp.id = new.creator_id;
    if v_mail_user is null
       or v_creator_user is null
       or v_mail_user is distinct from v_creator_user
       or not exists (
         select 1
           from private.gmail_normalized_threads t
          where t.mail_account_id = v_mail
            and t.provider_thread_id = v_thread
            and t.user_id = v_creator_user
       ) then
      raise exception 'inbox link must name this creator''s own stored thread'
        using errcode = '23514';
    end if;
    return new;
  end if;

  select b.creator_id, b.pipeline_item_id, b.mail_account_id, b.provider_thread_id
    into v_binding_creator, v_binding_item, v_mail, v_thread
    from public.pipeline_inbox_bindings b
   where b.id = new.binding_id;

  if v_binding_creator is null
     or v_binding_creator is distinct from new.creator_id
     or v_binding_item is distinct from new.pipeline_item_id then
    raise exception 'inbox reading must stay on its own binding'
      using errcode = '23514';
  end if;

  v_attempt := new.source_attempt_id;
  select cp.user_id into v_creator_user
    from public.creator_profiles cp
   where cp.id = new.creator_id;
  select m.user_id into v_mail_user
    from public.mail_accounts m
   where m.id = v_mail;

  if v_mail_user is null
     or v_creator_user is null
     or v_mail_user is distinct from v_creator_user
     or not exists (
       select 1
         from private.gmail_commercial_thread_attempts a
        where a.id = v_attempt
          and a.mail_account_id = v_mail
          and a.provider_thread_id = v_thread
          and a.user_id = v_creator_user
     ) then
    raise exception 'inbox reading must cite this creator''s own machine attempt'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.enforce_pipeline_inbox_same_creator() is
  'Rejects an inbox link, reading, or suggestion whose creator, pipeline item, mailbox, or machine attempt disagree. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.enforce_pipeline_inbox_same_creator()
  from public, anon, authenticated;
grant execute on function public.enforce_pipeline_inbox_same_creator()
  to service_role;

create trigger pipeline_inbox_bindings_same_creator
  before insert or update on public.pipeline_inbox_bindings
  for each row execute function public.enforce_pipeline_inbox_same_creator();

create trigger pipeline_inbox_readings_same_creator
  before insert or update on public.pipeline_inbox_readings
  for each row execute function public.enforce_pipeline_inbox_same_creator();

create trigger pipeline_inbox_suggestions_same_creator
  before insert or update on public.pipeline_inbox_suggestions
  for each row execute function public.enforce_pipeline_inbox_same_creator();

-- ---------------------------------------------------------------------------
-- Writer gate. Direct table writes, including service_role, are refused
-- unless the reconciliation functions set the transaction-local flag.
-- Deletes stay open so unbind and ON DELETE CASCADE can remove the link.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_pipeline_inbox_writer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_writer text := current_setting('inbox_pipeline.writer', true);
begin
  if tg_table_name = 'pipeline_inbox_bindings' then
    if v_writer is distinct from 'bind' then
      raise exception 'pipeline inbox bindings are written by bind_pipeline_inbox_thread'
        using errcode = '42501';
    end if;
    if tg_op = 'UPDATE'
       and (
         new.creator_id is distinct from old.creator_id
         or new.pipeline_item_id is distinct from old.pipeline_item_id
         or new.mail_account_id is distinct from old.mail_account_id
         or new.provider_thread_id is distinct from old.provider_thread_id
       ) then
      raise exception 'a pipeline inbox binding is not retargeted'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if tg_table_name = 'pipeline_inbox_readings' then
    if v_writer is distinct from 'refresh' then
      raise exception 'pipeline inbox readings are written by refresh'
        using errcode = '42501';
    end if;
    return new;
  end if;

  if v_writer is null or v_writer not in ('refresh','accept','dismiss') then
    raise exception 'pipeline inbox suggestions are written by the reconciliation functions'
      using errcode = '42501';
  end if;

  if v_writer = 'refresh' then
    if tg_op = 'INSERT' and new.status not in ('pending','creator_overrides') then
      raise exception 'refresh may only open a pending or creator-overridden suggestion'
        using errcode = '42501';
    end if;
    if tg_op = 'UPDATE' then
      if old.status in ('dismissed','accepted') then
        raise exception 'refresh cannot reopen a creator decision'
          using errcode = '42501';
      end if;
      if new.status not in ('pending','creator_overrides','superseded') then
        raise exception 'refresh cannot dismiss or accept a suggestion'
          using errcode = '42501';
      end if;
    end if;
  elsif v_writer = 'dismiss' then
    if tg_op <> 'UPDATE'
       or old.status <> 'pending'
       or new.status <> 'dismissed'
       or new.kind is distinct from old.kind
       or new.applies_crm is distinct from old.applies_crm
       or new.binding_id is distinct from old.binding_id
       or new.pipeline_item_id is distinct from old.pipeline_item_id
       or new.creator_id is distinct from old.creator_id
       or new.source_attempt_id is distinct from old.source_attempt_id then
      raise exception 'dismiss only moves a pending suggestion to dismissed'
        using errcode = '42501';
    end if;
  else
    if tg_op <> 'UPDATE'
       or old.status <> 'pending'
       or new.status not in ('accepted','creator_overrides')
       or new.kind is distinct from old.kind
       or new.applies_crm is distinct from old.applies_crm
       or new.binding_id is distinct from old.binding_id
       or new.pipeline_item_id is distinct from old.pipeline_item_id
       or new.creator_id is distinct from old.creator_id
       or new.source_attempt_id is distinct from old.source_attempt_id then
      raise exception 'accept only closes a pending suggestion'
        using errcode = '42501';
    end if;
  end if;

  -- A superseded decline is a retirement, not a live suggestion. Refresh
  -- clears decline_supported before it marks the old pending row superseded.
  -- Any other status still requires a rejection that is not a redirect.
  if new.kind = 'review_decline'
     and new.status is distinct from 'superseded'
     and not exists (
       select 1
         from public.pipeline_inbox_readings r
        where r.binding_id = new.binding_id
          and r.decline_supported
     ) then
    raise exception 'a decline suggestion requires a rejection that is not a redirect'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.enforce_pipeline_inbox_writer() is
  'Refuses inbox-link writes that did not come from the reconciliation functions. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.enforce_pipeline_inbox_writer()
  from public, anon, authenticated;
grant execute on function public.enforce_pipeline_inbox_writer()
  to service_role;

create trigger pipeline_inbox_bindings_writer
  before insert or update on public.pipeline_inbox_bindings
  for each row execute function public.enforce_pipeline_inbox_writer();

create trigger pipeline_inbox_readings_writer
  before insert or update on public.pipeline_inbox_readings
  for each row execute function public.enforce_pipeline_inbox_writer();

create trigger pipeline_inbox_suggestions_writer
  before insert or update on public.pipeline_inbox_suggestions
  for each row execute function public.enforce_pipeline_inbox_writer();

-- A pipeline item cannot change owner while an inbox link hangs off it.
create or replace function public.enforce_pipeline_inbox_item_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.creator_id is distinct from old.creator_id
     and exists (
       select 1 from public.pipeline_inbox_bindings b
        where b.pipeline_item_id = new.id
     ) then
    raise exception 'pipeline owner cannot change while an inbox link exists'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

comment on function public.enforce_pipeline_inbox_item_owner() is
  'Rejects a pipeline_items.creator_id change that would detach an inbox link. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.enforce_pipeline_inbox_item_owner()
  from public, anon, authenticated;
grant execute on function public.enforce_pipeline_inbox_item_owner()
  to service_role;

create trigger pipeline_items_inbox_owner
  before update of creator_id on public.pipeline_items
  for each row execute function public.enforce_pipeline_inbox_item_owner();

-- ---------------------------------------------------------------------------
-- RLS. Authenticated may SELECT own rows. Writes are the RPCs below.
-- ---------------------------------------------------------------------------
alter table public.pipeline_inbox_bindings enable row level security;
alter table public.pipeline_inbox_readings enable row level security;
alter table public.pipeline_inbox_suggestions enable row level security;

create policy pipeline_inbox_bindings_all
  on public.pipeline_inbox_bindings
  for all
  using (creator_id = public.current_creator_id())
  with check (creator_id = public.current_creator_id());

create policy pipeline_inbox_readings_all
  on public.pipeline_inbox_readings
  for all
  using (creator_id = public.current_creator_id())
  with check (creator_id = public.current_creator_id());

create policy pipeline_inbox_suggestions_all
  on public.pipeline_inbox_suggestions
  for all
  using (creator_id = public.current_creator_id())
  with check (creator_id = public.current_creator_id());

revoke all on table
  public.pipeline_inbox_bindings,
  public.pipeline_inbox_readings,
  public.pipeline_inbox_suggestions
  from public, anon, authenticated;

grant select on table
  public.pipeline_inbox_bindings,
  public.pipeline_inbox_readings,
  public.pipeline_inbox_suggestions
  to authenticated;

grant select, insert, update, delete on table
  public.pipeline_inbox_bindings,
  public.pipeline_inbox_readings,
  public.pipeline_inbox_suggestions
  to service_role;

-- ---------------------------------------------------------------------------
-- Suggestion sync. Caller holds the pipeline-item and binding locks.
-- This function does not call a CRM transition.
-- ---------------------------------------------------------------------------
create or replace function public._pipeline_inbox_sync_suggestions(p_binding_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_item uuid;
  v_mail uuid;
  v_thread text;
  v_user uuid;
  v_connection text;
  v_attempt uuid;
  v_state text;
  v_rule text;
  v_stale boolean;
  v_has_redirect boolean := false;
  v_has_rejection boolean := false;
  v_has_human boolean := false;
  v_decline boolean := false;
  v_latest text[];
  v_status text;
  v_kinds text[] := '{}';
  v_kind text;
  v_suggestion_status text;
  v_applies boolean;
  v_basis text;
begin
  select b.creator_id, b.pipeline_item_id, b.mail_account_id, b.provider_thread_id
    into v_creator, v_item, v_mail, v_thread
    from public.pipeline_inbox_bindings b
   where b.id = p_binding_id
   for update;

  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select cp.user_id into v_user
    from public.creator_profiles cp
   where cp.id = v_creator;

  select m.connection_state into v_connection
    from public.mail_accounts m
   where m.id = v_mail
     and m.user_id = v_user
   for update;

  if v_connection is null or v_connection in ('deleted','deletion_pending') then
    return jsonb_build_object('result', 'mailbox_unavailable');
  end if;

  select pi.status into v_status
    from public.pipeline_items pi
   where pi.id = v_item
     and pi.creator_id = v_creator
   for update;

  if v_status is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select c.stale, c.current_attempt_id, a.commercial_state, a.rule_version
    into v_stale, v_attempt, v_state, v_rule
    from private.gmail_commercial_thread_current c
    join private.gmail_commercial_thread_attempts a
      on a.id = c.current_attempt_id
     and a.mail_account_id = c.mail_account_id
     and a.provider_thread_id = c.provider_thread_id
   where c.mail_account_id = v_mail
     and c.provider_thread_id = v_thread
     and c.user_id = v_user;

  if v_attempt is null then
    return jsonb_build_object('result', 'no_reading');
  end if;

  perform set_config('inbox_pipeline.writer', 'refresh', true);

  if v_stale then
    update public.pipeline_inbox_readings
       set stale = true
     where binding_id = p_binding_id
       and creator_id = v_creator;
    return jsonb_build_object('result', 'stale');
  end if;

  select exists (
    select 1
      from private.gmail_commercial_message_current mc
      join private.gmail_commercial_message_attempts ma
        on ma.id = mc.current_attempt_id
       and ma.mail_account_id = mc.mail_account_id
       and ma.provider_message_id = mc.provider_message_id
     where mc.mail_account_id = v_mail
       and mc.provider_thread_id = v_thread
       and mc.user_id = v_user
       and mc.stale = false
       and mc.suppressed = false
       and 'redirect' = any (ma.signals)
  ) into v_has_redirect;

  select exists (
    select 1
      from private.gmail_commercial_message_current mc
      join private.gmail_commercial_message_attempts ma
        on ma.id = mc.current_attempt_id
       and ma.mail_account_id = mc.mail_account_id
       and ma.provider_message_id = mc.provider_message_id
     where mc.mail_account_id = v_mail
       and mc.provider_thread_id = v_thread
       and mc.user_id = v_user
       and mc.stale = false
       and mc.suppressed = false
       and 'rejection' = any (ma.signals)
  ) into v_has_rejection;

  -- Effective human reply is B07 §15: a creator reply-nature of human_reply
  -- counts; automated, delivery, and not_reply suppress; otherwise a current
  -- B06 qualifying_human_reply counts. Axis "none" is the ordinary case.
  select exists (
    select 1
      from private.gmail_commercial_message_current mc
      join private.gmail_commercial_message_attempts ma
        on ma.id = mc.current_attempt_id
       and ma.mail_account_id = mc.mail_account_id
       and ma.provider_message_id = mc.provider_message_id
      join private.gmail_normalized_messages nm
        on nm.mail_account_id = mc.mail_account_id
       and nm.provider_message_id = mc.provider_message_id
     where mc.mail_account_id = v_mail
       and mc.provider_thread_id = v_thread
       and mc.user_id = v_user
       and mc.stale = false
       and mc.suppressed = false
       and nm.provider_sent = false
       and (
         ma.axis_a_basis = 'human_reply'
         or (
           ma.axis_a_basis not in ('automated', 'delivery', 'not_reply')
           and ma.b06_response_class = 'qualifying_human_reply'
           and exists (
             select 1
               from private.gmail_reply_message_observations o
              where o.id = ma.b06_observation_id
                and o.current_normalized_message_id is not null
           )
         )
       )
  ) into v_has_human;

  select ma.signals into v_latest
    from private.gmail_commercial_message_current mc
    join private.gmail_commercial_message_attempts ma
      on ma.id = mc.current_attempt_id
     and ma.mail_account_id = mc.mail_account_id
     and ma.provider_message_id = mc.provider_message_id
    join private.gmail_normalized_messages nm
      on nm.mail_account_id = mc.mail_account_id
     and nm.provider_message_id = mc.provider_message_id
   where mc.mail_account_id = v_mail
     and mc.provider_thread_id = v_thread
     and mc.user_id = v_user
     and mc.stale = false
     and mc.suppressed = false
     and nm.provider_sent = false
   order by nm.internal_date desc, mc.provider_message_id desc
   limit 1;

  v_decline :=
    coalesce(v_state, '') = 'declined_observed'
    and v_latest is not null
    and coalesce('rejection' = any (v_latest), false)
    and not coalesce('redirect' = any (v_latest), false)
    and not coalesce('timing_constraint' = any (v_latest), false)
    and v_has_redirect = false;

  -- A bare text after || is parsed as an array literal when search_path is
  -- empty, so each kind is appended as an element.
  if v_has_human and v_state in (
    'unresolved','engaged','negotiating','agreement_observed','declined_observed'
  ) then
    v_kinds := array_append(v_kinds, 'mark_replied');
  end if;
  if v_state = 'negotiating' then
    v_kinds := array_append(v_kinds, 'open_negotiation');
  end if;
  if v_state = 'agreement_observed' then
    v_kinds := array_append(v_kinds, 'review_agreement');
  end if;
  if v_decline then
    v_kinds := array_append(v_kinds, 'review_decline');
  end if;

  insert into public.pipeline_inbox_readings (
    creator_id, pipeline_item_id, binding_id, source_attempt_id, commercial_state,
    rule_version, has_redirect, has_rejection, has_human_reply, decline_supported, stale
  ) values (
    v_creator, v_item, p_binding_id, v_attempt, v_state,
    v_rule, v_has_redirect, v_has_rejection, v_has_human, v_decline, false
  )
  on conflict on constraint pipeline_inbox_readings_binding_uidx
  do update set
    source_attempt_id = excluded.source_attempt_id,
    commercial_state = excluded.commercial_state,
    rule_version = excluded.rule_version,
    has_redirect = excluded.has_redirect,
    has_rejection = excluded.has_rejection,
    has_human_reply = excluded.has_human_reply,
    decline_supported = excluded.decline_supported,
    stale = false,
    pipeline_item_id = excluded.pipeline_item_id,
    creator_id = excluded.creator_id
  where public.pipeline_inbox_readings.binding_id = excluded.binding_id
    and public.pipeline_inbox_readings.creator_id = excluded.creator_id;

  foreach v_kind in array v_kinds loop
    v_applies := v_kind in ('mark_replied','open_negotiation');
    v_basis := case v_kind
      when 'mark_replied' then 'human_reply'
      when 'open_negotiation' then 'negotiating'
      when 'review_agreement' then 'agreement_observed'
      else 'rejection'
    end;
    v_suggestion_status := case
      when v_kind = 'mark_replied' and v_status in ('replied','negotiating','won','closed')
        then 'creator_overrides'
      when v_kind = 'open_negotiation' and v_status in ('negotiating','won','closed')
        then 'creator_overrides'
      when v_kind = 'review_agreement' and v_status in ('won','closed')
        then 'creator_overrides'
      when v_kind = 'review_decline' and v_status = 'closed'
        then 'creator_overrides'
      else 'pending'
    end;

    insert into public.pipeline_inbox_suggestions (
      creator_id, pipeline_item_id, binding_id, kind, status, applies_crm, basis,
      source_attempt_id, source_commercial_state, rule_version
    ) values (
      v_creator, v_item, p_binding_id, v_kind, v_suggestion_status, v_applies, v_basis,
      v_attempt, v_state, v_rule
    )
    on conflict on constraint pipeline_inbox_suggestions_attempt_kind_uidx
    do update set
      status = case
        when public.pipeline_inbox_suggestions.status in ('dismissed','accepted','creator_overrides')
          then public.pipeline_inbox_suggestions.status
        else excluded.status
      end,
      source_commercial_state = excluded.source_commercial_state,
      rule_version = excluded.rule_version,
      applies_crm = excluded.applies_crm,
      basis = excluded.basis
    where public.pipeline_inbox_suggestions.status in ('pending','creator_overrides','superseded')
      and public.pipeline_inbox_suggestions.creator_id = excluded.creator_id
      and public.pipeline_inbox_suggestions.binding_id = excluded.binding_id;
  end loop;

  update public.pipeline_inbox_suggestions
     set status = 'superseded'
   where binding_id = p_binding_id
     and creator_id = v_creator
     and status = 'pending'
     and not (source_attempt_id = v_attempt and kind = any (v_kinds));

  return jsonb_build_object('result', 'refreshed', 'pipeline_status', v_status);
end;
$$;

comment on function public._pipeline_inbox_sync_suggestions(uuid) is
  'Copies the current B07 advisory label into suggestion rows for one binding. Does not write pipeline_items, outreach_events, or collaborations. Not granted to client roles. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public._pipeline_inbox_sync_suggestions(uuid)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Public writers. Identity is the user id the server resolved from the session.
-- A missing id and another creator's id return the same not_found.
-- ---------------------------------------------------------------------------
create or replace function public.bind_pipeline_inbox_thread(
  p_user_id uuid,
  p_pipeline_item_id uuid,
  p_mail_account_id uuid,
  p_provider_thread_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_connection text;
  v_binding uuid;
  v_existing_thread text;
  v_existing_mail uuid;
begin
  if p_user_id is null or p_pipeline_item_id is null or p_mail_account_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;
  if p_provider_thread_id is null
     or char_length(btrim(p_provider_thread_id)) < 1
     or char_length(btrim(p_provider_thread_id)) > 256
     or p_provider_thread_id is distinct from btrim(p_provider_thread_id) then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator
    from public.creator_profiles cp
   where cp.user_id = p_user_id;
  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  perform 1 from public.creator_profiles where id = v_creator for update;

  if not exists (
    select 1 from public.pipeline_items pi
     where pi.id = p_pipeline_item_id
       and pi.creator_id = v_creator
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  perform 1
    from public.pipeline_items pi
   where pi.id = p_pipeline_item_id
     and pi.creator_id = v_creator
   for update;

  select m.connection_state into v_connection
    from public.mail_accounts m
   where m.id = p_mail_account_id
     and m.user_id = p_user_id;

  if v_connection is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_connection <> 'connected' then
    return jsonb_build_object('result', 'mailbox_not_connected');
  end if;

  if not exists (
    select 1
      from private.gmail_normalized_threads t
     where t.mail_account_id = p_mail_account_id
       and t.provider_thread_id = p_provider_thread_id
       and t.user_id = p_user_id
  ) then
    return jsonb_build_object('result', 'thread_not_stored');
  end if;

  select b.id, b.provider_thread_id, b.mail_account_id
    into v_binding, v_existing_thread, v_existing_mail
    from public.pipeline_inbox_bindings b
   where b.pipeline_item_id = p_pipeline_item_id
     and b.creator_id = v_creator;

  if v_binding is not null then
    if v_existing_thread = p_provider_thread_id and v_existing_mail = p_mail_account_id then
      return jsonb_build_object('result', 'already_bound');
    end if;
    return jsonb_build_object('result', 'item_already_bound');
  end if;

  if exists (
    select 1
      from public.pipeline_inbox_bindings b
     where b.mail_account_id = p_mail_account_id
       and b.provider_thread_id = p_provider_thread_id
  ) then
    return jsonb_build_object('result', 'thread_already_bound');
  end if;

  perform set_config('inbox_pipeline.writer', 'bind', true);
  begin
    insert into public.pipeline_inbox_bindings (
      creator_id, pipeline_item_id, mail_account_id, provider_thread_id
    ) values (
      v_creator, p_pipeline_item_id, p_mail_account_id, p_provider_thread_id
    )
    returning id into v_binding;
  exception
    when unique_violation then
      if exists (
        select 1
          from public.pipeline_inbox_bindings b
         where b.pipeline_item_id = p_pipeline_item_id
           and b.mail_account_id = p_mail_account_id
           and b.provider_thread_id = p_provider_thread_id
      ) then
        return jsonb_build_object('result', 'already_bound');
      end if;
      if exists (
        select 1 from public.pipeline_inbox_bindings b
         where b.pipeline_item_id = p_pipeline_item_id
      ) then
        return jsonb_build_object('result', 'item_already_bound');
      end if;
      return jsonb_build_object('result', 'thread_already_bound');
  end;

  return public._pipeline_inbox_sync_suggestions(v_binding)
    || jsonb_build_object('binding_id', v_binding);
end;
$$;

comment on function public.bind_pipeline_inbox_thread(uuid, uuid, uuid, text) is
  'Links one owned pipeline item to one stored thread on a connected mailbox the same creator owns. Does not change pipeline status. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.bind_pipeline_inbox_thread(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.bind_pipeline_inbox_thread(uuid, uuid, uuid, text)
  to service_role;

create or replace function public.unbind_pipeline_inbox_thread(
  p_user_id uuid,
  p_pipeline_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_status text;
  v_deleted integer;
begin
  if p_user_id is null or p_pipeline_item_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator
    from public.creator_profiles cp
   where cp.user_id = p_user_id;
  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  perform 1 from public.creator_profiles where id = v_creator for update;

  select pi.status into v_status
    from public.pipeline_items pi
   where pi.id = p_pipeline_item_id
     and pi.creator_id = v_creator
   for update;

  if v_status is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  delete from public.pipeline_inbox_bindings b
   where b.pipeline_item_id = p_pipeline_item_id
     and b.creator_id = v_creator;
  get diagnostics v_deleted = row_count;

  if v_deleted = 0 then
    return jsonb_build_object('result', 'not_bound', 'pipeline_status', v_status);
  end if;
  return jsonb_build_object('result', 'unbound', 'pipeline_status', v_status);
end;
$$;

comment on function public.unbind_pipeline_inbox_thread(uuid, uuid) is
  'Removes the current inbox link for one owned pipeline item. Pipeline status is unchanged. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.unbind_pipeline_inbox_thread(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.unbind_pipeline_inbox_thread(uuid, uuid)
  to service_role;

create or replace function public.refresh_pipeline_inbox_suggestions(
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
  v_item uuid;
  v_binding uuid;
begin
  if p_user_id is null or p_mail_account_id is null or p_normalized_thread_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator
    from public.creator_profiles cp
   where cp.user_id = p_user_id;
  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  if not exists (
    select 1 from public.mail_accounts m
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

  select b.pipeline_item_id into v_item
    from public.pipeline_inbox_bindings b
   where b.mail_account_id = p_mail_account_id
     and b.provider_thread_id = v_thread
     and b.creator_id = v_creator;

  if v_item is null then
    return jsonb_build_object('result', 'no_binding');
  end if;

  perform 1 from public.creator_profiles where id = v_creator for update;
  perform 1
    from public.pipeline_items pi
   where pi.id = v_item
     and pi.creator_id = v_creator
   for update;

  select b.id into v_binding
    from public.pipeline_inbox_bindings b
   where b.pipeline_item_id = v_item
     and b.creator_id = v_creator
   for update;

  if v_binding is null then
    return jsonb_build_object('result', 'no_binding');
  end if;

  return public._pipeline_inbox_sync_suggestions(v_binding);
end;
$$;

comment on function public.refresh_pipeline_inbox_suggestions(uuid, uuid, uuid) is
  'Refreshes suggestions for a linked thread after B07. No binding writes nothing. Does not change pipeline status. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.refresh_pipeline_inbox_suggestions(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.refresh_pipeline_inbox_suggestions(uuid, uuid, uuid)
  to service_role;

create or replace function public.dismiss_pipeline_inbox_suggestion(
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
  v_binding uuid;
  v_suggestion_status text;
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

  perform 1 from public.creator_profiles where id = v_creator for update;

  select pi.status into v_status
    from public.pipeline_items pi
   where pi.id = p_pipeline_item_id
     and pi.creator_id = v_creator
   for update;
  if v_status is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select s.binding_id, s.status
    into v_binding, v_suggestion_status
    from public.pipeline_inbox_suggestions s
   where s.id = p_suggestion_id
     and s.pipeline_item_id = p_pipeline_item_id
     and s.creator_id = v_creator;

  if v_binding is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  perform 1
    from public.pipeline_inbox_bindings b
   where b.id = v_binding
     and b.pipeline_item_id = p_pipeline_item_id
     and b.creator_id = v_creator
   for update;

  select s.status into v_suggestion_status
    from public.pipeline_inbox_suggestions s
   where s.id = p_suggestion_id
     and s.creator_id = v_creator
   for update;

  if v_suggestion_status is distinct from 'pending' then
    return jsonb_build_object('result', 'not_pending', 'pipeline_status', v_status);
  end if;

  perform set_config('inbox_pipeline.writer', 'dismiss', true);
  update public.pipeline_inbox_suggestions
     set status = 'dismissed'
   where id = p_suggestion_id
     and creator_id = v_creator
     and status = 'pending';

  return jsonb_build_object('result', 'dismissed', 'pipeline_status', v_status);
end;
$$;

comment on function public.dismiss_pipeline_inbox_suggestion(uuid, uuid, uuid) is
  'Records that the creator refused one pending suggestion. Pipeline status is unchanged. A later refresh of the same machine attempt does not reopen it. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.dismiss_pipeline_inbox_suggestion(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.dismiss_pipeline_inbox_suggestion(uuid, uuid, uuid)
  to service_role;

create or replace function public.accept_pipeline_inbox_suggestion(
  p_user_id uuid,
  p_pipeline_item_id uuid,
  p_suggestion_id uuid,
  p_sentiment text default null,
  p_event_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_status text;
  v_binding uuid;
  v_mail uuid;
  v_thread text;
  v_kind text;
  v_suggestion_status text;
  v_attempt uuid;
  v_applies boolean;
  v_reading_attempt uuid;
  v_stale boolean;
  v_event_at timestamptz;
  v_transition jsonb;
  v_status_after text;
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

  perform 1 from public.creator_profiles where id = v_creator for update;

  select pi.status into v_status
    from public.pipeline_items pi
   where pi.id = p_pipeline_item_id
     and pi.creator_id = v_creator
   for update;
  if v_status is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select s.binding_id, s.kind, s.status, s.source_attempt_id, s.applies_crm
    into v_binding, v_kind, v_suggestion_status, v_attempt, v_applies
    from public.pipeline_inbox_suggestions s
   where s.id = p_suggestion_id
     and s.pipeline_item_id = p_pipeline_item_id
     and s.creator_id = v_creator;

  if v_binding is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select b.mail_account_id, b.provider_thread_id
    into v_mail, v_thread
    from public.pipeline_inbox_bindings b
   where b.id = v_binding
     and b.pipeline_item_id = p_pipeline_item_id
     and b.creator_id = v_creator
   for update;

  if v_mail is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select s.status, s.kind, s.source_attempt_id, s.applies_crm
    into v_suggestion_status, v_kind, v_attempt, v_applies
    from public.pipeline_inbox_suggestions s
   where s.id = p_suggestion_id
     and s.creator_id = v_creator
   for update;

  if v_suggestion_status is distinct from 'pending' then
    return jsonb_build_object('result', 'not_pending', 'pipeline_status', v_status);
  end if;

  select r.stale, r.source_attempt_id
    into v_stale, v_reading_attempt
    from public.pipeline_inbox_readings r
   where r.binding_id = v_binding
     and r.creator_id = v_creator;

  if v_stale is null or v_stale then
    return jsonb_build_object('result', 'stale_reading', 'pipeline_status', v_status);
  end if;
  if v_reading_attempt is distinct from v_attempt then
    return jsonb_build_object('result', 'reading_moved', 'pipeline_status', v_status);
  end if;

  if v_kind = 'mark_replied' then
    if v_applies is distinct from true then
      return jsonb_build_object('result', 'invalid_input');
    end if;
    if p_sentiment is null or p_sentiment not in ('positive','negative','unclear') then
      return jsonb_build_object('result', 'invalid_input');
    end if;
    v_event_at := p_event_at;
    if v_event_at is null then
      select nm.internal_date into v_event_at
        from private.gmail_commercial_message_current mc
        join private.gmail_commercial_message_attempts ma
          on ma.id = mc.current_attempt_id
         and ma.mail_account_id = mc.mail_account_id
         and ma.provider_message_id = mc.provider_message_id
        join private.gmail_normalized_messages nm
          on nm.mail_account_id = mc.mail_account_id
         and nm.provider_message_id = mc.provider_message_id
       where mc.mail_account_id = v_mail
         and mc.provider_thread_id = v_thread
         and mc.user_id = p_user_id
         and mc.stale = false
         and mc.suppressed = false
         and nm.provider_sent = false
         and (
           ma.axis_a_basis = 'human_reply'
           or (
             ma.axis_a_basis not in ('automated', 'delivery', 'not_reply')
             and ma.b06_response_class = 'qualifying_human_reply'
             and exists (
               select 1
                 from private.gmail_reply_message_observations o
                where o.id = ma.b06_observation_id
                  and o.current_normalized_message_id is not null
             )
           )
         )
       order by nm.internal_date desc, mc.provider_message_id desc
       limit 1;
    end if;
    if v_event_at is null then
      return jsonb_build_object('result', 'needs_event_time', 'pipeline_status', v_status);
    end if;

    v_transition := public.transition_pipeline_item(
      p_user_id, p_pipeline_item_id, 'mark_replied', v_event_at, 'email', p_sentiment, null, null, null
    );
  elsif v_kind = 'open_negotiation' then
    if v_applies is distinct from true then
      return jsonb_build_object('result', 'invalid_input');
    end if;
    v_transition := public.progress_pipeline_deal(
      p_user_id, p_pipeline_item_id, 'start_negotiation', null, null
    );
  elsif v_kind in ('review_agreement','review_decline') then
    if v_applies then
      return jsonb_build_object('result', 'invalid_input');
    end if;
    perform set_config('inbox_pipeline.writer', 'accept', true);
    update public.pipeline_inbox_suggestions
       set status = 'accepted'
     where id = p_suggestion_id
       and creator_id = v_creator
       and status = 'pending';

    select pi.status into v_status_after
      from public.pipeline_items pi
     where pi.id = p_pipeline_item_id;
    if v_status_after is distinct from v_status then
      raise exception 'review acknowledgement changed pipeline status'
        using errcode = '23514';
    end if;
    return jsonb_build_object(
      'result', 'acknowledged',
      'pipeline_status', v_status_after,
      'suggestion_id', p_suggestion_id
    );
  else
    return jsonb_build_object('result', 'invalid_input');
  end if;

  if v_transition ->> 'result' = 'applied' then
    perform set_config('inbox_pipeline.writer', 'accept', true);
    update public.pipeline_inbox_suggestions
       set status = 'accepted'
     where id = p_suggestion_id
       and creator_id = v_creator
       and status = 'pending';
  elsif v_transition ->> 'result' = 'already_applied' then
    perform set_config('inbox_pipeline.writer', 'accept', true);
    update public.pipeline_inbox_suggestions
       set status = 'creator_overrides'
     where id = p_suggestion_id
       and creator_id = v_creator
       and status = 'pending';
  end if;

  return v_transition || jsonb_build_object('suggestion_id', p_suggestion_id);
end;
$$;

comment on function public.accept_pipeline_inbox_suggestion(uuid, uuid, uuid, text, timestamptz) is
  'Creator acceptance. mark_replied and open_negotiation call the existing CRM transitions and require a creator sentiment for a reply. review_agreement and review_decline record acknowledgement only. A redirect is never closed as a rejection. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.accept_pipeline_inbox_suggestion(uuid, uuid, uuid, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.accept_pipeline_inbox_suggestion(uuid, uuid, uuid, text, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------------
-- Read model. Runs as the caller so RLS is the row boundary.
-- ---------------------------------------------------------------------------
create or replace function public.read_pipeline_inbox_unity(p_pipeline_item_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_status text;
  v_creator uuid;
  v_binding uuid;
  v_mail uuid;
  v_thread text;
  v_email text;
  v_reading jsonb;
  v_suggestions jsonb;
  v_pending integer;
  v_unity text;
begin
  if p_pipeline_item_id is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select pi.status, pi.creator_id
    into v_status, v_creator
    from public.pipeline_items pi
   where pi.id = p_pipeline_item_id;

  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select b.id, b.mail_account_id, b.provider_thread_id, m.email_address::text
    into v_binding, v_mail, v_thread, v_email
    from public.pipeline_inbox_bindings b
    join public.mail_accounts m on m.id = b.mail_account_id
   where b.pipeline_item_id = p_pipeline_item_id
     and b.creator_id = v_creator;

  if v_binding is null then
    return jsonb_build_object(
      'result', 'ok',
      'pipeline_status', v_status,
      'unity', 'unlinked',
      'binding', null,
      'reading', null,
      'suggestions', '[]'::jsonb
    );
  end if;

  select jsonb_build_object(
    'commercial_state', r.commercial_state,
    'stale', r.stale,
    'has_redirect', r.has_redirect,
    'has_rejection', r.has_rejection,
    'has_human_reply', r.has_human_reply,
    'decline_supported', r.decline_supported
  ) into v_reading
    from public.pipeline_inbox_readings r
   where r.binding_id = v_binding
     and r.creator_id = v_creator;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', s.id,
      'kind', s.kind,
      'status', s.status,
      'applies_crm', s.applies_crm,
      'basis', s.basis
    )
    order by s.kind
  ), '[]'::jsonb)
    into v_suggestions
    from public.pipeline_inbox_suggestions s
   where s.binding_id = v_binding
     and s.creator_id = v_creator
     and s.status = 'pending';

  v_pending := jsonb_array_length(v_suggestions);
  v_unity := case when v_pending > 0 then 'suggestion_pending' else 'creator_authoritative' end;

  return jsonb_build_object(
    'result', 'ok',
    'pipeline_status', v_status,
    'unity', v_unity,
    'binding', jsonb_build_object(
      'mail_account_id', v_mail,
      'provider_thread_id', v_thread,
      'email_address', v_email
    ),
    'reading', v_reading,
    'suggestions', v_suggestions
  );
end;
$$;

comment on function public.read_pipeline_inbox_unity(uuid) is
  'D080 read model. pipeline_status is the creator record. unity is unlinked, suggestion_pending, or creator_authoritative. The machine commercial_state is never returned as the pipeline status. Runs as the caller so RLS applies. search_path is pinned empty.';

revoke all on function public.read_pipeline_inbox_unity(uuid) from public, anon;
grant execute on function public.read_pipeline_inbox_unity(uuid)
  to authenticated, service_role;
