-- ===========================================================================
-- 0044 — B07 slice 1: GMAIL COMMERCIAL MEANING (RULES ENGINE)
-- ===========================================================================
-- D072 / D074. Migration number 0044 is the next free number on main
-- 0d176e42a7487c24c42f7d448f1fb3b3912535e3 (0041–0043 are already used).
--
-- Three layers, never collapsed:
--   observed B04/B06 rows (untouched)
--   → machine interpretation (immutable attempts + replaceable current pointer)
--   → creator decision (append-only events + current projection)
--
-- This slice's engine kind is `rules` only. Model provider, model version and
-- prompt version are columns so provenance can name them later, and a check
-- rejects any non-null model field. No Gmail API call, no CRM write, no G3 row.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. FAIL BEFORE CHOICE
-- ---------------------------------------------------------------------------
do $$
declare
  colliding text[];
begin
  select array_agg(c.relname order by c.relname) into colliding
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'private'
     and c.relkind = 'r'
     and c.relname in (
       'gmail_commercial_message_attempts',
       'gmail_commercial_message_current',
       'gmail_commercial_thread_attempts',
       'gmail_commercial_thread_current',
       'gmail_commercial_creator_decision_events',
       'gmail_commercial_message_decisions',
       'gmail_commercial_thread_decisions'
     );
  if colliding is not null then
    raise exception
      '0044 refuses to install: private table(s) % already exist.',
      array_to_string(colliding, ', ')
      using errcode = 'restrict_violation';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Helpers used by CHECKs. Must exist before the tables.
-- ---------------------------------------------------------------------------
create or replace function private.gmail_commercial_text_array_ok(p_signals text[])
returns boolean
language sql
immutable
set search_path = public, private, pg_temp
as $$
  select p_signals is not null
    and p_signals <@ array[
      'agreement','interest','offer','other_commercial','redirect','rejection',
      'request_information','terms_discussion','timing_constraint'
    ]::text[]
    and cardinality(p_signals) = (
      select count(distinct s) from unnest(p_signals) as u(s)
    );
$$;

create or replace function private.gmail_commercial_signals_json_ok(p_signals jsonb)
returns boolean
language sql
immutable
set search_path = public, private, pg_temp
as $$
  select p_signals is not null
    and jsonb_typeof(p_signals) = 'array'
    and not exists (
      select 1
        from jsonb_array_elements_text(p_signals) as s(value)
       where s.value not in (
         'agreement','interest','offer','other_commercial','redirect','rejection',
         'request_information','terms_discussion','timing_constraint'
       )
    )
    and (
      select count(*) from jsonb_array_elements_text(p_signals)
    ) = (
      select count(distinct s.value) from jsonb_array_elements_text(p_signals) as s(value)
    );
$$;

create or replace function private.gmail_commercial_message_eligible(
  p_provider_sent boolean,
  p_b06_response_class text,
  p_b06_current boolean,
  p_axis_basis text
)
returns boolean
language sql
immutable
set search_path = public, private, pg_temp
as $$
  select case
    when p_provider_sent then false
    when p_axis_basis = 'human_reply' then true
    when p_axis_basis in ('automated', 'delivery', 'not_reply') then false
    else coalesce(p_b06_current, false)
      and p_b06_response_class = 'qualifying_human_reply'
  end;
$$;

revoke all on function private.gmail_commercial_text_array_ok(text[]) from public;
revoke all on function private.gmail_commercial_signals_json_ok(jsonb) from public;
revoke all on function private.gmail_commercial_message_eligible(boolean, text, boolean, text) from public;

-- ===========================================================================
-- 1. MACHINE MESSAGE HISTORY (immutable) AND CURRENT POINTER
-- ===========================================================================
create table private.gmail_commercial_message_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  mail_account_id uuid not null,
  provider_message_id text not null check (length(btrim(provider_message_id)) > 0),
  provider_thread_id text not null check (length(btrim(provider_thread_id)) > 0),
  normalized_thread_id uuid,
  current_normalized_message_id uuid references private.gmail_normalized_messages(id) on delete set null,
  b06_observation_id uuid references private.gmail_reply_message_observations(id) on delete set null,
  b06_response_class text,
  b06_classification_rule_version text,
  b06_relation_rule_version text,
  b06_text_transform_version text,
  axis_a_basis text not null check (axis_a_basis in (
    'none','human_reply','automated','delivery','not_reply','uncertain','cleared'
  )),
  axis_a_event_id uuid,
  axis_a_event_seq bigint,
  source_payload_sha256 text not null check (source_payload_sha256 ~ '^[0-9a-f]{64}$'),
  input_digest text not null check (input_digest ~ '^[0-9a-f]{64}$'),
  schema_version text not null check (schema_version ~ '^[a-z][a-z0-9_]{0,63}$'),
  transform_version text not null check (transform_version ~ '^[a-z][a-z0-9_.+]{0,160}$'),
  engine_kind text not null,
  rule_version text not null check (rule_version ~ '^[a-z][a-z0-9_]{0,63}$'),
  model_provider text,
  model_version text,
  prompt_version text,
  disposition text not null check (disposition in (
    'positive','negative','neutral','mixed','ambiguous'
  )),
  signals text[] not null,
  evidence_strength text not null check (evidence_strength in (
    'strong','moderate','weak','insufficient_evidence'
  )),
  evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint gmail_commercial_message_attempts_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  constraint gmail_commercial_message_attempts_id_anchor_uidx
    unique (id, mail_account_id, provider_message_id),

  constraint gmail_commercial_message_attempts_rules_only check (
    engine_kind = 'rules'
    and model_provider is null
    and model_version is null
    and prompt_version is null
  ),

  constraint gmail_commercial_message_attempts_signals_ok check (
    private.gmail_commercial_text_array_ok(signals)
  ),

  -- Redirect is never rejection. Timing is a different signal and may coexist
  -- with neither; it must not be stored as rejection.
  constraint gmail_commercial_message_attempts_redirect_not_rejection check (
    not ('redirect' = any(signals) and 'rejection' = any(signals))
  ),

  -- A live observation id still requires a class. ON DELETE SET NULL may
  -- clear the id while the copied class and versions stay as provenance.
  constraint gmail_commercial_message_attempts_b06_shape check (
    b06_observation_id is null or b06_response_class is not null
  )
);

comment on table private.gmail_commercial_message_attempts is
  'B07 machine layer: immutable interpretation attempts. Identity of the communication is (mail_account_id, provider_message_id). current_normalized_message_id is a replaceable pointer. engine_kind is rules in this slice; model fields are null.';

create index gmail_commercial_message_attempts_thread_idx
  on private.gmail_commercial_message_attempts (mail_account_id, provider_thread_id, created_at);

create index gmail_commercial_message_attempts_user_idx
  on private.gmail_commercial_message_attempts (user_id);

create table private.gmail_commercial_message_current (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  mail_account_id uuid not null,
  provider_message_id text not null check (length(btrim(provider_message_id)) > 0),
  provider_thread_id text not null check (length(btrim(provider_thread_id)) > 0),
  current_attempt_id uuid not null,
  input_digest text not null check (input_digest ~ '^[0-9a-f]{64}$'),
  stale boolean not null default false,
  stale_reason text,
  suppressed boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gmail_commercial_message_current_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  constraint gmail_commercial_message_current_identity_uidx
    unique (mail_account_id, provider_message_id),

  constraint gmail_commercial_message_current_attempt_fk
    foreign key (current_attempt_id, mail_account_id, provider_message_id)
    references private.gmail_commercial_message_attempts (id, mail_account_id, provider_message_id)
);

comment on table private.gmail_commercial_message_current is
  'B07 replaceable pointer at the machine attempt treated as current for one provider message. Human corrections do not delete the attempt it names.';

create index gmail_commercial_message_current_user_idx
  on private.gmail_commercial_message_current (user_id);

create index gmail_commercial_message_current_thread_idx
  on private.gmail_commercial_message_current (mail_account_id, provider_thread_id);

-- ===========================================================================
-- 2. MACHINE THREAD HISTORY AND CURRENT POINTER
-- ===========================================================================
create table private.gmail_commercial_thread_attempts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  mail_account_id uuid not null,
  provider_thread_id text not null check (length(btrim(provider_thread_id)) > 0),
  normalized_thread_id uuid,
  input_digest text not null check (input_digest ~ '^[0-9a-f]{64}$'),
  schema_version text not null check (schema_version ~ '^[a-z][a-z0-9_]{0,63}$'),
  transform_version text not null check (transform_version ~ '^[a-z][a-z0-9_.+]{0,160}$'),
  engine_kind text not null,
  rule_version text not null check (rule_version ~ '^[a-z][a-z0-9_]{0,63}$'),
  model_provider text,
  model_version text,
  prompt_version text,
  commercial_state text,
  compensation_structure text not null,
  evidence_strength text not null,
  evaluated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint gmail_commercial_thread_attempts_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  constraint gmail_commercial_thread_attempts_id_anchor_uidx
    unique (id, mail_account_id, provider_thread_id),

  constraint gmail_commercial_thread_attempts_rules_only check (
    engine_kind = 'rules'
    and model_provider is null
    and model_version is null
    and prompt_version is null
  ),

  constraint gmail_commercial_thread_attempts_vocab check (
    compensation_structure in ('paid','in_kind','hybrid','unpaid','other','unknown')
    and evidence_strength in ('strong','moderate','weak','insufficient_evidence')
    and (
      commercial_state is null
      or commercial_state in (
        'unresolved','engaged','negotiating','agreement_observed','declined_observed','ambiguous'
      )
    )
  )
);

comment on table private.gmail_commercial_thread_attempts is
  'B07 machine layer: immutable thread advisory state. commercial_state null means no eligible human reply, which is not ghosted and not unpaid. Never a CRM outcome.';

create index gmail_commercial_thread_attempts_user_idx
  on private.gmail_commercial_thread_attempts (user_id);

