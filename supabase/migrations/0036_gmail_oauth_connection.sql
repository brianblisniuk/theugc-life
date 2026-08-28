-- ===========================================================================
-- 0036 — GMAIL OAUTH CONNECTION, RECONNECT AND DISCONNECT (B02)
-- ===========================================================================
-- B01 (0035) drew the boundary and deliberately stored NO credential material.
-- B02 is the layer that actually connects a Google account, so it is the first
-- place in this system where a long-lived secret exists at all.
--
-- Two things follow, and they shape everything below.
--
-- FIRST: the credential does not belong in `public`. Every table in `public` is
-- reachable through PostgREST by whichever role holds a grant, and B01's own
-- contract says a refresh token must never be "in a generally queryable public
-- table alongside metadata". So the secret lives in a `private` schema that has
-- NO `usage` grant for anon, authenticated OR service_role. Not a narrow grant —
-- no path at all. `service_role` is `bypassrls`, so RLS could not have protected
-- this from the trusted role; withholding schema usage does.
--
-- SECOND: something still has to write it. That is a small set of SECURITY
-- DEFINER functions in `public`, executable ONLY by service_role, each of which
-- is ONE transaction. This is the same shape 0019's save_hotel_to_pipeline uses
-- and for the same reason: a sequence of independent PostgREST writes cannot be
-- atomic, and B02 has invariants that a half-finished write would break —
-- a `connected` mailbox with no credential, or a credential attached to the
-- wrong owner.
--
-- WHAT THIS MIGRATION DOES NOT DO:
--   It connects no Gmail account. It creates no OAuth transaction, stores no
--   credential and infers no consent. It adds no message, thread, attachment,
--   sync, import or classification table. It requests nothing from Google —
--   a migration cannot; it only makes the structures the server will use.
--
-- Migrations 0001-0035 are unchanged.

-- ===========================================================================
-- 0. FAIL BEFORE CHOICE
-- ===========================================================================
-- This migration installs an invariant it cannot retroactively satisfy: from
-- here on, a `connected` mailbox holds exactly one Gmail refresh credential.
-- Every row that exists BEFORE this file runs has zero, because the table that
-- would hold one is created below.
--
-- A constraint trigger governs writes, so such a row would sit there — connected
-- according to the database, unreadable in fact — until something happened to
-- touch it. The migration would report success while the property it claims to
-- establish was already false. That is not an invariant; it is a hope with a
-- trigger attached.
--
-- B02 cannot invent a Google refresh token for a row B01 created, so there is no
-- honest automatic repair. The four dishonest ones are all refused explicitly:
-- do not synthesize a credential, do not silently demote the row, do not delete
-- it, and do not shrug and say the next write will sort it out. Instead the
-- migration REFUSES TO INSTALL, names the rows, and hands the decision to a
-- human who knows what those mailboxes are.
--
-- The expected count is zero, and provably so: B01 shipped schema only — no
-- route, no action, no function that can create a `mail_accounts` row — so
-- nothing could have reached `connected` before B02 exists to connect it. That
-- is exactly why this guard is cheap: it costs one query on a table that should
-- be empty, and it is the difference between an invariant and a claim.
-- THE GUARD MUST COVER EVERY NEW INVARIANT, not just the first one. 0036 makes
-- two statements about pre-existing rows that they can already contradict:
--
--   1. `connected` holds exactly one credential — impossible before the store
--      exists, so any pre-existing `connected` row is a counterexample;
--   2. `pending_authorization` holds an EMPTY scope set — and 0035 permits a
--      `pending_authorization` row with `gmail.readonly`, because its empty-scope
--      CHECK covers only `disconnected`, `deletion_pending` and `deleted`. Such a
--      row is entirely valid under 0035 and forbidden the moment 0036 lands.
--
-- Checking only the first is the same mistake in a smaller place: the migration
-- would still complete with one of its own invariants already false.
--
-- The remaining 0035 states need no guard, and it is worth saying why rather
-- than leaving it to be inferred:
--
--   reauth_required   no credential can exist before this migration, and the
--                     state legitimately RETAINS its last known scope set — that
--                     is the contract, not a violation;
--   disconnected /
--   deletion_pending /
--   deleted           0035 already requires `disconnected_at` and an empty scope
--                     set for all three, and no credential store exists yet, so
--                     both new rules are satisfied by construction;
--   consent_required  cannot exist: 0035's CHECK does not permit the value, and
--                     this migration is what adds it.
do $$
declare
  v_connected bigint;
  v_pending bigint;
  v_sample text;
begin
  if to_regclass('public.mail_accounts') is null then
    return;
  end if;

  select count(*) into v_connected
    from public.mail_accounts where connection_state = 'connected';

  if v_connected > 0 then
    select string_agg(id::text, ', ' order by id) into v_sample
      from (select id from public.mail_accounts
             where connection_state = 'connected' order by id limit 10) s;

    raise exception
      '0036 refuses to install: % mail account(s) are already `connected` and cannot hold a Gmail OAuth credential, because this migration is what creates the credential store. B02 cannot attach a refresh token retroactively — the human would have to authorize at Google again — so these rows require explicit operator resolution (disconnect them, or retire them under B01''s deletion path) before the credential invariants can be installed. Refusing rather than synthesizing a credential, demoting the row or deleting it. First rows: %',
      v_connected, coalesce(v_sample, 'none')
      using errcode = 'integrity_constraint_violation';
  end if;

  select count(*) into v_pending
    from public.mail_accounts
   where connection_state = 'pending_authorization'
     and cardinality(coalesce(granted_scopes, '{}')) > 0;

  if v_pending > 0 then
    select string_agg(id::text, ', ' order by id) into v_sample
      from (select id from public.mail_accounts
             where connection_state = 'pending_authorization'
               and cardinality(coalesce(granted_scopes, '{}')) > 0
             order by id limit 10) s;

    raise exception
      '0036 refuses to install: % mail account(s) are `pending_authorization` while holding a non-empty granted scope set. 0035 permitted that combination; 0036 does not, because the state asserts the human never completed Google''s consent screen and a granted scope set is the record of an authorization it says did not happen. Only a human can say which half is true, so these rows require explicit operator resolution. Refusing rather than clearing the scopes or changing the state on their behalf. First rows: %',
      v_pending, coalesce(v_sample, 'none')
      using errcode = 'integrity_constraint_violation';
  end if;
end;
$$;

-- ===========================================================================
-- 1. THE PRIVATE SCHEMA — NOT REACHABLE FROM ANY CLIENT ROLE
-- ===========================================================================
create schema if not exists private;

-- Belt and braces: `create schema` grants nothing to these roles anyway, but
-- saying so explicitly means a future `grant usage` has to be a deliberate,
-- reviewable line rather than an inherited default nobody noticed.
revoke all on schema private from public;
revoke usage on schema private from anon, authenticated, service_role;

comment on schema private is
  'B02: server-only storage that no client role may reach. No usage grant for anon, authenticated or service_role — the only door is a SECURITY DEFINER function in public, executable by service_role alone.';

