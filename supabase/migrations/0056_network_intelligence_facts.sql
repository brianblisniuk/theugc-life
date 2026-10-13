-- ===========================================================================
-- 0056 — C02–C05 network intelligence facts (D099)
-- ===========================================================================
-- Creator-confirmed facts can feed an anonymous hotel aggregate. A Gmail
-- reading enters that aggregate only after the creator taps Sí on the linked
-- pipeline thread. No dismisses it, and a dismissed row never becomes
-- eligible. Manual ledger facts stay a different source family.
--
-- The existing D057/D058 recompute and hotel_public_intelligence /
-- hotel_premium_intelligence projections are not rewritten here.
--
-- Refused in this migration:
--   * a canonical organization is not a network target;
--   * a B05 hotel that is not the pipeline item's hotel is not chosen, and
--     the pipeline hotel is not invented as a target when B05 disagrees;
--   * trip shortlist membership is stored and is never network-eligible;
--   * compensation amounts are not copied;
--   * unknown is not stored as unpaid or as zero;
--   * a censored reply window is not stored as zero replies or as ghosted;
--   * redirect is not stored as rejection.
-- ===========================================================================

create table private.intelligence_facts (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.users(id) on delete cascade,
  fact_type text not null check (fact_type in (
    'pitch_sent', 'followup_sent', 'reply_received', 'positive_reply',
    'negative_reply', 'offer_received', 'negotiation_started', 'deal_won',
    'deal_lost', 'collaboration_started', 'collaboration_completed',
    'creator_closed_pipeline', 'collaboration_type_observed',
    'gmail_thread_commercial_state', 'gmail_human_reply_observed',
    'gmail_reply_latency', 'trip_shortlist_membership'
  )),
  provenance_class text not null check (provenance_class in ('machine', 'creator_confirmed')),
  source_family text not null check (source_family in ('manual', 'gmail', 'trip')),
  canonical_hotel_id uuid references public.hotels(id) on delete cascade,
  canonical_organization_id uuid references public.organizations(id) on delete cascade,
  evidence_kind text not null check (evidence_kind in (
    'outreach_event', 'collaboration', 'trip_hotel',
    'gmail_confirmation', 'gmail_thread_attempt'
  )),
  evidence_id uuid not null,
  value jsonb not null default '{}'::jsonb,
  event_at timestamptz,
  network_eligible boolean not null default false,
  counts_as_sample boolean not null default false,
  dismissed boolean not null default false,
  pipeline_item_id uuid references public.pipeline_items(id) on delete cascade,
  created_at timestamptz not null default now(),

  constraint intelligence_facts_one_target check (
    (canonical_hotel_id is not null and canonical_organization_id is null)
    or (canonical_hotel_id is null and canonical_organization_id is not null)
  ),
  constraint intelligence_facts_evidence_uidx
    unique (evidence_kind, evidence_id, fact_type, provenance_class),
  constraint intelligence_facts_network_shape check (
    network_eligible = false
    or (
      provenance_class = 'creator_confirmed'
      and dismissed = false
      and source_family in ('manual', 'gmail')
      and canonical_hotel_id is not null
      and canonical_organization_id is null
      and fact_type <> 'trip_shortlist_membership'
    )
  ),
  constraint intelligence_facts_sample_shape check (
    counts_as_sample = false or network_eligible
  ),
  constraint intelligence_facts_family_shape check (
    (
      source_family = 'manual'
      and provenance_class = 'creator_confirmed'
      and evidence_kind in ('outreach_event', 'collaboration')
    )
    or (
      source_family = 'gmail'
      and (
        (provenance_class = 'machine' and evidence_kind = 'gmail_thread_attempt' and network_eligible = false)
        or (provenance_class = 'creator_confirmed' and evidence_kind = 'gmail_confirmation')
      )
    )
    or (
      source_family = 'trip'
      and provenance_class = 'creator_confirmed'
      and evidence_kind = 'trip_hotel'
      and network_eligible = false
      and counts_as_sample = false
      and fact_type = 'trip_shortlist_membership'
    )
  ),
  constraint intelligence_facts_no_amounts check (
    not (value ? 'private_value_amount')
    and not (value ? 'private_value_currency')
    and not (value ? 'amount')
  ),
  constraint intelligence_facts_unknown_not_unpaid check (
    coalesce(value->>'structure', '') <> 'unpaid'
    or fact_type not in ('gmail_compensation_confirmed', 'gmail_compensation_structure')
  ),
  constraint intelligence_facts_redirect_not_rejection check (
    not (
      coalesce(value->'signals', '[]'::jsonb) ? 'redirect'
      and coalesce(value->'signals', '[]'::jsonb) ? 'rejection'
    )
  ),
  constraint intelligence_facts_no_ghosted_machine check (
    provenance_class = 'creator_confirmed'
    or coalesce(value->>'outcome', '') <> 'ghosted'
  )
);

comment on table private.intelligence_facts is
  'C01 facts for C02–C05. Network eligibility is creator-confirmed hotel facts only. Gmail rows cite a Sí confirmation. Machine rows and trip shortlists never enter the network. Evidence ids are admin provenance, not a public column.';

