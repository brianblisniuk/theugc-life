# theugc.life — B01_GMAIL_DATA_BOUNDARY_CONTRACT.md

The Gmail data boundary. Migration `0035`, the consent model, and the privacy
classes every later Phase-B and Phase-C block must obey.

---

## 1. The one question this layer answers

> **What does the system store about a creator's connected mailbox, who may see
> it, what exactly did the human agree to, and what must happen when they
> disconnect or ask for deletion — decided BEFORE a single message exists?**

It connects no mailbox, stores no OAuth token, imports no email, classifies
nothing and produces no network intelligence. Those are B02 and later.

Phase A's data was provider inventory: facts about hotels, reviewed by staff
whose job is to review them. This is a different kind of data entirely. A
creator's mailbox is **private correspondence**, most of it about people and
businesses who never agreed to anything with us, and under Google's
restricted-scope rules the obligations follow the data — including everything
derived from it.

---

## 2. The Google scope contract

The architecture owner performed the current primary-source Gmail / OAuth /
privacy research on **2026-08-27**. The results below are LOCKED product inputs.
They are not to be replaced by blog posts, tutorials or convenience, and a change
to them is a new contract.

### Historical and ongoing read

```
https://www.googleapis.com/auth/gmail.readonly     RESTRICTED
```

**Why `gmail.readonly` is required.** The product must eventually detect hotel
outreach, classify replies, understand negotiation context and extract outcomes
**from real message content**. That is not derivable from envelopes.

**Why `gmail.metadata` is insufficient**, and is not chosen merely because its
name sounds safer:

- it exposes metadata and headers but **not message bodies**, and the whole
  Phase-B thesis is about what is inside the message;
- the Gmail `users.messages.list` **search query parameter `q` cannot be used**
  under `gmail.metadata`, so the targeted retrieval a historical import depends
  on is unavailable;
- **it is also a restricted scope.** Choosing it would accept the same
  verification burden and deliver a product that cannot answer the question.

### Sending

```
https://www.googleapis.com/auth/gmail.send         SENSITIVE
```

Requested **later**, through **incremental authorization**, when a human
activates a feature that sends mail — never bundled into the initial connection
because the product might one day send something. A creator who connects a
mailbox to analyse their own history has not asked us to be able to send as them,
and the permission prompt should arrive at the moment that changes.

### Not requested in V1 without a new contract

```
https://mail.google.com/                           (full mailbox control)
https://www.googleapis.com/auth/gmail.modify
https://www.googleapis.com/auth/gmail.compose
https://www.googleapis.com/auth/gmail.insert
https://www.googleapis.com/auth/gmail.metadata
https://www.googleapis.com/auth/gmail.settings.basic
https://www.googleapis.com/auth/gmail.settings.sharing
```

`gmail.modify` and `gmail.compose` are the classic convenience mistakes: they
make a send feature marginally simpler and hand the product the ability to
alter, label and delete a human's mail. Nothing in the roadmap needs that.

**This list is enforced in the database.** `mail_accounts.granted_scopes` carries
an allow-list CHECK (`mail_accounts_scope_allowlist`), so a future writer cannot
quietly record a broader grant. A scope contract that lives only in a document is
a scope contract a script can break.

### Restricted-scope compliance is a product constraint, not an implementation detail

Because `gmail.readonly` is restricted and the product stores and processes that
data server-side, the product must be designed assuming:

- OAuth **restricted-scope verification**;
- the **Google API Services User Data Policy**, including **Limited Use**;
- an applicable **third-party security assessment**;
- secure handling **in transit and at rest**;
- the ability to **delete user data on request**;
- **accurate public privacy disclosures**;
- **minimum-scope access**.

None of that is optional engineering polish. It shapes what may be built.

### Limited Use applies to DERIVED data too

Google's Limited Use rules apply not only to raw Gmail data but to data
**aggregated from it, anonymized from it, or derived from it**.

So this model is **false** and must never appear in this codebase:

```
raw Gmail  →  extracted outcome  →  ordinary non-Gmail global data
```

