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
-- 0. THE SCOPE VOCABULARY — ONE DEFINITION, USED EVERYWHERE
-- ===========================================================================
-- Two places have to agree about Google scopes: what a mailbox currently holds,
-- and what a consent receipt says the human was told they were agreeing to. If
-- each carries its own copy of the allow-list, the two drift and the receipt
-- stops being evidence about the account. So the allow-list is a function, and
-- both CHECKs call it.
create or replace function public.approved_gmail_scopes()
returns text[]
language sql
immutable
as $$
  select array[
    -- RESTRICTED. Historical analysis needs message bodies; `gmail.metadata`
    -- cannot return them and cannot be searched with `q`, so it is not a
    -- lighter-touch substitute — it is a different, insufficient capability.
    'https://www.googleapis.com/auth/gmail.readonly',
    -- SENSITIVE, and requested LATER through incremental authorization, only
    -- when a human activates a feature that sends mail on their behalf.
    'https://www.googleapis.com/auth/gmail.send',
    -- Sign-in identity. Not mailbox access.
    'openid',
    'https://www.googleapis.com/auth/userinfo.email',
    'https://www.googleapis.com/auth/userinfo.profile'
  ]::text[];
$$;

comment on function public.approved_gmail_scopes() is
  'B01: the ONLY definition of the Google scopes this product may hold. Everything broader — gmail.modify, gmail.compose, gmail.insert, mail.google.com, the settings scopes — is absent deliberately.';

-- Scopes are a SET. Google may return them in any order, may repeat one, and a
-- writer may assemble them from several places. Comparing `text[]` with `=` is
-- order-sensitive and duplicate-sensitive, so every scope array in this schema
-- is normalised on write to sorted-distinct form and compared as stored. That is
-- what makes "the receipt's snapshot equals the account's scopes" a set equality
-- rather than an accident of ordering.
create or replace function public.canonical_scope_set(value text[])
returns text[]
language sql
immutable
as $$
  select coalesce(
    (select array_agg(s order by s)
       from (select distinct btrim(x) as s
               from unnest(coalesce(value, '{}'::text[])) as x
              where btrim(coalesce(x, '')) <> '') d),
    '{}'::text[]
  );
$$;

comment on function public.canonical_scope_set(text[]) is
  'B01: normalises a scope array to sorted-distinct form so scope sets can be compared with `=`. Applied on write to mail_accounts.granted_scopes and to consent receipt snapshots.';

create or replace function public.normalize_gmail_scope_column()
returns trigger
language plpgsql
as $$
begin
  if tg_argv[0] = 'granted_scopes' then
    new.granted_scopes := public.canonical_scope_set(new.granted_scopes);
  else
    new.granted_scopes_at_decision := public.canonical_scope_set(new.granted_scopes_at_decision);
  end if;
  return new;
end;
$$;

revoke all on function public.normalize_gmail_scope_column() from public;

-- ===========================================================================
-- 1. THE CONNECTED MAILBOX
-- ===========================================================================
-- G0 in the boundary contract: account and authorization METADATA. It says a
-- mailbox is connected and in what state; it holds no message content and no
-- credential.
--
-- ---------------------------------------------------------------------------
-- 1a. WHO OWNS A DURABLE PROVIDER ACCOUNT
-- ---------------------------------------------------------------------------
-- `(provider, provider_account_subject)` is the durable identity of a real
-- Google account. The contract is that it has EXACTLY ONE owning app user:
-- shared inboxes, agency delegation and cross-tenant transfer are all future
-- work needing explicit authorization, not a second row.
--
-- Stating that as a unique constraint on `mail_accounts` alone cannot work, and
-- the reason is worth writing down because getting it wrong is what this
-- registry exists to fix:
--
--   * A FULL unique index on (provider, provider_account_subject) forbids
--     same-owner reconnection. A creator who deletes their Gmail data and later
--     reconnects the same account must get a NEW row, because the old one is
--     `deleted` and terminal — a full index would make deletion mean "you may
--     never reconnect this address".
--   * A PARTIAL unique index over live rows only allows that reconnection, but
--     it stops seeing retired rows entirely. User A retires their mailbox, and
--     user B can then claim the same Google account, while A's consent receipts,
--     consent projections and deletion requests are all still on file, owned by
--     A. One durable provider identity, two app owners.
--
-- So ownership lives in its own table, keyed by the durable identity, and every
-- mail account — live or retired — must agree with it:
--
--   registry PK              one owner per durable provider identity, and the
--                            SERIALIZATION POINT: two transactions racing to
--                            claim a previously unseen subject contend on this
--                            index, so exactly one can win. No trigger that
--                            merely reads before writing could promise that.
--   mail_accounts FK         (provider, subject, user_id) must match the
--                            registry's (provider, subject, owner_user_id).
--                            Declarative: a mail account owned by anyone else is
--                            unrepresentable rather than merely refused.
--
-- The reservation is released ONLY when the owning user is erased (see the
-- cascade below), because a reservation that outlived its user would ban a
-- Google account forever with nothing left in the product to protect.
create table public.mail_provider_account_owners (
  provider text not null check (provider in ('gmail')),
  provider_account_subject text not null check (length(btrim(provider_account_subject)) > 0),

  -- Cascade for the same reason the mailbox does: when a user is erased their
  -- entire private communication plane goes, and nothing about them should
  -- remain to keep a Google account reserved. After that erasure a different,
  -- genuinely authenticated human may connect that account as a new identity —
  -- there is no longer any of A's private history for them to inherit.
  owner_user_id uuid not null references public.users(id) on delete cascade,

  first_claimed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint mail_provider_account_owners_pkey
    primary key (provider, provider_account_subject),

  -- Reference target for the mail_accounts FK below. The primary key already
  -- makes this unique, so it adds a target and no restriction.
  constraint mail_provider_account_owners_owner_uk
    unique (provider, provider_account_subject, owner_user_id)
);

