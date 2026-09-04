# B04 — Gmail private normalization: deterministic messages, participants, text parts

Status: implemented in PR (unmerged). Migration `0038_gmail_private_normalization.sql`.
Depends on: [`B01_GMAIL_DATA_BOUNDARY_CONTRACT.md`](B01_GMAIL_DATA_BOUNDARY_CONTRACT.md)
(migration `0035`), [`B03_GMAIL_HISTORICAL_IMPORT_CONTRACT.md`](B03_GMAIL_HISTORICAL_IMPORT_CONTRACT.md)
(migration `0037`), decisions D067, D068, D069.

---

## 1. The one question this layer answers

> **How does each private Gmail raw message B03 produced become a private,
> deterministic, replay-safe normalized communication record whose Gmail
> thread, message headers, participants, references and textual MIME parts
> are reconstructable from exact source evidence, without yet inferring
> outreach, hotel, reply, negotiation or outcome semantics?**

B03 acquired a sanitized snapshot and interpreted none of it: headers were
preserved as opaque lists, and there was no thread, no participant, no
address. **B04 is the first layer that turns that raw evidence into a
projection anything downstream can actually query** — while remaining exactly
as uninterested as B03 was in what any of it *means* for the product.

**B04 supports:** normalizing one raw message, a bounded batch, or every
stale/missing projection for a mailbox · account-scoped thread and message
identity · lossless header-occurrence preservation · syntactic address-list
parsing · syntactic message-id reference tokenization · deterministic MIME
structural traversal · exactly-once Gmail-API base64url decoding with an
explicit charset policy · durable invalidation when B03 replaces a raw
snapshot · purging on deletion.

**B04 does not support, and does not partially implement:** outreach
detection or hotel matching (B05) · reply, timing or outcome facts, including
any parent/child message relationship (B06) · creator corrections (B07) ·
incremental sync (B08) · attachment retrieval or storage in any form ·
network intelligence of any kind · sending mail · a creator-facing or
admin-facing UI of any kind.

---

## 2. Three layers, not two

```
RAW GMAIL EVIDENCE  (B03, private.gmail_raw_messages)
   != NORMALIZED GMAIL PROJECTION  (B04, private.gmail_normalized_*)
   != BUSINESS SEMANTICS  (B05+)
```

B03's raw row remains the source of truth for what Gmail supplied inside the
approved historical window. B04's rows are **deterministic projections** of
that evidence — the same source in always produces the same projection out.
B05 and later may interpret a normalized communication as outreach, a reply,
a negotiation. **B04 must not**, and nothing in this migration reads or writes
a hotel, a pipeline item, an outreach event or a collaboration.

---

## 3. Means / does not mean

| term | means | does NOT mean |
| --- | --- | --- |
| normalized message | a projection bound to one exact raw snapshot | the raw message itself, or a message that will never change |
| Gmail thread (`gmail_normalized_threads`) | Gmail's own conversation grouping | that this is creator outreach — B05's judgement, on top of this row |
| `provider_sent = true` | this provider message carried Gmail's `SENT` label in the raw evidence | outreach, a pitch, a first send, a pipeline event, successful delivery |
| `provider_sent = false` | the raw evidence carried no `SENT` label | inbound, a reply, a hotel response, a received response — **no negative inference is licensed** |
| a Message-ID/In-Reply-To/References token | syntactic message evidence | a proven reply relationship — B04 writes no `parent_message_id`, no `is_reply`, no `reply_received` |
| a malformed header or address | evidence that stayed evidence | "no participant" — a row exists with an explicit failure status |
| absent body | no `body.data` ever arrived for this part | an empty body, and neither means content B03 chose to omit |
| deterministic thread order | a reproducible `ORDER BY` for reading a thread | a proven reply graph — `provider_message_id` is a tie-break, not chronological evidence |
| decoded HTML text | private source text | content declared safe to render in a browser — B04 builds no UI |
| private Gmail-derived data | still subject to D067's Limited Use rules | network-eligible the moment it is structured |

