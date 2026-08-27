-- ===========================================================================
-- 0035 — MAIL ACCOUNT, CONSENT AND THE PRIVATE COMMUNICATION BOUNDARY (B01)
-- ===========================================================================
-- Phase A closed the canonical property spine: A05 can turn an authorized D062
-- PASS into a canonical hotel. Phase B opens a different kind of data entirely.
--
-- A creator's mailbox is not provider inventory. It is PRIVATE COMMUNICATION,
-- most of it about people and businesses who never agreed to anything with us,
-- and under Google's restricted-scope rules the obligations attach to the data
-- itself — including to everything derived from it. So this migration is the
-- BOUNDARY, written before a single message exists:
--
--   * who owns a connected mailbox, and who may see that it exists;
--   * what the human actually consented to, recorded as immutable history;
--   * whether that consent is still in force right now;
--   * the difference between DISCONNECTING a mailbox and DELETING its data;
--   * a provenance spine every future Gmail-derived row must hang from, so
--     deletion is always addressable.
--
-- WHAT THIS MIGRATION DOES NOT ADD, deliberately:
--   No messages. No threads. No attachments. No sync/history/job tables. No
--   OAuth callback tables. No classifications. No aggregates. And, above all,
--   NO CREDENTIAL MATERIAL — no access token, no refresh token, no client
--   secret. B02 implements the connection; §8 below is the contract it inherits.
--
-- MIGRATIONS DO NOT ENROL ANYONE. This file creates structure only: it connects
-- no mailbox, infers no consent, enrols no user and stores no token.

-- ===========================================================================
-- 1. THE CONNECTED MAILBOX
-- ===========================================================================
-- G0 in the boundary contract: account and authorization METADATA. It says a
-- mailbox is connected and in what state; it holds no message content and no
-- credential.
create table public.mail_accounts (
  id uuid primary key default gen_random_uuid(),

  -- THE OWNER. Cascade, because deleting a user must take their private
  -- communication plane with it — a mailbox that outlives its owner is exactly
  -- the row a deletion request is supposed to be able to reach.
  --
  -- One user may own MANY mailboxes (a creator legitimately runs a personal and
  -- a business address). The reverse is not true; see the unique below.
  user_id uuid not null references public.users(id) on delete cascade,

  -- V1 vocabulary is Gmail alone. A second provider is a contract, not a value:
  -- the scope allow-list below is Google's, and it would be silently wrong for
  -- Outlook.
  provider text not null check (provider in ('gmail')),

  -- THE DURABLE PROVIDER IDENTITY — Google's stable subject (`sub`), not the
  -- address. An email address is a display and routing identifier: it can be
  -- renamed, aliased, or reassigned to a different human, and treating it as the
  -- key would eventually attach one person's mailbox history to another's.
  provider_account_subject text not null check (length(btrim(provider_account_subject)) > 0),
  -- Display/routing only. Nullable because the future OAuth flow may learn the
  -- subject before the address, and NULL is honest about not knowing yet.
  email_address citext,

  -- THE STATE MACHINE B02 needs, and nothing more.
  --
  --   pending_authorization  a connection was started; the human has not yet
  --                          completed Google's consent screen. No access.
  --   connected              provider access is expected to work, and the
  --                          private-processing consent below is granted.
  --   reauth_required        access failed in a way only the human can fix
  --                          (revoked at Google, password change, scope change).
  --                          Not an error state: the mailbox is still theirs.
  --   disconnected           provider access has been stopped deliberately.
  --                          Stored data may still exist — see §4.
  --   deletion_pending       disconnected AND a deletion of stored data has been
  --                          requested and is not finished.
  --   deleted                the deletion request completed.
  --
  -- `connected` is a statement about AUTHORIZATION, never about a token. No
  -- token lives in this table (§8).
  connection_state text not null default 'pending_authorization'
    check (connection_state in
      ('pending_authorization', 'connected', 'reauth_required',
       'disconnected', 'deletion_pending', 'deleted')),

  -- The scopes Google actually granted, as METADATA. Recorded separately from
  -- any credential material precisely so the product can answer "what may we do
  -- with this mailbox?" without touching a secret store.
  --
  -- The allow-list IS the scope contract, in the database. `gmail.readonly` is
  -- restricted and is what historical analysis requires; `gmail.send` is
  -- sensitive and is requested LATER, through incremental authorization, when a
  -- human activates a feature that sends mail. Everything else Google offers —
  -- `gmail.modify`, `gmail.compose`, `gmail.insert`, `mail.google.com`, the
  -- settings scopes — is refused here, so "we added a broader scope for
  -- convenience" is not something a future writer can do quietly.
  granted_scopes text[] not null default '{}'
    constraint mail_accounts_scope_allowlist check (
      granted_scopes <@ array[
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
        'openid',
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile'
      ]::text[]
    ),

  connected_at timestamptz,
  disconnected_at timestamptz,
  last_state_change_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- ONE PROVIDER ACCOUNT, ONE OWNING APP USER. Without this, two app users could
  -- both claim the same Google account and each would appear to own its history.
  -- Shared-inbox ownership and agency delegation are deliberately future work
  -- and will need explicit authorization, not a second row.
  constraint mail_accounts_provider_account_uk unique (provider, provider_account_subject),

  -- THE PROVENANCE SPINE. Every future Gmail-origin or Gmail-derived table
  -- composite-FKs `(mail_account_id, owner_user_id)` against this pair, so no
  -- such row can ever lose the account and the owner it must be deleted with.
  -- See §7.
  constraint mail_accounts_id_user_uk unique (id, user_id),

  -- A connection that claims to work must say when it started and what it may
  -- do. An empty scope set with `connected` would be a mailbox we believe we can
  -- read while holding permission to read nothing.
  constraint mail_accounts_connected_shape check (
    connection_state <> 'connected'
    or (connected_at is not null and cardinality(granted_scopes) > 0)
  ),

  -- ACCESS HAS STOPPED, and the row says so rather than merely implying it.
  -- Emptying `granted_scopes` is the metadata half of revocation; B02 revokes at
  -- Google and destroys the credential, and neither substitutes for the other.
  constraint mail_accounts_disconnected_shape check (
    connection_state not in ('disconnected', 'deletion_pending', 'deleted')
    or (disconnected_at is not null and cardinality(granted_scopes) = 0)
  )
);