create index mail_provider_account_owners_user_idx
  on public.mail_provider_account_owners (owner_user_id);

comment on table public.mail_provider_account_owners is
  'B01: which app user owns a durable provider account identity. One owner per (provider, provider_account_subject), for as long as ANY of that identity''s mail-account history exists. Released only by erasing the owner.';

-- A reservation is created and released, never edited. Editing `owner_user_id`
-- would BE the cross-tenant transfer this table exists to prevent, performed in
-- one statement; if the product ever needs real transfer, that is a new contract
-- with its own authorization, deletion and privacy semantics.
create or replace function public.forbid_provider_account_owner_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'UPDATE on % is refused: a provider-account ownership reservation is not editable. Changing the owner would move a durable Google identity — and the consent history bound to it — between app users, which B01 does not implement.',
    tg_table_name
    using errcode = 'restrict_violation';
end;
$$;

revoke all on function public.forbid_provider_account_owner_mutation() from public;

create trigger mail_provider_account_owners_immutable
  before update on public.mail_provider_account_owners
  for each row execute function public.forbid_provider_account_owner_mutation();

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
      granted_scopes <@ public.approved_gmail_scopes()
    ),

  connected_at timestamptz,
  disconnected_at timestamptz,
  last_state_change_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- THE DELETION THIS RECORD'S RETIREMENT RESTS ON.
  --
  -- `deletion_pending` and `deleted` are claims about a specific request, not
  -- about the mailbox's history in general. Naming the request makes the claim
  -- checkable: without this pointer, any completed request ever filed — for a
  -- narrower scope, from years earlier, already superseded — would satisfy a
  -- present-tense state, and "your account was deleted" would be provable by an
  -- unrelated event. The composite FK in §4 also forces the request to belong to
  -- THIS mailbox, so one account's deletion cannot retire another's.
  --
  -- No `on delete` action: the requests cascade when the account row goes, and
  -- by then this row no longer exists to reference them.
  current_deletion_request_id uuid,

  -- ONE PROVIDER ACCOUNT, ONE OWNING APP USER. This row must agree with the
  -- registry in §1a about who owns its durable provider identity — live rows and
  -- retired ones alike, which is precisely what a partial unique index over live
  -- rows could not see.
  --
  -- Declarative rather than a trigger, so a mail account belonging to anyone but
  -- the registered owner is unrepresentable. The BEFORE INSERT trigger below
  -- claims the reservation on a writer's behalf; this constraint is what makes
  -- the claim binding even if that trigger were removed (in which case no
  -- registry row would be created and every insert would fail — closed, not
  -- open).
  constraint mail_accounts_provider_owner_fk
    foreign key (provider, provider_account_subject, user_id)
    references public.mail_provider_account_owners
      (provider, provider_account_subject, owner_user_id),

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

  -- CONNECTED MEANS WE CAN ACTUALLY READ. A non-empty scope set is not enough:
  -- `openid` plus `gmail.send` is a mailbox we may write to and may not read,
  -- which is not a Gmail connection in this product's sense at all. Every G1/G2
  -- capability the roadmap describes starts from reading messages, so the base
  -- read grant is what the state word `connected` is allowed to assert.
  constraint mail_accounts_connected_requires_read check (
    connection_state <> 'connected'
    or granted_scopes @> array['https://www.googleapis.com/auth/gmail.readonly']::text[]
  ),

  -- ACCESS HAS STOPPED, and the row says so rather than merely implying it.
  -- Emptying `granted_scopes` is the metadata half of revocation; B02 revokes at
  -- Google and destroys the credential, and neither substitutes for the other.
  constraint mail_accounts_disconnected_shape check (
    connection_state not in ('disconnected', 'deletion_pending', 'deleted')
    or (disconnected_at is not null and cardinality(granted_scopes) = 0)
  ),

  -- A DELETION STATE MUST NAME ITS DELETION. The pointer's target is validated
  -- in §4 (same mailbox) and §5 (right status, right scope); this row-local
  -- CHECK is the part that can be immediate, so the pointer can never simply be
  -- left behind when the state is set.
  constraint mail_accounts_deletion_state_has_request check (
    connection_state not in ('deletion_pending', 'deleted')
    or current_deletion_request_id is not null
  ),

  -- ...and a mailbox that is NOT in a deletion state must not carry a stale
  -- pointer, so the field always means "the deletion this state rests on".
  constraint mail_accounts_non_deletion_state_has_no_request check (
    connection_state in ('deletion_pending', 'deleted')
    or current_deletion_request_id is null
  )
);

