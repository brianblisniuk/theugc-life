# theugc.life — PROPERTY_CONTENT_IMPLEMENTATION_SPEC.md

Version: 1.0
Status: **Implementation spec for the V1 property-content infrastructure
foundation.** Closed — no unresolved product decision blocks implementation.

Governing contract:
[`PROPERTY_CONTENT_COVERAGE_CONTRACT.md`](PROPERTY_CONTENT_COVERAGE_CONTRACT.md)
(D060–D064). Also governed by [`HOTEL_DATA_CONTRACT.md`](HOTEL_DATA_CONTRACT.md),
[`CANONICAL_PROMOTION_SPEC.md`](CANONICAL_PROMOTION_SPEC.md),
[`IMPORT_SPEC.md`](IMPORT_SPEC.md), [`DESTINATION_CATALOG.md`](DESTINATION_CATALOG.md),
D046 (privileges are a migration contract).

**This document specifies infrastructure only.** It does not ingest Bali or
Dubai, does not run Coverage Engine, does not promote anything, does not choose a
star authority, and does not download media.

---

## 1. Current architecture map

### 1.1 Canonical layer (creator-facing)

```
destinations ──< hotels ──< hotel_contacts
                   │           (premium, entitlement-gated)
                   ├──< hotel_organizations >── organizations
                   ├──< hotel_intelligence ──> hotel_public_intelligence  (view)
                   │                        └─> hotel_premium_intelligence (view)
                   └──< trip_hotels, pipeline_items, collaborations …
```

`hotels` is canonical **publishable** inventory. A row in `hotels` is a row a
creator can see (D062 §7.0). There is no `publication_status`, no canonical draft
tier, and this spec introduces none.

### 1.2 Editorial / import layer (staff-only)

Built in Sprint 1A/1B for **file** research (`IMPORT_SPEC.md` §3,
`CANONICAL_PROMOTION_SPEC.md`):

```
import_batches                     one parsed FILE
  └──< import_rows                 one source ROW (property | contact | evidence)
        ├──< import_match_candidates    explainable entity-resolution candidates
        ├──< import_row_reviews         child-row include/exclude override
        └──< import_row_links           row → canonical entity, after promotion
import_property_reviews            decision per (batch, source_property_key)
editorial_evidence                 provenance for a claim
destination_aliases                alias → destination resolution
```

Promotion (`src/lib/import/promote.ts`) is reviewer-gated, preview-first, and
idempotent through `import_row_links`.

Every table above is `service_role` + `is_admin_or_editor()` through RLS, with
privileges stated explicitly in migration `0024` (D046).

### 1.3 What the file pipeline assumes, and why provider sources break it

| Assumption | File import | Provider API |
|---|---|---|
| Unit of work | one uploaded file, parsed once | one **run**, repeated over time |
| Identity of a candidate | `(batch, source_property_key)` — dies with the batch | `(provider, environment, source_property_id)` — **durable across runs** |
| Re-execution | re-import is an anomaly, guarded by file SHA | re-execution is **normal and expected** |
| Record count | tens–hundreds | thousands per destination |
| Review lifetime | per batch | must survive the next run |

The last row is the structural one. A file review answers "what do we do with
this batch"; a provider review answers "what do we do with this property,
forever". Storing the second in a table keyed on a batch would discard the
decision every time the provider is re-read.

---

## 2. Provider-source flow

```
provider API (evaluation or production environment)
  │
  ├─ source_runs                     one execution: provider × environment × destination
  │
  ├─ source_property_identities      durable (provider, environment, source id)
  │    │                             first/last seen, resolution state
  │    │
  │    ├─ source_property_observations   one snapshot per (run, identity)
  │    │                                  source facts, never canonical truth
  │    │
  │    ├─ source_match_candidates        evidence matrix vs canonical hotels
  │    │
  │    └─ source_property_reviews        durable human decision per identity
  │
  └─ hotel_source_identities         canonical hotel ↔ source identity (D063)
       │
       └─ (future) D062 promotion gate → hotels
```

## 3. Existing file-import flow (unchanged)

```
file → import_batches → import_rows → import_match_candidates
     → import_property_reviews (+ import_row_reviews)
     → promote preview → --apply → hotels / hotel_contacts / editorial_evidence
     → import_row_links
```

