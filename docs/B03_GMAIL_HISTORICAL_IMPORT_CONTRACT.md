# B03 — Gmail historical import: private, resumable, idempotent, sent-rooted

Status: implemented in PR #35 (unmerged), amended in place under external audit
amendment #1. Migration `0037_gmail_historical_import.sql`.
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

**The provider query is a SUPERSET of the local window, never a subset.** Gmail
searches at second resolution; `window_end_at` is a database timestamp carrying
milliseconds. Both bounds therefore round OUTWARD —
`after: floor(start/1000) − 1`, `before: ceil(end/1000)` — so the request may
overfetch by under a second at each edge and the exact local filter removes the
excess. Rounding the upper bound inward made the request narrower than the window
it served: with an end of `20:00:00.750`, a sent message at `20:00:00.500` was
inside the authoritative interval and Gmail was never asked for it. **A message
enumeration never returned cannot be recovered by any local filter.**

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
| the approved message headers (§4.1), in `messageHeaders` | every other header |
| inline `text/plain` and `text/html` body data | any other MIME type's body data |
| MIME structure of omitted parts (mimeType, size) | attachment bytes, `attachmentId` |
| `Content-Type`/`Content-Disposition`/`Content-Transfer-Encoding` on **every** part | any header value carrying a `name=`/`filename=` parameter — dropped whole |
| `internalDate`, `labelIds`, `historyId`, `sizeEstimate` | `snippet`, `raw` |

**4.1 Approved message headers** (each occurrence kept, in provider order)**:** `From`, `Sender`, `Reply-To`, `To`, `Cc`,
`Bcc`, `Subject`, `Date`, `Message-ID`, `In-Reply-To`, `References`. Values are
preserved verbatim and **not parsed** — deciding who an address belongs to is
B04's job, and doing it here would bake a guess into the raw layer.

**Two header namespaces, never one.** For a single-part message Gmail's
top-level `MessagePart` is *both* the RFC message carrying `From`/`To`/`Subject`
*and* the MIME part carrying `Content-Type` and `Content-Transfer-Encoding`.
`messageHeaders` and `payload.headers` are therefore separate fields, and neither
may overwrite the other — writing the message headers into the part destroyed the
charset and transfer encoding of the very body being stored, for the commonest
shape of email there is.

**The MIME name filter applies to MIME headers ONLY.** `name=` and `filename=`
are parameters of `Content-Type` and `Content-Disposition`. In the value of an
approved RFC message header they are text a human wrote: `Subject:
filename=proposal.pdf` is a subject line, and discarding it applied a privacy
rule to the wrong namespace — losing real content and protecting nothing. Message
headers are whitelisted and preserved verbatim, with no value filtering;
structural headers keep the guard.

**Both are LISTS, and every approved occurrence survives.** Gmail exposes headers
as a list and RFC 5322 messages — especially the historical and obsolete ones B03
exists to import — can legitimately repeat a field. Reducing them into a
`Record<string, string>` meant a second `To:` silently overwrote the first, which
is B03 choosing which occurrence is the real one. That is interpretation, it is
B04's to make, and B04 could never recover what was discarded here. Names are
lower-cased for stable lookup, values are untouched, provider order is preserved,
and nothing is concatenated or deduplicated.

A part's body is persistable **only if** its MIME type is on the text list
**and** the part is not NAMED **and** it has no `attachmentId` **and** its
`Content-Disposition` is not `attachment`. Any one of those failing omits the
body and records a reason (`attachment`, `non_text`, `external_body`).

**Every MIME safety decision reads EVERY occurrence of the header, not the
first.** Once duplicate headers are admitted and preserved, a part can carry
`Content-Disposition: inline` followed by
`Content-Disposition: attachment; filename*=UTF-8''private.pdf`. A
first-occurrence check saw only `inline`; the filename-bearing header was
correctly dropped from storage and the BODY was persisted anyway — which is the
half that matters. Contradictory provider headers now resolve conservatively:
any `attachment` disposition, or any name parameter on any `Content-Type` or
`Content-Disposition` occurrence, means the body is not persisted. Being wrong in
that direction costs a body we did not keep; being wrong in the other costs
somebody's document.