-- ONE LIVE MAILBOX RECORD PER PROVIDER ACCOUNT. The registry in §1a settles WHO
-- owns a durable provider identity; this settles HOW MANY usable connections it
-- may have at once, which is one. Two live rows for a single Google account —
-- even under the same owner — would be two simultaneous connections with two
-- separate consent histories, and no reader could say which one governs.
--
-- RETIRED RECORDS ARE EXCLUDED, and this is a direct consequence of `deleted`
-- being terminal (see the trigger below). A creator who deletes their mailbox
-- data and later reconnects the same Google account must get a NEW row: the old
-- one asserts that their data was removed and may never be revived. If this
-- index covered retired rows, terminality would silently mean "you can never
-- reconnect this address", which is not a privacy guarantee, just a bug.
--
-- What the exclusion must NOT do is stop seeing retired rows for the purposes of
-- OWNERSHIP. That is exactly the gap the registry closes, and the two work as a
-- pair: the registry spans a durable identity's whole history, the index governs
-- only its live present.
create unique index mail_accounts_provider_account_uidx
  on public.mail_accounts (provider, provider_account_subject)
  where connection_state <> 'deleted';

create index mail_accounts_user_idx on public.mail_accounts (user_id, connection_state);

-- ---------------------------------------------------------------------------
-- CLAIMING THE DURABLE IDENTITY
-- ---------------------------------------------------------------------------
-- Auto-claim, so no writer can create a mail account and forget to register its
-- ownership; the FK above is the guarantee, and this is what makes satisfying it
-- the default rather than a step someone remembers.
--
-- THE RACE IS IMPOSSIBLE, NOT UNLIKELY. A trigger that merely SELECTed for an
-- existing owner and refused a different one would let two transactions both
-- find nothing and both proceed, since neither sees the other's uncommitted row.
-- The INSERT below contends on the registry's primary-key index instead: the
-- second transaction blocks there until the first commits, then takes no action
-- and reads the winner in the next statement's snapshot. One owner wins; the
-- loser fails the ownership test below, or — under an isolation level where the
-- winner's row stays invisible — fails the FK. Every path is closed.
create or replace function public.claim_provider_account_owner()
returns trigger
language plpgsql
as $$
declare
  registered_owner uuid;
begin
  insert into public.mail_provider_account_owners
    (provider, provider_account_subject, owner_user_id)
  values (new.provider, new.provider_account_subject, new.user_id)
  on conflict (provider, provider_account_subject) do nothing;

  select o.owner_user_id into registered_owner
    from public.mail_provider_account_owners o
   where o.provider = new.provider
     and o.provider_account_subject = new.provider_account_subject;

  if registered_owner is null then
    -- The claim neither inserted nor found a row: a concurrent claim committed
    -- but is not visible to this transaction's snapshot. Refusing is the only
    -- safe answer, and the FK would refuse anyway.
    raise exception
      'provider account %/% could not be claimed for user %: a concurrent claim is in flight. Retry the connection.',
      new.provider, new.provider_account_subject, new.user_id
      using errcode = 'serialization_failure';
  end if;

  if registered_owner <> new.user_id then
    raise exception
      'provider account %/% is already owned by app user %, so user % cannot hold a mailbox for it. A Google account''s durable identity belongs to one app user for as long as any of its history exists here — including a retired mail account, whose consent receipts and deletion record remain bound to that owner. Moving it is a transfer, and B01 implements none.',
      new.provider, new.provider_account_subject, registered_owner, new.user_id
      using errcode = 'integrity_constraint_violation';
  end if;

  return new;
end;
$$;

revoke all on function public.claim_provider_account_owner() from public;

-- INSERT only: the identity columns are immutable after creation (see the
-- state-transition trigger), so there is no UPDATE that could need re-claiming.
create trigger mail_accounts_claim_provider_account
  before insert on public.mail_accounts
  for each row execute function public.claim_provider_account_owner();

create trigger mail_accounts_set_updated_at
  before update on public.mail_accounts
  for each row execute function public.set_updated_at();

create trigger mail_accounts_normalize_scopes
  before insert or update on public.mail_accounts
  for each row execute function public.normalize_gmail_scope_column('granted_scopes');

-- ---------------------------------------------------------------------------
-- `deleted` IS TERMINAL
-- ---------------------------------------------------------------------------
-- Every other connection state is a stage in a mailbox's life and may be left.
-- `deleted` is not a stage: it is the assertion that the stored Gmail data is
-- gone and the record is retired. Reviving that row would reattach a live
-- mailbox to a completed deletion request — the user is told their data was
-- removed while the same row starts accumulating again, and the evidence trail
-- says the deletion succeeded. A returning creator gets a NEW mail_accounts row
-- through a fresh authorization and a fresh consent; that is not a hardship,
-- it is the correct record of a second, separate grant of access.
create or replace function public.enforce_mail_account_state_transition()
returns trigger
language plpgsql
as $$
declare
  request_status text;
