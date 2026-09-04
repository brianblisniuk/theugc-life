# B05 — Gmail Private Creator-Outreach Interpretation Contract

Governed by **D070**. Implemented by migration
[`0039_gmail_outreach_commercial_targets.sql`](../supabase/migrations/0039_gmail_outreach_commercial_targets.sql).
Depends on D022, D028, D029, D057, D063, D067, D068, D069 and on B04's
normalized projection (`0038_gmail_private_normalization.sql`). Nothing in
0035–0038 is modified.

---

## 1. Purpose

B03 answered "what Gmail evidence exists?" B04 answered "how do we normalize
that evidence privately and deterministically?" **B05 answers: which
normalized conversations represent creator-commercial outreach, who or what
was the creator trying to reach, and which recipients were actually targeted
as commercial contacts?**

B05 does **not** answer whether a target replied (B06), what the outcome was
(B07), or keep the mailbox in sync (B08), and it does not decide whether
historical Gmail evidence enters the live CRM (a future, separately
contracted feature).

## 2. Exact inputs from B04

B05 reads, and never writes:

- `private.gmail_normalized_threads` / `_messages` — thread/message identity,
  `provider_sent`, `source_payload_sha256`, `normalizer_version`.
- `private.gmail_normalized_headers` — the `subject` header's raw value.
- `private.gmail_normalized_participants` — `to`/`cc`/`bcc` occurrences on
  `provider_sent = true` messages, with their real ids for stable provenance.
- `private.gmail_normalized_text_parts` — decoded `text/plain`/`text/html`
  bodies of `provider_sent = true` messages only.

No B05 code path calls `gmail_normalize_commit_message` or any other B04
writer. The only new read surface is
`public.gmail_outreach_get_thread_evidence`, added by this migration because
B04 itself exposes no read RPC for its own normalized content.

## 3. Exact outputs

Eleven `private`-schema tables (§26), five of them MACHINE (advisory,
replaceable), six of them HUMAN (immutable events + current projections,
authoritative) — see §6 for the full layer definition. Nothing is written to
`public.pipeline_items`, `public.outreach_events`, `public.collaborations`,
trip state, or any canonical `public.hotels`/`public.organizations`/
`public.hotel_contacts`/`public.organization_contacts` row.

## 4. Means / does-not-mean table

| Fact | Means | Does NOT mean |
|---|---|---|
| `outreach_status = 'qualified_outreach'` | the machine's current advisory read of the thread | the creator has confirmed anything |
| `gmail_outreach_creator_decisions.outreach_decision = 'outreach_confirmed'` | the creator explicitly confirmed this thread was outreach | that the classifier was ever run, or agreed |
| a `gmail_outreach_target_canonical_links` row | a conservative evidence-based candidate exists | the target is resolved, or that any canonical row was touched |
| `gmail_outreach_target_confirmations` contains observation X | the creator confirmed X was a real target | X has, or ever will have, a canonical link |
| an `gmail_outreach_observed_recipient_canonical_links` row | this address exactly matches an existing canonical contact | this recipient is the commercial target contact, or that the linked hotel/organization is the thread's target (D028) |
| `role = 'cc'` on an observed recipient | this address was CC'd on a SENT message | this address was a target of the outreach |
| `provider_sent = false` on a message | the message was not sent by the creator | the thread was inbound, or that anyone replied (B06 only) |
| a thread has no `gmail_outreach_target_observations` row | no target evidence was extractable this run | the outreach classification is `not_outreach` |

## 5. Qualified-outreach semantics

Positive `qualified_outreach` requires, jointly:

1. At least one message in the thread with `provider_sent = true` (B04's
   literal fact).
2. Evidence in that creator-SENT content of a creator-commercial proposal —
   collaboration request, UGC proposal, hosted-stay/paid-content/barter/
   hybrid pitch, sponsorship/partnership proposal, or an analogous
   creator-to-business commercial ask.
3. Evidence that the proposal was directed at a potential commercial target
   or a representative of one.

