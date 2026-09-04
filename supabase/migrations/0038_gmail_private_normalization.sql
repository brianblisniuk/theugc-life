-- ===========================================================================
-- 0038 — B04: GMAIL PRIVATE NORMALIZATION (deterministic projection over B03)
-- ===========================================================================
-- B03 acquired a sanitized snapshot of a creator's sent-rooted Gmail history and
-- interpreted none of it. B04 is the first layer that turns that RAW EVIDENCE
-- into a DETERMINISTIC, REPLAY-SAFE, PRIVATE PROJECTION: normalized threads,
-- messages, header occurrences, parsed participants, syntactic message-id
-- reference tokens and decoded text parts — bound at all times to the exact
-- raw snapshot and normalizer version that produced them.
--
-- WHAT THIS MIGRATION DOES NOT CREATE, on purpose:
--
--   no outreach detection or hotel match (B05);
--   no sent/reply/timing fact — "reply", "reply_received", "reply_delay" and
--     any parent/child message relationship are PRODUCT facts, not syntactic
--     ones, and B04 writes none of them (B06);
--   no outcome, correction or creator feedback (B07);
--   no history cursor, watch subscription or incremental sync state (B08);
--   no network-intelligence eligibility, aggregate or contribution flag;
--   no attachment table, and no column that could hold attachment bytes —
--     B04 normalizes only the text/plain and text/html parts B03 already
--     retained, and cannot resurrect what B03 never persisted;
--   no client-readable view of Gmail content, raw or normalized, for any role.
--
-- It also performs NO Gmail network activity: zero Google calls, zero OAuth
-- changes, zero quota consumption. Every input already lives in
-- `private.gmail_raw_messages`; B04 is local computation over rows B03 wrote.
--
-- 0035, 0036 and 0037 are UNCHANGED. This migration extends the schema
-- additively: new tables, one new trigger on `private.gmail_raw_messages`
-- (source-replacement invalidation), one new deferred deletion invariant, and
-- a handful of new `SECURITY DEFINER` functions. Nothing in 0037 is rewritten.
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
     and c.relname in ('gmail_normalized_threads', 'gmail_normalized_messages',
                       'gmail_normalized_headers', 'gmail_normalized_participants',
                       'gmail_normalized_reference_tokens', 'gmail_normalized_text_parts');

  if colliding is not null then
    raise exception
      '0038 refuses to install: private table(s) % already exist. B04 is the first normalization layer, so pre-existing tables of these names hold state this migration did not create and cannot interpret. Resolve them explicitly rather than letting a migration adopt, alter or drop somebody else''s data.',
      array_to_string(colliding, ', ')
      using errcode = 'restrict_violation';
  end if;
end;
$$;