create table private.gmail_commercial_thread_current (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  mail_account_id uuid not null,
  provider_thread_id text not null check (length(btrim(provider_thread_id)) > 0),
  current_attempt_id uuid not null,
  input_digest text not null check (input_digest ~ '^[0-9a-f]{64}$'),
  stale boolean not null default false,
  stale_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gmail_commercial_thread_current_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  constraint gmail_commercial_thread_current_identity_uidx
    unique (mail_account_id, provider_thread_id),

  constraint gmail_commercial_thread_current_attempt_fk
    foreign key (current_attempt_id, mail_account_id, provider_thread_id)
    references private.gmail_commercial_thread_attempts (id, mail_account_id, provider_thread_id)
);

comment on table private.gmail_commercial_thread_current is
  'B07 replaceable pointer at the current thread machine attempt. A creator outcome lives in a different table and is not this column.';

create index gmail_commercial_thread_current_user_idx
  on private.gmail_commercial_thread_current (user_id);

-- ===========================================================================
-- 3. HUMAN DECISION EVENTS AND CURRENT PROJECTIONS
-- ===========================================================================
create table private.gmail_commercial_creator_decision_events (
  id uuid primary key default gen_random_uuid(),
  event_seq bigint generated always as identity,
  user_id uuid not null references public.users(id) on delete cascade,
  mail_account_id uuid not null,
  decided_by_user_id uuid not null,
  axis text not null check (axis in (
    'reply_nature','disposition','signals','business_outcome','compensation'
  )),
  provider_message_id text,
  provider_thread_id text,
  action text not null check (action in ('set','clear')),
  reply_nature text,
  disposition text,
  signals text[],
  business_outcome text,
  lost_reason text,
  compensation_structure text,
  observed_machine_value text,
  -- The machine attempt that was current for this axis when the creator decided.
  -- Message axes point at a message attempt; thread axes point at a thread attempt.
  observed_machine_attempt_id uuid,
  decided_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint gmail_commercial_creator_events_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  constraint gmail_commercial_creator_events_decider_chk check (decided_by_user_id = user_id),

  constraint gmail_commercial_creator_events_message_anchor_uidx
    unique (id, user_id, mail_account_id, axis, provider_message_id),

  constraint gmail_commercial_creator_events_thread_anchor_uidx
    unique (id, user_id, mail_account_id, axis, provider_thread_id),

  constraint gmail_commercial_creator_events_anchor_chk check (
    (
      axis in ('reply_nature','disposition','signals')
      and provider_message_id is not null
      and length(btrim(provider_message_id)) > 0
      and provider_thread_id is null
    )
    or (
      axis in ('business_outcome','compensation')
      and provider_thread_id is not null
      and length(btrim(provider_thread_id)) > 0
      and provider_message_id is null
    )
  ),

  constraint gmail_commercial_creator_events_signals_ok check (
    signals is null or private.gmail_commercial_text_array_ok(signals)
  ),

  constraint gmail_commercial_creator_events_shape_chk check (
    (
      action = 'clear'
      and reply_nature is null and disposition is null and signals is null
      and business_outcome is null and lost_reason is null and compensation_structure is null
    )
    or (
      action = 'set' and axis = 'reply_nature'
      and reply_nature in ('human_reply','automated','delivery','not_reply','uncertain')
      and disposition is null and signals is null and business_outcome is null
      and lost_reason is null and compensation_structure is null
    )
    or (
      action = 'set' and axis = 'disposition'
      and disposition in ('positive','negative','neutral','mixed','ambiguous')
      and reply_nature is null and signals is null and business_outcome is null
      and lost_reason is null and compensation_structure is null
    )
    or (
      action = 'set' and axis = 'signals'
      and signals is not null
      and reply_nature is null and disposition is null and business_outcome is null
      and lost_reason is null and compensation_structure is null
    )
    or (
      action = 'set' and axis = 'business_outcome'
      and business_outcome in ('open','won','lost','ghosted','uncertain')
      and (
        (business_outcome = 'lost' and lost_reason in ('rejected','not_a_fit','timing','other'))
        or (business_outcome <> 'lost' and lost_reason is null)
      )
      and reply_nature is null and disposition is null and signals is null
      and compensation_structure is null
    )
    or (
      action = 'set' and axis = 'compensation'
      and compensation_structure in ('paid','in_kind','hybrid','unpaid','other','unknown')
      and reply_nature is null and disposition is null and signals is null
      and business_outcome is null and lost_reason is null
    )
  )
);

comment on table private.gmail_commercial_creator_decision_events is
  'B07 human layer: append-only creator decisions. event_seq is the only ordering authority. Machine writers cannot insert here. Clear is a new event, not a delete.';

create index gmail_commercial_creator_events_message_idx
  on private.gmail_commercial_creator_decision_events (mail_account_id, provider_message_id, axis, event_seq);

create index gmail_commercial_creator_events_thread_idx
  on private.gmail_commercial_creator_decision_events (mail_account_id, provider_thread_id, axis, event_seq);

create index gmail_commercial_creator_events_user_idx
  on private.gmail_commercial_creator_decision_events (user_id);

create table private.gmail_commercial_message_decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  mail_account_id uuid not null,
  provider_message_id text not null check (length(btrim(provider_message_id)) > 0),
  axis text not null check (axis in ('reply_nature','disposition','signals')),
  is_cleared boolean not null,
  reply_nature text,
  disposition text,
  signals text[],
  current_event_id uuid not null,
  current_event_seq bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gmail_commercial_message_decisions_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  constraint gmail_commercial_message_decisions_identity_uidx
    unique (mail_account_id, provider_message_id, axis),

  constraint gmail_commercial_message_decisions_event_fk
    foreign key (current_event_id, user_id, mail_account_id, axis, provider_message_id)
    references private.gmail_commercial_creator_decision_events
      (id, user_id, mail_account_id, axis, provider_message_id),

  constraint gmail_commercial_message_decisions_signals_ok check (
    signals is null or private.gmail_commercial_text_array_ok(signals)
  ),

  constraint gmail_commercial_message_decisions_shape_chk check (
    (
      axis = 'reply_nature' and disposition is null and signals is null
      and (
        (is_cleared and reply_nature is null)
        or (not is_cleared and reply_nature in ('human_reply','automated','delivery','not_reply','uncertain'))
      )
    )
    or (
      axis = 'disposition' and reply_nature is null and signals is null
      and (
        (is_cleared and disposition is null)
        or (not is_cleared and disposition in ('positive','negative','neutral','mixed','ambiguous'))
      )
    )
    or (
      axis = 'signals' and reply_nature is null and disposition is null
      and (
        (is_cleared and signals is null)
        or (not is_cleared and signals is not null)
      )
    )
  )
);

comment on table private.gmail_commercial_message_decisions is
  'B07 current human projection for message axes. The composite FK cannot point at another account, axis, or message, and current_event_seq cannot move backwards.';

create index gmail_commercial_message_decisions_user_idx
  on private.gmail_commercial_message_decisions (user_id);

create table private.gmail_commercial_thread_decisions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  mail_account_id uuid not null,
  provider_thread_id text not null check (length(btrim(provider_thread_id)) > 0),
  axis text not null check (axis in ('business_outcome','compensation')),
  is_cleared boolean not null,
  business_outcome text,
  lost_reason text,
  compensation_structure text,
  current_event_id uuid not null,
  current_event_seq bigint not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gmail_commercial_thread_decisions_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  constraint gmail_commercial_thread_decisions_identity_uidx
    unique (mail_account_id, provider_thread_id, axis),

  constraint gmail_commercial_thread_decisions_event_fk
    foreign key (current_event_id, user_id, mail_account_id, axis, provider_thread_id)
    references private.gmail_commercial_creator_decision_events
      (id, user_id, mail_account_id, axis, provider_thread_id),

  constraint gmail_commercial_thread_decisions_shape_chk check (
    (
      axis = 'business_outcome' and compensation_structure is null
      and (
        (is_cleared and business_outcome is null and lost_reason is null)
        or (
          not is_cleared
          and business_outcome in ('open','won','lost','ghosted','uncertain')
          and (
            (business_outcome = 'lost' and lost_reason in ('rejected','not_a_fit','timing','other'))
            or (business_outcome <> 'lost' and lost_reason is null)
          )
        )
      )
    )
    or (
      axis = 'compensation' and business_outcome is null and lost_reason is null
      and (
        (is_cleared and compensation_structure is null)
        or (
          not is_cleared
          and compensation_structure in ('paid','in_kind','hybrid','unpaid','other','unknown')
        )
      )
    )
  )
);

comment on table private.gmail_commercial_thread_decisions is
  'B07 current human projection for thread outcome and compensation. Machine commercial_state is a different table and is never written here.';

create index gmail_commercial_thread_decisions_user_idx
  on private.gmail_commercial_thread_decisions (user_id);