create index mail_accounts_user_idx on public.mail_accounts (user_id, connection_state);

create trigger mail_accounts_set_updated_at
  before update on public.mail_accounts
  for each row execute function public.set_updated_at();

comment on table public.mail_accounts is
  'B01 G0: a connected mailbox as ACCOUNT METADATA. Private communication plane — never editorial data, never network-visible, and it holds no OAuth credential. See B01_GMAIL_DATA_BOUNDARY_CONTRACT.md.';
comment on column public.mail_accounts.provider_account_subject is
  'The provider''s stable account subject. The durable identity; email_address is display/routing only and may change owner.';
comment on column public.mail_accounts.granted_scopes is
  'Scope METADATA, never credential material. Constrained to the approved allow-list: gmail.readonly (restricted) and, later and incrementally, gmail.send (sensitive).';

-- ===========================================================================
-- 2. WHAT THE HUMAN ACTUALLY CONSENTED TO — IMMUTABLE
-- ===========================================================================
-- Connecting a mailbox and contributing to shared intelligence are two
-- different permissions, and collapsing them is the failure this table exists
-- to prevent. A blanket "connect Gmail" must never be read as agreement that a
-- creator's activity may inform other creators' products.
--
-- Following 0032/0033/0034: the DECISION is immutable history and the CURRENT
-- state is a separate projection. A withdrawal is a NEW event, never an edit of
-- the record of what was once agreed.
create table public.mail_account_consent_receipts (
  id uuid primary key default gen_random_uuid(),

  mail_account_id uuid not null,
  -- Denormalised and CONSTRAINED to the account's own owner by the composite FK
  -- below, so a receipt can never be attributed to the wrong person.
  user_id uuid not null,

  -- THE TWO PERMISSIONS.
  --
  --   private_gmail_processing
  --     "process my Gmail data to provide MY OWN creator workflow and
  --      intelligence." Required for the product to do anything at all.
  --
  --   network_intelligence_contribution
  --     "let eligible privacy-safe derived signals from my activity contribute
  --      to aggregated intelligence features." OPTIONAL, SEPARATE, EXPLICIT,
  --      REVOCABLE, and DEFAULT NOT GRANTED — the absence of a receipt is not
  --      consent, which is why nothing here defaults to `granted`.
  consent_kind text not null
    check (consent_kind in ('private_gmail_processing', 'network_intelligence_contribution')),

  decision text not null check (decision in ('granted', 'withdrawn')),

  -- WHAT THE HUMAN WAS SHOWN. A consent record that cannot reproduce the text
  -- agreed to is an assertion, not evidence; and a policy version alone does not
  -- prove which words were on the screen.
  policy_version text not null check (length(btrim(policy_version)) > 0),
  consent_text_digest text not null check (consent_text_digest ~ '^[0-9a-f]{64}$'),
  consent_text_digest_algorithm text not null default 'sha256'
    check (consent_text_digest_algorithm = 'sha256'),

  -- The scopes in force when the human decided. A consent given against
  -- read-only access is not consent to a later, wider grant.
  granted_scopes_at_decision text[] not null default '{}',

  -- WHO ACTED. In B01 this must be the owner: there is no agency delegation, no
  -- staff-acting-for-user, and no server deciding on a human's behalf. Widening
  -- this is a contract, and the CHECK is what makes that explicit.
  -- Cascade for the same reason the owner does: in B01 this IS the owner (the
  -- CHECK below says so), so deleting that human must take the record with it
  -- rather than blocking their deletion.
  decided_by_user_id uuid not null references public.users(id) on delete cascade,
  decided_at timestamptz not null,

  receipt_digest text not null check (receipt_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),

  constraint mail_account_consent_receipts_self_decided
    check (decided_by_user_id = user_id),

  -- The receipt belongs to THIS account AND to that account's own owner.
  constraint mail_account_consent_receipts_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  -- Reference targets so the CURRENT projection in §3 can be composite-FK'd to a
  -- receipt that agrees with it on every field that matters. `id` is already the
  -- primary key, so these add targets and no restriction.
  constraint mail_account_consent_receipts_projection_uk
    unique (id, mail_account_id, consent_kind, decision)
);