begin
  -- THE ROW'S IDENTITY IS FIXED AT CREATION. Owner, provider and provider
  -- subject are what every consent receipt and deletion request on this mailbox
  -- is about; editing them would silently re-point a whole private history at a
  -- different human or a different Google account, which is a transfer performed
  -- in one UPDATE. The registry FK already makes a cross-owner result
  -- unrepresentable — this refuses the attempt at its source, and with a message
  -- that says what was actually being done.
  if new.user_id is distinct from old.user_id
     or new.provider is distinct from old.provider
     or new.provider_account_subject is distinct from old.provider_account_subject then
    raise exception
      'mail account % cannot change owner or provider identity. The consent receipts and deletion records attached to a mailbox are about THIS human and THIS Google account; re-pointing the row would make all of them describe something else.',
      old.id
      using errcode = 'restrict_violation';
  end if;

  -- TERMINALITY, so that a retired record answers with the reason it is
  -- refusing everything rather than with whatever rule happens to be tested next.
  if old.connection_state = 'deleted' then
    if new.connection_state <> 'deleted' then
      raise exception
        'mail account % is `deleted` and cannot become `%`. Deletion is terminal: the record asserts that stored Gmail data was removed, and a revived row would make that assertion false while still carrying the completed deletion request as its evidence. Reconnecting is a NEW mail account with a NEW authorization and a NEW consent.',
        old.id, new.connection_state
        using errcode = 'restrict_violation';
    end if;

    -- The pointer is frozen with the state: swapping the request afterwards
    -- would let the account keep the word `deleted` while the deletion it names
    -- changes underneath.
    if new.current_deletion_request_id is distinct from old.current_deletion_request_id then
      raise exception
        'mail account % is `deleted`; the deletion request it rests on cannot be replaced. The evidence for a completed deletion is fixed at the moment the state was set.',
        old.id
        using errcode = 'restrict_violation';
    end if;

    return new;
  end if;

  -- ENTERING `deletion_pending` MEANS WAITING ON A DELETION THAT IS RUNNING NOW.
  --
  -- This one is checked IMMEDIATELY rather than at COMMIT, and the difference is
  -- the whole point. A deferred check only ever sees where the transaction ended
  -- up, so a writer could pass through `deletion_pending` pointing at a request
  -- that finished long ago and land on `deleted` in the same transaction — the
  -- end state looks perfect and the waiting never happened. Testing the pointer
  -- at the moment it is set is what makes "the request that ran is the request
  -- that is credited" true rather than merely usual.
  if new.connection_state = 'deletion_pending'
     and (old.connection_state is distinct from 'deletion_pending'
          or new.current_deletion_request_id is distinct from old.current_deletion_request_id) then
    select r.status into request_status
      from public.mail_account_deletion_requests r
     where r.id = new.current_deletion_request_id;

    if not found then
      raise exception
        'mail account % cannot become `deletion_pending` naming a deletion request that does not exist yet. Record the request first: the state is a claim that specific work is under way.',
        old.id
        using errcode = 'restrict_violation';
    end if;

    if request_status not in ('requested', 'in_progress') then
      raise exception
        'mail account % cannot start waiting on a deletion request that is already `%`. A finished request is history; a present-tense state needs work that is actually running.',
        old.id, request_status
        using errcode = 'restrict_violation';
    end if;
  end if;

  -- ENTERING `deleted` IS THE END OF A DELETION THIS ROW WAS ALREADY WAITING ON.
  --
  -- §5 requires the named request to be completed and account-scoped, but on its
  -- own that still lets a request completed long ago — one the mailbox was never
  -- retired for, perhaps from a connection two authorizations back — be picked up
  -- later as the evidence for a fresh `deleted`. Requiring the transition to come
  -- out of `deletion_pending` on the SAME request removes the possibility rather
  -- than testing for it: the pointer can only be set while the request is still
  -- open (§5 again), so a stale completed request can never be pointed at at all.
  if new.connection_state = 'deleted' and old.connection_state <> 'deleted' then
    if old.connection_state <> 'deletion_pending' then
      raise exception
        'mail account % cannot go from `%` straight to `deleted`. A retirement is the end of a deletion this record was waiting on: it passes through `deletion_pending` on the request that is running, so the completed request it finally rests on is the one it actually waited for.',
        old.id, old.connection_state
        using errcode = 'restrict_violation';
    end if;

    if new.current_deletion_request_id is distinct from old.current_deletion_request_id then
      raise exception
        'mail account % became `deleted` naming a different deletion request than the one it was pending on. The request that ran must be the request that is credited.',
        old.id
        using errcode = 'restrict_violation';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_mail_account_state_transition() from public;