-- ===========================================================================
-- 4. WRITER GUARDS
-- ===========================================================================
create or replace function private.gmail_commercial_guard_attempt()
returns trigger
language plpgsql
set search_path = public, private, pg_temp
as $$
begin
  if tg_op = 'DELETE' and current_setting('b07.purge', true) = 'on' then
    return old;
  end if;

  -- Semantic columns are frozen. Pointer columns may transition to NULL only,
  -- which is how ON DELETE SET NULL survives a B04 rebuild or a B06 purge
  -- without retargeting the attempt at a different row.
  if tg_op = 'UPDATE' then
    if tg_table_name = 'gmail_commercial_message_attempts' then
      if new.id is distinct from old.id
         or new.user_id is distinct from old.user_id
         or new.mail_account_id is distinct from old.mail_account_id
         or new.provider_message_id is distinct from old.provider_message_id
         or new.provider_thread_id is distinct from old.provider_thread_id
         or new.b06_response_class is distinct from old.b06_response_class
         or new.b06_classification_rule_version is distinct from old.b06_classification_rule_version
         or new.b06_relation_rule_version is distinct from old.b06_relation_rule_version
         or new.b06_text_transform_version is distinct from old.b06_text_transform_version
         or new.axis_a_basis is distinct from old.axis_a_basis
         or new.axis_a_event_id is distinct from old.axis_a_event_id
         or new.axis_a_event_seq is distinct from old.axis_a_event_seq
         or new.source_payload_sha256 is distinct from old.source_payload_sha256
         or new.input_digest is distinct from old.input_digest
         or new.schema_version is distinct from old.schema_version
         or new.transform_version is distinct from old.transform_version
         or new.engine_kind is distinct from old.engine_kind
         or new.rule_version is distinct from old.rule_version
         or new.model_provider is distinct from old.model_provider
         or new.model_version is distinct from old.model_version
         or new.prompt_version is distinct from old.prompt_version
         or new.disposition is distinct from old.disposition
         or new.signals is distinct from old.signals
         or new.evidence_strength is distinct from old.evidence_strength
         or new.evaluated_at is distinct from old.evaluated_at
         or new.created_at is distinct from old.created_at
      then
        raise exception 'B07 machine attempts are immutable'
          using errcode = 'insufficient_privilege';
      end if;
      if (new.current_normalized_message_id is distinct from old.current_normalized_message_id
          and new.current_normalized_message_id is not null)
         or (new.b06_observation_id is distinct from old.b06_observation_id
          and new.b06_observation_id is not null)
         or (new.normalized_thread_id is distinct from old.normalized_thread_id
          and new.normalized_thread_id is not null)
      then
        raise exception 'B07 attempt pointers may only be cleared, never retargeted'
          using errcode = 'insufficient_privilege';
      end if;
      return new;
    end if;

    if new.id is distinct from old.id
       or new.user_id is distinct from old.user_id
       or new.mail_account_id is distinct from old.mail_account_id
       or new.provider_thread_id is distinct from old.provider_thread_id
       or new.input_digest is distinct from old.input_digest
       or new.schema_version is distinct from old.schema_version
       or new.transform_version is distinct from old.transform_version
       or new.engine_kind is distinct from old.engine_kind
       or new.rule_version is distinct from old.rule_version
       or new.model_provider is distinct from old.model_provider
       or new.model_version is distinct from old.model_version
       or new.prompt_version is distinct from old.prompt_version
       or new.commercial_state is distinct from old.commercial_state
       or new.compensation_structure is distinct from old.compensation_structure
       or new.evidence_strength is distinct from old.evidence_strength
       or new.evaluated_at is distinct from old.evaluated_at
       or new.created_at is distinct from old.created_at
    then
      raise exception 'B07 machine attempts are immutable'
        using errcode = 'insufficient_privilege';
    end if;
    if new.normalized_thread_id is distinct from old.normalized_thread_id
       and new.normalized_thread_id is not null
    then
      raise exception 'B07 attempt pointers may only be cleared, never retargeted'
        using errcode = 'insufficient_privilege';
    end if;
    return new;
  end if;

  if tg_op = 'INSERT' and current_setting('b07.machine_writer', true) = 'on' then
    return new;
  end if;
  raise exception 'B07 machine history changes only through the machine commit writer or purge'
    using errcode = 'insufficient_privilege';
end;
$$;

create or replace function private.gmail_commercial_guard_machine_current()
returns trigger
language plpgsql
set search_path = public, private, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('b07.purge', true) = 'on' then
      return old;
    end if;
    raise exception 'B07 machine current rows are removed only by purge'
      using errcode = 'insufficient_privilege';
  end if;

  if current_setting('b07.machine_writer', true) = 'on' then
    return new;
  end if;

  if current_setting('b07.human_writer', true) = 'on' and tg_op = 'UPDATE' then
    if new.current_attempt_id is distinct from old.current_attempt_id
       or new.input_digest is distinct from old.input_digest
       or new.user_id is distinct from old.user_id
       or new.mail_account_id is distinct from old.mail_account_id
       or new.provider_thread_id is distinct from old.provider_thread_id then
      raise exception 'creator decisions do not rewrite machine interpretation identity'
        using errcode = 'insufficient_privilege';
    end if;
    -- PL/pgSQL does not skip the right-hand field access, and thread current
    -- rows have no provider_message_id.
    if tg_table_name = 'gmail_commercial_message_current' then
      if new.provider_message_id is distinct from old.provider_message_id then
        raise exception 'creator decisions do not rewrite machine interpretation identity'
          using errcode = 'insufficient_privilege';
      end if;
    end if;
    return new;
  end if;

  raise exception 'only the machine commit writer may modify B07 machine current rows'
    using errcode = 'insufficient_privilege';
end;
$$;

-- A B04 rebuild clears current_normalized_message_id inside the delete that
-- removed the old normalized row. That same transaction must stop presenting
-- the old attempt as current. The GUC is restored so the rest of the B04
-- transaction does not become a machine writer.
create or replace function private.gmail_commercial_mark_source_rebuilt()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_prev text;
begin
  if tg_op <> 'UPDATE' then
    return null;
  end if;

  if tg_table_name = 'gmail_commercial_message_attempts' then
    if old.current_normalized_message_id is not null
       and new.current_normalized_message_id is null then
      v_prev := current_setting('b07.machine_writer', true);
      perform set_config('b07.machine_writer', 'on', true);
      update private.gmail_commercial_message_current
         set stale = true,
             suppressed = true,
             stale_reason = 'source_rebuilt',
             updated_at = now()
       where mail_account_id = new.mail_account_id
         and provider_message_id = new.provider_message_id;
      update private.gmail_commercial_thread_current
         set stale = true,
             stale_reason = 'source_rebuilt',
             updated_at = now()
       where mail_account_id = new.mail_account_id
         and provider_thread_id = new.provider_thread_id;
      perform set_config('b07.machine_writer', coalesce(v_prev, ''), true);
    end if;
    return null;
  end if;

  if old.normalized_thread_id is not null and new.normalized_thread_id is null then
    v_prev := current_setting('b07.machine_writer', true);
    perform set_config('b07.machine_writer', 'on', true);
    update private.gmail_commercial_thread_current
       set stale = true,
           stale_reason = 'source_rebuilt',
           updated_at = now()
     where mail_account_id = new.mail_account_id
       and provider_thread_id = new.provider_thread_id;
    perform set_config('b07.machine_writer', coalesce(v_prev, ''), true);
  end if;
  return null;
end;
$$;

create or replace function private.gmail_commercial_guard_human_event()
returns trigger
language plpgsql
set search_path = public, private, pg_temp
as $$
begin
  if tg_op = 'DELETE' and current_setting('b07.purge', true) = 'on' then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'B07 human decision events are append-only'
      using errcode = 'insufficient_privilege';
  end if;
  if current_setting('b07.human_writer', true) = 'on' then
    return new;
  end if;
  raise exception 'only the creator-decision writer may insert B07 human truth'
    using errcode = 'insufficient_privilege';
end;
$$;

create or replace function private.gmail_commercial_guard_human_projection()
returns trigger
language plpgsql
set search_path = public, private, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('b07.purge', true) = 'on' then
      return old;
    end if;
    raise exception 'B07 human projections are removed only by purge'
      using errcode = 'insufficient_privilege';
  end if;
  if current_setting('b07.human_writer', true) is distinct from 'on' then
    raise exception 'only the creator-decision writer may modify B07 human projections'
      using errcode = 'insufficient_privilege';
  end if;
  if tg_op = 'UPDATE' and new.current_event_seq <= old.current_event_seq then
    raise exception 'stale creator decision cannot move the current projection backwards'
      using errcode = 'serialization_failure';
  end if;
  return new;
end;
$$;

revoke all on function private.gmail_commercial_guard_attempt() from public;
revoke all on function private.gmail_commercial_guard_machine_current() from public;
revoke all on function private.gmail_commercial_guard_human_event() from public;
revoke all on function private.gmail_commercial_guard_human_projection() from public;
revoke all on function private.gmail_commercial_mark_source_rebuilt() from public;

create trigger gmail_commercial_message_attempts_guard
  before insert or update or delete on private.gmail_commercial_message_attempts
  for each row execute function private.gmail_commercial_guard_attempt();

create trigger gmail_commercial_thread_attempts_guard
  before insert or update or delete on private.gmail_commercial_thread_attempts
  for each row execute function private.gmail_commercial_guard_attempt();

create trigger gmail_commercial_message_attempts_source_rebuilt
  after update on private.gmail_commercial_message_attempts
  for each row execute function private.gmail_commercial_mark_source_rebuilt();

create trigger gmail_commercial_thread_attempts_source_rebuilt
  after update on private.gmail_commercial_thread_attempts
  for each row execute function private.gmail_commercial_mark_source_rebuilt();

create trigger gmail_commercial_message_current_guard
  before insert or update or delete on private.gmail_commercial_message_current
  for each row execute function private.gmail_commercial_guard_machine_current();

create trigger gmail_commercial_thread_current_guard
  before insert or update or delete on private.gmail_commercial_thread_current
  for each row execute function private.gmail_commercial_guard_machine_current();

create trigger gmail_commercial_creator_events_guard
  before insert or update or delete on private.gmail_commercial_creator_decision_events
  for each row execute function private.gmail_commercial_guard_human_event();

create trigger gmail_commercial_message_decisions_guard
  before insert or update or delete on private.gmail_commercial_message_decisions
  for each row execute function private.gmail_commercial_guard_human_projection();

create trigger gmail_commercial_thread_decisions_guard
  before insert or update or delete on private.gmail_commercial_thread_decisions
  for each row execute function private.gmail_commercial_guard_human_projection();