**Nothing in this block modifies that path.** No column is added to, removed
from or re-typed in any `import_*` table.

## 4. Convergence point

The two pipelines converge at the **review → promotion-gate boundary**, not at
the storage layer:

```
FILE:      import_property_reviews ─┐
                                    ├─→ D062 promotion gate ─→ hotels
PROVIDER:  source_property_reviews ─┘        (future block)
```

Shared, deliberately:

- the **decision vocabulary** — `approve_create` · `approve_match` · `reject` ·
  `defer`, identical strings to `import_property_reviews`;
- the **destination catalogue** — both resolve through `destinations` /
  `destination_aliases`;
- the **canonical target** — both can only ever create or match a row in
  `hotels`, subject to the same D062 gate;
- the **provenance sink** — `editorial_evidence` accepts a source-run reference
  (§5.7), so a provider claim and a research claim are auditable side by side;
- the **security model** — `service_role` + `is_admin_or_editor()`.

Not shared, deliberately: staging storage, run bookkeeping and candidate
identity, because their lifetimes genuinely differ (§1.3).

---

## 5. Exact new tables

Five tables. Every one is `public`, RLS-enabled, admin/editor + service_role.

### 5.1 `source_runs` — one execution of a source

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `source` | `text` NOT NULL | provider namespace, e.g. `hotelbeds`. Free text, not an enum: a new provider must not require a migration. |
| `source_environment` | `text` NOT NULL | `evaluation` \| `production`. **The isolation axis (§18).** |
| `destination_id` | `uuid` NULL FK `destinations` | canonical destination. NULL for a non-destination run (a master-data or credential run). |
| `provider_geography` | `jsonb` NOT NULL default `'{}'` | the provider-native geography actually used, e.g. `{"destinationCode":"BAI"}`. Evidence, not configuration. |
| `run_mode` | `text` NOT NULL | `full` \| `incremental` \| `evaluation` \| `master_data`. |
| `run_status` | `text` NOT NULL default `'running'` | §7 state machine. |
| `started_at` / `completed_at` | `timestamptz` | `completed_at` NULL while running. |
| `raw_records_seen` | `integer` NOT NULL default 0 | |
| `unique_source_property_ids` | `integer` NOT NULL default 0 | |
| `provider_reported_total` | `integer` NULL | NULL = provider supplied none. Never defaulted to 0 — "0" and "did not say" are different facts. |
| `pagination_walk_completed` | `boolean` NOT NULL default false | the walk consumed every page. |
| `extraction_exhaustion_proven` | `boolean` NOT NULL default false | walk completed **and** zero coverage risks. Separate from the above because they fail for different reasons and demand different responses. |
| `coverage_risks` | `text[]` NOT NULL default `'{}'` | never silently emptied. |
| `request_count` / `cache_hit_count` | `integer` NOT NULL default 0 | quota accounting evidence. |
| `harness_version` | `text` NULL | which code produced this run. |
| `notes` | `text` NULL | |
| `created_by` | `uuid` NULL FK `users` | |
| `created_at` / `updated_at` | `timestamptz` | |

Indexes: `(source, source_environment, started_at desc)`,
`(destination_id, run_status)`.

**Why not `import_batches`?** A batch is keyed on a parsed file
(`source_file_name`, `file_sha256`, `parser_name`, `parser_version`) and its
status vocabulary is parse-shaped (`parsing`, `parsed`, `review_required`). A
provider run has no file, no parser version, and needs pagination-exhaustion,
coverage-risk, provider-total and quota evidence that a file has no analogue
for. Overloading it would mean nullable-everything on both sides and a status
enum that means two different things.

### 5.2 `source_property_identities` — durable source identity

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | our surrogate. **Never the provider id.** |
| `source` | `text` NOT NULL | |
| `source_environment` | `text` NOT NULL | |
| `source_property_id` | `text` NOT NULL | provider-native, stored as text (Hotelbeds returns a number; a provider may not). |
| `source_url` | `text` NULL | |
| `first_seen_at` / `last_seen_at` | `timestamptz` NOT NULL | |
| `first_seen_run_id` / `last_seen_run_id` | `uuid` NOT NULL FK `source_runs` ON DELETE RESTRICT | |
| `resolution_state` | `text` NOT NULL default `'unresolved'` | §8 / Coverage Engine (§22). |
| `resolution_reason` | `text` NULL | required when the state is a final exclusion; §8. |
| `observation_count` | `integer` NOT NULL default 0 | |
| `created_at` / `updated_at` | `timestamptz` | |