---

## 4. Canonical identities

**Thread identity: `(mail_account_id, provider_thread_id)`.** **Message
identity: `(mail_account_id, provider_message_id)`.** Both mirror B03's own
raw identity exactly, because Gmail's ids are **account-scoped**: the same
`provider_thread_id` or `provider_message_id` string under two different
mailboxes names two unrelated Gmail objects, and must produce two distinct
rows. There is no global provider-message identity, and a message is never
identified by its `Message-ID` header, its subject, its participants or its
timestamp — those are evidence, not the provider's own key.

Both identities are enforced by real PostgreSQL constraints, not by
convention: `unique (mail_account_id, provider_thread_id)` on threads,
`unique (mail_account_id, provider_message_id)` on messages, and a composite
`unique (id, mail_account_id)` on threads so a message's thread FK can require
the SAME account rather than merely a real thread.

---

## 5. Exact raw → normalized provenance

A normalized message proves three things simultaneously, each a real
constraint rather than a comment:

1. **exact raw identity** — `gmail_normalized_messages_raw_fk`, a foreign key
   on `(mail_account_id, provider_message_id)` into
   `private.gmail_raw_messages`. This alone also makes cross-account raw
   provenance unrepresentable: a message cannot claim a `mail_account_id`
   that disagrees with the raw row it points at, regardless of what any
   caller asserts;
2. **exact snapshot digest** — `source_payload_sha256`, compared against the
   raw row's CURRENT `payload_sha256` at every commit (§7);
3. **exact normalizer contract** — `normalizer_version`, currently always
   `gmail_normalizer_v1`, a semantic contract version rather than a git SHA,
   a timestamp or a package version. Unlike B03's `acquisition_strategy`
   (fixed forever by a single-value CHECK), this column is a sanitized-slug
   shape (`^[a-z][a-z0-9_]{0,63}$`) because it is **expected** to grow over the
   table's life: a row written under an older version is a rebuild candidate,
   not a violation.

A projection whose recorded digest or version differs from the raw row's
current values is **not current** — and, per §7, is not merely stale but
already gone.

---

## 6. Source replacement: durable invalidation, not "the worker will notice"

B03 legitimately updates an existing `(mail_account_id, provider_message_id)`
raw row when the provider snapshot changes — new labels, an edited header, a
new history id. That is a real sequence:

```
raw digest AAA  ->  normalized projection AAA
        (later)
raw digest BBB  (same identity)
```

The old AAA projection must not survive the BBB commit as if it were current.
B04 does not solve this by having the next worker notice next time it looks.
An `AFTER UPDATE OF payload_sha256` trigger on `private.gmail_raw_messages`
itself — installed **additively from 0038**, never touching 0037's file —
deletes the message's existing normalized projection (and, by cascade, every
header/participant/reference-token/text-part beneath it) **inside the same
transaction that changes the raw row**, the moment the digest actually moves
(`when (new.payload_sha256 is distinct from old.payload_sha256)`). By the time
that transaction commits, no stale projection exists to be read.

**Required orderings, both real, both proved with true multi-session
PostgreSQL tests (§9):**

| ordering | outcome |
| --- | --- |
| normalizer wins the row lock first | it binds AAA and commits; the waiting raw update proceeds immediately afterward and its own trigger deletes AAA in the same transaction that writes BBB |
| raw update wins the row lock first | it commits BBB; a normalizer that started against AAA observes the CAS failure (`stale_source`) and writes nothing — it does not blindly persist a snapshot that no longer exists as current |

No PostgreSQL lock is ever held across anything but a single SQL statement's
worth of work inside one function call — B04 makes no network call at all, so
there is no gap to protect a lock across.

---

## 7. The short lock, and the compare-and-swap it enables

`gmail_normalize_commit_message` takes `select ... for no key update` on the
**exact raw row** it is about to normalize, held only for the duration of
that one function call — the same shape as B03's `validate_claim` preflight,
applied here to a purely local race instead of a network one. Two
consequences fall out of that one lock:

- **two concurrent normalizers on the same raw row genuinely serialize.** The
  second waits, then re-reads the row inside its own lock and finds a current
  projection already sitting there — `already_current`, not a duplicate;
- **a concurrent raw update on the same row genuinely serializes against a
  normalizer holding it**, in either direction (§6).

The compare-and-swap itself is the raw row's own `payload_sha256`, not a
purpose-built revision counter: the caller names the exact digest it
normalized against, `p_expected_source_payload_sha256`, and the function
refuses to write if the row's current digest disagrees. `provider_sent` and
`provider_thread_id` are **derived inside the function from the locked raw
row**, never accepted as parameters — the same reason `commit_thread` never
accepted a caller-supplied candidacy boolean: a provenance-relevant fact is
not the caller's to assert.

**Exact replay is a true no-op, not merely "not offered as a candidate
again."** If a current projection already exists for the exact digest and
version, the function returns `already_current` without writing a byte — no
new id, no updated `updated_at` or `normalized_at`, no duplicate child row.
This is proved by calling the commit function **directly**, bypassing the
candidate list, because the list already filters out current messages and
would otherwise hide a regression in the commit function's own guard.

---

## 8. Normalizer execution model

B04 is **entirely local**. It reads only rows already committed to
`private.gmail_raw_messages` by B03. **Zero Google calls. Zero OAuth changes.
Zero Gmail quota.** There is no lease, no authorization-revision fence and no
quota pacer anywhere in 0038, because none of them protect anything that
exists here — B03's own authorization state is untouched and unconsulted.

Three operations, each a `SECURITY DEFINER` RPC:

- `gmail_normalize_list_candidates` — read-only, no lock: a raw message is a
  candidate iff its projection is **absent**, **out of date** (differing
  `payload_sha256`) or **stale by version** (differing `normalizer_version`),
  ordered by `(internal_date, provider_message_id)` for a reproducible batch;
- `gmail_normalize_commit_message` — the atomic write described above;
- `gmail_normalize_status` — counts only (threads, messages, header
  occurrences, participants, reference tokens, text parts, stale/missing
  projections), matching B03's status philosophy: never a subject, an
  address, a thread id or decoded text.

The TypeScript side (`src/lib/gmail/normalize/`) does the interpretation work
the database refuses to do — address parsing, MIME traversal, base64url
decoding, charset handling — and hands the DATABASE the computed rows plus the
exact digest it normalized against. The database is still the authority on
whether that computation may become the current projection.

`normalizeOneCandidate`, `normalizeBatch` and `normalizeMailboxUntilIdle`
(`src/lib/gmail/normalize/service.server.ts`) compose these into: one message;
a bounded batch; or a whole mailbox's stale/missing backlog, in controlled
batches until none remain. The operator entrypoint is
`npm run gmail:normalize:run -- --user-id <uuid> --mail-account-id <uuid>`.

---

## 9. Concurrency, proved with real PostgreSQL sessions

Three cases, each proved with `pg_blocking_pids` rather than a sleep-based
timing guess:

- **C1 — two normalizers competing for the same source.** The second
  genuinely blocks on the first's row lock, then converges to exactly one
  message row and one header set — never two.
- **C2 — a normalizer's lock vs. a concurrent raw update.** The raw update
  genuinely blocks until the normalizer commits, then its own trigger
  invalidates what the normalizer just wrote.
- **C3 — a raw update's lock vs. a concurrent normalizer.** The normalizer
  genuinely blocks until the raw update commits, then observes the CAS
  failure and writes nothing against the now-superseded digest.

---

## 10. Header occurrences: lossless, exactly like B03's own promise

B03 already refused to let a second `To:` overwrite a first. B04 does not
regress that one layer up: `private.gmail_normalized_headers` holds **one row
per approved occurrence**, carrying both `occurrence_index` (position among
occurrences of its own name) and `global_order` (position among ALL approved
headers on the message, reconstructing the original interleaved provider
order). `unique (normalized_message_id, header_name, occurrence_index)` and
`unique (normalized_message_id, global_order)` make duplication structurally
impossible, not merely discouraged.

