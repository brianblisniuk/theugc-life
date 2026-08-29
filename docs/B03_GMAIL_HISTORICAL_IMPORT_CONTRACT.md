# B03 — Gmail historical import: private, resumable, idempotent, sent-rooted

Status: implemented in PR (unmerged). Migration `0037_gmail_historical_import.sql`.
Depends on: [`B01_GMAIL_DATA_BOUNDARY_CONTRACT.md`](B01_GMAIL_DATA_BOUNDARY_CONTRACT.md)
(migration `0035`), [`B02_GMAIL_OAUTH_CONNECTION_CONTRACT.md`](B02_GMAIL_OAUTH_CONNECTION_CONTRACT.md)
(migration `0036`, merged as `f8d088b`), decisions D067 and D068.

---

## 1. The one question this layer answers

> **How does a connected mailbox's historical Gmail content get acquired — over
> one fixed window, without ever exceeding what the human authorized, without
> importing anything twice, and in a way that survives a worker dying mid-run —
> while storing nothing beyond a sanitized provider-shaped snapshot?**

B01 drew the boundary and stored no content. B02 obtained and protected the
credential and stored no content. **B03 is where the first Gmail message body
this system has ever held actually arrives**, which is why most of what follows
is about what may enter the database, what may not, and what happens when the
human changes their mind while a request is on the wire.

**B03 supports:** starting one historical run over one explicit window ·
enumerating sent-rooted candidate threads · fetching those threads · sanitizing
them · storing them once · pausing, cancelling, resuming and completing the run ·
purging everything on deletion.

**B03 does not support, and does not partially implement:** normalized threads,
messages, participants or addresses (B04) · outreach detection or hotel matching
(B05) · reply, timing or outcome facts (B06) · creator corrections (B07) ·
incremental history sync or watch subscriptions (B08) · attachments in any form ·
network intelligence of any kind · sending mail.

---

## 2. What "sent-rooted" means, and why it is a CHECK constraint

A thread is a candidate **iff the creator sent at least one message in it inside
the window**. Enumeration is `users.messages.list` with `labelIds=SENT` and a
bounded date expression; the thread ids of those messages are the work queue.

This is the difference between *acquiring the creator's outreach history* and
*crawling their mailbox*. A newsletter, a personal conversation, and a booking
confirmation for a holiday are all in an inbox; none of them are outreach, and
none of them become candidates unless the creator wrote into that conversation.

It is stored as a value on the run —
`acquisition_strategy = 'sent_rooted_threads_v1'` — under a CHECK that admits no
other string, and mirrored in the application as `B03_ACQUISITION_STRATEGY`.
Widening the acquisition rule is a contract change, and the database makes it
look like one instead of letting a later writer pass a different argument.

**Once a thread is a candidate, the WHOLE thread inside the window is fetched**,
including messages the creator did not send. A conversation with the replies
removed is not a conversation, and every later layer that wants to know whether a
hotel answered would be reading a record that structurally cannot say.

### Drafts are dropped

A message carrying Gmail's `DRAFT` label is discarded — not stored, not counted.
A draft is a sentence somebody typed and did not send. Counting it as
communication would bias every future timing and outcome layer in the same
direction.

---

## 3. The window is fixed at creation

`window_start_at` is supplied explicitly by the caller. B03 does **not** invent
12, 24 or 36 months, or "all history": which lookbacks a human is offered is a
product decision, and a data pipeline is where such a decision becomes permanent
without anyone having made it.

`window_end_at` is set **by the database** when the run is created and never
moves. A worker that re-read "now" on each restart would be importing a window
that grows while it runs, so two restarts of one run would not be the same
operation — and "resumable" would be a word rather than a property.

Owner, mailbox, window and acquisition strategy are the four facts that *are* the
run. A `before update` trigger refuses to change any of them, because a writer
who could edit them could silently widen an import that has already been partly
performed.

### Two filters, and only one of them is authoritative

Gmail's `q` decides what the provider **offers**. The local `internalDate`
comparison against `[window_start_at, window_end_at]` decides what is
**persisted**, and it is authoritative. Gmail's date search is approximate and
timezone-laden; the stored record must not be.