**Uniqueness — the core invariant:**

```sql
unique (source, source_environment, source_property_id)
```

Provider id uniqueness is scoped **within its namespace and environment**. The
same `12345` in Hotelbeds evaluation and Hotelbeds production are different
identities, and must be, or an evaluation record could silently satisfy a
production precondition.

Indexes: the unique key, plus `(resolution_state)` and `(last_seen_run_id)`.

**Why not `import_rows`?** An import row is immutable, belongs to exactly one
batch, and dies with it. A source identity is mutable (last seen, resolution
state), belongs to no run in particular, and must outlive every run.

### 5.3 `source_property_observations` — one snapshot per run

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `source_run_id` | `uuid` NOT NULL FK `source_runs` **ON DELETE RESTRICT** | |
| `source_property_identity_id` | `uuid` NOT NULL FK `source_property_identities` **ON DELETE RESTRICT** | |
| `observed_at` | `timestamptz` NOT NULL | |
| `source_name` | `text` NULL | |
| `source_destination_code` / `source_zone_code` | `text` NULL | provider geography as returned. |
| `source_address` / `source_postal_code` / `source_city` | `text` NULL | |
| `source_latitude` / `source_longitude` | `numeric` NULL | **no range CHECK** — §5.3.1. |
| `source_coordinates_plausible` | `boolean` NULL | derived audit flag, not a filter. |
| `source_website_url` / `source_email` / `source_phone` | `text` NULL | |
| `source_phone_type` | `text` NULL | so a fax is never silently reported as a contact phone. |
| `source_brand_code` / `source_chain_code` | `text` NULL | |
| `source_property_type_code` | `text` NULL | e.g. Hotelbeds `accommodationTypeCode`. |
| `source_property_type_label` | `text` NULL | resolved through the provider's own master. |
| `source_classification_code` | `text` NULL | e.g. `5EST`. |
| `source_classification_label` | `text` NULL | e.g. `5 STARS`. |
| `source_classification_group` | `text` NULL | e.g. `GRUPO5`. |
| `source_classification_simple_code` | `text` NULL | **text, not numeric** — §5.3.2. |
| `source_classification_evidence_kind` | `text` NOT NULL default `'provider_classification_evidence'` | §5.3.2. |
| `source_lifecycle_status` | `text` NULL | **only when the provider actually supplies one.** |
| `source_image_count` | `integer` NULL | §20. |
| `source_provider_designated_principal_image` | `boolean` NULL | §20. |
| `source_attributes` | `jsonb` NOT NULL default `'{}'` | bounded; §19. |
| `source_payload_digest` | `text` NULL | sha256 of the provider's record; §19. |
| `source_payload_uri` | `text` NULL | pointer to an off-database raw artifact; §19. |
| `created_at` | `timestamptz` | |

**Idempotency:**

```sql
unique (source_run_id, source_property_identity_id)
```

One run observes one source property at most once. Re-running the extraction
produces a **new run** and therefore a new observation — history accumulates
rather than being overwritten.

Indexes: the unique key, `(source_property_identity_id, observed_at desc)`,
`(source_run_id)`.

#### 5.3.1 Invalid provider coordinates are preserved

There is deliberately **no** `check (latitude between -90 and 90)` on source
columns. The Bali evaluation returned one out-of-range coordinate; a range
constraint would have made that row unstorable, and the ingestion would have had
to drop it, null it or crash. All three destroy evidence.

`source_coordinates_plausible` records the audit verdict. `hotels.latitude` /
`hotels.longitude` remain the resolved canonical values and are untouched here.

#### 5.3.2 Provider classification is evidence, never canonical stars

`source_classification_simple_code` is **text**. Hotelbeds `simpleCode` is a
number that is *not* a star rating — `simpleCode 5` covers `5EST` (5 STARS),
`5LL` (5 KEYS), `APTH5` (aparthotel) and `HS5` (hostel). Typing it numeric would
invite `where simple_code >= 4`, which is precisely the query that must never
produce inventory.

