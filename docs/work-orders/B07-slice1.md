# B07 slice 1 — Gmail commercial meaning, rules-only engine

**Status:** Binding work order for this PR.  
**Base:** `main` `0d176e42a7487c24c42f7d448f1fb3b3912535e3`  
**Branch:** `feat/b07-slice1-rules-engine`  
**One PR for the whole block. Do not merge.**

Owner decision recorded 2026-10-12 (product authority): implement now with a deterministic rules-based engine kind, which D072 already allows as an inference-engine kind. No external model calls. No provider receives Gmail data.

Sources of truth, in order: D072, D074, `docs/B07_GMAIL_COMMERCIAL_MEANING_CONTRACT.md`, this work order. This work order does not add product semantics. Where D072 reserved migration `0041`, D074 substitutes the next free number. On this base that number is `0044`.

---

## Principal question

Given a commercially relevant Gmail thread whose reply chronology B06 has already established, what business meaning do conservative deterministic rules support, and what has the creator explicitly confirmed or corrected, without ever collapsing those two facts into one row or one writer?

## Locked semantics (D072 / D074)

Three epistemic layers, never collapsed:

```text
OBSERVED COMMUNICATION
  → MACHINE COMMERCIAL INTERPRETATION
    → CREATOR CORRECTION / CONFIRMATION
```

Machine disposition (exactly one): `positive` | `negative` | `neutral` | `mixed` | `ambiguous`.

Machine signals (a set): `interest` | `request_information` | `redirect` | `terms_discussion` | `offer` | `agreement` | `rejection` | `timing_constraint` | `other_commercial`.

Thread machine state (advisory, never CRM): `unresolved` | `engaged` | `negotiating` | `agreement_observed` | `declined_observed` | `ambiguous`.

Compensation structure: `paid` | `in_kind` | `hybrid` | `unpaid` | `other` | `unknown`. `unknown` is not `unpaid`.

Human business outcome (human only): `open` | `won` | `lost` | `ghosted` | `uncertain`. Lost reason, only when outcome is `lost`: `rejected` | `not_a_fit` | `timing` | `other`. No `no_reply`.

Human reply-nature overlay on B06: `human_reply` | `automated` | `delivery` | `not_reply` | `uncertain`.

Evidence strength (machine only): `strong` | `moderate` | `weak` | `insufficient_evidence`.

Engine provenance for this slice: `engine_kind = rules`, `rule_version` set, model provider / model version / prompt version all null. A row that names a model is unrepresentable.

## In scope

- `supabase/migrations/0044_gmail_commercial_meaning.sql`
- Rules engine under `src/lib/gmail/commercial/` (`engine_kind = rules` only)
- Append-only human decision events and current projections for five axes
- SECURITY DEFINER RPCs where a client role must not touch `private` directly: machine commit (service_role), creator decision and creator read (authenticated, `auth.uid()`), purge (service_role)
- RLS + SELECT grant so an authenticated creator can read only their own B07 rows
- Tests named in this order, including PR #40 holdout fixtures `m-en-hold-017`, `m-en-hold-027`, `m-es-hold-017`
- Tracker, autopilot state, and a D074-style reconciliation note

## Out of scope

- Any LLM, HTTP model client, or provider that receives Gmail text
- UI beyond the creator-decision RPC (no screens, no extra server actions)
- B08 incremental sync, watches, history cursors
- CRM materialization (`pipeline_items`, `outreach_events`, `collaborations`, trips, canonical hotel/organization/contact)
- Amounts, currency, deliverables, payment status, invoices
- Automatic `ghosted`
- Vendor selection
- Rewriting B03/B04/B05/B06 rows

## Invariants

- Authentication is not authorization. User A cannot read, enumerate, update, delete, count-infer, RPC, or FK-link User B's B07 rows.
- Machine writers never insert, update, or delete human decision rows.
- Human corrections never delete machine attempts. A rerun may add an attempt or move a current pointer. It does not update an attempt in place and does not delete human events.
- Same input digest + same schema + same transform + same rule version does not append another attempt and does not change the current pointer.
- `redirect` never coexists with `rejection` on one message.
- `timing_constraint` on the latest eligible message, without `rejection`, never yields `declined_observed`.
- Uncertainty yields `ambiguous`, not a forced positive or negative.
- Politeness alone is not `positive`.
- An offer is not `agreement_observed`. A one-sided target "yes" is not `agreement_observed`. Creator-sent acceptance alone is not `agreement_observed`.
- No qualifying human reply means no human outcome and no `ghosted`.
- `private_gmail_processing` plus the B05 locked lifecycle fence gate every new machine write and every new human write. Withdrawal keeps existing rows. Deletion purges them.
- `search_path` is pinned on every new SECURITY DEFINER function.