**A part is NAMED wherever the provider put the name, in every form RFC 2231
permits.** `part.filename`, or a name parameter in `Content-Disposition` or
`Content-Type` — and the parameter may be plain (`filename=`), extended
(`filename*=UTF-8''private.pdf`), continued (`filename*0=`, `filename*1=`) or
both at once (`filename*0*=UTF-8''private-`, `filename*1*=name.txt`). All three
extended forms occur in real historical mail, which is exactly the mail B03
imports, and a guard that only knew `filename=` kept the header and treated the
body as ordinary text.

The value is therefore split on parameter boundaries and each ATTRIBUTE NAME is
matched on its own against `^(?:file)?name(\*\d+)?\*?$`. Gmail frequently leaves
`part.filename` empty while a disposition carries the name; trusting the field
alone would let the provider's formatting choice decide the privacy posture. A
filename-bearing header value is dropped whole rather than kept for its
structural half — `boundary=` is an attribute, not a name, and survives. **The
sanitizer's failure mode is "kept less", never "stored something we should
not".**

### There is no separate attachment retrieval, and no attachment byte is stored

`GmailHistoricalReadAdapter` has exactly two methods: `listSentMessages` and
`getThread`. There is **no** `users.messages.attachments.get` — not a disabled
one, not a guarded one — so it is a fact about the type, not a promise about the
implementation. There is likewise no send, modify, label or history method.
`getThread` uses `format=full`, never `format=raw`: a raw response is the whole
RFC822 message, and it would arrive before any sanitizer could intervene.

**The honest statement, precisely.** `threads.get(format=full)` returns a
`MessagePartBody` that MAY carry `body.data` inline whenever Gmail did not assign
an external `attachmentId`. B03 must fetch the thread to acquire the
conversation, so such bytes can cross the network as part of a response it
legitimately asked for. What B03 guarantees is therefore:

- it **never calls** `users.messages.attachments.get`;
- it **never follows** an `attachmentId`;
- it **never persists** body data for an attachment, a non-text part or a named
  part, and has no table or column that could hold one;
- inline non-text or named bytes arriving inside the required thread response are
  **discarded by the sanitizer before anything is written**.

"No attachment can ever cross the network" would be a stronger claim than the
Gmail API permits, and stating it would be describing a system we do not have.

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

### And a stale claim may not START a read

The commit fence protects the database; it does not protect the mailbox. Between
claiming a step and making the request a worker asks B02 for a token and may wait
out the quota pacer, and a Disconnect in that gap cancels the run and clears the
lease while the WORKER still holds the claim in memory. If the person then
reconnects, B02 hands that worker a perfectly valid token and it reads Gmail
under an import intention that was cancelled — nothing persisted, and a read that
should never have happened.

So the claim is revalidated **immediately before every provider call**, after the
token and after any pacing wait, by
`gmail_historical_import_validate_claim(user, run, lease, revision, step,
thread)`. It proves the same things the commit fence proves — owner, run
runnable, exact lease token, unexpired, exact step, exact thread for a
`fetch_thread` and none for an `enumerate_page`, mailbox connected, consent
granted and exact-scope, revision unchanged — and it mutates nothing. A failed
preflight means **zero Gmail calls**.

**It takes a SHORT lock, and holds it only there.** An unlocked read is not a
serialization point: under READ COMMITTED a plain `SELECT` answers from the
snapshot its statement began with, so a Disconnect committing while the preflight
ran was simply not seen — `ok` returned, the Disconnect landed a moment later,
and the worker read Gmail under a cancelled import. The check was evidence about
a moment that had passed rather than a decision about now.

`for no key update` on the RUN ROW fixes that, and the run row is the right
object: the lifecycle trigger updates that same row inside the
Disconnect/consent/reauth transaction, so the two operations genuinely contend.