`source_classification_evidence_kind` is constrained to
`provider_classification_evidence` or `canonical_classification_evidence`, and
**no source may write the second without a product decision naming its issuing
authority**. Hotelbeds is locked to the first
(`evaluations/PROPERTY_SOURCE_BAKEOFF_BALI_DUBAI_2026-08.md` §9).

No star value is computed, rounded or averaged anywhere in this layer (D060 §8;
locked invariant G).

**Why not `import_rows.raw_data`?** An import row stores one file row's raw
JSON. A source observation is a *typed, queryable* snapshot whose fields the
resolution and Coverage Engine layers must filter and join on, and whose raw
payload is deliberately **not** stored inline (§19).

### 5.4 `source_match_candidates` — entity-resolution evidence

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `source_property_identity_id` | `uuid` NOT NULL FK identities ON DELETE CASCADE | |
| `source_run_id` | `uuid` NULL FK runs ON DELETE SET NULL | which run generated it. |
| `candidate_hotel_id` | `uuid` NULL FK `hotels` ON DELETE CASCADE | NULL = "no canonical candidate", i.e. a NEW PROPERTY assertion. |
| `name_evidence` | `text` NOT NULL default `'none'` | `exact` \| `token_containment` \| `none` — **one dimension, two strengths**. |
| `domain_evidence` / `address_evidence` / `phone_evidence` / `brand_evidence` | `text` NOT NULL default `'unavailable'` | `agrees` \| `differs` \| `unavailable`. |
| `coordinate_distance_metres` | `numeric` NULL | raw distance. **No threshold is stored.** |
| `known_source_mapping` | `boolean` NOT NULL default false | a previously confirmed identity link. |
| `agreeing_dimensions` | `integer` NOT NULL default 0 | count of independent dimensions in agreement. |
| `match_method` | `text` NOT NULL | human-readable, e.g. `name_exact+domain_agrees`. |
| `status` | `text` NOT NULL default `'pending'` | `pending` \| `accepted` \| `rejected` \| `superseded`. |
| `review_note` | `text` NULL | |
| `created_at` / `resolved_at` | `timestamptz` | |

Indexes: `(source_property_identity_id, status)`, `(candidate_hotel_id)`.

**`unavailable` is not `differs`.** "Neither side supplied an address" is not
evidence against a match, and collapsing the two would turn missing data into a
negative finding.

**No numeric confidence column and no threshold** (D063 §12.2, locked invariant
H). `agreeing_dimensions` counts *independent* dimensions — a name agreement is
one dimension whatever its strength, which is the bug the pilot comparison had to
have fixed. **A name alone never auto-merges**: it produces at most
`agreeing_dimensions = 1`, and §8 forbids `matched` below two.

**Why not `import_match_candidates`?** That table FKs `import_row_id NOT NULL`
and carries a single `score numeric NOT NULL` — a confidence number this contract
explicitly refuses to invent. Reusing it would mean either a fake score or a
nullable-score schema change to a working, reviewed table.

### 5.5 `hotel_source_identities` — the D063 canonical link

The table `PROPERTY_CONTENT_COVERAGE_CONTRACT.md` §11.1 names.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `hotel_id` | `uuid` NOT NULL FK `hotels` ON DELETE CASCADE | |
| `source_property_identity_id` | `uuid` NOT NULL FK identities ON DELETE RESTRICT | |
| `source` / `source_environment` / `source_property_id` | `text` NOT NULL | denormalised for the constraint below and for auditability if a provider is dropped. |
| `link_status` | `text` NOT NULL default `'active'` | `active` \| `superseded` \| `rejected`. |
| `match_method` | `text` NOT NULL | how the link was established. |
| `match_evidence` | `jsonb` NOT NULL default `'{}'` | the evidence matrix at decision time. |
| `linked_by_user_id` | `uuid` NULL FK `users` | |
| `linked_at` | `timestamptz` NOT NULL | |
| `first_seen_at` / `last_seen_at` / `last_synced_at` | `timestamptz` | §11.1 semantics. |
| `created_at` / `updated_at` | `timestamptz` | |

**Two constraints carry the D063 invariants:**