create trigger mail_accounts_state_transition
  before update on public.mail_accounts
  for each row execute function public.enforce_mail_account_state_transition();

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

  -- THE ORDER OF EVENTS, OWNED BY THE DATABASE.
  --
  -- "Which decision is the latest one?" has to have exactly one answer, and none
  -- of the obvious candidates gives it:
  --
  --   decided_at   is supplied by the caller. A writer that passes a stale or
  --                clock-skewed timestamp — or an attacker who passes one on
  --                purpose — would make a withdrawal sort before the grant it
  --                revokes.
  --   created_at   is `now()`, which in PostgreSQL is transaction start time.
  --                Two receipts written in one transaction share it exactly, and
  --                a long transaction can stamp a receipt earlier than one a
  --                short later transaction already committed.
  --   id           is a random UUID. Lexical order over v4 UUIDs is not
  --                chronology in any sense; it only looks like an ordering.
  --
  -- An identity column is generated by the database at INSERT, is strictly
  -- increasing, and cannot be supplied or overridden by the writer (`generated
  -- ALWAYS`). Gaps from rolled-back transactions are irrelevant: dominance is
  -- "greatest sequence that exists", never "sequence + 1".
  event_seq bigint generated always as identity,

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

  -- THE SCOPES IN FORCE WHEN THE HUMAN DECIDED — a snapshot, and evidence.
  --
  -- A consent given against read-only access is not consent to a later, wider
  -- grant, so this column is what makes "what were they agreeing about?"
  -- answerable years later. That only works if it is TRUE, which means two
  -- things the database has to hold rather than trust:
  --
  --   * it must equal the mailbox's ACTUAL granted scopes at the moment the
  --     receipt was written (§5, R1) — a caller cannot narrate a narrower or
  --     wider grant than the one that existed;
  --   * it must never contain a scope this product is not allowed to hold, so a
  --     forbidden scope cannot enter the schema through the consent side after
  --     being refused on the account side (the CHECK below).
  --
  -- And it is never rewritten. When account scopes change later, the fix is a
  -- NEW receipt; editing this one would replace what a human actually saw with
  -- what is convenient now.
  granted_scopes_at_decision text[] not null default '{}'
    constraint mail_account_consent_receipts_scope_allowlist check (
      granted_scopes_at_decision <@ public.approved_gmail_scopes()
    ),

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
  -- receipt that agrees with it on every field that matters — including its
  -- position in the event order. `id` is already the primary key, so these add
  -- targets and no restriction.
  constraint mail_account_consent_receipts_projection_uk
    unique (id, mail_account_id, consent_kind, decision, event_seq),

  constraint mail_account_consent_receipts_event_seq_uk unique (event_seq)
);

-- Ordered by EVENT_SEQ, not by `decided_at`. An index on a caller-supplied
-- timestamp would quietly invite `order by decided_at desc limit 1` to be
-- treated as "the current decision", which is the defect this amendment closes.
create index mail_account_consent_receipts_account_idx
  on public.mail_account_consent_receipts (mail_account_id, consent_kind, event_seq desc);
create index mail_account_consent_receipts_user_idx
  on public.mail_account_consent_receipts (user_id);

create trigger mail_account_consent_receipts_normalize_scopes
  before insert on public.mail_account_consent_receipts
  for each row execute function public.normalize_gmail_scope_column('granted_scopes_at_decision');

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
  -- WHAT IS ACTUALLY BEING TESTED. The permitted deletion path is the cascade
  -- from this receipt's mailbox or from its owning user, and the test is a
  -- statement about the state those cascades produce, not about how the DELETE
  -- was reached:
  --
  --   PostgreSQL applies a referential action AFTER removing the parent row, so
  --   when this BEFORE DELETE fires inside such a cascade, the parent — the
  --   mail_accounts row, or the users row when `on delete cascade` reaches these
  --   receipts directly — is already gone in this transaction's snapshot.
  --
  -- A direct `delete from mail_account_consent_receipts` leaves both parents in
  -- place, so it fails this test and is refused. Checking BOTH parents matters:
  -- deleting a user cascades to mail_accounts and to these receipts through two
  -- separate constraints, and PostgreSQL does not promise which fires first, so
  -- a check that named only the mailbox would intermittently block a legitimate
  -- user deletion.
  --
  -- The earlier version of this guard used `pg_trigger_depth() > 1`. That is
  -- true of ANY nested trigger context — an FK cascade, but equally a BEFORE
  -- trigger on some other table issuing this DELETE itself — so it did not
  -- prove what it was documented as proving.
  if not exists (select 1 from public.mail_accounts m where m.id = old.mail_account_id)
     or not exists (select 1 from public.users u where u.id = old.user_id) then
    return old;
  end if;

  raise exception
    'DELETE on % is refused: consent history is removed only by deleting the mailbox or the user it belongs to, which cascades all of it at once. Deleting one receipt would leave a consent record that disagrees with the decisions that produced it.',
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

  -- The named receipt's position in the event order, carried here so that
  -- "this projection never moves backwards" is a comparison between two values
  -- in the row being updated rather than a subquery that a concurrent writer
  -- could race. The composite FK below makes it impossible for this number to
  -- disagree with the receipt it is copied from.
  current_event_seq bigint not null,

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
    foreign key (current_receipt_id, mail_account_id, consent_kind, state, current_event_seq)
    references public.mail_account_consent_receipts
      (id, mail_account_id, consent_kind, decision, event_seq)
    on delete restrict
);

create index mail_account_consents_user_idx on public.mail_account_consents (user_id);

