-- 0050 — D07 collaboration deliverables and agreed compensation (D078).
--
-- Migration number: 0050. Checked against main
-- 989e7f020f07362113b3e9b00fd9950293808f10, which ends at 0046.
-- Open PR #53 (B08) reserves 0047_gmail_incremental_sync.sql and
-- 0048_gmail_commercial_clean_text_entities.sql, and D076.
-- 0049 is left free because open PR #55 (E01) may take it.
-- D077 is C01 on main. This block is D078.
--
-- Agreed compensation is the creator's record of what a won collaboration is
-- worth. It is strategic data used to value each deliverable. It does not
-- charge anyone, does not call a payment provider, and does not write
-- collaborations.private_value_* or the public intelligence aggregates.
--
-- A B07 machine compensation structure may be copied into a suggestion row.
-- That copy is not human truth and this migration never writes it into the
-- agreed-compensation table.
--
-- Derived value is computed on read. Unknown stays unknown: the amount is
-- JSON null, never zero. An explicit unpaid agreement is a known zero and is
-- labeled unpaid_explicit so it cannot be mistaken for that null.

-- ---------------------------------------------------------------------------
-- ISO 4217 alphabetic codes. Must match src/lib/collaboration/currencies.ts.
-- ---------------------------------------------------------------------------
create or replace function public.is_iso_currency(p_code text)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select p_code in (
    'AED','AFN','ALL','AMD','ANG','AOA','ARS','AUD','AWG','AZN',
    'BAM','BBD','BDT','BGN','BHD','BIF','BMD','BND','BOB','BRL',
    'BSD','BTN','BWP','BYN','BZD','CAD','CDF','CHF','CLP','CNY',
    'COP','CRC','CUC','CUP','CVE','CZK','DJF','DKK','DOP','DZD',
    'EGP','ERN','ETB','EUR','FJD','FKP','GBP','GEL','GHS','GIP',
    'GMD','GNF','GTQ','GYD','HKD','HNL','HRK','HTG','HUF','IDR',
    'ILS','INR','IQD','IRR','ISK','JMD','JOD','JPY','KES','KGS',
    'KHR','KMF','KPW','KRW','KWD','KYD','KZT','LAK','LBP','LKR',
    'LRD','LSL','LYD','MAD','MDL','MGA','MKD','MMK','MNT','MOP',
    'MRU','MUR','MVR','MWK','MXN','MYR','MZN','NAD','NGN','NIO',
    'NOK','NPR','NZD','OMR','PAB','PEN','PGK','PHP','PKR','PLN',
    'PYG','QAR','RON','RSD','RUB','RWF','SAR','SBD','SCR','SDG',
    'SEK','SGD','SHP','SLE','SLL','SOS','SRD','SSP','STN','SVC',
    'SYP','SZL','THB','TJS','TMT','TND','TOP','TRY','TTD','TWD',
    'TZS','UAH','UGX','USD','UYU','UZS','VES','VND','VUV','WST',
    'XAF','XCD','XCG','XDR','XOF','XPF','XSU','YER','ZAR','ZMW',
    'ZWG','ZWL'
  );
$$;

comment on function public.is_iso_currency(text) is
  'True for an uppercase ISO 4217 alphabetic code in the D078 list. Lowercase is not accepted; callers uppercase first.';