Repeated `Subject` occurrences remain repeated and ordered — B04 does not
decide which one is "the real subject," and no convenience column exists that
would silently answer that question by fiat.

---

## 11. Participants: syntactic parsing, nothing inferred

Parsed only from address-bearing occurrences: `From`, `Sender`, `Reply-To`,
`To`, `Cc`, `Bcc`. The parser is `addressparser` (MIT, zero dependencies, the
same library nodemailer itself uses for the identical problem) — a real
RFC 5322-aware tokenizer, not a comma split or an ad-hoc regex: it respects
quoted strings (`"Smith, John" <j@x.com>` does not split into two addresses)
and understands RFC 2822 group syntax (`Undisclosed-recipients:;`).

Each parsed entry links to its **exact source header occurrence** via a real
foreign key (`source_header_id`), not a duplicated `(name, index)` pair, and
carries `participant_order` — its position among entries parsed from that ONE
occurrence. `unique (source_header_id, participant_order)` makes a duplicate
order within one header structurally impossible.

**What B04 refuses to do, deliberately:** strip `+tag` addressing; collapse
Gmail's dot-insensitive local part; lowercase or otherwise rewrite the local
part as identity truth (`domain_lower` is a MECHANICAL convenience column,
never treated as the address); merge two entries into "the same human";
decode RFC 2047 encoded-words in a display name (a MIME-decoding step, out of
scope for V1 — the raw header value stays available verbatim via the linked
header row); infer a hotel, a creator, an employee or a target contact.

**Malformed evidence is a row, never an absence.** `parse_status` distinguishes
three outcomes, and NONE of them produces zero participant rows for a header
that carried text:

| `parse_status` | means |
| --- | --- |
| `parsed` | a clean addr-spec was extracted; `addr_spec`/`local_part`/`domain` are populated |
| `malformed` | text was present but did not resolve into a clean addr-spec; `raw_fragment` carries what was recovered |
| `empty_group` | a genuine RFC 2822 group construct naming zero addresses (`Undisclosed-recipients:;`) |

The distinction between `malformed` and `empty_group` had to be tracked
explicitly through the parser rather than inferred from the parsed shape:
`addressparser` represents both an empty group and ordinary unparseable
garbage as the identical `{name, address: ""}` shape once flattened, and
collapsing that during development briefly misclassified a legitimate empty
group as a parse failure. Fixed by carrying the group marker through
flattening instead of reconstructing it after the fact.

A header value that tokenizes to literally nothing (empty, whitespace-only,
total garbage) still produces exactly ONE `malformed` row carrying the raw
value — never zero rows, which is indistinguishable from a header that was
never there at all.

---

## 12. Message references: syntactic tokens, explicitly not a reply graph

`Message-ID`, `In-Reply-To` and `References` are tokenized into individual
`<local@domain>`-shaped tokens, in order, each linked to its exact source
header occurrence exactly like a participant. `parse_status` is
`valid_msgid` or `malformed` — a token missing a bracket or an `@` is still a
row.

**This is useful evidence for a later block, and it is explicitly not a
reply relationship.** There is no `parent_message_id`, no
`reply_to_normalized_message_id`, no `is_reply`, no `reply_received` anywhere
in 0038, and no code path compares one token's value against another
message's `Message-ID` to decide anything. That comparison — and everything
it would imply about timing, qualification and outcome — belongs to B06,
under its own contract.

---

## 13. MIME structural paths and the base64url decoding rule

B04 traverses the sanitized MIME tree deterministically and identifies each
part by its **structural position** — `[]` the root, `[0]` its first child,
`[1,0]` the first child of the second — because B03 never promised Gmail's
`partId` survived sanitization, and B04 does not fabricate one.
`unique (normalized_message_id, part_path)` makes a duplicate path
structurally impossible.