-- ===========================================================================
-- 1. NORMALIZED THREAD — Gmail's conversation grouping, nothing more
-- ===========================================================================
-- A Gmail provider thread is Gmail's grouping mechanism. It is NOT an outreach
-- thread, and this table asserts nothing about whether a human sent anything
-- into it that matters to the product — B05 owns that judgement, on top of B04.
--
-- IDENTITY IS (mail_account_id, provider_thread_id) — ACCOUNT-SCOPED, exactly
-- like B03's raw-message identity. The same `provider_thread_id` string under
-- two different mailboxes names two different Gmail accounts' conversations,
-- and must produce two distinct normalized threads.
create table private.gmail_normalized_threads (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null references public.users(id) on delete cascade,
  mail_account_id uuid not null,

  provider_thread_id text not null check (length(btrim(provider_thread_id)) > 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint gmail_normalized_threads_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  -- ACCOUNT-SCOPED IDENTITY. The same provider_thread_id in two mailboxes is
  -- two rows, never one.
  constraint gmail_normalized_threads_identity_uidx
    unique (mail_account_id, provider_thread_id),

  -- The composite target for child tables' account-scoped provenance FK below.
  constraint gmail_normalized_threads_id_account_uidx
    unique (id, mail_account_id)
);

comment on table private.gmail_normalized_threads is
  'B04: Gmail''s own thread grouping, account-scoped. Not an outreach thread, not a hotel conversation — B05 decides that, on top of this row. No status, no hotel_id, no reply/outcome state.';

create index gmail_normalized_threads_account_idx
  on private.gmail_normalized_threads (mail_account_id);

-- ===========================================================================
-- 2. NORMALIZED MESSAGE — a projection bound to ONE exact raw snapshot
-- ===========================================================================
-- IDENTITY IS (mail_account_id, provider_message_id) — the same account-scoped
-- identity B03 uses for the raw row. A normalized message additionally proves,
-- via a real foreign key rather than a text provenance column, that it was
-- computed from an EXACT raw row: `(mail_account_id, provider_message_id)`
-- must exist in `private.gmail_raw_messages`, and `source_payload_sha256` names
-- the exact digest it was computed from. A row whose recorded digest differs
-- from the raw row's CURRENT digest is not current — see §5's invalidation
-- trigger, which deletes such a row the moment it becomes true rather than
-- leaving it to be discovered stale by a reader.
create table private.gmail_normalized_messages (
  id uuid primary key default gen_random_uuid(),

  user_id uuid not null references public.users(id) on delete cascade,
  mail_account_id uuid not null,
  normalized_thread_id uuid not null,

  provider_message_id text not null check (length(btrim(provider_message_id)) > 0),

  -- Gmail's own `internalDate`, copied from the raw row at normalization time.
  -- Evidence, not proof of chronology beyond what B03 already established; see
  -- the deterministic ordering rule in §9 (application-level, `ORDER BY`).
  internal_date timestamptz not null,

  -- THE LITERAL PROVIDER FACT, and nothing more. Derived by the DATABASE from
  -- the raw row's `label_ids` at commit time — never accepted from the caller
  -- — so a TS-side bug cannot assert a SENT fact the raw evidence disagrees
  -- with. `SENT` present means exactly that; ABSENT proves nothing about
  -- "inbound" or "reply" (see D067/D068 and the B04 contract §"means/does not
  -- mean" table). No negative inference is stored, because none is licensed.
  provider_sent boolean not null,

  -- EXACT PROVENANCE, not a loose text field. What this proves, together:
  --   (mail_account_id, provider_message_id) -> the EXACT raw identity;
  --   source_payload_sha256                  -> the EXACT snapshot digest;
  --   normalizer_version                     -> the EXACT code contract used.
  -- All three must currently agree with the raw row for this projection to be
  -- "current" rather than a rebuild candidate.
  source_payload_sha256 text not null check (source_payload_sha256 ~ '^[0-9a-f]{64}$'),

  -- A SEMANTIC CONTRACT VERSION, not a git SHA, a timestamp or a package
  -- version. Sanitized-slug shaped so a future v2 is a value, not a schema
  -- change — unlike B03's `acquisition_strategy`, this one is EXPECTED to grow
  -- over the table's life: an old row is a rebuild candidate, not a violation.
  normalizer_version text not null check (normalizer_version ~ '^[a-z][a-z0-9_]{0,63}$'),

  normalized_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- EXACT RAW PROVENANCE, ENFORCEABLE, NOT A LOOSE TEXT FIELD. This FK alone
  -- also makes cross-account raw provenance unrepresentable: a message whose
  -- own `mail_account_id` differs from the raw row's cannot be inserted, full
  -- stop, regardless of what any caller asserts.
  constraint gmail_normalized_messages_raw_fk
    foreign key (mail_account_id, provider_message_id)
    references private.gmail_raw_messages (mail_account_id, provider_message_id)
    on delete cascade,

  -- THE MESSAGE'S THREAD MUST BE A THREAD OF THE SAME ACCOUNT. Composite FK,
  -- not an application promise — a message cannot point at another mailbox's
  -- thread even if a caller tries.
  constraint gmail_normalized_messages_thread_fk
    foreign key (normalized_thread_id, mail_account_id)
    references private.gmail_normalized_threads (id, mail_account_id)
    on delete cascade,

  constraint gmail_normalized_messages_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  -- ACCOUNT-SCOPED MESSAGE IDENTITY, mirroring the raw layer exactly.
  constraint gmail_normalized_messages_identity_uidx
    unique (mail_account_id, provider_message_id)
);

comment on table private.gmail_normalized_messages is
  'B04: one projection per raw Gmail message, bound to an exact source_payload_sha256 and normalizer_version. provider_sent is the literal SENT-label fact only — never inbound/reply/outcome inference. Stale the moment the raw row''s digest moves; see the AFTER UPDATE trigger on gmail_raw_messages.';

create index gmail_normalized_messages_thread_idx
  on private.gmail_normalized_messages (normalized_thread_id, internal_date, provider_message_id);

create index gmail_normalized_messages_account_idx
  on private.gmail_normalized_messages (mail_account_id);

-- A generic `updated_at` touch, shared by both tables above that carry the
-- column. Row-local, no side effects on any other table.
create or replace function private.touch_gmail_normalized_row()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.touch_gmail_normalized_row() from public;

create trigger gmail_normalized_threads_touch
  before update on private.gmail_normalized_threads
  for each row execute function private.touch_gmail_normalized_row();

create trigger gmail_normalized_messages_touch
  before update on private.gmail_normalized_messages
  for each row execute function private.touch_gmail_normalized_row();

-- ===========================================================================
-- 3. NORMALIZED HEADERS — every approved occurrence, losslessly, in order
-- ===========================================================================
-- B03 already refused to let a second `To:` overwrite a first. B04 does not
-- regress that: every approved occurrence B03 kept becomes its own row here,
-- carrying BOTH its position among occurrences of its own name (so "the second
-- To:" is addressable) and its position among ALL approved headers on the
-- message (so the original interleaved provider order is reconstructable).
create table private.gmail_normalized_headers (
  id uuid primary key default gen_random_uuid(),

  normalized_message_id uuid not null references private.gmail_normalized_messages(id) on delete cascade,

  -- The same approved set B03's sanitizer whitelists, lower-cased, no more and
  -- no less. B04 does not widen what B03 chose to keep.
  header_name text not null check (header_name in (
    'from', 'sender', 'reply-to', 'to', 'cc', 'bcc',
    'subject', 'date', 'message-id', 'in-reply-to', 'references'
  )),

  -- 0-based position among occurrences of THIS name on THIS message, in
  -- provider order.
  occurrence_index integer not null check (occurrence_index >= 0),

  -- 0-based position among ALL approved headers on THIS message, in provider
  -- order — the only thing that can reconstruct the original interleaving once
  -- headers are split by name.
  global_order integer not null check (global_order >= 0),

  -- Verbatim. B03 already refused to parse it; B04 does not parse it here
  -- either — this row IS the evidence a parser (below) reads from.
  raw_value text not null,

  created_at timestamptz not null default now(),

  -- NO DUPLICATE OCCURRENCE INDEX PER NAME PER MESSAGE.
  constraint gmail_normalized_headers_occurrence_uidx
    unique (normalized_message_id, header_name, occurrence_index),

  -- NO DUPLICATE GLOBAL POSITION PER MESSAGE.
  constraint gmail_normalized_headers_order_uidx
    unique (normalized_message_id, global_order)
);

comment on table private.gmail_normalized_headers is
  'B04: every approved header occurrence B03 kept, one row each, in both per-name and global provider order. Never collapsed, never concatenated — the interpretation layer (participants/reference tokens) reads FROM this evidence, it does not replace it.';

create index gmail_normalized_headers_message_idx
  on private.gmail_normalized_headers (normalized_message_id);

-- ===========================================================================
-- 4. NORMALIZED PARTICIPANTS — syntactic address parsing, nothing inferred
-- ===========================================================================
-- Parsed FROM address-bearing header occurrences only: From, Sender, Reply-To,
-- To, Cc, Bcc. Every parsed entry is linked to the EXACT header occurrence it
-- came from via a real foreign key, not a duplicated (name, index) pair.
--
-- MALFORMED EVIDENCE IS NOT DISCARDED. `parse_status` distinguishes a clean
-- addr-spec from a fragment the parser could not resolve into one, and either
-- way the row exists — a header that parsed to zero clean addresses is not the
-- same fact as a header that carried none.
create table private.gmail_normalized_participants (
  id uuid primary key default gen_random_uuid(),

  normalized_message_id uuid not null references private.gmail_normalized_messages(id) on delete cascade,
  source_header_id uuid not null references private.gmail_normalized_headers(id) on delete cascade,

  -- Denormalized for cheap filtering; the write path (the one and only writer,
  -- `gmail_normalize_commit_message`) guarantees it matches the linked header's
  -- `header_name`.
  header_role text not null check (header_role in ('from', 'sender', 'reply-to', 'to', 'cc', 'bcc')),

  -- 0-based order of this entry AMONG the entries parsed from the SAME header
  -- occurrence — a `To:` line with three addresses produces three rows sharing
  -- one `source_header_id` and `participant_order` 0, 1, 2.
  participant_order integer not null check (participant_order >= 0),

  -- AS PARSED, VERBATIM WHERE POSSIBLE. No +tag stripping, no Gmail-dot
  -- collapsing, no lowercasing of the local part, no cross-address merging.
  display_name text,
  addr_spec text,
  local_part text,
  domain text,
  -- Mechanical convenience only, never identity truth: `lower(domain)`.
  domain_lower text,
  -- The raw fragment the parser associated with this entry when no clean
  -- addr-spec could be extracted — present for `malformed`, absent otherwise.
  raw_fragment text,

  parse_status text not null check (parse_status in ('parsed', 'malformed', 'empty_group')),

  created_at timestamptz not null default now(),

  -- A `parsed` entry must actually carry the address it claims to have parsed.
  constraint gmail_normalized_participants_parsed_has_addr_spec
    check (parse_status <> 'parsed' or addr_spec is not null),

  -- NO DUPLICATE ORDER WITHIN ONE HEADER OCCURRENCE.
  constraint gmail_normalized_participants_order_uidx
    unique (source_header_id, participant_order)
);

comment on table private.gmail_normalized_participants is
  'B04: syntactic address-list parsing of From/Sender/Reply-To/To/Cc/Bcc occurrences only. No +tag stripping, no Gmail-dot collapsing, no identity merging, no hotel/creator/employee inference. A malformed or empty entry is still a row, linked to its exact source header.';

create index gmail_normalized_participants_message_idx
  on private.gmail_normalized_participants (normalized_message_id);

create index gmail_normalized_participants_header_idx
  on private.gmail_normalized_participants (source_header_id);

-- ===========================================================================
-- 5. NORMALIZED REFERENCE TOKENS — syntactic message-id tokens, not a reply graph
-- ===========================================================================
-- Message-ID, In-Reply-To and References are tokenized into individual
-- syntactic message-id tokens, in order. This is USEFUL evidence for a LATER
-- block, and it is explicitly NOT a reply relationship: there is no
-- `parent_message_id`, no `reply_to_normalized_message_id`, no `is_reply`
-- column anywhere in this migration, and none may be added here without a new
-- contract. A token is a string that looks like `<local@domain>`; whether it
-- names a message this system actually holds, and what a match would mean, is
-- a decision this table refuses to make.
create table private.gmail_normalized_reference_tokens (
  id uuid primary key default gen_random_uuid(),

  normalized_message_id uuid not null references private.gmail_normalized_messages(id) on delete cascade,
  source_header_id uuid not null references private.gmail_normalized_headers(id) on delete cascade,

  header_role text not null check (header_role in ('message-id', 'in-reply-to', 'references')),

  -- 0-based order among tokens parsed from the SAME header occurrence —
  -- `References` commonly carries many.
  token_order integer not null check (token_order >= 0),

  raw_token text not null,

  parse_status text not null check (parse_status in ('valid_msgid', 'malformed')),

  created_at timestamptz not null default now(),

  constraint gmail_normalized_reference_tokens_order_uidx
    unique (source_header_id, token_order)
);

comment on table private.gmail_normalized_reference_tokens is
  'B04: syntactic message-id tokens from Message-ID/In-Reply-To/References, in order. NOT a reply graph. No parent/child linkage, no is_reply, no reply_received — that judgement belongs to a later, explicitly contracted block.';

create index gmail_normalized_reference_tokens_message_idx
  on private.gmail_normalized_reference_tokens (normalized_message_id);

-- ===========================================================================
-- 6. NORMALIZED TEXT PARTS — decoded text/plain and text/html, nothing else
-- ===========================================================================
-- Only parts B03 actually classified as `text/plain` or `text/html` become a
-- row here — never a part B03 omitted as an attachment or non-text body, and
-- never a byte B03 did not already retain. `part_path` is B04's OWN structural
-- identity (child index at each nesting level), because B03 never promised
-- Gmail's `partId` survived sanitization.
create table private.gmail_normalized_text_parts (
  id uuid primary key default gen_random_uuid(),

  normalized_message_id uuid not null references private.gmail_normalized_messages(id) on delete cascade,

  -- Deterministic structural identity: `{}` is the root, `{0}` its first
  -- child, `{1,0}` the first child of the second child. UNIQUE within a
  -- message, and never Gmail's `partId`.
  part_path integer[] not null,

  mime_type text not null check (mime_type in ('text/plain', 'text/html')),

  -- Every surviving occurrence, as evidence — never resolved by "first wins"
  -- or "last wins", the exact lesson B03's MIME safety work already paid for.
  content_type_values text[] not null default '{}',
  content_disposition_values text[] not null default '{}',
  content_transfer_encoding_values text[] not null default '{}',

  -- Set ONLY when exactly one supported charset was declared across all
  -- surviving Content-Type occurrences. NULL for no declaration and for a
  -- genuine conflict — see `decode_status`.
  declared_charset text,
  -- Which path produced a successful decode: an explicit declaration, or the
  -- V1 no-declaration UTF-8 fallback. NULL unless decode_status is `decoded`
  -- or `empty_decoded`.
  charset_source text check (charset_source in ('declared', 'no_declaration_utf8_fallback')),

  -- Did the sanitized payload carry non-empty `body.data` for this part?
  body_data_present boolean not null,
  -- Did B03 itself mark this part's content omitted (`contentOmitted: true`)?
  b03_omitted boolean not null default false,
  -- B03's own omission reason, preserved verbatim where present. Never
  -- reinterpreted; B04 cannot recover content B03 chose not to keep.
  b03_omission_reason text check (b03_omission_reason in ('attachment', 'non_text', 'external_body')),

  decode_status text not null check (decode_status in (
    'decoded', 'empty_decoded', 'body_absent', 'content_omitted_by_b03',
    'invalid_base64url', 'conflicting_charset', 'unsupported_charset',
    'decode_failure', 'missing_charset_undecodable'
  )),

  -- Populated ONLY for `decoded` and `empty_decoded`. PRIVATE SOURCE TEXT —
  -- HTML included, and not declared safe for rendering. B04 builds no UI.
  decoded_text text,

  created_at timestamptz not null default now(),

  -- `decoded`/`empty_decoded` must actually carry decoded text (possibly
  -- empty-string); every other status must not claim one.
  constraint gmail_normalized_text_parts_decoded_text_consistency
    check (
      (decode_status in ('decoded', 'empty_decoded') and decoded_text is not null)
      or (decode_status not in ('decoded', 'empty_decoded') and decoded_text is null)
    ),

  constraint gmail_normalized_text_parts_charset_source_consistency
    check (
      (decode_status in ('decoded', 'empty_decoded') and charset_source is not null)
      or (decode_status not in ('decoded', 'empty_decoded') and charset_source is null)
    ),

  -- STRUCTURAL PATH UNIQUE WITHIN ONE MESSAGE.
  constraint gmail_normalized_text_parts_path_uidx
    unique (normalized_message_id, part_path)
);

comment on table private.gmail_normalized_text_parts is
  'B04: decoded text/plain and text/html parts only, one Gmail API base64url decode, charset applied at most once, Content-Transfer-Encoding preserved as evidence and never re-applied. HTML is private source text, not sanitized for rendering. No attachment, non-text or B03-omitted content is ever reconstructed here.';

create index gmail_normalized_text_parts_message_idx
  on private.gmail_normalized_text_parts (normalized_message_id);

-- ===========================================================================
-- 7. SOURCE REPLACEMENT — DURABLE INVALIDATION, IN THE SAME TRANSACTION
-- ===========================================================================
-- B03 legitimately updates an existing (mail_account_id, provider_message_id)
-- raw row when the provider snapshot changes: new labels, an edited approved
-- header, a new history id. When that happens, any B04 projection computed
-- from the OLD digest is stale the instant the new digest commits — and it
-- must not survive as if it were current.
--
-- The fix is symmetric with B03's own lesson: a fact that spans a gap must be
-- checked WHERE the gap closes, not observed later by whoever happens to look.
-- Here the gap is "the raw row changed after a projection was built", and it
-- closes at the raw row's own UPDATE — so the raw row's own trigger is where
-- the stale projection is removed, in the SAME transaction, before it commits.
--
-- This does not need to inspect WHICH digest is now current: the AFTER UPDATE
-- fires only when payload_sha256 actually moved, and there is at most one
-- normalized message per (mail_account_id, provider_message_id) by the unique
-- constraint above, so an unconditional delete of that one row (cascading to
-- every header/participant/reference-token/text-part) is exactly correct.
create or replace function private.invalidate_gmail_normalized_projection_on_raw_change()
returns trigger
language plpgsql
as $$
begin
  delete from private.gmail_normalized_messages
   where mail_account_id = new.mail_account_id
     and provider_message_id = new.provider_message_id;
  return null;
end;
$$;

revoke all on function private.invalidate_gmail_normalized_projection_on_raw_change() from public;

-- Installed on `private.gmail_raw_messages`, a table 0037 created. This is an
-- ADDITIVE trigger from 0038 — 0037's file is untouched, and its own triggers
-- (`gmail_raw_messages_thread_is_stable`, the deferred deletion check) continue
-- to fire independently of this one.
create trigger gmail_raw_messages_invalidate_normalization_on_change
  after update of payload_sha256 on private.gmail_raw_messages
  for each row
  when (new.payload_sha256 is distinct from old.payload_sha256)
  execute function private.invalidate_gmail_normalized_projection_on_raw_change();

-- ===========================================================================
-- 8. `deleted` MUST NOT COEXIST WITH B04 DATA
-- ===========================================================================
-- The same falsifiable assertion B03 enforces for its own tables, extended to
-- this layer. Checking `gmail_normalized_threads` alone is sufficient: every
-- message requires a live thread row (FK), and every header/participant/
-- reference-token/text-part requires a live message row (FK) — so if no
-- thread survives for the account, nothing beneath it can either. Registered
-- on `mail_accounts` (the write that marks `deleted`) AND on the thread and
-- message tables (the writes that could otherwise slip a fresh row past a
-- transaction that also marks the mailbox deleted), exactly mirroring 0037's
-- registration-on-every-write-origin rule.
create or replace function public.assert_gmail_normalized_data_absent_when_deleted()
returns trigger
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  account_id uuid;
  account_state text;
  thread_count integer;
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

  if not found then
    return null;
  end if;

  if account_state <> 'deleted' then
    return null;
  end if;

  select count(*)::int into thread_count
    from private.gmail_normalized_threads t where t.mail_account_id = account_id;

  if thread_count > 0 then
    raise exception
      'mail account % is `deleted` while % normalized Gmail thread(s) remain (messages/headers/participants/reference tokens/text parts cascade from them). B04-derived Gmail data must not survive a completed deletion.',
      account_id, thread_count
      using errcode = 'integrity_constraint_violation';
  end if;

  return null;
end;
$$;

revoke all on function public.assert_gmail_normalized_data_absent_when_deleted() from public;
revoke all on function public.assert_gmail_normalized_data_absent_when_deleted() from anon, authenticated;

create constraint trigger mail_accounts_gmail_normalized_absent_when_deleted
  after insert or update on public.mail_accounts
  deferrable initially deferred
  for each row execute function public.assert_gmail_normalized_data_absent_when_deleted();

create constraint trigger gmail_normalized_threads_absent_when_deleted
  after insert or update on private.gmail_normalized_threads
  deferrable initially deferred
  for each row execute function public.assert_gmail_normalized_data_absent_when_deleted();

create constraint trigger gmail_normalized_messages_absent_when_deleted
  after insert or update on private.gmail_normalized_messages
  deferrable initially deferred
  for each row execute function public.assert_gmail_normalized_data_absent_when_deleted();

-- ===========================================================================
-- 9. THE NORMALIZATION RPC SURFACE
-- ===========================================================================
-- B04 performs no Gmail network activity, so unlike B03 there is no lease, no
-- authorization-revision fence and no quota pacer here: the only gap this
-- layer has to close is TWO CONCURRENT LOCAL PROCESSES computing a projection
-- for the same raw row, or one process computing while another commits a NEW
-- raw snapshot underneath it. Both are closed the same way — a short
-- `for no key update` lock on the EXACT raw row, held only for the duration of
-- the one commit statement, never across any I/O.

-- ---------------------------------------------------------------------------
-- 9a. WHICH RAW MESSAGES NEED (RE)NORMALIZING
-- ---------------------------------------------------------------------------
-- A candidate is a raw message whose projection is ABSENT, OUT OF DATE (a
-- different `source_payload_sha256`) or STALE BY VERSION (a different
-- `normalizer_version` than the one the caller is currently running). Ordered
-- deterministically so a bounded batch is reproducible. Read-only: it takes no
-- lock, because planning what to normalize is not the operation that needs
-- one — the commit RPC below re-validates everything it needs under its own
-- lock regardless of what this returned.
create or replace function public.gmail_normalize_list_candidates(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_normalizer_version text,
  p_limit integer,
  p_provider_message_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_rows jsonb;
begin
  if p_normalizer_version !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'invalid normalizer version %', p_normalizer_version
      using errcode = 'invalid_parameter_value';
  end if;

  select coalesce(jsonb_agg(row), '[]'::jsonb) into v_rows
    from (
      select jsonb_build_object(
               'mail_account_id', r.mail_account_id,
               'provider_message_id', r.provider_message_id,
               'provider_thread_id', r.provider_thread_id,
               'internal_date_ms', (extract(epoch from r.internal_date) * 1000)::bigint,
               'label_ids', to_jsonb(r.label_ids),
               'sanitized_payload', r.sanitized_payload,
               'payload_sha256', r.payload_sha256
             ) as row
        from private.gmail_raw_messages r
        left join private.gmail_normalized_messages n
          on n.mail_account_id = r.mail_account_id
         and n.provider_message_id = r.provider_message_id
       where r.mail_account_id = p_mail_account_id
         and r.user_id = p_user_id
         and (p_provider_message_id is null or r.provider_message_id = p_provider_message_id)
         and (
           n.id is null
           or n.source_payload_sha256 is distinct from r.payload_sha256
           or n.normalizer_version is distinct from p_normalizer_version
         )
       order by r.internal_date asc, r.provider_message_id asc
       limit greatest(coalesce(p_limit, 1), 1)
    ) candidates;

  return jsonb_build_object('result', 'ok', 'candidates', v_rows);
end;
$$;

revoke all on function public.gmail_normalize_list_candidates(uuid, uuid, text, integer, text) from public;

-- ---------------------------------------------------------------------------
-- 9b. COMMIT ONE NORMALIZED MESSAGE — atomic, CAS'd against the raw digest
-- ---------------------------------------------------------------------------
-- TS has already done the interpretation work this function refuses to do
-- itself: address parsing, MIME traversal, base64url decoding, charset
-- handling. What TS hands over is DATA, and this function is the sole
-- authority on whether it may become the current projection.
--
-- p_expected_source_payload_sha256 is the digest TS normalized AGAINST. This
-- function re-reads the EXACT CURRENT raw row under a short row lock and
-- refuses to write if the digest has since moved — the same compare-and-swap
-- shape as B02's authorization_revision and B03's lease, applied to the one
-- thing that can change here: the source snapshot itself.
--
-- `provider_sent` and `provider_thread_id` are NOT accepted as parameters.
-- Both are derived, inside this function, from the raw row it just locked —
-- the same reason `commit_thread` never accepted a caller-supplied candidacy
-- boolean: a privacy/provenance-relevant fact is not the caller's to assert.
create or replace function public.gmail_normalize_commit_message(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_provider_message_id text,
  p_expected_source_payload_sha256 text,
  p_normalizer_version text,
  p_headers jsonb,
  p_participants jsonb,
  p_reference_tokens jsonb,
  p_text_parts jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_account public.mail_accounts%rowtype;
  v_raw private.gmail_raw_messages%rowtype;
  v_existing private.gmail_normalized_messages%rowtype;
  v_thread_id uuid;
  v_message_id uuid;
  v_provider_sent boolean;
  v_h jsonb;
  v_expected_count integer;
  v_written_count integer;
begin
  if p_normalizer_version !~ '^[a-z][a-z0-9_]{0,63}$' then
    raise exception 'invalid normalizer version %', p_normalizer_version
      using errcode = 'invalid_parameter_value';
  end if;

  select m.* into v_account
    from public.mail_accounts m
   where m.id = p_mail_account_id and m.user_id = p_user_id;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- DEFENSE IN DEPTH, not the invariant itself: §8's deferred trigger is what
  -- actually makes `deleted` + B04 data unrepresentable. Refusing here just
  -- avoids doing (and then discarding) work against a mailbox already gone.
  if v_account.connection_state = 'deleted' then
    return jsonb_build_object('result', 'account_deleted');
  end if;

  -- THE SHORT LOCK. Held for exactly this statement and everything below it in
  -- this one function call — never across an HTTP round trip, because there is
  -- none inside this function: TS already finished all parsing before calling.
  -- A concurrent second normalizer on this SAME raw row blocks here until this
  -- transaction commits or rolls back; a concurrent B03 raw UPDATE on this row
  -- blocks here too, and its own AFTER UPDATE trigger (§7) is what removes
  -- whatever this function is about to write, the moment that update commits.
  select r.* into v_raw
    from private.gmail_raw_messages r
   where r.mail_account_id = p_mail_account_id
     and r.provider_message_id = p_provider_message_id
     and r.user_id = p_user_id
   for no key update;

  if not found then
    return jsonb_build_object('result', 'source_not_found');
  end if;

  -- THE COMPARE-AND-SWAP. TS normalized against a snapshot; if the raw row has
  -- since moved, TS's parsed structures describe evidence that no longer
  -- exists as "current". Refuse rather than bind a new projection to a digest
  -- nobody asked for — the caller re-fetches and re-normalizes, which is safe
  -- and cheap because B04 does no network I/O.
  if v_raw.payload_sha256 is distinct from p_expected_source_payload_sha256 then
    return jsonb_build_object(
      'result', 'stale_source',
      'current_payload_sha256', v_raw.payload_sha256
    );
  end if;

  -- EXACT REPLAY MUST NOT REWRITE SEMANTIC STATE. If a current projection
  -- already exists for this exact digest and version, this call changes
  -- nothing — not even a timestamp.
  select n.* into v_existing
    from private.gmail_normalized_messages n
   where n.mail_account_id = p_mail_account_id
     and n.provider_message_id = p_provider_message_id;

  if found
     and v_existing.source_payload_sha256 = p_expected_source_payload_sha256
     and v_existing.normalizer_version = p_normalizer_version then
    return jsonb_build_object('result', 'already_current', 'normalized_message_id', v_existing.id);
  end if;

  -- A STALE PROJECTION (different digest already invalidated by §7's trigger
  -- the moment the raw row changed, so ordinarily nothing is here to remove;
  -- a different NORMALIZER VERSION is the one case a row can legitimately
  -- still exist for the CURRENT digest) is replaced by delete-then-insert
  -- rather than update-in-place, so every child table is rebuilt from
  -- scratch and no row from a previous shape can survive alongside a new one.
  if found then
    delete from private.gmail_normalized_messages where id = v_existing.id;
  end if;

  -- THE LITERAL PROVIDER FACT, DERIVED HERE, NOT ACCEPTED FROM THE CALLER.
  v_provider_sent := 'SENT' = any(v_raw.label_ids);

  insert into private.gmail_normalized_threads (user_id, mail_account_id, provider_thread_id)
  values (p_user_id, p_mail_account_id, v_raw.provider_thread_id)
  on conflict (mail_account_id, provider_thread_id) do nothing;

  select t.id into v_thread_id
    from private.gmail_normalized_threads t
   where t.mail_account_id = p_mail_account_id
     and t.provider_thread_id = v_raw.provider_thread_id;

  insert into private.gmail_normalized_messages (
    user_id, mail_account_id, normalized_thread_id, provider_message_id,
    internal_date, provider_sent, source_payload_sha256, normalizer_version
  ) values (
    p_user_id, p_mail_account_id, v_thread_id, p_provider_message_id,
    v_raw.internal_date, v_provider_sent, p_expected_source_payload_sha256, p_normalizer_version
  )
  returning id into v_message_id;

  -- HEADERS, verbatim, in order. A structurally malformed entry (this function
  -- cannot even parse the jsonb shape it was promised) raises and rolls back
  -- the whole message atomically — TS should never produce one, and this is
  -- the fail-closed backstop, not the expected path.
  for v_h in select * from jsonb_array_elements(coalesce(p_headers, '[]'::jsonb))
  loop
    if coalesce(v_h ->> 'header_name', '') = ''
       or (v_h ->> 'occurrence_index') is null
       or (v_h ->> 'global_order') is null
       or (v_h ->> 'raw_value') is null then
      raise exception 'gmail_normalize_commit_message received a malformed header entry'
        using errcode = 'invalid_parameter_value';
    end if;
  end loop;

  insert into private.gmail_normalized_headers
    (normalized_message_id, header_name, occurrence_index, global_order, raw_value)
  select v_message_id, h ->> 'header_name', (h ->> 'occurrence_index')::int,
         (h ->> 'global_order')::int, h ->> 'raw_value'
    from jsonb_array_elements(coalesce(p_headers, '[]'::jsonb)) as h;

  -- PARTICIPANTS, joined back to the header rows just inserted above by exact
  -- (name, occurrence) identity — never a duplicated foreign row id supplied
  -- by the caller. A row count mismatch means a participant named a header
  -- occurrence that does not exist on this message, which is a caller defect
  -- severe enough to fail the whole message.
  select count(*)::int into v_expected_count
    from jsonb_array_elements(coalesce(p_participants, '[]'::jsonb));

  insert into private.gmail_normalized_participants (
    normalized_message_id, source_header_id, header_role, participant_order,
    display_name, addr_spec, local_part, domain, domain_lower, raw_fragment, parse_status
  )
  select v_message_id, h.id, p ->> 'header_role', (p ->> 'participant_order')::int,
         p ->> 'display_name', p ->> 'addr_spec', p ->> 'local_part', p ->> 'domain',
         p ->> 'domain_lower', p ->> 'raw_fragment', p ->> 'parse_status'
    from jsonb_array_elements(coalesce(p_participants, '[]'::jsonb)) as p
    join private.gmail_normalized_headers h
      on h.normalized_message_id = v_message_id
     and h.header_name = p ->> 'source_header_name'
     and h.occurrence_index = (p ->> 'source_header_occurrence_index')::int;

  get diagnostics v_written_count = row_count;
  if v_written_count <> v_expected_count then
    raise exception
      'gmail_normalize_commit_message: % participant(s) named a header occurrence absent from this message (expected %, matched %)',
      v_expected_count - v_written_count, v_expected_count, v_written_count
      using errcode = 'invalid_parameter_value';
  end if;

  select count(*)::int into v_expected_count
    from jsonb_array_elements(coalesce(p_reference_tokens, '[]'::jsonb));

  insert into private.gmail_normalized_reference_tokens (
    normalized_message_id, source_header_id, header_role, token_order, raw_token, parse_status
  )
  select v_message_id, h.id, t ->> 'header_role', (t ->> 'token_order')::int,
         t ->> 'raw_token', t ->> 'parse_status'
    from jsonb_array_elements(coalesce(p_reference_tokens, '[]'::jsonb)) as t
    join private.gmail_normalized_headers h
      on h.normalized_message_id = v_message_id
     and h.header_name = t ->> 'source_header_name'
     and h.occurrence_index = (t ->> 'source_header_occurrence_index')::int;

  get diagnostics v_written_count = row_count;
  if v_written_count <> v_expected_count then
    raise exception
      'gmail_normalize_commit_message: % reference token(s) named a header occurrence absent from this message (expected %, matched %)',
      v_expected_count - v_written_count, v_expected_count, v_written_count
      using errcode = 'invalid_parameter_value';
  end if;

  insert into private.gmail_normalized_text_parts (
    normalized_message_id, part_path, mime_type, content_type_values,
    content_disposition_values, content_transfer_encoding_values, declared_charset,
    charset_source, body_data_present, b03_omitted, b03_omission_reason,
    decode_status, decoded_text
  )
  select
    v_message_id,
    coalesce(
      (select array_agg(value::int) from jsonb_array_elements_text(tp -> 'part_path')),
      '{}'::int[]
    ),
    tp ->> 'mime_type',
    coalesce(
      (select array_agg(value::text) from jsonb_array_elements_text(tp -> 'content_type_values')),
      '{}'::text[]),
    coalesce(
      (select array_agg(value::text) from jsonb_array_elements_text(tp -> 'content_disposition_values')),
      '{}'::text[]),
    coalesce(
      (select array_agg(value::text) from jsonb_array_elements_text(tp -> 'content_transfer_encoding_values')),
      '{}'::text[]),
    tp ->> 'declared_charset',
    tp ->> 'charset_source',
    (tp ->> 'body_data_present')::boolean,
    coalesce((tp ->> 'b03_omitted')::boolean, false),
    tp ->> 'b03_omission_reason',
    tp ->> 'decode_status',
    tp ->> 'decoded_text'
    from jsonb_array_elements(coalesce(p_text_parts, '[]'::jsonb)) as tp;

  return jsonb_build_object(
    'result', 'ok',
    'normalized_message_id', v_message_id,
    'normalized_thread_id', v_thread_id
  );
end;
$$;

revoke all on function public.gmail_normalize_commit_message(
  uuid, uuid, text, text, text, jsonb, jsonb, jsonb, jsonb
) from public;

-- ---------------------------------------------------------------------------
-- 9c. STATUS — counts only, never content
-- ---------------------------------------------------------------------------
create or replace function public.gmail_normalize_status(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_normalizer_version text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_threads integer;
  v_messages integer;
  v_headers integer;
  v_participants integer;
  v_reference_tokens integer;
  v_text_parts integer;
  v_stale integer;
  v_raw_total integer;
begin
  perform 1 from public.mail_accounts where id = p_mail_account_id and user_id = p_user_id;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  select count(*)::int into v_threads
    from private.gmail_normalized_threads where mail_account_id = p_mail_account_id;

  select count(*)::int into v_messages
    from private.gmail_normalized_messages where mail_account_id = p_mail_account_id;

  select count(*)::int into v_headers
    from private.gmail_normalized_headers h
    join private.gmail_normalized_messages m on m.id = h.normalized_message_id
   where m.mail_account_id = p_mail_account_id;

  select count(*)::int into v_participants
    from private.gmail_normalized_participants p
    join private.gmail_normalized_messages m on m.id = p.normalized_message_id
   where m.mail_account_id = p_mail_account_id;

  select count(*)::int into v_reference_tokens
    from private.gmail_normalized_reference_tokens t
    join private.gmail_normalized_messages m on m.id = t.normalized_message_id
   where m.mail_account_id = p_mail_account_id;

  select count(*)::int into v_text_parts
    from private.gmail_normalized_text_parts tp
    join private.gmail_normalized_messages m on m.id = tp.normalized_message_id
   where m.mail_account_id = p_mail_account_id;

  select count(*)::int into v_raw_total
    from private.gmail_raw_messages where mail_account_id = p_mail_account_id;

  select count(*)::int into v_stale
    from private.gmail_raw_messages r
    left join private.gmail_normalized_messages n
      on n.mail_account_id = r.mail_account_id
     and n.provider_message_id = r.provider_message_id
   where r.mail_account_id = p_mail_account_id
     and (
       n.id is null
       or n.source_payload_sha256 is distinct from r.payload_sha256
       or n.normalizer_version is distinct from p_normalizer_version
     );

  return jsonb_build_object(
    'result', 'ok',
    'raw_messages', v_raw_total,
    'normalized_threads', v_threads,
    'normalized_messages', v_messages,
    'header_occurrences', v_headers,
    'participants', v_participants,
    'reference_tokens', v_reference_tokens,
    'text_parts', v_text_parts,
    'stale_or_missing_projections', v_stale
  );
end;
$$;

revoke all on function public.gmail_normalize_status(uuid, uuid, text) from public;

-- ---------------------------------------------------------------------------
-- 9d. DELETION — B04's own purge, choreographed alongside B03's
-- ---------------------------------------------------------------------------
-- Mirrors `gmail_historical_import_purge_for_deletion` exactly: only while a
-- deletion is actually running, only for the request the mailbox is actually
-- waiting on, only for a scope that actually includes Gmail data. B03's purge
-- function in 0037 is NOT modified — this is B04's OWN function, and a
-- deletion orchestrator calls both. Deleting the thread rows is sufficient;
-- every message/header/participant/reference-token/text-part cascades.
create or replace function public.gmail_normalize_purge_for_deletion(
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
  v_threads integer;
begin
  select m.* into v_account
    from public.mail_accounts m
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

  select r.* into v_request
    from public.mail_account_deletion_requests r
   where r.id = p_deletion_request_id;

  if not found
     or v_request.mail_account_id <> p_mail_account_id
     or v_request.user_id <> p_user_id then
    return jsonb_build_object('result', 'stale_deletion_request');
  end if;

  if v_request.status not in ('requested', 'in_progress') then
    return jsonb_build_object('result', 'request_not_running', 'status', v_request.status);
  end if;

  if v_request.scope not in ('gmail_derived_data', 'account_and_gmail_derived_data') then
    return jsonb_build_object('result', 'scope_excludes_gmail_data', 'scope', v_request.scope);
  end if;

  with removed as (
    delete from private.gmail_normalized_threads t
     where t.mail_account_id = p_mail_account_id returning 1
  ) select count(*)::int into v_threads from removed;

  return jsonb_build_object('result', 'ok', 'normalized_threads_removed', v_threads);
end;
$$;

revoke all on function public.gmail_normalize_purge_for_deletion(uuid, uuid, uuid) from public;

-- ===========================================================================
-- 10. EXECUTE PRIVILEGES — service_role AND NOBODY ELSE
-- ===========================================================================
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.gmail_normalize_list_candidates(uuid,uuid,text,integer,text)',
    'public.gmail_normalize_commit_message(uuid,uuid,text,text,text,jsonb,jsonb,jsonb,jsonb)',
    'public.gmail_normalize_status(uuid,uuid,text)',
    'public.gmail_normalize_purge_for_deletion(uuid,uuid,uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- ===========================================================================
-- 11. WHAT 0038 DOES NOT CREATE
-- ===========================================================================
-- No outreach detection, hotel match or canonical hotel write — B05.
-- No sent/reply/timing fact, no parent/child message relationship,
--   no reply_received, no reply_delay, no ghosted/negotiation/outcome state — B06/B07.
-- No history cursor, watch subscription or incremental sync state — B08.
-- No network-intelligence eligibility, aggregate or contribution flag.
-- No attachment table, and no column that could hold attachment bytes.
-- No client-readable view of normalized Gmail content, for any role.
-- No creator-facing or admin-facing Gmail UI of any kind.
--
-- And this migration performs no normalization itself: it creates no
-- normalized thread, message, header, participant, reference token or text
-- part. Every row above is written later, by the application, one message at
-- a time, through `gmail_normalize_commit_message`.