```sql
-- One ACTIVE source identity maps to at most ONE canonical hotel.
create unique index hotel_source_identities_active_identity_uidx
  on public.hotel_source_identities (source_property_identity_id)
  where link_status = 'active';

-- Evaluation data can never become canonical evidence (§18).
constraint hotel_source_identities_production_only
  check (source_environment = 'production')
```

A canonical hotel may hold **many** source identities (different providers, or a
superseded link plus its replacement). The unique index is partial on
`active` so history is retained rather than deleted.

`hotels` gains **no** provider column. There is no `hotelbeds_id`,
`booking_id` or `expedia_id` anywhere in the canonical schema (locked invariant
C).

### 5.6 `source_property_reviews` — durable decision per identity

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `source_property_identity_id` | `uuid` NOT NULL **UNIQUE** FK identities ON DELETE CASCADE | one live decision per identity. |
| `decision` | `text` NOT NULL | `approve_create` \| `approve_match` \| `reject` \| `defer` — **identical vocabulary to `import_property_reviews`**. |
| `target_hotel_id` | `uuid` NULL FK `hotels` | |
| `destination_id` | `uuid` NULL FK `destinations` | |
| `reviewer_user_id` | `uuid` NULL FK `users` | |
| `reviewer_label` | `text` NOT NULL | |
| `review_note` | `text` NULL | |
| `decided_in_run_id` | `uuid` NULL FK `source_runs` ON DELETE SET NULL | which run's evidence the decision was made against. |
| `reviewed_at` / `created_at` / `updated_at` | `timestamptz` | |

Decision shape is constrained exactly as `import_property_reviews` is:

```sql
check (
  (decision = 'approve_create' and target_hotel_id is null and destination_id is not null)
  or (decision = 'approve_match' and target_hotel_id is not null)
  or (decision in ('reject', 'defer') and target_hotel_id is null)
)
```

That is six tables' worth of concepts in five plus this one — see §6 for why each
exists.

### 5.7 One additive change to an existing table

`editorial_evidence` gains **one nullable column**:

```sql
alter table public.editorial_evidence
  add column source_run_id uuid references public.source_runs(id) on delete set null;
```

Nothing else about it changes. This is the provenance sink both pipelines share
(§4): a provider claim and a file-research claim become auditable in one place
instead of two. `import_batch_id` and `import_row_id` remain untouched and
nullable as before.

---

## 6. Why each table is necessary rather than a reuse

| New table | Nearest existing | Why not reused |
|---|---|---|
| `source_runs` | `import_batches` | file/parser-keyed; no pagination-exhaustion, coverage-risk, provider-total or quota semantics; status enum is parse-shaped |
| `source_property_identities` | `import_rows` | import rows are immutable, batch-scoped and disposable; a source identity is mutable and must outlive every run |
| `source_property_observations` | `import_rows.raw_data` | needs typed, queryable, joinable columns and an explicit raw-payload boundary (§19) |
| `source_match_candidates` | `import_match_candidates` | FKs a NOT NULL `import_row_id` and requires a NOT NULL `score`; this contract refuses to invent a confidence number |
| `source_property_reviews` | `import_property_reviews` | keyed on `(import_batch_id, source_property_key)` — a decision that dies with the batch; provider decisions must survive re-runs |
| `hotel_source_identities` | — | no equivalent exists; named by D063 §11.1 |

---

## 7. Source-run lifecycle

```
running ──> completed          walk finished (exhaustion proven or not)
   │
   ├──────> incomplete         stopped early: budget, quota, or interruption
   ├──────> failed             error before useful completion
   └──────> abandoned          superseded operationally
```

Rules:

- a run starts `running` with `completed_at` NULL;
- `completed_at` must be NULL when `running`, and NOT NULL otherwise —
  enforced by CHECK, so "still running" and "finished" cannot be confused;
- `extraction_exhaustion_proven = true` requires
  `pagination_walk_completed = true` — enforced by CHECK. A run cannot claim
  exhaustion it did not walk;
- `coverage_risks` is append-only by convention and never emptied to make a run
  look clean;
- **a run is never deleted to hide a bad extraction.** Observations and
  identities FK it `ON DELETE RESTRICT`.