revoke all on function public.is_iso_currency(text) from public, anon;
grant execute on function public.is_iso_currency(text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Agreed compensation: one creator record per collaboration.
-- ---------------------------------------------------------------------------
create table public.collaboration_agreed_compensations (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  collaboration_id uuid not null references public.collaborations(id) on delete cascade,
  pipeline_item_id uuid not null references public.pipeline_items(id) on delete cascade,
  structure text not null check (structure in ('paid','in_kind','hybrid','unpaid','other','unknown')),
  cash_amount_minor bigint,
  cash_currency text,
  in_kind_description text,
  in_kind_estimate_minor bigint,
  in_kind_estimate_currency text,
  payment_status text not null check (payment_status in ('pending','partially_paid','paid','not_applicable')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint collaboration_agreed_compensations_collaboration_uidx unique (collaboration_id),
  constraint collaboration_agreed_compensations_amounts_nonnegative check (
    (cash_amount_minor is null or (cash_amount_minor >= 0 and cash_amount_minor <= 9007199254740991))
    and (in_kind_estimate_minor is null or (in_kind_estimate_minor >= 0 and in_kind_estimate_minor <= 9007199254740991))
  ),
  constraint collaboration_agreed_compensations_currency check (
    (cash_currency is null or public.is_iso_currency(cash_currency))
    and (in_kind_estimate_currency is null or public.is_iso_currency(in_kind_estimate_currency))
  ),
  constraint collaboration_agreed_compensations_shape check (
    (
      structure = 'paid'
      and cash_amount_minor is not null
      and cash_currency is not null
      and in_kind_description is null
      and in_kind_estimate_minor is null
      and in_kind_estimate_currency is null
      and payment_status in ('pending','partially_paid','paid')
    )
    or (
      structure = 'in_kind'
      and cash_amount_minor is null
      and cash_currency is null
      and in_kind_description is not null
      and char_length(in_kind_description) between 1 and 500
      and in_kind_description = btrim(in_kind_description)
      and ((in_kind_estimate_minor is null) = (in_kind_estimate_currency is null))
      and payment_status = 'not_applicable'
    )
    or (
      structure = 'hybrid'
      and cash_amount_minor is not null
      and cash_currency is not null
      and in_kind_description is not null
      and char_length(in_kind_description) between 1 and 500
      and in_kind_description = btrim(in_kind_description)
      and ((in_kind_estimate_minor is null) = (in_kind_estimate_currency is null))
      and payment_status in ('pending','partially_paid','paid')
      and (
        in_kind_estimate_minor is null
        or cash_currency is distinct from in_kind_estimate_currency
        or cash_amount_minor <= 9007199254740991 - in_kind_estimate_minor
      )
    )
    or (
      structure in ('unpaid','other','unknown')
      and cash_amount_minor is null
      and cash_currency is null
      and in_kind_description is null
      and in_kind_estimate_minor is null
      and in_kind_estimate_currency is null
      and payment_status = 'not_applicable'
    )
  )
);

comment on table public.collaboration_agreed_compensations is
  'D078 creator record of agreed compensation for one collaboration. Human truth. Not a charge, not a payment-provider record, and not a B07 machine interpretation. Unknown is an empty amount, never zero.';

comment on column public.collaboration_agreed_compensations.cash_amount_minor is
  'Integer minor units of cash_currency. Null means this structure has no cash leg. Zero is a recorded zero, which unknown is not allowed to become.';

comment on column public.collaboration_agreed_compensations.in_kind_estimate_minor is
  'Optional creator estimate of the in-kind leg, in integer minor units. Null means the estimate is unknown, not zero. The read model labels a present estimate as creator_estimate.';

create index collaboration_agreed_compensations_creator_idx
  on public.collaboration_agreed_compensations (creator_id);

create trigger collaboration_agreed_compensations_set_updated_at
  before update on public.collaboration_agreed_compensations
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Machine suggestion. Structure only. B07 does not extract amounts.
-- ---------------------------------------------------------------------------
create table public.collaboration_compensation_suggestions (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  collaboration_id uuid not null references public.collaborations(id) on delete cascade,
  pipeline_item_id uuid not null references public.pipeline_items(id) on delete cascade,
  structure text not null check (structure in ('paid','in_kind','hybrid','unpaid','other','unknown')),
  source_mail_account_id uuid not null references public.mail_accounts(id) on delete cascade,
  source_provider_thread_id text not null check (char_length(btrim(source_provider_thread_id)) between 1 and 256),
  source_attempt_id uuid not null,
  rule_version text not null check (char_length(rule_version) between 1 and 64),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint collaboration_compensation_suggestions_collaboration_uidx unique (collaboration_id)
);

comment on table public.collaboration_compensation_suggestions is
  'D078 copy of a B07 machine compensation structure for one collaboration. A suggestion, never human truth, and never an amount. Prefill updates only this table.';

comment on column public.collaboration_compensation_suggestions.source_attempt_id is
  'Provenance of the machine attempt the structure was copied from. Not a live foreign key: purging B07 history does not rewrite creator compensation.';

create index collaboration_compensation_suggestions_creator_idx
  on public.collaboration_compensation_suggestions (creator_id);

create trigger collaboration_compensation_suggestions_set_updated_at
  before update on public.collaboration_compensation_suggestions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Deliverables checklist. Value is not stored here.
-- ---------------------------------------------------------------------------
create table public.collaboration_deliverables (
  id uuid primary key default gen_random_uuid(),
  creator_id uuid not null references public.creator_profiles(id) on delete cascade,
  collaboration_id uuid not null references public.collaborations(id) on delete cascade,
  pipeline_item_id uuid not null references public.pipeline_items(id) on delete cascade,
  deliverable_type text not null check (deliverable_type in (
    'reel','story','post','tiktok','youtube','photo_set','ugc_video','other'
  )),
  quantity integer not null check (quantity between 1 and 10000),
  platform text,
  due_on date,
  status text not null default 'pending' check (status in ('pending','submitted','approved','rejected')),
  proof_url text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint collaboration_deliverables_platform_shape check (
    platform is null
    or (
      char_length(platform) between 1 and 80
      and platform = btrim(platform)
    )
  ),
  constraint collaboration_deliverables_notes_shape check (
    notes is null
    or (
      char_length(notes) between 1 and 2000
      and notes = btrim(notes)
    )
  ),
  constraint collaboration_deliverables_proof_url_shape check (
    proof_url is null
    or (
      char_length(proof_url) between 1 and 2000
      and proof_url ~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]]*)?$'
    )
  )
);

comment on table public.collaboration_deliverables is
  'D078 checklist of pieces of content owed on one collaboration. Status is execution. It does not change the derived value of the piece. Proof is an https URL the creator records, not an upload.';

create index collaboration_deliverables_collaboration_idx
  on public.collaboration_deliverables (collaboration_id, created_at, id);

create index collaboration_deliverables_creator_idx
  on public.collaboration_deliverables (creator_id);