-- ===========================================================================
-- 5. DIGEST AND PER-MESSAGE VIEW (one definition, used by read and commit)
-- ===========================================================================
create or replace function private.gmail_commercial_message_rows(
  p_mail_account_id uuid,
  p_normalized_thread_id uuid
)
returns table (
  provider_message_id text,
  provider_sent boolean,
  internal_date timestamptz,
  source_payload_sha256 text,
  normalized_message_id uuid,
  b06_observation_id uuid,
  b06_response_class text,
  b06_classification_rule_version text,
  b06_relation_rule_version text,
  b06_text_transform_version text,
  b06_current boolean,
  axis_basis text,
  axis_event_id uuid,
  axis_event_seq bigint,
  eligible boolean
)
language sql
stable
set search_path = public, private, pg_temp
as $$
  select
    m.provider_message_id,
    m.provider_sent,
    m.internal_date,
    m.source_payload_sha256,
    m.id,
    o.id,
    o.response_class,
    o.classification_rule_version,
    o.relation_rule_version,
    o.text_transform_version,
    coalesce(o.current_normalized_message_id is not null, false),
    coalesce(case when ax.is_cleared then 'cleared' else ax.reply_nature end, 'none'),
    ax.current_event_id,
    ax.current_event_seq,
    private.gmail_commercial_message_eligible(
      m.provider_sent,
      o.response_class,
      coalesce(o.current_normalized_message_id is not null, false),
      coalesce(case when ax.is_cleared then 'cleared' else ax.reply_nature end, 'none')
    )
  from private.gmail_normalized_messages m
  left join private.gmail_reply_message_observations o
    on o.mail_account_id = m.mail_account_id
   and o.provider_message_id = m.provider_message_id
  left join private.gmail_commercial_message_decisions ax
    on ax.mail_account_id = m.mail_account_id
   and ax.provider_message_id = m.provider_message_id
   and ax.axis = 'reply_nature'
  where m.mail_account_id = p_mail_account_id
    and m.normalized_thread_id = p_normalized_thread_id;
$$;

create or replace function private.gmail_commercial_input_digest(
  p_mail_account_id uuid,
  p_normalized_thread_id uuid,
  p_schema_version text,
  p_transform_version text,
  p_rule_version text
)
returns text
language sql
stable
set search_path = public, private, pg_temp
as $$
  select encode(digest(
    p_schema_version || '|' || p_transform_version || '|' || p_rule_version || '|' ||
    coalesce(private.gmail_reply_thread_eligibility(p_mail_account_id, p_normalized_thread_id), '') || '|' ||
    coalesce((
      select t.provider_thread_id
        from private.gmail_normalized_threads t
       where t.id = p_normalized_thread_id
         and t.mail_account_id = p_mail_account_id
    ), '') || E'\n' ||
    coalesce((
      select string_agg(
        r.provider_message_id || '|' || r.source_payload_sha256 || '|' || r.provider_sent::text || '|' ||
        coalesce(r.b06_response_class, 'absent') || '|' ||
        coalesce(r.b06_classification_rule_version, '') || '|' ||
        coalesce(r.b06_relation_rule_version, '') || '|' ||
        coalesce(r.b06_text_transform_version, '') || '|' ||
        case when r.b06_current then '1' else '0' end || '|' ||
        r.axis_basis || '|' || coalesce(r.axis_event_seq::text, ''),
        E'\n' order by r.provider_message_id
      )
      from private.gmail_commercial_message_rows(p_mail_account_id, p_normalized_thread_id) r
    ), ''),
    'sha256'
  ), 'hex');
$$;

revoke all on function private.gmail_commercial_message_rows(uuid, uuid) from public;
revoke all on function private.gmail_commercial_input_digest(uuid, uuid, text, text, text) from public;

-- ===========================================================================
-- 6. DELETION MUST PURGE B07 TOO
-- ===========================================================================
create or replace function public.assert_gmail_commercial_data_absent_when_deleted()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  account_id uuid;
  account_state text;
  remaining_count integer;
begin
  if tg_table_name = 'mail_accounts' then
    account_id := coalesce(new.id, old.id);
  else
    account_id := coalesce(new.mail_account_id, old.mail_account_id);
  end if;

  if account_id is null then
    return null;
  end if;

  select m.connection_state into account_state
    from public.mail_accounts m where m.id = account_id;

  if not found or account_state <> 'deleted' then
    return null;
  end if;

  select
    (select count(*) from private.gmail_commercial_message_attempts where mail_account_id = account_id)
    + (select count(*) from private.gmail_commercial_message_current where mail_account_id = account_id)
    + (select count(*) from private.gmail_commercial_thread_attempts where mail_account_id = account_id)
    + (select count(*) from private.gmail_commercial_thread_current where mail_account_id = account_id)
    + (select count(*) from private.gmail_commercial_creator_decision_events where mail_account_id = account_id)
    + (select count(*) from private.gmail_commercial_message_decisions where mail_account_id = account_id)
    + (select count(*) from private.gmail_commercial_thread_decisions where mail_account_id = account_id)
    into remaining_count;

  if remaining_count > 0 then
    raise exception
      'mail account % is deleted while B07 commercial-meaning state remains (% row(s)).',
      account_id, remaining_count
      using errcode = 'integrity_constraint_violation';
  end if;

  return null;
end;
$$;

revoke all on function public.assert_gmail_commercial_data_absent_when_deleted() from public;
revoke all on function public.assert_gmail_commercial_data_absent_when_deleted() from anon, authenticated;

create constraint trigger mail_accounts_gmail_commercial_absent_when_deleted
  after insert or update on public.mail_accounts
  deferrable initially deferred
  for each row execute function public.assert_gmail_commercial_data_absent_when_deleted();

create constraint trigger gmail_commercial_message_attempts_absent_when_deleted
  after insert or update on private.gmail_commercial_message_attempts
  deferrable initially deferred
  for each row execute function public.assert_gmail_commercial_data_absent_when_deleted();

create constraint trigger gmail_commercial_message_current_absent_when_deleted
  after insert or update on private.gmail_commercial_message_current
  deferrable initially deferred
  for each row execute function public.assert_gmail_commercial_data_absent_when_deleted();

create constraint trigger gmail_commercial_thread_attempts_absent_when_deleted
  after insert or update on private.gmail_commercial_thread_attempts
  deferrable initially deferred
  for each row execute function public.assert_gmail_commercial_data_absent_when_deleted();

create constraint trigger gmail_commercial_thread_current_absent_when_deleted
  after insert or update on private.gmail_commercial_thread_current
  deferrable initially deferred
  for each row execute function public.assert_gmail_commercial_data_absent_when_deleted();

create constraint trigger gmail_commercial_creator_events_absent_when_deleted
  after insert or update on private.gmail_commercial_creator_decision_events
  deferrable initially deferred
  for each row execute function public.assert_gmail_commercial_data_absent_when_deleted();

create constraint trigger gmail_commercial_message_decisions_absent_when_deleted
  after insert or update on private.gmail_commercial_message_decisions
  deferrable initially deferred
  for each row execute function public.assert_gmail_commercial_data_absent_when_deleted();

create constraint trigger gmail_commercial_thread_decisions_absent_when_deleted
  after insert or update on private.gmail_commercial_thread_decisions
  deferrable initially deferred
  for each row execute function public.assert_gmail_commercial_data_absent_when_deleted();
-- ===========================================================================
-- 7. ACCOUNT-SCOPED THREAD POINTER
-- ===========================================================================
-- SET NULL lists only the thread id (PostgreSQL 15+). mail_account_id stays,
-- so a deleted normalized thread cannot drag the attempt into another account
-- and cannot violate the NOT NULL account column.
alter table private.gmail_commercial_message_attempts
  add constraint gmail_commercial_message_attempts_thread_fk
  foreign key (normalized_thread_id, mail_account_id)
  references private.gmail_normalized_threads (id, mail_account_id)
  on delete set null (normalized_thread_id);

alter table private.gmail_commercial_thread_attempts
  add constraint gmail_commercial_thread_attempts_thread_fk
  foreign key (normalized_thread_id, mail_account_id)
  references private.gmail_normalized_threads (id, mail_account_id)
  on delete set null (normalized_thread_id);

-- ===========================================================================
-- 8. MACHINE EVIDENCE (service_role) — source text, consent required
-- ===========================================================================
create or replace function public.gmail_commercial_get_thread_evidence(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_normalized_thread_id uuid,
  p_schema_version text,
  p_transform_version text,
  p_rule_version text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_owner uuid;
  v_may text;
  v_thread private.gmail_normalized_threads%rowtype;
  v_eligibility text;
  v_digest text;
begin
  if p_schema_version !~ '^[a-z][a-z0-9_]{0,63}$'
     or p_rule_version !~ '^[a-z][a-z0-9_]{0,63}$'
     or p_transform_version !~ '^[a-z][a-z0-9_.+]{0,160}$' then
    raise exception 'invalid commercial schema/transform/rule version'
      using errcode = 'invalid_parameter_value';
  end if;

  select m.user_id into v_owner
    from public.mail_accounts m
   where m.id = p_mail_account_id and m.user_id = p_user_id;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  v_may := private.gmail_outreach_assert_may_process_locked(p_mail_account_id);
  if v_may <> 'ok' then
    return jsonb_build_object('result', v_may);
  end if;

  select t.* into v_thread
    from private.gmail_normalized_threads t
   where t.id = p_normalized_thread_id and t.mail_account_id = p_mail_account_id;
  if not found then
    return jsonb_build_object('result', 'thread_not_found');
  end if;

  v_eligibility := private.gmail_reply_thread_eligibility(p_mail_account_id, p_normalized_thread_id);
  if v_eligibility = 'not_eligible' then
    return jsonb_build_object('result', 'not_eligible');
  end if;

  v_digest := private.gmail_commercial_input_digest(
    p_mail_account_id, p_normalized_thread_id,
    p_schema_version, p_transform_version, p_rule_version
  );

  return jsonb_build_object(
    'result', 'ok',
    'provider_thread_id', v_thread.provider_thread_id,
    'input_digest', v_digest,
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider_message_id', r.provider_message_id,
        'provider_sent', r.provider_sent,
        'internal_date_ms', (extract(epoch from r.internal_date) * 1000)::bigint,
        'eligible', r.eligible
      ) order by r.internal_date, r.provider_message_id)
      from private.gmail_commercial_message_rows(p_mail_account_id, p_normalized_thread_id) r
    ), '[]'::jsonb),
    'text_parts', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider_message_id', m.provider_message_id,
        'mime_type', tp.mime_type,
        'decode_status', tp.decode_status,
        'decoded_text', tp.decoded_text
      ) order by m.provider_message_id, tp.part_path)
      from private.gmail_normalized_messages m
      join private.gmail_normalized_text_parts tp on tp.normalized_message_id = m.id
      where m.mail_account_id = p_mail_account_id
        and m.normalized_thread_id = p_normalized_thread_id
    ), '[]'::jsonb)
  );
end;
$$;