create index intelligence_facts_owner_idx
  on private.intelligence_facts (owner_user_id, canonical_hotel_id);

create index intelligence_facts_network_idx
  on private.intelligence_facts (canonical_hotel_id)
  where network_eligible;

create table private.intelligence_gmail_confirmations (
  id uuid primary key default gen_random_uuid(),
  owner_user_id uuid not null references public.users(id) on delete cascade,
  pipeline_item_id uuid not null references public.pipeline_items(id) on delete cascade,
  binding_id uuid not null references public.pipeline_inbox_bindings(id) on delete cascade,
  source_attempt_id uuid,
  decision text not null check (decision in ('confirmed', 'dismissed')),
  decided_at timestamptz not null default now(),
  constraint intelligence_gmail_confirmations_attempt_uidx
    unique (binding_id, source_attempt_id)
);

create unique index intelligence_gmail_confirmations_null_attempt_uidx
  on private.intelligence_gmail_confirmations (binding_id)
  where source_attempt_id is null;

comment on table private.intelligence_gmail_confirmations is
  'Immutable Sí/No for one linked Gmail reading. Dismissed never becomes a network fact. A later machine attempt is a different row and needs its own answer.';

create table private.network_intelligence_views (
  id uuid primary key default gen_random_uuid(),
  creator_user_id uuid not null references public.users(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  viewed_on date not null,
  created_at timestamptz not null default now(),
  constraint network_intelligence_views_day_uidx
    unique (creator_user_id, hotel_id, viewed_on)
);

comment on table private.network_intelligence_views is
  'Admin retention input: a creator saw a published anonymous network row. Not a public metric and not an edit of that row.';

create table private.network_decision_events (
  id uuid primary key default gen_random_uuid(),
  creator_user_id uuid not null references public.users(id) on delete cascade,
  hotel_id uuid not null references public.hotels(id) on delete cascade,
  decision text not null check (decision = 'prioritize'),
  created_at timestamptz not null default now()
);

comment on table private.network_decision_events is
  'C05 decision instrument. Prioritizing a hotel does not change its network aggregate.';

alter table private.intelligence_facts enable row level security;
alter table private.intelligence_gmail_confirmations enable row level security;
alter table private.network_intelligence_views enable row level security;
alter table private.network_decision_events enable row level security;

revoke all on table private.intelligence_facts from public, anon, authenticated, service_role;
revoke all on table private.intelligence_gmail_confirmations from public, anon, authenticated, service_role;
revoke all on table private.network_intelligence_views from public, anon, authenticated, service_role;
revoke all on table private.network_decision_events from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Manual, collaboration, and trip facts follow the source row.
-- ---------------------------------------------------------------------------
create or replace function private.apply_intelligence_fact_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid;
  v_value jsonb;
begin
  if tg_table_name = 'outreach_events' then
    if tg_op = 'DELETE' then
      delete from private.intelligence_facts
       where evidence_kind = 'outreach_event'
         and evidence_id = old.id;
      return old;
    end if;
    if new.source is distinct from 'manual_creator' then
      return new;
    end if;
    if new.event_type not in (
      'pitch_sent', 'followup_sent', 'reply_received', 'positive_reply',
      'negative_reply', 'offer_received', 'negotiation_started', 'deal_won',
      'deal_lost', 'collaboration_started', 'collaboration_completed',
      'creator_closed_pipeline'
    ) then
      return new;
    end if;
    select user_id into v_owner
      from public.creator_profiles
     where id = new.creator_id;
    if v_owner is null then
      return new;
    end if;
    v_value := '{}'::jsonb;
    if new.event_type = 'collaboration_completed' then
      v_value := jsonb_build_object('terms_matched', new.metadata->>'terms_matched');
      if new.metadata ? 'would_work_again' then
        v_value := v_value || jsonb_build_object('would_work_again', new.metadata->'would_work_again');
      end if;
    elsif new.event_type = 'deal_lost' and new.metadata ? 'reason' then
      v_value := jsonb_build_object('reason', new.metadata->>'reason');
    end if;
    insert into private.intelligence_facts (
      owner_user_id, fact_type, provenance_class, source_family,
      canonical_hotel_id, evidence_kind, evidence_id, value, event_at,
      network_eligible, counts_as_sample, pipeline_item_id
    ) values (
      v_owner, new.event_type, 'creator_confirmed', 'manual',
      new.hotel_id, 'outreach_event', new.id, v_value, new.event_at,
      true, true, new.pipeline_item_id
    )
    on conflict (evidence_kind, evidence_id, fact_type, provenance_class) do nothing;
    return new;
  end if;

  if tg_table_name = 'collaborations' then
    if tg_op = 'DELETE' then
      delete from private.intelligence_facts
       where evidence_kind = 'collaboration'
         and evidence_id = old.id;
      return old;
    end if;
    if new.collaboration_type is null then
      delete from private.intelligence_facts
       where evidence_kind = 'collaboration'
         and evidence_id = new.id
         and fact_type = 'collaboration_type_observed';
      return new;
    end if;
    select user_id into v_owner
      from public.creator_profiles
     where id = new.creator_id;
    if v_owner is null then
      return new;
    end if;
    insert into private.intelligence_facts (
      owner_user_id, fact_type, provenance_class, source_family,
      canonical_hotel_id, evidence_kind, evidence_id, value, event_at,
      network_eligible, counts_as_sample, pipeline_item_id
    ) values (
      v_owner, 'collaboration_type_observed', 'creator_confirmed', 'manual',
      new.hotel_id, 'collaboration', new.id,
      jsonb_build_object('collaboration_type', new.collaboration_type),
      new.agreed_at, true, true, new.pipeline_item_id
    )
    on conflict (evidence_kind, evidence_id, fact_type, provenance_class) do update
      set canonical_hotel_id = excluded.canonical_hotel_id,
          value = excluded.value,
          event_at = excluded.event_at,
          pipeline_item_id = excluded.pipeline_item_id,
          network_eligible = true,
          counts_as_sample = true,
          dismissed = false;
    return new;
  end if;

  if tg_table_name = 'trip_hotels' then
    if tg_op = 'DELETE' then
      delete from private.intelligence_facts
       where evidence_kind = 'trip_hotel'
         and evidence_id = old.id;
      return old;
    end if;
    select cp.user_id into v_owner
      from public.trips t
      join public.creator_profiles cp on cp.id = t.creator_id
     where t.id = new.trip_id;
    if v_owner is null or new.hotel_id is null then
      return new;
    end if;
    insert into private.intelligence_facts (
      owner_user_id, fact_type, provenance_class, source_family,
      canonical_hotel_id, evidence_kind, evidence_id, value, event_at,
      network_eligible, counts_as_sample
    ) values (
      v_owner, 'trip_shortlist_membership', 'creator_confirmed', 'trip',
      new.hotel_id, 'trip_hotel', new.id, '{}'::jsonb, new.created_at,
      false, false
    )
    on conflict (evidence_kind, evidence_id, fact_type, provenance_class) do nothing;
    return new;
  end if;

  if tg_table_name = 'intelligence_gmail_confirmations' and tg_op = 'DELETE' then
    delete from private.intelligence_facts
     where evidence_kind = 'gmail_confirmation'
       and evidence_id = old.id;
    return old;
  end if;

  return coalesce(new, old);
end;
$$;

revoke all on function private.apply_intelligence_fact_change() from public, anon, authenticated, service_role;

create trigger outreach_events_intelligence_fact
  after insert or delete on public.outreach_events
  for each row execute function private.apply_intelligence_fact_change();

create trigger collaborations_intelligence_fact
  after insert or update or delete on public.collaborations
  for each row execute function private.apply_intelligence_fact_change();

create trigger trip_hotels_intelligence_fact
  after insert or delete on public.trip_hotels
  for each row execute function private.apply_intelligence_fact_change();

create trigger intelligence_gmail_confirmations_purge_facts
  after delete on private.intelligence_gmail_confirmations
  for each row execute function private.apply_intelligence_fact_change();

insert into private.intelligence_facts (
  owner_user_id, fact_type, provenance_class, source_family,
  canonical_hotel_id, evidence_kind, evidence_id, value, event_at,
  network_eligible, counts_as_sample, pipeline_item_id
)
select cp.user_id, oe.event_type, 'creator_confirmed', 'manual',
       oe.hotel_id, 'outreach_event', oe.id,
       case
         when oe.event_type = 'collaboration_completed' then
           jsonb_build_object('terms_matched', oe.metadata->>'terms_matched')
           || case
                when oe.metadata ? 'would_work_again'
                  then jsonb_build_object('would_work_again', oe.metadata->'would_work_again')
                else '{}'::jsonb
              end
         when oe.event_type = 'deal_lost' and oe.metadata ? 'reason'
           then jsonb_build_object('reason', oe.metadata->>'reason')
         else '{}'::jsonb
       end,
       oe.event_at, true, true, oe.pipeline_item_id
  from public.outreach_events oe
  join public.creator_profiles cp on cp.id = oe.creator_id
 where oe.source = 'manual_creator'
   and oe.event_type in (
     'pitch_sent', 'followup_sent', 'reply_received', 'positive_reply',
     'negative_reply', 'offer_received', 'negotiation_started', 'deal_won',
     'deal_lost', 'collaboration_started', 'collaboration_completed',
     'creator_closed_pipeline'
   )
on conflict (evidence_kind, evidence_id, fact_type, provenance_class) do nothing;

insert into private.intelligence_facts (
  owner_user_id, fact_type, provenance_class, source_family,
  canonical_hotel_id, evidence_kind, evidence_id, value, event_at,
  network_eligible, counts_as_sample, pipeline_item_id
)
select cp.user_id, 'collaboration_type_observed', 'creator_confirmed', 'manual',
       c.hotel_id, 'collaboration', c.id,
       jsonb_build_object('collaboration_type', c.collaboration_type),
       c.agreed_at, true, true, c.pipeline_item_id
  from public.collaborations c
  join public.creator_profiles cp on cp.id = c.creator_id
 where c.collaboration_type is not null
on conflict (evidence_kind, evidence_id, fact_type, provenance_class) do nothing;

insert into private.intelligence_facts (
  owner_user_id, fact_type, provenance_class, source_family,
  canonical_hotel_id, evidence_kind, evidence_id, value, event_at,
  network_eligible, counts_as_sample
)
select cp.user_id, 'trip_shortlist_membership', 'creator_confirmed', 'trip',
       th.hotel_id, 'trip_hotel', th.id, '{}'::jsonb, th.created_at, false, false
  from public.trip_hotels th
  join public.trips t on t.id = th.trip_id
  join public.creator_profiles cp on cp.id = t.creator_id
on conflict (evidence_kind, evidence_id, fact_type, provenance_class) do nothing;

-- ---------------------------------------------------------------------------
-- Anonymous aggregate. Counts stay inside the view and are not columns.
-- ---------------------------------------------------------------------------
create view public.network_hotel_public
with (security_barrier = true, security_invoker = false) as
select
  hotel_id,
  confidence_level,
  case
    when confidence_level = 'emerging' then 'emerging'
    when confidence_level = 'moderate' then 'medium'
    when confidence_level = 'strong' then 'high'
    else null
  end as activity_level,
  case when collab_creators >= 3 then true else null end as has_observed_collaboration,
  case
    when confidence_level in ('moderate', 'strong') then recency_band
    else null
  end as recency_band,
  case
    when confidence_level in ('moderate', 'strong') then recency_band
    else null
  end as freshness_band
from (
  select
    hotel_id,
    case
      when sample_size >= 50 then 'strong'
      when sample_size >= 15 then 'moderate'
      when sample_size >= 5 then 'emerging'
      else 'insufficient'
    end as confidence_level,
    collab_creators,
    case
      when latest_event_at is null then null
      when latest_event_at >= now() - interval '30 days' then 'past_month'
      when latest_event_at >= now() - interval '90 days' then 'past_quarter'
      else 'older'
    end as recency_band
  from (
    select
      f.canonical_hotel_id as hotel_id,
      count(*) filter (where f.counts_as_sample)::integer as sample_size,
      count(distinct f.owner_user_id) filter (where f.counts_as_sample)::integer as sample_creators,
      count(distinct f.owner_user_id) filter (
        where f.fact_type in ('collaboration_completed', 'collaboration_type_observed')
      )::integer as collab_creators,
      max(f.event_at) filter (where f.counts_as_sample) as latest_event_at
    from private.intelligence_facts f
    where f.network_eligible
      and f.provenance_class = 'creator_confirmed'
      and f.dismissed = false
      and f.source_family in ('manual', 'gmail')
      and f.canonical_hotel_id is not null
    group by f.canonical_hotel_id
  ) counts
  where sample_creators >= 3
) gated;

comment on view public.network_hotel_public is
  'Anonymous C03 projection. Shown only at 3 or more distinct creators (D058) with D012 confidence. No creator id, evidence id, raw count, reply time, or source split. Insufficient suppresses metrics. NULL collaboration is not false.';

revoke all on table public.network_hotel_public from public, anon, authenticated, service_role;
grant select on table public.network_hotel_public to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Gmail Sí / No. Identity is auth.uid(). A passed user id is not accepted.
-- ---------------------------------------------------------------------------
create or replace function public.answer_gmail_network_reading(
  p_pipeline_item_id uuid,
  p_decision text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_creator uuid;
  v_hotel uuid;
  v_binding uuid;
  v_mail uuid;
  v_thread text;
  v_attempt uuid;
  v_state text;
  v_human boolean;
  v_stale boolean;
  v_existing text;
  v_confirmation uuid;
  v_hotel_count integer;
  v_org_count integer;
  v_target uuid;
  v_admitted integer := 0;
  v_primary boolean;
  v_summary_id uuid;
  v_first_ms bigint;
  v_latest_ms bigint;
  v_latest_known boolean;
  v_latency jsonb;
begin
  if v_user is null or p_decision not in ('confirmed', 'dismissed') then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select pi.creator_id, pi.hotel_id
    into v_creator, v_hotel
    from public.pipeline_items pi
    join public.creator_profiles cp on cp.id = pi.creator_id
   where pi.id = p_pipeline_item_id
     and cp.user_id = v_user;
  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select b.id, b.mail_account_id, b.provider_thread_id
    into v_binding, v_mail, v_thread
    from public.pipeline_inbox_bindings b
   where b.pipeline_item_id = p_pipeline_item_id
     and b.creator_id = v_creator;
  if v_binding is null then
    return jsonb_build_object('result', 'not_linked');
  end if;

  select r.source_attempt_id, r.commercial_state, r.has_human_reply, r.stale
    into v_attempt, v_state, v_human, v_stale
    from public.pipeline_inbox_readings r
   where r.binding_id = v_binding;

  if v_stale then
    return jsonb_build_object('result', 'stale');
  end if;

  select c.decision
    into v_existing
    from private.intelligence_gmail_confirmations c
   where c.binding_id = v_binding
     and c.source_attempt_id is not distinct from v_attempt;
  if v_existing is not null then
    return jsonb_build_object('result', 'already_answered', 'decision', v_existing);
  end if;

  insert into private.intelligence_gmail_confirmations (
    owner_user_id, pipeline_item_id, binding_id, source_attempt_id, decision
  ) values (
    v_user, p_pipeline_item_id, v_binding, v_attempt, p_decision
  )
  returning id into v_confirmation;

  if p_decision = 'dismissed' then
    return jsonb_build_object('result', 'dismissed');
  end if;

  select count(distinct l.target_hotel_id), count(distinct l.target_organization_id)
    into v_hotel_count, v_org_count
    from private.gmail_normalized_threads t
    join private.gmail_outreach_target_observations o
      on o.normalized_thread_id = t.id
     and o.mail_account_id = t.mail_account_id
     and o.machine_is_current
    join private.gmail_outreach_target_canonical_links l
      on l.target_observation_id = o.id
   where t.mail_account_id = v_mail
     and t.provider_thread_id = v_thread
     and t.user_id = v_user;

  select l.target_hotel_id
    into v_target
    from private.gmail_normalized_threads t
    join private.gmail_outreach_target_observations o
      on o.normalized_thread_id = t.id
     and o.mail_account_id = t.mail_account_id
     and o.machine_is_current
    join private.gmail_outreach_target_canonical_links l
      on l.target_observation_id = o.id
     and l.target_kind = 'hotel'
   where t.mail_account_id = v_mail
     and t.provider_thread_id = v_thread
     and t.user_id = v_user
   group by l.target_hotel_id
   limit 1;

  if v_hotel_count is distinct from 1
     or coalesce(v_org_count, 0) <> 0
     or v_target is distinct from v_hotel then
    return jsonb_build_object('result', 'confirmed_not_admitted');
  end if;

  if v_attempt is not null and exists (
    select 1
      from private.gmail_commercial_thread_attempts a
     where a.id = v_attempt
       and a.user_id = v_user
       and a.mail_account_id = v_mail
       and a.provider_thread_id = v_thread
  ) then
    insert into private.intelligence_facts (
      owner_user_id, fact_type, provenance_class, source_family,
      canonical_hotel_id, evidence_kind, evidence_id, value, event_at,
      network_eligible, counts_as_sample, pipeline_item_id
    ) values (
      v_user, 'gmail_thread_commercial_state', 'machine', 'gmail',
      v_target, 'gmail_thread_attempt', v_attempt,
      case when v_state is null then '{}'::jsonb else jsonb_build_object('state', v_state) end,
      now(), false, false, p_pipeline_item_id
    )
    on conflict (evidence_kind, evidence_id, fact_type, provenance_class) do nothing;
  end if;

  v_primary := v_state is not null;
  if v_primary then
    insert into private.intelligence_facts (
      owner_user_id, fact_type, provenance_class, source_family,
      canonical_hotel_id, evidence_kind, evidence_id, value, event_at,
      network_eligible, counts_as_sample, pipeline_item_id
    ) values (
      v_user, 'gmail_thread_commercial_state', 'creator_confirmed', 'gmail',
      v_target, 'gmail_confirmation', v_confirmation,
      jsonb_build_object('state', v_state), now(), true, true, p_pipeline_item_id
    );
    v_admitted := v_admitted + 1;
  end if;

  if coalesce(v_human, false) then
    insert into private.intelligence_facts (
      owner_user_id, fact_type, provenance_class, source_family,
      canonical_hotel_id, evidence_kind, evidence_id, value, event_at,
      network_eligible, counts_as_sample, pipeline_item_id
    ) values (
      v_user, 'gmail_human_reply_observed', 'creator_confirmed', 'gmail',
      v_target, 'gmail_confirmation', v_confirmation,
      jsonb_build_object('response_class', 'qualifying_human_reply'),
      now(), true, not v_primary, p_pipeline_item_id
    );
    v_admitted := v_admitted + 1;
  end if;

  select s.id,
         s.latency_from_first_creator_sent_ms,
         s.latency_from_latest_creator_sent_ms,
         (
           s.latest_creator_sent_before_reply_provider_message_id is not null
           and s.latency_from_latest_creator_sent_ms is not null
         )
    into v_summary_id, v_first_ms, v_latest_ms, v_latest_known
    from private.gmail_reply_thread_summaries s
    join private.gmail_normalized_threads t
      on t.id = s.normalized_thread_id
     and t.mail_account_id = s.mail_account_id
   where s.mail_account_id = v_mail
     and s.user_id = v_user
     and t.provider_thread_id = v_thread
     and s.observation_state = 'qualifying_human_reply_observed'
     and s.reply_chronology_conflict = false
     and s.first_qualifying_human_reply_provider_message_id is not null
     and s.first_creator_sent_provider_message_id is not null
     and s.latency_from_first_creator_sent_ms is not null;

  if v_summary_id is not null then
    v_latency := jsonb_build_object('first_send_to_human_reply_ms', v_first_ms);
    if v_latest_known then
      v_latency := v_latency || jsonb_build_object('latest_touch_to_human_reply_ms', v_latest_ms);
    end if;
    insert into private.intelligence_facts (
      owner_user_id, fact_type, provenance_class, source_family,
      canonical_hotel_id, evidence_kind, evidence_id, value, event_at,
      network_eligible, counts_as_sample, pipeline_item_id
    ) values (
      v_user, 'gmail_reply_latency', 'creator_confirmed', 'gmail',
      v_target, 'gmail_confirmation', v_confirmation,
      v_latency, now(), true, false, p_pipeline_item_id
    );
    v_admitted := v_admitted + 1;
  end if;

  if v_admitted = 0 then
    return jsonb_build_object('result', 'confirmed_not_admitted');
  end if;
  return jsonb_build_object('result', 'confirmed_admitted');
exception
  when unique_violation then
    return jsonb_build_object('result', 'already_answered');
end;
$$;

comment on function public.answer_gmail_network_reading(uuid, text) is
  'Records Sí or No for the caller''s linked reading. Dismissed stores no network fact. Sí admits Gmail facts only when exactly one current B05 hotel link is the pipeline hotel. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.answer_gmail_network_reading(uuid, text) from public, anon, authenticated;
grant execute on function public.answer_gmail_network_reading(uuid, text) to authenticated, service_role;

create or replace function public.read_gmail_network_prompt(p_pipeline_item_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_creator uuid;
  v_binding uuid;
  v_attempt uuid;
  v_stale boolean;
  v_decision text;
  v_confirmation uuid;
  v_admitted boolean;
begin
  if v_user is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  select pi.creator_id into v_creator
    from public.pipeline_items pi
    join public.creator_profiles cp on cp.id = pi.creator_id
   where pi.id = p_pipeline_item_id
     and cp.user_id = v_user;
  if v_creator is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  select b.id into v_binding
    from public.pipeline_inbox_bindings b
   where b.pipeline_item_id = p_pipeline_item_id
     and b.creator_id = v_creator;
  if v_binding is null then
    return jsonb_build_object('result', 'hidden');
  end if;
  select r.source_attempt_id, r.stale
    into v_attempt, v_stale
    from public.pipeline_inbox_readings r
   where r.binding_id = v_binding;
  if v_stale then
    return jsonb_build_object('result', 'stale');
  end if;
  select c.id, c.decision
    into v_confirmation, v_decision
    from private.intelligence_gmail_confirmations c
   where c.binding_id = v_binding
     and c.source_attempt_id is not distinct from v_attempt;
  if v_decision is null then
    return jsonb_build_object('result', 'pending');
  end if;
  if v_decision = 'dismissed' then
    return jsonb_build_object('result', 'dismissed');
  end if;
  select exists (
    select 1
      from private.intelligence_facts f
     where f.evidence_kind = 'gmail_confirmation'
       and f.evidence_id = v_confirmation
       and f.network_eligible
  ) into v_admitted;
  if v_admitted then
    return jsonb_build_object('result', 'confirmed_admitted');
  end if;
  return jsonb_build_object('result', 'confirmed_not_admitted');
end;
$$;

revoke all on function public.read_gmail_network_prompt(uuid) from public, anon, authenticated;
grant execute on function public.read_gmail_network_prompt(uuid) to authenticated, service_role;

create or replace function public.read_own_network_facts(p_hotel_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  return jsonb_build_object(
    'result', 'ok',
    'manual', coalesce((
      select jsonb_agg(jsonb_build_object(
               'fact_type', f.fact_type,
               'provenance_class', f.provenance_class,
               'source_family', f.source_family,
               'event_at', f.event_at
             ) order by f.event_at nulls last, f.fact_type)
        from private.intelligence_facts f
       where f.owner_user_id = v_user
         and f.canonical_hotel_id = p_hotel_id
         and f.source_family = 'manual'
    ), '[]'::jsonb),
    'gmail', coalesce((
      select jsonb_agg(jsonb_build_object(
               'fact_type', f.fact_type,
               'provenance_class', f.provenance_class,
               'source_family', f.source_family,
               'event_at', f.event_at
             ) order by f.event_at nulls last, f.fact_type)
        from private.intelligence_facts f
       where f.owner_user_id = v_user
         and f.canonical_hotel_id = p_hotel_id
         and f.source_family = 'gmail'
         and f.provenance_class = 'creator_confirmed'
         and f.dismissed = false
    ), '[]'::jsonb)
  );
end;
$$;

comment on function public.read_own_network_facts(uuid) is
  'The caller''s own facts for one hotel, split into manual and Gmail. No evidence id and no other creator.';

revoke all on function public.read_own_network_facts(uuid) from public, anon, authenticated;
grant execute on function public.read_own_network_facts(uuid) to authenticated, service_role;

create or replace function public.record_network_intelligence_view(p_hotel_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if not exists (
    select 1 from public.network_hotel_public n where n.hotel_id = p_hotel_id
  ) then
    return jsonb_build_object('result', 'not_visible');
  end if;
  insert into private.network_intelligence_views (creator_user_id, hotel_id, viewed_on)
  values (v_user, p_hotel_id, (now() at time zone 'utc')::date)
  on conflict (creator_user_id, hotel_id, viewed_on) do nothing;
  return jsonb_build_object('result', 'ok');
end;
$$;

revoke all on function public.record_network_intelligence_view(uuid) from public, anon, authenticated;
grant execute on function public.record_network_intelligence_view(uuid) to authenticated, service_role;

create or replace function public.record_network_priority(p_hotel_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  if not exists (
    select 1
      from public.network_hotel_public n
     where n.hotel_id = p_hotel_id
       and n.confidence_level in ('emerging', 'moderate', 'strong')
       and (
         n.activity_level is not null
         or n.recency_band is not null
         or n.has_observed_collaboration is true
       )
  ) then
    return jsonb_build_object('result', 'not_visible');
  end if;
  insert into private.network_decision_events (creator_user_id, hotel_id, decision)
  values (v_user, p_hotel_id, 'prioritize');
  return jsonb_build_object('result', 'ok');
end;
$$;

comment on function public.record_network_priority(uuid) is
  'Records that the caller prioritized a hotel whose anonymous signal is already published. Does not change that signal.';

revoke all on function public.record_network_priority(uuid) from public, anon, authenticated;
grant execute on function public.record_network_priority(uuid) to authenticated, service_role;

create or replace function public.read_network_destination_rank(p_destination_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'result', 'ok',
    'hotels', coalesce((
      select jsonb_agg(jsonb_build_object(
               'hotel_id', ranked.hotel_id,
               'confidence_level', ranked.confidence_level,
               'activity_level', ranked.activity_level,
               'recency_band', ranked.recency_band
             ) order by ranked.baseline_rank)
        from (
          select n.hotel_id, n.confidence_level, n.activity_level, n.recency_band,
                 row_number() over (
                   order by case n.recency_band
                              when 'past_month' then 1
                              when 'past_quarter' then 2
                              when 'older' then 3
                              else 4
                            end,
                            case n.confidence_level
                              when 'strong' then 1
                              when 'moderate' then 2
                              when 'emerging' then 3
                              else 4
                            end,
                            n.hotel_id
                 ) as baseline_rank
            from public.network_hotel_public n
            join public.hotels h on h.id = n.hotel_id
           where h.destination_id = p_destination_id
             and n.confidence_level in ('emerging', 'moderate', 'strong')
             and (
               n.activity_level is not null
               or n.recency_band is not null
               or n.has_observed_collaboration is true
             )
        ) ranked
    ), '[]'::jsonb)
  );
$$;

comment on function public.read_network_destination_rank(uuid) is
  'Baseline order of hotels with a published anonymous signal. No score, no count, no creator id. Hotels below the floor are omitted, not ranked last.';

revoke all on function public.read_network_destination_rank(uuid) from public, anon, authenticated;
grant execute on function public.read_network_destination_rank(uuid) to anon, authenticated, service_role;

create or replace function public.read_admin_fact_provenance(p_fact_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row private.intelligence_facts%rowtype;
begin
  if public.current_user_role() is distinct from 'admin' then
    return jsonb_build_object('result', 'not_found');
  end if;
  select * into v_row
    from private.intelligence_facts
   where id = p_fact_id;
  if v_row.id is null then
    return jsonb_build_object('result', 'not_found');
  end if;
  return jsonb_build_object(
    'result', 'ok',
    'fact_id', v_row.id,
    'owner_user_id', v_row.owner_user_id,
    'fact_type', v_row.fact_type,
    'provenance_class', v_row.provenance_class,
    'source_family', v_row.source_family,
    'evidence_kind', v_row.evidence_kind,
    'evidence_id', v_row.evidence_id,
    'canonical_hotel_id', v_row.canonical_hotel_id,
    'value', v_row.value
  );
end;
$$;

comment on function public.read_admin_fact_provenance(uuid) is
  'Admin audit of one fact. Creators, editors, and anonymous callers get not_found, including for a missing id.';

revoke all on function public.read_admin_fact_provenance(uuid) from public, anon, authenticated;
grant execute on function public.read_admin_fact_provenance(uuid) to authenticated, service_role;

create or replace function public.read_admin_pilot_kpis()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_confirmed integer;
  v_dismissed integer;
  v_decisions integer;
begin
  if public.current_user_role() is distinct from 'admin' then
    return jsonb_build_object('result', 'not_found');
  end if;

  select count(*) filter (where decision = 'confirmed'),
         count(*) filter (where decision = 'dismissed')
    into v_confirmed, v_dismissed
    from private.intelligence_gmail_confirmations;
  v_decisions := v_confirmed + v_dismissed;

  return jsonb_build_object(
    'result', 'ok',
    'confirmed_facts_per_creator', coalesce((
      select jsonb_agg(jsonb_build_object(
               'creator_user_id', owner_user_id,
               'manual_facts', manual_facts,
               'gmail_confirmed_facts', gmail_confirmed_facts
             ) order by owner_user_id)
        from (
          select owner_user_id,
                 count(*) filter (
                   where source_family = 'manual' and provenance_class = 'creator_confirmed'
                 )::integer as manual_facts,
                 count(*) filter (
                   where source_family = 'gmail'
                     and provenance_class = 'creator_confirmed'
                     and dismissed = false
                     and network_eligible
                 )::integer as gmail_confirmed_facts
            from private.intelligence_facts
           group by owner_user_id
        ) per_creator
    ), '[]'::jsonb),
    'gmail_confirmed', v_confirmed,
    'gmail_dismissed', v_dismissed,
    'gmail_confirmed_pct', case
      when v_decisions = 0 then null
      else round(100.0 * v_confirmed / v_decisions)::integer
    end,
    'gmail_dismissed_pct', case
      when v_decisions = 0 then null
      else round(100.0 * v_dismissed / v_decisions)::integer
    end,
    'hotels_emerging_or_above', (
      select count(*)::integer
        from public.network_hotel_public
       where confidence_level in ('emerging', 'moderate', 'strong')
    ),
    'hotel_response_time', coalesce((
      select jsonb_agg(jsonb_build_object(
               'hotel_id', banded.hotel_id,
               'response_time_band', banded.band
             ) order by banded.hotel_id)
        from (
          select agg.hotel_id,
                 case
                   when agg.mean_ms < 86400000 then 'under_24h'
                   when agg.mean_ms < 3 * 86400000 then '1_3_days'
                   when agg.mean_ms < 7 * 86400000 then '3_7_days'
                   when agg.mean_ms < 14 * 86400000 then '1_2_weeks'
                   else '2_plus_weeks'
                 end as band
            from (
              select per.hotel_id,
                     count(*)::integer as creators,
                     avg(per.creator_ms) as mean_ms,
                     sum(per.observations)::integer as observations
                from (
                  select f.canonical_hotel_id as hotel_id,
                         f.owner_user_id,
                         percentile_cont(0.5) within group (
                           order by (f.value->>'first_send_to_human_reply_ms')::numeric
                         ) as creator_ms,
                         count(*)::integer as observations
                    from private.intelligence_facts f
                   where f.network_eligible
                     and f.fact_type = 'gmail_reply_latency'
                     and f.source_family = 'gmail'
                     and f.provenance_class = 'creator_confirmed'
                     and f.value ? 'first_send_to_human_reply_ms'
                     and (f.value->>'first_send_to_human_reply_ms') ~ '^[0-9]+$'
                   group by f.canonical_hotel_id, f.owner_user_id
                ) per
               group by per.hotel_id
            ) agg
           where agg.creators >= 3
             and agg.observations >= 5
             and agg.mean_ms is not null
        ) banded
    ), '[]'::jsonb),
    'retention', (
      select jsonb_build_object(
        'creators_who_viewed', count(*)::integer,
        'creators_who_returned', count(*) filter (where days >= 2)::integer,
        'return_rate', case
          when count(*) = 0 then null
          when count(*) < 5 then null
          else round(count(*) filter (where days >= 2)::numeric / count(*), 2)
        end
      )
        from (
          select creator_user_id, count(distinct viewed_on)::integer as days
            from private.network_intelligence_views
           group by creator_user_id
        ) viewers
    )
  );
end;
$$;

comment on function public.read_admin_pilot_kpis() is
  'Admin-only D099 pilot measures. Response time is a band and only at 3 or more creators and 5 or more observations. A zero-decision Gmail rate is null, not 0%. Return rate is null below 5 viewers.';

revoke all on function public.read_admin_pilot_kpis() from public, anon, authenticated;
grant execute on function public.read_admin_pilot_kpis() to authenticated, service_role;

create or replace function public.read_admin_prior_experiment(p_destination_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if public.current_user_role() is distinct from 'admin' then
    return jsonb_build_object('result', 'not_found');
  end if;
  return jsonb_build_object(
    'result', 'ok',
    'prior_applied', false,
    'reason', 'no_proven_lift',
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
               'hotel_id', ranked.hotel_id,
               'baseline_rank', ranked.baseline_rank,
               'prior_rank', ranked.baseline_rank
             ) order by ranked.baseline_rank)
        from (
          select n.hotel_id,
                 row_number() over (
                   order by case n.recency_band
                              when 'past_month' then 1
                              when 'past_quarter' then 2
                              when 'older' then 3
                              else 4
                            end,
                            case n.confidence_level
                              when 'strong' then 1
                              when 'moderate' then 2
                              when 'emerging' then 3
                              else 4
                            end,
                            n.hotel_id
                 ) as baseline_rank
            from public.network_hotel_public n
            join public.hotels h on h.id = n.hotel_id
           where h.destination_id = p_destination_id
             and n.confidence_level in ('emerging', 'moderate', 'strong')
             and (
               n.activity_level is not null
               or n.recency_band is not null
               or n.has_observed_collaboration is true
             )
        ) ranked
    ), '[]'::jsonb)
  );
end;
$$;

comment on function public.read_admin_prior_experiment(uuid) is
  'C04 comparison. The hierarchical prior is not applied: prior_rank equals the baseline. Creators do not receive this function''s body.';

revoke all on function public.read_admin_prior_experiment(uuid) from public, anon, authenticated;
grant execute on function public.read_admin_prior_experiment(uuid) to authenticated, service_role;

create or replace function public.read_own_network_priority(p_hotel_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when auth.uid() is null then jsonb_build_object('result', 'not_found')
    else jsonb_build_object(
      'result', 'ok',
      'prioritized', exists (
        select 1
          from private.network_decision_events e
         where e.creator_user_id = auth.uid()
           and e.hotel_id = p_hotel_id
           and e.decision = 'prioritize'
      )
    )
  end;
$$;

revoke all on function public.read_own_network_priority(uuid) from public, anon, authenticated;
grant execute on function public.read_own_network_priority(uuid) to authenticated, service_role;