-- ===========================================================================
-- 1a. THE STATE B01 DID NOT HAVE A WORD FOR
-- ===========================================================================
-- 0035 wrote its state vocabulary before any credential existed anywhere in the
-- system, and defined:
--
--   pending_authorization  a connection was started; the human has NOT completed
--                          Google's consent screen; NO ACCESS.
--
-- B02 produces a situation that sentence cannot describe. When a creator
-- finishes at Google we hold a verified `sub`, the scope set Google actually
-- approved, and a usable refresh token — and we still have not asked them the
-- product question, because a Google authorization is not a product consent.
-- Reusing `pending_authorization` for that moment would make the database say
-- "the human has not authorized anything and we have no access" about a mailbox
-- we could read this second. That is not a stricter label; it is a false one,
-- and every later reader — support, an export, a deletion routine, an auditor —
-- would inherit the lie.
--
-- So B02 ADDS a state rather than redefining a merged one. 0035 is untouched;
-- this ALTERs the constraint it created, additively, and the two states now
-- divide the ground between them cleanly:
--
--   pending_authorization  Google authorization has NOT completed. No usable
--                          stored refresh credential. No provider access is
--                          represented as current. (0035's meaning, intact.)
--
--   consent_required       Google authorization COMPLETED: the durable provider
--                          identity is verified, an encrypted refresh credential
--                          exists, and `gmail.readonly` is in the approved set —
--                          but no current private-processing consent covers
--                          exactly that scope set, so the product may not
--                          process the mailbox yet.
--
--   connected              all of the above AND a current, exact-scope-matching
--                          private-processing consent. (0035's meaning, intact.)
--
--   reauth_required        the last authorization is no longer usable; no
--                          credential remains.
--
--   disconnecting          the owner has explicitly asked to disconnect, and the
--                          provider side is not finished. New processing is
--                          already forbidden and no access token may be handed
--                          out; the encrypted credential MAY still be present,
--                          for the sole purpose of revoking it at Google. This
--                          is NOT `disconnected` — saying that before the
--                          provider grant is actually gone would be the same
--                          category of lie as the states this migration exists
--                          to fix.
--
--   disconnected           access was intentionally stopped AND the provider
--                          side is resolved; no credential, and an empty scope
--                          set.
--
--   deletion_pending /
--   deleted                0035's meanings, untouched.
alter table public.mail_accounts
  drop constraint mail_accounts_connection_state_check;

alter table public.mail_accounts
  add constraint mail_accounts_connection_state_check
  check (connection_state in
    ('pending_authorization', 'consent_required', 'connected', 'reauth_required',
     'disconnecting', 'disconnected', 'deletion_pending', 'deleted'));

-- ===========================================================================
-- 1b. THE LIFECYCLE REVISION — OAUTH IS A LONG-RUNNING OPERATION TOO
-- ===========================================================================
-- Amendment #2 gave the CREDENTIAL a generation, because a refresh spans a
-- network call and the world can move during it. Authorization spans a much
-- longer one: we write a transaction, hand the browser to Google, and the
-- callback arrives whenever the human gets round to it — minutes later, or after
-- they wandered off, made a cup of tea, and changed their mind.
--
-- The reconnect target was validated against its state AT CALLBACK TIME, which
-- means a newer decision could be overwritten by an older intention:
--
--   1. mailbox A is `reauth_required`;
--   2. the human starts Reconnect A;
--   3. the human changes their mind and DISCONNECTS A — revoked at Google,
--      credential gone, state `disconnected`;
--   4. the old callback finally arrives. `disconnected` is a reconnectable
--      state, so the callback stored a fresh credential and — because the old
--      consent was still on file for the same scope set — put the mailbox
--      straight back to `connected`.
--
-- An explicit Disconnect, undone by an intention that predates it.
--
-- CHECKING THE STATE NAME IS NOT ENOUGH, and this is the part worth being exact
-- about. A mailbox can leave a reconnectable state and come back to it:
--
--   reauth_required (rev 10) -> disconnected (rev 11) -> reauth_required (rev 12)
--
-- A callback pinned at rev 10 finds the state name it expects and is still
-- stale: two lifecycle decisions happened in between that it knows nothing
-- about. So the flow pins the exact REVISION, not the state.
--
-- Database-owned and monotonic, from a sequence. Not a timestamp — amendment #2
-- settled that: equal values collide and clock order is not causal order. Not
-- caller-supplied either: the trigger below overwrites whatever a writer puts
-- there, so a direct SQL lifecycle change invalidates in-flight OAuth exactly
-- like an RPC one does.
create sequence if not exists public.mail_account_authorization_revision_seq;

revoke all on sequence public.mail_account_authorization_revision_seq from public;
revoke all on sequence public.mail_account_authorization_revision_seq from anon, authenticated;
-- service_role holds INSERT/UPDATE on mail_accounts (0035), so it needs to be
-- able to draw the default and the trigger's next value. No client role does.
grant usage, select on sequence public.mail_account_authorization_revision_seq to service_role;

alter table public.mail_accounts
  add column authorization_revision bigint not null
    default nextval('public.mail_account_authorization_revision_seq');

-- THE DURABLE DISCONNECT INTENT.
--
-- The revision alone tells a stale callback that the world moved. It does not
-- tell it WHY, and the difference matters exactly once: when the reason is an
-- explicit human Disconnect of this same Google account, the newly issued grant
-- must be revoked at Google rather than merely dropped — otherwise B02 ends with
-- `disconnected` locally and an ACTIVE authorization at Google, which is not
-- what the human asked for.
--
-- This records the revision created by the most recent explicit disconnect
-- intent. A stale reconnect callback pinned at R was superseded by a Disconnect
-- iff this value is greater than R *and* the mailbox has not been legitimately
-- re-authorized since (see `gmail_connection_persist`). Both halves are needed:
-- without the second, an old callback could revoke a NEWER valid connection the
-- human made after changing their mind again.
alter table public.mail_accounts
  add column disconnect_requested_revision bigint;

comment on column public.mail_accounts.disconnect_requested_revision is
  'B02: the authorization_revision created by the most recent explicit Disconnect intent. Lets a stale reconnect callback tell "superseded by a Disconnect" (revoke the grant it just obtained) from "superseded by something else" (drop it silently).';

comment on column public.mail_accounts.authorization_revision is
  'B02: the lifecycle revision an in-flight OAuth flow pins. Advances whenever a change invalidates an authorization started against the older state — a connection-state transition or a scope-set change. Database-owned and not caller-settable.';

-- WHAT ADVANCES IT, and what deliberately does not.
--
-- A lifecycle decision invalidates a flow started before it, so a
-- `connection_state` transition or a `granted_scopes` change advances the
-- revision. Editing an email address or touching `updated_at` does not: a
-- display-metadata change is not a decision about access, and making every
-- unrelated write invalidate in-flight OAuth would turn a correctness mechanism
-- into a source of spurious failures.
--
-- A SUCCESSFUL EXPLICIT RECONNECT ALSO ADVANCES IT, even when it changes neither
-- the state nor the scope set. Landing a fresh Google credential IS a provider
-- authorization event, and without this two reconnect flows begun against the
-- same version could both land — the second silently replacing the first's
-- credential, each of them "current" by every check available to it.
-- `gmail_connection_persist` REQUESTS that bump; it never supplies a number.
--
-- A background refresh-token rotation is deliberately excluded: it is not a
-- human authorization event, and bumping there would cancel unrelated in-flight
-- OAuth flows for no reason. That is what `credential_generation` is for. Two
-- clocks, two questions.
--
-- THE TRIGGER ALWAYS ASSIGNS THE COLUMN — on INSERT as well as UPDATE — which is
-- what makes "database-owned" true rather than merely intended. A writer who
-- supplies their own value has it overwritten, whichever statement they use.
create or replace function public.bump_mail_account_authorization_revision()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'INSERT' then
    -- The column default would do this for a writer who omits it; assigning it
    -- here covers the writer who does NOT omit it. `mail_accounts` is
    -- trusted-server-only, so this is a contract-truth fix rather than a
    -- cross-user hole — but a contract that is only true when nobody tries is
    -- not a contract.
    new.authorization_revision := nextval('public.mail_account_authorization_revision_seq');
    return new;
  end if;

  if new.connection_state is distinct from old.connection_state
     or new.granted_scopes is distinct from old.granted_scopes
     or coalesce(current_setting('b02.authorization_revision_bump', true), '') = 'requested' then
    new.authorization_revision := nextval('public.mail_account_authorization_revision_seq');
  else
    new.authorization_revision := old.authorization_revision;
  end if;
  return new;
end;
$$;

revoke all on function public.bump_mail_account_authorization_revision() from public;

create trigger mail_accounts_authorization_revision
  before insert or update on public.mail_accounts
  for each row execute function public.bump_mail_account_authorization_revision();

comment on column public.mail_accounts.connection_state is
  'B01 + B02: pending_authorization = Google authorization not completed, no credential. consent_required (B02) = Google authorization completed and a credential exists, but private-processing consent does not cover the granted scope set. connected = both. reauth_required/disconnected = no credential. deletion_pending/deleted per B01.';

-- ===========================================================================
-- 2. THE OAUTH TRANSACTION — SHORT-LIVED, OWNER-BOUND, CONSUMED ONCE
-- ===========================================================================
-- B01 cannot create a mail account before Google tells us the durable `sub`, so
-- an authorization that is in flight has nowhere to live in the public plane.
-- This is that place, and it holds three secrets for a few minutes:
--
--   state    CSRF / request correlation. Stored as a DIGEST only: the raw value
--            travels in the URL and comes back from Google, so what we keep is
--            enough to recognise it and not enough to forge it.
--   nonce    OpenID Connect replay / mix-up protection. Digest, same reasoning.
--   verifier the PKCE code verifier. This one we need back in plaintext to
--            complete the exchange, so unlike the other two it is ENCRYPTED
--            rather than hashed — the same AES-256-GCM envelope the refresh
--            token uses, in a schema no client can read.
create table private.gmail_oauth_transactions (
  id uuid primary key default gen_random_uuid(),

  -- Owner-bound from the moment it is created. The callback must be completed
  -- by the same human who started it; a transaction is not a bearer token.
  user_id uuid not null references public.users(id) on delete cascade,

  state_digest text not null check (state_digest ~ '^[0-9a-f]{64}$'),
  nonce_digest text not null check (nonce_digest ~ '^[0-9a-f]{64}$'),

  code_verifier_ciphertext text not null check (length(code_verifier_ciphertext) > 0),
  code_verifier_iv text not null check (length(code_verifier_iv) > 0),
  code_verifier_auth_tag text not null check (length(code_verifier_auth_tag) > 0),
  encryption_key_version text not null check (length(btrim(encryption_key_version)) > 0),

  --   connect    no mail account exists yet for this provider identity, or we do
  --              not know which one it will turn out to be.
  --   reconnect  the human pointed at a specific mailbox of theirs.
  purpose text not null check (purpose in ('connect', 'reconnect')),

  -- When a reconnect names a target, the composite FK binds it to THIS user's
  -- own mailbox. A transaction cannot be aimed at somebody else's account even
  -- if a caller supplies its id.
  target_mail_account_id uuid,

  -- ...and the lifecycle revision that target had when the flow STARTED. The id
  -- says which mailbox; this says which version of it. Without it, a callback
  -- that arrives after the human disconnected would find a state that happens to
  -- be reconnectable again and quietly undo their decision. Written by
  -- `gmail_oauth_begin` from the row itself — never supplied by a caller.
  target_authorization_revision bigint,

  -- What we asked Google for. Recorded to compare against what Google actually
  -- grants — B01 §11's rule is that the granted set is authoritative and the
  -- requested set is never a substitute for it.
  requested_scopes text[] not null
    constraint gmail_oauth_transactions_scope_allowlist
      check (requested_scopes <@ public.approved_gmail_scopes()),

  -- Where to send the browser afterwards. Same-origin RELATIVE only, enforced
  -- here as well as in the route: an absolute or protocol-relative value is an
  -- open redirect, and this table is one of the places it could hide.
  return_path text
    check (return_path is null
           or (return_path like '/%' and return_path not like '//%')),

  created_at timestamptz not null default now(),
  expires_at timestamptz not null,

  constraint gmail_oauth_transactions_state_uk unique (state_digest),

  constraint gmail_oauth_transactions_target_owned_fk
    foreign key (target_mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade,

  -- PURPOSE AND TARGET ARE THE SAME FACT, WRITTEN TWICE, SO THEY MUST AGREE
  -- EXACTLY. "reconnect implies a target" leaves the other half open, and a
  -- `connect` carrying a target is a transaction whose two fields describe
  -- different flows: the callback would then have to decide which one it meant,
  -- and a caller who can influence that decision can steer where a fresh Google
  -- grant lands. An IFF removes the choice instead of documenting it.
  constraint gmail_oauth_transactions_purpose_target_iff
    check ((purpose = 'connect'
            and target_mail_account_id is null
            and target_authorization_revision is null)
        or (purpose = 'reconnect'
            and target_mail_account_id is not null
            and target_authorization_revision is not null)),

  constraint gmail_oauth_transactions_ttl
    check (expires_at > created_at)
);

create index gmail_oauth_transactions_expiry_idx
  on private.gmail_oauth_transactions (expires_at);
create index gmail_oauth_transactions_user_idx
  on private.gmail_oauth_transactions (user_id);

comment on table private.gmail_oauth_transactions is
  'B02: one in-flight Gmail authorization. Owner-bound, short-lived, consumed once. State and nonce are digests; the PKCE verifier is encrypted because the exchange needs it back.';

-- ===========================================================================
-- 3. THE CREDENTIAL — THE ONLY LONG-LIVED SECRET IN THE SYSTEM
-- ===========================================================================
-- A refresh token, encrypted with AES-256-GCM by the application before it ever
-- reaches the database. The ciphertext, IV, authentication tag and key version
-- are stored; the key is not, and never appears in any table.
--
-- ACCESS TOKENS ARE ABSENT ON PURPOSE, and so are the authorization code, the
-- ID token, the raw state and the raw nonce. An access token lives minutes and
-- belongs in memory; persisting it would multiply the blast radius of this table
-- for no benefit. The others are single-use inputs whose job is over.
create sequence if not exists private.gmail_credential_generation_seq;

comment on sequence private.gmail_credential_generation_seq is
  'B02: the credential concurrency token. Never reissues a number, so a generation identifies one credential for the life of the database even across delete-and-recreate on reconnection.';

create table private.gmail_oauth_credentials (
  -- One credential per mailbox. Not a history: a replaced refresh token
  -- supersedes its predecessor completely, and keeping the old one would be
  -- keeping a live key we have decided to stop using.
  mail_account_id uuid primary key,
  user_id uuid not null,

  refresh_token_ciphertext text not null check (length(refresh_token_ciphertext) > 0),
  refresh_token_iv text not null check (length(refresh_token_iv) > 0),
  refresh_token_auth_tag text not null check (length(refresh_token_auth_tag) > 0),
  encryption_key_version text not null check (length(btrim(encryption_key_version)) > 0),

  -- THE CONCURRENCY TOKEN.
  --
  -- A refresh is: load the credential, call Google, write the result. The middle
  -- step is a network round trip, and in that gap another worker can rotate the
  -- token and the human can disconnect. Writing back by `mail_account_id` alone
  -- makes whatever arrives last authoritative regardless of what it was derived
  -- from, so a slow worker can overwrite a newer credential with an older one,
  -- or delete a token it never saw because the one IT held was rejected.
  --
  -- So every mutation derived from a loaded credential must name the generation
  -- it was derived from, and is refused if that is no longer current.
  --
  -- Deliberately NOT a timestamp: two writes in the same microsecond compare
  -- equal, and clock order is not causal order.
  --
  -- And deliberately a SEQUENCE rather than a per-row counter starting at 1. A
  -- credential is deleted and re-created on every disconnect-then-reconnect, so
  -- a per-row counter would hand the new credential generation 1 again — and a
  -- worker still holding generation 1 from the PREVIOUS authorization would find
  -- its stale value matching, which is precisely the collision this column
  -- exists to make impossible. A sequence never reissues a number, so a
  -- generation identifies a credential for the lifetime of the database.
  credential_generation bigint not null
    default nextval('private.gmail_credential_generation_seq')
    check (credential_generation > 0),

  -- Google's token endpoint can return `refresh_token_expires_in` for
  -- time-based access. `google-auth-library@11.0.2` does not surface it on the
  -- credentials object it hands back, so THE PRODUCTION ADAPTER ALWAYS WRITES
  -- NULL HERE. The column exists because this is where the value belongs when an
  -- adapter can read it, and NULL keeps its usual meaning: "not stated", never
  -- "never expires". B02 does not claim to capture provider refresh-token expiry
  -- metadata — see §14 of the B02 contract.
  provider_refresh_token_expires_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- B01's provenance spine. The credential hangs off the (account, owner) PAIR,
  -- so it cannot lose either, and it cascades with the mailbox and with the
  -- user — deletion stays addressable, which is a restricted-scope obligation
  -- rather than a convenience.
  constraint gmail_oauth_credentials_account_fk
    foreign key (mail_account_id, user_id)
    references public.mail_accounts (id, user_id) on delete cascade
);

create index gmail_oauth_credentials_user_idx
  on private.gmail_oauth_credentials (user_id);

create trigger gmail_oauth_credentials_set_updated_at
  before update on private.gmail_oauth_credentials
  for each row execute function public.set_updated_at();

comment on table private.gmail_oauth_credentials is
  'B02: the encrypted Gmail refresh token, one per mailbox. No access token, no ID token, no authorization code, no raw state or nonce. Unreachable from any client role.';

-- ===========================================================================
-- 3a. THE STATE WORD AND THE CREDENTIAL MUST BE THE SAME FACT
-- ===========================================================================
-- The state vocabulary above is only worth anything if the database enforces it.
-- Left to writer discipline, "connected with no credential" and "disconnected
-- while a live refresh token sits in `private`" are both one forgotten line
-- away, and neither is visible from the public plane — a support answer, an
-- export or a deletion routine would read the state word and be wrong.
--
-- So the correspondence is an invariant, not a convention:
--
--   connected / consent_required   EXACTLY ONE credential row exists.
--   everything else                NO credential row exists.
--
-- Deferred to COMMIT because every legitimate write passes through an
-- intermediate state: `gmail_connection_persist` sets the account row before it
-- inserts the credential, and `gmail_disconnect_finalize` deletes the credential
-- before it moves the state. An immediate check would make the correct order
-- impossible. What has to be coherent is the state that SURVIVES commit.
--
-- Registered on BOTH write origins — the account and the credential — for the
-- reason A04.6 and A05 established the hard way: an invariant enforced from one
-- side can be walked around from the other. Deleting the credential of a
-- `connected` mailbox never touches `mail_accounts`, and inserting one under a
-- `disconnected` mailbox never touches it either.
-- ON EXISTING ROWS: a constraint trigger governs WRITES, so rows already in the
-- table are not re-validated by this migration. That set is empty in any real
-- deployment and provably so: B01 shipped schema only — no route, no action and
-- no function that could create a `mail_accounts` row at all — so no mailbox can
-- have reached `connected` before B02 exists to connect it. The first write to
-- any such row would be refused, which is the correct outcome rather than a
-- silent repair; deleting or rewriting rows from a migration is not something
-- this file is willing to do to make an invariant look true.
create or replace function public.assert_gmail_credential_state_coherent()
returns trigger
language plpgsql
as $$
declare
  account_id uuid;
  account record;
  credential_count integer;
  consent_state text;
  consent_scopes text[];
begin
  -- OLD and NEW are each unassigned outside their own operations, so the row
  -- image is chosen by operation rather than coalesced.
  if tg_table_name = 'mail_accounts' then
    account_id := new.id;
  elsif tg_op = 'DELETE' then
    account_id := old.mail_account_id;
  else
    account_id := new.mail_account_id;
  end if;

  -- FINAL DATABASE STATE, read now. This is also what makes cascades correct
  -- without asking whether one happened: when the owning user or the mailbox row
  -- is erased, PostgreSQL removes the parent first and the credential goes with
  -- it, so by commit there is no account left to be coherent with. A
  -- `pg_trigger_depth()` test would be answering a different question — how we
  -- got here rather than where we ended up — and B01's amendment #3 already
  -- established why that is not proof of anything.
  select m.connection_state, m.granted_scopes into account
    from public.mail_accounts m where m.id = account_id;

  if not found then
    return null;
  end if;

  select count(*)::int into credential_count
    from private.gmail_oauth_credentials c where c.mail_account_id = account_id;

  if account.connection_state in ('connected', 'consent_required') then
    if credential_count <> 1 then
      raise exception
        'mail account % is `%` with % stored credentials. Both states assert that a usable Google authorization is held right now; without exactly one credential the word is a claim about access this system does not have.',
        account_id, account.connection_state, credential_count
        using errcode = 'integrity_constraint_violation';
    end if;
  elsif account.connection_state = 'disconnecting' then
    -- THE ONE STATE THAT MAY GO EITHER WAY, and only because it is transient by
    -- construction. A disconnect that still has to revoke at Google needs the
    -- credential to revoke WITH; a disconnect of a mailbox that never had one
    -- has nothing to keep. What `disconnecting` asserts is that the human has
    -- decided and the provider side is unfinished — not that a usable
    -- authorization is held, which is why no access token is issued from it.
    if credential_count > 1 then
      raise exception
        'mail account % is `disconnecting` with % stored credentials; there is at most one per mailbox.',
        account_id, credential_count
        using errcode = 'integrity_constraint_violation';
    end if;
  elsif credential_count <> 0 then
    raise exception
      'mail account % is `%` while a Gmail refresh credential is still stored for it. Every one of these states asserts that no current provider access is held — a surviving credential means the record says access stopped while the key to resume it is still on disk.',
      account_id, account.connection_state
      using errcode = 'integrity_constraint_violation';
  end if;

  -- `pending_authorization` MEANS THE WHOLE SENTENCE, NOT HALF OF IT.
  --
  -- 0035 defines it as: a connection was started, the human has NOT completed
  -- Google's consent screen, and no provider access is represented as current.
  -- The credential rule above covers "no usable credential". A scope set is the
  -- other half of "no access represented as current" — `granted_scopes` is what
  -- the product reads to answer "what may we do with this mailbox?", and a row
  -- claiming `gmail.readonly` while claiming Google never authorized anything is
  -- two contradictory answers to that question sitting in one row.
  --
  -- `reauth_required` is deliberately NOT subject to this. It retains the last
  -- known scope set by contract, because that records what the human actually
  -- authorized and is what a reconnection is trying to restore. The two states
  -- say different things and must not be collapsed.
  if account.connection_state = 'pending_authorization'
     and cardinality(coalesce(account.granted_scopes, '{}')) <> 0 then
    raise exception
      'mail account % is `pending_authorization` holding scopes %. That state asserts the human never completed Google''s consent screen and no provider access is current; a granted scope set is the record of an authorization that this state says did not happen.',
      account_id, public.canonical_scope_set(account.granted_scopes)
      using errcode = 'integrity_constraint_violation';
  end if;

  if account.connection_state = 'consent_required' then
    -- The state names a mailbox we could read if we were permitted to. Without
    -- the read scope there is nothing being withheld, and the label would be
    -- describing a decision that does not arise.
    if not (public.canonical_scope_set(account.granted_scopes)
            @> array['https://www.googleapis.com/auth/gmail.readonly']::text[]) then
      raise exception
        'mail account % is `consent_required` without `gmail.readonly`. The state means "Google has authorized us to read this mailbox and the human has not yet permitted us to process it"; with no read grant there is no such pending decision.',
        account_id
        using errcode = 'integrity_constraint_violation';
    end if;

    -- ...and it must be genuinely pending. If a current private-processing
    -- consent already covers exactly this scope set, the human HAS decided, and
    -- leaving the mailbox in `consent_required` would ask them again for
    -- permission they already gave — or, worse, hold back processing they
    -- already authorized while the record blames them for not answering.
    select c.state, r.granted_scopes_at_decision
      into consent_state, consent_scopes
      from public.mail_account_consents c
      join public.mail_account_consent_receipts r on r.id = c.current_receipt_id
     where c.mail_account_id = account_id
       and c.consent_kind = 'private_gmail_processing';

    if consent_state = 'granted'
       and consent_scopes is not distinct from public.canonical_scope_set(account.granted_scopes) then
      raise exception
        'mail account % is `consent_required` while holding a granted private_gmail_processing consent for exactly these scopes. The decision this state is waiting for has already been made: the mailbox is `connected`.',
        account_id
        using errcode = 'integrity_constraint_violation';
    end if;
  end if;

  return null;
end;
$$;

revoke all on function public.assert_gmail_credential_state_coherent() from public;

create constraint trigger mail_accounts_credential_coherent
  after insert or update on public.mail_accounts
  deferrable initially deferred
  for each row execute function public.assert_gmail_credential_state_coherent();

-- DELETE included: removing the credential is the whole of one direction of the
-- attack, and it never touches `mail_accounts` for the other trigger to see.
create constraint trigger gmail_oauth_credentials_state_coherent
  after insert or update or delete on private.gmail_oauth_credentials
  deferrable initially deferred
  for each row execute function public.assert_gmail_credential_state_coherent();

-- The consent projection is a third write origin for the `consent_required`
-- half: granting consent without moving the state off `consent_required` would
-- otherwise leave a mailbox permanently asking for a decision already made.
create constraint trigger mail_account_consents_credential_coherent
  after insert or update or delete on public.mail_account_consents
  deferrable initially deferred
  for each row execute function public.assert_gmail_credential_state_coherent();

-- ===========================================================================
-- 4. THE ONLY DOOR — SECURITY DEFINER, service_role ONLY
-- ===========================================================================
-- Every function below sets an explicit `search_path`, so a caller cannot
-- shadow `public` or `private` with a temp schema and redirect a definer-rights
-- function at their own tables.

-- ---------------------------------------------------------------------------
-- 4a. BEGIN — record an authorization that is about to start
-- ---------------------------------------------------------------------------
-- A RECONNECT STARTS AGAINST A REAL STATE, NOT A POSSIBLE FUTURE ONE.
--
-- The target is resolved and validated HERE, and its lifecycle revision is
-- captured from the row itself. Two things follow that did not hold before:
--
--   * a flow cannot BEGIN against a mailbox that is currently `connected` (or
--     retired, or in a deletion state). A caller could otherwise open
--     "Reconnect A" while A was working and hope it became reconnectable later
--     — starting a flow against a state that does not exist yet;
--   * the revision is read from the row, so no caller can supply one. Pinning a
--     value the caller chose would be pinning nothing.
create or replace function public.gmail_oauth_begin(
  p_user_id uuid,
  p_state_digest text,
  p_nonce_digest text,
  p_verifier_ciphertext text,
  p_verifier_iv text,
  p_verifier_auth_tag text,
  p_key_version text,
  p_purpose text,
  p_target_mail_account_id uuid,
  p_requested_scopes text[],
  p_return_path text,
  p_ttl_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_id uuid;
  v_target public.mail_accounts%rowtype;
  v_revision bigint;
begin
  if p_user_id is null then
    raise exception 'gmail_oauth_begin requires an authenticated user'
      using errcode = 'invalid_parameter_value';
  end if;

  if p_purpose = 'reconnect' then
    if p_target_mail_account_id is null then
      return jsonb_build_object('result', 'invalid_target');
    end if;

    -- Owner in the lookup, not compared afterwards. Somebody else's mailbox does
    -- not exist here. `for no key update` so a concurrent lifecycle change
    -- serializes against this read rather than racing it.
    select m.* into v_target
      from public.mail_accounts m
     where m.id = p_target_mail_account_id
       and m.user_id = p_user_id
       and m.provider = 'gmail'
     for no key update;

    if not found then
      return jsonb_build_object('result', 'invalid_target');
    end if;

    if v_target.connection_state not in
       ('disconnected', 'reauth_required', 'pending_authorization', 'consent_required') then
      -- `disconnecting` is excluded deliberately: the human has already decided
      -- to stop, and starting or landing a reconnect against that decision would
      -- be racing them.
      -- `connected` included: a working mailbox is not something to reconnect,
      -- and a flow opened against one would be waiting for a state change it has
      -- no right to anticipate. `deleted` and the deletion states are refused for
      -- B01's terminality reasons.
      return jsonb_build_object(
        'result', 'not_reconnectable',
        'connection_state', v_target.connection_state
      );
    end if;

    v_revision := v_target.authorization_revision;
  end if;

  -- Housekeeping on the way in, so expired rows cannot accumulate unbounded
  -- without a scheduled job existing yet. Cheap: the index is on expires_at.
  delete from private.gmail_oauth_transactions where expires_at <= now();

  insert into private.gmail_oauth_transactions
    (user_id, state_digest, nonce_digest, code_verifier_ciphertext,
     code_verifier_iv, code_verifier_auth_tag, encryption_key_version,
     purpose, target_mail_account_id, target_authorization_revision,
     requested_scopes, return_path, expires_at)
  values
    (p_user_id, p_state_digest, p_nonce_digest, p_verifier_ciphertext,
     p_verifier_iv, p_verifier_auth_tag, p_key_version,
     p_purpose,
     case when p_purpose = 'reconnect' then p_target_mail_account_id end,
     v_revision,
     public.canonical_scope_set(p_requested_scopes), p_return_path,
     now() + make_interval(secs => greatest(p_ttl_seconds, 1)))
  returning id into v_id;

  return jsonb_build_object(
    'result', 'ok',
    'id', v_id,
    'target_authorization_revision', v_revision
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4b. CONSUME — find it, return it, destroy it, in one statement
-- ---------------------------------------------------------------------------
-- `delete ... returning` is the whole point. A replayed callback finds nothing
-- the second time, and there is no window between "we looked it up" and "we
-- marked it used" for a concurrent replay to slip through.
--
-- The user id is part of the WHERE clause, not checked afterwards: a state
-- started by user A cannot be completed by user B, and the reason it fails is
-- that it does not exist for them.
create or replace function public.gmail_oauth_consume_transaction(
  p_user_id uuid,
  p_state_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_row private.gmail_oauth_transactions%rowtype;
begin
  delete from private.gmail_oauth_transactions t
   where t.state_digest = p_state_digest
     and t.user_id = p_user_id
     and t.expires_at > now()
  returning t.* into v_row;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  return jsonb_build_object(
    'result', 'ok',
    'id', v_row.id,
    'nonce_digest', v_row.nonce_digest,
    'code_verifier_ciphertext', v_row.code_verifier_ciphertext,
    'code_verifier_iv', v_row.code_verifier_iv,
    'code_verifier_auth_tag', v_row.code_verifier_auth_tag,
    'encryption_key_version', v_row.encryption_key_version,
    'purpose', v_row.purpose,
    'target_mail_account_id', v_row.target_mail_account_id,
    'target_authorization_revision', v_row.target_authorization_revision,
    'requested_scopes', to_jsonb(v_row.requested_scopes),
    'return_path', v_row.return_path
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4c. PERSIST — the atomic landing point after Google has been satisfied
-- ---------------------------------------------------------------------------
-- Called only once every external check has passed: the code was exchanged, a
-- refresh token exists, the ID token verified, the nonce matched, and a Gmail
-- profile call proved the mailbox is reachable. Everything local happens here,
-- in one transaction, so none of the forbidden intermediate states can survive.
--
-- A RECONNECT IS BOUND TO ITS TARGET BEFORE ANY OF THAT. When the transaction
-- named a mailbox, the returned Google subject must BE that mailbox's subject,
-- and the check happens before the generic cases are even considered. The
-- earlier arrangement — comparing the target only inside the branch where a live
-- row for the returned subject already existed — meant that choosing a DIFFERENT
-- Google account at Google's account picker fell straight through to "identity
-- never seen" and silently created a new mailbox, or to "already connected" for
-- a mailbox the human never asked to touch. "Reconnect A" then quietly meant
-- "connect whatever you picked", which is not a reconnection and not what the
-- human was shown.
--
-- Account selection then obeys B01 exactly, and the four cases are its four:
--   A  provider identity never seen        -> new mail_accounts row
--   B  live row owned by this user         -> REUSE it (never a second live row)
--   C  only retired rows                   -> new row; `deleted` stays terminal
--   D  identity owned by a different user  -> refuse, and say nothing about who
create or replace function public.gmail_connection_persist(
  p_user_id uuid,
  p_provider_account_subject text,
  p_email_address text,
  p_granted_scopes text[],
  p_refresh_ciphertext text,
  p_refresh_iv text,
  p_refresh_auth_tag text,
  p_key_version text,
  p_provider_refresh_expires_at timestamptz,
  p_expected_mail_account_id uuid,
  p_expected_target_revision bigint,
  p_consent_policy_version text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_scopes text[] := public.canonical_scope_set(p_granted_scopes);
  v_registered_owner uuid;
  v_account public.mail_accounts%rowtype;
  v_target public.mail_accounts%rowtype;
  v_mail_account_id uuid;
  v_consent_scopes text[];
  v_consent_state text;
  v_reused boolean := false;
  v_found boolean := false;
begin
  if p_user_id is null or coalesce(btrim(p_provider_account_subject), '') = '' then
    raise exception 'gmail_connection_persist requires a user and a verified provider subject'
      using errcode = 'invalid_parameter_value';
  end if;

  -- The granted set must actually let us read the mailbox. B01 makes this a
  -- CHECK on `connected`; asserting it here as well means we refuse before
  -- storing a credential we would not be allowed to use.
  if not (v_scopes @> array['https://www.googleapis.com/auth/gmail.readonly']::text[]) then
    return jsonb_build_object('result', 'missing_read_scope');
  end if;

  -- ---------------------------------------------------------------------
  -- EXACT RECONNECT BINDING — first, and before any generic case applies.
  -- ---------------------------------------------------------------------
  if p_expected_mail_account_id is not null then
    -- LOCK FIRST, THEN CHECK.
    --
    -- A revision comparison is evidence about the row that was read. It does not
    -- RESERVE that row, and a plpgsql function is VOLATILE, so every statement
    -- inside it takes a fresh snapshot. Without the lock this was a
    -- time-of-check/time-of-use race with a real, reproducible outcome:
    --
    --   callback  SELECT target        -> sees revision N, comparison passes
    --   human     Disconnect           -> revision N+1, COMMIT
    --   callback  UPDATE ... INSERT    -> writes anyway, restoring access
    --
    -- `for no key update` makes the check and the mutation describe the SAME row
    -- version. A concurrent lifecycle write either waits behind us and applies
    -- afterwards, or commits first and is then visible to our locked read, which
    -- fails the comparison. There is no third ordering.
    select m.* into v_target
      from public.mail_accounts m
     where m.id = p_expected_mail_account_id
     for no key update;

    -- Ownership is re-established here rather than trusted from the caller.
    -- The transaction's composite FK already bound the target to this user when
    -- it was created, but this function is the door a credential comes through
    -- and it does not get to assume its inputs were checked upstream.
    if not found or v_target.user_id <> p_user_id or v_target.provider <> 'gmail' then
      return jsonb_build_object('result', 'account_mismatch');
    end if;

    -- A retired mailbox is not a reconnection target. B01's terminality means
    -- the row asserts that stored Gmail data was removed; reviving it would make
    -- that assertion false while the completed deletion request sits underneath
    -- as its evidence. The same human reconnecting the same Google identity
    -- starts a NEW connect flow and gets a NEW row — which is the honest record
    -- of a second, separate grant of access.
    if v_target.connection_state = 'deleted' then
      return jsonb_build_object('result', 'account_retired');
    end if;

    if v_target.connection_state not in
       ('disconnected', 'reauth_required', 'pending_authorization', 'consent_required') then
      -- `disconnecting` is excluded deliberately: the human has already decided
      -- to stop, and starting or landing a reconnect against that decision would
      -- be racing them.
      return jsonb_build_object('result', 'account_mismatch');
    end if;

    -- THE BINDING ITSELF. The human was shown "reconnect this mailbox"; if the
    -- account picker produced a different Google identity, the only truthful
    -- answer is that this is not that mailbox. Never a silent connect.
    if v_target.provider_account_subject <> p_provider_account_subject then
      return jsonb_build_object('result', 'account_mismatch');
    end if;

    -- ...AND IT MUST STILL BE THE SAME VERSION OF THAT MAILBOX.
    --
    -- The state name is not enough. A mailbox can leave a reconnectable state
    -- and return to one — `reauth_required` -> `disconnected` -> `reauth_required`
    -- — and a callback pinned before all of that would find the word it expects
    -- while knowing nothing about the two decisions in between. The revision is
    -- what distinguishes "still the situation I started against" from "a
    -- situation that happens to look similar".
    --
    -- Concretely, this is what stops an OAuth flow the human abandoned from
    -- undoing the Disconnect they chose instead.
    if p_expected_target_revision is null
       or v_target.authorization_revision <> p_expected_target_revision then
      -- WHY IT IS STALE MATTERS, exactly once.
      --
      -- If the reason is an explicit human Disconnect of THIS Google account,
      -- the grant this callback just obtained must be revoked at Google, not
      -- merely dropped: otherwise the human ends with `disconnected` locally and
      -- an ACTIVE authorization at Google, which is not what they asked for.
      -- That is not callback cleanup — it is carrying out the newer instruction.
      --
      -- Both halves of the test are load-bearing. The disconnect intent must be
      -- NEWER than the revision this flow pinned, and the mailbox must not have
      -- been legitimately re-authorized since — otherwise an old callback could
      -- revoke a working connection the human made after changing their mind
      -- again. Any other reason for staleness answers `state_changed` and
      -- revokes nothing, which is amendment #2's rule intact.
      if v_target.disconnect_requested_revision is not null
         and v_target.disconnect_requested_revision > p_expected_target_revision
         and v_target.connection_state in ('disconnecting', 'disconnected') then
        return jsonb_build_object(
          'result', 'superseded_by_disconnect',
          'connection_state', v_target.connection_state
        );
      end if;

      return jsonb_build_object(
        'result', 'state_changed',
        'connection_state', v_target.connection_state
      );
    end if;

    -- A SUCCESSFUL RECONNECT IS ITSELF A LIFECYCLE EVENT, so it consumes the
    -- revision it was authorized against.
    --
    -- Without this, a reconnect that changes neither the state nor the scope set
    -- left the revision untouched — and TWO flows begun against the same version
    -- could both land, the second silently replacing the first's credential.
    -- Both were "current" by every check available to them.
    --
    -- The caller REQUESTS the bump; the trigger chooses the number. Letting the
    -- application supply a revision would make "database-owned" untrue in the
    -- one place it matters most. This is `set local`, so it lasts exactly as
    -- long as this function's transaction.
    --
    -- Deliberately NOT done by `gmail_credential_replace`: a background refresh
    -- rotation is not a human authorization event, and bumping there would
    -- cancel unrelated in-flight OAuth flows for no reason.
    perform set_config('b02.authorization_revision_bump', 'requested', true);
  end if;

  -- CASE D first, because it is the one that must not leak. The registry is
  -- B01's authority on who owns a durable provider identity, retired mailboxes
  -- included, and the answer here carries no user id back to the caller.
  select o.owner_user_id into v_registered_owner
    from public.mail_provider_account_owners o
   where o.provider = 'gmail'
     and o.provider_account_subject = p_provider_account_subject;

  if v_registered_owner is not null and v_registered_owner <> p_user_id then
    return jsonb_build_object('result', 'owned_by_other_user');
  end if;

  -- CASE B — a live row for this identity, owned by this user. `deleted` is
  -- excluded, so a retired mailbox is never revived (CASE C falls through to
  -- the insert below).
  --
  -- For a reconnect this is the row we already LOCKED above, so it is reused
  -- rather than looked up again: a second, unlocked read of the same row could
  -- see a different version and would put the race straight back.
  if p_expected_mail_account_id is not null then
    v_account := v_target;
    v_found := true;
  else
    select m.* into v_account
      from public.mail_accounts m
     where m.provider = 'gmail'
       and m.provider_account_subject = p_provider_account_subject
       and m.user_id = p_user_id
       and m.connection_state <> 'deleted'
     limit 1;
    v_found := found;
  end if;

  if v_found then
    if v_account.connection_state = 'connected' then
      -- Already working. A second generic connect flow must not silently swap
      -- the credential underneath a live connection.
      return jsonb_build_object(
        'result', 'already_connected',
        'mail_account_id', v_account.id
      );
    end if;

    -- A GENERIC CONNECT MAY NOT REVIVE A LIVE ROW.
    --
    -- A connect flow does not know which Google account it will get until the
    -- callback, so it cannot have pinned that mailbox's lifecycle revision at
    -- the start — there was nothing to pin. Letting it reuse an existing
    -- non-deleted row would reintroduce the whole stale-callback problem
    -- through the one door that has no snapshot to check: connect, wander off,
    -- disconnect, and let the old callback restore access.
    --
    -- So the answer is to send the human through the explicit action that DOES
    -- pin a revision. This is a deliberate narrowing of B01's CASE B: a generic
    -- connect now serves an unseen identity, or one whose previous rows are all
    -- terminally `deleted`. Nothing is persisted here.
    if p_expected_mail_account_id is null then
      return jsonb_build_object(
        'result', 'reconnect_required',
        'mail_account_id', v_account.id,
        'connection_state', v_account.connection_state
      );
    end if;

    -- No second target comparison here. The binding above already proved the
    -- returned subject IS this target's subject, and the live-row unique index
    -- means only one row can carry that subject — so a check at this point could
    -- only ever agree, and a second source of truth about the same fact is how
    -- the two drift apart later.
    v_mail_account_id := v_account.id;
    v_reused := true;

    -- `consent_required`, not `pending_authorization`: Google HAS authorized us,
    -- the credential below is about to exist, and the only thing missing is the
    -- product permission. The state has to move before the scopes go on anyway —
    -- B01 requires a disconnected row to hold an EMPTY scope set — and this is
    -- the state that describes where we actually are.
    update public.mail_accounts
       set connection_state = 'consent_required',
           granted_scopes = v_scopes,
           email_address = coalesce(p_email_address, email_address),
           disconnected_at = null,
           last_state_change_at = now()
     where id = v_mail_account_id;
  else
    -- CASE A and CASE C. The claim trigger from B01 registers ownership on
    -- insert, and refuses if this identity belongs to somebody else — the
    -- check above is the friendly answer, this is the binding one.
    insert into public.mail_accounts
      (user_id, provider, provider_account_subject, email_address,
       connection_state, granted_scopes)
    values
      (p_user_id, 'gmail', p_provider_account_subject, p_email_address,
       'consent_required', v_scopes)
    returning id into v_mail_account_id;
  end if;

  -- The credential. One per mailbox; a replacement supersedes completely.
  insert into private.gmail_oauth_credentials
    (mail_account_id, user_id, refresh_token_ciphertext, refresh_token_iv,
     refresh_token_auth_tag, encryption_key_version, provider_refresh_token_expires_at)
  values
    (v_mail_account_id, p_user_id, p_refresh_ciphertext, p_refresh_iv,
     p_refresh_auth_tag, p_key_version, p_provider_refresh_expires_at)
  on conflict (mail_account_id) do update
     set refresh_token_ciphertext = excluded.refresh_token_ciphertext,
         refresh_token_iv = excluded.refresh_token_iv,
         refresh_token_auth_tag = excluded.refresh_token_auth_tag,
         encryption_key_version = excluded.encryption_key_version,
         provider_refresh_token_expires_at = excluded.provider_refresh_token_expires_at,
         -- A reconnection replaces the credential, so it advances the
         -- generation like any other replacement: work in flight against the
         -- old one is stale from this moment.
         credential_generation = nextval('private.gmail_credential_generation_seq'),
         updated_at = now();

  -- MAY WE CONNECT WITHOUT ASKING AGAIN? Only if a consent this mailbox already
  -- holds covers exactly this scope set. B01's rule, restated: a Google grant is
  -- not a product consent, and a consent given about a narrower mailbox does not
  -- describe a wider one.
  select c.state, r.granted_scopes_at_decision
    into v_consent_state, v_consent_scopes
    from public.mail_account_consents c
    join public.mail_account_consent_receipts r on r.id = c.current_receipt_id
   where c.mail_account_id = v_mail_account_id
     and c.consent_kind = 'private_gmail_processing';

  if v_consent_state = 'granted' and v_consent_scopes is not distinct from v_scopes then
    update public.mail_accounts
       set connection_state = 'connected',
           connected_at = now(),
           last_state_change_at = now()
     where id = v_mail_account_id;

    return jsonb_build_object(
      'result', 'connected',
      'mail_account_id', v_mail_account_id,
      'reused_existing_row', v_reused
    );
  end if;

  return jsonb_build_object(
    'result', 'consent_required',
    'mail_account_id', v_mail_account_id,
    'reused_existing_row', v_reused,
    'policy_version', p_consent_policy_version
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4d. CONSENT — the product decision, separate from the Google one
-- ---------------------------------------------------------------------------
-- The scope snapshot is taken FROM THE ACCOUNT, never from the caller. B01
-- checks the same thing at COMMIT; doing it here too means the receipt is right
-- by construction rather than right because the writer remembered.
create or replace function public.gmail_grant_private_processing_consent(
  p_user_id uuid,
  p_mail_account_id uuid,
  p_policy_version text,
  p_consent_text_digest text,
  p_receipt_digest text
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_account public.mail_accounts%rowtype;
  v_receipt_id uuid;
  v_event_seq bigint;
  v_has_credential boolean;
begin
  select m.* into v_account
    from public.mail_accounts m
   where m.id = p_mail_account_id
     and m.user_id = p_user_id
   for no key update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_account.connection_state = 'deleted' then
    return jsonb_build_object('result', 'account_retired');
  end if;

  -- Consent authorizes processing. Without a stored credential there is nothing
  -- to process with, and `connected` would be a claim we cannot honour.
  select exists (
    select 1 from private.gmail_oauth_credentials c where c.mail_account_id = p_mail_account_id
  ) into v_has_credential;

  if not v_has_credential then
    return jsonb_build_object('result', 'no_credential');
  end if;

  insert into public.mail_account_consent_receipts
    (mail_account_id, user_id, consent_kind, decision, policy_version,
     consent_text_digest, granted_scopes_at_decision, decided_by_user_id,
     decided_at, receipt_digest)
  values
    (p_mail_account_id, p_user_id, 'private_gmail_processing', 'granted',
     p_policy_version, p_consent_text_digest, v_account.granted_scopes,
     p_user_id, now(), p_receipt_digest)
  returning id, event_seq into v_receipt_id, v_event_seq;

  insert into public.mail_account_consents
    (mail_account_id, user_id, consent_kind, state, current_receipt_id, current_event_seq)
  values
    (p_mail_account_id, p_user_id, 'private_gmail_processing', 'granted',
     v_receipt_id, v_event_seq)
  on conflict (mail_account_id, consent_kind) do update
     set state = excluded.state,
         current_receipt_id = excluded.current_receipt_id,
         current_event_seq = excluded.current_event_seq;

  update public.mail_accounts
     set connection_state = 'connected',
         connected_at = now(),
         last_state_change_at = now()
   where id = p_mail_account_id;

  return jsonb_build_object(
    'result', 'connected',
    'mail_account_id', p_mail_account_id,
    'receipt_id', v_receipt_id
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4e. LOAD — hand the ciphertext to trusted server code, and nothing else
-- ---------------------------------------------------------------------------
-- Deliberately returns the ENVELOPE, not a token: decryption happens in the
-- application, in memory, with a key the database has never seen.
create or replace function public.gmail_credential_load(
  p_mail_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_account public.mail_accounts%rowtype;
  v_cred private.gmail_oauth_credentials%rowtype;
begin
  select m.* into v_account from public.mail_accounts m where m.id = p_mail_account_id;
  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_account.connection_state <> 'connected' then
    return jsonb_build_object('result', 'not_connected', 'connection_state', v_account.connection_state);
  end if;

  -- The consent is checked HERE, not only where the token is used, so that a
  -- withdrawal takes effect at the one place every future caller passes through.
  if not public.mail_account_has_consent(p_mail_account_id, 'private_gmail_processing') then
    return jsonb_build_object('result', 'consent_missing');
  end if;

  select c.* into v_cred
    from private.gmail_oauth_credentials c
   where c.mail_account_id = p_mail_account_id;

  if not found then
    return jsonb_build_object('result', 'no_credential');
  end if;

  -- The generation travels WITH the envelope. Everything derived from this
  -- credential names it when it writes back, so a mutation cannot be applied to
  -- a credential that is no longer the one it was derived from.
  return jsonb_build_object(
    'result', 'ok',
    'user_id', v_cred.user_id,
    'credential_generation', v_cred.credential_generation,
    'refresh_token_ciphertext', v_cred.refresh_token_ciphertext,
    'refresh_token_iv', v_cred.refresh_token_iv,
    'refresh_token_auth_tag', v_cred.refresh_token_auth_tag,
    'encryption_key_version', v_cred.encryption_key_version
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4e-bis. LOAD FOR AN OWNER — the surface a USER-INITIATED action must use
-- ---------------------------------------------------------------------------
-- `gmail_credential_load` above takes no user id, because a background job in
-- B03 will hold a mailbox id it derived itself and has no session to check
-- against. That is defensible for a trusted internal caller and indefensible for
-- anything reached from a browser: Disconnect passes a `mail_account_id` that
-- came from a form, and loading the credential first and comparing owners
-- afterwards means the secret boundary was crossed on the strength of untrusted
-- input. The comparison happening a line later does not un-cross it.
--
-- So a user-initiated action uses THIS function, where the owner is part of the
-- lookup rather than a check applied to its result. A stranger's mailbox id
-- returns `not_found`, and the envelope is never assembled at all.
--
-- Unlike the internal loader, this one does NOT require `connected`: disconnect
-- has to be able to revoke a credential belonging to a mailbox that is merely
-- `consent_required`. That grant is live at Google, and a disconnect that
-- quietly skipped revoking it would leave the human's mailbox authorized to an
-- application whose UI told them they had stopped it.
create or replace function public.gmail_credential_load_for_owner(
  p_user_id uuid,
  p_mail_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_state text;
  v_cred private.gmail_oauth_credentials%rowtype;
begin
  if p_user_id is null then
    raise exception 'gmail_credential_load_for_owner requires an authenticated user'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Owner in the WHERE clause. Somebody else's mailbox does not exist here.
  select m.connection_state into v_state
    from public.mail_accounts m
   where m.id = p_mail_account_id
     and m.user_id = p_user_id;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  select c.* into v_cred
    from private.gmail_oauth_credentials c
   where c.mail_account_id = p_mail_account_id
     and c.user_id = p_user_id;

  if not found then
    return jsonb_build_object('result', 'no_credential', 'connection_state', v_state);
  end if;

  return jsonb_build_object(
    'result', 'ok',
    'connection_state', v_state,
    'credential_generation', v_cred.credential_generation,
    'refresh_token_ciphertext', v_cred.refresh_token_ciphertext,
    'refresh_token_iv', v_cred.refresh_token_iv,
    'refresh_token_auth_tag', v_cred.refresh_token_auth_tag,
    'encryption_key_version', v_cred.encryption_key_version
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4f. ROTATE — compare-and-swap, because a refresh spans a network call
-- ---------------------------------------------------------------------------
-- Google occasionally hands back a replacement refresh token. Writing it by
-- `mail_account_id` alone made whichever worker finished last authoritative
-- regardless of what it had derived its result from: two workers that both
-- loaded generation 1 could each store their own successor, and the slower one
-- would silently replace the faster one's newer credential with a value derived
-- from a token Google had already rotated away.
--
-- So the caller names the generation it loaded, and the update happens only if
-- that is still the current one. It also re-checks that the mailbox is still
-- connected and still consented: a refresh that began while the human was
-- permitted must not land after they withdrew.
create or replace function public.gmail_credential_replace(
  p_mail_account_id uuid,
  p_expected_generation bigint,
  p_refresh_ciphertext text,
  p_refresh_iv text,
  p_refresh_auth_tag text,
  p_key_version text,
  p_provider_refresh_expires_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_state text;
  v_generation bigint;
begin
  if p_expected_generation is null then
    raise exception 'gmail_credential_replace requires the generation the caller loaded'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Lock the mailbox first, so two concurrent CAS attempts serialize here rather
  -- than racing on the credential row.
  select m.connection_state into v_state
    from public.mail_accounts m where m.id = p_mail_account_id for no key update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_state <> 'connected'
     or not public.mail_account_has_consent(p_mail_account_id, 'private_gmail_processing') then
    -- The world moved while we were talking to Google. Storing a fresh
    -- credential for a mailbox that is no longer connected or no longer
    -- permitted would re-arm access the human just stopped.
    return jsonb_build_object('result', 'state_changed', 'connection_state', v_state);
  end if;

  select c.credential_generation into v_generation
    from private.gmail_oauth_credentials c
   where c.mail_account_id = p_mail_account_id;

  if not found then
    return jsonb_build_object('result', 'no_credential');
  end if;

  if v_generation <> p_expected_generation then
    -- Somebody else rotated it. Their credential is newer than anything this
    -- caller can produce, so it stays.
    return jsonb_build_object(
      'result', 'stale_credential',
      'current_generation', v_generation,
      'expected_generation', p_expected_generation
    );
  end if;

  update private.gmail_oauth_credentials
     set refresh_token_ciphertext = p_refresh_ciphertext,
         refresh_token_iv = p_refresh_iv,
         refresh_token_auth_tag = p_refresh_auth_tag,
         encryption_key_version = p_key_version,
         provider_refresh_token_expires_at = p_provider_refresh_expires_at,
         credential_generation = nextval('private.gmail_credential_generation_seq'),
         updated_at = now()
   where mail_account_id = p_mail_account_id
     and credential_generation = p_expected_generation
  returning credential_generation into v_generation;

  if not found then
    return jsonb_build_object('result', 'stale_credential');
  end if;

  return jsonb_build_object('result', 'ok', 'credential_generation', v_generation);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4f-bis. CURRENTNESS — the last thing checked before a token is handed over
-- ---------------------------------------------------------------------------
-- A refresh spans a network call, and a human can disconnect during it. Handing
-- back an access token obtained under an authorization that has since been
-- withdrawn is the one outcome the whole consent apparatus exists to prevent.
--
-- This does NOT claim to be a distributed lock over B03's future Gmail calls —
-- nothing at this layer could be. It establishes the strongest honest handoff:
-- this token was still authorized by our current local state immediately before
-- we handed it over. B03 adds its own job-level cancellation on top.
create or replace function public.gmail_credential_currentness(
  p_mail_account_id uuid,
  p_expected_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_state text;
  v_generation bigint;
begin
  select m.connection_state into v_state
    from public.mail_accounts m where m.id = p_mail_account_id;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_state <> 'connected' then
    return jsonb_build_object('result', 'state_changed', 'connection_state', v_state);
  end if;

  if not public.mail_account_has_consent(p_mail_account_id, 'private_gmail_processing') then
    return jsonb_build_object('result', 'consent_missing');
  end if;

  select c.credential_generation into v_generation
    from private.gmail_oauth_credentials c
   where c.mail_account_id = p_mail_account_id;

  if not found then
    return jsonb_build_object('result', 'no_credential');
  end if;

  if v_generation <> p_expected_generation then
    return jsonb_build_object(
      'result', 'stale_credential',
      'current_generation', v_generation,
      'expected_generation', p_expected_generation
    );
  end if;

  return jsonb_build_object('result', 'ok', 'credential_generation', v_generation);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4g. REAUTH REQUIRED — a permanently unusable refresh token
-- ---------------------------------------------------------------------------
-- Normal lifecycle, not corruption: users revoke at Google, passwords change,
-- Testing-mode grants lapse after about a week. The credential goes because it
-- cannot be used; the consent history and the ownership reservation stay,
-- because neither of them stopped being true.
create or replace function public.gmail_mark_reauth_required(
  p_mail_account_id uuid,
  p_expected_generation bigint
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_state text;
  v_generation bigint;
begin
  if p_expected_generation is null then
    raise exception 'gmail_mark_reauth_required requires the generation that actually failed'
      using errcode = 'invalid_parameter_value';
  end if;

  select connection_state into v_state
    from public.mail_accounts where id = p_mail_account_id for no key update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- IT MUST STILL BE THE SITUATION THE FAILURE WAS ABOUT.
  --
  -- This is destructive — it deletes a credential and moves the mailbox — so it
  -- may only act on the exact state that produced the `invalid_grant`. Without
  -- these checks a slow worker holding a long-dead token could delete a
  -- credential somebody else had just stored, or drag a mailbox the human had
  -- deliberately DISCONNECTED back to `reauth_required`, which reads as "we
  -- would like you to reconnect" about a decision they already made.
  if v_state <> 'connected'
     or not public.mail_account_has_consent(p_mail_account_id, 'private_gmail_processing') then
    return jsonb_build_object('result', 'state_changed', 'connection_state', v_state);
  end if;

  select c.credential_generation into v_generation
    from private.gmail_oauth_credentials c
   where c.mail_account_id = p_mail_account_id;

  if not found then
    -- Already gone. Nothing to destroy, and nothing this caller knows makes it
    -- right to move the mailbox.
    return jsonb_build_object('result', 'no_credential');
  end if;

  if v_generation <> p_expected_generation then
    -- The token that failed is not the token on disk. A newer one exists and
    -- has not been shown to be dead.
    return jsonb_build_object(
      'result', 'stale_credential',
      'current_generation', v_generation,
      'expected_generation', p_expected_generation
    );
  end if;

  delete from private.gmail_oauth_credentials
   where mail_account_id = p_mail_account_id
     and credential_generation = p_expected_generation;

  if not found then
    return jsonb_build_object('result', 'stale_credential');
  end if;

  -- `reauth_required` keeps the scope set: it records what the human last
  -- authorized, which is what a reconnection is trying to restore. Only
  -- `disconnected` and the deletion states must be empty (B01).
  update public.mail_accounts
     set connection_state = 'reauth_required',
         last_state_change_at = now()
   where id = p_mail_account_id;

  return jsonb_build_object('result', 'ok');
end;
$$;

-- ---------------------------------------------------------------------------
-- 4g-bis. DISCONNECT PREPARE — record the intention BEFORE talking to Google
-- ---------------------------------------------------------------------------
-- The two-phase disconnect (revoke, then finalize) had no durable fact saying
-- "a Disconnect is now the newest human intention" during the network gap. So a
-- reconnect flow started earlier could still consume its transaction, exchange
-- its code, and hand Google a fresh grant AFTER the human had disconnected —
-- ending with `disconnected` locally and an active authorization at Google.
--
-- This runs first and closes that from both directions:
--
--   * it CANCELS unconsumed reconnect transactions for this mailbox, so a
--     callback that has not started yet finds no valid state and never exchanges
--     its code. That removes the simple sequential case entirely rather than
--     cleaning up after it;
--   * it records the intent durably — a new revision, and the revision itself
--     stored in `disconnect_requested_revision` — so a callback that ALREADY
--     consumed its transaction and is mid-exchange can later prove it was
--     superseded by a Disconnect specifically, and revoke what it obtained.
--
-- The state becomes `disconnecting`, not `disconnected`: the provider side is
-- not resolved yet, and saying otherwise would be the same kind of false
-- statement the rest of this migration exists to prevent. The credential is
-- deliberately KEPT — it is the only thing that can revoke the grant.
create or replace function public.gmail_disconnect_prepare(
  p_user_id uuid,
  p_mail_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_account public.mail_accounts%rowtype;
  v_cred private.gmail_oauth_credentials%rowtype;
  v_cancelled integer;
begin
  if p_user_id is null then
    raise exception 'gmail_disconnect_prepare requires an authenticated user'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Owner inside the lookup, and the row held for the whole transaction.
  select m.* into v_account
    from public.mail_accounts m
   where m.id = p_mail_account_id
     and m.user_id = p_user_id
   for no key update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  -- A DELETION OWNS THE LIFECYCLE WHILE IT RUNS.
  --
  -- `deletion_pending` means a specific deletion request is outstanding and the
  -- account surface is telling the human so. A user-facing Disconnect that
  -- moved it to `disconnected` would stop that message while the request was
  -- still running, and would clear the pointer the claim rests on. Access has
  -- already stopped in that state, so Disconnect has nothing to add — it is
  -- refused rather than quietly rewriting somebody else's lifecycle.
  if v_account.connection_state = 'deletion_pending' then
    return jsonb_build_object('result', 'deletion_in_progress',
                              'connection_state', v_account.connection_state);
  end if;

  if v_account.connection_state = 'deleted' then
    return jsonb_build_object('result', 'account_retired');
  end if;

  if v_account.connection_state = 'disconnected' then
    -- Already where the human wanted to be. Idempotent, and no new intent is
    -- recorded: there is nothing in flight left to supersede.
    return jsonb_build_object('result', 'already_disconnected');
  end if;

  -- CANCEL WHAT HAS NOT STARTED. An unconsumed reconnect transaction for this
  -- mailbox is an older intention that must not be allowed to complete.
  with cancelled as (
    delete from private.gmail_oauth_transactions t
     where t.user_id = p_user_id
       and t.target_mail_account_id = p_mail_account_id
    returning 1
  )
  select count(*)::int into v_cancelled from cancelled;

  -- Record the intent. The trigger picks the number; asking for the bump is all
  -- this function may do, and the revision it produces is then stored as the
  -- disconnect marker so a mid-flight callback can compare against it.
  perform set_config('b02.authorization_revision_bump', 'requested', true);
  update public.mail_accounts
     set connection_state = 'disconnecting',
         last_state_change_at = now()
   where id = p_mail_account_id;

  update public.mail_accounts
     set disconnect_requested_revision = authorization_revision
   where id = p_mail_account_id
  returning * into v_account;

  select c.* into v_cred
    from private.gmail_oauth_credentials c
   where c.mail_account_id = p_mail_account_id
     and c.user_id = p_user_id;

  if not found then
    return jsonb_build_object(
      'result', 'ok',
      'cancelled_transactions', v_cancelled,
      'disconnect_revision', v_account.disconnect_requested_revision,
      'has_credential', false
    );
  end if;

  return jsonb_build_object(
    'result', 'ok',
    'cancelled_transactions', v_cancelled,
    'disconnect_revision', v_account.disconnect_requested_revision,
    'has_credential', true,
    'refresh_token_ciphertext', v_cred.refresh_token_ciphertext,
    'refresh_token_iv', v_cred.refresh_token_iv,
    'refresh_token_auth_tag', v_cred.refresh_token_auth_tag,
    'encryption_key_version', v_cred.encryption_key_version
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4h. DISCONNECT FINALIZE — local half of a revocation that already succeeded
-- ---------------------------------------------------------------------------
-- Called ONLY after Google has confirmed the token is gone or already invalid.
-- Idempotent on purpose: if the previous attempt revoked at Google and then
-- failed locally, running it again completes the job rather than reporting a
-- state nobody can reach.
--
-- Disconnect is not delete. The mailbox row, the consent history, the ownership
-- reservation and any Gmail-derived workspace data all remain — B01 is explicit
-- that stopping access and removing data are different acts.
create or replace function public.gmail_disconnect_finalize(
  p_user_id uuid,
  p_mail_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_account public.mail_accounts%rowtype;
begin
  select m.* into v_account
    from public.mail_accounts m
   where m.id = p_mail_account_id
     and m.user_id = p_user_id
   for no key update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;

  if v_account.connection_state = 'deleted' then
    return jsonb_build_object('result', 'account_retired');
  end if;

  -- The deletion executor owns that lifecycle; B02's Disconnect does not.
  if v_account.connection_state = 'deletion_pending' then
    return jsonb_build_object('result', 'deletion_in_progress',
                              'connection_state', v_account.connection_state);
  end if;

  delete from private.gmail_oauth_credentials where mail_account_id = p_mail_account_id;

  if v_account.connection_state = 'disconnected' then
    -- Already there. Re-running after a partial failure must succeed.
    return jsonb_build_object('result', 'ok', 'already_disconnected', true);
  end if;

  update public.mail_accounts
     set connection_state = 'disconnected',
         granted_scopes = '{}',
         disconnected_at = now(),
         last_state_change_at = now()
   where id = p_mail_account_id;

  return jsonb_build_object('result', 'ok', 'already_disconnected', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4i. STATUS — what the account surface may show its owner
-- ---------------------------------------------------------------------------
-- Reports WHETHER a credential exists, never anything about it.
create or replace function public.gmail_connection_status(
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
begin
  return coalesce(
    (select jsonb_agg(
        jsonb_build_object(
          'mail_account_id', m.id,
          'email_address', m.email_address,
          'connection_state', m.connection_state,
          'granted_scopes', to_jsonb(m.granted_scopes),
          'connected_at', m.connected_at,
          'has_credential', exists (
            select 1 from private.gmail_oauth_credentials c where c.mail_account_id = m.id),
          'private_processing_consent',
            public.mail_account_has_consent(m.id, 'private_gmail_processing'),
          'network_contribution_consent',
            public.mail_account_has_consent(m.id, 'network_intelligence_contribution')
        ) order by m.created_at)
       from public.mail_accounts m
      where m.user_id = p_user_id
        and m.provider = 'gmail'
        and m.connection_state <> 'deleted'),
    '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- 5. EXECUTE PRIVILEGES — service_role AND NOBODY ELSE
-- ===========================================================================
-- 0024 revokes default function privileges from anon/authenticated, and 0018/0019
-- established that hosted Supabase projects may grant EXECUTE to client roles by
-- default. Both are repeated explicitly here: these functions are definer-rights
-- doors into a schema no client may enter, so an accidental grant would be the
-- whole boundary.
do $$
declare
  fn text;
begin
  foreach fn in array array[
    'public.gmail_oauth_begin(uuid,text,text,text,text,text,text,text,uuid,text[],text,integer)',
    'public.gmail_oauth_consume_transaction(uuid,text)',
    'public.gmail_connection_persist(uuid,text,text,text[],text,text,text,text,timestamptz,uuid,bigint,text)',
    'public.gmail_grant_private_processing_consent(uuid,uuid,text,text,text)',
    'public.gmail_credential_load(uuid)',
    'public.gmail_credential_load_for_owner(uuid,uuid)',
    'public.gmail_credential_replace(uuid,bigint,text,text,text,text,timestamptz)',
    'public.gmail_credential_currentness(uuid,bigint)',
    'public.gmail_mark_reauth_required(uuid,bigint)',
    'public.gmail_disconnect_prepare(uuid,uuid)',
    'public.gmail_disconnect_finalize(uuid,uuid)',
    'public.gmail_connection_status(uuid)'
  ] loop
    execute format('revoke all on function %s from public, anon, authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$$;

-- ===========================================================================
-- 6. WHAT 0036 DOES NOT CREATE
-- ===========================================================================
-- No message, thread, attachment, label, sync, history or import table. No
-- classification, no aggregate, no hotel matching. No Gmail send capability —
-- `gmail.send` stays outside the requested set until a human activates a feature
-- that needs it, through incremental authorization, under B01's rule that
-- widening scopes requires renewing private-processing consent.
--
-- AND IT ENROLS NOBODY: this file connects no Gmail account, opens no OAuth
-- transaction, stores no credential and infers no consent.