## 8. Source-identity lifecycle

```
first observation ──> unresolved
                        │
                        ├──> resolved_eligible      A. canonical eligible V1 property
                        ├──> duplicate_matched      B. matched to an existing canonical hotel
                        └──> final_exclusion        C. out of V1 scope, durable reason
```

These are exactly D061 §15.1's three terminal states, plus the hold state.

`resolution_reason` is required (CHECK) when `resolution_state =
'final_exclusion'`, and uses the D061 §9 vocabulary:

`duplicate_merged` · `permanently_closed` · `corporate_group_hq` ·
`agency_non_property` · `not_physical_hospitality` ·
`star_below_v1_scope` · `outside_destination` · `other_reviewed_exclusion`

**`star_classification_unresolved` and `identity_unresolved` are NOT exclusion
reasons.** They are hold states, and an identity carrying them stays
`unresolved` — which is what keeps it inside the coverage-critical count.
Collapsing the two is the failure D061 §9 exists to prevent: "star unknown" is
not the same fact as "confirmed 3-star".

`matched` requires two or more independent agreeing dimensions on the accepted
candidate. A name agreement alone cannot produce `duplicate_matched` — locked
invariants H and I.

## 9. Source-observation model

One identity, many observations, one per run:

```
identity 12345 ─┬─ run 2026-08-16 (evaluation) → observation: "Hotel X", 4EST, lat/lon
                ├─ run 2026-09-01 (evaluation) → observation: "Hotel X", 5EST, lat/lon
                └─ run 2026-10-01 (production) → …different identity (§18)
```

The 4EST → 5EST change is retained as two observations. Nothing overwrites, so a
future star resolution can cite **which observation, from which run, at which
time** supported a canonical value — D062 conditions 7 and 10.

Observations are never mutated after insert (convention, not a trigger — a
staff-only table with an explicit contract, consistent with `import_rows`).

## 10. Entity-resolution model

Evidence, not scores:

| Dimension | Values | Independent? |
|---|---|---|
| NAME | `exact` \| `token_containment` \| `none` | one dimension, two strengths |
| DOMAIN | `agrees` \| `differs` \| `unavailable` | yes |
| ADDRESS | `agrees` \| `differs` \| `unavailable` | yes |
| PHONE | `agrees` \| `differs` \| `unavailable` | yes |
| BRAND/CHAIN | `agrees` \| `differs` \| `unavailable` | yes |
| COORDINATES | raw metres, no threshold | corroborating |
| KNOWN MAPPING | boolean | yes |

`agreeing_dimensions` is stored so a reviewer sees the count without recomputing
it, and a CHECK bounds it to `0..6`. No universal threshold is stored anywhere;
the promotion gate and the reviewer decide, and §8 states the one structural
floor (two dimensions for a match).

## 11. Canonical source-identity mapping

Answers "which Hotelbeds property corresponds to this canonical hotel?" in one
join:

```sql
select h.id, h.name, si.source, si.source_property_id
from public.hotels h
join public.hotel_source_identities si on si.hotel_id = h.id
where si.link_status = 'active' and si.source = 'hotelbeds';
```

Invariants, both enforced in the database:

- **one active source identity → at most one canonical hotel** (partial unique
  index);
- **one canonical hotel → many source identities** (no constraint prevents it,
  by design).

## 12. RLS / ACL model

Identical to the existing import infrastructure, and stated explicitly per D046:

- RLS enabled on all six new tables;
- one `for all using (is_admin_or_editor()) with check (is_admin_or_editor())`
  policy per table;
- `grant select, insert, update, delete … to authenticated` — a capability
  grant; RLS reduces a regular creator to zero rows;
- `grant all … to service_role`;
- **no `anon` grant of any kind**;
- migration `0024`'s `alter default privileges` already revokes client
  privileges on future tables, so the grants above are the entire client surface.

The ACL matrix test (`tests/rls/acl-matrix.test.ts`) is extended with the six new
relations, so a future table that forgets its grants fails the suite.

## 13. Idempotency semantics

| Level | Mechanism |
|---|---|
| identity | `unique (source, source_environment, source_property_id)` — re-running never forks an identity |
| observation | `unique (source_run_id, source_property_identity_id)` — a run cannot double-observe |
| canonical link | partial unique on `(source_property_identity_id) where link_status='active'` |
| review | `unique (source_property_identity_id)` |