## Identity, authority, privacy

- Message human identity: `(mail_account_id, provider_message_id, axis)`. Thread human identity: `(mail_account_id, provider_thread_id, axis)`. Never a B04/B06 row id.
- Current projections FK to the event row including account, axis, and anchor, so they cannot point at another account, axis, or message.
- Creator RPCs take the user from `auth.uid()` only. A passed-in user id is not authority.
- Machine commit takes `p_user_id` and requires it to equal the mail account owner. The function is not granted to `authenticated` or `anon`.
- All stored rows are G2. No G3 rows. `is_admin_or_editor()` grants nothing here.
- B07 reads stored normalized text. It does not call Gmail.

## DB contract

| Relation | Role |
|---|---|
| `private.gmail_commercial_message_attempts` | Immutable machine message history |
| `private.gmail_commercial_message_current` | Replaceable pointer at the current message attempt |
| `private.gmail_commercial_thread_attempts` | Immutable machine thread history |
| `private.gmail_commercial_thread_current` | Replaceable pointer at the current thread attempt |
| `private.gmail_commercial_creator_decision_events` | Append-only human events, `event_seq` identity |
| `private.gmail_commercial_message_decisions` | Current human projection, message axes A–C |
| `private.gmail_commercial_thread_decisions` | Current human projection, thread axes D–E |

`event_seq` is `generated always as identity`. Callers cannot supply it. Projection updates require the new `event_seq` to be strictly greater. Clear/withdraw is a new event with null values and `is_cleared`.

Axis A (`reply_nature`) is the only human axis that changes machine eligibility. Axes B–E do not move the machine pointer and do not delete attempts.

RLS is enabled on every B07 table. `authenticated` receives `SELECT` only, policy `user_id = auth.uid()`. No insert/update/delete grant. `anon` receives nothing. Usage on schema `private` is granted to `authenticated` only so that SELECT can be evaluated; execute on `private` functions and privileges on non-B07 private tables stay revoked.

## Concurrency

- New writes call `private.gmail_outreach_assert_may_process_locked` (consent `for share`, then mail account `for share`, same order as B01/B05/B06).
- Machine commit then takes `for update` on the mail account so two commits serialize. A `40P01` deadlock is a retry, not a second current row.
- Human projection upsert updates only when `excluded.current_event_seq` is greater. A trigger rejects a backwards `current_event_seq`.
- Machine commit recomputes the input digest under those locks. A mismatch returns `stale_source` and writes nothing.

## Replay / idempotency

Input digest is SHA-256 over schema version, transform version, rule version, provider thread id, and each current normalized message's source digest, sent flag, B06 class and versions, B06 currentness, and Axis A basis plus event seq. The database computes it. The caller only echoes it.

Equal digest and an already-current projection: `already_current`, zero new attempts. A rule-behavior change requires a new `rule_version`, which changes the digest.

## Error model

Refusals are structured results, not thrown product errors: `unauthenticated`, `not_found`, `account_deleted`, `deletion_pending`, `consent_missing`, `thread_not_found`, `not_eligible`, `anchor_not_found`, `stale_source`, `already_current`.

Shape violations (`redirect` with `rejection`, `declined_observed` without a latest-message `rejection`, `declined_observed` while the latest eligible message has `timing_constraint` or `redirect`, `agreement_observed` without an `agreement` signal, unknown vocabulary) raise `check_violation` and write nothing.

## Deletion

`gmail_commercial_purge_for_deletion` deletes human projections, human events, current pointers, and attempts for the account, only when B01's deletion request is the current one and its scope includes Gmail-derived data. A deferred constraint trigger makes `connection_state = deleted` unrepresentable while any B07 row remains.

A B04 rebuild that deletes a normalized message sets the attempt's normalized-message pointer to null (`on delete set null`). The attempt and the human event stay, anchored to the provider id. Effective reads do not present a null-pointer attempt as current.

## Provenance

Every attempt stores mail account, provider ids, source payload sha256, B06 observation id (nullable) and the B06 versions it read, Axis A basis and event seq, input digest, schema version, transform version, `engine_kind = rules`, rule version, null model/prompt fields, and `evaluated_at`.