A reply classification, a response time, an offer value, a negotiation outcome or
a structured pitch feature **remains Gmail-derived data** when Gmail was its
origin. Discarding the body does not launder the obligation.

---

## 3. Four data classes

Every future Phase-B and Phase-C row belongs to exactly one of these, and the
class decides who may see it.

### G0 — account / authorization metadata

Provider · provider account subject · email address · connection state · granted
scopes · consent versions · sync capability state · timestamps.

No message content. Still personal data, still owner-scoped. **This is all B01
creates.**

### G1 — private Gmail content

Message bodies · snippets · headers · participants · subjects · thread content ·
attachments if ever permitted.

**STRICTLY PRIVATE.** Owner-scoped. Never network-visible. Never publicly
queryable. **No ordinary admin/editor client access merely because a user is
staff.** B01 creates no G1 table; B03/B04 will, under this contract.

### G2 — private Gmail-derived facts

"This thread is hotel outreach" · reply received · reply delay · reply
classification · negotiation stage · offer extracted · deal won/lost ·
collaboration outcome · pitch feature extraction.

**Still Gmail-derived data**, and private to the creator by default. Structured
data is not automatically safe to share because the original body was discarded —
see Limited Use above.

### G3 — network-eligible aggregate contributions

**Not automatically produced by anything.** A G2 fact becomes eligible to
contribute to network intelligence only when ALL of these hold:

1. the creator gave a **separate explicit opt-in**;
2. the use is a **prominent user-facing product feature**;
3. no raw message body is exposed;
4. no personal email address is exposed;
5. no creator identity is exposed;
6. no private thread is reconstructable;
7. the aggregation threshold is satisfied;
8. the contribution is **provenance-linked** to the account and user, so
   deletion or consent withdrawal removes it from future rebuilds;
9. no advertising, data-broker or credit use;
10. no generalized external dataset sale.

**B01 implements no aggregation.** It establishes the boundary the C-phase
intelligence must obey, and D050's rule still governs the aggregates themselves:
privacy does not change by plan.

---

## 4. Two consents, and the second is optional

The product genuinely wants to learn which hotels reply, who replies, what
pitches work, response times, negotiation patterns and collaboration outcomes.
That remains the moat (D019, D020). It must not arrive through a blanket
"connect Gmail" click.

| consent kind | meaning |
|---|---|
| `private_gmail_processing` | *"process my Gmail data to provide MY OWN creator workflow and intelligence."* Required for the product to do anything at all. |
| `network_intelligence_contribution` | *"let eligible privacy-safe derived signals from my activity contribute to aggregated intelligence features."* **OPTIONAL · SEPARATE · EXPLICIT · REVOCABLE · DEFAULT NOT GRANTED.** |

**Connecting a mailbox must deliver real private value with network contribution
false.** If it does not, the second consent is a dark pattern wearing a checkbox.
0035 enforces the first half of that directly: a mailbox may be `connected` with
no network consent at all, and there is no code path in which connecting implies
contributing.

### The absence of a receipt is never consent

`public.mail_account_has_consent(account_id, kind)` is the **single** definition
of "this mailbox currently permits this", and no row means **not granted**. One
function, because a second reading of "no row" is how a default-false permission
becomes accidentally true.

### Receipts and projection, as in A04.5/A04.6

The same shape the review layers proved:

| table | lifetime |
|---|---|
| `mail_account_consent_receipts` | **immutable history** of what a human agreed to, and when |
| `mail_account_consents` | the **current** answer, one row per (mailbox, permission) |

A withdrawal is a **new receipt**, never an edit. The receipt records the policy
version, a digest of the exact text shown, and the scopes in force at the time —
because a consent given against read-only access is not consent to a later, wider
grant, and a consent record that cannot reproduce what was on the screen is an
assertion rather than evidence.