create trigger collaboration_deliverables_set_updated_at
  before update on public.collaboration_deliverables
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Same-creator fence. Fires for every writer, including service_role.
-- A missing collaboration and another creator's collaboration are the same
-- failure: the row is not written.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_collaboration_record_same_creator()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator uuid;
  v_pipeline uuid;
  v_item_creator uuid;
  v_mail uuid;
  v_mail_user uuid;
  v_creator_user uuid;
  v_attempt uuid;
  v_thread text;
begin
  select c.creator_id, c.pipeline_item_id
    into v_creator, v_pipeline
    from public.collaborations c
   where c.id = new.collaboration_id;

  if v_creator is null
     or v_creator is distinct from new.creator_id
     or v_pipeline is null
     or v_pipeline is distinct from new.pipeline_item_id then
    raise exception 'collaboration record must belong to the same creator and pipeline item'
      using errcode = '23514';
  end if;

  select pi.creator_id into v_item_creator
    from public.pipeline_items pi
   where pi.id = new.pipeline_item_id;

  if v_item_creator is null or v_item_creator is distinct from new.creator_id then
    raise exception 'collaboration record must belong to the same creator and pipeline item'
      using errcode = '23514';
  end if;

  if tg_table_name = 'collaboration_compensation_suggestions' then
    v_mail := (pg_catalog.to_jsonb(new) ->> 'source_mail_account_id')::uuid;
    v_attempt := (pg_catalog.to_jsonb(new) ->> 'source_attempt_id')::uuid;
    v_thread := pg_catalog.to_jsonb(new) ->> 'source_provider_thread_id';
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
           from private.gmail_commercial_thread_attempts a
          where a.id = v_attempt
            and a.mail_account_id = v_mail
            and a.user_id = v_creator_user
            and a.provider_thread_id = v_thread
            and a.compensation_structure = new.structure
       ) then
      raise exception 'compensation suggestion must cite this creator''s own machine reading'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

comment on function public.enforce_collaboration_record_same_creator() is
  'Rejects a compensation or deliverable row whose creator, collaboration, or pipeline item disagree, and a suggestion that cites another creator''s mailbox or machine attempt. SECURITY DEFINER so the check sees the other row even when the caller cannot. search_path is pinned empty.';

revoke all on function public.enforce_collaboration_record_same_creator()
  from public, anon, authenticated;
grant execute on function public.enforce_collaboration_record_same_creator()
  to service_role;

create trigger collaboration_agreed_compensations_same_creator
  before insert or update on public.collaboration_agreed_compensations
  for each row execute function public.enforce_collaboration_record_same_creator();

create trigger collaboration_deliverables_same_creator
  before insert or update on public.collaboration_deliverables
  for each row execute function public.enforce_collaboration_record_same_creator();

create trigger collaboration_compensation_suggestions_same_creator
  before insert or update on public.collaboration_compensation_suggestions
  for each row execute function public.enforce_collaboration_record_same_creator();

-- A collaboration whose creator or pipeline item changes must not leave a
-- child describing the previous owner. Setting pipeline_item_id to null is
-- the existing ON DELETE SET NULL path and is allowed; children cascade from
-- the pipeline item themselves.
create or replace function public.enforce_collaboration_children_same_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.creator_id is distinct from old.creator_id then
    if exists (
      select 1 from public.collaboration_agreed_compensations c
       where c.collaboration_id = new.id
    ) or exists (
      select 1 from public.collaboration_deliverables d
       where d.collaboration_id = new.id
    ) or exists (
      select 1 from public.collaboration_compensation_suggestions s
       where s.collaboration_id = new.id
    ) then
      raise exception 'collaboration owner cannot change while compensation or deliverables exist'
        using errcode = '23514';
    end if;
  end if;

  if new.pipeline_item_id is not null
     and new.pipeline_item_id is distinct from old.pipeline_item_id
     and (
       exists (
         select 1 from public.collaboration_agreed_compensations c
          where c.collaboration_id = new.id
            and c.pipeline_item_id is distinct from new.pipeline_item_id
       ) or exists (
         select 1 from public.collaboration_deliverables d
          where d.collaboration_id = new.id
            and d.pipeline_item_id is distinct from new.pipeline_item_id
       ) or exists (
         select 1 from public.collaboration_compensation_suggestions s
          where s.collaboration_id = new.id
            and s.pipeline_item_id is distinct from new.pipeline_item_id
       )
     ) then
    raise exception 'collaboration pipeline item cannot change while compensation or deliverables exist'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

comment on function public.enforce_collaboration_children_same_owner() is
  'Rejects a collaborations.creator_id or pipeline_item_id change that would detach existing compensation or deliverables. SECURITY DEFINER. search_path is pinned empty.';

revoke all on function public.enforce_collaboration_children_same_owner()
  from public, anon, authenticated;
grant execute on function public.enforce_collaboration_children_same_owner()
  to service_role;

create trigger collaborations_children_same_owner
  before update of creator_id, pipeline_item_id on public.collaborations
  for each row execute function public.enforce_collaboration_children_same_owner();

-- ---------------------------------------------------------------------------
-- RLS. Authenticated may SELECT own rows. Writes are the RPCs below.
-- The repo does not FORCE row level security; service_role remains the
-- trusted writer and the triggers above are the cross-tenant fence.
-- ---------------------------------------------------------------------------
alter table public.collaboration_agreed_compensations enable row level security;
alter table public.collaboration_deliverables enable row level security;
alter table public.collaboration_compensation_suggestions enable row level security;

