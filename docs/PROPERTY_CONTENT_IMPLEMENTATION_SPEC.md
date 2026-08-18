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
  │    ├─ source_match_candidates        evidence matrix vs a canonical hotel,
  │    │                                  another source identity, or NEW PROPERTY
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

**Six tables** (§5.1–§5.6), plus one additive nullable column on an existing
table (§5.7). Every new table is `public`, RLS-enabled, admin/editor +
service_role.

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
| `provider_enumeration_exhaustion_proven` | `boolean` NOT NULL default false | **enumeration exhaustion only**: walk completed **and** zero `enumeration_risks`. §7.1. |
| `enumeration_risks` | `text[]` NOT NULL default `'{}'` | risks to the enumeration *itself* (cursor loop, provider total disagreeing with rows returned, budget stop). These block exhaustion. |
| `coverage_risks` | `text[]` NOT NULL default `'{}'` | risks about what the enumerated set *means* (geography-mapping caveats, pending coverage-universe comparison). Recorded, never silently emptied, and they do **not** falsify a completed walk. §7.1. |
| `request_count` / `cache_hit_count` | `integer` NOT NULL default 0 | quota accounting evidence. |
| `harness_version` | `text` NULL | which code produced this run. |
| `notes` | `text` NULL | |
| `created_by` | `uuid` NULL FK `users` | |
| `created_at` / `updated_at` | `timestamptz` | |

Indexes: `(source, source_environment, started_at desc)`,
`(destination_id, run_status)`.

Also carries `unique (id, source, source_environment)`. That is redundant as a
key — `id` is already the PK — and exists solely so identities and observations
can foreign-key a run's **source and environment**, not merely its id (§5.2,
§5.3, §18.4).

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
| `first_seen_run_id` / `last_seen_run_id` | `uuid` NOT NULL, **composite** FK `source_runs (id, source, source_environment)` ON DELETE RESTRICT | see below. |
| `resolution_state` | `text` NOT NULL default `'unresolved'` | §8 / Coverage Engine (§22). |
| `resolution_reason` | `text` NULL | required when the state is a final exclusion; §8. |
| `observation_count` | `integer` NOT NULL default 0 | |
| `matched_hotel_id` | `uuid` NULL FK `hotels` ON DELETE RESTRICT | the durable answer to "matched to WHAT?" — a **canonical hotel**, and only that; §8.2. |
| `promoted_hotel_id` | `uuid` NULL, **composite** FK `hotel_source_identities (source_property_identity_id, hotel_id)` ON DELETE RESTRICT | which canonical row **this identity's own** resolution produced. Written by a future promotion apply step; §8.1. No direct FK to `hotels`: the composite one is stronger and requiring both would be duplicate truth. |
| `created_at` / `updated_at` | `timestamptz` | |

**Uniqueness — the core invariant:**

```sql
unique (source, source_environment, source_property_id)
```

Provider id uniqueness is scoped **within its namespace and environment**. The
same `12345` in Hotelbeds evaluation and Hotelbeds production are different
identities, and must be, or an evaluation record could silently satisfy a
production precondition.

**Run provenance is composite, not id-only:**

```sql
constraint source_property_identities_first_run_fk
  foreign key (first_seen_run_id, source, source_environment)
  references public.source_runs (id, source, source_environment) on delete restrict,
constraint source_property_identities_last_run_fk
  foreign key (last_seen_run_id, source, source_environment)
  references public.source_runs (id, source, source_environment) on delete restrict
```

A plain `first_seen_run_id → source_runs(id)` would let a *Hotelbeds evaluation*
identity name a *Nuitee production* run as the run that saw it: both rows exist,
so the FK passes, and the provenance is silently wrong while nothing looks
broken. Including `source` and `source_environment` in the key makes that
combination unrepresentable rather than merely wrong (§18.4).

Two further redundant unique keys exist for the same reason —
`unique (id, source, source_environment)` and
`unique (id, source, source_environment, source_property_id)` — so observations
(§5.3) and the canonical link (§5.5) can reference the identity's own source,
environment and provider id instead of trusting the writer's copy of them.

Indexes: the unique keys, plus `(resolution_state)` and `(last_seen_run_id)`.

**Why not `import_rows`?** An import row is immutable, belongs to exactly one
batch, and dies with it. A source identity is mutable (last seen, resolution
state), belongs to no run in particular, and must outlive every run.

### 5.3 `source_property_observations` — one snapshot per run

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `source_run_id` | `uuid` NOT NULL, **composite** FK `source_runs (id, source, source_environment)` **ON DELETE RESTRICT** | |
| `source_property_identity_id` | `uuid` NOT NULL, **composite** FK identities `(id, source, source_environment)` **ON DELETE RESTRICT** | |
| `source` / `source_environment` | `text` NOT NULL | denormalised **so both parents can be keyed on them**; see below. |
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

**Provenance alignment:**

```sql
constraint source_property_observations_run_fk
  foreign key (source_run_id, source, source_environment)
  references public.source_runs (id, source, source_environment) on delete restrict,
constraint source_property_observations_identity_fk
  foreign key (source_property_identity_id, source, source_environment)
  references public.source_property_identities (id, source, source_environment) on delete restrict
```

With id-only FKs, a **production** run could carry an observation of an
**evaluation** identity: each row exists, each FK passes, and the environment of
the evidence is quietly lost. Keying both parents on the same denormalised
`(source, source_environment)` pair makes the two agree by construction — the
observation cannot be inserted at all unless its run and its identity are the
same provider in the same environment (§18.4).

**Append-only:** see §9. Observations are never updated or deleted, and that is
enforced by privileges *and* a trigger, not by convention.

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

`source_classification_evidence_kind` is constrained to **exactly one value**,
`provider_classification_evidence`:

```sql
source_classification_evidence_kind text not null
  default 'provider_classification_evidence'
  check (source_classification_evidence_kind = 'provider_classification_evidence')
```

An earlier draft allowed `canonical_classification_evidence` as a second
permitted value, documented as "no source may write it without a product
decision". That is a rule with no mechanism: nothing in the row said which source
may speak canonically, so an ingestion script could have written `hotelbeds` +
`canonical_classification_evidence` and Postgres would have accepted it. At this
layer a source observation is **source evidence, always** — a provider cannot
promote itself to star authority.