The projection is composite-FK'd to the receipt on `(id, mail_account_id,
consent_kind, decision)`, so a projection that says `granted` while naming a
withdrawal, or that borrows another mailbox's or another permission's decision,
is **unrepresentable** — not merely unlikely, and not left to a trigger.

### No processing without consent

A deferred constraint trigger requires, at COMMIT, that
`connection_state = 'connected'` implies a granted `private_gmail_processing`
consent. Holding access and being permitted to use it are different facts, and
the state that says "we may process this mailbox" must not be assertable without
the second one.

---

## 5. No general model training on Gmail data

**G1 and G2 data must not be used to train a general-purpose model, a foundation
model, an advertising model, or an external reusable dataset.**

Later AI inference may process the minimum necessary private content when:

- it provides a **visible user-facing product feature**;
- the processing is **disclosed**;
- the processor is **contractually limited** to providing that service;
- the processor receives **no rights** to reuse the content for unrelated
  training, advertising or data brokerage.

The product's learning moat is built from structured product-specific signals,
human corrections, privacy-safe aggregates and explicit eligible contributions —
never from silently training a general model on everyone's inbox. AI_RULES.md
already forbids fabricated claims and bulk flows; this extends the same posture
to the training question.

**B01 implements no AI.**

---

## 6. Human staff access

**Default: NO HUMAN STAFF READING OF G1.** An employee, admin or editor gains no
access to a creator's mailbox merely by holding an internal role.

This is why the RLS posture in 0035 is **deliberately different** from every
table in 0027–0034. Those answer `public.is_admin_or_editor()` because reviewing
hotel data is staff work. That function appears **nowhere** in this plane, and a
test asserts its absence from the policies rather than trusting the reading.

Future exceptions — affirmative user approval to inspect specific content for
support, security/abuse investigation where permitted, legal requirement —
require a **separately contracted, audited mechanism**. B01 implements none of
them, and the data model is deliberately shaped so this plane cannot be confused
with the public/editorial admin data next to it.

---

## 7. Ownership, agency and deletion-addressability

**One app user → zero or many mailboxes.** A creator legitimately runs a personal
and a business address.

**One provider account → exactly ONE owning app user**, enforced by
`unique (provider, provider_account_subject)`. Shared-inbox ownership is not
implemented.

**No agency delegation.** An agency managing a creator gets **no** automatic
access to that creator's mailbox. Delegation is future work and will require
explicit authorization — and MASTER_PLAN §4.16 already lists "no accidental
cross-creator private inbox access" as a Phase-F requirement. In B01 the
`decided_by_user_id = user_id` and `requested_by_user_id = user_id` CHECKs make
acting-on-behalf-of unrepresentable rather than merely unimplemented.

**The mailbox is not the login.** The Gmail account used for product data need
not equal the user's app login email, and `provider_account_subject` — Google's
stable subject — is the durable identity. `email_address` is display and routing
only: it can be renamed, aliased, or reassigned to a different human, and keying
on it would eventually attach one person's history to another's.

### Deletion must stay addressable — load-bearing for B03/B04/C

**Every future Gmail-origin or Gmail-derived row MUST be traceable to
`mail_account_id` and `owner_user_id`**, directly or through an unambiguous FK
chain. A Gmail-derived record whose owner provenance is lost is a record that
cannot be deleted on request, which is a restricted-scope obligation, not a
preference.

`mail_accounts` carries the additive `unique (id, user_id)` precisely so future
tables composite-FK the **pair**. Every B01 child already does.

Network aggregation, when it exists, must retain enough **contribution
provenance** to rebuild aggregates after account deletion, network-consent
withdrawal, or user deletion. B01 contracts that requirement and implements no
aggregate.

---

## 8. Tokens and secrets — the contract B02 inherits

**B01 stores no OAuth credential.** No access token, no refresh token, no client
secret, no authorization code. A test asserts that no column in this plane
matches `token|secret|credential|password|refresh|bearer`.

B02 must:

- keep credentials **server-side only**;
- store them **encrypted, in secret storage** — never in a generally queryable
  `public` table alongside metadata;
- **never** return them through a client API;
- **never** log them;
- **revoke at Google** on disconnect, and destroy the stored credential;
- persist the **granted scopes as metadata**, separately from the token material.

`mail_accounts.granted_scopes` is that metadata surface, and it exists so the
product can answer *"what may we do with this mailbox?"* without touching a
secret store. A `connected` row is a statement about **authorization**, never
about a token.

---

## 9. Disconnect is not delete

Conflating these is how a product tells someone their data is gone when it is
not.

| | |
|---|---|
| **DISCONNECT** | Provider access stops. Credentials stop being usable. No future sync. **Stored data may remain** — a creator may legitimately want to keep the workspace history they already built. |
| **DELETE** | Stored Gmail-origin content and Gmail-derived facts are removed. Contribution rows become **ineligible for future network rebuilds**. Completion must be provable. |

The database represents both. A disconnected mailbox with no deletion request is
the first case; `mail_account_deletion_requests` is the second, and its `scope`
records **how much** was asked for, because "delete my data" means different
things to different people and the answer must be captured at request time rather
than decided later by whoever runs the job.

Deferred constraint triggers make the state labels mean something:

- `deletion_pending` requires an **outstanding** request — a state that looks
  like work in progress with nothing behind it is a promise nothing is keeping;
- `deleted` requires a **completed** one — the difference between telling a human
  their data is gone and being able to show it;
- `disconnected` / `deletion_pending` / `deleted` all require
  `disconnected_at is not null` and an **empty scope set**, which is the metadata
  half of revocation. B02 revokes at Google and destroys the credential, and
  neither substitutes for the other.

`network_contributions_invalidated_at` exists so a later phase can **prove** the
withdrawal reached the aggregate layer rather than assuming it. It is NULL in
B01, because B01 produces no aggregates for it to reach.

No UX is implemented. The later "disconnect and keep history" vs "disconnect and
delete" choice has somewhere to live.

---

## 10. Google verification / business readiness — a NON-CODE launch gate

Before Gmail can be offered broadly to external production users, the project
must prepare:

- a public app homepage;
- a **privacy policy on an owned, verified domain**;
- terms as appropriate;
- **OAuth brand verification**;
- **restricted-scope verification** for `gmail.readonly`;
- a written **scope justification**;
- a **demo video** of the Gmail feature and the OAuth flow;
- the applicable **security assessment**;
- a working **deletion capability**;
- current **developer and support contact information**.

None of this is performed in B01, and none of it is engineering. It is recorded
here so future planning cannot treat "add Gmail OAuth" as a sprint task with a
code-shaped estimate.

---

## 11. What 0035 adds

| object | |
|---|---|
| `mail_accounts` | the connected mailbox as G0 metadata: owner, provider subject, connection state, granted scopes. No credential. |
| `mail_account_consent_receipts` | APPEND-ONLY history of what a human agreed to, with policy version, consent-text digest and scopes at decision |
| `mail_account_consents` | the CURRENT answer per (mailbox, permission), composite-FK'd to the receipt it represents |
| `mail_account_deletion_requests` | an explicit, owner-initiated request to DELETE stored Gmail data, distinct from disconnecting |
| `mail_account_has_consent()` | the single definition of "may we?"; no row = NOT granted |
| `assert_mail_account_state_coherent()` | deferred to COMMIT, on all three write origins: no `connected` without consent, no `deletion_pending` without an open request, no `deleted` without a completed one |

Migrations `0001`–`0034` are not modified. **0035 connects no mailbox, infers no
consent, enrols no user and stores no token.**

---

## 12. Not in this layer

- **No Gmail OAuth implementation.** No client id, no callback endpoint, no
  Google Cloud change, no API call.
- **No message, thread, attachment, sync, history or job table.**
- **No attachment ingestion, ever, without a separate contract.** Message text is
  already a restricted-data surface; widening it needs a product reason, not a
  convenience.
- **No import, no classification, no hotel matching, no reply detection, no
  sending, no watch/history sync.**
- **No aggregation, no network intelligence, no model training, no AI.**
- **No agency delegation and no staff-inspection workflow.**
- **No UX** for disconnect-and-keep versus disconnect-and-delete.
- **No real Gmail account connected, and no token stored.**