**Only `text/plain` and `text/html` parts get a row at all** — the exact list
B03 itself was willing to persist body data for. A part B03 recorded as
`contentOmitted` (attachment, non-text, or an external body it refused to
fetch) still gets a row **if its `mimeType` was text/plain or text/html**,
with `decode_status = 'content_omitted_by_b03'` and the omission reason
preserved verbatim — B04 cannot resurrect content B03 chose not to keep, and
does not try. A genuinely non-text part (`image/png`, and so on) produces
**no row whatsoever**: there is no attachment table, no column that could
hold attachment bytes, and no code path that calls
`users.messages.attachments.get` — that method does not exist anywhere in
this codebase.

**The locked V1 decoding rule**, and the evidence behind it, kept in three
explicit layers so a documented fact is never confused with an observed
behavior or with our own policy choice:

- **Official documented fact.** The Gmail API discovery schema for
  `users.messages` describes `MessagePartBody.data` only as "the body data
  of a MIME message part... as a base64url encoded string." It says nothing
  anywhere about `Content-Transfer-Encoding` or about whether that header's
  transfer encoding has already been applied to `data`. There is no official
  guarantee to rely on here.
- **Empirical provider behavior (not documented by Google).** In practice,
  decoding `data` as base64url exactly once yields the final body bytes even
  when the source message's `Content-Transfer-Encoding` header says `base64`
  or `quoted-printable` — Gmail appears to unwrap that transfer encoding
  before populating `data`. This is an observation about the provider's
  behavior, not a contractual guarantee, and it could be falsified for some
  message in the future.
- **Our V1 policy**, built on that observation: B04 decodes `MessagePartBody.data`
  as base64url — the TRANSPORT encoding of a body Gmail already extracted
  from the raw MIME message — **exactly once**, then interprets the
  resulting bytes under a charset. `Content-Transfer-Encoding` is preserved
  as **source MIME evidence** (every occurrence, verbatim) and is **never**
  inspected to trigger a second decode, so decoded bytes that happen to look
  like base64 text stay literal rather than being re-decoded. B04
  deliberately does not double-decode speculatively to hedge against the
  empirical assumption being wrong; instead, because B03's raw payload is
  fully preserved and reconstructable, a future normalizer version can
  reprocess affected messages if the assumption is ever falsified.

**Charset policy**, applied to every surviving `Content-Type` occurrence on
the part, never just the first:

| situation | outcome |
| --- | --- |
| exactly one charset declared, supported, bytes valid | `decoded` / `empty_decoded`, `charset_source = 'declared'` |
| exactly one charset declared, supported, bytes invalid | `decode_failure` |
| exactly one charset declared, not a recognized label | `unsupported_charset` |
| two or more DIFFERING charsets declared | `conflicting_charset` — never resolved by first-wins or last-wins |
| no charset declared, strict UTF-8 succeeds | `decoded` / `empty_decoded`, `charset_source = 'no_declaration_utf8_fallback'` |
| no charset declared, strict UTF-8 fails | `missing_charset_undecodable` — never silently replaced with another encoding |
| no `body.data` at all | `body_absent` (or `content_omitted_by_b03` if B03 flagged it) |
| `body.data` present but not valid base64url | `invalid_base64url` |

Charset support comes entirely from Node's built-in `TextDecoder` (backed by
ICU), used with `{ fatal: true }` so an invalid byte sequence under a
recognized charset is a decode failure, never a silent replacement. No new
dependency was needed for this half of the pipeline.

Plain and HTML bodies are stored **independently** — never concatenated,
never one chosen as canonical, never converted into the other, never
stripped of quotes/signatures/disclaimers. Decoded HTML is **private source
text**, not declared safe for rendering; B04 builds no UI that could render
it.

---

## 14. Privacy and security