-- ===========================================================================
-- 9. MACHINE COMMIT (service_role)
-- ===========================================================================
-- Recomputes the digest under the account lock. Equal digest + a current
-- projection is already_current even if the payload differs: the same rule
-- version cannot oscillate. A behavior change requires a new rule version,
-- which changes the digest.
create or replace function public.gmail_commercial_commit_interpretation(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_normalized_thread_id uuid,
  p_schema_version text,
  p_transform_version text,
  p_rule_version text,
  p_expected_input_digest text,
  p_messages jsonb,
  p_thread jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_owner uuid;
  v_may text;
  v_thread private.gmail_normalized_threads%rowtype;
  v_eligibility text;
  v_digest text;
  v_state text;
  v_compensation text;
  v_evidence text;
  v_eligible_count integer;
  v_payload_count integer;
  v_distinct_count integer;
  v_set_mismatch boolean;
  v_bad_shape boolean;
  v_latest_signals jsonb;
  v_already boolean;
begin
  if p_schema_version !~ '^[a-z][a-z0-9_]{0,63}$'
     or p_rule_version !~ '^[a-z][a-z0-9_]{0,63}$'
     or p_transform_version !~ '^[a-z][a-z0-9_.+]{0,160}$' then
    raise exception 'invalid commercial schema/transform/rule version'
      using errcode = 'invalid_parameter_value';
  end if;

  select m.user_id into v_owner
    from public.mail_accounts m
   where m.id = p_mail_account_id and m.user_id = p_user_id;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  v_may := private.gmail_outreach_assert_may_process_locked(p_mail_account_id);
  if v_may <> 'ok' then
    return jsonb_build_object('result', v_may);
  end if;

  -- Upgrade the share lock from the fence to an exclusive lock so a human
  -- correction and a second commit serialize on this account.
  perform 1 from public.mail_accounts where id = p_mail_account_id for update;

  select t.* into v_thread
    from private.gmail_normalized_threads t
   where t.id = p_normalized_thread_id and t.mail_account_id = p_mail_account_id
   for key share;
  if not found then
    return jsonb_build_object('result', 'thread_not_found');
  end if;

  v_eligibility := private.gmail_reply_thread_eligibility(p_mail_account_id, p_normalized_thread_id);
  if v_eligibility = 'not_eligible' then
    perform set_config('b07.machine_writer', 'on', true);
    update private.gmail_commercial_message_current
       set stale = true, stale_reason = 'b05_not_eligible', updated_at = now()
     where mail_account_id = p_mail_account_id
       and provider_thread_id = v_thread.provider_thread_id;
    update private.gmail_commercial_thread_current
       set stale = true, stale_reason = 'b05_not_eligible', updated_at = now()
     where mail_account_id = p_mail_account_id
       and provider_thread_id = v_thread.provider_thread_id;
    return jsonb_build_object('result', 'not_eligible');
  end if;

  perform 1
    from private.gmail_normalized_messages m
   where m.mail_account_id = p_mail_account_id
     and m.normalized_thread_id = p_normalized_thread_id
   for key share;

  v_digest := private.gmail_commercial_input_digest(
    p_mail_account_id, p_normalized_thread_id,
    p_schema_version, p_transform_version, p_rule_version
  );
  if v_digest is distinct from p_expected_input_digest then
    -- No new attempt. The previous current row must stop being presented as current.
    perform set_config('b07.machine_writer', 'on', true);
    update private.gmail_commercial_message_current c
       set stale = true,
           suppressed = c.suppressed or exists (
             select 1
               from private.gmail_commercial_message_attempts a
              where a.id = c.current_attempt_id
                and a.current_normalized_message_id is null
           ),
           stale_reason = 'stale_source',
           updated_at = now()
     where c.mail_account_id = p_mail_account_id
       and c.provider_thread_id = v_thread.provider_thread_id;
    update private.gmail_commercial_thread_current
       set stale = true, stale_reason = 'stale_source', updated_at = now()
     where mail_account_id = p_mail_account_id
       and provider_thread_id = v_thread.provider_thread_id;
    perform set_config('b07.machine_writer', '', true);
    return jsonb_build_object('result', 'stale_source', 'current_input_digest', v_digest);
  end if;

  if p_thread is null or jsonb_typeof(p_thread) <> 'object' then
    raise exception 'thread payload must be an object' using errcode = 'check_violation';
  end if;
  v_state := p_thread->>'commercial_state';
  v_compensation := p_thread->>'compensation_structure';
  v_evidence := p_thread->>'evidence_strength';
  if v_compensation not in ('paid','in_kind','hybrid','unpaid','other','unknown')
     or v_evidence not in ('strong','moderate','weak','insufficient_evidence')
     or (v_state is not null and v_state not in (
       'unresolved','engaged','negotiating','agreement_observed','declined_observed','ambiguous'
     ))
  then
    raise exception 'unknown commercial thread vocabulary' using errcode = 'check_violation';
  end if;

  select count(*)::int into v_eligible_count
    from private.gmail_commercial_message_rows(p_mail_account_id, p_normalized_thread_id) r
   where r.eligible;

  with payload as (
    select elem->>'provider_message_id' as provider_message_id
      from jsonb_array_elements(coalesce(p_messages, '[]'::jsonb)) elem
  ),
  eligible as (
    select r.provider_message_id
      from private.gmail_commercial_message_rows(p_mail_account_id, p_normalized_thread_id) r
     where r.eligible
  )
  select
    (select count(*)::int from payload),
    (select count(distinct provider_message_id)::int from payload),
    exists (select 1 from eligible e where not exists (
      select 1 from payload p where p.provider_message_id = e.provider_message_id))
    or exists (select 1 from payload p where not exists (
      select 1 from eligible e where e.provider_message_id = p.provider_message_id))
    into v_payload_count, v_distinct_count, v_set_mismatch;

  if v_payload_count <> v_distinct_count or v_set_mismatch then
    raise exception 'commercial payload is not exactly the eligible message set'
      using errcode = 'check_violation';
  end if;

  select exists (
    select 1
      from jsonb_array_elements(coalesce(p_messages, '[]'::jsonb)) elem
     where elem->>'disposition' not in ('positive','negative','neutral','mixed','ambiguous')
        or elem->>'evidence_strength' not in ('strong','moderate','weak','insufficient_evidence')
        or not private.gmail_commercial_signals_json_ok(elem->'signals')
        or ((elem->'signals') @> '["redirect"]'::jsonb and (elem->'signals') @> '["rejection"]'::jsonb)
  ) into v_bad_shape;
  if v_bad_shape then
    raise exception 'unknown commercial message vocabulary or redirect combined with rejection'
      using errcode = 'check_violation';
  end if;

  if v_eligible_count = 0 then
    if v_state is not null or v_compensation <> 'unknown' or v_evidence <> 'insufficient_evidence' then
      raise exception 'an empty eligible set is not a commercial state, unpaid, or ghosted'
        using errcode = 'check_violation';
    end if;
  end if;

  if v_state = 'declined_observed' then
    select elem->'signals' into v_latest_signals
      from private.gmail_commercial_message_rows(p_mail_account_id, p_normalized_thread_id) r
      join jsonb_array_elements(coalesce(p_messages, '[]'::jsonb)) elem
        on elem->>'provider_message_id' = r.provider_message_id
     where r.eligible
     order by r.internal_date desc, r.provider_message_id desc
     limit 1;
    if v_latest_signals is null
       or not (v_latest_signals @> '["rejection"]'::jsonb)
       or v_latest_signals @> '["redirect"]'::jsonb
       or v_latest_signals @> '["timing_constraint"]'::jsonb
    then
      raise exception 'declined_observed requires a latest eligible rejection without redirect or timing_constraint'
        using errcode = 'check_violation';
    end if;
  end if;

  -- Same bar as the rules engine: an explicit booking confirmation, an earlier
  -- creator-sent message, and no later eligible rejection. A one-sided
  -- "we accept" is an agreement signal and stays negotiating.
  if v_state = 'agreement_observed' then
    if not exists (
      select 1
        from private.gmail_commercial_message_rows(p_mail_account_id, p_normalized_thread_id) r
        join jsonb_array_elements(coalesce(p_messages, '[]'::jsonb)) elem
          on elem->>'provider_message_id' = r.provider_message_id
       where r.eligible
         and elem->>'explicit_booking_confirmation' = 'true'
         and (elem->'signals') @> '["agreement"]'::jsonb
         and exists (
           select 1
             from private.gmail_commercial_message_rows(p_mail_account_id, p_normalized_thread_id) sent
            where sent.provider_sent and sent.internal_date < r.internal_date
         )
         and not exists (
           select 1
             from private.gmail_commercial_message_rows(p_mail_account_id, p_normalized_thread_id) later
             join jsonb_array_elements(coalesce(p_messages, '[]'::jsonb)) later_elem
               on later_elem->>'provider_message_id' = later.provider_message_id
            where later.eligible
              and (later.internal_date, later.provider_message_id)
                  > (r.internal_date, r.provider_message_id)
              and (later_elem->'signals') @> '["rejection"]'::jsonb
         )
    ) then
      raise exception 'agreement_observed requires an explicit booking confirmation, an agreement signal, an earlier creator-sent message, and no later rejection'
        using errcode = 'check_violation';
    end if;
  end if;

  -- DIGEST EQUALITY SHORT-CIRCUIT. Same digest and a non-stale current
  -- projection covering exactly the eligible set: zero new attempts.
  select
    exists (
      select 1 from private.gmail_commercial_thread_current c
       where c.mail_account_id = p_mail_account_id
         and c.provider_thread_id = v_thread.provider_thread_id
         and c.input_digest = v_digest
         and not c.stale
    )
    and (
      select count(*)::int
        from private.gmail_commercial_message_current c
        join private.gmail_commercial_message_rows(p_mail_account_id, p_normalized_thread_id) r
          on r.provider_message_id = c.provider_message_id and r.eligible
       where c.mail_account_id = p_mail_account_id
         and c.input_digest = v_digest
         and not c.stale
         and not c.suppressed
    ) = v_eligible_count
    and not exists (
      select 1 from private.gmail_commercial_message_current c
       where c.mail_account_id = p_mail_account_id
         and c.provider_thread_id = v_thread.provider_thread_id
         and not c.suppressed
         and not exists (
           select 1
             from private.gmail_commercial_message_rows(p_mail_account_id, p_normalized_thread_id) r
            where r.provider_message_id = c.provider_message_id and r.eligible
         )
    )
    into v_already;

  if v_already then
    return jsonb_build_object('result', 'already_current', 'input_digest', v_digest, 'committed', false);
  end if;

  perform set_config('b07.machine_writer', 'on', true);

  with payload as (
    select
      elem->>'provider_message_id' as provider_message_id,
      elem->>'disposition' as disposition,
      coalesce((
        select array_agg(s.value order by s.value)
          from jsonb_array_elements_text(elem->'signals') s(value)
      ), '{}'::text[]) as signals,
      elem->>'evidence_strength' as evidence_strength
    from jsonb_array_elements(coalesce(p_messages, '[]'::jsonb)) elem
  ),
  inserted as (
    insert into private.gmail_commercial_message_attempts (
      user_id, mail_account_id, provider_message_id, provider_thread_id, normalized_thread_id,
      current_normalized_message_id, b06_observation_id, b06_response_class,
      b06_classification_rule_version, b06_relation_rule_version, b06_text_transform_version,
      axis_a_basis, axis_a_event_id, axis_a_event_seq, source_payload_sha256, input_digest,
      schema_version, transform_version, engine_kind, rule_version,
      disposition, signals, evidence_strength
    )
    select
      p_user_id, p_mail_account_id, r.provider_message_id, v_thread.provider_thread_id,
      p_normalized_thread_id, r.normalized_message_id, r.b06_observation_id, r.b06_response_class,
      r.b06_classification_rule_version, r.b06_relation_rule_version, r.b06_text_transform_version,
      r.axis_basis, r.axis_event_id, r.axis_event_seq, r.source_payload_sha256, v_digest,
      p_schema_version, p_transform_version, 'rules', p_rule_version,
      py.disposition, py.signals, py.evidence_strength
    from private.gmail_commercial_message_rows(p_mail_account_id, p_normalized_thread_id) r
    join payload py on py.provider_message_id = r.provider_message_id
    where r.eligible
    returning id, provider_message_id
  )
  insert into private.gmail_commercial_message_current (
    user_id, mail_account_id, provider_message_id, provider_thread_id,
    current_attempt_id, input_digest, stale, stale_reason, suppressed
  )
  select p_user_id, p_mail_account_id, i.provider_message_id, v_thread.provider_thread_id,
         i.id, v_digest, false, null, false
    from inserted i
  on conflict (mail_account_id, provider_message_id) do update
    set provider_thread_id = excluded.provider_thread_id,
        current_attempt_id = excluded.current_attempt_id,
        input_digest = excluded.input_digest,
        stale = false,
        stale_reason = null,
        suppressed = false,
        updated_at = now();

  update private.gmail_commercial_message_current c
     set stale = true, suppressed = true, stale_reason = 'not_eligible', updated_at = now()
   where c.mail_account_id = p_mail_account_id
     and c.provider_thread_id = v_thread.provider_thread_id
     and not exists (
       select 1
         from private.gmail_commercial_message_rows(p_mail_account_id, p_normalized_thread_id) r
        where r.provider_message_id = c.provider_message_id and r.eligible
     );

  with inserted as (
    insert into private.gmail_commercial_thread_attempts (
      user_id, mail_account_id, provider_thread_id, normalized_thread_id, input_digest,
      schema_version, transform_version, engine_kind, rule_version,
      commercial_state, compensation_structure, evidence_strength
    )
    values (
      p_user_id, p_mail_account_id, v_thread.provider_thread_id, p_normalized_thread_id, v_digest,
      p_schema_version, p_transform_version, 'rules', p_rule_version,
      v_state, v_compensation, v_evidence
    )
    returning id
  )
  insert into private.gmail_commercial_thread_current (
    user_id, mail_account_id, provider_thread_id, current_attempt_id, input_digest, stale, stale_reason
  )
  select p_user_id, p_mail_account_id, v_thread.provider_thread_id, i.id, v_digest, false, null
    from inserted i
  on conflict (mail_account_id, provider_thread_id) do update
    set current_attempt_id = excluded.current_attempt_id,
        input_digest = excluded.input_digest,
        stale = false,
        stale_reason = null,
        updated_at = now();

  return jsonb_build_object('result', 'ok', 'input_digest', v_digest, 'committed', true);
end;
$$;

-- ===========================================================================
-- 10. CREATOR DECISION (authenticated). auth.uid() only.
-- ===========================================================================
create or replace function public.gmail_commercial_record_creator_decision(
  p_mail_account_id uuid,
  p_axis text,
  p_action text,
  p_provider_message_id text,
  p_provider_thread_id text,
  p_reply_nature text,
  p_disposition text,
  p_signals text[],
  p_business_outcome text,
  p_lost_reason text,
  p_compensation_structure text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user uuid;
  v_may text;
  v_thread_id text;
  v_event_id uuid;
  v_event_seq bigint;
  v_advanced integer;
  v_signals text[];
  v_observed text;
  v_observed_attempt uuid;
  v_sent boolean;
  v_class text;
  v_b06_current boolean;
  v_basis text;
  v_eligible boolean;
begin
  v_user := auth.uid();
  if v_user is null then
    return jsonb_build_object('result', 'unauthenticated');
  end if;

  if not exists (
    select 1 from public.mail_accounts m where m.id = p_mail_account_id and m.user_id = v_user
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  v_may := private.gmail_outreach_assert_may_process_locked(p_mail_account_id);
  if v_may <> 'ok' then
    return jsonb_build_object('result', v_may);
  end if;

  perform 1 from public.mail_accounts where id = p_mail_account_id for update;

  if p_axis not in ('reply_nature','disposition','signals','business_outcome','compensation')
     or p_action not in ('set','clear') then
    raise exception 'unknown creator-decision axis or action' using errcode = 'check_violation';
  end if;

  if p_axis in ('reply_nature','disposition','signals') then
    if p_provider_message_id is null or p_provider_thread_id is not null then
      raise exception 'message axes are anchored to a provider message id' using errcode = 'check_violation';
    end if;
    select t.provider_thread_id into v_thread_id
      from private.gmail_normalized_messages m
      join private.gmail_normalized_threads t on t.id = m.normalized_thread_id
     where m.mail_account_id = p_mail_account_id and m.provider_message_id = p_provider_message_id
     limit 1;
    if v_thread_id is null then
      select a.provider_thread_id into v_thread_id
        from private.gmail_commercial_message_attempts a
       where a.mail_account_id = p_mail_account_id and a.provider_message_id = p_provider_message_id
       limit 1;
    end if;
    if v_thread_id is null then
      return jsonb_build_object('result', 'anchor_not_found');
    end if;
    -- Snapshot the machine value of THIS axis, not the disposition of every message axis.
    select c.current_attempt_id,
           case p_axis
             when 'reply_nature' then a.b06_response_class
             when 'disposition' then a.disposition
             when 'signals' then array_to_string(a.signals, ',')
           end
      into v_observed_attempt, v_observed
      from private.gmail_commercial_message_current c
      join private.gmail_commercial_message_attempts a on a.id = c.current_attempt_id
     where c.mail_account_id = p_mail_account_id and c.provider_message_id = p_provider_message_id;
  else
    if p_provider_thread_id is null or p_provider_message_id is not null then
      raise exception 'thread axes are anchored to a provider thread id' using errcode = 'check_violation';
    end if;
    if not exists (
      select 1 from private.gmail_normalized_threads t
       where t.mail_account_id = p_mail_account_id and t.provider_thread_id = p_provider_thread_id
    ) and not exists (
      select 1 from private.gmail_commercial_thread_attempts a
       where a.mail_account_id = p_mail_account_id and a.provider_thread_id = p_provider_thread_id
    ) then
      return jsonb_build_object('result', 'anchor_not_found');
    end if;
    select c.current_attempt_id,
           case p_axis
             when 'business_outcome' then a.commercial_state
             when 'compensation' then a.compensation_structure
           end
      into v_observed_attempt, v_observed
      from private.gmail_commercial_thread_current c
      join private.gmail_commercial_thread_attempts a on a.id = c.current_attempt_id
     where c.mail_account_id = p_mail_account_id and c.provider_thread_id = p_provider_thread_id;
  end if;

  if p_action = 'clear' then
    if p_reply_nature is not null or p_disposition is not null or p_signals is not null
       or p_business_outcome is not null or p_lost_reason is not null
       or p_compensation_structure is not null then
      raise exception 'clear carries no axis value' using errcode = 'check_violation';
    end if;
  elsif p_axis = 'reply_nature' then
    if p_reply_nature not in ('human_reply','automated','delivery','not_reply','uncertain')
       or p_disposition is not null or p_signals is not null or p_business_outcome is not null
       or p_lost_reason is not null or p_compensation_structure is not null then
      raise exception 'reply_nature value is not in the locked vocabulary' using errcode = 'check_violation';
    end if;
  elsif p_axis = 'disposition' then
    if p_disposition not in ('positive','negative','neutral','mixed','ambiguous')
       or p_reply_nature is not null or p_signals is not null or p_business_outcome is not null
       or p_lost_reason is not null or p_compensation_structure is not null then
      raise exception 'disposition value is not in the locked vocabulary' using errcode = 'check_violation';
    end if;
  elsif p_axis = 'signals' then
    if p_signals is null or not private.gmail_commercial_text_array_ok(p_signals)
       or ('redirect' = any(p_signals) and 'rejection' = any(p_signals))
       or p_reply_nature is not null or p_disposition is not null or p_business_outcome is not null
       or p_lost_reason is not null or p_compensation_structure is not null then
      raise exception 'signals value is not in the locked vocabulary' using errcode = 'check_violation';
    end if;
  elsif p_axis = 'business_outcome' then
    if p_business_outcome not in ('open','won','lost','ghosted','uncertain')
       or (p_business_outcome = 'lost' and p_lost_reason not in ('rejected','not_a_fit','timing','other'))
       or (p_business_outcome <> 'lost' and p_lost_reason is not null)
       or p_reply_nature is not null or p_disposition is not null or p_signals is not null
       or p_compensation_structure is not null then
      raise exception 'business_outcome value is not in the locked vocabulary' using errcode = 'check_violation';
    end if;
  else
    if p_compensation_structure not in ('paid','in_kind','hybrid','unpaid','other','unknown')
       or p_reply_nature is not null or p_disposition is not null or p_signals is not null
       or p_business_outcome is not null or p_lost_reason is not null then
      raise exception 'compensation value is not in the locked vocabulary' using errcode = 'check_violation';
    end if;
  end if;

  if p_signals is null then
    v_signals := null;
  else
    select array_agg(s order by s) into v_signals from unnest(p_signals) s;
  end if;

  perform set_config('b07.human_writer', 'on', true);

  insert into private.gmail_commercial_creator_decision_events (
    user_id, mail_account_id, decided_by_user_id, axis,
    provider_message_id, provider_thread_id, action,
    reply_nature, disposition, signals, business_outcome, lost_reason, compensation_structure,
    observed_machine_value, observed_machine_attempt_id
  ) values (
    v_user, p_mail_account_id, v_user, p_axis,
    p_provider_message_id, p_provider_thread_id, p_action,
    case when p_action = 'set' and p_axis = 'reply_nature' then p_reply_nature end,
    case when p_action = 'set' and p_axis = 'disposition' then p_disposition end,
    case when p_action = 'set' and p_axis = 'signals' then v_signals end,
    case when p_action = 'set' and p_axis = 'business_outcome' then p_business_outcome end,
    case when p_action = 'set' and p_axis = 'business_outcome' then p_lost_reason end,
    case when p_action = 'set' and p_axis = 'compensation' then p_compensation_structure end,
    v_observed, v_observed_attempt
  )
  returning id, event_seq into v_event_id, v_event_seq;

  if p_axis in ('reply_nature','disposition','signals') then
    insert into private.gmail_commercial_message_decisions (
      user_id, mail_account_id, provider_message_id, axis, is_cleared,
      reply_nature, disposition, signals, current_event_id, current_event_seq
    ) values (
      v_user, p_mail_account_id, p_provider_message_id, p_axis, p_action = 'clear',
      case when p_action = 'set' and p_axis = 'reply_nature' then p_reply_nature end,
      case when p_action = 'set' and p_axis = 'disposition' then p_disposition end,
      case when p_action = 'set' and p_axis = 'signals' then v_signals end,
      v_event_id, v_event_seq
    )
    on conflict (mail_account_id, provider_message_id, axis) do update
      set is_cleared = excluded.is_cleared,
          reply_nature = excluded.reply_nature,
          disposition = excluded.disposition,
          signals = excluded.signals,
          current_event_id = excluded.current_event_id,
          current_event_seq = excluded.current_event_seq,
          updated_at = now()
      where gmail_commercial_message_decisions.current_event_seq < excluded.current_event_seq;
  else
    insert into private.gmail_commercial_thread_decisions (
      user_id, mail_account_id, provider_thread_id, axis, is_cleared,
      business_outcome, lost_reason, compensation_structure, current_event_id, current_event_seq
    ) values (
      v_user, p_mail_account_id, p_provider_thread_id, p_axis, p_action = 'clear',
      case when p_action = 'set' and p_axis = 'business_outcome' then p_business_outcome end,
      case when p_action = 'set' and p_axis = 'business_outcome' then p_lost_reason end,
      case when p_action = 'set' and p_axis = 'compensation' then p_compensation_structure end,
      v_event_id, v_event_seq
    )
    on conflict (mail_account_id, provider_thread_id, axis) do update
      set is_cleared = excluded.is_cleared,
          business_outcome = excluded.business_outcome,
          lost_reason = excluded.lost_reason,
          compensation_structure = excluded.compensation_structure,
          current_event_id = excluded.current_event_id,
          current_event_seq = excluded.current_event_seq,
          updated_at = now()
      where gmail_commercial_thread_decisions.current_event_seq < excluded.current_event_seq;
  end if;
  get diagnostics v_advanced = row_count;

  -- Axis A changes eligibility. Flag currentness. Do not delete the attempt
  -- and do not move current_attempt_id.
  if p_axis = 'reply_nature' and v_advanced > 0 then
    select m.provider_sent,
           o.response_class,
           coalesce(o.current_normalized_message_id is not null, false)
      into v_sent, v_class, v_b06_current
      from private.gmail_normalized_messages m
      left join private.gmail_reply_message_observations o
        on o.mail_account_id = m.mail_account_id and o.provider_message_id = m.provider_message_id
     where m.mail_account_id = p_mail_account_id and m.provider_message_id = p_provider_message_id;

    v_basis := case when p_action = 'clear' then 'cleared' else p_reply_nature end;
    if v_sent is null then
      v_eligible := false;
    else
      v_eligible := private.gmail_commercial_message_eligible(v_sent, v_class, v_b06_current, v_basis);
    end if;

    update private.gmail_commercial_message_current
       set stale = true,
           suppressed = not v_eligible,
           stale_reason = 'axis_a',
           updated_at = now()
     where mail_account_id = p_mail_account_id and provider_message_id = p_provider_message_id;

    update private.gmail_commercial_thread_current
       set stale = true, stale_reason = 'axis_a', updated_at = now()
     where mail_account_id = p_mail_account_id and provider_thread_id = v_thread_id;
  end if;

  return jsonb_build_object(
    'result', 'ok',
    'event_id', v_event_id,
    'event_seq', v_event_seq,
    'projection_advanced', v_advanced > 0
  );
end;
$$;

-- ===========================================================================
-- 11. CREATOR READS (authenticated). Retention, not new processing.
-- AUTH.UID ACCOUNT FILTER — a caller never names another user.
-- ===========================================================================
create or replace function public.gmail_commercial_read_thread(
  p_mail_account_id uuid,
  p_provider_thread_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user uuid;
begin
  v_user := auth.uid();
  if v_user is null then
    return jsonb_build_object('result', 'unauthenticated');
  end if;
  if not exists (
    select 1 from public.mail_accounts m
     where m.id = p_mail_account_id and m.user_id = v_user
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  return jsonb_build_object(
    'result', 'ok',
    'machine', (
      select jsonb_build_object(
        'commercial_state', case
          when c.stale or a.normalized_thread_id is null or exists (
            select 1
              from private.gmail_commercial_message_current mc
              join private.gmail_commercial_message_attempts ma on ma.id = mc.current_attempt_id
             where mc.mail_account_id = c.mail_account_id
               and mc.provider_thread_id = c.provider_thread_id
               and ma.current_normalized_message_id is null
          ) then null
          else a.commercial_state
        end,
        'compensation_structure', case
          when c.stale or a.normalized_thread_id is null or exists (
            select 1
              from private.gmail_commercial_message_current mc
              join private.gmail_commercial_message_attempts ma on ma.id = mc.current_attempt_id
             where mc.mail_account_id = c.mail_account_id
               and mc.provider_thread_id = c.provider_thread_id
               and ma.current_normalized_message_id is null
          ) then null
          else a.compensation_structure
        end,
        'evidence_strength', case
          when c.stale or a.normalized_thread_id is null or exists (
            select 1
              from private.gmail_commercial_message_current mc
              join private.gmail_commercial_message_attempts ma on ma.id = mc.current_attempt_id
             where mc.mail_account_id = c.mail_account_id
               and mc.provider_thread_id = c.provider_thread_id
               and ma.current_normalized_message_id is null
          ) then null
          else a.evidence_strength
        end,
        'stale', c.stale or a.normalized_thread_id is null or exists (
          select 1
            from private.gmail_commercial_message_current mc
            join private.gmail_commercial_message_attempts ma on ma.id = mc.current_attempt_id
           where mc.mail_account_id = c.mail_account_id
             and mc.provider_thread_id = c.provider_thread_id
             and ma.current_normalized_message_id is null
        ),
        'input_digest', c.input_digest,
        'engine_kind', a.engine_kind,
        'rule_version', a.rule_version,
        'schema_version', a.schema_version,
        'transform_version', a.transform_version,
        'attempt_id', a.id
      )
      from private.gmail_commercial_thread_current c
      join private.gmail_commercial_thread_attempts a on a.id = c.current_attempt_id
      where c.mail_account_id = p_mail_account_id
        and c.provider_thread_id = p_provider_thread_id
        and c.user_id = v_user
    ),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider_message_id', c.provider_message_id,
        'disposition', case
          when c.stale or c.suppressed or a.current_normalized_message_id is null then null
          else a.disposition
        end,
        'signals', case
          when c.stale or c.suppressed or a.current_normalized_message_id is null then null
          else to_jsonb(a.signals)
        end,
        'evidence_strength', case
          when c.stale or c.suppressed or a.current_normalized_message_id is null then null
          else a.evidence_strength
        end,
        'stale', c.stale or a.current_normalized_message_id is null,
        'suppressed', c.suppressed or a.current_normalized_message_id is null,
        'engine_kind', a.engine_kind,
        'rule_version', a.rule_version
      ) order by c.provider_message_id)
      from private.gmail_commercial_message_current c
      join private.gmail_commercial_message_attempts a on a.id = c.current_attempt_id
      where c.mail_account_id = p_mail_account_id
        and c.provider_thread_id = p_provider_thread_id
        and c.user_id = v_user
    ), '[]'::jsonb),
    'human_messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider_message_id', d.provider_message_id,
        'axis', d.axis,
        'is_cleared', d.is_cleared,
        'reply_nature', d.reply_nature,
        'disposition', d.disposition,
        'signals', d.signals,
        'event_seq', d.current_event_seq
      ) order by d.provider_message_id, d.axis)
      from private.gmail_commercial_message_decisions d
      where d.mail_account_id = p_mail_account_id
        and d.user_id = v_user
        and (
          d.provider_message_id in (
            select m.provider_message_id from private.gmail_normalized_messages m
             where m.mail_account_id = p_mail_account_id
               and m.normalized_thread_id in (
                 select t.id from private.gmail_normalized_threads t
                  where t.mail_account_id = p_mail_account_id
                    and t.provider_thread_id = p_provider_thread_id
               )
          )
          or d.provider_message_id in (
            select a.provider_message_id from private.gmail_commercial_message_attempts a
             where a.mail_account_id = p_mail_account_id
               and a.provider_thread_id = p_provider_thread_id
          )
        )
    ), '[]'::jsonb),
    'human_thread', coalesce((
      select jsonb_agg(jsonb_build_object(
        'axis', d.axis,
        'is_cleared', d.is_cleared,
        'business_outcome', d.business_outcome,
        'lost_reason', d.lost_reason,
        'compensation_structure', d.compensation_structure,
        'event_seq', d.current_event_seq
      ) order by d.axis)
      from private.gmail_commercial_thread_decisions d
      where d.mail_account_id = p_mail_account_id
        and d.provider_thread_id = p_provider_thread_id
        and d.user_id = v_user
    ), '[]'::jsonb)
  );