Explicitly excluded, when nothing above is separately satisfied: reservation/
booking requests, customer-service complaints, employment applications,
personal/family travel, newsletters, ordinary marketing received by the
creator, a vendor/software seller pitching *to* the business, and unrelated
press/media correspondence.

`needs_review` and `insufficient_evidence` are legitimate, non-penalized
abstentions — never forced into a binary. `not_outreach` is a confident
negative, distinct from `insufficient_evidence`'s "we don't have enough to
say."

## 6. Machine-vs-human epistemic layers

**MACHINE** (`gmail_outreach_thread_signals`, `gmail_outreach_observed_
recipient_canonical_links`, `gmail_outreach_target_contact_signals`/
`_candidates`, `gmail_outreach_target_observations`'s advisory columns,
`gmail_outreach_target_canonical_links`): versioned, replaceable, may go
stale, upserted or wholesale-replaced on each re-run. Never creator truth.

**HUMAN** (`gmail_outreach_creator_decision_events`, `gmail_outreach_
creator_decisions`, `gmail_outreach_target_confirmations`, `gmail_outreach_
target_contact_confirmed_members`): immutable append-only decision events
(`event_seq generated always as identity` is the sole ordering authority),
plus current projections that can never name a stale or wrong-axis event. A
machine re-run never writes to any HUMAN table — enforced structurally:
`gmail_outreach_commit_interpretation` (the only machine writer) has no
reference to `gmail_outreach_creator_decision_events` anywhere in its body,
and `gmail_outreach_record_creator_decision` (the only human writer) never
reads or writes a MACHINE table's *content* columns (only reads `outreach_
status` once, as read-only context stored in `observed_machine_state` for
audit, never as authorization).

## 7. Private target observations

`private.gmail_outreach_target_observations` — a private, stable fact
independent of canonical inventory (§8 of D070). Identity fields
(`observed_name`, `observed_domain`, `target_kind_hint`, `source_message_
ids`) are written once per `(mail_account_id, normalized_thread_id,
observation_fingerprint)` and never rewritten by a later re-run — the commit
RPC's `on conflict ... do nothing` on the fingerprint, followed by a separate
`update` that touches only the advisory columns, is what enforces this. A
re-run that cannot recognize an existing observation (different fingerprint)
creates a new, additional observation rather than overwriting the old one.

## 8. Canonical target-link semantics

`private.gmail_outreach_target_canonical_links` — zero, one, or many rows per
observation, each `target_kind` (`hotel`/`organization` today, closed and
additively extensible) with exactly one populated kind-specific FK
(`target_hotel_id`/`target_organization_id`), enforced by the table's own
shape CHECK. Evidence columns (`name_evidence`/`domain_evidence`/`address_
evidence`/`contact_evidence`, each `agrees`/`differs`/`unavailable`) mirror
`source_property_reviews`' existing conservative-evidence shape — no numeric
score, per D063 §12.2. Wholesale replaced per observation on each
re-evaluation; never creates or mutates `public.hotels`/`public.
organizations`.

## 9. Observed recipients

`private.gmail_outreach_observed_recipients` — every `to`/`cc`/`bcc`
occurrence on a `provider_sent = true` message, unfiltered: self-addresses,
manager/assistant CCs, malformed participants B04 preserved. Keyed
(`unique(source_participant_id)`) on the exact B04 participant row it came
from, so a re-extraction always upserts onto the same row id — a later human
confirmation referencing it (§10) is never orphaned.

## 10. Commercial target-contact interpretation

"Which observed recipient, if any, was actually the commercial target
contact?" is answered separately from "who appeared in the headers" (§9).
`private.gmail_outreach_target_contact_signals` (one aggregate row per
thread: `match_quality`, `matcher_version`, `evaluated_epoch`, `candidate_
set_fingerprint`) plus `private.gmail_outreach_target_contact_candidates`
(child rows, each referencing a real `gmail_outreach_observed_recipients`
row, never a canonical contact) express this. `match_quality` uses the same
four-value vocabulary as target matching. The human confirmation of this fact
(`gmail_outreach_target_contact_confirmed_members`) also anchors to the
observed recipient, never to a canonical contact — see §11.

## 11. Canonical contact-link semantics

`private.gmail_outreach_observed_recipient_canonical_links` — zero, one, or
many rows per observed recipient, `canonical_contact_kind`
(`hotel_contact`/`organization_contact`, closed and additively extensible)
with exactly one populated kind-specific FK, computed **inside**
`gmail_outreach_commit_interpretation` by an exact, case-insensitive email
join against `public.hotel_contacts`/`public.organization_contacts` — never
trusted from the caller, and never used to force a single link onto the
recipient row. An exact match is evidence only (D028): it never by itself
establishes target-contact identity or commercial-target identity.

## 12. Target scope

`single_target` | `multiple_targets` | `portfolio_target` | `unresolved` —
its own semantic fact (`gmail_outreach_creator_decisions.target_scope_
decision`), never mechanically derived from the confirmed-target set's
cardinality or kind (D070, and the Ogilvy vs. Marriott-Caribbean-Partnerships
example that established this rule). May be captured independently of, and
before, target identity is resolved. No trigger enforces a hard consistency
constraint between scope and the confirmed-member set; a review surface may
compute and show a `consistent`/`pending_target_resolution`/`contradictory`
status by comparing `target_scope_decision`'s cardinality implication against
`count(*) from gmail_outreach_target_confirmations` for the thread — this is
diagnostic, never a write-time gate.

## 13. Qualitative machine states

`strong_match` | `needs_review` | `ambiguous` | `insufficient_evidence` —
used identically for target matching and target-contact matching. Never a
numeric/calibrated percentage. If a future model-backed classifier emits a
raw score, it is stored only as diagnostic provenance metadata (§14), never
surfaced as fact or as a creator-visible percentage.

## 14. Provenance

Guaranteed deterministic and replayable: B04 evidence selection, the
classifier-input transform, deterministic candidate generation/evidence
scoring, canonical hashing, and all stored provenance itself.
**Not** guaranteed byte-replayable: any future external model inference — the
guarantee is "we can reconstruct exactly what evidence and configuration
produced this stored result," never "calling the model again returns
identical bytes." Every machine row records its detector/matcher version;
V1's deterministic baseline (`gmail_outreach_rules_v1`, §21) needs no
model-identifier/prompt-version columns since it makes no external call, but
the schema (implicit in `reason_codes`/evidence columns, extensible via
future columns) does not preclude adding them for a future model-backed
adapter without breaking existing rows.

## 15. Source invalidation (the source-evidence fence)

`gmail_outreach_commit_interpretation` takes `p_expected_evidence_digest`,
computed by the caller from the exact evidence bundle it read
(`gmail_outreach_get_thread_evidence`). At commit time, under a `for key
share` lock on the thread's current `gmail_normalized_messages` rows (which
blocks a concurrent B04 invalidation delete until this transaction resolves,
and is itself blocked by one already in flight), the function recomputes the
identical digest shape and refuses the entire commit (`result: 'stale_
source'`) on any mismatch — nothing is written from evidence that moved
underneath the caller. Verified end-to-end: a deliberately stale digest is
rejected and leaves every existing machine and human row untouched.