Every B04 table lives in `private`, the schema B02 already revoked `USAGE`
on for `public` (and therefore `anon` and `authenticated`) — the same posture
B03's own three tables rely on, since `service_role`'s `BYPASSRLS` means RLS
could never have protected these tables from the trusted role in the first
place. No B04 table enables row-level security, for the same reason none of
B03's do: a role with no schema `USAGE` cannot resolve the table well enough
for a policy to matter, and pretending otherwise would be exactly the
"RLS is enabled, so it's secure" reasoning this project refuses.

`service_role` itself holds **no direct grant** on any B04 table — verified
directly, not only through schema `USAGE`. The only doors are the four
`SECURITY DEFINER` functions in `public`, each pinning `search_path`, each
`EXECUTE`-granted to `service_role` alone, each taking the owner
`(mail_account_id, user_id)` as part of its lookup rather than comparing it
afterward — the same reason a call naming the wrong `user_id` for a real
`mail_account_id` returns `not_found` rather than reading somebody else's
mail.

---

## 15. Deletion and disconnect

Unchanged B01 semantics: **disconnect** may retain historical data;
**delete** must remove Gmail-origin and Gmail-derived data. B04 extends the
choreography **additively from 0038**, never touching 0037's purge function
— `gmail_normalize_purge_for_deletion` is B04's own function, mirroring
`gmail_historical_import_purge_for_deletion`'s guard conditions exactly
(only while `deletion_pending`, only for the request the mailbox actually
names, only for a scope that includes Gmail data), and removes B04's own
tables and nothing else. Deleting `gmail_normalized_threads` is sufficient;
every message, header, participant, reference token and text part cascades.

**The invariant is a deferred constraint, not an ordering promise.** A NEW
`assert_gmail_normalized_data_absent_when_deleted()` function — checking only
`gmail_normalized_threads`, since every other B04 row requires a live thread
by FK — is registered as a deferred constraint trigger on `mail_accounts`,
`gmail_normalized_threads` and `gmail_normalized_messages`, mirroring B03's
own registration-on-every-write-origin rule. A transaction that marks a
mailbox `deleted` while any normalized thread survives for it is refused at
COMMIT, regardless of which write happened first.

---

## 16. Idempotency

| replay | why it is safe |
| --- | --- |
| the same message, same digest, same version | the commit function's own `already_current` short-circuit — zero writes, proved by calling it directly, not only via the candidate list |
| the same batch | `gmail_normalize_list_candidates` excludes anything already current, so a repeated batch normalizes nothing |
| a raw digest change | the AFTER UPDATE trigger invalidates the old projection in the SAME transaction as the change; the next normalization binds only the new digest |
| a normalizer-version bump | an old-version row is offered as a candidate again and rebuilt; nothing about the OLD row is treated as current in the meantime |
| a forced mid-write failure | one PL/pgSQL function call is one transaction — any exception anywhere inside it rolls back everything committed so far in that call, leaving either the PREVIOUS valid projection intact or no projection at all, never a mixed partial one |

---

## 17. What B04 explicitly does not infer

No hotel, hotel_contact, pipeline_item, outreach_event or collaboration row
or column exists anywhere in 0038. No reply, timing, negotiation, outcome,
ghosted, win/loss or portfolio-proof state. No network intelligence, no
cross-creator aggregation, no LLM extraction or classification, no semantic
body cleanup (no quote removal, no signature stripping, no HTML-to-text
canonicalization). No automatic sending, no `gmail.send` scope, no
incremental history sync, no new provider call of any kind — B04 performs
zero Gmail network activity. No attachment retrieval, ever. No creator-facing
or admin-facing view of raw or normalized Gmail content, for any role.

---

## 18. What this contract does not decide

Whether normalization runs automatically after a B03 import completes (it
does not, today: every normalization is an explicit batch call). Anything
about outreach detection, hotel matching, reply/timing facts, outcome
classification or network intelligence — all later, separately contracted
blocks. Whether a `Message-ID` reference token that syntactically matches
another stored message means anything at all: B04 stores the token and draws
no conclusion from it.