end;
$$;

create or replace function public.gmail_commercial_status(p_mail_account_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user uuid;
begin
  v_user := auth.uid();
  if v_user is null then
    return jsonb_build_object('result', 'unauthenticated');
  end if;
  if not exists (
    select 1 from public.mail_accounts m where m.id = p_mail_account_id and m.user_id = v_user
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  return jsonb_build_object(
    'result', 'ok',
    'threads', (select count(*) from private.gmail_commercial_thread_current c
                 where c.mail_account_id = p_mail_account_id and c.user_id = v_user),
    'message_attempts', (select count(*) from private.gmail_commercial_message_attempts a
                          where a.mail_account_id = p_mail_account_id and a.user_id = v_user),
    'stale_threads', (select count(*) from private.gmail_commercial_thread_current c
                       where c.mail_account_id = p_mail_account_id and c.user_id = v_user and c.stale),
    'human_events', (select count(*) from private.gmail_commercial_creator_decision_events e
                      where e.mail_account_id = p_mail_account_id and e.user_id = v_user)
  );
end;
$$;

create or replace function public.gmail_commercial_list_threads(p_mail_account_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_user uuid;
begin
  v_user := auth.uid();
  if v_user is null then
    return jsonb_build_object('result', 'unauthenticated');
  end if;
  if not exists (
    select 1 from public.mail_accounts m where m.id = p_mail_account_id and m.user_id = v_user
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  return jsonb_build_object(
    'result', 'ok',
    'threads', coalesce((
      select jsonb_agg(jsonb_build_object(
        'provider_thread_id', c.provider_thread_id,
        'commercial_state', case
          when c.stale or a.normalized_thread_id is null or exists (
            select 1
              from private.gmail_commercial_message_current mc
              join private.gmail_commercial_message_attempts ma on ma.id = mc.current_attempt_id
             where mc.mail_account_id = c.mail_account_id
               and mc.provider_thread_id = c.provider_thread_id
               and ma.current_normalized_message_id is null
          ) then null
          else a.commercial_state
        end,
        'stale', c.stale or a.normalized_thread_id is null or exists (
          select 1
            from private.gmail_commercial_message_current mc
            join private.gmail_commercial_message_attempts ma on ma.id = mc.current_attempt_id
           where mc.mail_account_id = c.mail_account_id
             and mc.provider_thread_id = c.provider_thread_id
             and ma.current_normalized_message_id is null
        )
      ) order by c.provider_thread_id)
      from private.gmail_commercial_thread_current c
      join private.gmail_commercial_thread_attempts a on a.id = c.current_attempt_id
      where c.mail_account_id = p_mail_account_id and c.user_id = v_user
    ), '[]'::jsonb)
  );
end;
$$;

-- ===========================================================================
-- 12. DELETION PURGE (service_role)
-- ===========================================================================
create or replace function public.gmail_commercial_purge_for_deletion(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_deletion_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_account public.mail_accounts%rowtype;
  v_request public.mail_account_deletion_requests%rowtype;
  v_attempts integer;
  v_events integer;
begin
  select m.* into v_account from public.mail_accounts m
   where m.id = p_mail_account_id and m.user_id = p_user_id
   for no key update;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_account.connection_state <> 'deletion_pending' then
    return jsonb_build_object('result', 'not_deleting', 'connection_state', v_account.connection_state);
  end if;
  if v_account.current_deletion_request_id is distinct from p_deletion_request_id then
    return jsonb_build_object('result', 'stale_deletion_request');
  end if;

  select r.* into v_request from public.mail_account_deletion_requests r where r.id = p_deletion_request_id;
  if not found or v_request.mail_account_id <> p_mail_account_id or v_request.user_id <> p_user_id then
    return jsonb_build_object('result', 'stale_deletion_request');
  end if;
  if v_request.status not in ('requested', 'in_progress') then
    return jsonb_build_object('result', 'request_not_running', 'status', v_request.status);
  end if;
  if v_request.scope not in ('gmail_derived_data', 'account_and_gmail_derived_data') then
    return jsonb_build_object('result', 'scope_excludes_gmail_data', 'scope', v_request.scope);
  end if;

  perform set_config('b07.purge', 'on', true);

  delete from private.gmail_commercial_message_decisions where mail_account_id = p_mail_account_id;
  delete from private.gmail_commercial_thread_decisions where mail_account_id = p_mail_account_id;
  with removed as (
    delete from private.gmail_commercial_creator_decision_events
     where mail_account_id = p_mail_account_id returning 1
  ) select count(*)::int into v_events from removed;
  delete from private.gmail_commercial_message_current where mail_account_id = p_mail_account_id;
  delete from private.gmail_commercial_thread_current where mail_account_id = p_mail_account_id;
  with removed as (
    delete from private.gmail_commercial_message_attempts
     where mail_account_id = p_mail_account_id returning 1
  ) select count(*)::int into v_attempts from removed;
  delete from private.gmail_commercial_thread_attempts where mail_account_id = p_mail_account_id;

  return jsonb_build_object(
    'result', 'ok',
    'message_attempts_removed', v_attempts,
    'human_events_removed', v_events
  );
end;
$$;

-- ===========================================================================
-- 13. RLS, GRANTS
-- ===========================================================================
-- authenticated may SELECT only its own B07 rows. No write grant. Schema
-- USAGE is required for that SELECT to resolve. Every other private table
-- and every private function stays revoked, including credential storage.
alter table private.gmail_commercial_message_attempts enable row level security;
alter table private.gmail_commercial_message_current enable row level security;
alter table private.gmail_commercial_thread_attempts enable row level security;
alter table private.gmail_commercial_thread_current enable row level security;
alter table private.gmail_commercial_creator_decision_events enable row level security;
alter table private.gmail_commercial_message_decisions enable row level security;
alter table private.gmail_commercial_thread_decisions enable row level security;

create policy gmail_commercial_message_attempts_select
  on private.gmail_commercial_message_attempts for select to authenticated
  using (user_id = auth.uid());
create policy gmail_commercial_message_current_select
  on private.gmail_commercial_message_current for select to authenticated
  using (user_id = auth.uid());
create policy gmail_commercial_thread_attempts_select
  on private.gmail_commercial_thread_attempts for select to authenticated
  using (user_id = auth.uid());
create policy gmail_commercial_thread_current_select
  on private.gmail_commercial_thread_current for select to authenticated
  using (user_id = auth.uid());
create policy gmail_commercial_creator_events_select
  on private.gmail_commercial_creator_decision_events for select to authenticated
  using (user_id = auth.uid());
create policy gmail_commercial_message_decisions_select
  on private.gmail_commercial_message_decisions for select to authenticated
  using (user_id = auth.uid());
create policy gmail_commercial_thread_decisions_select
  on private.gmail_commercial_thread_decisions for select to authenticated
  using (user_id = auth.uid());

grant usage on schema private to authenticated;
revoke all on all tables in schema private from public, anon, authenticated;
grant select on
  private.gmail_commercial_message_attempts,
  private.gmail_commercial_message_current,
  private.gmail_commercial_thread_attempts,
  private.gmail_commercial_thread_current,
  private.gmail_commercial_creator_decision_events,
  private.gmail_commercial_message_decisions,
  private.gmail_commercial_thread_decisions
to authenticated;

revoke all on all functions in schema private from public, anon, authenticated;

revoke all on function public.gmail_commercial_get_thread_evidence(uuid, uuid, uuid, text, text, text)
  from public, anon, authenticated;
revoke all on function public.gmail_commercial_commit_interpretation(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function public.gmail_commercial_record_creator_decision(uuid, text, text, text, text, text, text, text[], text, text, text)
  from public, anon, authenticated;
revoke all on function public.gmail_commercial_read_thread(uuid, text) from public, anon, authenticated;
revoke all on function public.gmail_commercial_status(uuid) from public, anon, authenticated;
revoke all on function public.gmail_commercial_list_threads(uuid) from public, anon, authenticated;
revoke all on function public.gmail_commercial_purge_for_deletion(uuid, uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.gmail_commercial_get_thread_evidence(uuid, uuid, uuid, text, text, text) to service_role;
grant execute on function public.gmail_commercial_commit_interpretation(uuid, uuid, uuid, text, text, text, text, jsonb, jsonb) to service_role;
grant execute on function public.gmail_commercial_purge_for_deletion(uuid, uuid, uuid) to service_role;

grant execute on function public.gmail_commercial_record_creator_decision(uuid, text, text, text, text, text, text, text[], text, text, text)
  to authenticated, service_role;
grant execute on function public.gmail_commercial_read_thread(uuid, text) to authenticated, service_role;
grant execute on function public.gmail_commercial_status(uuid) to authenticated, service_role;
grant execute on function public.gmail_commercial_list_threads(uuid) to authenticated, service_role;

-- ===========================================================================
-- 14. WHAT 0044 DOES NOT CREATE
-- ===========================================================================
-- No external model call, no model provider column that may be non-null.
-- No write to public.pipeline_items, public.outreach_events, public.collaborations,
--   or any canonical hotel/organization/brand/contact row.
-- No G3 / network-intelligence row.
-- No Gmail API call and no new OAuth scope.
-- No UI.
-- Machine commercial_state is not a human business outcome. ghosted is human-only.