| ordering | outcome |
| --- | --- |
| lifecycle transaction first | the preflight WAITS, then sees the stopped run and refuses — **zero Gmail calls** |
| validator first | it holds the row, validates, returns and commits; the lock is released and a Disconnect proceeds |

The lock is **never held across Google**. It lives for the duration of that one
statement — no token exchange, no quota sleep, no `messages.list`, no
`threads.get` happens while it is held. Pinning a PostgreSQL transaction to a
third party's latency would be a different and worse bug. The boundary is then
exact rather than approximate:

| | |
| --- | --- |
| **before** the validation transaction commits `ok` | a cancellation, a withdrawn consent or a reclaimed lease prevents the READ |
| **after** it commits `ok` | the operation is in flight; a cancellation prevents the RESULT being persisted |

A paused run therefore requires an explicit **resume** before another provider
read, not merely before another write.

**Every claim-derived result names the revision it came from** — the successful
commits, and equally `record_thread_gone`, `record_retry` and
`commit_completion`. Marking a work item `gone`, spending an attempt from its
budget, and stamping a terminal status on a run are all mutations, and a mutation
decided by a response obtained under revision N may not land under revision N+2.
**A NULL revision is refused outright**: "compare against whatever is current" is
precisely the comparison that lets a stale response through, so it is not on
offer. `commit_completion` makes no Gmail call at all and is fenced anyway,
because what changes between its claim and its commit is a human decision.

**A lease names one thread.** A valid token for T1 is not permission to record a
result against T2 — that would let one claimed step spend another item's budget.

The revision is what makes this a compare-and-swap rather than a re-read. A state
name can leave and come back; a revision cannot go backwards. This is the same
lesson B02 learned three times — a check that spans a network gap must carry the
value it checked, or it is evidence rather than a hold.

### A human decision is durable, not observed

Asking "may we read this mailbox?" whenever a worker happens to look is enough to
stop a stale response being persisted. It is **not** enough to record that a
person made a decision:

```
run R is runnable
the person Disconnects        no worker is running
the person Reconnects         no worker is running
a worker finally polls        every question it can ask is answered by the
                              CURRENT row, which says `connected`
```

The Disconnect happened and R simply carried on. So a lifecycle change is no
longer something to be observed: a narrow trigger on `mail_accounts` carries the
transition into B03's runs **inside the same transaction that moved the mailbox**.

| the mailbox enters | non-terminal runs become |
| --- | --- |
| `disconnecting`, `disconnected`, `deletion_pending`, `deleted` | `cancelled_connection_stopped`, lease cleared |
| `reauth_required`, `pending_authorization` | `paused_reauth` (from `runnable`) |
| `consent_required` | `paused_consent` (from `runnable`) |
| `connected` | **nothing** |

`connected` doing nothing is the point. Reconnecting answers "may we read your
mail again"; it does not answer "please resume the import you stopped". A paused
run stays paused until somebody resumes it, a cancelled run stays cancelled
forever, and starting again means starting a NEW run. The trigger is idempotent,
never rewrites a terminal run, writes only B03 run rows, and deletes nothing — a
Disconnect is not a deletion.

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

**Enumeration carries its own durable retry budget.** A thread fetch has a work
item to count attempts against; a listing page has nothing but the run, so
`enumeration_attempt_count` and `enumeration_next_attempt_at` live on the run
itself. Without them a `messages.list` that keeps answering 429 is retried by
whichever process polls next, forever, remembering nothing — an unbounded loop
wearing the costume of a retry policy. The budget belongs to the CURRENT cursor:
a successful page commit resets it, because the next page is a different provider
operation. Exhausting it ends the run `failed`; a non-retryable error exhausts it
on the first attempt. The backoff is enforced by the CLAIM, so a fresh process
cannot skip a delay that lived in the process that scheduled it.

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

**A malformed success is not an empty mailbox.** A 200 whose body will not parse,
whose `messages` is not a list, that names a candidate with no id, or that
carries a non-string `nextPageToken` used to read as "enumeration finished, zero
candidates" — indistinguishable from a creator who simply sent nothing. Each one
now fails the PAGE. One bad entry fails the whole page rather than being dropped,
because a silently shrunken candidate set is invisible to everything downstream.
An ABSENT `messages` key stays legitimate: Gmail omits it on an empty page.