The query is built entirely by B03 from epoch seconds (never `YYYY/MM/DD`, which
Gmail interprets at midnight Pacific). **No browser string, CLI free-text
argument or database column reaches `q`** — a Gmail search query is a capability
that can ask for anything in the mailbox.

---

## 4. What is stored, and what is refused

`private.gmail_raw_messages` holds the sanitized snapshot. **Identity is
`(mail_account_id, provider_message_id)`** — not `(run, message)`. The same Gmail
message observed in ten imports is one message; keying on the run would produce
ten snapshots of one fact and force every later layer to guess which is current.
Provider ids are account-scoped, so the mailbox is part of the key.

Provenance is kept without duplication: `first_import_run_id` and
`last_import_run_id`, `first_seen_at` and `last_seen_at`.

### The sanitizer is a whitelist, in one place

| kept | refused |
| --- | --- |
| the approved message headers (§4.1) | every other header |
| inline `text/plain` and `text/html` body data | any other MIME type's body data |
| MIME structure of omitted parts (mimeType, size) | attachment bytes, `attachmentId` |
| `Content-Type`/`Content-Disposition`/`Content-Transfer-Encoding` **of parts whose body was kept** | those headers on omitted parts — a `Content-Disposition` carries the filename |
| `internalDate`, `labelIds`, `historyId`, `sizeEstimate` | `snippet`, `raw` |

**4.1 Approved message headers:** `From`, `Sender`, `Reply-To`, `To`, `Cc`,
`Bcc`, `Subject`, `Date`, `Message-ID`, `In-Reply-To`, `References`. Values are
preserved verbatim and **not parsed** — deciding who an address belongs to is
B04's job, and doing it here would bake a guess into the raw layer.

A part's body is persistable **only if** its MIME type is on the text list **and**
it has no filename **and** it has no `attachmentId` **and** its
`Content-Disposition` is not `attachment`. Any one of those failing omits the
body and records a reason (`attachment`, `non_text`, `external_body`). **The
sanitizer's failure mode is "kept less", never "stored something we should
not".**

### There is no attachment method

`GmailHistoricalReadAdapter` has exactly two methods: `listSentMessages` and
`getThread`. There is **no** `users.messages.attachments.get` — not a disabled
one, not a guarded one. "B03 never fetches attachments" is a fact about the type,
not a promise about the implementation. There is likewise no send, modify, label
or history method. `getThread` uses `format=full`, never `format=raw`: a raw
response is the whole RFC822 message including attachment bytes, and it would
arrive before any sanitizer could intervene.

### Omissions are counted

`text_parts_omitted_external` and `attachment_or_nontext_parts_omitted` are kept
on the run so a later evaluation can tell how much of the historical record B03
could not see. An import that silently dropped half the bodies would otherwise
look identical to one that captured everything.

### What 0037 deliberately does not create

No normalized thread/message/participant/address table, no outreach or hotel
match, no reply or timing fact, no outcome or correction, no history cursor or
watch subscription, no network-intelligence eligibility or aggregate, no
attachment table and no column that could hold attachment bytes, and no
client-readable view of Gmail content for any role.

---

## 5. Privacy class and reachability

Raw Gmail content is **G1 private** in B01's vocabulary: never contributed to any
shared or network intelligence, never reachable by a client role, never read by
staff, deletion-addressable.

All three B03 tables live in the `private` schema, which grants `USAGE` to
nobody. `service_role` is `BYPASSRLS`, so RLS could never have protected these
tables from the trusted role — **withholding schema usage is what does**. The
only doors are twelve `SECURITY DEFINER` functions in `public`, each with a
pinned `search_path`, each `EXECUTE`-granted to `service_role` alone, and each
taking the owner as part of its **lookup** rather than comparing it afterwards.

`service_role` is a **capability, not an authorization**. Holding it proves a
caller is server-side; it proves nothing about whether the protocol was followed,
which is why every commit re-checks ownership, lease and authorization.

---

## 6. May we still read this mailbox? Asked twice, deliberately