create trigger mail_account_consents_set_updated_at
  before update on public.mail_account_consents
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- A PROJECTION MOVES FORWARD ONLY
-- ---------------------------------------------------------------------------
-- Consent state is reached by living through events, not by choosing which past
-- event to stand on. Re-pointing this row at an earlier receipt would resurrect
-- a permission the human already took back — and it would do so without any new
-- decision by them, because the grant being pointed at is one they made before
-- the withdrawal. The only route from `withdrawn` back to `granted` is a NEW
-- granted receipt, which by construction carries a higher `event_seq`.
--
-- This is the immediate, row-local half of the rule; §5 adds the deferred half
-- that also requires the projection to sit on the LATEST event, not merely a
-- later one than before.
create or replace function public.forbid_mail_consent_projection_rewind()
returns trigger
language plpgsql
as $$
begin
  if new.current_event_seq < old.current_event_seq then
    raise exception
      'consent projection for mail account % / % cannot move back from event % to event %. A projection follows the consent history forward; re-granting after a withdrawal requires a NEW granted receipt, never a second use of the one that was already withdrawn.',
      old.mail_account_id, old.consent_kind, old.current_event_seq, new.current_event_seq
      using errcode = 'restrict_violation';
  end if;

  if new.mail_account_id is distinct from old.mail_account_id
     or new.consent_kind is distinct from old.consent_kind then
    raise exception
      'consent projection for mail account % / % cannot be re-pointed at a different mailbox or permission. Moving the row is how one permission''s history would come to answer for another''s.',
      old.mail_account_id, old.consent_kind
      using errcode = 'restrict_violation';
  end if;

  return new;
end;
$$;

revoke all on function public.forbid_mail_consent_projection_rewind() from public;

create trigger mail_account_consents_no_rewind
  before update on public.mail_account_consents
  for each row execute function public.forbid_mail_consent_projection_rewind();

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
  ),

  -- Reference target for the account's `current_deletion_request_id` pointer.
  -- `id` is already the primary key, so this adds a target and no restriction —
  -- what it buys is that the pointer must name a request belonging to THE SAME
  -- mailbox, declaratively.
  constraint mail_account_deletion_requests_id_account_uk unique (id, mail_account_id)
);

-- THE POINTER, now that its target exists. NOT deferrable: the state-transition
-- trigger already requires the request to exist and be running before an account
-- may start waiting on it, so there is no legitimate window in which this
-- reference is allowed to dangle.
alter table public.mail_accounts
  add constraint mail_accounts_current_deletion_request_fk
  foreign key (current_deletion_request_id, id)
  references public.mail_account_deletion_requests (id, mail_account_id);

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
  request_status text;
  request_scope text;
  consent_scopes text[];
begin
  -- OLD and NEW are each unassigned outside their own operations, so the row
  -- image has to be chosen by operation rather than coalesced.
  if tg_table_name = 'mail_accounts' then
    account_id := new.id;
  elsif tg_op = 'DELETE' then
    account_id := old.mail_account_id;
  else
    account_id := new.mail_account_id;
  end if;

  -- FINAL state, read now rather than trusting the row image queued when this
  -- trigger fired: by commit time either side may have moved again.
  select m.connection_state, m.user_id, m.granted_scopes, m.current_deletion_request_id
    into account
    from public.mail_accounts m where m.id = account_id;

  if not found then
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

  -- 2. THE SCOPES A CONNECTED MAILBOX HOLDS ARE THE SCOPES ITS CURRENT CONSENT
  --    WAS GIVEN ABOUT.
  --
  --    Incremental authorization means the set can grow after the fact: a
  --    creator who agreed to read-only analysis can later be asked for
  --    `gmail.send`. Google's screen asks about ACCESS. It does not ask again
  --    about what this product may do with the data, and the receipt on file
  --    describes a narrower mailbox than the one now connected — so silently
  --    keeping it would leave the documentation saying "consent is scoped to
  --    what was granted" while the database happily widened the grant without a
  --    human. Widening therefore requires a NEW private-processing receipt whose
  --    snapshot names the new set; the projection advances to it, and the
  --    account and its consent describe the same mailbox again.
  --
  --    Narrowing is the same rule for the same reason, and disconnecting is not
  --    an exception to it: a disconnected mailbox is not `connected`, so this
  --    check does not apply to it and no consent has to be re-collected to stop.
  if account.connection_state = 'connected' then
    select r.granted_scopes_at_decision into consent_scopes
      from public.mail_account_consents c
      join public.mail_account_consent_receipts r on r.id = c.current_receipt_id
     where c.mail_account_id = account_id
       and c.consent_kind = 'private_gmail_processing';

    if consent_scopes is distinct from public.canonical_scope_set(account.granted_scopes) then
      raise exception
        'mail account % is `connected` holding scopes % while its current private_gmail_processing consent was given about %. A change to what Google lets us do is not itself a decision by the human about what we may do with the data: record a NEW consent receipt for the current scope set.',
        account_id,
        public.canonical_scope_set(account.granted_scopes),
        coalesce(consent_scopes::text, 'no scopes at all')
        using errcode = 'integrity_constraint_violation';
    end if;
  end if;

  -- THE DELETION THE STATE RESTS ON — the specific one, read through the
  -- account's own pointer. Counting requests would let any completed request
  -- ever filed satisfy a present-tense claim.
  if account.current_deletion_request_id is not null then
    select r.status, r.scope into request_status, request_scope
      from public.mail_account_deletion_requests r
     where r.id = account.current_deletion_request_id;
  end if;

  -- 3. `deletion_pending` MEANS a deletion is genuinely outstanding. A state
  --    that merely looks like work in progress, with no request behind it, is a
  --    promise to the user that nothing is keeping. A request that already
  --    finished or failed does not keep it either.
  if account.connection_state = 'deletion_pending'
     and coalesce(request_status, '') not in ('requested', 'in_progress') then
    raise exception
      'mail account % is `deletion_pending` but the deletion request it names is %. The state claims work is under way that nothing recorded is actually doing.',
      account_id, coalesce(request_status, 'absent')
      using errcode = 'integrity_constraint_violation';
  end if;

  -- 4. `deleted` MEANS THIS MAILBOX'S RECORD WAS RETIRED BY A DELETION THAT
  --    ASKED FOR EXACTLY THAT.
  --
  --    Two separate things had to be true and neither was checkable before:
  --    the named request must have COMPLETED, and its scope must have been
  --    `account_and_gmail_derived_data`. A completed `gmail_derived_data`
  --    request means the opposite — the human asked for their Gmail-derived data
  --    to go while the account record is KEPT, precisely so the connection stays
  --    auditable. Letting that retire the record would delete something nobody
  --    asked to delete, and would then read back as evidence that they had.
  if account.connection_state = 'deleted' then
    if coalesce(request_status, '') <> 'completed' then
      raise exception
        'mail account % is `deleted` but the deletion request it names is %. Disconnecting is not deleting, and a state label is not evidence that data was removed.',
        account_id, coalesce(request_status, 'absent')
        using errcode = 'integrity_constraint_violation';
    end if;

    if request_scope <> 'account_and_gmail_derived_data' then
      raise exception
        'mail account % is `deleted` on the strength of a `%` request. That request asked for Gmail-derived data to be removed while the account record is KEPT; retiring the record anyway deletes something the human did not ask to delete.',
        account_id, request_scope
        using errcode = 'integrity_constraint_violation';
    end if;
  end if;

  return null;