## 16. Catalog invalidation

Two levels (D070, §20 of the accepted amendment history): a cheap, monotonic,
cross-table sequence (`private.gmail_outreach_catalog_epoch_seq`, bumped by a
`for each statement` trigger on `hotels`, `hotel_source_identities`,
`hotel_contacts`, `organizations`, `hotel_organizations`, `organization_
contacts`) means only "the candidate universe might have changed," never
"every previous result is wrong." Every machine row that depends on canonical
inventory (`gmail_outreach_target_contact_signals`, `gmail_outreach_target_
observations`'s advisory columns) records the `evaluated_epoch` it read via
`public.gmail_outreach_current_catalog_epoch()`. Staleness is a read-time
comparison against the current epoch, never a write-time reject — the write
always succeeds, honestly recording what catalog state it evaluated against,
because the machine layer is advisory by construction (§6) and cannot become
authoritative without a separate creator confirmation regardless of how
current its catalog read was.

## 17. Creator decisions/corrections

The single writer is `public.gmail_outreach_record_creator_decision`
(service_role-only, `p_user_id` verified against `mail_accounts.user_id`
before any write). Four independently-decidable axes — `outreach`,
`target_scope`, `target`, `target_contact` — each producing an immutable
event (`gmail_outreach_creator_decision_events`, `decided_by_user_id =
user_id` enforced by both the function and the table's own CHECK) and
updating exactly the corresponding current-projection row/table. A `target`
or `target_contact` "remove" action deletes the confirmation row (its
authorizing event remains permanently in the ledger) rather than
soft-deleting it, since "confirmed" is defined by presence, not by a status
column that could itself drift.

## 18. RLS/access model

No RLS is enabled on any `private.gmail_outreach_*` table — protection is
schema-level, identical to B01–B04: no `USAGE` grant on `private` to
`anon`/`authenticated`. Every RPC is `SECURITY DEFINER`, `set search_path =
public, private, pg_temp`, and `EXECUTE` is revoked from `public`, `anon`,
`authenticated` and granted only to `service_role` (§27 of the migration).
No admin/editor/staff role — `public.is_admin_or_editor()` appears nowhere in
this migration — gains any access to B05 data by role, per D067/B01 §6.

## 19. Disconnect/churn/deletion semantics

Disconnect and subscription churn/inactivity are not deletion events and
trigger no automatic purge anywhere in this migration — the only path that
removes B05 data is `public.gmail_outreach_purge_for_deletion`, callable only
while the mailbox is `deletion_pending` under the request that is actually
running, for a scope that actually includes Gmail data (mirroring B03's/B04's
own purge functions exactly). It purges the HUMAN layer first, then the
MACHINE layer. `public.assert_gmail_outreach_data_absent_when_deleted`, a
deferred constraint trigger registered on `mail_accounts` and on every
top-level B05 table, makes "`deleted` + surviving B05 data" structurally
unrepresentable, mirroring B03/B04's identical pattern.

## 20. Evaluation contract

Synthetic only in this PR — no production gold-label table exists anywhere in
0039 (D070, Finding C of the accepted amendment history). Fixtures and gold
labels live in `tests/gmail-outreach/` as TypeScript data, never as a
migration table. Tracked separately: outreach precision/recall/needs-review
rate/insufficient-evidence rate; target strong-match correctness/wrong-target
rate/candidate recall/ambiguous rate/scope correctness; target-contact
candidate correctness/abstention rate; observed-recipient preservation rate;
canonical-contact-link correctness/false-link rate. All explicitly labeled
**synthetic/evaluation-harness metrics** — never "real-world precision/
recall." No numeric go-live threshold is fixed, because none exists in any
accepted source (D070's closing section).

## 21. B06/B07/B08 boundaries

B05 stores no `parent_message_id`, `is_reply`, `reply_received`, `reply_
delay`, `negotiation`, `offer`, `won`/`lost`, `ghosted`, `collaboration_
type`, or outcome/value column anywhere. No incremental-sync cursor or watch
subscription state exists. Field names and comments throughout 0039 avoid
implying any of these facts, per the explicit instruction that "recipients
were actually targeted as commercial contacts," never "engaged" or a word
implying interaction.

## 22. CRM-materialization non-goal

`0039` contains no reference anywhere to `public.pipeline_items`,
`public.outreach_events`, or `public.collaborations`. The existing `outreach_
events.source = 'gmail'` CHECK value predates this migration and remains
unused. A creator may connect Gmail and still see a clean, unmodified
operational CRM.

## 23. Network-intelligence non-goal

No G3 row, aggregate, or eligibility flag is created. B05 output is G2 only.
`network_intelligence_contribution` is neither read nor required by any B05
RPC. No model training (global, shared, or cross-user) is performed or
authorized by anything in this PR — V1 ships only the deterministic rules
baseline (§21… see also the technology note below), which makes no external
call at all.

## 24. Multi-vertical extension rule

Adding a future canonical target kind (a brand, a restaurant, an airline) or
canonical contact kind is additive only: one new `CHECK` value on `target_
kind`/`canonical_contact_kind`, one new nullable FK column, in a future
migration. No existing row's kind, FK, or meaning changes. The outreach
classification language (§5) and the observed-recipient concept (§9) were
never hospitality-specific to begin with.

## 25. Adversarial cases

Covered by the test suite (`tests/gmail-outreach/`), consolidated into
well-designed scenarios rather than one file per line item, per the explicit
instruction that this is a semantic minimum, not a file-count requirement:
UGC/hosted-stay/paid/barter pitches; reservation/complaint/job-application/
personal-travel/newsletter/vendor-to-business/press exclusions; quoted-reply
false positives; multi-SENT-message aggregation; HTML-only/undecodable/
malformed text; self/manager/assistant CC preservation; generic-inbox vs.
named-person target-contact distinction; unknown/non-canonical targets;
two-property and portfolio pitches; organization-only vs. single-organization-
as-direct-client scope disambiguation; exact-contact-vs-thread-evidence
contradiction; zero/many canonical candidates; B04 rebuild not orphaning
human decisions; detector/matcher version changes; catalog epoch/fingerprint
staleness without unrelated-write false triggers; cross-account isolation;
concurrent commits; malformed structured output rejection; disconnect/churn/
deletion.

## 26. Migration/schema mapping

| Concept | Table |
|---|---|
| Machine outreach signal | `private.gmail_outreach_thread_signals` |
| Observed recipients (deterministic) | `private.gmail_outreach_observed_recipients` |
| Canonical contact links (0..N) | `private.gmail_outreach_observed_recipient_canonical_links` |
| Machine target-contact signal | `private.gmail_outreach_target_contact_signals` |
| Machine target-contact candidates | `private.gmail_outreach_target_contact_candidates` |
| Private target observations | `private.gmail_outreach_target_observations` |
| Canonical target links (0..N) | `private.gmail_outreach_target_canonical_links` |
| Human current decisions (outreach + scope) | `private.gmail_outreach_creator_decisions` |
| Human confirmed targets (set) | `private.gmail_outreach_target_confirmations` |
| Human confirmed target-contacts (set) | `private.gmail_outreach_target_contact_confirmed_members` |
| Human immutable decision ledger | `private.gmail_outreach_creator_decision_events` |

RPCs: `gmail_outreach_current_catalog_epoch`, `gmail_outreach_list_
candidates`, `gmail_outreach_get_thread_evidence`, `gmail_outreach_commit_
interpretation`, `gmail_outreach_record_creator_decision`, `gmail_outreach_
status`, `gmail_outreach_purge_for_deletion` — all `service_role`-only.

## 27. Operational run/replay semantics

`npm run gmail:outreach:run` (batch, bounded, forward-progress-guaranteed
exactly like B04's `normalizeMailboxUntilIdle`: a permanently-failing
candidate is excluded after a bounded number of attempts within one run,
never persisted as a quarantine, and never causes an infinite loop or a false
"idle" report) and `npm run gmail:outreach:status`. Replay is exact:
re-running the deterministic V1 interpreter against unchanged B04 evidence
and an unchanged catalog epoch produces byte-identical machine output,
verified by test.

---

## Technology choice — V1 deterministic baseline only

No AI/model provider is selected or called anywhere in this PR. `src/lib/
gmail/outreach/interpreter.ts` implements `gmail_outreach_rules_v1`, a
conservative, provider-abstracted, deterministic rules interpreter behind an
interface any future per-user model adapter could implement without a schema
change. The baseline abstains (`insufficient_evidence`/`needs_review`)
aggressively rather than risk a false positive commercial-outreach claim,
consistent with MASTER_PLAN §4.7's AI principles (provider abstraction,
structured outputs, confidence and human correction, never silently turn
model inference into verified fact, evaluation sets before scale).

## What this does not decide

Everything B06 (reply/timing), B07 (outcome/correction taxonomy beyond the
four decision axes above), B08 (incremental sync) own; any real-world
precision/recall threshold; the design of a future historical-CRM-
reconciliation feature; the design of a future explicitly-authorized
support-sharing mechanism; whether or when a per-user model adapter replaces
the V1 deterministic baseline.