Re-running an extraction is therefore **safe and additive**: new run row, new
observations, same identities, existing reviews and links untouched.

## 14–17. (Covered above)

§14 source-run semantics → §7 · §15 source-identity semantics → §8 ·
§16 source-observation semantics → §9 · §17 entity-resolution semantics → §10.

## 18. Evaluation vs production isolation

Three independent mechanisms, because one would be a single point of failure:

1. **Identity separation.** `source_environment` participates in the identity
   unique key, so an evaluation record and a production record with the same
   provider id are different rows. An evaluation identity can never be mistaken
   for its production counterpart.
2. **Link prohibition.** `hotel_source_identities` CHECKs
   `source_environment = 'production'`. Evaluation data **cannot** be linked to a
   canonical hotel at all — not by a bug, not by a careless script, not by a
   reviewer.
3. **Run provenance.** Every observation carries its run, and every run carries
   its environment, so the environment of any evidence is one join away and
   cannot be lost.

This implements locked invariant K. The Hotelbeds *evaluation* extraction
(3,275 Bali + 835 Dubai records, already measured) can be loaded by a future
block for analysis and **still** cannot become canonical inventory.

## 19. Raw-payload boundary — an explicit decision

**Decision: full provider payloads are NOT stored in Postgres.**

What lives in Postgres:

- the typed observation columns (§5.3) — everything resolution, review and
  Coverage Engine actually query;
- `source_attributes jsonb` — a **bounded** overflow for provider fields not yet
  modelled, guarded by a trigger that raises above 8 KB per row;
- `source_payload_digest` — sha256 of the provider's record, which is what makes
  "did this property change between runs?" answerable without storing the
  payload;
- `source_payload_uri` — a nullable, opaque pointer to an off-database artifact.

What does not:

- the complete provider record, and specifically the image arrays. One Bali
  property returned **118** images; the destination totals **137,328**. Putting
  that in a JSONB column because it is easy would cost storage and I/O
  permanently in exchange for data no query needs yet.

**No object-storage product is chosen here, and none is required.** The repo has
not made that decision, and this spec does not make it: `source_payload_uri` is
a `text` column with no semantics beyond "opaque locator". Today's harness
already persists raw payloads to the gitignored `.data/provider-evaluation/`
tree; a future block may point the URI at that, at object storage, or at
nothing. **The relational layer does not depend on the choice** — every
constraint, index and query in this spec works with the column NULL.

> **FLAGGED FOR A FUTURE DECISION, non-blocking:** durable raw-artifact storage
> (which product, what retention, what cost) is an infrastructure decision this
> block deliberately does not make.

## 20. Media boundary

**No image rows, no image binaries, no `hotel_media` table in this block**
(D064 storage strategy and the production/commercial rights review are both
open).

What is retained, per observation, so ingestion remains possible later:

- `source_image_count` — how many images the provider offered;
- `source_provider_designated_principal_image` — whether the provider designated
  a principal image (`visualOrder = 0` for Hotelbeds). HBX documents that
  designation **and** documents that some hotels carry none, so `false` is a
  documented valid state, not a defect.

Where media plugs in later:

```
hotel_media (future, D064 §14.1)
  ├─ hotel_id                     → hotels
  ├─ source_identity reference    → hotel_source_identities.id
  └─ source observation reference → source_property_observations.id
```

Both FK targets exist after this block, so the future media block adds a table
rather than rebuilding ingestion. Nothing here has to be undone.

## 21. D062 future-gate interface

The gate is **not implemented**. What this block guarantees is that it *can* be,
without touching source ingestion.

A future promotion preview must answer, per candidate:

| D062 condition | Where the evidence comes from |
|---|---|
| 1. canonical identity resolved | `source_property_reviews.decision` + `hotel_source_identities` |
| 2. supported destination | `source_property_reviews.destination_id` → `destinations` |
| 3. physical hospitality property | `source_property_observations.source_property_type_code/label` |
| 4. not permanently closed | `source_lifecycle_status` **when the provider supplies one** |
| 5. V1 scope resolved | `source_property_identities.resolution_state` |
| 6. star exactly 4 or 5 | **not from this layer alone** — see below |
| 7. star provenance | future `hotel_star_resolutions` → `source_property_observations.id` |
| 8/9. canonical lat/long | future `hotel_location_resolutions` → `source_property_observations.id` |
| 10. coordinate provenance | same |
| 11. no unresolved conflict | `source_match_candidates.status` |

