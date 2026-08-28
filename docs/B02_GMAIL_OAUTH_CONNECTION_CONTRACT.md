# B02 — Gmail OAuth connection, reconnect and disconnect

Status: implemented in PR (unmerged). Migration `0036_gmail_oauth_connection.sql`.
Depends on: [`B01_GMAIL_DATA_BOUNDARY_CONTRACT.md`](B01_GMAIL_DATA_BOUNDARY_CONTRACT.md),
migration `0035`, decision D067.

---

## 1. The one question this layer answers

> **How does an authenticated app user securely authorize a real Gmail account,
> prove which Google account it is, persist only the minimum long-lived
> credential needed for later server-side sync, and later reconnect or disconnect
> it without breaking B01's ownership, consent and privacy guarantees?**

B01 drew the boundary and deliberately stored no credential. B02 is where the
first long-lived secret in this system actually appears, which is why almost
everything below is about where it lives, who can reach it, and what happens when
it stops working.

**B02 supports:** connect · reconnect · disconnect · refresh, including detecting
that a stored credential has permanently died.

**B02 does not support, and does not partially implement:** historical email
import, message listing, thread ingestion, attachments, classification, hotel
matching, outreach intelligence, network aggregates, or sending mail. B03 begins
historical import.

---

## 2. The flow: authorization code, server-side

OAuth 2.0 **authorization code** flow for a confidential web-server client. The
browser is redirected to Google, Google returns a code to our backend callback,
and the backend exchanges it. No implicit/token flow; no token ever reaches
client JavaScript.

### What B02 requests

| scope | why |
|---|---|
| `openid` | which Google account this is |
| `.../auth/userinfo.email` | the address, for display |
| `.../auth/gmail.readonly` | **restricted** — historical analysis needs message bodies |

`gmail.metadata` is not a lighter-touch substitute: it returns no body and cannot
be searched with `q`, so it is a different and insufficient capability that
carries the same verification burden.

**`gmail.send` is not requested.** It is sensitive, nothing in B02 sends mail, and
asking for a permission before a feature needs it is how a consent screen becomes
something people click past. It arrives later through incremental authorization —
and under B01, widening the granted set requires a **renewed private-processing
consent**, not merely a second Google prompt. Everything broader
(`gmail.modify`, `gmail.compose`, `gmail.insert`, `mail.google.com`, the settings
scopes) is refused by the database allow-list, on both the account side and the
consent side.

### Offline access, and why the consent prompt is forced

`access_type=offline`, because B03/B08 sync while the human is not using the app.
A usable connection therefore **requires a refresh token**; an access token alone
is not a connected state, and B02 refuses a grant that does not include one.

Google returns a refresh token on first offline authorization and may not on
later ones unless consent is prompted again. Connect and reconnect both need a
storable refresh token to succeed, so both set `prompt=consent` deliberately.
This is not a loop: each is a single user-initiated action, and nothing retries
authorization automatically.

### The granted set is authoritative

Google may return less than we asked for, and — with `include_granted_scopes` —
previously-approved scopes we did not ask for. B02 persists **the actual granted
set**, never the requested one, and refuses the connection if it lacks
`gmail.readonly` or contains anything outside the approved vocabulary.

### Redirect URI

Exact, absolute, HTTPS in production, configured server-side. It is never taken
from the request, so there is no caller-controlled redirect and no open redirect.
The post-callback destination is a **relative same-origin path** stored in the
transaction — validated in the route and again by a CHECK constraint.

---

## 3. Identity: the verified `sub`, never the email

The durable provider identity stays exactly B01's `(provider, provider_account_subject)`,
where the subject is the **verified OpenID Connect `sub` claim**.

The ID token is cryptographically verified server-side with Google's official
library (`google-auth-library@11.0.2`): signature against Google's published
keys, issuer, audience equal to our configured client, and expiry. A merely
decoded JWT is attacker-controlled JSON, and this is the step that decides which
Google account a mailbox is bound to.

The email address is display and routing metadata. It can be renamed, aliased or
reassigned to a different human, and keying on it would eventually attach one
person's mailbox history to another's.

---

## 4. State, PKCE and nonce — all three

| | purpose | how it is stored |
|---|---|---|
| **state** | CSRF / request correlation | SHA-256 **digest** only |
| **nonce** | OIDC replay and mix-up protection | SHA-256 **digest** only |
| **PKCE verifier** (S256) | binds the code to this client | **encrypted**, because the exchange needs it back |

State and nonce are hashed because the raw values travel in the URL: what we keep
is enough to recognise them and not enough to forge one. The verifier is the
exception — the token exchange needs the plaintext — so it gets the same
AES-256-GCM envelope as the refresh token, in a schema no client can read.

The transaction is **owner-bound, short-lived (10 minutes) and consumed once**.
Consumption is a single `delete … returning` scoped to the user, so a replay
finds nothing and there is no window between "looked it up" and "marked it used".
A state started by user A cannot be completed by user B — it does not exist for
them.

Nonce verification is separate from state on purpose: state proves the request
correlates, the nonce proves the **ID token** belongs to this authorization.

Consuming the transaction before the token exchange makes a failed exchange
non-retryable. That is accepted: the human restarts the flow, and an
authorization code that could be replayed is worse.

**A denial ends the transaction too.** When Google returns `error=access_denied`,
consumption still happens first: a callback carrying a state we issued is a flow
of ours reaching its end, whichever way it ended. Returning early on the error
parameter — which an earlier version did — left the state digest, nonce digest
and encrypted PKCE verifier alive until the TTL expired, contradicting "consumed
once by the callback". A callback with no state at all, an unknown state, an
expired one, or one belonging to a different user is still refused as
`invalid_state`, and no code is exchanged for a flow the human refused.

