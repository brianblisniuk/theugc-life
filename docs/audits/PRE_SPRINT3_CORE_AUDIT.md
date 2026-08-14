# Pre-Sprint-3 Core Audit

Audited commit: `d12f8f7dd624cb659414e3b357d2e1b82753b0ed` (origin/main)
Date: 2026-08-14
Scope: entire V1 core engine (Sprints 0 → 2F), foundation and documentation.
Method: falsification-oriented. Every invariant was attacked before it was believed.

---

## 1. Executive summary

The core engine is in good shape. The trusted-server boundary, the CRM state
machine, the deal/collaboration lifecycle, the intelligence derivation and the
privacy gating all hold up under direct attack from real database roles. Client
write access to every workflow table has been revoked, identity is never
accepted from the browser, and the "a technical error is not a domain fact"
rule is implemented consistently across Discover, Hotel Detail, contacts,
pipeline, collaboration and intelligence.

**One P1 defect was found**, and it is a real one: the application cannot read
`public.users`, so `getSessionContext()` silently falls back to the `creator`
role for every user, including genuine admins and editors. The admin surface is
therefore unreachable, and the fallback is itself an instance of the very
anti-pattern the codebase polices everywhere else — a permission error being
read as a domain fact. It fails closed (no privilege escalation), and the
database-side role checks (`is_admin_or_editor()`) are unaffected.

Beyond that: two P2 hardening items, five P3 debt items, six P4 documentation
divergences. No P0. No secret material in the tree. No cross-creator data
exposure found under direct probing.

**Recommendation: C — HARDENING SPRINT REQUIRED**, on the strict reading of the
severity rubric (one P1 exists). In practice this is a single small fix plus a
regression test, not a broad hardening effort; see §19.

---

## 2. Audit baseline

| Item | Value |
|---|---|
| `git rev-parse origin/main` | `d12f8f7dd624cb659414e3b357d2e1b82753b0ed` ✅ matches required |
| Working tree | clean (audited on scratch branch `audit/pre-sprint3` at that SHA) |
| Migrations | 0001 → 0023 (23 files) |
| Fresh replay from empty DB | PASS (23/23 applied) |
| `npm test` | 676 passed, 33 files |
| `npm run lint` | clean |
| `npm run typecheck` | clean |
| `npm run build` | clean |
| `npm run format:check` | clean |
| Production Supabase | NOT contacted |

### Inventory

**Migrations (23).** 0001 extensions/helpers · 0002 users/profiles · 0003
geography/inventory · 0004 commerce/entitlements · 0005 trips/pipeline · 0006
events/collaborations · 0007 verification/signals/flags · 0008 intelligence ·
0009 growth · 0010 access helpers · 0011 signup trigger · 0012 RLS policies ·
0013 public intelligence view · 0014 import/organizations · 0015 import
backstops · 0016 destination catalog/review · 0017 one property row per key ·
0018 grant hardening · 0019 save-to-pipeline RPC · 0020 pipeline transitions ·
0021 negotiation/deal-won/collaboration · 0022 hotel intelligence aggregation ·
0023 collaboration lifecycle.

**Application RPCs (service_role-only).** `save_hotel_to_pipeline`,
`transition_pipeline_item`, `progress_pipeline_deal`, `progress_collaboration`,
`recompute_hotel_intelligence`, `recompute_hotel_intelligence_for_pipeline_item`,
`recompute_all_hotel_intelligence`, `hotel_intelligence_lock_key`.

**Client-callable helper functions (SECURITY DEFINER, self-scoped).**
`current_creator_id`, `current_user_role`, `is_admin_or_editor`,
`has_active_pro`, `has_active_destination_access`, `has_premium_hotel_access`.
Private `_`-prefixed variants are revoked from client roles (0018).

**Tables/views.** 36 tables + 1 view (`hotel_public_intelligence`). RLS is
enabled on **all 36 tables** (zero exceptions). 105 functions in `public`,
of which ~85 are extension-provided (citext, pgcrypto).

**Routes.** Public `/`, `/pricing`; auth `/login`, `/signup`,
`/forgot-password`, `/reset-password`, `/onboarding`, `/auth/callback`;
app `/app`, `/app/discover`, `/app/hotels/[id]`, `/app/pipeline`, `/app/trips`,
`/app/profile`, `/app/profile/portfolio`, `/app/account`, `/app/billing`;
admin `/admin`.