create index mail_account_consent_receipts_account_idx
  on public.mail_account_consent_receipts (mail_account_id, consent_kind, decided_at desc);
create index mail_account_consent_receipts_user_idx
  on public.mail_account_consent_receipts (user_id);

comment on table public.mail_account_consent_receipts is
  'B01: APPEND-ONLY history of what a human consented to about their mailbox. A withdrawal is a new receipt; the record of what was once agreed is never edited.';

-- ---------------------------------------------------------------------------
-- APPEND-ONLY BY TRIGGER (the grants in §6 are the first layer)
-- ---------------------------------------------------------------------------
create or replace function public.forbid_mail_consent_receipt_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    '% on % is refused: a mail-account consent receipt is APPEND-ONLY. Withdrawing consent is a NEW receipt; editing this one would change what a human is recorded as having agreed to at a moment that has passed.',
    tg_op, tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

revoke all on function public.forbid_mail_consent_receipt_mutation() from public;

-- DELETE is deliberately absent from the trigger: the row is removed only by the
-- cascade from its account or its user, which is the deletion path itself. What
-- is forbidden is EDITING history, and deleting one receipt while its siblings
-- remain.
create trigger mail_account_consent_receipts_append_only
  before update on public.mail_account_consent_receipts
  for each row execute function public.forbid_mail_consent_receipt_mutation();

create or replace function public.forbid_mail_consent_receipt_delete()
returns trigger
language plpgsql
as $$
begin
  -- A cascade from the account or the user is the deletion path and is allowed;
  -- `pg_trigger_depth() > 1` is true exactly when this DELETE was caused by
  -- another table's referential action rather than issued directly.
  if pg_trigger_depth() > 1 then
    return old;
  end if;
  raise exception
    'DELETE on % is refused: consent history is removed only by deleting the mailbox or the user it belongs to. Deleting one receipt would leave a consent record that disagrees with the decisions that produced it.',
    tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

revoke all on function public.forbid_mail_consent_receipt_delete() from public;