**Every field B03 relies on is validated at runtime, in one place**
(`provider-shape.ts`), and a TypeScript cast over parsed JSON is not treated as a
fact about what arrived. In particular `typeof [] === "object"`, so a top-level
`200 []` once passed an object check and read as a successful final empty page;
the top level must now be a non-array object. `messages` must be an array if
present, each candidate an object with non-empty string `id` and `threadId`, and
`nextPageToken` a non-empty string if present.

The thread response is validated the same way: non-array object, non-empty `id`,
`messages` **must be an array** (an absent one is a response we did not
understand, not an empty conversation), and for every **non-draft** message a
non-empty `id`, a `threadId` equal to the thread's own, a valid `internalDate`,
a string `historyId` if present, a finite `sizeEstimate` if present, and a
non-array object `payload` whose MIME tree is validated recursively — headers as
a list of `{string name, string value}`, body as an object with optional string
`attachmentId`/`data` and finite `size`, `parts` as an array of valid parts.

**`internalDate` needed a real parser, not a coercion.** `Number("")`,
`Number("   ")` and `Number(null)` are all `0`, so `Number.isFinite(Number(x))`
accepted a message with no timestamp and stored it dated 1 January 1970 — a fact
about somebody's conversation, invented by a coercion rule. The provider value
must now be a non-empty decimal integer string that survives as a safe integer.

**Nothing malformed is coerced into `[]`, `{}`, `0` or `null`.** A malformed
non-draft message fails the fetch: the work item stays pending, then fails, and
the run cannot reach `completed`. Drafts are established from their labels and
dropped before their content is examined, so nothing about them can be malformed.

Stored error codes are sanitized slugs matching `^[a-z][a-z0-9_]{0,63}$`. No
provider message, no response body, no address ever enters an error column.

`completed` must not lie: the run reaches it only when enumeration finished, no
work remains, and no permanently failed thread was ignored. A partial import is
not a completed import, however tidy the counters look.

**And the failure is written when it becomes true, not when somebody next
looks.** A terminal thread failure fails the RUN in the same transaction that
records it: `failed`, `phase = finished`, `completed_at` set, lease cleared. The
alternative was a state where the worker had already reported `failed` and the
database still said `runnable` — the run holding the one-active-run index for a
mailbox nobody was importing, its real status recoverable only by running `work`
a second time so a later step could notice. The database is the durable truth in
this block, so one `work` command is enough. Pending siblings of a failed thread
stay as evidence of work that was not done, and are unclaimable because a
terminal run hands out no leases.

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

**What the pacer actually guarantees.** It is PROCESS-LOCAL. One
`gmail:import:work` process paces itself to the budget; two independently started
worker processes do not share a bucket, and nothing about it survives a restart.
Calling it a durable per-mailbox rate limiter would be an overstatement, so it is
not called one. What actually bounds a run that asks for too much is the durable
half: a 429 is recorded on the run or the work item, backed off with jitter, and
capped at five attempts, all in the database. Making pacing durable is possible
and is deliberately not being done here — B03 is not being widened into
distributed infrastructure for it.

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

## 13a. External audit amendment #1

The principal architecture survived the first external audit; five correctness
gaps did not, and each was reproduced as real committed state on real PostgreSQL
before it was fixed.

- **Enumeration retries were neither bounded nor durable.** `record_retry` only
  incremented an attempt when a provider thread was named, so a `messages.list`
  429 counted nothing and scheduled nothing. Fixed by §7's run-level budget.
- **A human lifecycle decision existed only if a worker observed it.** A
  Disconnect followed by a Reconnect with nothing polling in between left the run
  runnable. Fixed by §6's transition trigger.
- **Failure and completion paths escaped the fence.** `record_thread_gone` was
  called with a NULL revision, `record_retry` had no revision parameter at all,
  and `commit_completion` had none either. Fixed by §6; NULL is now refused.