**Server actions.** `saveHotelAction`, `transitionPipelineItemAction`,
`progressPipelineDealAction`, `progressCollaborationAction`.

**Tests.** 33 files / 676 assertions-bearing tests; 15 DB-backed, 18 pure.

---

## 3. System architecture snapshot

```
browser (client component, no secrets)
   │  posts only: ids the user is acting on + fields the user typed
   ▼
server action ("use server")
   │  identity ONLY from getSessionContext()
   │  limits ONLY from typed config (FREE_LIMITS)
   ▼
server-only service (src/lib/pipeline/queries.ts, "server-only")
   │  createAdminClient() → service_role
   ▼
service_role-only RPC (SECURITY INVOKER, search_path pinned)
   │  resolves creator_profile from p_user_id
   │  resolves pipeline item by (id AND creator_id)
   │  resolves collaboration/hotel from the item
   │  locks creator → item → collaboration
   ▼
tables (client INSERT/UPDATE/DELETE revoked; RLS retained as defence in depth)
```

Reads take the opposite path: the cookie-bound client under the caller's own
RLS, never service_role.

---

## 4. Migration / schema assessment

Fresh replay from an empty database: **PASS**, 23/23, no ordering surprises, no
dependency on production-only data, no duplicate object definitions shadowing
earlier behaviour.

`CREATE OR REPLACE` is used twice on already-shipped functions
(`transition_pipeline_item` in 0023, `hotel_public_intelligence` in 0022). Both
re-issue their `REVOKE`/`GRANT` immediately after replacement, and the audit
confirmed on the replayed schema that no client role regained EXECUTE and that
`prosecdef`/`proconfig` are as intended. This is the correct pattern and it was
followed.

Structural invariants that the database genuinely enforces (verified by
attempting to violate them as superuser):

| Invariant | Enforced by | Result |
|---|---|---|
| One non-closed cycle per creator+hotel | `pipeline_items_single_active_cycle_uidx` | **blocked** ✅ |
| One collaboration per relationship cycle | `collaborations_one_per_cycle_uidx` | **blocked** ✅ |
| `end_date >= start_date` on collaborations | `collaborations_dates_valid` | enforced ✅ |
| `cycle_number >= 1` | `pipeline_items_cycle_positive` | enforced ✅ |
| Event/status/channel vocabularies | CHECK constraints | enforced ✅ |

See §8 for the invariants that are **not** structural.

---

## 5. Security / RLS assessment

RLS is enabled on every table. The full privilege matrix was read from the
replayed schema; the security-relevant rows:

| Object | anon | authenticated | service_role |
|---|---|---|---|
| `pipeline_items` | — | SELECT | ALL |
| `outreach_events` | — | SELECT | ALL |
| `collaborations` | — | SELECT | ALL |
| `hotel_intelligence` | — | **—** | ALL |
| `destination_intelligence` | — | **—** | ALL |
| `hotel_public_intelligence` (view) | SELECT | SELECT | **—** |
| `hotel_contacts` | — | ALL (RLS: admin/editor write; premium read) | ALL |
| `access_entitlements` | — | SELECT (own or admin) | ALL |
| `users` | — | **—** | ALL |
| import/admin tables | — | ALL (RLS: `is_admin_or_editor()`) | ALL |

Verified by direct role impersonation:

- authenticated cannot INSERT/UPDATE/DELETE `pipeline_items`, `outreach_events`
  or `collaborations` (`permission denied`), while SELECT of **own** rows works
  and another creator's rows return zero rows.
- authenticated and anon cannot SELECT `hotel_intelligence` or
  `destination_intelligence` at all.
- anon and authenticated cannot EXECUTE any of the eight application RPCs.
- All four workflow RPCs: `public_exec = false`, `anon = false`,
  `authenticated = false`, `service_role = true`, `search_path` pinned.
  `save_hotel_to_pipeline` is DEFINER by design (0019); the three added since
  are INVOKER, as intended.

**Accepted legacy exceptions (not new findings).** Extension functions from
`citext` and `pgcrypto` carry PUBLIC EXECUTE and no pinned `search_path`; they
live in `public` because Supabase installs them there. `set_updated_at`,
`prevent_user_privilege_change` and the six self-scoped `has_*`/`current_*`
wrappers are intentionally PUBLIC-executable (0010/0018) — the wrappers take no
user id and read only `auth.uid()`.

