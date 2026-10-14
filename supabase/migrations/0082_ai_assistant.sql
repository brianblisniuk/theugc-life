-- 0082 — D03 AI assistant storage (D141–D145).
--
-- Adds the ledger reason and the usage table. The reason is not inserted
-- here: PostgreSQL will not use a new enum value in the same transaction
-- that adds it. 0083 charges the draft.
--
-- ai_usage stores token counts and an estimated cost. It has no prompt,
-- no completion, and no message body.

alter type public.credit_reason add value 'ai_draft';

alter table public.credit_config
  add column ai_draft_cost integer not null default 1
  check (ai_draft_cost > 0);

comment on column public.credit_config.ai_draft_cost is
  'Credits charged for one successful AI pitch draft (D143). One, the same unit as an unlock. Not a card charge.';

update public.credit_config
   set ai_draft_cost = 1
 where id;

alter table public.pitch_drafts
  add column origin text not null default 'template'
  constraint pitch_drafts_origin_check check (origin in ('template', 'assistant'));

comment on column public.pitch_drafts.origin is
  'template is the manual fill. assistant is a model draft. Neither value sends mail (D142).';

create table public.ai_usage (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  user_id uuid not null references public.users (id) on delete cascade,
  task text not null check (task = 'compose_pitch'),
  model text not null check (char_length(model) between 1 and 80),
  input_tokens integer not null check (input_tokens >= 0 and input_tokens <= 200000),
  output_tokens integer not null check (output_tokens >= 0 and output_tokens <= 8192),
  estimated_cost_micros bigint not null check (
    estimated_cost_micros >= 0 and estimated_cost_micros <= 1000000000
  ),
  status text not null check (status in ('reserved', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  unique (request_id, status)
);

comment on table public.ai_usage is
  'D145. Token counts and estimated USD micros for one assistant call. No prompt, no completion, no mailbox body. Append-only. Deleting the user cascades the rows.';

create index ai_usage_user_created_idx
  on public.ai_usage (user_id, created_at);

create index ai_usage_created_idx
  on public.ai_usage (created_at);

create or replace function public.ai_usage_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'ai_usage is append-only' using errcode = '55000';
end;
$$;

create trigger ai_usage_no_update
  before update on public.ai_usage
  for each row execute function public.ai_usage_append_only();

create trigger ai_usage_no_delete
  before delete on public.ai_usage
  for each row execute function public.ai_usage_append_only();

alter table public.ai_usage enable row level security;

create policy ai_usage_select_own
  on public.ai_usage
  for select
  using (user_id = auth.uid());

revoke all on table public.ai_usage from public, anon, authenticated, service_role;
grant select on table public.ai_usage to authenticated, service_role;
grant insert on table public.ai_usage to service_role;

revoke all on function public.ai_usage_append_only() from public, anon, authenticated, service_role;
grant execute on function public.ai_usage_append_only() to authenticated, service_role;