`private.gmail_import_authorization_state(mail_account_id, expected_revision)` is
one predicate, evaluated at **claim** time and again at **every commit**. Four
things must all still hold:

| condition | authority |
| --- | --- |
| the mailbox is `connected` | B02's connection state |
| `private_gmail_processing` consent is `granted` | B01's permission model |
| that consent covers the **current** scope set | B01's exact-scope rule |
| `authorization_revision` is unchanged | B02's database-owned clock |

The gap between claim and commit is a Gmail network call. PostgreSQL cannot
cancel a request already in flight, and B03 does not pretend otherwise. What it
guarantees is the strongest honest property available:

> **The response of a stale step may not be persisted.**

The revision is what makes this a compare-and-swap rather than a re-read. A state
name can leave and come back; a revision cannot go backwards. This is the same
lesson B02 learned three times — a check that spans a network gap must carry the
value it checked, or it is evidence rather than a hold.

### Refusals map onto the lifecycle, and the state name is the reason

- `consent_required` → **pause (consent)**. B01's consent dominance means a
  withdrawn consent leaves the credential intact and moves the mailbox to
  `consent_required`. Treating every non-`connected` state as a Disconnect would
  cancel a run the human could resume by answering the permission question again.
- `reauth_required`, `pending_authorization` → **pause (reauth)**.
- `disconnecting`, `disconnected`, `deletion_pending`, `deleted` → **cancel**
  (`cancelled_connection_stopped`). The human stopped this connection, or a
  deletion owns the mailbox. It does **not** resume by itself if they reconnect
  later; starting again is a decision.
- `authorization_changed` is **not** a lifecycle event. The response is stale and
  nothing of it is kept, but the mailbox may be perfectly healthy; the next claim
  reads the current state and decides from there.

B03 never reconnects Gmail, never re-grants consent and never refreshes a token
itself. It calls B02's one may-we-read chokepoint and records what it says. The
access token exists inside a single function call and is never persisted, logged
or returned.

---

## 7. Resumability: the queue is the database

There is no background runtime in this repository, and pretending otherwise — a
fire-and-forget promise, a request that never returns, an in-memory queue — would
put a pipeline's progress inside a process that can die.

So the database holds the queue (`gmail_historical_import_threads`), the cursor
(`enumeration_page_token`) and the **durable step lease**. Every step is:

```
claim → fresh access token via B02 → exactly one Gmail call → commit
```

If the process dies at any point, the lease expires and the next worker claims
the same work. Idempotence makes that replay safe.

**A lease is liveness, a revision is authorization.** They are deliberately
different mechanisms: a lease answers "is another worker still on this?" (time),
a revision answers "is this still allowed?" (causality). Collapsing them would
make a slow worker look unauthorized and a revoked one look alive.

One active run per mailbox is enforced by a partial unique index over
`('runnable', 'paused_reauth', 'paused_consent')`. Terminal runs coexist freely —
a mailbox may be imported many times over its life and that history is worth
keeping. Two live runs are not two decisions; they are a race for the same quota
and the same rows.

---

## 8. Idempotence: replaying a step changes nothing

| replay | why it is safe |
| --- | --- |
| the same enumeration page | `unique (run_id, provider_thread_id)` on the work queue, and the commit refuses outright if the run's cursor has already moved past the token it was given |
| the same thread fetch | message identity is `(mail_account_id, provider_message_id)`; an unchanged `payload_sha256` skips the write entirely |
| the same completion | `complete_run` is a leased step like any other and a terminal run is not claimable |

The page insert and the cursor advance happen in **one transaction**. Splitting
them is how an enumeration either loses a page or repeats one forever.

A message may **not** move between threads. If the same account/message id is
presented with a different thread id, something upstream is wrong — a mixed-up
response, a confused caller, a fake that does not model reality — and quietly
rewriting the row would bury it. The trigger fails closed.

---

## 9. Failure taxonomy