The two future resolution tables are **specified as an interface only**:

```
hotel_star_resolutions (future)
  hotel_id                        → hotels
  resolved_star_value             numeric, exactly 4 or 5 for V1
  evidence_observation_id         → source_property_observations(id)
  issuing_authority               text NOT NULL   -- the open product decision
  conflict_state                  text
  resolved_by_user_id, resolved_at

hotel_location_resolutions (future)
  hotel_id                        → hotels
  resolved_latitude, resolved_longitude
  evidence_observation_id         → source_property_observations(id)
  conflict_state                  text
  resolved_by_user_id, resolved_at
```

Both FK `source_property_observations(id)`, which is why observations are
`ON DELETE RESTRICT` and never mutated: a canonical star that cites an
observation must be able to keep citing it.

**Hotelbeds is not the star authority and this block does not make it one.** The
star-authority hierarchy for Bali/Dubai remains explicitly undecided
(`PROPERTY_CONTENT_COVERAGE_CONTRACT.md` §16), which is exactly why
`issuing_authority` is a future column rather than a value written today.

## 22. Coverage Engine future interface

Not implemented. The union it will need is available from this schema:

```sql
-- Approved provider candidates for a destination, by resolution state.
select spi.resolution_state, spi.resolution_reason, count(*)
from public.source_property_identities spi
join public.source_property_observations spo
  on spo.source_property_identity_id = spi.id
join public.source_runs sr on sr.id = spo.source_run_id
where sr.destination_id = $1 and sr.source_environment = 'production'
group by 1, 2;

-- The number that decides closure (D061 §15.1).
--   coverage_critical_unresolved_count = count(resolution_state = 'unresolved')
--   COVERAGE COMPLETE requires that count = 0
```

The three terminal states map one-to-one onto D061 §15.1 A/B/C, and the hold
state is counted, never hidden. **Nothing in the ingestion path deletes an
unresolved candidate** — the FKs are `RESTRICT`, and no code path in this block
issues a DELETE.

## 23. Historical Dubai pilot treatment

Unchanged and untouched. The 30 canonical pilot rows in `hotels`:

- are **not** grandfathered under D062 (contract §7.0, `CANONICAL_PROMOTION_SPEC`
  §6.1);
- are **not** modified, re-audited, linked or deleted by this block;
- gain no source identity — the Hotelbeds data that plausibly matches 27 of them
  is *evaluation-environment* data, which §18 prohibits from linking.

Their re-audit is a later block, and this schema is what will make it auditable:
a production run, observations, match candidates, and a reviewer decision per
identity.

## 24. Migration / rollout order

1. `0027_property_content_infrastructure.sql` — the six tables, constraints,
   indexes, triggers, RLS policies, explicit grants, and the one additive
   `editorial_evidence.source_run_id` column. Additive only; nothing existing is
   altered or dropped.
2. `tests/db/property-content.test.ts` — the invariant suite (§13 of the block
   brief).
3. `tests/rls/acl-matrix.test.ts` — six new relations added to the contract.
4. Documentation: `DATABASE.md` §5a, this spec, contract cross-references.

**Not in this block, in dependency order afterwards:** provider ingestion writer
→ resolution runner → D062 gate + star/location resolution tables → Coverage
Engine → media.

---

## 25. Product decisions encountered

None that block implementation. For the record:

| Question | Status |
|---|---|
| Star authority hierarchy | **Open** (contract §16) — deferred by design; `issuing_authority` is a future column |
| Object storage product | **Open** — flagged in §19; the relational layer does not depend on it |
| Media storage strategy | **Open** (D064) — §20 keeps ingestion possible without deciding |
| Evaluation data may never link canonically | **Determined** by locked invariant K; implemented as a CHECK |
| Provider review is a separate table | **Implementation**, justified in §1.3 / §6 |
| Match threshold | **Refused** by D063 §12.2; none stored |