end;
$$;

revoke all on function public.assert_mail_account_state_coherent() from public;

create constraint trigger mail_accounts_state_coherent
  after insert or update on public.mail_accounts
  deferrable initially deferred
  for each row execute function public.assert_mail_account_state_coherent();

-- DELETE included on the projection: removing the current consent row is
-- otherwise a way to un-consent a `connected` mailbox with no trigger watching.
create constraint trigger mail_account_consents_state_coherent
  after insert or update or delete on public.mail_account_consents
  deferrable initially deferred
  for each row execute function public.assert_mail_account_state_coherent();

create constraint trigger mail_account_consent_receipts_state_coherent
  after insert on public.mail_account_consent_receipts
  deferrable initially deferred
  for each row execute function public.assert_mail_account_state_coherent();

create constraint trigger mail_account_deletion_requests_state_coherent
  after insert or update on public.mail_account_deletion_requests
  deferrable initially deferred
  for each row execute function public.assert_mail_account_state_coherent();

-- ---------------------------------------------------------------------------
-- THE CURRENT CONSENT IS THE LATEST CONSENT
-- ---------------------------------------------------------------------------
-- The composite FK in §3 makes the projection agree with the receipt it names.
-- It says nothing about whether that receipt is the one that should be named,
-- and that gap is the whole defect: a withdrawal could be appended to history
-- while the projection stayed on the earlier grant, so `mail_account_has_consent`
-- kept answering `true` about a permission the human had taken back — and every
-- future G1/G2 caller reads exactly that function.
--
-- The rule: for each (mailbox, permission) that has any history at all, exactly
-- one projection exists, and it names the receipt with the greatest `event_seq`.
-- Withdrawal therefore cannot be recorded without taking effect, and effect
-- cannot be claimed without a decision to point at.
--
-- Deferred, because a legitimate transaction writes the receipt and advances
-- the projection in two statements and is momentarily inconsistent between them.
--
-- REGISTERED ON BOTH ORIGINS — receipt INSERT and projection INSERT/UPDATE/
-- DELETE. This is the lesson A04.6 amendment #3 paid for: an invariant hung off
-- one side is not an invariant, it is a habit of whoever writes that side. Here
-- the same broken state is reachable from either direction (append a receipt
-- and stop; or move the projection off the latest one), so both directions have
-- to be able to refuse it.
create or replace function public.assert_mail_consent_projection_dominant()
returns trigger
language plpgsql
as $$
declare
  target_account uuid;
  target_kind text;
  latest record;
  projection record;