---

## 5. Where the credential lives

**A `private` schema with no `usage` grant for `anon`, `authenticated` or
`service_role`.** Not a narrow grant — no path at all.

`service_role` is `BYPASSRLS`, so RLS could never have protected a credential
from the trusted role. Withholding schema usage does. The only door is a small
set of **SECURITY DEFINER functions in `public`, executable by `service_role`
alone**, each pinning its `search_path`, each one transaction. That is the same
shape `save_hotel_to_pipeline` (0019) uses, for the same reason: a sequence of
independent PostgREST writes cannot be atomic.

| stored | not stored |
|---|---|
| encrypted refresh token, IV, auth tag, key version | access token |
| the owner, through B01's `(mail_account_id, user_id)` provenance pair | ID token |
| provider-stated refresh expiry, when given (NULL = *not stated*, never *never expires*) | authorization code |
| | raw state, raw nonce, raw PKCE verifier |

An access token lives minutes and belongs in memory; persisting it would multiply
this table's blast radius for no benefit. The others are single-use inputs whose
job is over.

### Encryption

AES-256-GCM, applied in the application **before** the value reaches PostgreSQL,
with a key the database has never seen — so a backup, a restore into staging or a
support dump contains no usable credential. A fresh random IV per encryption
(GCM's security collapses if a key/IV pair repeats), an authentication tag so a
tampered ciphertext refuses rather than producing plausible garbage, and a stored
key version so rotation will not need a format change.

The key is validated at configuration time: base64, decoding to exactly 32 bytes.
B02 ships one key version and no rotation machinery — a future move to managed
KMS/secret storage is recorded as follow-up, not pretended.

---

## 6. Configuration

Server-only, and deliberately **not** part of `serverEnv()`: those variables are
required for the app to run at all, these only to connect a mailbox. Folding them
in would stop the whole application on a deployment that has not set up Google.

`GOOGLE_OAUTH_CLIENT_ID` · `GOOGLE_OAUTH_CLIENT_SECRET` ·
`GOOGLE_OAUTH_REDIRECT_URI` · `GMAIL_TOKEN_ENCRYPTION_KEY_V1`

None may become `NEXT_PUBLIC_*`. Absent configuration is fine everywhere except
the Gmail endpoints, which **fail closed** with a controlled error. There is no
development fallback and no "skip verification in dev" branch.

---

## 7. Connect

1. Verify the app session. Never trust a user id, owner or email from the request.
2. Create one short-lived owner-bound transaction; generate state, nonce, PKCE.
3. Request only the B02 scope set, offline, with a consent prompt.
4. Redirect to Google.

No mail account exists yet for a new provider identity — B01 cannot create one
before Google reveals the durable `sub`.

## 8. Callback

A dedicated route, **not** the Supabase auth callback. Signing into the
application and authorizing access to a creator's mailbox are different security
boundaries; sharing a route would mean one set of checks guarding both.

Every external check happens before anything local is written, in order: valid
app session → state consumed once (denial or not) → code exchanged with the
PKCE verifier →
refresh token present → granted scopes acceptable → ID token verified → nonce
matches → **Gmail profile health check**.

### The health check

One call: the authenticated user's own Gmail profile. It proves the granted token
reaches a real mailbox — a Google account without Gmail would otherwise become a
"connected" mailbox that never syncs. The response carries `messagesTotal`,
`threadsTotal` and `historyId`; B02 uses only the address and **persists none of
them**, because they are sync state and B02 does not sync. No message or thread
is listed.

If the health check fails, the connection is refused and no credential is stored.
The grant is **not** revoked — see §10: revocation at Google is project-wide, so
using it as callback cleanup destroys whatever else that person authorized.

---

## 9. Which mail account, exactly

### A reconnect pins the mailbox's lifecycle REVISION, not its state name

OAuth is a long-running operation — longer than a refresh. We write a
transaction, hand the browser to Google, and the callback arrives whenever the
human gets round to it. The world moves in between, and an older intention must
not overwrite a newer decision:

1. mailbox A is `reauth_required`;
2. the human starts Reconnect A;
3. they change their mind and **Disconnect** A — revoked at Google, credential
   gone, state `disconnected`;
4. the old callback lands. `disconnected` is a reconnectable state, so it stored
   a fresh credential and, the old consent still being on file for the same scope
   set, put the mailbox straight back to `connected`.

**Checking the state name is not enough**, and this is the part that matters. A
mailbox can leave a reconnectable state and come back to one:

```
reauth_required (rev 10) → disconnected (rev 11) → reauth_required (rev 12)
```

A callback pinned at rev 10 finds exactly the word it expects and is still stale:
two lifecycle decisions happened that it knows nothing about.

So `mail_accounts.authorization_revision` is a database-owned `bigint` from a
sequence. It advances when a `connection_state` transition or a `granted_scopes`
change happens — the changes that invalidate an authorization started against the
older state — and not when unrelated display metadata is edited. A trigger
assigns it on every update, so it is never caller-settable and a **direct SQL**
lifecycle change invalidates in-flight OAuth exactly as a server action does.

`gmail_oauth_begin` resolves the target itself, requires it to be in a
reconnectable state **right now**, and captures its revision. A flow therefore
cannot begin against a `connected` mailbox and wait for it to become
reconnectable: it starts against a real state, not a possible future one.
`purpose`/`target`/`revision` are an IFF — connect has neither, reconnect has
both.

`gmail_connection_persist` then requires the exact revision alongside everything
below. A different one answers `state_changed`: nothing persisted, no scopes
changed, no state moved, and no Google grant revoked.

**The check RESERVES the row, it does not merely inspect it.** The target is
loaded `for no key update` before anything is compared, and the lock is held
until the transaction ends. A plpgsql function is VOLATILE, so each statement
inside it takes a fresh snapshot — without the lock, a callback could read
revision N, a Disconnect could commit N+1, and the callback's later writes would
still land. Evidence about a row is not a hold on it. With the lock there are
only two orderings, and both are safe: the lifecycle write waits behind us and
applies afterwards, or it commits first and is then visible to our locked read,
which fails the comparison.

**A successful reconnect CONSUMES the revision it used.** Landing a fresh Google
credential is itself a provider-authorization event, so it advances the revision
even when the state and the scope set are unchanged. Without that, two flows
begun against the same version could both land — the second replacing the
first's credential, each of them "current" by every check available to it. The
function REQUESTS the bump; the trigger chooses the number, because a revision
the application could pick would not be database-owned. A background
`gmail_credential_replace` deliberately does not bump: rotation is not a human
authorization event, and cancelling unrelated in-flight flows for it would be
noise. `credential_generation` is the clock for rotation; this is the clock for
the lifecycle.

### A reconnect is bound to its target FIRST

When the OAuth transaction named a target mailbox, that binding is checked before
any of the general cases below is even considered. The target must belong to this
user, be a `gmail` account, be in a reconnectable state (`disconnected`,
`reauth_required`, `pending_authorization`, `consent_required`), and — the
binding itself — carry a `provider_account_subject` **equal to the subject Google
just verified**.

Anything else answers `account_mismatch` and nothing is stored. The grant is
**not** revoked (§10). A `deleted` target answers `account_retired`: B01's
terminality is not something a reconnect may undo, and a returning creator starts
a NEW connect flow and receives a NEW row.

This ordering is the fix, not the check itself. Comparing the target only inside
the branch where a live row for the returned subject already existed meant that
picking a **different** Google account at the account chooser fell straight
through to "identity never seen" and silently created a mailbox, or reported
`already_connected` for a mailbox the human never named. "Reconnect A" quietly
meant "connect whatever you picked".

### Then B01's four cases

| case | behaviour |
|---|---|
| **A** — identity never seen | create a NEW `mail_accounts` row |
| **B** — a LIVE row owned by this user, not connected | **`reconnect_required`** — persist nothing; see below |
| **B′** — that row is already `connected` | return `already_connected`; do not silently swap a working credential |
| **C** — only `deleted` rows exist | create a NEW row; `deleted` stays terminal |
| **D** — identity owned by a different app user | **refuse**, store nothing, revoke nothing, and say nothing about who owns it |

### Why a generic CONNECT may no longer revive a live row

A connect flow does not know which Google account it will get until the callback,
so it could not have pinned that mailbox's revision at the start — there was
nothing to pin. Letting it reuse an existing non-deleted row would reintroduce
the whole stale-callback problem through the one door with no snapshot to check:
connect, wander off, disconnect, and let the old callback restore access.

So a generic connect that lands on a live mailbox of this owner answers
`reconnect_required` and persists nothing. The human uses the explicit **Reconnect**
action, which pins the revision. Every non-connected account in the UI exposes it.

This is a deliberate narrowing of B01's CASE B: a generic connect now serves an
unseen identity, or one whose previous rows are all terminally `deleted`.

### `purpose`, `target` and `revision` are an IFF

`connect` ⇔ no target and no revision; `reconnect` ⇔ both. Enforced as a CHECK on
the transaction table and again in the start route, which drops a
`mail_account_id` supplied alongside `purpose=connect` rather than passing it on.
The revision is never supplied by a caller — `gmail_oauth_begin` reads it from
the row, because pinning a value the caller chose would be pinning nothing.

---

## 10. What happens to a grant we refuse — and why it is NOT revoked

### The Google fact this rests on

A programmatic revocation **removes every OAuth 2.0 scope previously granted to
the PROJECT for that user and invalidates the issued access and refresh tokens
for all clients registered under that project.** It operates on the (user,
project) grant. There is no "revoke only this token" call.

### So a refused callback revokes nothing

An earlier version of B02 called revoke on every callback refusal and described
it as "giving back the token we just received". That description was wrong, and
the behaviour was worse than wrong:

- **authorizing an already-connected mailbox again** → `already_connected`, and
  the revoke killed the credential that mailbox was still using;
- **a reconnect whose account chooser returned a different mailbox** →
  `account_mismatch`, and the revoke killed the *other* mailbox, which the human
  had never mentioned;
- **a stranger authorizing a Google account somebody else owns** →
  `owned_by_other_user`, and the revoke disconnected the legitimate owner. B01's
  correct cross-owner refusal had become a way to disconnect other people.

The rule now: **a refused callback persists nothing and revokes nothing.** The
token material stays in memory, is never written and never logged, and falls out
of scope. Preserving a connection that is already valid matters more than tidying
up an in-memory token we are about to forget.

This is the rule for **every** refusal path listed here: missing refresh token,
forbidden scope, missing read scope, unverifiable or missing ID token, nonce
mismatch, failed mailbox health check, `account_mismatch`, `account_retired`,
`state_changed`, `reconnect_required`, `already_connected`,
`owned_by_other_user`, and a failed local persist. If a sentence elsewhere says
one of THOSE refusals revokes, that sentence is wrong and this one governs —
these instructions are read by people writing the next feature, and one stale
line is how the project-wide revocation defect gets reintroduced.

### The one refusal that DOES revoke, and why it is not a counter-example

There is exactly one exception, and it is not tidying up: **`superseded_by_disconnect`**.

**Correction to the amendment #5 text.** That version described this refusal as
reachable when the mailbox is `disconnecting` **or** `disconnected`. In the SQL
it was not: the reconnectable-state gate ran first and answered
`account_mismatch` for `disconnecting`, so the `disconnecting` half of the
condition was dead code — and `disconnecting` is precisely the window in which a
live, freshly-created grant is most likely to exist, because it is the state a
Disconnect sits in when its provider call has not resolved. The checks are now
ordered by what they mean rather than by what is convenient.

The three failures above share a shape. In each, the human either wanted a
connection to keep working or had never asked for anything, and the revoke
destroyed authorization they still wanted. `superseded_by_disconnect` is the
opposite shape: the callback is stale *because the owner of that mailbox
explicitly pressed Disconnect after the flow began*. Removing the project's
authorization is not a side effect there — it is the literal thing they asked
for, and B02's promise is Disconnect, not "forget our copy of the token while
Google may remain authorized".

The refusal is narrow, and every part of the narrowing is load-bearing:

- this flow's **`oauth_intent_seq` must be lower than the mailbox's
  `disconnect_intent_seq`** — the flow began before the human's Disconnect. A
  flow started afterwards draws a higher number and is new work, not stale work;
- the mailbox must currently be `disconnecting` or `disconnected` — a newer
  successful Reconnect, or any other state, is not it;
- the callback's verified Google `sub` must be the subject the disconnect was
  aimed at. A different Google account reached through the account chooser is
  `account_mismatch`, which revokes nothing.

**The order of the checks is part of the contract**, because the wrong order
throws away the information the question needs. For a targeted reconnect:
identity (owner, provider, verified subject) → **supersession** → the ordinary
lifecycle refusals (reconnectable state, then the exact-revision CAS). Nothing is
widened by that order: `connected`, `disconnecting`, `deletion_pending` and
`deleted` remain states no callback may persist a credential into. They simply
get a truthful answer about *why* they are being refused.

### The fence that works before the Google account is known

`authorization_revision` is a version of one known mailbox, so only a flow that
already has a target can pin it. A **generic CONNECT has no target** — it learns
the Google identity at the callback — which left it outside the fence entirely,
and the gap was reachable:

1. the creator has mailbox S connected;
2. they press **Connect another Gmail**: a generic flow, nothing to pin, and
   nothing for `gmail_disconnect_prepare` to cancel, because cancellation can
   only find transactions that NAME a mailbox;
3. before the callback returns they explicitly Disconnect S;
4. the chooser hands back S. The code is exchanged, so Google's grant for S is
   active again;
5. the generic path saw a live `disconnected` row and answered
   `reconnect_required` — correctly persisting nothing, and correctly revoking
   nothing, because ordinary refusals must not revoke.

Local `disconnected`, Google ACTIVE. So the fence is a **shared monotonic
sequence** (`public.mail_account_lifecycle_intent_seq`) drawn by both sides:
every OAuth transaction takes an `oauth_intent_seq` when it begins — generic
included — and every explicit Disconnect takes a `disconnect_intent_seq` when it
is prepared. Once the callback has a verified subject, the database knows which
mailbox it is about and can compare two values from one clock.

A sequence, not a timestamp: equal timestamps collide and clock order is not
causal order. One sequence, not two: two clocks would not be comparable.

The two mechanisms are kept apart because they answer different questions:

| | question | works without a target? |
|---|---|---|
| `authorization_revision` | is this the exact version of the target mailbox my reconnect was authorized against? | no |
| `*_intent_seq` | did my flow begin before the human's Disconnect? | **yes** |

`account_mismatch`, `owned_by_other_user`, `reconnect_required`,
`already_connected`, an ordinary `state_changed` from an unrelated lifecycle
change, and a newer successful Reconnect all still revoke **nothing**. Do not
collapse these two cases back together: the distinction is between "we are
discarding a token we did not want" and "the person told us to end this
authorization while it was being created".

### The honest cost, stated rather than hidden

After a failed first-time authorization, the application may still appear in the
person's Google Account even though **nothing was persisted here** and we hold no
usable token. They can retry the connection, or remove the access from their
Google Account settings. That is a genuine limitation and it is stated, not
hidden — a generic CONNECT that fails a check has no mailbox and no disconnect
intent to attach itself to, so there is nothing that could make revocation the
right call.

**A Disconnect that overlaps a stale flow is NOT covered by that limitation, and
must not be described as an accepted cost.** It used to be, and it was wrong: a
reconnect callback landing after a Disconnect would exchange its code, be
refused, and leave a live grant in the person's Google Account that nothing
removed — the mailbox read `disconnected` while Google was freshly authorized.
Two mechanisms now close it, in this order:

1. `gmail_disconnect_prepare` **cancels the mailbox's outstanding OAuth
   transactions** before any network call, so in the ordinary sequential case
   the stale callback's `state` resolves to nothing, no code is exchanged, and
   no grant is ever created;
2. for the genuine race — the callback had already consumed its transaction
   before the disconnect ran — and for **every generic flow**, which cancellation
   cannot reach at all, the persist refuses with `superseded_by_disconnect` and
   the grant that flow just obtained is revoked.

### That revocation is durable, because it is a network call

Revoking a superseded grant can fail transiently, and the token it needs is the
one this callback just received. Dropping it on failure could end with the
mailbox `disconnected`, no credential anywhere, and an **active** Google grant
that nothing could ever remove — the same divergence, one step further down.

So the fresh credential is made durable FIRST and revoked second, the same
ordering as prepare/revoke/finalize and for the same reason:

1. `gmail_record_superseded_disconnect_credential` stores the sealed token and
   puts the mailbox in `disconnecting` — returning it there if a Disconnect had
   already reported completion, because this callback is newer evidence that the
   provider side is not finished. It re-checks every precondition under its own
   lock and **refuses** if a newer successful Reconnect has made the mailbox live
   again; on a refusal the callback neither stores nor revokes;
2. the revocation is attempted with that fresh token;
3. on success — or on `invalid_token` **for that same token**, which means the
   grant's newest artifact is already unusable — `gmail_disconnect_finalize`
   completes the Disconnect, **under the generation this callback stored and the
   intent it stored it under**. If something newer arrived in between, finalize
   refuses and the callback respects the refusal rather than closing a mailbox
   that is no longer its responsibility;
4. on any other failure the mailbox stays `disconnecting` with the retry
   material, and the callback answers `disconnect_incomplete`. The human is not
   told they are disconnected, because they are not. A later Disconnect retry
   loads that token and finishes the job.

What is stored is not an authorization. It is the instrument required to carry
out a revocation the human already asked for, held in a state that permits no
processing: `gmail_credential_load` answers `not_connected` for `disconnecting`.

### What `invalid_token` proves, and what it does not

`invalid_token` is evidence about **the token it was returned for**, and nothing
else. On the token a superseded callback just received it means that grant's
newest artifact is dead, which is the outcome revocation was asking for.

On the **older stored token** an ordinary Disconnect revokes with, it means only
that this token is unusable. It is not evidence that no grant exists for that
Google account: a flow that was in the air can have obtained a newer one seconds
ago. B02 does not paper over that with an inference — a Disconnect still destroys
its dead stored token, and the newer grant is handled where it actually exists,
by the callback that created it.

B02 still does not pretend that discarding a token locally revokes Google's
grant. The only way to make that true is the project-wide operation above, and
using it on the three failures listed is what caused them.

## 10a. Atomicity

Once all Google-side checks pass, local persistence is **one transaction** inside
one SECURITY DEFINER function. None of these can survive — and "cannot survive"
means a deferred constraint trigger refuses the COMMIT, not that the writer
remembers:

- a `connected` or `consent_required` mailbox with no refresh credential;
- a `pending_authorization`, `reauth_required`, `disconnected`,
  `deletion_pending` or `deleted` mailbox that still holds one;
- a `disconnecting` mailbox holding MORE than one — this is the single state
  where either count is legitimate, because the credential is retained on
  purpose until revocation resolves (§13) and then destroyed. "Zero or one" is
  not a gap in the invariant; it is the honest statement of a state that spans a
  network call, and it is enforced as an upper bound rather than left unchecked;
- a `consent_required` mailbox without `gmail.readonly`, or one whose consent has
  in fact already been granted for exactly its scope set;
- a credential attached to the wrong app owner;
- a credential for an unverified provider identity.

---

## 11. Consent is a separate decision

A Google authorization is not a product consent, and B02 keeps them apart.

For a **brand-new** mail account the callback persists the provider identity, the
actual granted scopes and the encrypted credential and leaves the mailbox in
**`consent_required`**. The credential is stored at this point because we hold a
real grant and must be able to revoke it; what we do not yet hold is permission
to process.

The state is `consent_required` and specifically NOT `pending_authorization`.
0035 defines the latter as "the human has not completed Google's consent screen;
no access", which would be false about a mailbox whose verified `sub`, approved
`gmail.readonly` and live refresh token we are holding at that moment. B02 adds
the word rather than quietly widening an existing one — see §9 of the B01
contract for the full table.

The creator is then shown an explicit, plain-language step. The **server owns the
exact consent text and its version**, and computes the digest from that text — a
browser that could supply its own policy version or digest could manufacture a
receipt saying someone agreed to something they never saw. The browser's only
input is *yes*.

On acceptance, atomically: append a `granted` `private_gmail_processing` receipt,
advance the projection onto it, snapshot the **actual** granted scope set, and
transition to `connected` with `connected_at`. B01's deferred invariants are the
final authority.

**Consent may connect only FROM `consent_required`.** That is the only state in
which the question this action answers is open, and the check happens inside the
same `for no key update` lock the function already takes. Any other state returns
**`consent_not_applicable`** and writes nothing — not even a receipt, because a
receipt is evidence that a decision took effect and recording one for a refused
decision would make the append-only history say something that did not happen.

The gate matters most where amendment #5 made it reachable. A Disconnect
deliberately RETAINS the credential while `disconnecting`, so the function's
"is there a credential?" test passed, and a consent form submitted *before* the
human pressed Disconnect could land afterwards and put the mailbox back to
`connected` — undoing the newer explicit decision. Reproduced end to end:
`consent_required` → Disconnect prepare → `disconnecting` → transient revoke
failure → the stale consent lands → a new receipt written, state `connected`.

Because the check is inside the lock, there are exactly two orderings and no
third:

| ordering | outcome |
|---|---|
| consent takes the lock first | it connects; the Disconnect then waits and applies to a connected mailbox — final state `disconnected` |
| Disconnect's prepare takes it first | the consent wakes, sees `disconnecting`, and refuses — the Disconnect intent stands |

### 11a. Asking again when the scope set widened

`consent_required` is the database's answer to "does a current, exact-scope
private-processing consent exist?", and it is the only answer the UI consults. A
stored consent can be `granted` and still not cover the mailbox in front of the
human: it may describe a narrower set from before a reconnect widened the grant,
and B01 requires a fresh decision for the new set.

The consent prompt is therefore shown when the state is `consent_required` and a
credential exists — **not** when the consent projection happens to read
un-granted. Keying on the projection left exactly the widened case unreachable:
"Awaiting your permission" with no way to give it.


**Network contribution is not mentioned as implied and is not granted.** It stays
separate, explicit, revocable and default-off, and B02 offers no way to enable it.

---

## 12. Reconnect

Applies to `disconnected`, `reauth_required`, `pending_authorization` and
`consent_required` rows, and only when the verified Google subject is that row's
own subject (§9). A `deleted` row is never revived.

The fresh credential and actual scope set replace the old ones. Then:

- if the **current** private-processing consent is granted, belongs to this
  mailbox, and its scope snapshot **exactly equals** the newly granted set →
  reconnect straight to `connected` without asking the same question again;
- if consent is absent, withdrawn, or the scope set changed → the mailbox stays
  non-connected until a **new** explicit consent event.

Consent from a deleted or older mail account can never authorize a new one: every
receipt and projection is bound to a `mail_account_id`.

---

## 13. Disconnect, and the ordering that matters

Disconnect is **not** delete. The mailbox row, its consent history, its ownership
reservation and any Gmail-derived workspace data all remain — deletion is a
separate B01 lifecycle.

**Disconnect is the one place project-wide revocation belongs**, because there it
is precisely what the human asked for: stop this application's Gmail
authorization. See §10 for why it is not used anywhere else, and
`B02_GOOGLE_CLOUD_SETUP.md` §0 for the architecture rule that follows — the
OAuth project is an authorization domain, and unrelated Google integrations must
not share it.

**Record the intent, then revoke at Google, then finalize locally.** Three steps,
and each order relation is load-bearing:

`gmail_disconnect_prepare` → revoke at Google → `gmail_disconnect_finalize`.

*Prepare before the network call*, because a decision made only after Google
answers cannot beat an OAuth callback that lands while Google is still thinking.
Prepare runs in one transaction and does three things: it **cancels the mailbox's
outstanding OAuth transactions**, so a flow that has not yet come back can never
be completed; it moves the mailbox to `disconnecting` and records
`disconnect_requested_revision`, so a callback that had *already* consumed its
transaction can be recognised as superseded (§10); and it returns the credential
envelope, if one exists, for the revocation about to happen.

*Revoke before finalize*, because:

- if Google succeeds and the local write fails, running disconnect again
  completes the job — Google reports the token already invalid, and finalization
  proceeds. The operation is idempotent, and `disconnecting` is one of the states
  Disconnect accepts, precisely so a retry is possible;
- if local state were cleared first and revocation then failed, we would have
  destroyed the only credential capable of revoking an access Google still
  honours, and told the human they had disconnected while the application
  remained authorized.

**Finalize REQUIRES the prepared state.** `gmail_disconnect_finalize` may consume
only `disconnecting` (→ `disconnected`) and is idempotent on `disconnected` (→
`already_disconnected`). `pending_authorization`, `consent_required`,
`connected` and `reauth_required` are refused with **`prepare_required`**;
`deletion_pending` with `deletion_in_progress`; `deleted` with
`account_retired`.

**And it REQUIRES the snapshot it prepared under.** The state gate alone answers
"is a Disconnect outstanding?" — not "is this *my* Disconnect, on the credential
*I* sent to Google?". Those became different questions the moment a superseded
callback was allowed to replace the stored token mid-Disconnect, and the
difference was reachable:

```
prepare loads R1/G1
  -> superseded callback stores R2/G2; its own revoke fails transiently
  -> revoke(R1) returns invalid_token — true of R1, no evidence about R2
  -> finalize deletes R2 and writes `disconnected`

LOCAL disconnected · CREDENTIAL none · GOOGLE grant from R2 ACTIVE · RETRY impossible
```

So the provider operation is no longer *"I revoked something for mailbox A"*. It
is **"I attempted to revoke credential generation G under Disconnect intent I"**,
and finalization is a compare-and-swap on both:

| condition | refusal |
|---|---|
| `disconnect_intent_seq` ≠ the one prepared under | `stale_disconnect_intent` |
| the credential is not the generation that was sent to Google | `newer_revocation_material` |
| a credential appeared after a **no-credential** prepare (expected generation NULL) | `newer_revocation_material` |

A NULL expected generation is information, not a wildcard: it says there was
nothing to revoke when this operation was prepared. A NULL expected intent is
refused outright — a caller with no snapshot has not proved it prepared anything.
Both parameters are **required**, so the old two-argument call does not resolve:
an unqualified finalizer is not a finalizer.

Only an exact match may delete the credential, empty the scopes and write
`disconnected`. Everything else changes nothing and leaves the mailbox in
`disconnecting`, still holding the retry material for whatever grant may still
be alive.

**`invalid_token` does not override the CAS.** It proves the token *presented to
Google* is unusable — that is the whole of its meaning (§10). Whether the
generation it refers to is still the one this Disconnect is responsible for is a
question only the database can answer, and the CAS is where it answers it.

**Both callers check the result.** `disconnectGmailAccount` and the superseded
callback each carry their own snapshot and each treat anything but `ok` —
including a transport error — as "this call did not complete the Disconnect".
Neither reports success it did not produce, and neither destroys material it did
not revoke. The superseded callback's snapshot comes from
`gmail_record_superseded_disconnect_credential`, which returns the generation it
stored and the intent it stored it under.

Without that gate the last step accepted almost any live mailbox, so a trusted
caller could go straight from `connected` to `disconnected` — credential
deleted, scopes emptied, the human told they had disconnected — with no durable
intent recorded, no in-flight OAuth cancelled, and nothing said to Google. That
is the original divergence rebuilt through the RPC surface. `service_role` is a
capability, not proof that a future caller remembered the protocol, so "you
cannot skip the step that talks to Google" is enforced by the database.

**`disconnecting` is a real state and it is not a synonym for `disconnected`.**
It says: the owner has asked to stop, and the provider side is not resolved yet.
The credential is deliberately still there — it is the only thing that can
revoke — so the invariant for this state permits zero or one credential, and
nothing else. Naming the row `disconnected` before revocation resolved would be
the application telling the human something it does not know.

**A deletion owns the lifecycle while it runs.** If the mailbox is
`deletion_pending`, both prepare and finalize refuse with `deletion_in_progress`
and change nothing. Access has already stopped in that state, so Disconnect has
nothing to add, and rewriting the row would clear the deletion pointer the claim
rests on and stop telling the human that their deletion is running. `deleted`
refuses as `account_retired`.

A successful revocation **or** `invalid_token` both prove the stored token is no
longer usable, and both allow finalization. This is asserted in the orchestration
layer, not only inside the adapter, so the guarantee does not depend on which
adapter is wired in.

Any other provider failure returns a controlled error, and the account is **not**
falsely marked disconnected.

It is no longer true that *nothing changed*, and the UI must not say so. Prepare
runs before the network call by design: the mailbox is already `disconnecting`,
its in-flight OAuth flows are already cancelled, and no processing happens from
that state. What has not happened is Google's confirmation. The copy says that —
"Google has not confirmed the disconnection yet. Gmail processing is stopped
while we finish disconnecting it — try Disconnect again." — because "nothing was
changed" would be a smaller lie than "disconnected" and still a lie.

`deletion_in_progress` is a distinct outcome and gets a distinct message. It used
to fall through to "that mailbox was not found", which is a different and
misleading thing to tell someone whose deletion request is running right now.

Disconnect revokes whatever credential exists, including one belonging to a
mailbox that never reached `connected`. A `consent_required` mailbox holds a LIVE
Google grant; skipping its revocation would leave the human authorized to an
application whose UI had just told them they had stopped it.

### The credential a user action may load

Disconnect receives a `mail_account_id` from a form, so it uses
`gmail_credential_load_for_owner(p_user_id, p_mail_account_id)` — the
authenticated user is part of the **lookup**, and a stranger's id returns
`not_found` with no envelope ever assembled.

The ownerless `gmail_credential_load` remains, because a B03 background job holds
a mailbox id it derived itself and has no session to check against. It is not
reachable from a user-initiated path. Loading the credential first and comparing
owners a line later was the earlier arrangement: the comparison was correct, and
the boundary had already been crossed on the strength of untrusted input by the
time it ran.

---

## 14. Refresh, and `reauth_required`

`getFreshGmailAccessToken(mailAccountId)` is the server-only primitive B03 builds
on. It requires the mailbox to be `connected` and the private-processing consent
to be currently granted — checked at this one chokepoint, so a withdrawal takes
effect everywhere rather than depending on each future caller remembering.

The access token is returned **in memory**. It is never persisted, never logged,
never sent to a browser.

### What may destroy a credential

Exactly one error: **`invalid_grant`**, which is what Google documents for a
refresh token that has expired or been invalidated. That is normal lifecycle, not
corruption: users revoke at Google, passwords change, Testing-mode grants lapse.
Atomically, remove the unusable credential and set `reauth_required`. Consent
history and the ownership reservation are **kept** — neither stopped being true.

**`invalid_client`, `unauthorized_client` and `invalid_request` are NOT
destructive.** Google documents these against our CLIENT and our REQUEST: a wrong
client id or secret, a client not permitted to make this request, a malformed or
incomplete request. Every one of them is satisfied by a mistyped environment
variable or a programming error on our side, and none is evidence that a
creator's token stopped working. Treating them as permanent — which an earlier
version did — meant one bad deployment would delete every credential it touched
and require each affected person to reconnect by hand to repair a mistake of
ours. They surface as a sanitized configuration failure and change nothing.

Adding another code to the destructive set requires citing current official
Google documentation stating that it proves the refresh token itself is
permanently unusable. **HTTP 4xx alone is not evidence**, and neither is a
`permanent` flag set by whichever caller constructed the error.

**Transient or unrecognised failure** does not erase the credential and does not
mark `reauth_required`; it surfaces a sanitized retryable error. Nothing
auto-loops.

### Every mutation names the credential it came from

A refresh is: load the credential, call Google, write the result. The middle step
is a network round trip, and in it another worker can rotate the token and the
human can disconnect. Keying the write on `mail_account_id` alone made whichever
worker finished last authoritative regardless of what it had derived its result
from — so a slow worker could overwrite a newer credential with one derived from
a token Google had already rotated away, delete a credential it had never seen
because the one IT held was rejected, or drag a mailbox the human had
deliberately **disconnected** back to `reauth_required`.

`private.gmail_oauth_credentials.credential_generation` closes that. It is a
database-owned `bigint` drawn from a sequence — deliberately **not** a timestamp
(two writes in the same microsecond compare equal, and clock order is not causal
order), and deliberately **not** a per-row counter starting at 1 (a credential is
deleted and re-created on every reconnection, so a per-row counter would reissue
generation 1 and a stale worker's remembered value would match).

Every load returns it. Every mutation derived from a loaded credential supplies
it, and is a compare-and-swap:

| operation | proceeds only if | otherwise |
|---|---|---|
| `gmail_credential_replace` | still `connected`, consent still current, generation unchanged | `state_changed` / `stale_credential`, nothing written |
| `gmail_mark_reauth_required` | still `connected`, consent still current, credential present at **that** generation | `state_changed` / `stale_credential`, nothing deleted, no state moved |
| `gmail_credential_currentness` | still `connected`, consent current, generation is the one this result corresponds to | `state_changed`, no token handed back |

A stale `invalid_grant` therefore never deletes a newer refresh token, and never
undoes a Disconnect.

### The application must not claim a transition that did not happen

`reauth_required` is reported **only** when the CAS RPC confirms it performed the
transition. A transport failure surfaces as a provider error; a stale or
state-changed refusal surfaces as `state_changed`. The previous version awaited
the RPC and returned `reauth_required` regardless of what it said.

### The last check before the token leaves

A human can disconnect while the refresh call is in flight. Before returning
`{ result: 'ok', accessToken }`, the local state is re-read and must still agree:
connected, consented, and at the generation this result corresponds to — the one
loaded, or the one just committed by this worker's own rotation.

This does **not** claim to be a distributed lock over B03's future Gmail calls;
nothing at this layer could be. It establishes the strongest honest handoff:
*this access token was still authorized by our current local state immediately
before it was handed over.* B03 adds its own job-level cancellation on top.

### Rotation is part of a successful refresh

The order is explicit: a usable access token must exist, and only then is the
provider refresh treated as successful; if Google returned a **replacement
refresh token**, storing it encrypted is part of completing that refresh.

Both the transport error and the RPC's own answer are checked. If the replacement
cannot be stored, the refresh reports a sanitized storage failure — **not**
success — because the mailbox is now holding a value that stops working, and
saying "ok" would hand a caller a token while hiding that the connection is
already broken.

The previous credential is deliberately **not** deleted on a storage failure.
Whether Google has already invalidated it is not knowable from here, and throwing
away the only value that might still work would turn a storage blip into a forced
re-authorization. The next attempt establishes which it was.

### Provider refresh-token expiry metadata is NOT captured

Google's token endpoint can return `refresh_token_expires_in` for time-based
access, and `private.gmail_oauth_credentials.provider_refresh_token_expires_at`
is where that value belongs. **`google-auth-library@11.0.2` does not surface it**
on the credentials object it returns, so the production adapter always writes
NULL there.

Stated plainly rather than left as an implication: B02 does not currently capture
provider refresh-token expiry metadata. The column keeps its usual meaning —
NULL is "not stated", never "never expires" — and a future adapter that can read
the field populates it without a schema change.

### Google Testing mode

For an External app in **Testing** status, a refresh token carrying Gmail scopes
may expire after roughly **7 days**. That is expected behaviour in development,
and B02 models it as: valid connection → refresh token later invalid →
`reauth_required` → the human reconnects. Not a crash, and not corruption.

---

## 15. Secrets and logging

Nothing in this path may put a secret where a log can see it: authorization code,
raw state, PKCE verifier, nonce, access token, refresh token, client secret,
encryption key, ID token.

Provider errors are reduced to a **code** before anything is logged, and only a
well-formed OAuth error code is accepted — short, lowercase, no whitespace.
Free-text provider messages are **discarded rather than truncated**: truncation
keeps whatever sits in the first hundred characters, and a provider that echoes
the rejected token early in its message would put it straight into our logs.

---

## 16. Authorization on every route

Every Gmail route and action establishes the authenticated app user first, then
verifies ownership, then does privileged work. **Service role is a capability,
never an authorization.** No route trusts a `user_id`, a mail-account owner, a
provider subject or an email supplied by the browser. A mail account id does
arrive from the form, but every query it reaches also constrains `user_id` — and
for the credential specifically, the owner is part of the LOOKUP rather than a
comparison applied to its result, so an id naming somebody else's mailbox finds
nothing instead of finding their secret and then discarding it.

---

## 16a. The account panel

The smallest honest surface: connect, consent, reconnect, disconnect, and which
of those states a mailbox is actually in. Its rules live in
`src/lib/gmail/panel-actions.ts` so they are testable as rules rather than as
rendering, and so the component never makes a decision the database has already
made:

- **Reconnect** appears only for `pending_authorization`, `consent_required`,
  `reauth_required` and `disconnected` — the states `gmail_oauth_begin` accepts.
  Offering it on a `connected` or deleting mailbox would offer something certain
  to be refused;
  Offering it on a `disconnecting` mailbox would be worse than useless: it would
  invite the human to reauthorize the very grant a disconnect is in the middle of
  removing;
- **the consent prompt** follows the STATE (§11a), not the consent projection;
- **an unfinished Disconnect gets a line of its own.** `disconnect_incomplete`
  is the one callback outcome the mailbox state under-reports: the row reads
  `disconnecting`, which looks transient, when in fact a live Google grant is
  waiting on a retry. Every other outcome is already visible in the state, and
  the state is the authority — this deliberately does not grow into a status
  taxonomy, because a second source of truth about a connection is how the two
  end up disagreeing;
- **Disconnect** appears for `pending_authorization`, `consent_required`,
  `connected`, `reauth_required` and `disconnecting`. It disappears once access
  has actually stopped (`disconnected`) and on the deletion states, where the
  RPCs would refuse it anyway. `disconnecting` keeps the button on purpose:
  that state means the provider side did not resolve, and pressing Disconnect
  again is the retry that finishes it;
- **Connect another Gmail** is available whenever Gmail is configured and at
  least one mailbox exists. B01 allows one creator many mailboxes — a personal
  and a business Gmail are both legitimate — and the backend always did; the
  panel previously offered Connect only when the list was empty, so there was no
  ordinary way to add a second. It starts a generic CONNECT, which is the right
  flow for an account we have never seen. Reconnect targets a mailbox that
  already exists here and would aim at the wrong row.

## 17. Not in this layer

- **No email import, message listing, thread ingestion or attachments.**
- **No classification, hotel matching, outreach intelligence or aggregates.**
- **No Gmail send**, and no `gmail.send` in the requested scope set.
- **No message, thread, attachment, label, sync, history or import table.**
- **No DPoP.** Current Google guidance suggests considering sender-constrained
  tokens; adding it here would be new, lightly-exercised code on the critical
  credential path. B02 ships PKCE, a confidential web-server client and encrypted
  server-side refresh storage. DPoP is recorded as a security-hardening
  follow-up before broad production rollout — **it is not implemented**.
- **No automated Google Cloud configuration.** See the runbook.
- **No real Gmail account connected in this PR**, unless the project owner
  explicitly authorizes a manual smoke test with credentials supplied outside
  source control.
