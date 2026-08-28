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
--   disconnected           access was intentionally stopped; no credential, and
--                          an empty scope set.
--
--   deletion_pending /
--   deleted                0035's meanings, untouched.
alter table public.mail_accounts
  drop constraint mail_accounts_connection_state_check;

alter table public.mail_accounts
  add constraint mail_accounts_connection_state_check
  check (connection_state in
    ('pending_authorization', 'consent_required', 'connected', 'reauth_required',
     'disconnected', 'deletion_pending', 'deleted'));

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
    check ((purpose = 'connect' and target_mail_account_id is null)
        or (purpose = 'reconnect' and target_mail_account_id is not null)),

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

  -- Google returns this only sometimes. NULL means "not stated", never "never
  -- expires" — the unknown-vs-zero distinction this codebase keeps everywhere.
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
  elsif credential_count <> 0 then
    raise exception
      'mail account % is `%` while a Gmail refresh credential is still stored for it. Every one of these states asserts that no current provider access is held — a surviving credential means the record says access stopped while the key to resume it is still on disk.',
      account_id, account.connection_state
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
returns uuid
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_id uuid;
begin
  if p_user_id is null then
    raise exception 'gmail_oauth_begin requires an authenticated user'
      using errcode = 'invalid_parameter_value';
  end if;

  -- Housekeeping on the way in, so expired rows cannot accumulate unbounded
  -- without a scheduled job existing yet. Cheap: the index is on expires_at.
  delete from private.gmail_oauth_transactions where expires_at <= now();

  insert into private.gmail_oauth_transactions
    (user_id, state_digest, nonce_digest, code_verifier_ciphertext,
     code_verifier_iv, code_verifier_auth_tag, encryption_key_version,
     purpose, target_mail_account_id, requested_scopes, return_path, expires_at)
  values
    (p_user_id, p_state_digest, p_nonce_digest, p_verifier_ciphertext,
     p_verifier_iv, p_verifier_auth_tag, p_key_version,
     p_purpose, p_target_mail_account_id,
     public.canonical_scope_set(p_requested_scopes), p_return_path,
     now() + make_interval(secs => greatest(p_ttl_seconds, 1)))
  returning id into v_id;

  return v_id;
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
    select m.* into v_target
      from public.mail_accounts m
     where m.id = p_expected_mail_account_id;

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
      return jsonb_build_object('result', 'account_mismatch');
    end if;

    -- THE BINDING ITSELF. The human was shown "reconnect this mailbox"; if the
    -- account picker produced a different Google identity, the only truthful
    -- answer is that this is not that mailbox. Never a silent connect.
    if v_target.provider_account_subject <> p_provider_account_subject then
      return jsonb_build_object('result', 'account_mismatch');
    end if;
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
  select m.* into v_account
    from public.mail_accounts m
   where m.provider = 'gmail'
     and m.provider_account_subject = p_provider_account_subject
     and m.user_id = p_user_id
     and m.connection_state <> 'deleted'
   limit 1;

  if found then
    if v_account.connection_state = 'connected' then
      -- Already working. A second generic connect flow must not silently swap
      -- the credential underneath a live connection.
      return jsonb_build_object(
        'result', 'already_connected',
        'mail_account_id', v_account.id
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

  return jsonb_build_object(
    'result', 'ok',
    'user_id', v_cred.user_id,
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
    'refresh_token_ciphertext', v_cred.refresh_token_ciphertext,
    'refresh_token_iv', v_cred.refresh_token_iv,
    'refresh_token_auth_tag', v_cred.refresh_token_auth_tag,
    'encryption_key_version', v_cred.encryption_key_version
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4f. ROTATE — Google occasionally hands back a replacement refresh token
-- ---------------------------------------------------------------------------
create or replace function public.gmail_credential_replace(
  p_mail_account_id uuid,
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
begin
  update private.gmail_oauth_credentials
     set refresh_token_ciphertext = p_refresh_ciphertext,
         refresh_token_iv = p_refresh_iv,
         refresh_token_auth_tag = p_refresh_auth_tag,
         encryption_key_version = p_key_version,
         provider_refresh_token_expires_at = p_provider_refresh_expires_at,
         updated_at = now()
   where mail_account_id = p_mail_account_id;

  if not found then
    return jsonb_build_object('result', 'no_credential');
  end if;
  return jsonb_build_object('result', 'ok');
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
  p_mail_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_state text;
begin
  select connection_state into v_state
    from public.mail_accounts where id = p_mail_account_id for no key update;

  if not found then
    return jsonb_build_object('result', 'not_found');
  end if;
  if v_state = 'deleted' then
    return jsonb_build_object('result', 'account_retired');
  end if;

  delete from private.gmail_oauth_credentials where mail_account_id = p_mail_account_id;

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
    'public.gmail_connection_persist(uuid,text,text,text[],text,text,text,text,timestamptz,uuid,text)',
    'public.gmail_grant_private_processing_consent(uuid,uuid,text,text,text)',
    'public.gmail_credential_load(uuid)',
    'public.gmail_credential_load_for_owner(uuid,uuid)',
    'public.gmail_credential_replace(uuid,text,text,text,text,timestamptz)',
    'public.gmail_mark_reauth_required(uuid)',
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