D066 does **not** weaken this. It says a single approved provider is *sufficient
input* for resolution; it does not say the provider's own row may declare the
outcome. The approving artefact is a reviewed policy of ours
([`PROPERTY_SOURCE_CLASSIFICATION_POLICY.md`](PROPERTY_SOURCE_CLASSIFICATION_POLICY.md)),
applied by the resolver — so this CHECK stays exactly as narrow as it was, and is
now *more* load-bearing rather than less.

The judgement *"this observation is sufficient canonical star provenance"*
belongs to the pre-publication star-resolution layer (§21), together with the
resolved value, the conflict state, the reviewed policy version and who resolved
it (plus an OPTIONAL issuing authority, which D066 makes corroboration rather
than a precondition).
Widening this CHECK is a product decision, not an ingestion convenience.
Hotelbeds remains provider classification evidence
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
| `source` / `source_environment` | `text` NOT NULL | denormalised so the identity and the run can be required to agree; see below. |
| `source_run_id` | `uuid` NULL, **composite** FK runs `(id, source, source_environment)` ON DELETE RESTRICT | which run generated it. NULL means "not produced by a run" — a reviewer's own finding. |
| `candidate_kind` | `text` NOT NULL default `'new_property'` | `canonical_hotel` \| `source_identity` \| `new_property` — **what this candidate points at**, stated rather than inferred; §5.4.1. |
| `candidate_hotel_id` | `uuid` NULL FK `hotels` ON DELETE CASCADE | set iff `candidate_kind = 'canonical_hotel'`. |
| `candidate_source_property_identity_id` | `uuid` NULL FK identities ON DELETE CASCADE | set iff `candidate_kind = 'source_identity'`; §5.4.1. |
| `name_evidence` | `text` NOT NULL default `'none'` | `exact` \| `token_containment` \| `none` — **one dimension, two strengths**. |
| `domain_evidence` / `address_evidence` / `phone_evidence` / `brand_evidence` | `text` NOT NULL default `'unavailable'` | `agrees` \| `differs` \| `unavailable`. |
| `coordinate_distance_metres` | `numeric` NULL | raw distance. **No threshold is stored.** |
| `known_source_mapping` | `boolean` NOT NULL default false | a previously confirmed identity link. |
| `agreeing_dimensions` | `integer` NOT NULL **GENERATED ALWAYS … STORED** | count of independent dimensions in agreement, derived from the columns above; §5.4.2. Callers never write it. |
| `match_method` | `text` NOT NULL | human-readable, e.g. `name_exact+domain_agrees`. |
| `status` | `text` NOT NULL default `'pending'` | `pending` \| `accepted` \| `rejected` \| `superseded`. |
| `review_note` | `text` NULL | |
| `created_at` / `resolved_at` | `timestamptz` | |

Indexes: `(source_property_identity_id, status)`, `(candidate_hotel_id)`,
`(candidate_source_property_identity_id)`.

#### 5.4.1 Three target kinds, and why NULL is not one of them

The coverage universe is multi-source: Hotelbeds ∪ Nuitee ∪ research ∪ other
approved sources. Hotelbeds `H123` and Nuitee `N456` can be the same physical
hotel **long before either has a row in `hotels`**. If the only expressible
targets were "a canonical hotel" and "NULL", de-duplicating them would require
publishing one provider first — exactly the coupling a source-agnostic
architecture exists to avoid.

So a candidate names its target kind explicitly:

| `candidate_kind` | Target | Meaning |
|---|---|---|
| `canonical_hotel` | `candidate_hotel_id` | this source property may be an existing published hotel |
| `source_identity` | `candidate_source_property_identity_id` | this source property may be the **same physical property** as another source's identity, published or not |
| `new_property` | neither | "we looked and found nothing" — an explicit finding, not an absence of one |

```sql
constraint source_match_candidates_target_shape check (
  (candidate_kind = 'canonical_hotel'
     and candidate_hotel_id is not null and candidate_source_property_identity_id is null)
  or (candidate_kind = 'source_identity'
     and candidate_source_property_identity_id is not null and candidate_hotel_id is null)
  or (candidate_kind = 'new_property'
     and candidate_hotel_id is null and candidate_source_property_identity_id is null)
),
constraint source_match_candidates_no_self_match check (
  candidate_source_property_identity_id is null
  or candidate_source_property_identity_id <> source_property_identity_id
)
```

NULL is therefore never overloaded: a `new_property` finding and a
`canonical_hotel` candidate whose target was not written are different rows, and
only one of them is storable.

A source↔source candidate is **evidence, not a resolution**. Accepting one does
not terminally resolve either identity — see §8.2 for why that distinction is
what stops coverage closing on a cycle.

#### 5.4.2 `agreeing_dimensions` is derived, not asserted

```sql
agreeing_dimensions integer not null generated always as (
    (case when name_evidence <> 'none'      then 1 else 0 end)
  + (case when domain_evidence  = 'agrees'  then 1 else 0 end)
  + (case when address_evidence = 'agrees'  then 1 else 0 end)
  + (case when phone_evidence   = 'agrees'  then 1 else 0 end)
  + (case when brand_evidence   = 'agrees'  then 1 else 0 end)
  + (case when known_source_mapping         then 1 else 0 end)
) stored
```

Stored beside the evidence it summarises, a writer-supplied count is duplicate
truth: nothing stopped a row recording `name=exact, domain=agrees,
address=agrees` alongside `agreeing_dimensions = 0`, and the two would drift the
first time a caller updated one and forgot the other. Deriving it means the
summary cannot contradict its own inputs, and cannot go stale when evidence is
corrected.

`coordinate_distance_metres` is deliberately **not** counted. There is no
approved distance threshold (D063 §12.2), and counting proximity would be
inventing one here. The `0..6` bound is now structural rather than a CHECK.

**`unavailable` is not `differs`.** "Neither side supplied an address" is not
evidence against a match, and collapsing the two would turn missing data into a
negative finding.

**No numeric confidence column and no threshold** (D063 §12.2, locked invariant
H). `agreeing_dimensions` counts *independent* dimensions — a name agreement is
one dimension whatever its strength, which is the bug the pilot comparison had to
have fixed.

