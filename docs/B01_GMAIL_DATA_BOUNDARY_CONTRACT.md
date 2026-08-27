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
consent_kind, decision, event_seq)`, so a projection that says `granted` while
naming a withdrawal, or that borrows another mailbox's or another permission's
decision, is **unrepresentable** — not merely unlikely, and not left to a trigger.

### The current consent is the LATEST consent

The composite FK makes the projection agree with the receipt it names. It says
nothing about whether that is the receipt that SHOULD be named, and that gap is
where the worst failure in this layer lives: a withdrawal appended to history
while the projection stays on the earlier grant. The receipt makes the product
look compliant while the permission stays on, and `mail_account_has_consent()` —
which every future G1/G2 caller reads — keeps answering `true`.

Answering "which decision is most recent?" needs an ordering the database owns.
None of the obvious candidates is one:

| candidate | why not |
|---|---|
| `decided_at` | supplied by the caller; a stale, skewed or hostile value sorts a withdrawal before the grant it revokes |
| `created_at` | `now()` is transaction START time — identical for two receipts written together, and a long transaction can stamp earlier than a short later one that already committed |
| `id` | lexical order over random UUIDs is not chronology; it only resembles one |

So each receipt carries `event_seq`, a `generated always as identity` ordinal the
writer cannot supply or override. Three layers use it:

1. the composite FK — the projection's ordinal cannot disagree with its receipt;
2. a BEFORE UPDATE trigger — the projection's ordinal never decreases. **A
   projection can never move backwards to a historical receipt.** Re-granting
   after a withdrawal is allowed ONLY through a new granted receipt, which
   carries a higher ordinal by construction;
3. a deferred invariant — for every (mailbox, permission) with any history,
   exactly one projection exists and it names the receipt with the greatest
   ordinal.

Layer 3 is registered on **both** write origins, receipt INSERT and projection
INSERT/UPDATE/DELETE. This is the A04.6 amendment #3 lesson: the same broken
state is reachable from either side — append a withdrawal and stop, or move the
projection off the latest decision — so an invariant hung off one side is not an
invariant, it is a habit of whoever writes that side.

### The scope snapshot is evidence, not narration

`granted_scopes_at_decision` is the only durable record of what a mailbox could
actually do when a human agreed to something, so it is taken from the mailbox
rather than accepted from the caller: a deferred check requires it to equal the
account's actual scope set at COMMIT of the transaction that created the receipt,
and an allow-list CHECK stops a forbidden scope entering through the consent side
after being refused on the account side.

It is **never rewritten** when account scopes change later. History is a series of
snapshots and each stays true about its own moment; the fix for a changed scope
set is a new receipt. One consequence worth stating: a transaction that clears
scopes and records a withdrawal together snapshots `{}`, so a writer that wants to
record "withdrew while holding `gmail.readonly`" writes the withdrawal receipt
before clearing the account's scopes.

### Widening access requires renewing consent

Incremental authorization means the scope set can grow after the fact — a creator
who agreed to read-only analysis can later be asked for `gmail.send`. Google's
screen asks about **access**. It does not ask again about what this product may
do with the data, and the receipt on file describes a narrower mailbox than the
one now connected.

So a `connected` mailbox's scope set must EQUAL the snapshot on its current
`private_gmail_processing` receipt, checked at COMMIT. Widening — and narrowing,
for the same reason — requires a new private-processing receipt naming the new
set. Disconnecting is not an exception: a disconnected mailbox is not
`connected`, so no consent has to be re-collected in order to stop.

This is stated here because the alternative was leaving the documentation saying
consent is scoped to what was granted while the database quietly permitted the
grant to widen without a human.

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

**One provider account → exactly ONE owning app user**, for as long as any of
that identity's mail-account history exists here. Shared-inbox ownership,
agency delegation and cross-tenant transfer are not implemented.

This is enforced by a dedicated registry, `mail_provider_account_owners`, keyed
`(provider, provider_account_subject)` with an `owner_user_id`, plus a composite
FK from `mail_accounts (provider, provider_account_subject, user_id)` into it.
Not by a unique index on `mail_accounts`, because neither shape of index can
express the rule:

| | |
|---|---|
| **FULL** unique index on the subject | forbids same-owner reconnection, which terminal `deleted` makes necessary. Deletion would come to mean "you may never reconnect this address". |
| **PARTIAL** index over live rows only | permits reconnection but stops seeing retired rows. User A retires a mailbox; user B claims the same Google account while A's consent receipts, consent projections and deletion request are still on file and still A's. One durable identity, two app owners. |

The registry separates the two questions one index was being asked to answer at
once: **who owns a durable provider identity** — the registry, spanning its whole
history — and **how many live connections it may have** — the partial index,
governing only the present, which remains in place at one.

**The race is impossible, not unlikely.** A trigger that read for an existing
owner and refused a different one would let two concurrent transactions both find
nothing and both proceed, because neither sees the other's uncommitted row. The
registry's primary key is the serialization point: claiming is an
`insert … on conflict do nothing`, so the second claimant blocks on the index
until the first commits, then reads the winner and is refused. The composite FK
is the declarative backstop; remove the claim trigger and inserts fail closed,
not open.

**What this permits, and what it refuses.**

| | |
|---|---|
| A retires mailbox S, A reconnects S as a NEW row | permitted — new authorization, new scopes, new consent, new history, new `mail_account_id`. Nothing carries across, because every receipt and projection is bound to a `mail_account_id`. |
| A retires mailbox S, B claims S | **refused** — A's private-plane evidence still exists and is still A's |
| A holds S live, B claims S | **refused** |
| A holds S live, A creates a second live row for S | **refused** — two simultaneous connections, two consent histories, no way to say which governs |
| Editing a mail account's owner or provider subject | **refused** — that is a transfer in one UPDATE, and it would re-point a whole consent history at a different human or Google account |
| Editing the registry's `owner_user_id` | **refused** — the same transfer, one table over |
| Deleting a mail account ROW while its owner exists | reservation stands; it is still that human's claim and they may reconnect |
| Deleting the reservation itself while its owner exists | **refused** — by the trusted role, by the table owner, by anyone, and whether or not any mailbox still references it |
| Erasing the USER entirely | reservation is released with the rest of their private plane |

Erasing the user is the one deliberate release, and it is the ONLY one. The FK
from `mail_accounts` alone was not enough: it refuses while a mailbox references
the reservation and stops meaning anything the moment the last such row is
physically removed, which was enough to move a Google account between app users
in three ordinary statements with the owner untouched. A BEFORE DELETE guard now
refuses whenever the owning user still exists — the state that distinguishes a
direct delete from the cascade, since PostgreSQL removes the parent first —
and `service_role` holds no DELETE on the registry at all, because direct removal
is not a supported operation.

That last row is the one deliberate release. A reservation that outlived its
human would ban a Google account permanently with nothing left in the product to
protect, so after full erasure a different, genuinely authenticated person may
connect that account as a new identity — there is no longer any of A's private
history for them to inherit.

If the product ever needs real transfer of a Gmail account between app users,
that is a NEW contract with its own authorization, deletion and privacy
semantics. It is not something a writer can reach by editing a column.

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

- `deletion_pending` requires the request the account **names** to be outstanding
  — a state that looks like work in progress with nothing behind it is a promise
  nothing is keeping;
- `deleted` requires the request the account **names** to be completed **and**
  scoped `account_and_gmail_derived_data` — the difference between telling a
  human their data is gone and being able to show it, and between deleting what
  they asked for and deleting more;
- `disconnected` / `deletion_pending` / `deleted` all require
  `disconnected_at is not null` and an **empty scope set**, which is the metadata
  half of revocation. B02 revokes at Google and destroys the credential, and
  neither substitutes for the other.

### The state names the deletion it rests on

A deletion state is a claim about a **specific** request, so `mail_accounts`
carries `current_deletion_request_id`, composite-FK'd so the request must belong
to that mailbox. Counting requests instead would let any completed request ever
filed satisfy a present-tense claim — a narrower one, an older one, one from a
connection two authorizations back — and "your account was deleted" would be
provable by an unrelated event.

Two rules are checked IMMEDIATELY rather than at COMMIT, because a deferred check
only ever sees where a transaction ended up:

- entering `deletion_pending` requires the named request to exist and be running
  **at that moment**. Otherwise a writer could pass through `deletion_pending`
  pointing at a request that finished long ago and land on `deleted` in the same
  transaction: the end state looks perfect and the waiting never happened;
- `deleted` is reachable only **from** `deletion_pending`, on the same request.
  The request that ran is the request that is credited.

A completed `gmail_derived_data` request may never retire the record. That
request asked for the opposite — derived data removed, the account record KEPT so
the connection stays auditable — and retiring it anyway would delete something
nobody asked to delete, then read back as evidence that they had.

### `deleted` is terminal

Every other connection state is a stage in a mailbox's life and may be left.
`deleted` is not a stage: it is the assertion that the stored Gmail data is gone
and the record retired. It may not become `pending_authorization`, `connected`,
`reauth_required`, `disconnected` or `deletion_pending`, and the request it names
cannot be swapped afterwards. A revived row would make the assertion false while
still carrying the completed deletion as its evidence.

A returning creator therefore reconnects as a **new** `mail_accounts` row, with a
new authorization and a new consent — which is the honest record of a second,
separate grant of access. The provider-subject uniqueness index excludes retired
rows for exactly this reason; if it did not, terminality would silently mean "you
may never reconnect this address", which is not a privacy guarantee, just a bug.

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
| `approved_gmail_scopes()` | the ONE definition of the permitted scope set, called by both allow-list CHECKs so the account side and the consent side cannot drift |
| `canonical_scope_set()` | sorted-distinct normalisation applied on write, so scope sets compare as SETS rather than as arrays |
| `mail_provider_account_owners` | which app user owns a durable provider identity, for as long as any of its history exists. One owner per `(provider, provider_account_subject)`; released only by erasing that user |
| `mail_accounts` | the connected mailbox as G0 metadata: owner, provider subject, connection state, granted scopes, and the deletion request a retirement rests on. No credential. |
| `mail_account_consent_receipts` | APPEND-ONLY history of what a human agreed to, with policy version, consent-text digest, a database-owned `event_seq` and the scopes actually held at decision |
| `mail_account_consents` | the CURRENT answer per (mailbox, permission), composite-FK'd to the receipt it represents including its ordinal |
| `mail_account_deletion_requests` | an explicit, owner-initiated request to DELETE stored Gmail data, distinct from disconnecting |
| `mail_account_has_consent()` | the single definition of "may we?"; no row = NOT granted |
| `assert_mail_account_state_coherent()` | deferred to COMMIT, on all four write origins: no `connected` without consent, no `connected` whose scopes outrun its consent, no `deletion_pending` without the named request running, no `deleted` without the named request completed at account scope |
| `assert_mail_consent_projection_dominant()` | deferred, on receipt INSERT and projection INSERT/UPDATE/DELETE: the current consent is the latest decision |
| `assert_mail_consent_receipt_scopes_actual()` | deferred, on receipt INSERT: the scope snapshot equals what the mailbox really held |
| `claim_provider_account_owner()` | on mail-account INSERT: claims the durable identity for its owner through the registry's primary key, so concurrent first claims serialize and exactly one wins |
| `enforce_mail_account_state_transition()` | immediate: `deletion_pending` waits on a running request, `deleted` comes only from it, `deleted` is terminal, and a mailbox's owner and provider identity are immutable |
| `forbid_mail_consent_projection_rewind()` | immediate: a projection never moves back to an earlier decision |

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