No cross-creator exposure was found.

---

## 6. Trusted-boundary assessment

Every mutation path was traced end to end. In all four server actions the
browser supplies only: the id of the object it is acting on, and the values the
creator typed. Identity comes from `getSessionContext()`; limits come from
`FREE_LIMITS`. The RPCs re-derive creator, item ownership, hotel id,
collaboration id, current status and entitlements internally.

Specifically confirmed **not** accepted from the client anywhere:
`user_id`, `creator_id`, hotel ownership, pipeline ownership, current status,
collaboration status, collaboration id, plan, entitlement, engaged count, and
the intelligence recompute target (resolved from the mutated `pipelineItemId`,
never the browser's `hotelId`).

`NEXT_PUBLIC_*` contains only the Supabase URL, anon key, site URL and PostHog
keys. `SUPABASE_SERVICE_ROLE_KEY` is read only in `src/lib/supabase/admin.ts`,
which is `server-only`. No raw SQL text or PostgREST error object reaches the
UI: every RPC result passes through a `map*Result` function whose default arm
is `{ result: "error" }`.

---

## 7. CRM state-machine assessment

Real transition graph, derived from 0020/0021/0023 rather than from docs:

| From | Action | To | Event(s) | Consumes engaged slot |
|---|---|---|---|---|
| saved | plan | planned | *(none)* | **yes** |
| saved, planned | mark_pitched | pitched | `pitch_sent` | yes (only from saved) |
| pitched | mark_followup_sent | follow_up | `followup_sent` | no |
| pitched, follow_up | mark_replied | replied | `reply_received` (+`positive_reply`/`negative_reply`/`offer_received`) | no |
| replied | start_negotiation | negotiating | `negotiation_started` | no |
| negotiating | mark_won | won | `deal_won` + collaboration row | no |
| saved, planned | close | closed | `creator_closed_pipeline` | frees |
| pitched, follow_up, replied, negotiating | close | closed | `deal_lost` | frees |
| won | *(no close)* | — | — | — |
| won + collaboration terminal | complete/cancel | closed | `collaboration_completed` / `creator_closed_pipeline` | frees |

Every other combination returns `invalid_transition`. A `closed` cycle accepts
no action except an idempotent `close`. Retries return `already_applied` and
write nothing. No reachable-but-undocumented status combination was found: the
only way into each status is the action above, and `negotiating`/`won` are
unreachable without their predecessors.

Idempotency was probed for every action, including two independent connections
racing the same and different transitions; all converge correctly.

---

## 8. Deal / collaboration lifecycle assessment

The `won` invariant (pipeline `won` + exactly one `deal_won` + exactly one
collaboration) and the collaboration lifecycle
(`agreed → scheduled? → active → completed|cancelled → cycle closed`) behave
correctly through the RPCs, including the 2F review hardening that validates
status against event counts before any branch.

**Critical distinction requested by §12 — structural vs merely detected:**

| Invalid state | Structurally prevented? | Notes |
|---|---|---|
| Two open cycles per creator+hotel | **YES** (partial unique index) | verified blocked |
| Two collaborations per cycle | **YES** (partial unique index) | verified blocked |
| Collaboration with no `deal_won` | **NO** — RPC-detected only | insert succeeded |
| Pipeline `won` with no collaboration | **NO** — RPC-detected only | update succeeded |
| Terminal collaboration with non-closed pipeline | **NO** — RPC-detected only | update succeeded |
| Duplicate `deal_won` in one cycle | **NO** — RPC-detected only | two rows inserted |
| Collaboration with NULL `pipeline_item_id` | **NO** — allowed by schema | excluded from the unique index |

Because client writes to all three tables are revoked and the RPCs are the only
writers, none of these is reachable from the browser today. They are reachable
by service-role code, a future admin correction tool, or a hand-written fix.
Recorded as **F-02 (P2)**.

---

## 9. Intelligence assessment

D044 semantics were re-derived independently from 0022 and match the decision
record: the unit of observation is the relationship cycle, not the event; the
qualifying-reply rule (`event_at >= initial pitch`) is implemented; classification
events are tied to the qualifying reply through `metadata.reply_event_id` with a
documented same-cycle fallback; `deal_won` is the only collaboration signal;
medians use `event_at`, never `created_at`; rolling windows and activity level
use `event_at`; activity counts **distinct recently active cycles**, so one busy
relationship cannot manufacture "high" activity.

Contamination checks: editorial evidence (including a
`creator_collaboration_evidence` claim), contact verification, hotel metadata,
star rating, brand and import activity have **zero** effect — verified by
snapshotting the derived row before and after inserting evidence. `hotel_saved`
alone produces **no row at all**.

`0` vs `NULL` is correct after the 2E review: `reply_rate = 0` is a measured
rate for a pitched-but-unanswered hotel; `NULL` means no denominator. Activity
is `NULL` (never `low`) when no cycle was active in 90 days. A hotel with no
qualifying activity has **no row**, and a recompute that finds none **deletes**
the row.

Per-hotel recompute is serialised by a transaction-scoped advisory lock keyed
per hotel, so two refreshes cannot overwrite each other out of order; different
hotels do not block each other. Full rebuild is deterministic, equals per-hotel
recompute field-for-field, and counts removals exactly (per hotel, not by net
row count). Refresh is best-effort, post-commit, driven by the pipeline item id,
and its failure never changes the workflow result.

---

## 10. Privacy assessment

Base intelligence tables are unreadable by anon and authenticated (0022). The
public projection exposes exactly seven columns — `hotel_id`, `hotel_slug`,
`activity_level`, `confidence_level`, `reply_rate`,
`has_confirmed_collaboration`, `recency_band` — with no creator id, no pipeline
id, no exact counts and no raw timestamps. Progressive disclosure verified at
each band: insufficient → confidence only; emerging → + activity + collaboration
boolean; moderate → + coarse recency; strong → + reply rate.

The NULL-not-false invariant holds in SQL and in the panel: a suppressed
collaboration answer is `NULL`, and the UI renders the collaboration row only
for `true`, so neither `NULL` nor `false` ever prints "No collaboration".
Financial columns (`private_value_amount`, `private_value_currency`) are never
selected by any read path.

---

## 11. Concurrency / idempotency assessment

Lock inventory:

| Site | Mechanism | Order |
|---|---|---|
| `save_hotel_to_pipeline` | `FOR UPDATE` creator | creator |
| `transition_pipeline_item` | `FOR UPDATE` creator → item | creator → item |
| `progress_pipeline_deal` | `FOR UPDATE` creator → item | creator → item |
| `progress_collaboration` | `FOR UPDATE` creator → item → collaboration | creator → item → collaboration |
| `recompute_hotel_intelligence` | `pg_advisory_xact_lock(hotel key)` | per hotel |
| import review/promote | session advisory lock per batch | per batch |

The order is consistent everywhere (creator first, then item, then
collaboration), so no inversion path exists between the four workflow functions.
The intelligence lock is taken in a separate post-commit transaction and never
while holding a workflow row lock, so it cannot participate in a cycle. Import
locks are keyed on a disjoint namespace.

Unique-violation recovery is used deliberately in two places
(`save_hotel_to_pipeline`, `progress_pipeline_deal`) to convert a lost race into
the winner's row rather than an error.

---

## 12. Import-system assessment

Reviewed without touching production. The canonical rules hold in code:
editorial evidence is stored separately and proven to have no path into creator
intelligence; property identity is keyed per property, not per shared endpoint;
the review/apply flow is serialised per batch by an advisory lock; promotion is
idempotent with a database backstop on `(file_sha256, parser_name,
parser_version)`; rollback and manifest snapshots are covered by DB-backed
tests. All import tables are admin/editor-only by RLS.

The one operational coupling worth noting: the import CLI's admin-gated
workflows depend on a role that the **application** can no longer resolve
(F-01); the CLI itself uses service_role and is unaffected.

---

## 13. Test-suite assessment

676 tests, 33 files, 15 DB-backed. Coverage by subsystem:

| Subsystem | DB-backed | Pure | Gap |
|---|---|---|---|
| Save to pipeline | ✅ 19 | ✅ | — |
| Workflow transitions | ✅ 50 | ✅ 29 | — |
| Deal path | ✅ 36 | ✅ 32 | — |
| Collaboration lifecycle | ✅ 58 | ✅ 35 | — |
| Intelligence aggregation | ✅ 70 | ✅ 29 | — |
| RLS / grants | ✅ 47 | — | **no test of `public.users` grants** |
| Import | ✅ 5 files | ✅ 4 files | — |
| Discover / hotel detail | ✅ 34 | ✅ | — |
| **Auth / role resolution** | — | — | **no test at all** |
| Trips | partial (RLS only) | — | no feature yet |

The decisive gap is auth: **no test exercises `getSessionContext()` or
`requireRole()` against a real database role.** That gap is exactly why F-01
survived to this audit. Concurrency is genuinely tested with independent
connections (not simulated), and security checks use real Postgres roles rather
than mocks — both good.

Minor: the pure view-state suites overlap somewhat with the DB suites on label
vocabularies, but they assert distinct product copy, so this is duplication of
subject rather than of coverage.

---

## 14. Performance / scalability assessment

Nothing here blocks beta. Hazards worth tracking:

- `listPipelineItems` caps at `.limit(200)` with no pagination and no
  disclosure — see F-03.
- Discover uses `count: "exact"` on every search; fine at 30 hotels, a known
  cost at catalogue scale.
- `recompute_all_hotel_intelligence` is a synchronous loop over every hotel with
  activity — correct, but O(hotels) and unbounded in one transaction per hotel.
- The best-effort refresh is `await`ed inside the workflow action, adding a
  round trip (and a possible advisory-lock wait) to user-facing latency.
- Index coverage for the aggregation, cycle lookup and pipeline listing is
  present and appropriate.

---

## 15. Documentation consistency assessment

The decision record (D001–D045) is the strongest document and matches the code.
The divergences found are all in the older reference docs, and all are
documentation-only (F-08 … F-13). None describes a security property that the
code fails to implement; they describe capabilities that were later revoked or
deferred.

---

## 16. Production verification checklist

To be run by the external reviewer against production (not by this audit):

1. `main` SHA equals `d12f8f7dd624cb659414e3b357d2e1b82753b0ed`.
2. `supabase_migrations.schema_migrations` contains exactly versions 0001…0023,
   no extras, no gaps.
3. Function signatures exist and match: the eight application RPCs, with
   `prosecdef` false for all except `save_hotel_to_pipeline`, and
   `proconfig` containing `search_path=public, pg_temp` on all eight.
4. `has_function_privilege('anon'|'authenticated', …, 'EXECUTE') = false` and
   `service_role = true` for all eight; PUBLIC not present in `proacl`.
5. `has_table_privilege('authenticated', …)` — INSERT/UPDATE/DELETE false on
   `pipeline_items`, `outreach_events`, `collaborations`; SELECT true.
6. `has_table_privilege('authenticated', 'hotel_intelligence'|'destination_intelligence', 'SELECT') = false`.
7. `hotel_public_intelligence` selectable by anon and authenticated; column list
   is exactly the seven approved columns.
8. `relrowsecurity = true` on all `public` tables; policy list matches the 51
   policies in this audit.
9. Indexes present: `pipeline_items_single_active_cycle_uidx`,
   `collaborations_one_per_cycle_uidx`.
10. Row counts: 30 hotels, 0 pipeline_items, 0 outreach_events, 0
    collaborations, 0 hotel_intelligence, 0 destination_intelligence.
11. Supabase security advisor: no new findings beyond the accepted extension
    exceptions in §5.
12. No schema drift: object list diffed against a fresh local replay of 0001–0023.

---

## 17. Findings

| ID | Sev | Confidence | Subsystem | Location |
|---|---|---|---|---|
| F-01 | **P1** | CONFIRMED | Auth / role resolution | `src/lib/auth/guards.ts:28-36`; grants in `0012` |
| F-02 | P2 | CONFIRMED | Deal/collaboration integrity | `0006`, `0021`, `0023` schema |
| F-03 | P2 | CONFIRMED | Pipeline list | `src/lib/pipeline/queries.ts:117` |
| F-04 | P3 | CONFIRMED | Collaboration schema | `0006` `collaborations.pipeline_item_id` |
| F-05 | P3 | CONFIRMED | Intelligence lifecycle | no recompute on creator deletion |
| F-06 | P3 | LIKELY | Workflow latency | `src/lib/pipeline/actions.ts` |
| F-07 | P3 | CONFIRMED | Public view grants | `0013`/`0022` view grants |
| F-08 | P3 | CONFIRMED | Discover scale | `src/lib/hotels/queries.ts:175` |
| F-09 | P4 | DOCUMENTATION-ONLY | EVENTS.md §4 | stale transition map |
| F-10 | P4 | DOCUMENTATION-ONLY | EVENTS.md §5 | "Mark won → optional collaboration dates" |
| F-11 | P4 | DOCUMENTATION-ONLY | PERMISSIONS.md §9 | premium detailed intelligence |
| F-12 | P4 | DOCUMENTATION-ONLY | PERMISSIONS.md §5/§6 | creator write access |
| F-13 | P4 | DOCUMENTATION-ONLY | EVENTS.md §3 | `contact_bounced` has no producer |
| F-14 | P4 | DOCUMENTATION-ONLY | Test suite | no auth/role test |

### F-01 — Application cannot resolve user roles (P1, CONFIRMED)

> **Partially superseded — read §20 before acting on this finding.** External
> verification against production established that the *production* privilege
> state differs from a clean migration replay, so the impact paragraph below
> ("every session is treated as `creator`") describes the replayed schema, not
> production. The finding itself stands. The original wording is preserved
> verbatim as the historical record.

**Location.** `src/lib/auth/guards.ts:28-36`; migration `0012` never grants
`SELECT` on `public.users` to `authenticated`.

**Description.** `getSessionContext()` reads `public.users` with the
cookie-bound client to resolve the user's role. `authenticated` has no table
privilege on `public.users`, so the query fails. The code discards the error
and applies `?? "creator"`.

**Reproduction.**
```sql
begin;
  set local role authenticated;
  set local request.jwt.claims = '{"sub":"<admin uuid>","role":"authenticated"}';
  select role, email from public.users where id = '<admin uuid>';
  -- ERROR: permission denied for table users
rollback;
select has_table_privilege('authenticated','public.users','SELECT');  -- false
```
The same user's `public.is_admin_or_editor()` returns **true** — the database
half of the role system is intact; only the application half is broken.

**Impact.** Every session is treated as `creator`. `requireRole(["admin","editor"])`
in `src/app/admin/layout.tsx` always redirects, so `/admin` is unreachable by
anyone, and `isStaff` in the app layout is permanently false. It fails closed,
so there is no privilege escalation and no data exposure. It is also a direct
violation of the project's own rule — a permission error is being reported as
the domain fact "this user is a creator". The two RLS policies
`users_select_own` / `users_update_own` are dead code today.

**Recommended fix.** Either grant `select` on `public.users` to `authenticated`
(the existing `users_select_own` policy already restricts it to the caller's own
row), or resolve the role through the existing `public.current_user_role()`
SECURITY DEFINER wrapper, which is already client-executable and self-scoped.
Either way, distinguish a failed lookup from a genuine `creator` role rather
than collapsing both to the least-privileged answer, and add a DB-backed test
asserting an admin resolves as admin.

### F-02 — Cross-table lifecycle invariants are policy, not structure (P2, CONFIRMED)

**Location.** `collaborations` / `pipeline_items` / `outreach_events` schema.

**Description.** Four invariants the system treats as inviolable are enforced
only inside the RPCs: collaboration without `deal_won`; pipeline `won` without a
collaboration; terminal collaboration with a non-closed pipeline; duplicate
`deal_won` in one cycle. All four were created successfully by direct SQL.

**Impact.** Not reachable from the browser (client writes are revoked), so this
is hardening rather than an active hole. It becomes material the moment an admin
correction tool, a data migration or a second service writes these tables — the
RPCs would then classify the result as `integrity_error` with no way to repair it.

**Recommended fix.** Either add the missing constraints (e.g. a trigger or a
deferred check tying collaboration status to pipeline status), or explicitly
record in DATABASE.md that these are RPC-enforced and that any out-of-band
writer must uphold them. Prefer the second for V1; the first for the sprint that
introduces admin corrections.

### F-03 — Pipeline list silently truncates at 200 (P2, CONFIRMED)

**Location.** `src/lib/pipeline/queries.ts:117`.

**Description.** `listPipelineItems` applies `.limit(200)` with no pagination and
no count. A creator with more than 200 relationships sees an arbitrary subset
with no indication that anything is missing.

**Impact.** The Pipeline page states "N hotels" from the truncated array, so the
UI would assert a false count of the creator's own data. Low likelihood at
current scale; the failure mode is a quiet misstatement rather than an error.

**Recommended fix.** Paginate, or fetch an exact count and disclose truncation.

### F-04 — Orphan collaborations are permitted (P3, CONFIRMED)

`collaborations.pipeline_item_id` is nullable with `ON DELETE SET NULL`, and the
per-cycle unique index is partial (`where pipeline_item_id is not null`).
Deleting a pipeline item would therefore leave an unowned collaboration that no
lifecycle code can reach and no constraint deduplicates. No current code path
deletes a pipeline item, so this is theoretical today.

### F-05 — Derived intelligence is not refreshed when a creator is deleted (P3, CONFIRMED)

`creator_profiles` cascades to `pipeline_items` and `outreach_events`, but
nothing recomputes `hotel_intelligence` afterwards and no scheduled rebuild
exists. A deleted creator's outcomes remain in every affected hotel's aggregate
until someone runs `recompute_all_hotel_intelligence()`. Aggregates are
anonymous, so this is accuracy debt rather than a privacy breach — but it should
be resolved before account deletion ships.

### F-06 — Best-effort refresh is awaited in-band (P3, LIKELY)

`refreshIntelligenceForPipelineItem` is `await`ed inside every successful
workflow action, adding a service-role round trip and a possible per-hotel
advisory-lock wait to the creator's perceived latency. Correctness is unaffected
(failures are swallowed). Consider deferring it once a job runner exists.

### F-07 — `hotel_public_intelligence` is not granted to `service_role` (P3, CONFIRMED)

The view is granted to `anon` and `authenticated` only. All current reads use the
cookie-bound client, so nothing is broken today; a future server-side read via
`createAdminClient()` would fail with a confusing permission error.

### F-08 — Discover counts exactly on every search (P3, CONFIRMED)

`count: "exact"` forces a full count per search request. Immaterial at 30 hotels;
revisit before the catalogue grows.

### F-09 … F-13 — Documentation divergences (P4, DOCUMENTATION-ONLY)

- **F-09** `EVENTS.md §4` transition map predates D043/D045: it still says
  "won → closed only when closing archived cycle … if product UI requires" and
  omits the collaboration lifecycle and the close-classification rule entirely.
- **F-10** `EVENTS.md §5` says Mark-won asks for "optional collaboration dates";
  the implementation deliberately does not (dates belong to schedule/start).
- **F-11** `PERMISSIONS.md §9` promises premium users "detailed intelligence";
  0022 revoked all client access to the base tables and no surface exposes it.
- **F-12** `PERMISSIONS.md §5/§6` describe creator read/**write** on
  `pipeline_items`, `outreach_events`, `collaborations` and owner-writable
  `private_notes`; 0020/0021 revoked every client write.
- **F-13** `contact_bounced` is in the event enum and documented in EVENTS.md §3
  with no producer anywhere. Roadmap, but it should be marked as such.
- **F-14** No test covers auth/role resolution at all (see §13).

---

## 18. Deferred roadmap items — explicitly NOT defects

Mapbox and coordinates; Trips UX (`/app/trips` placeholder, `/app/trips/[id]`
absent); collaboration dashboard/history; Gmail/Outlook integration; destination
intelligence aggregation; Experience Intelligence aggregates over
`terms_matched`/`would_work_again`; repeat follow-ups; financial tracking and
`private_value_*` surfacing; collaboration rescheduling/editing; notes editing
and `next_followup_at` editing; Kanban; checkout/billing beyond the link target;
the seven unbuilt `/admin/*` routes; marketplace. None of these breaks an
existing promise.

---

## 19. Final recommendation

**C — HARDENING SPRINT REQUIRED.**

The rubric assigns C whenever a P1 exists, and F-01 is a genuine P1: an entire
role-gated surface is unreachable and the application's role resolution silently
reports a technical failure as a domain fact.

That said, the honest scope is small. F-01 is a one-line grant (or a switch to
the existing `current_user_role()` wrapper) plus error handling and one
DB-backed regression test. Pairing it with F-02's documentation and F-03's
pagination would clear everything that could plausibly affect Sprint 3 work.
Nothing in the core engine — state machine, trusted boundary, intelligence,
privacy, concurrency — requires redesign.

Suggested minimal pre-Sprint-3 hardening: **F-01 (required), F-03, F-09 … F-12.**

---

## 20. External verification addendum (2026-08-14)

This section was added **after** §1–§19 were written, on the basis of an
independent verification pass run by the external reviewer against the hosted
production project. This audit never contacted production; §1–§19 were derived
from a clean replay of `0001 → 0023` into an empty local database. The addendum
records where the two diverge, and corrects one claim that the audit was not
entitled to make.

### 20.1 What the external verification confirmed

| Check | Result |
|---|---|
| Production migration ledger | contains **0001 … 0023**, independently verified — no gaps, no extras |
| Cross-creator data exposure | none identified, in replay or in production |
| Core engine redesign required | **no** |
| Sprint 2G | is the remediation gate for everything below |

### 20.2 Correction to F-01's impact claim

§17/F-01 states that "every session is treated as `creator`" and that "`/admin`
is unreachable by anyone". That is what a **clean replay** produces: 0012 creates
the `users_select_own` / `users_update_own` policies but never grants any table
privilege on `public.users` to `authenticated`, so the read fails and
`row?.role ?? "creator"` converts a technical failure into a domain role.

External verification found that **production is not in that state**: hosted
Supabase left broader default grants in place, and production currently *does*
have `authenticated` `SELECT`/`UPDATE` on `public.users`. The audit's statement
that real production admins are currently reduced to `creator` was therefore
**not independently reproduced and is not established**. It should be read as a
property of the replayed schema, not of the deployed system.

### 20.3 What the finding actually is

Removing the unsupported impact claim does **not** dissolve F-01. Four distinct
problems remain, and all four are real:

- **(A) Migration replay is not equivalent to production.** The same migration
  set produces two different privilege states depending on whether hosted
  Supabase default grants happened to be present. Replay is therefore not a
  faithful rehearsal of production, which is the property the whole test suite
  depends on.
- **(B) A role-lookup error is incorrectly collapsed into `creator`.** This is
  wrong regardless of which privilege state the database is in. A failed read is
  a technical error; reporting it as the least-privileged *domain role* is the
  precise anti-pattern the codebase polices everywhere else.
- **(C) Table ACLs are not fully controlled by migrations.** The intended
  privilege contract is partly inherited from the hosting platform rather than
  being established explicitly by versioned SQL.
- **(D) Hosted default grants are broader than the intended contract.**
  Production reports privileges — including `INSERT`/`UPDATE`/`DELETE`/`TRUNCATE`
  for `anon` and `authenticated` on relations that were never meant to be
  client-writable — that no migration in this repository requested.

On (D): RLS is enabled on every table and the audit's direct probing found no
row-level path through those grants, so this is **not evidence of current
exposure**. It is evidence that the reachable surface is wider than the contract
intends, and that the contract is not written down anywhere the database can
enforce it.

### 20.4 F-02 — accepted as deferred hardening

F-02 is **accepted as deferred hardening (P2)**, not scheduled for Sprint 2G.
Adding cross-table constraint triggers now would introduce write-path complexity
and lock behaviour into the exact code the rest of this sprint is hardening.

The important thing is to state the position accurately rather than to overstate
the guarantee:

- The database **does** structurally prevent two open cycles per creator+hotel
  and two collaborations per relationship cycle (two partial unique indexes).
- The database **does not** structurally encode every cross-table lifecycle
  invariant. Collaboration-without-`deal_won`, `won`-without-collaboration,
  terminal-collaboration-with-open-pipeline and duplicate `deal_won` are
  detected by the RPCs, not prevented by constraints.
- The trusted RPCs are the **canonical mutation boundary** for pipeline,
  outreach and collaboration state. Client write access to all three tables is
  revoked, so no browser path can reach these states.
- Any future privileged tooling — an admin correction surface, a data migration,
  a second service, hand-written `postgres`/`service_role` SQL — **must uphold
  these invariants itself**. Arbitrary superuser or service-role SQL against
  these tables is not safe by construction and must not be assumed to be.

### 20.5 Status of this audit

F-01 remains a real reproducibility and error-semantics defect. Its blast radius
is narrower than §17 asserted. No P0 was found in either the replay or the
external verification, no cross-creator exposure was identified, and no core
redesign is required. **Sprint 2G is the remediation gate**; the per-finding
outcome is recorded in §21.