**The count describes the evidence; it does not decide the match.** No number of
agreeing dimensions automatically produces a match, and no number is required for
one — see §10.1.

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
| `source_property_identity_id` | `uuid` NOT NULL, **composite** FK identities `(id, source, source_environment, source_property_id)` ON DELETE RESTRICT | |
| `source` / `source_environment` / `source_property_id` | `text` NOT NULL | denormalised for auditability if a provider is dropped — and **constrained by the composite FK to equal the referenced identity's own values**. |
| `link_status` | `text` NOT NULL default `'active'` | `active` \| `superseded` \| `rejected`. |
| `match_method` | `text` NOT NULL | how the link was established. |
| `match_evidence` | `jsonb` NOT NULL default `'{}'` | the evidence matrix at decision time. |
| `linked_by_user_id` | `uuid` NULL FK `users` | |
| `linked_at` | `timestamptz` NOT NULL | |
| `first_seen_at` / `last_seen_at` / `last_synced_at` | `timestamptz` | §11.1 semantics. |
| `created_at` / `updated_at` | `timestamptz` | |

**Three constraints carry the D063 invariants:**

```sql
-- One ACTIVE source identity maps to at most ONE canonical hotel.
create unique index hotel_source_identities_active_identity_uidx
  on public.hotel_source_identities (source_property_identity_id)
  where link_status = 'active';

-- The denormalised labels ARE the identity's own values, not the writer's
-- assertion about them.
constraint hotel_source_identities_identity_fk
  foreign key (source_property_identity_id, source, source_environment, source_property_id)
  references public.source_property_identities (id, source, source_environment, source_property_id)
  on delete restrict,

-- Evaluation data can never become canonical evidence (§18).
constraint hotel_source_identities_production_only
  check (source_environment = 'production')
```

The composite FK is what makes the CHECK mean anything. On its own the CHECK
reads a column *this row* supplies, so a link could point at an **evaluation**
identity while writing `source_environment = 'production'`; the CHECK would read
the label, pass, and test-environment data would sit against a canonical hotel —
detectable in a join afterwards, but only by a report someone remembers to run.
With the composite key the label must be the identity's own, so an evaluation
identity is not merely *auditable* but **unlinkable**: the INSERT fails. The same
key rejects a link that misstates the identity's `source` or `source_property_id`
(§18.2).

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
| `source_property_identity_id` | `uuid` NOT NULL **UNIQUE**, **composite** FK identities `(id, source, source_environment)` ON DELETE CASCADE | one live decision per identity. |
| `source` / `source_environment` | `text` NOT NULL | denormalised so the cited run can be required to match the identity. |
| `decision` | `text` NOT NULL | `approve_create` \| `approve_match` \| `reject` \| `defer` — **identical vocabulary to `import_property_reviews`**. |
| `target_hotel_id` | `uuid` NULL FK `hotels` | |
| `destination_id` | `uuid` NULL FK `destinations` | |
| `reviewer_user_id` | `uuid` NULL FK `users` | |
| `reviewer_label` | `text` NOT NULL | |
| `review_note` | `text` NULL | |
| `decided_in_run_id` | `uuid` NULL, **composite** FK `source_runs (id, source, source_environment)` ON DELETE RESTRICT | which run's evidence the decision was made against; §18.5. |
| `reviewed_at` / `created_at` / `updated_at` | `timestamptz` | |

Decision shape is constrained exactly as `import_property_reviews` is:

```sql
check (
  (decision = 'approve_create' and target_hotel_id is null and destination_id is not null)
  or (decision = 'approve_match' and target_hotel_id is not null)
  or (decision in ('reject', 'defer') and target_hotel_id is null)
)
```

See §6 for why each of the six exists rather than reusing its nearest neighbour.

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
- exhaustion semantics are §7.1;
- `coverage_risks` is append-only by convention and never emptied to make a run
  look clean;
- **a run is never deleted to hide a bad extraction.** Observations and
  identities FK it `ON DELETE RESTRICT`.

### 7.1 Exhaustion is about ENUMERATION, not about coverage

These are two different questions, and PR #21 established that conflating them
reports a correct extraction as a failure:

| Question | Column |
|---|---|
| Did the walk consume every page? | `pagination_walk_completed` |
| Did we read **every record the provider offers for this geography**? | `provider_enumeration_exhaustion_proven` |
| Is this **destination's coverage** settled? | not a run-level fact at all — see §22 |

```sql
constraint source_runs_exhaustion_requires_walk check (
  provider_enumeration_exhaustion_proven = false
  or (pagination_walk_completed = true and cardinality(enumeration_risks) = 0)
)
```

Only `enumeration_risks` block exhaustion, because only they make the
enumeration itself unprovable: a cursor loop, a provider total that disagrees
with the rows returned, a budget stop mid-walk.

`coverage_risks` deliberately do **not**. Hotelbeds BAI can be exhaustively
enumerated while a second source is still pending for the coverage UNIVERSE — those are facts about what the enumerated set *means*, and
making them falsify the walk would leave no way to state the true sentence "we
read everything this provider has, and coverage is still open". They are
recorded on the run, never emptied, and answered by the Coverage Engine layer,
not by the extractor.

An earlier draft of this section described exhaustion as "walk completed AND zero
coverage risks", which the database never enforced. The vocabulary is now split
so the sentence and the constraint say the same thing.

## 8. Source-identity lifecycle

```
first observation ──> unresolved ──────────────────────────────┐
                        │                                      │
                        │   (pre-publication investigation,    │  stays unresolved
                        │    star/location resolution, review, │  throughout
                        │    D062 preview, human approval)     │
                        │                                      │
                        ├──> resolved_eligible      A. canonical eligible V1 property
                        │                              — ONLY once promotion has
                        │                                actually published a row
                        ├──> duplicate_matched      B. matched, WITH a durable target
                        └──> final_exclusion        C. out of V1 scope, durable reason
```

These are exactly D061 §15.1's three terminal states, plus the hold state. An
identity stays `unresolved` for the whole of pre-publication investigation —
that is the state's job, and it is what keeps the candidate inside the
coverage-critical count.

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