| provider answer | classification | effect |
| --- | --- | --- |
| 429, `rateLimitExceeded`, `userRateLimitExceeded`, `backendError` | retryable | exponential backoff with jitter, capped, at most 5 attempts |
| 5xx | retryable | same |
| 404 on a thread | `thread_not_found` | **terminal work result**, not a run failure: the thread is `gone`, counted, and no message row is fabricated |
| 403 | `forbidden`, non-retryable | one attempt; explicitly **not** treated as a dead credential — that is B02's judgement to make, and B03 guessing would delete a working token |
| malformed response, or a thread id that is not the one requested | non-retryable | the work item fails; a provider answering with a different conversation is not something to normalize away |

Stored error codes are sanitized slugs matching `^[a-z][a-z0-9_]{0,63}$`. No
provider message, no response body, no address ever enters an error column.

`completed` must not lie: the run reaches it only when enumeration finished, no
work remains, and no permanently failed thread was ignored. A partial import is
not a completed import, however tidy the counters look.

---

## 10. Quota

B03 plans against **4,000 units per minute per mailbox**, deliberately below the
published per-user ceiling, using the provider's published per-method costs:

| method | units |
| --- | --- |
| `users.messages.list` | 5 |
| `users.threads.get` | 40 |

These are values Google publishes and has changed before. They live together in
`src/lib/gmail/import/contract.ts` so a future correction is one edit rather than
a hunt, and `estimated_gmail_quota_units` is documented — in the column comment —
as **an estimate derived from published costs, not a billing statement**.

Running at a published ceiling means treating a number that can change, and that
every other client of the same user shares, as a guarantee. The pacer is
server-side and typed; no request parameter reaches it.

---

## 11. Deletion

B01 defines `deleted` as an assertion that stored Gmail data was removed. **B03
is the first layer that makes that assertion falsifiable, so it is the first
layer that has to check it.**

A deferred constraint trigger registered on `mail_accounts` **and on all three
B03 tables** refuses to let a transaction commit with a mailbox in `deleted`
while any run, thread work item or raw message survives for it. It is registered
on every write origin because a trigger on one table only sees writes to that
table; it is deferred because a legitimate purge touches several tables in one
transaction; and it reads the FINAL state rather than using `pg_trigger_depth()`,
because cascade depth is an implementation detail of *how* rows were removed, not
of *whether* the invariant holds.

`gmail_historical_import_purge_for_deletion` removes all three, and the composite
`(mail_account_id, user_id)` foreign keys cascade with both the mailbox and the
human, so nothing can be orphaned into un-addressability.

---

## 12. Operating it

```
npm run gmail:import:start  -- --user <uuid> --account <uuid> --window-start <ISO>
npm run gmail:import:work   -- --user <uuid> --run <uuid>
npm run gmail:import:resume -- --user <uuid> --run <uuid>
npm run gmail:import:status -- --user <uuid> --run <uuid>
```

`--window-start` accepts an **absolute ISO timestamp only**. Relative expressions
("12 months") are refused: the CLI is not where a lookback policy gets decided,
and an operator typing a duration at 23:59 is how two runs of "the same" import
cover different history.

`status` reports counts and lifecycle only — never a subject, an address, a
thread id or a body.

---

## 13. What this contract does not decide

- Which lookback windows a human is offered in the product UI.
- Whether a historical import starts automatically on connection. It does not,
  today: every run is created by an explicit call.
- Anything about normalization, matching, timing, outcomes or aggregation.
- Whether `provider_history_id` means anything. B03 keeps the value and draws no
  conclusion from it; B08 owns incremental sync.

---

## 14. Verification

- Migration replay: fresh `0001→0037`; populated main `0036→0037` with no drift
  to B01/B02 rows, consent state or authorization revision; no run created by the
  migration itself; and a pre-existing `private.gmail_raw_messages` aborts the
  migration **before** it creates anything (fail before choice), leaving the
  foreign rows untouched.
- Negative controls: removing the raw-message identity, letting the sanitizer
  keep attachment data, dropping the authorization fence, accepting a stale
  lease, splitting the page insert from the cursor advance, and allowing
  `deleted` to coexist with B03 rows each break the suite. A control that does
  not bite means the test was not binding.
- No live Google call is made by any test. The provider is a fake that models
  paging, drafts, attachments, external bodies, vanished threads, rate limits and
  malformed responses.
