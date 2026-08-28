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
app session → state consumed once → code exchanged with the PKCE verifier →
refresh token present → granted scopes acceptable → ID token verified → nonce
matches → **Gmail profile health check**.

### The health check

One call: the authenticated user's own Gmail profile. It proves the granted token
reaches a real mailbox — a Google account without Gmail would otherwise become a
"connected" mailbox that never syncs. The response carries `messagesTotal`,
`threadsTotal` and `historyId`; B02 uses only the address and **persists none of
them**, because they are sync state and B02 does not sync. No message or thread
is listed.

If the health check fails, the connection is refused, no credential is stored,
and the newly issued grant is revoked.

---

## 9. Which mail account, exactly

After the verified `sub` is known, B01 decides:

| case | behaviour |
|---|---|
| **A** — identity never seen | create a NEW `mail_accounts` row |
| **B** — a LIVE row owned by this user (`pending_authorization`/`disconnected`/`reauth_required`) | **reuse that row**; never a second live row |
| **B′** — that row is already `connected` | return `already_connected`; do not silently swap a working credential |
| **C** — only `deleted` rows exist | create a NEW row; `deleted` stays terminal |
| **D** — identity owned by a different app user | **refuse**, revoke the grant, store nothing, and say nothing about who owns it |

---

## 10. Compensation, and atomicity

The token exchange happens before every local invariant can be checked, so when
Google has issued a credential and the local side then refuses — a forbidden
scope, a failed health check, a cross-owner identity — B02 **revokes the grant it
is not going to keep**. Leaving it would mean a human's mailbox is authorized to
an application that has no record of it: invisible to them and to us. A failed
compensating revocation is logged as a sanitized security event, code only.

Once all Google-side checks pass, local persistence is **one transaction** inside
one SECURITY DEFINER function. None of these can survive:

- a `connected` mailbox with no refresh credential;
- a credential attached to the wrong app owner;
- a credential for an unverified provider identity.

---

## 11. Consent is a separate decision

A Google authorization is not a product consent, and B02 keeps them apart.

For a **brand-new** mail account the callback persists the provider identity, the
actual granted scopes and the encrypted credential while leaving the mailbox
**not yet `connected`**. The credential is stored at this point because we hold a
real grant and must be able to revoke it; what we do not yet hold is permission
to process.

The creator is then shown an explicit, plain-language step. The **server owns the
exact consent text and its version**, and computes the digest from that text — a
browser that could supply its own policy version or digest could manufacture a
receipt saying someone agreed to something they never saw. The browser's only
input is *yes*.

On acceptance, atomically: append a `granted` `private_gmail_processing` receipt,
advance the projection onto it, snapshot the **actual** granted scope set, and
transition to `connected` with `connected_at`. B01's deferred invariants are the
final authority.

**Network contribution is not mentioned as implied and is not granted.** It stays
separate, explicit, revocable and default-off, and B02 offers no way to enable it.

---

## 12. Reconnect

Applies to `disconnected`, `reauth_required` and `pending_authorization` rows. A
`deleted` row is never revived.

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

**Google revoke first, local finalize second.** The order is the whole point:

- if Google succeeds and the local write fails, running disconnect again
  completes the job — Google reports the token already invalid, and finalization
  proceeds. The operation is idempotent;
- if local state were cleared first and revocation then failed, we would have
  destroyed the only credential capable of revoking an access Google still
  honours, and told the human they had disconnected while the application
  remained authorized.

A successful revocation **or** `invalid_token` both prove the stored token is no
longer usable, and both allow finalization. This is asserted in the orchestration
layer, not only inside the adapter, so the guarantee does not depend on which
adapter is wired in.

Any other provider failure returns a controlled error and changes nothing. The
account is **not** falsely marked disconnected.

---

## 14. Refresh, and `reauth_required`

`getFreshGmailAccessToken(mailAccountId)` is the server-only primitive B03 builds
on. It requires the mailbox to be `connected` and the private-processing consent
to be currently granted — checked at this one chokepoint, so a withdrawal takes
effect everywhere rather than depending on each future caller remembering.

The access token is returned **in memory**. It is never persisted, never logged,
never sent to a browser.

**Permanent failure** (`invalid_grant` and friends) is normal lifecycle, not
database corruption: users revoke at Google, passwords change, Testing-mode grants
lapse. Atomically: remove the unusable credential and set `reauth_required`.
Consent history and the ownership reservation are **kept** — neither stopped being
true.

**Transient failure** does not erase the credential and does not mark
`reauth_required`; it surfaces a sanitized retryable error. Nothing auto-loops.

If Google returns a **replacement refresh token** during refresh, it is stored
encrypted after the response validates — the old one stops working.

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
arrive from the form, but it is only ever used inside a query that also
constrains `user_id`.

---

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