create trigger mail_account_consent_receipts_no_direct_delete
  before delete on public.mail_account_consent_receipts
  for each row execute function public.forbid_mail_consent_receipt_delete();

-- ===========================================================================
-- 3. THE CURRENT CONSENT — A PROJECTION, NOT HISTORY
-- ===========================================================================
-- One row per (mailbox, permission), naming the receipt it currently represents.
-- Reading current state must never require replaying history, and history must
-- never be rewritten to change current state.
create table public.mail_account_consents (
  id uuid primary key default gen_random_uuid(),

  mail_account_id uuid not null,
  user_id uuid not null,
  consent_kind text not null
    check (consent_kind in ('private_gmail_processing', 'network_intelligence_contribution')),

  state text not null check (state in ('granted', 'withdrawn')),
  current_receipt_id uuid not null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- ONE current answer per permission per mailbox.
  constraint mail_account_consents_account_kind_uk unique (mail_account_id, consent_kind),

  constraint mail_account_consents_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  -- THE PROJECTION AND ITS RECEIPT CANNOT DISAGREE, and this is declarative
  -- rather than a trigger because it can be: the pointed receipt must belong to
  -- the SAME mailbox, describe the SAME permission, and record the SAME
  -- decision. A projection that says `granted` while naming a withdrawal receipt
  -- is unrepresentable, not merely unlikely.
  --
  -- RESTRICT, not CASCADE: the receipt a projection currently represents cannot
  -- be removed out from under it.
  constraint mail_account_consents_receipt_fk
    foreign key (current_receipt_id, mail_account_id, consent_kind, state)
    references public.mail_account_consent_receipts (id, mail_account_id, consent_kind, decision)
    on delete restrict
);

create index mail_account_consents_user_idx on public.mail_account_consents (user_id);

create trigger mail_account_consents_set_updated_at
  before update on public.mail_account_consents
  for each row execute function public.set_updated_at();

comment on table public.mail_account_consents is
  'B01: the CURRENT answer to "may we do this with this mailbox?", per permission. Composite-FK''d to the receipt it represents, so projection and history cannot disagree. ABSENCE MEANS NOT GRANTED.';

-- ---------------------------------------------------------------------------
-- THE ONE PLACE THAT ANSWERS "MAY WE?"
-- ---------------------------------------------------------------------------
-- Absence of a row means NOT GRANTED, and this function is what makes every
-- future caller say so the same way. A second reading of "no row" is how a
-- default-false permission becomes accidentally true.
create or replace function public.mail_account_has_consent(
  account_id uuid,
  kind text
)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from public.mail_account_consents c
     where c.mail_account_id = account_id
       and c.consent_kind = kind
       and c.state = 'granted'
  );
$$;

comment on function public.mail_account_has_consent(uuid, text) is
  'The single definition of "this mailbox currently permits this". NO ROW = NOT GRANTED; the absence of a consent receipt is never consent.';