The *structural* requirement on `duplicate_matched` is a canonical target
(§8.2) — **not** a signal count. There is no minimum number of agreeing
dimensions, in the schema or in this document: D063 §12.2 refuses a universal
entity-resolution threshold, and a count is not an exception to that merely
because it is an integer rather than a score. §10.1 says what the evidence is
for.

### 8.1 `resolved_eligible` means THIS identity published THAT hotel

D061 §15.1 A is *canonical eligible V1 property*, and under D062 §7.0 a canonical
property **is** a published row in `hotels`. So the label cannot be a judgement
somebody types. Four mechanisms, each answering a different way of faking it:

```sql
-- 1. It must name a promoted hotel at all.
constraint source_property_identities_eligible_requires_promotion check (
  resolution_state <> 'resolved_eligible' or promoted_hotel_id is not null
),
-- 2. Evaluation data can never be eligible, for the same reason it can never
--    be linked (§18).
constraint source_property_identities_eligible_is_production check (
  resolution_state <> 'resolved_eligible' or source_environment = 'production'
),
-- 3. The named hotel must be THIS identity's own canonical link, not any row
--    in `hotels` that happens to exist.
constraint source_property_identities_promotion_link_fk
  foreign key (id, promoted_hotel_id)
  references public.hotel_source_identities (source_property_identity_id, hotel_id)
  on delete restrict
-- 4. ...and that link must be ACTIVE — trigger
--    enforce_eligible_requires_active_link(), plus
--    forbid_demoting_promoted_link() in the other direction.
```

Constraint 1 alone was the first draft, and it was not enough: **any** existing
hotel id satisfied it, so the state proved only that some canonical property
existed somewhere — not that this identity produced it, was promoted, or passed
D062. Constraint 3 makes those the same fact by keying the pair against the
canonical link. A `rejected` or `superseded` link says "this identity does *not*
correspond to that hotel", which the FK cannot see and the trigger does.

`MATCH SIMPLE` (the default) means constraint 3 is satisfied whenever
`promoted_hotel_id` is NULL, so an unresolved identity is unaffected.

**This does not recreate the pre-publication cycle §21.1 removed.** Nothing here
is required before the gate; it constrains only the terminal state after it. The
expected apply transaction is:

```
begin
  D062 preview has passed, a human has approved
  insert into hotels                       ← publication
  insert into hotel_source_identities      ← the canonical link
  update  source_property_identities set resolution_state = 'resolved_eligible',
                                         promoted_hotel_id = <the new hotel>
commit
```

One transaction, published atomically — which is why it is not a canonical draft
tier. Nothing is visible to a creator mid-sequence because nothing is committed
mid-sequence.

### 8.2 `duplicate_matched` means matched to a CANONICAL property

```sql
constraint source_property_identities_duplicate_target check (
  resolution_state <> 'duplicate_matched' or matched_hotel_id is not null
),
constraint source_property_identities_match_target_scope check (
  resolution_state = 'duplicate_matched' or matched_hotel_id is null
)
```

A terminal duplicate state with no durable target is an unauditable claim: the
candidate leaves the coverage-critical count and nothing records what absorbed
it.

The target must be a **canonical hotel**. An earlier draft also allowed another
source identity, which was wrong in a way worth stating plainly: it lets coverage
close on a cycle. If A is `duplicate_matched` to B and B is `duplicate_matched`
to A — or A → B → C → A — then no identity is `unresolved`, the
coverage-critical count reads zero, and **no published property exists
anywhere**. D061 §15.1 B is literally "duplicate/matched to an existing canonical
property", and taking it literally is what makes the count mean something.

Source-to-source equivalence is not lost; it was never a terminal state. It lives
in `source_match_candidates` with `candidate_kind = 'source_identity'` (§5.4.1),
where it is durable, reviewable, and correctly *pre-publication*: recognising
that Hotelbeds H123 and Nuitee N456 are the same hotel is evidence, and the
property still has to be published before anything is resolved.

So the V1 rule is:

| | |
|---|---|
| source↔source **candidate** | pre-publication entity-resolution evidence — `pending` / `accepted` / `rejected` / `superseded` |
| identity `duplicate_matched` | terminal D061 state, requires `matched_hotel_id` |

No graph-root or entity-cluster machinery is introduced to bridge them; that is a
later question, and the cycle is avoided by not opening it here.

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

### 9.1 Observations are APPEND-ONLY, and the database enforces it

A future canonical star or coordinate will cite `source_property_observations.id`
as its provenance (§21). If the cited row can later be edited or deleted, that
provenance is a promise the database does not keep — and `ON DELETE RESTRICT` on
the observation's **parents** does not protect the observation itself: it stops
the run being deleted, not the row.

Two layers, deliberately:

1. **Privileges.** Neither `authenticated` nor `service_role` holds UPDATE or
   DELETE on this table. The grant is `select, insert` only — the one place in
   the schema where the trusted role is deliberately not `all`, because the
   invariant exists to keep evidence citable and a trusted caller can break it
   just as thoroughly as an untrusted one.
2. **Triggers.** `forbid_observation_mutation()` fires `before update` and
   `before delete` and raises unconditionally, so the refusal holds for the table
   owner and survives a future migration that grants ALL to some role for
   convenience.

| Operation | Allowed |
|---|---|
| INSERT (admin/editor, service_role) | yes |
| SELECT (admin/editor, service_role) | yes |
| UPDATE | **no — trigger + no privilege** |
| DELETE | **no — trigger + no privilege** |

A corrected or later fact is recorded as a **new observation in a new run**,
which is what the model was for. `source_payload_uri` and `source_payload_digest`
are written at insert or left NULL; there is no post-insert attachment path and
no narrow update exception, because every such exception is a column somebody
later argues should also be updatable.

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

`agreeing_dimensions` is **generated** from the columns above (§5.4.2), so a
reviewer sees the count without recomputing it and without the count being able
to contradict the evidence.

### 10.1 The count is a summary, not a rule

No universal threshold is stored anywhere, and none is implied. An earlier draft
of this document claimed that `duplicate_matched` required "two or more
independent agreeing dimensions" and that a name alone "can never auto-merge".
Both sentences invented exactly the thing D063 §12.2 refuses — a universal
entity-resolution threshold — and an integer is no less invented than a score.
There is no such constraint in the schema, and there must not be one.

Why a count cannot be the decision:

- **one strong dimension can outweigh three weak ones.** A confirmed,
  authoritative `known_source_mapping` — a link a human already established — is
  not the same evidence as three circumstantial agreements between two records
  that happen to share a city;
- **the dimensions are not interchangeable.** `address = agrees` between two
  large resorts on the same road, plus a brand code both inherit from the same
  chain, plus a switchboard phone number, is three dimensions and very little
  information;
- **a threshold would be applied by whatever code reads it**, which is how a
  documented "floor" becomes an automatic merge nobody approved.

So what the schema does is store the evidence and refuse to grade it. What
decides a match is the **future resolution/review layer**, on the standing D063
principle that a false merge is strategically worse than a temporarily retained
duplicate — a duplicate is visible and fixable; a merge silently attributes one
hotel's outreach history to another.

The only structural rule about `duplicate_matched` is that it must name a
canonical hotel (§8.2), which is a statement about *what a terminal state means*,
not about how much evidence is enough.

> The `strong_multi_signal` classification in the Hotelbeds evaluation
> (`docs/evaluations/PROPERTY_SOURCE_BAKEOFF_BALI_DUBAI_2026-08.md` §9) is a
> **reporting bucket for that evaluation's own comparison**, not a canonical
> matching rule, and is unaffected by any of this.

The same evidence matrix serves all three target kinds (§5.4.1). A
source↔source comparison uses exactly the columns a source↔canonical comparison
does — name, domain, address, phone, brand, coordinate distance — so
cross-provider de-duplication needs no second vocabulary and no publication step
first:

```sql
-- "Which Nuitee identity might be the same physical property as this
--  Hotelbeds one?" — answerable before either has a row in `hotels`.
select c.candidate_source_property_identity_id, c.agreeing_dimensions, c.match_method
from public.source_match_candidates c
where c.source_property_identity_id = $1
  and c.candidate_kind = 'source_identity'
  and c.status = 'pending';
```

## 11. Canonical source-identity mapping

Answers "which Hotelbeds property corresponds to this canonical hotel?" in one
join:

```sql
select h.id, h.name, si.source, si.source_property_id
from public.hotels h
join public.hotel_source_identities si on si.hotel_id = h.id
where si.link_status = 'active' and si.source = 'hotelbeds';
```

Invariants, all enforced in the database:

- **one active source identity → at most one canonical hotel** (partial unique
  index);
- **one canonical hotel → many source identities** (no constraint prevents it,
  by design);
- **the link's source, environment and provider id are the identity's own**
  (composite FK), so a link cannot misdescribe what it points at;
- **evaluation data is unlinkable** (composite FK + production-only CHECK, §18);
- **one row per (identity, hotel) pair**, so an identity's `promoted_hotel_id`
  can key against the pair (§8.1). Re-linking an identity to a hotel it was
  previously linked to reactivates that row rather than inserting a second one;
  linking it to a different hotel is unaffected.

### 11.1 Deleting a canonical hotel

`hotel_source_identities.hotel_id` is `ON DELETE CASCADE` from `hotels`, but
after §8.1 that cascade cannot fire for a promoted identity: the link row is
itself referenced `ON DELETE RESTRICT` by `source_property_identities
(id, promoted_hotel_id)`, so deleting the hotel fails rather than quietly
removing the link. **A hotel that a source identity was promoted into cannot be
deleted while that identity says so.**

For a hotel with only non-promoted links (an `approve_match` link, or a
superseded one), the cascade still applies and the link rows go with the hotel.
That is consistent with every other child of `hotels` in the schema.

> **FLAGGED, non-blocking:** the repo has **no product contract for deleting a
> published canonical hotel** — not in `HOTEL_DATA_CONTRACT.md`,
> `CANONICAL_PROMOTION_SPEC.md` or D062, and no code path issues such a delete.
> This block deliberately does not invent one. Whether a published property is
> ever hard-deleted (versus closed, excluded or superseded) is a **canonical
> hotel lifecycle question for a later block**, and the answer should decide
> whether that residual cascade is right — not this migration.

## 12. RLS / ACL model

Identical to the existing import infrastructure, and stated explicitly per D046:

- RLS enabled on all six new tables;
- one `for all using (is_admin_or_editor()) with check (is_admin_or_editor())`
  policy per table;
- `grant select, insert, update, delete … to authenticated` on five of them — a
  capability grant; RLS reduces a regular creator to zero rows;
- `grant all … to service_role` on the same five;
- **`source_property_observations` is the exception: `select, insert` only, for
  both roles** (§9.1). Append-only is a privilege fact, not only a trigger fact;
- **no `anon` grant of any kind**;
- migration `0024`'s `alter default privileges` already revokes client
  privileges on future tables, so the grants above are the entire client surface.

The ACL matrix test (`tests/rls/acl-matrix.test.ts`) is extended with the six new
relations, so a future table that forgets its grants fails the suite.

## 13. Idempotency semantics

| Level | Mechanism |
|---|---|
| identity | `unique (source, source_environment, source_property_id)` — re-running never forks an identity |
| observation | `unique (source_run_id, source_property_identity_id)` — a run cannot double-observe. There is no upsert path: the table is append-only (§9.1), so a re-observation is a new run's row |
| canonical link | partial unique on `(source_property_identity_id) where link_status='active'` |
| review | `unique (source_property_identity_id)` |

Re-running an extraction is therefore **safe and additive**: new run row, new
observations, same identities, existing reviews and links untouched.

## 14–17. (Covered above)

§14 source-run semantics → §7 · §15 source-identity semantics → §8 ·
§16 source-observation semantics → §9 · §17 entity-resolution semantics → §10.

## 18. Evaluation vs production isolation

Four independent mechanisms, because one would be a single point of failure:

**18.1 Identity separation.** `source_environment` participates in the identity
unique key, so an evaluation record and a production record with the same
provider id are different rows. An evaluation identity can never be mistaken for
its production counterpart.

**18.2 Link prohibition — enforced against the IDENTITY, not against a label.**
`hotel_source_identities` CHECKs `source_environment = 'production'`, and the
composite FK (§5.5) forces that column to be the referenced identity's own
value. So the prohibition is not "a link must claim production" but "the linked
identity must *be* production". Three separate lies are rejected at INSERT:

| Attempt | Result |
|---|---|
| link an evaluation identity, labelled honestly | CHECK `production_only` fails |
| link an evaluation identity, labelled `production` | **composite FK fails** |
| link a production identity, misstating its `source` or `source_property_id` | **composite FK fails** |

The middle row is the one that matters. Before the composite key existed, that
insert succeeded and the mismatch was merely *detectable* by a join someone had
to think to run — which is not an invariant, it is a report.

**18.3 Eligibility prohibition.** An evaluation identity can never reach
`resolved_eligible` either (§8.1), so it cannot be counted as covered inventory
even in the absence of a link.

**18.4 Provenance alignment.** Every observation carries its run and its
identity, and the composite FKs (§5.2, §5.3) require all three to agree on
`source` and `source_environment`. A production run cannot carry an observation
of an evaluation identity, and an identity cannot name a run from another
provider or another environment as the run that saw it. The environment of any
piece of evidence is therefore not merely recoverable — it is impossible to
lose.

**18.5 Every run reference is provenance, so every one is aligned.** The same
composite rule covers `source_match_candidates.source_run_id` and
`source_property_reviews.decided_in_run_id`. Left as plain id references they
would have allowed a Hotelbeds identity to claim its candidate was generated by
an unrelated Nuitee run, or its review decided against a production run it never
appeared in — a citation that reads as evidence and is not, which is worse than
no citation at all. Both are nullable (`MATCH SIMPLE`), so "not produced by a
run" and "decided outside a run" stay expressible; what is no longer expressible
is a *false* run.

Both are `ON DELETE RESTRICT` rather than `SET NULL`. A run is already
undeletable while observations cite it, so RESTRICT states what was true anyway
— and `SET NULL` on a composite key would try to null the NOT NULL `source`
columns along with the run id.

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

## 21. D062 pre-publication preview interface

The read-only gate preview is implemented by A04 under
`scripts/prepublication-preview/`. It composes existing pre-publication evidence
without writing publication, canonical, review, resolution, candidate, or
lifecycle state. Human authorization and atomic apply remain A05.

### 21.0 Preview inputs are not apply outputs

Everything the preview reads must be able to **exist before publication**. That
sounds obvious and is the exact thing an earlier draft of the table below got
wrong twice, in both cases by listing an artifact that only exists *after* the
gate has already been passed:

| PREVIEW INPUTS — exist before anything is published | APPLY OUTPUTS — created by the transaction the preview authorises |
|---|---|
| `source_property_observations` (typed source facts) | the row in `hotels` |
| `source_property_reviews` (the reviewer's decision + its target) | the `hotel_source_identities` link |
| `source_match_candidates` (entity-resolution evidence and status) | `source_property_identities.promoted_hotel_id` |
| `source_property_star_resolution_revisions` + its head pointer (0028) | the terminal `resolution_state` |
| `source_property_location_resolution_revisions` + its head pointer (0028) | |
| `destinations` / `destination_aliases` | |

An apply output used as a preview input is circular by construction: it makes the
gate require the thing the gate produces. Both corrections below are instances of
that one mistake, so the table is now audited against this rule rather than
against intuition.

A future promotion preview must answer, per candidate, from **pre-publication
evidence only**:

| D062 condition | Where the evidence comes from (all pre-publication) |
|---|---|
| 1. canonical identity resolved | `source_property_reviews.decision` + `source_match_candidates` — see §21.2. **Not** `hotel_source_identities`, which is an apply output |
| 2. supported destination | `source_property_reviews.destination_id` → `destinations` |
| 3. physical hospitality property | `source_property_scope_resolution_revisions` (0029) → `source_property_observations.id`, resolved through the reviewed provider scope policy. **A `physical_hospitality` result is an INPUT, not eligibility** — D060 §21.4 |
| 4. not blocked by current property-level closure evidence | A03's current complete `source_property_issue_snapshots` and `source_property_issue_evidence`, evaluated through the approved lifecycle policy for an explicit `as_of` — see §21.4 |
| 5. V1 scope resolved | A04's **derived pre-publication preview judgement**, composed from conditions 1/2/3/4/6/7/11 without persistence — see §21.3. **Not** `source_property_identities.resolution_state`, which is the post-decision record |
| 6. star exactly 4 or 5 | **not from this layer alone** — §21.1 |
| 7. star provenance | `source_property_star_resolution_revisions` → `source_property_observations.id`, cited as an IMMUTABLE revision id |
| 8/9. canonical lat/long | `source_property_location_resolution_revisions` → `source_property_observations.id` |
| 10. coordinate provenance | same |
| 11. no unresolved conflict | `source_match_candidates.status` |

### 21.1 Pre-publication resolution attaches to the CANDIDATE, not to a hotel

An earlier draft of this section proposed `hotel_star_resolutions.hotel_id →
hotels` and `hotel_location_resolutions.hotel_id → hotels`. **That interface
cannot work**, and the reason is structural rather than cosmetic:

```
D062 requires resolved stars + star provenance + canonical coordinates
+ coordinate provenance BEFORE a row in `hotels` may be created
                    │
                    ▼
but a hotel_id-keyed resolution table needs the hotel row to exist first
                    │
                    ▼
need hotel_id to resolve → need resolution to create hotel_id
```

For `approve_match` it happens to work, because a hotel already exists. For
`approve_create` — the path that actually adds inventory — it is circular. And
the two ways out of the circle are both prohibited: creating a canonical draft
hotel to hang the resolution on would reintroduce the publication tier D062 §7.0
removes, and weakening "promotion = publication" would put unresolved rows in
front of creators.

So resolution attaches to the **pre-canonical entity** — the source property
identity / candidate — and cites exact observations:

Implemented in `0028_prepublication_resolution.sql`, in two layers. The split is
not decoration: D062 will cite a resolution as the evidence that authorised a
publication, so the row it cites must never be rewritten afterwards.

```
source_property_star_resolution_revisions   -- IMMUTABLE, append-only
  id                              uuid
  (source_property_identity_id, source, source_environment)
                                  → source_property_identities (composite)
  (evidence_observation_id, source_property_identity_id)
                                  → source_property_observations (composite)
  (policy_provider, policy_version, policy_field)
                                  → provider_classification_policies
  source_value                    text     -- must equal the cited observation's
  outcome, resolved_star_value             -- must equal what the policy maps
  conflict_state, conflicting_observation_id, conflicting_outcome
  issuing_authority               text NULL   -- OPTIONAL corroboration (D066)
  supersedes_revision_id, resolved_by_user_id, resolved_at
  revision_digest                 generated  -- idempotency key

source_property_star_resolutions            -- HEAD POINTER, one per candidate
  source_property_identity_id     primary key
  (current_revision_id, source_property_identity_id)
                                  → the revision above (composite)

source_property_location_resolution_revisions / _resolutions
                                             -- the same two-layer shape, with
                                             -- verbatim coordinates and a
                                             -- missing/implausible reason
```

`source_property_current_star_resolutions` and its location twin are the read
model: one join from the head, never a replay of history.

The order then runs forwards with no cycle, and **every arrow points one way**:

```
source identity — resolution_state = 'unresolved' throughout this column
  │
  ├─ pre-publication resolutions: star, location, scope, identity/conflict
  │     citing source_property_observations
  │
  ├─ D062 preview — every condition evaluable from the evidence above,
  │     still nothing published, nothing in `hotels`
  │
  ├─ human authorization
  │
  └─ apply, in ONE transaction:
        create the canonical row in `hotels`, or match the approved existing one
        establish the hotel_source_identities link (production only)
        write source_property_identities.promoted_hotel_id
        set the terminal resolution_state                  ← §8.1 becomes true
                                                              only here
  ↓
later: Coverage Engine counts terminal states (§22.2 — not before the
       resolution block owns those transitions)
```

Nothing below the `apply` line is readable above it. That is the whole rule, and
§21.0 is how the condition table is checked against it.

`promoted_hotel_id` is what carries the resolution forward: after apply, a
canonical star's provenance is reachable as
`hotels ← promoted_hotel_id ← identity → star resolution → observation → run`.
For `approve_match`, the same resolution rows attach to the same identity and the
link is established against the existing hotel instead of a new one — one
interface, both decisions.

**Neither table is implemented in the 0027 block.** 0028 builds them, and both
FK `source_property_observations` — which is why observations are `ON DELETE
RESTRICT` and append-only (§9.1): a canonical star that cites an observation must
be able to keep citing it.

**Hotelbeds does not become canonical by being ingested, and 0027 does not make
it so.** Classification is resolved by the star resolver, from the
reviewed provider policy in
[`PROPERTY_SOURCE_CLASSIFICATION_POLICY.md`](PROPERTY_SOURCE_CLASSIFICATION_POLICY.md)
(D066) — one approved provider is sufficient, and `issuing_authority` records an
OPTIONAL corroborating registry rather than a required one.

### 21.2 Condition 1 — identity resolution is expressible before publication

The earlier table cited `hotel_source_identities` as evidence that canonical
identity was resolved. For `approve_match` that is merely redundant; for
`approve_create` it is **backwards**, and `approve_create` is the path that
actually adds inventory:

- there is no new row in `hotels` yet, because creating one *is* publication
  (D062 §7.0);
- therefore there can be no link row, because a link FKs a hotel;
- so requiring the link would mean requiring publication before the gate that
  authorises publication.

The link is an **apply output** — the durable canonical receipt of a decision
already made, and the thing that later answers "which provider property is this
hotel?" (§11). It is not an input.

What identity resolution actually means at preview time depends on the decision:

| Decision | "Canonical identity resolved" means |
|---|---|
| `approve_create` | the entity-resolution result says this candidate is a **distinct new physical property**: its `source_match_candidates` carry no unresolved conflict, and the reviewer recorded `approve_create` rather than a match. No canonical hotel and no link exist yet, and none is expected to |
| `approve_match` | the reviewer identified an existing canonical property, recorded as `source_property_reviews.target_hotel_id` |

Both are readable from tables that exist today, before anything is published.
Note that a `new_property` candidate (§5.4.1) is an explicit finding — "we looked
and found nothing" — which is precisely why it had to be expressible as something
other than a NULL: the `approve_create` path needs to *cite* the search, not the
absence of a row.

### 21.3 Condition 5 — V1 scope is resolved before it is recorded

The earlier table cited `source_property_identities.resolution_state`. §8 says an
identity stays `unresolved` through the whole of pre-publication investigation
and only reaches a terminal state **after** apply — so at preview time that
column reads `unresolved` for every candidate under consideration. Using it as a
precondition means using the terminal state to prove the precondition for
reaching the terminal state.

`resolution_state` is the **post-decision record**, not the evidence. V1 scope
resolution is A04's derived pre-publication preview judgement, computed from the
candidate's own evidence:

- physical-hospitality / property-type resolution (condition 3);
- canonical star resolution and its provenance (conditions 6/7) — the D060 "4 or
  5 exactly" test;
- supported destination (condition 2);
- lifecycle / known-closed evidence (condition 4);
- identity and conflict resolution (conditions 1/11);
- any reviewed exclusion or hold state recorded against the candidate.

That is the same list D061 §9 draws its exclusion vocabulary from, which is the
point: scope is decided from facts about the property, and `resolution_state`
then *records* what was decided. The arrow runs one way.

**No table is added for this.** A04 computes condition 5 in the preview from the
independently evaluated scope-critical conditions. It does not read the overall
preview result and does not persist a second source of truth. Persistence and
human authorization remain A05 concerns.

### 21.4 Conditions 3 and 4 are resolved pre-publication

**Condition 3** is answered by migration 0029: a reviewed per-provider policy on
`accommodationTypeCode`, frozen once approved, resolved into immutable revisions
with a head pointer — the same shape as star and location.

Its result is an INPUT to this gate and **not** V1 eligibility. D060 is explicit
that property type alone does not decide eligibility, so nothing in 0029 says
`eligible` or `publishable`. `physical_hospitality` + 3 stars is not eligible;
`unresolved` + 5 stars is a HOLD, not an exclusion. The conjunction is composed
here, at the preview, and nowhere earlier. Full contract:
[`PROPERTY_SOURCE_HOSPITALITY_SCOPE_POLICY.md`](PROPERTY_SOURCE_HOSPITALITY_SCOPE_POLICY.md).

**Condition 4 is now answered by A03 / migration 0031.** This corrects the
historical state described below; it does not pretend the evidence existed in
0027. The Hotelbeds Content API supplies no property-level lifecycle field, so
A03 preserves complete `issues[]` snapshots and evaluates only an approved exact
pair: `HOTEL + CLOSED` may establish a property-level date interval.

- `license` is a tax/registration number, not a status;
- the `issues[]` array is the only closure-shaped evidence, and it is
  **facility-scoped and date-ranged**, not a property status. Across 4,110
  properties there are 176 issue rows, 13 with `issueType = CLOSED` — and 11 of
  those name a WATERPARK, RESTAURANT, SPA or PARKING, not the property.

Exactly **2** rows carry `issueCode = HOTEL` with `issueType = CLOSED`: one Bali
property closed `2020-04-24 → 2039-12-31`, and one Dubai property closed
`2026-05-31 → 2026-08-31`. That is a genuine lead for condition 4 and it is
recorded here rather than acted on, because:

1. it is not persisted — 0027's ingestion does not map `issues[]`, so no
   observation carries it today;
2. a date range is not a lifecycle status, and a three-month window is a
   temporary closure while a nineteen-year one is not — collapsing them would be
   inventing the very distinction D062 condition 4 needs;
3. `active = true` must never be manufactured from the ABSENCE of a field, and a
   destination name containing `*CLOSED` is a provider geography label, not a
   property lifecycle fact.

The evaluator requires an explicit `as_of`, resolves currentness exclusively by
`source_property_identities.last_seen_run_id` to an observation for that same
identity/run, and never falls back to history. `KNOWN_CLOSED` fails condition 4;
`NO_KNOWN_CLOSURE` passes it but does **not** mean active, open, or operating;
`UNRESOLVED` holds it. Facility codes such as SPA, RESTAURANT, WATERPARK, and
PARKING never close the property. Full semantics and provenance are in
[`PROPERTY_LIFECYCLE_EVIDENCE_CONTRACT.md`](PROPERTY_LIFECYCLE_EVIDENCE_CONTRACT.md).

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

**The closure count cannot be talked into being zero *structurally*.** Each way
out of `unresolved` costs something the database checks: `resolved_eligible`
requires this identity's own active canonical link to the hotel it names (§8.1),
`duplicate_matched` requires an existing canonical hotel (§8.2),
`final_exclusion` requires a durable D061 §9 reason — and "star classification
unknown" is deliberately not one of them. A candidate cannot leave the
coverage-critical count by being relabelled, nor by a ring of identities pointing
at each other.

### 22.1 What 0027 proves, and what it does not

That paragraph is a claim about **structure**, and it is important not to read it
as more. Migration `0027` does not implement star resolution, location
resolution, the D062 preview, apply authorization, or the resolution/promotion
engine. It therefore cannot prove that the D062 conditions were satisfied for any
identity — only that a terminal state is not *structurally* fabricable.

> **Migration 0027 prevents structurally false terminal states and provides the
> integrity boundary the future resolution/promotion engine will use. The future
> D062/resolution block remains responsible for authorizing the semantic
> transition into the terminal states.**

Concretely: the schema guarantees a `resolved_eligible` identity really does hold
its own active canonical link to the hotel it names. It does not guarantee that
the hotel should have been published — that is what the gate is for. No
placeholder D062 columns are added here to blur the difference.

### 22.2 Sequencing — do not build Coverage Engine yet

The closure query above is the intended end state, **not** something to implement
against the current foundation. The order is:

1. `0027` — the state model and its structural invariants. **Done.**
2. The resolution / D062 promotion block — defines and *owns* the authorized
   transitions into `resolved_eligible`, `duplicate_matched` and
   `final_exclusion`, making those states operationally authoritative.
3. **Then** Coverage Engine may count them.

Skipping step 2 is the specific mistake this section exists to prevent: an
engineer reading §22 straight after `0027` could implement the count and treat
"a canonical link exists" as proof that D062 was satisfied. It is not. Until the
resolution block lands, a terminal state means "structurally well-formed", not
"authorized".

Run-level `coverage_risks` (§7.1) belong to this layer too: they are the
destination-level caveats the Coverage Engine must weigh, and they are
deliberately not allowed to falsify a provider walk that genuinely completed.

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
(shipped, PR #23) → star/location resolution tables + resolution runner (shipped,
0028) → scope resolver → D062 gate → Coverage Engine → media.

---

## 25. Product decisions encountered

None that block implementation. For the record:

| Question | Status |
|---|---|
| Star authority hierarchy | **Resolved by D066** — there is no hierarchy to rank. A reviewed per-provider code policy resolves classification; a conflict between two approved providers goes to REVIEW. §5.3.2 still makes it impossible for a source to appoint *itself*, because the policy is ours, not the provider's |
| Object storage product | **Open** — flagged in §19; the relational layer does not depend on it |
| Media storage strategy | **Open** (D064) — §20 keeps ingestion possible without deciding |
| Evaluation data may never link canonically | **Determined** by locked invariant K; implemented as a composite FK **plus** a CHECK (§18.2) |
| Where pre-publication resolution attaches | **Determined**: to the source identity / candidate, never to a `hotel_id` that does not exist yet (§21.1) |
| Source↔source matching before publication | **Determined**: an explicit `candidate_kind` with three targets (§5.4.1), as *evidence* — never a terminal state (§8.2) |
| `resolved_eligible` means this identity published this hotel | **Determined**: composite FK to the identity's own canonical link, plus an active-link trigger (§8.1) |
| Terminal `duplicate_matched` target | **Determined**: a canonical hotel only, so coverage cannot close on a cycle (§8.2) |
| `agreeing_dimensions` | **Determined**: generated from the evidence columns, never writer-supplied (§5.4.2) |
| Deleting a published canonical hotel | **Open, and deliberately not invented here** — no product contract exists; §11.1 records what the schema currently does |
| Observations are append-only | **Determined**: privileges plus triggers (§9.1) |
| Enumeration exhaustion vs coverage | **Determined**: separate columns and separate vocabularies (§7.1) |
| Provider review is a separate table | **Implementation**, justified in §1.3 / §6 |
| Match threshold | **Refused** by D063 §12.2; none stored |