begin
  if tg_op = 'DELETE' then
    target_account := old.mail_account_id;
    target_kind := old.consent_kind;
  else
    target_account := new.mail_account_id;
    target_kind := new.consent_kind;
  end if;

  if not exists (select 1 from public.mail_accounts m where m.id = target_account) then
    -- The mailbox went in this transaction and took its consent plane with it.
    return null;
  end if;

  select r.id, r.event_seq, r.decision into latest
    from public.mail_account_consent_receipts r
   where r.mail_account_id = target_account
     and r.consent_kind = target_kind
   order by r.event_seq desc
   limit 1;

  if not found then
    -- No history for this permission. A projection cannot exist without one —
    -- its FK names a receipt — so there is nothing to compare.
    return null;
  end if;

  select c.current_receipt_id, c.current_event_seq, c.state into projection
    from public.mail_account_consents c
   where c.mail_account_id = target_account
     and c.consent_kind = target_kind;

  if not found then
    raise exception
      'mail account % has % consent history for `%` but no current consent row. A decision that is recorded and not projected is a decision that never takes effect — most dangerously a withdrawal.',
      target_account, latest.decision, target_kind
      using errcode = 'integrity_constraint_violation';
  end if;

  if projection.current_event_seq <> latest.event_seq then
    raise exception
      'current consent for mail account % / `%` names event % (%), but the latest recorded decision is event % (%). The current answer to "may we?" must be the human''s most recent decision, not an earlier one that is still convenient.',
      target_account, target_kind,
      projection.current_event_seq, projection.state,
      latest.event_seq, latest.decision
      using errcode = 'integrity_constraint_violation';
  end if;

  return null;
end;
$$;

revoke all on function public.assert_mail_consent_projection_dominant() from public;

create constraint trigger mail_account_consent_receipts_projection_dominant
  after insert on public.mail_account_consent_receipts
  deferrable initially deferred
  for each row execute function public.assert_mail_consent_projection_dominant();

create constraint trigger mail_account_consents_projection_dominant
  after insert or update or delete on public.mail_account_consents
  deferrable initially deferred
  for each row execute function public.assert_mail_consent_projection_dominant();

-- ---------------------------------------------------------------------------
-- A RECEIPT'S SCOPE SNAPSHOT IS EVIDENCE, NOT NARRATION
-- ---------------------------------------------------------------------------
-- `granted_scopes_at_decision` is the only durable record of what the mailbox
-- could actually do when a human agreed to something. If the writer may put any
-- value there, it records what the writer wished were true — including a
-- narrower set than was really held, which is how a broad grant gets documented
-- as a modest one.
--
-- So it must equal the account's scope set as that set stands when the receipt's
-- transaction commits. "At commit" is the only definition available and it is
-- the right one: it is the state the receipt was actually written against, and
-- it is what a reader would reconstruct.
--
-- A consequence worth stating: a transaction that clears scopes and records a
-- withdrawal together produces a snapshot of `{}`. To preserve "withdrew while
-- holding gmail.readonly", write the withdrawal receipt in its own transaction
-- BEFORE clearing the account's scopes. The constraint never rewrites an old
-- receipt when scopes later change — history is a series of snapshots, and each
-- one stays true about its own moment.
create or replace function public.assert_mail_consent_receipt_scopes_actual()
returns trigger
language plpgsql
as $$
declare
  account_scopes text[];
begin
  select public.canonical_scope_set(m.granted_scopes) into account_scopes
    from public.mail_accounts m where m.id = new.mail_account_id;

  if not found then
    return null;
  end if;

  if new.granted_scopes_at_decision is distinct from account_scopes then
    raise exception
      'consent receipt % records scopes % but mail account % actually holds %. The snapshot is evidence about a moment, so it is taken from the mailbox rather than accepted from the caller.',
      new.id, new.granted_scopes_at_decision, new.mail_account_id, account_scopes
      using errcode = 'integrity_constraint_violation';
  end if;

  return null;
end;
$$;

revoke all on function public.assert_mail_consent_receipt_scopes_actual() from public;

create constraint trigger mail_account_consent_receipts_scopes_actual
  after insert on public.mail_account_consent_receipts
  deferrable initially deferred
  for each row execute function public.assert_mail_consent_receipt_scopes_actual();

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
alter table public.mail_provider_account_owners enable row level security;
alter table public.mail_accounts enable row level security;
alter table public.mail_account_consent_receipts enable row level security;
alter table public.mail_account_consents enable row level security;
alter table public.mail_account_deletion_requests enable row level security;

-- The ownership registry is part of the private plane, not a public directory:
-- "which app user owns Google subject X" would let anyone probe whether a given
-- Gmail account is connected here and to whom. Owners see only their own
-- reservations, on the same terms as everything else in this plane.
create policy mail_provider_account_owners_select_own on public.mail_provider_account_owners
  for select using (owner_user_id = auth.uid());
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
  public.mail_provider_account_owners,
  public.mail_accounts,
  public.mail_account_consent_receipts,
  public.mail_account_consents,
  public.mail_account_deletion_requests
to authenticated;

-- No anon grant of any kind.

-- The registry needs INSERT because the claim trigger runs with the privileges
-- of whoever inserts the mail account, and the server is the only writer here.
-- DELETE is granted for completeness; in practice the reservation is released by
-- the cascade from an erased user, and the FK refuses any delete that would
-- orphan a mail account. UPDATE is granted and then refused by the immutability
-- trigger, so an attempted transfer fails loudly rather than silently lacking a
-- privilege.
grant select, insert, update, delete on
  public.mail_provider_account_owners,
  public.mail_accounts,
  public.mail_account_consents,
  public.mail_account_deletion_requests
to service_role;

-- Append-only: not even the trusted role holds UPDATE or DELETE on consent
-- history. The trigger in §2 is the second layer, not the only one.
grant select, insert on public.mail_account_consent_receipts to service_role;