-- ===========================================================================
-- 4. DISCONNECT IS NOT DELETE
-- ===========================================================================
-- Two different things a human can ask for, and conflating them is how a
-- product tells someone their data is gone when it is not:
--
--   DISCONNECT  provider access stops, credentials stop being usable, no
--               future sync. STORED DATA MAY REMAIN — a creator may
--               legitimately want to keep the workspace history they already
--               built.
--
--   DELETE      the stored Gmail-origin content and Gmail-derived facts are
--               removed, and any contribution rows become ineligible for future
--               network rebuilds.
--
-- The database must be able to REPRESENT the difference even though no UX
-- exists yet. A disconnected mailbox with no deletion request is the first case;
-- a request row is the second.
create table public.mail_account_deletion_requests (
  id uuid primary key default gen_random_uuid(),

  mail_account_id uuid not null,
  user_id uuid not null,

  -- HOW MUCH is being deleted. Stated explicitly because "delete my data" means
  -- different things to different people, and the answer must be recorded at
  -- request time rather than decided later by whoever runs the job.
  --
  --   gmail_derived_data              remove Gmail-origin content and derived
  --                                   facts; keep the account record so the
  --                                   history of the connection remains auditable
  --   account_and_gmail_derived_data  the above, and retire the mailbox record
  --                                   itself (`connection_state = 'deleted'`)
  scope text not null
    check (scope in ('gmail_derived_data', 'account_and_gmail_derived_data')),

  requested_by_user_id uuid not null references public.users(id) on delete cascade,
  requested_at timestamptz not null,

  status text not null default 'requested'
    check (status in ('requested', 'in_progress', 'completed', 'failed')),
  completed_at timestamptz,
  failure_reason text,

  -- FUTURE NETWORK AGGREGATES MUST BE REBUILDABLE WITHOUT THIS ACCOUNT. Recording
  -- when contributions were marked ineligible is what lets a later phase prove
  -- the withdrawal actually reached the aggregate layer, instead of assuming it.
  -- NULL until that step runs; B01 produces no aggregates for it to reach.
  network_contributions_invalidated_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Only the owner may ask. No staff-initiated deletion path exists in B01, and
  -- the CHECK is what stops one appearing by accident.
  constraint mail_account_deletion_requests_self_requested
    check (requested_by_user_id = user_id),

  constraint mail_account_deletion_requests_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  -- A finished request must say when, and a failed one must say why. "Completed"
  -- with no completion time is the shape that lets a deletion silently not
  -- happen.
  constraint mail_account_deletion_requests_terminal_shape check (
    (status <> 'completed' or completed_at is not null)
    and (status <> 'failed' or (failure_reason is not null and length(btrim(failure_reason)) > 0))
    and (status in ('completed', 'failed') or completed_at is null)
  )
);

-- ONE open request per mailbox. Two concurrent deletions of the same data is not
-- a second decision, it is a race.
create unique index mail_account_deletion_requests_open_uidx
  on public.mail_account_deletion_requests (mail_account_id)
  where status in ('requested', 'in_progress');

create index mail_account_deletion_requests_user_idx
  on public.mail_account_deletion_requests (user_id, status);

create trigger mail_account_deletion_requests_set_updated_at
  before update on public.mail_account_deletion_requests
  for each row execute function public.set_updated_at();

comment on table public.mail_account_deletion_requests is
  'B01: an explicit request to DELETE stored Gmail data, which is a different act from disconnecting. Owner-initiated only; B01 implements no execution.';

-- ===========================================================================
-- 5. THE STATES MUST MEAN WHAT THEY SAY
-- ===========================================================================
-- Three cross-row rules, deferred to COMMIT because the legitimate write orders
-- pass through intermediate states — a connection inserts the account and its
-- consent in one transaction, and a deletion moves the request and the account
-- together. An immediate check would make the correct path impossible; what must
-- be coherent is the state that survives COMMIT.
--
-- Registered on BOTH write origins, for the reason A04.6 and A05 established: an
-- invariant enforced from one side can be broken from the other.
create or replace function public.assert_mail_account_state_coherent()
returns trigger
language plpgsql
as $$
declare
  account_id uuid;
  account record;
  open_requests integer;
  completed_requests integer;
begin
  if tg_table_name = 'mail_accounts' then
    account_id := new.id;
  else
    account_id := new.mail_account_id;
  end if;

  -- FINAL state, read now rather than trusting the row image queued when this
  -- trigger fired: by commit time either side may have moved again.
  select m.connection_state, m.user_id into account
    from public.mail_accounts m where m.id = account_id;

  if account.connection_state is null then
    -- The mailbox was deleted in this transaction; the children cascaded with
    -- it, and there is nothing left to be coherent with.
    return null;
  end if;

  -- 1. NO PROCESSING WITHOUT CONSENT. A `connected` mailbox is one the product
  --    is entitled to process, so the private-processing permission must
  --    actually be granted. Without this, "connected" would mean "we hold
  --    access" rather than "we were permitted".
  if account.connection_state = 'connected'
     and not public.mail_account_has_consent(account_id, 'private_gmail_processing') then
    raise exception
      'mail account % cannot be `connected` without a granted private_gmail_processing consent. Connecting a mailbox is not the same act as being permitted to process it, and the absence of a consent receipt is never consent.',
      account_id
      using errcode = 'integrity_constraint_violation';
  end if;

  select count(*) filter (where status in ('requested', 'in_progress')),
         count(*) filter (where status = 'completed')
    into open_requests, completed_requests
    from public.mail_account_deletion_requests r
   where r.mail_account_id = account_id;

  -- 2. `deletion_pending` MEANS a deletion is genuinely outstanding. A state
  --    that merely looks like work in progress, with no request behind it, is a
  --    promise to the user that nothing is keeping.
  if account.connection_state = 'deletion_pending' and open_requests = 0 then
    raise exception
      'mail account % is `deletion_pending` with no outstanding deletion request. The state claims work is under way that nothing recorded asked for.',
      account_id
      using errcode = 'integrity_constraint_violation';
  end if;

  -- 3. `deleted` MEANS a deletion actually completed. This is the difference
  --    between telling a human their data is gone and being able to show it.
  if account.connection_state = 'deleted' and completed_requests = 0 then
    raise exception
      'mail account % is `deleted` with no COMPLETED deletion request. Disconnecting is not deleting, and a state label is not evidence that data was removed.',
      account_id
      using errcode = 'integrity_constraint_violation';
  end if;

  return null;