create policy collaboration_agreed_compensations_all
  on public.collaboration_agreed_compensations
  for all
  using (creator_id = public.current_creator_id())
  with check (creator_id = public.current_creator_id());

create policy collaboration_deliverables_all
  on public.collaboration_deliverables
  for all
  using (creator_id = public.current_creator_id())
  with check (creator_id = public.current_creator_id());

create policy collaboration_compensation_suggestions_all
  on public.collaboration_compensation_suggestions
  for all
  using (creator_id = public.current_creator_id())
  with check (creator_id = public.current_creator_id());

revoke all on table
  public.collaboration_agreed_compensations,
  public.collaboration_deliverables,
  public.collaboration_compensation_suggestions
  from public, anon, authenticated;

grant select on table
  public.collaboration_agreed_compensations,
  public.collaboration_deliverables,
  public.collaboration_compensation_suggestions
  to authenticated;

grant select, insert, update, delete on table
  public.collaboration_agreed_compensations,
  public.collaboration_deliverables,
  public.collaboration_compensation_suggestions
  to service_role;

-- ---------------------------------------------------------------------------
-- Shared lookup. not_found for a missing id and for another creator's id are
-- the same jsonb, so the caller cannot tell them apart.
-- ---------------------------------------------------------------------------
create or replace function public.upsert_collaboration_compensation(
  p_user_id uuid,
  p_pipeline_item_id uuid,
  p_structure text,
  p_cash_amount_minor bigint,
  p_cash_currency text,
  p_in_kind_description text,
  p_in_kind_estimate_minor bigint,
  p_in_kind_estimate_currency text,
  p_payment_status text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_count integer;
  v_collab_id uuid;
  v_collab_creator uuid;
  v_structure text;
  v_payment text;
  v_description text;
  v_cash_currency text;
  v_estimate_currency text;
  v_saved uuid;
begin
  if p_user_id is null or p_pipeline_item_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  v_structure := nullif(btrim(coalesce(p_structure, '')), '');
  v_payment := nullif(btrim(coalesce(p_payment_status, '')), '');
  v_description := nullif(btrim(coalesce(p_in_kind_description, '')), '');
  v_cash_currency := nullif(upper(btrim(coalesce(p_cash_currency, ''))), '');
  v_estimate_currency := nullif(upper(btrim(coalesce(p_in_kind_estimate_currency, ''))), '');

  if v_structure is null
     or v_structure not in ('paid','in_kind','hybrid','unpaid','other','unknown')
     or v_payment is null
     or v_payment not in ('pending','partially_paid','paid','not_applicable') then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  if p_cash_amount_minor is not null
     and (p_cash_amount_minor < 0 or p_cash_amount_minor > 9007199254740991) then
    return jsonb_build_object('result', 'invalid_input');
  end if;
  if p_in_kind_estimate_minor is not null
     and (p_in_kind_estimate_minor < 0 or p_in_kind_estimate_minor > 9007199254740991) then
    return jsonb_build_object('result', 'invalid_input');
  end if;
  if v_cash_currency is not null and not public.is_iso_currency(v_cash_currency) then
    return jsonb_build_object('result', 'invalid_input');
  end if;
  if v_estimate_currency is not null and not public.is_iso_currency(v_estimate_currency) then
    return jsonb_build_object('result', 'invalid_input');
  end if;
  if v_description is not null and char_length(v_description) > 500 then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  if v_structure = 'paid' then
    if p_cash_amount_minor is null or v_cash_currency is null
       or v_description is not null
       or p_in_kind_estimate_minor is not null
       or v_estimate_currency is not null
       or v_payment not in ('pending','partially_paid','paid') then
      return jsonb_build_object('result', 'invalid_input');
    end if;
  elsif v_structure = 'in_kind' then
    if p_cash_amount_minor is not null or v_cash_currency is not null
       or v_description is null
       or (p_in_kind_estimate_minor is null) <> (v_estimate_currency is null)
       or v_payment <> 'not_applicable' then
      return jsonb_build_object('result', 'invalid_input');
    end if;
  elsif v_structure = 'hybrid' then
    if p_cash_amount_minor is null or v_cash_currency is null
       or v_description is null
       or (p_in_kind_estimate_minor is null) <> (v_estimate_currency is null)
       or v_payment not in ('pending','partially_paid','paid') then
      return jsonb_build_object('result', 'invalid_input');
    end if;
    if p_in_kind_estimate_minor is not null
       and v_cash_currency is not distinct from v_estimate_currency
       and p_cash_amount_minor > 9007199254740991 - p_in_kind_estimate_minor then
      return jsonb_build_object('result', 'invalid_input');
    end if;
  else
    if p_cash_amount_minor is not null or v_cash_currency is not null
       or v_description is not null
       or p_in_kind_estimate_minor is not null
       or v_estimate_currency is not null
       or v_payment <> 'not_applicable' then
      return jsonb_build_object('result', 'invalid_input');
    end if;
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return jsonb_build_object('result', 'creator_profile_missing');
  end if;

  perform 1 from public.creator_profiles where id = v_creator_id for update;

  if not exists (
    select 1 from public.pipeline_items pi
     where pi.id = p_pipeline_item_id
       and pi.creator_id = v_creator_id
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  select count(*)::integer into v_count
    from public.collaborations c
   where c.pipeline_item_id = p_pipeline_item_id;

  if v_count = 0 then
    return jsonb_build_object('result', 'collaboration_not_found');
  end if;
  if v_count <> 1 then
    return jsonb_build_object('result', 'integrity_error');
  end if;

  select c.id, c.creator_id
    into v_collab_id, v_collab_creator
    from public.collaborations c
   where c.pipeline_item_id = p_pipeline_item_id
   for update;

  if v_collab_creator is distinct from v_creator_id then
    return jsonb_build_object('result', 'integrity_error');
  end if;

  insert into public.collaboration_agreed_compensations (
    creator_id, collaboration_id, pipeline_item_id,
    structure, cash_amount_minor, cash_currency,
    in_kind_description, in_kind_estimate_minor, in_kind_estimate_currency,
    payment_status
  ) values (
    v_creator_id, v_collab_id, p_pipeline_item_id,
    v_structure, p_cash_amount_minor, v_cash_currency,
    v_description, p_in_kind_estimate_minor, v_estimate_currency,
    v_payment
  )
  on conflict on constraint collaboration_agreed_compensations_collaboration_uidx
  do update set
    structure = excluded.structure,
    cash_amount_minor = excluded.cash_amount_minor,
    cash_currency = excluded.cash_currency,
    in_kind_description = excluded.in_kind_description,
    in_kind_estimate_minor = excluded.in_kind_estimate_minor,
    in_kind_estimate_currency = excluded.in_kind_estimate_currency,
    payment_status = excluded.payment_status
  where public.collaboration_agreed_compensations.creator_id = excluded.creator_id
    and public.collaboration_agreed_compensations.pipeline_item_id = excluded.pipeline_item_id
  returning id into v_saved;

  if v_saved is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  return jsonb_build_object('result', 'saved');
end;
$$;

comment on function public.upsert_collaboration_compensation(uuid, uuid, text, bigint, text, text, bigint, text, text) is
  'D078 creator write of agreed compensation. Does not read or write the machine suggestion. Records only: no charge and no payment provider. service_role only.';

revoke all on function public.upsert_collaboration_compensation(uuid, uuid, text, bigint, text, text, bigint, text, text)
  from public, anon, authenticated;
grant execute on function public.upsert_collaboration_compensation(uuid, uuid, text, bigint, text, text, bigint, text, text)
  to service_role;

create or replace function public.upsert_collaboration_deliverable(
  p_user_id uuid,
  p_pipeline_item_id uuid,
  p_deliverable_id uuid,
  p_deliverable_type text,
  p_quantity integer,
  p_platform text,
  p_due_on date,
  p_status text,
  p_proof_url text,
  p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_count integer;
  v_collab_id uuid;
  v_collab_creator uuid;
  v_type text;
  v_status text;
  v_platform text;
  v_notes text;
  v_url text;
  v_saved uuid;
begin
  if p_user_id is null or p_pipeline_item_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  v_type := nullif(btrim(coalesce(p_deliverable_type, '')), '');
  v_status := nullif(btrim(coalesce(p_status, '')), '');
  v_platform := nullif(btrim(coalesce(p_platform, '')), '');
  v_notes := nullif(btrim(coalesce(p_notes, '')), '');
  v_url := nullif(btrim(coalesce(p_proof_url, '')), '');

  if v_type is null
     or v_type not in ('reel','story','post','tiktok','youtube','photo_set','ugc_video','other')
     or v_status is null
     or v_status not in ('pending','submitted','approved','rejected')
     or p_quantity is null
     or p_quantity < 1
     or p_quantity > 10000 then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  if v_platform is not null and char_length(v_platform) > 80 then
    return jsonb_build_object('result', 'invalid_input');
  end if;
  if v_notes is not null and char_length(v_notes) > 2000 then
    return jsonb_build_object('result', 'invalid_input');
  end if;
  if v_url is not null
     and (
       char_length(v_url) > 2000
       or v_url !~ '^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[^[:space:]]*)?$'
     ) then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return jsonb_build_object('result', 'creator_profile_missing');
  end if;

  perform 1 from public.creator_profiles where id = v_creator_id for update;

  if not exists (
    select 1 from public.pipeline_items pi
     where pi.id = p_pipeline_item_id
       and pi.creator_id = v_creator_id
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  select count(*)::integer into v_count
    from public.collaborations c
   where c.pipeline_item_id = p_pipeline_item_id;

  if v_count = 0 then
    return jsonb_build_object('result', 'collaboration_not_found');
  end if;
  if v_count <> 1 then
    return jsonb_build_object('result', 'integrity_error');
  end if;

  select c.id, c.creator_id
    into v_collab_id, v_collab_creator
    from public.collaborations c
   where c.pipeline_item_id = p_pipeline_item_id
   for update;

  if v_collab_creator is distinct from v_creator_id then
    return jsonb_build_object('result', 'integrity_error');
  end if;

  if p_deliverable_id is null then
    insert into public.collaboration_deliverables (
      creator_id, collaboration_id, pipeline_item_id,
      deliverable_type, quantity, platform, due_on, status, proof_url, notes
    ) values (
      v_creator_id, v_collab_id, p_pipeline_item_id,
      v_type, p_quantity, v_platform, p_due_on, v_status, v_url, v_notes
    )
    returning id into v_saved;
  else
    update public.collaboration_deliverables d
       set deliverable_type = v_type,
           quantity = p_quantity,
           platform = v_platform,
           due_on = p_due_on,
           status = v_status,
           proof_url = v_url,
           notes = v_notes
     where d.id = p_deliverable_id
       and d.collaboration_id = v_collab_id
       and d.creator_id = v_creator_id
       and d.pipeline_item_id = p_pipeline_item_id
    returning d.id into v_saved;

    if v_saved is null then
      return jsonb_build_object('result', 'not_found');
    end if;
  end if;

  return jsonb_build_object('result', 'saved', 'deliverable_id', v_saved);
end;
$$;

comment on function public.upsert_collaboration_deliverable(uuid, uuid, uuid, text, integer, text, date, text, text, text) is
  'D078 creator write of one deliverable on the caller''s own collaboration. A foreign deliverable id is not_found and is not moved. service_role only.';

revoke all on function public.upsert_collaboration_deliverable(uuid, uuid, uuid, text, integer, text, date, text, text, text)
  from public, anon, authenticated;
grant execute on function public.upsert_collaboration_deliverable(uuid, uuid, uuid, text, integer, text, date, text, text, text)
  to service_role;

create or replace function public.delete_collaboration_deliverable(
  p_user_id uuid,
  p_pipeline_item_id uuid,
  p_deliverable_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_creator_id uuid;
  v_collab_id uuid;
  v_deleted uuid;
begin
  if p_user_id is null or p_pipeline_item_id is null or p_deliverable_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return jsonb_build_object('result', 'creator_profile_missing');
  end if;

  perform 1 from public.creator_profiles where id = v_creator_id for update;

  select c.id into v_collab_id
    from public.collaborations c
    join public.pipeline_items pi on pi.id = c.pipeline_item_id
   where c.pipeline_item_id = p_pipeline_item_id
     and pi.creator_id = v_creator_id
     and c.creator_id = v_creator_id;

  if v_collab_id is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  delete from public.collaboration_deliverables d
   where d.id = p_deliverable_id
     and d.collaboration_id = v_collab_id
     and d.creator_id = v_creator_id
  returning d.id into v_deleted;

  if v_deleted is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  return jsonb_build_object('result', 'deleted');
end;
$$;

comment on function public.delete_collaboration_deliverable(uuid, uuid, uuid) is
  'D078 delete of one deliverable on the caller''s own collaboration. A foreign id and a missing id both return not_found. service_role only.';

revoke all on function public.delete_collaboration_deliverable(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.delete_collaboration_deliverable(uuid, uuid, uuid)
  to service_role;

-- Copies the current B07 machine compensation structure onto the suggestion
-- row. The same staleness rule as gmail_commercial_read_thread applies: a
-- stale or unbound attempt is not a current suggestion and is not written.
-- The agreed-compensation table is not mentioned in the write.
create or replace function public.prefill_collaboration_compensation_suggestion(
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
  v_creator_id uuid;
  v_count integer;
  v_collab_id uuid;
  v_collab_creator uuid;
  v_thread text;
  v_mail_user uuid;
  v_structure text;
  v_attempt uuid;
  v_rule text;
  v_saved uuid;
begin
  if p_user_id is null or p_pipeline_item_id is null or p_mail_account_id is null then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  v_thread := nullif(btrim(coalesce(p_provider_thread_id, '')), '');
  if v_thread is null or char_length(v_thread) > 256 then
    return jsonb_build_object('result', 'invalid_input');
  end if;

  select cp.id into v_creator_id
    from public.creator_profiles cp
   where cp.user_id = p_user_id;

  if v_creator_id is null then
    return jsonb_build_object('result', 'creator_profile_missing');
  end if;

  perform 1 from public.creator_profiles where id = v_creator_id for update;

  select m.user_id into v_mail_user
    from public.mail_accounts m
   where m.id = p_mail_account_id;

  if v_mail_user is null or v_mail_user is distinct from p_user_id then
    return jsonb_build_object('result', 'not_found');
  end if;

  if not exists (
    select 1 from public.pipeline_items pi
     where pi.id = p_pipeline_item_id
       and pi.creator_id = v_creator_id
  ) then
    return jsonb_build_object('result', 'not_found');
  end if;

  select count(*)::integer into v_count
    from public.collaborations c
   where c.pipeline_item_id = p_pipeline_item_id;

  if v_count = 0 then
    return jsonb_build_object('result', 'collaboration_not_found');
  end if;
  if v_count <> 1 then
    return jsonb_build_object('result', 'integrity_error');
  end if;

  select c.id, c.creator_id
    into v_collab_id, v_collab_creator
    from public.collaborations c
   where c.pipeline_item_id = p_pipeline_item_id
   for update;

  if v_collab_creator is distinct from v_creator_id then
    return jsonb_build_object('result', 'integrity_error');
  end if;

  select a.compensation_structure, a.id, a.rule_version
    into v_structure, v_attempt, v_rule
    from private.gmail_commercial_thread_current c
    join private.gmail_commercial_thread_attempts a
      on a.id = c.current_attempt_id
   where c.mail_account_id = p_mail_account_id
     and c.provider_thread_id = v_thread
     and c.user_id = p_user_id
     and a.user_id = p_user_id
     and not c.stale
     and a.normalized_thread_id is not null
     and not exists (
       select 1
         from private.gmail_commercial_message_current mc
         join private.gmail_commercial_message_attempts ma
           on ma.id = mc.current_attempt_id
        where mc.mail_account_id = c.mail_account_id
          and mc.provider_thread_id = c.provider_thread_id
          and ma.current_normalized_message_id is null
     );

  if v_structure is null or v_attempt is null then
    return jsonb_build_object('result', 'no_current_machine_compensation');
  end if;

  insert into public.collaboration_compensation_suggestions (
    creator_id, collaboration_id, pipeline_item_id,
    structure, source_mail_account_id, source_provider_thread_id,
    source_attempt_id, rule_version
  ) values (
    v_creator_id, v_collab_id, p_pipeline_item_id,
    v_structure, p_mail_account_id, v_thread,
    v_attempt, v_rule
  )
  on conflict on constraint collaboration_compensation_suggestions_collaboration_uidx
  do update set
    structure = excluded.structure,
    source_mail_account_id = excluded.source_mail_account_id,
    source_provider_thread_id = excluded.source_provider_thread_id,
    source_attempt_id = excluded.source_attempt_id,
    rule_version = excluded.rule_version
  where public.collaboration_compensation_suggestions.creator_id = excluded.creator_id
  returning id into v_saved;

  if v_saved is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  return jsonb_build_object(
    'result', 'suggested',
    'structure', v_structure,
    'authority', 'machine_suggestion'
  );
end;
$$;

comment on function public.prefill_collaboration_compensation_suggestion(uuid, uuid, uuid, text) is
  'D078 copy of the current B07 machine compensation structure into the suggestion table. Does not update agreed compensation. A stale or missing machine reading writes nothing. service_role only.';

revoke all on function public.prefill_collaboration_compensation_suggestion(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.prefill_collaboration_compensation_suggestion(uuid, uuid, uuid, text)
  to service_role;

-- ---------------------------------------------------------------------------
-- Read model. SECURITY INVOKER so RLS hides another creator's rows.
-- Allocation is largest-remainder across quantity (each unit is one piece).
-- Status does not change the share. Unknown amounts are JSON null.
-- ---------------------------------------------------------------------------
create or replace function public.collaboration_deliverable_values(p_pipeline_item_id uuid)
returns jsonb
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_count integer;
  v_collab_id uuid;
  v_comp public.collaboration_agreed_compensations%rowtype;
  v_has_comp boolean := false;
  v_kind text;
  v_reason text;
  v_currency text;
  v_total bigint;
  v_pieces bigint;
  v_alloc jsonb := '{}'::jsonb;
  v_compensation jsonb;
  v_suggestion jsonb;
  v_deliverables jsonb;
begin
  if p_pipeline_item_id is null then
    return jsonb_build_object('result', 'not_found');
  end if;

  select count(*)::integer into v_count
    from public.collaborations c
   where c.pipeline_item_id = p_pipeline_item_id;

  if v_count = 0 then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_count <> 1 then
    return jsonb_build_object('result', 'integrity_error');
  end if;

  select c.id into v_collab_id
    from public.collaborations c
   where c.pipeline_item_id = p_pipeline_item_id;

  select * into v_comp
    from public.collaboration_agreed_compensations comp
   where comp.collaboration_id = v_collab_id;

  v_has_comp := found;

  if not v_has_comp then
    v_kind := 'unknown';
    v_reason := 'no_creator_compensation';
    v_currency := null;
    v_total := null;
  elsif v_comp.structure = 'unknown' then
    v_kind := 'unknown';
    v_reason := 'structure_unknown';
    v_currency := null;
    v_total := null;
  elsif v_comp.structure = 'other' then
    v_kind := 'unknown';
    v_reason := 'structure_other';
    v_currency := null;
    v_total := null;
  elsif v_comp.structure = 'unpaid' then
    v_kind := 'derived';
    v_reason := 'unpaid';
    v_currency := null;
    v_total := 0;
  elsif v_comp.structure = 'paid' then
    v_kind := 'derived';
    v_reason := 'allocated';
    v_currency := v_comp.cash_currency;
    v_total := v_comp.cash_amount_minor;
  elsif v_comp.structure = 'in_kind' then
    if v_comp.in_kind_estimate_minor is null then
      v_kind := 'unknown';
      v_reason := 'in_kind_estimate_missing';
      v_currency := null;
      v_total := null;
    else
      v_kind := 'derived';
      v_reason := 'allocated';
      v_currency := v_comp.in_kind_estimate_currency;
      v_total := v_comp.in_kind_estimate_minor;
    end if;
  elsif v_comp.structure = 'hybrid' then
    if v_comp.in_kind_estimate_minor is null then
      v_kind := 'unknown';
      v_reason := 'hybrid_incomplete';
      v_currency := null;
      v_total := null;
    elsif v_comp.cash_currency is distinct from v_comp.in_kind_estimate_currency then
      v_kind := 'unknown';
      v_reason := 'currency_mismatch';
      v_currency := null;
      v_total := null;
    elsif v_comp.cash_amount_minor > 9007199254740991 - v_comp.in_kind_estimate_minor then
      return jsonb_build_object('result', 'integrity_error');
    else
      v_kind := 'derived';
      v_reason := 'allocated';
      v_currency := v_comp.cash_currency;
      v_total := v_comp.cash_amount_minor + v_comp.in_kind_estimate_minor;
    end if;
  else
    return jsonb_build_object('result', 'integrity_error');
  end if;

  if v_kind = 'derived' and v_reason = 'allocated' then
    select coalesce(sum(d.quantity), 0)::bigint into v_pieces
      from public.collaboration_deliverables d
     where d.collaboration_id = v_collab_id;

    if v_pieces > 0 then
      select coalesce(jsonb_object_agg(ranked.id::text, to_jsonb(ranked.amount_minor)), '{}'::jsonb)
        into v_alloc
        from (
          select lines.id,
                 lines.base + case
                   when row_number() over (
                     order by lines.frac desc, lines.created_at, lines.id
                   ) <= (v_total - sums.base_sum)
                   then 1
                   else 0
                 end as amount_minor
            from (
              select d.id,
                     d.created_at,
                     floor((v_total::numeric * d.quantity) / v_pieces)::bigint as base,
                     ((v_total::numeric * d.quantity) / v_pieces)
                       - floor((v_total::numeric * d.quantity) / v_pieces) as frac
                from public.collaboration_deliverables d
               where d.collaboration_id = v_collab_id
            ) lines
            cross join (
              select coalesce(sum(
                       floor((v_total::numeric * d.quantity) / v_pieces)::bigint
                     ), 0)::bigint as base_sum
                from public.collaboration_deliverables d
               where d.collaboration_id = v_collab_id
            ) sums
        ) ranked;

      if exists (
        select 1
          from public.collaboration_deliverables d
         where d.collaboration_id = v_collab_id
           and not (v_alloc ? (d.id::text))
      ) then
        return jsonb_build_object('result', 'integrity_error');
      end if;
    end if;
  end if;

  if v_has_comp then
    v_compensation := jsonb_build_object(
      'authority', 'creator',
      'structure', v_comp.structure,
      'cash_amount_minor', v_comp.cash_amount_minor,
      'cash_currency', v_comp.cash_currency,
      'in_kind_description', v_comp.in_kind_description,
      'in_kind_estimate_minor', v_comp.in_kind_estimate_minor,
      'in_kind_estimate_currency', v_comp.in_kind_estimate_currency,
      'in_kind_estimate_label', case
        when v_comp.in_kind_estimate_minor is null then null
        else 'creator_estimate'
      end,
      'payment_status', v_comp.payment_status
    );
  else
    v_compensation := null;
  end if;

  select jsonb_build_object(
           'authority', 'machine_suggestion',
           'structure', s.structure,
           'source_mail_account_id', s.source_mail_account_id,
           'source_provider_thread_id', s.source_provider_thread_id,
           'source_attempt_id', s.source_attempt_id,
           'rule_version', s.rule_version
         )
    into v_suggestion
    from public.collaboration_compensation_suggestions s
   where s.collaboration_id = v_collab_id;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'id', d.id,
             'deliverable_type', d.deliverable_type,
             'quantity', d.quantity,
             'platform', d.platform,
             'due_on', d.due_on,
             'status', d.status,
             'proof_url', d.proof_url,
             'notes', d.notes,
             'attributed_value', case
               when v_kind = 'unknown' then jsonb_build_object(
                 'kind', 'unknown',
                 'label', 'unknown',
                 'basis', 'unknown',
                 'amount_minor', null,
                 'currency', null
               )
               when v_reason = 'unpaid' then jsonb_build_object(
                 'kind', 'derived',
                 'label', 'derived',
                 'basis', 'unpaid_explicit',
                 'amount_minor', 0,
                 'currency', null
               )
               else jsonb_build_object(
                 'kind', 'derived',
                 'label', 'derived',
                 'basis', 'allocated',
                 'amount_minor', (v_alloc ->> d.id::text)::bigint,
                 'currency', v_currency
               )
             end
           )
           order by d.created_at, d.id
         ), '[]'::jsonb)
    into v_deliverables
    from public.collaboration_deliverables d
   where d.collaboration_id = v_collab_id;

  return jsonb_build_object(
    'result', 'ok',
    'compensation', v_compensation,
    'suggestion', v_suggestion,
    'valuation', jsonb_build_object(
      'kind', v_kind,
      'label', case when v_kind = 'unknown' then 'unknown' else 'derived' end,
      'reason', v_reason,
      'currency', v_currency,
      'total_minor', v_total
    ),
    'deliverables', v_deliverables
  );
end;
$$;

comment on function public.collaboration_deliverable_values(uuid) is
  'D078 read model. Derived value of each deliverable from the creator compensation record. Labeled derived. Unknown is JSON null, never zero. Runs as the caller so RLS applies. A machine suggestion is returned beside the creator record and is not allocated.';

revoke all on function public.collaboration_deliverable_values(uuid) from public, anon;
grant execute on function public.collaboration_deliverable_values(uuid) to authenticated, service_role;