## Failure matrix (16)

| # | Dimension | Failure this slice refuses |
|---|---|---|
| 1 | Identity | Human truth anchored only to a replaceable B04 UUID |
| 2 | Authority | Machine output written into a human outcome column, or a creator id taken from a parameter |
| 3 | Completeness | Silence in a historical window stored as `ghosted` or `declined_observed` |
| 4 | Staleness | Commit whose locked source digest differs from the digest that was read |
| 5 | Concurrency | Lower `event_seq` replacing the current human projection; two commits leaving two current rows |
| 6 | Nullability | Missing compensation stored as `unpaid`; unclear disposition stored as `positive` or `negative` |
| 7 | Ambiguity | "I can't tell you yet" stored as rejection or `declined_observed` |
| 8 | Ordering | A later reopening leaving the thread permanently `declined_observed`, or deleting the earlier rejection attempt |
| 9 | Replay | Same digest appending another attempt or flipping current state |
| 10 | Human truth | Machine rerun deleting or updating a creator event |
| 11 | Privacy | New write after consent withdrawal or `deletion_pending`; any G3 row |
| 12 | Provenance | Current suggestion with no stored engine kind, rule version, and source digest |
| 13 | Scope | A write to pipeline, outreach, collaborations, or canonical entities |
| 14 | Deletion | `deleted` mailbox that still has attempts, current pointers, or human events |
| 15 | Versioning | Rules output that does not record schema, transform, and rule versions |
| 16 | Tenancy | User A reading or correcting User B by id, list, count, update, delete, RPC, or FK |

## Attack cases

- Direct id, list, update, delete, count, and RPC as User A against User B and the reverse
- Authenticated and anon `EXECUTE` on machine commit and purge (`42501`)
- Creator decision for another account's `mail_account_id` or provider message id
- Composite FK: a projection cannot reference another account's event
- Payload with `redirect` and `rejection` together
- Latest message is only `timing_constraint` while state is `declined_observed`
- Machine commit after a human Axis B correction (human row unchanged)
- Machine commit racing a human Axis A correction (human event survives; machine does not delete it)
- Stale digest after a body change
- Second interpret with no input change
- Consent withdrawn between read and commit
- Purge on deletion; rebuild of the normalized message does not drop the human event
- Holdout fixtures above, plus contract §27 cases in unit tests

## Required tests

- `tests/gmail-commercial/rules.test.ts` — pure rules, including the three holdout fixtures and §27 cases
- `tests/gmail-commercial/db-core.test.ts` — real Postgres: replay, stale digest, human overlay survives rerun, Axis A suppression, deletion purge, B04 pointer survival, no CRM writes, redirect/rejection rejected by the database
- `tests/gmail-commercial/isolation.test.ts` — User A/B both directions
- `tests/gmail-commercial/concurrency.test.ts` — correction vs rerun, stale `event_seq`
- `tests/rls/acl-matrix.test.ts` — B07 SECURITY DEFINER grants and pinned `search_path`

## Negative controls

Each guard is removed locally, the named test is re-run, the failure is recorded, and the file is restored. Nothing mutated is committed.

| Guard | Test | Expected when removed |
|---|---|---|
| RLS enabled on message attempts | isolation: cross-tenant SELECT returns 0 | User B sees User A's row |
| No UPDATE grant for authenticated | isolation: cross-tenant UPDATE is `42501` | Statement is not `42501` |
| No DELETE grant | isolation: cross-tenant DELETE is `42501` | Statement is not `42501` |
| `auth.uid()` account filter on read RPC | isolation: User B read is `not_found` | User B receives User A's meaning |
| `event_seq` monotonic trigger | concurrency: backwards update raises | Backwards update commits |
| Human-writer GUC on decision events | db-core: machine commit does not insert human rows; direct insert without GUC raises | Insert without the GUC succeeds |
| Digest equality short-circuit | db-core: second run adds 0 attempts | A second attempt appears |
| `redirect`/`rejection` check | db-core: combined payload raises | Row is stored |
| Purge + absent-when-deleted trigger | db-core: `deleted` with rows raises | `deleted` commits while rows remain |

## Acceptance

Local `format:check`, `lint`, `typecheck`, `test`, `build`, and `npm run autopilot:validate` pass. GitHub `verify` is green on the exact head. The PR is not merged.