end;
$$;

revoke all on function public.assert_mail_account_state_coherent() from public;

create constraint trigger mail_accounts_state_coherent
  after insert or update on public.mail_accounts
  deferrable initially deferred
  for each row execute function public.assert_mail_account_state_coherent();

create constraint trigger mail_account_consents_state_coherent
  after insert or update on public.mail_account_consents
  deferrable initially deferred
  for each row execute function public.assert_mail_account_state_coherent();

create constraint trigger mail_account_deletion_requests_state_coherent
  after insert or update on public.mail_account_deletion_requests
  deferrable initially deferred
  for each row execute function public.assert_mail_account_state_coherent();

-- ===========================================================================
-- 6. RLS AND GRANTS — THE PRIVATE COMMUNICATION PLANE
-- ===========================================================================
-- This posture is DELIBERATELY DIFFERENT from every table in 0027–0034, and the
-- difference is the point.
--
-- Provider source evidence is editorial internals: admin/editor read it through
-- `public.is_admin_or_editor()` because reviewing hotel data is their job. A
-- creator's mailbox is not their job. Holding an internal role is not a reason
-- to read someone's private correspondence, so `is_admin_or_editor()` appears
-- NOWHERE below.
--
--   OWNER            reads their own mailbox metadata, consent state and
--                    deletion status. Reading is all a client does here: the
--                    rows are written by the server after Google's consent
--                    screen, not typed by a browser.
--   OTHER CREATOR    nothing.
--   ADMIN / EDITOR   nothing, through a client session. Staff access to private
--                    communication requires a separately contracted, audited
--                    mechanism that B01 does not implement.
--   ANON             nothing. Not "no rows" — no privilege at all.
--   SERVICE ROLE     the trusted server path. A capability, never a user-facing
--                    permission.
alter table public.mail_accounts enable row level security;
alter table public.mail_account_consent_receipts enable row level security;
alter table public.mail_account_consents enable row level security;
alter table public.mail_account_deletion_requests enable row level security;

create policy mail_accounts_select_own on public.mail_accounts
  for select using (user_id = auth.uid());
create policy mail_account_consent_receipts_select_own on public.mail_account_consent_receipts
  for select using (user_id = auth.uid());
create policy mail_account_consents_select_own on public.mail_account_consents
  for select using (user_id = auth.uid());
create policy mail_account_deletion_requests_select_own on public.mail_account_deletion_requests
  for select using (user_id = auth.uid());

-- 0024 revoked client privileges on future objects by default, so these grants
-- are the entire client surface. SELECT only: every write is a server action
-- behind an OAuth flow or a deletion job, and neither is something a browser
-- should be able to assert directly.
grant select on
  public.mail_accounts,
  public.mail_account_consent_receipts,
  public.mail_account_consents,
  public.mail_account_deletion_requests
to authenticated;

-- No anon grant of any kind.

grant select, insert, update, delete on
  public.mail_accounts,
  public.mail_account_consents,
  public.mail_account_deletion_requests
to service_role;

-- Append-only: not even the trusted role holds UPDATE or DELETE on consent
-- history. The trigger in §2 is the second layer, not the only one.
grant select, insert on public.mail_account_consent_receipts to service_role;