- **A fractional `window_end_at` made the provider query narrower than the
  window.** Fixed by §3's outward rounding.
- **Message headers overwrote MIME structural headers on single-part mail.**
  Fixed by §4's two namespaces.

Two smaller defects were found alongside them: an `inline; filename="…"`
disposition could carry a filename past the attachment guard (§4), and a
malformed provider response read as a successful empty result (§9).

## 13b. External audit amendment #2

Three merge-blocking gaps and one raw-completeness correction, each reproduced
before it was fixed.

- **A cancelled or paused claim could still START a new Gmail request.**
  Amendment #1 made the lifecycle decision durable, but the worker holds the
  claim in memory across the token acquisition and the pacer wait; after a
  Disconnect→Reconnect, B02 would hand it a valid token and it would read Gmail
  under a cancelled intention. Fixed by §6's pre-provider claim fence.
- **Malformed-success validation was partial.** `typeof [] === "object"`, so a
  top-level `200 []` read as a successful empty final page. Fixed by §9's strict
  runtime validators, which also caught `Number("") === 0` dating a message to
  1970.
- **RFC 2231 extended and continued filenames bypassed the name guard.**
  `filename*=UTF-8''private.pdf` and `filename*0*=…` kept both the header and the
  body. Fixed by §4's attribute-level parameter check.
- **Repeated approved headers lost occurrences.** A `Record<string, string>` kept
  one `To:` of two. Fixed by §4's lossless header lists.

The `QuotaPacer`'s real guarantee is now stated in §10 rather than implied, and
the attachment wording was carried into the code comments as well as the docs.

## 13c. External audit amendment #3

- **The preflight was not linearizable.** It read the run without a lock, so a
  Disconnect committing during it was invisible and `ok` was returned anyway.
  Fixed by §6's short `for no key update` serialization point, proved with two
  real PostgreSQL sessions and `pg_blocking_pids`.
- **MIME safety decisions read only the first header occurrence.** A second
  `Content-Disposition: attachment; filename*=…` was dropped from storage while
  its body was kept. Fixed by §4's all-occurrence rule.
- **The MIME filename filter ran on RFC message-header values**, discarding
  `Subject: filename=proposal.pdf`. Fixed by §4's namespace separation.
- **A terminal thread failure left the run `runnable`** while the worker reported
  `failed`. Fixed by §9's same-transaction run failure.

## 14. Verification

- Migration replay: fresh `0001→0037`; populated main `0036→0037` with no drift
  to B01/B02 rows, consent state or authorization revision; no run created by the
  migration itself; and a pre-existing `private.gmail_raw_messages` aborts the
  migration **before** it creates anything (fail before choice), leaving the
  foreign rows untouched.
- Negative controls: removing the raw-message identity, letting the sanitizer
  keep attachment data, dropping the authorization fence, accepting a stale
  lease, splitting the page insert from the cursor advance, and allowing
  `deleted` to coexist with B03 rows each break the suite. Amendment #1 added
  seven more — removing the enumeration budget, removing the lifecycle trigger,
  disabling the revision fence on the result paths, flooring the upper search
  bound, letting message headers overwrite the part headers, silently dropping
  malformed entries, and trusting `part.filename` alone — and each of those bites
  too. Amendment #2 added four more: removing the pre-provider claim validation
  (5 failures), accepting array/coercible malformed provider shapes (6), dropping
  RFC 2231 extended-name detection (7), and collapsing repeated approved headers
  (3). Amendment #3 added four more: removing the validator's row lock
  (3 failures), restoring first-occurrence-only MIME decisions (5), applying the
  filename filter to message headers (4), and letting a terminal thread failure
  leave the run runnable (7). **Twenty-one negative controls in total**, and a
  control that does not bite means the test was not binding.
- No live Google call is made by any test. The provider is a fake that models
  paging, drafts, attachments, external bodies, vanished threads, rate limits and
  malformed responses.
