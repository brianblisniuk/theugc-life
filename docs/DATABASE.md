# theugc.life — DATABASE.md
Version: 1.0
Source of truth: `/docs/PRD.md`
Database: PostgreSQL / Supabase
ID strategy: UUID primary keys. Public slugs are mutable identifiers and MUST NOT be foreign keys.

## 1. Database invariants

1. Hotel records and hotel contacts are separate entities.
2. Commercial payment records and access entitlements are separate entities.
3. `pipeline_items` represent current creator workflow state; `outreach_events` preserve historical facts.
4. Creator-private activity is never read directly by public pages.
5. Creator signals do not directly mutate editorial hotel/contact truth.
6. Intelligence is derived from structured events and can be recalculated.
7. Destinations are hierarchical and are not synonymous with cities.
8. Collaborations are first-class records.
9. Private creator fields are owner-only by default.
10. No primary creator-facing `reports` table exists.
11. Canonical property identity is owned by theugc.life. An external provider's
    property ID is a **source identity attached to** a hotel, never a hotel's
    primary key (D063).
12. Canonical values that a reader could challenge — star classification and
    coordinates above all — carry provenance. A value without provenance is not
    canonical (D060, D062).

## 2. PostgreSQL conventions

- Use `uuid` primary keys with `gen_random_uuid()`.
- Use `timestamptz` for instants; store UTC.
- Use `date` for travel dates that do not require time-of-day.
- Use `citext` or normalized unique indexes for case-insensitive username/email-like uniqueness where appropriate.
- Use database enums only for states that are genuinely stable. Prefer CHECK constraints or reference tables when product iteration is likely.
- Every mutable table has `created_at` and `updated_at` unless explicitly append-only.
- All FK columns are indexed.
- Use soft/status transitions for strategically valuable history rather than destructive deletion.
- `outreach_events` is append-oriented. Corrections should be explicit, auditable operations rather than silent historical rewrites.
- JSONB is allowed only for event-specific metadata. Frequently queried analytics dimensions must become structured columns/tables.

## 3. Auth identity

Supabase `auth.users.id` is the canonical authentication identity.

### public.users
- `id uuid PK` — equals `auth.users.id`
- `email text`
- `role text NOT NULL DEFAULT 'creator'`
- `status text NOT NULL DEFAULT 'active'`
- `timezone text NULL`
- `locale text NULL`
- `last_active_at timestamptz NULL`
- timestamps

Allowed roles: `creator`, `editor`, `admin`; `moderator`, `brand` reserved.
Allowed statuses: `active`, `suspended`, `deleted`.

Create user row/profile through a controlled signup trigger or server action. Never trust client-supplied role.

## 4. Creator domain

### creator_profiles
- `id uuid PK`
- `user_id uuid UNIQUE FK users(id) ON DELETE CASCADE`
- `display_name text`
- `username text UNIQUE`
- `bio text`
- `home_city text`
- `home_country text`
- `profile_photo_url text`
- `primary_language text`
- `languages text[]`
- `creator_niches text[]`
- `content_formats text[]`
- social URL/handle fields
- `portfolio_visibility text`
- `public_profile_enabled boolean DEFAULT false`
- timestamps

### portfolio_assets
- `id uuid PK`
- `creator_id uuid FK creator_profiles(id) ON DELETE CASCADE`
- `type text`
- `storage_path text NULL`
- `external_url text NULL`
- `thumbnail_path text NULL`
- `title text NULL`
- `description text NULL`
- `sort_order integer DEFAULT 0`
- `is_public boolean DEFAULT true`
- timestamps

Constraint: exactly one usable asset source (`storage_path` or `external_url`) where required.
Types: `video`, `image`, `link`, `case_study`.

## 5. Geography and inventory

### destinations
- `id uuid PK`
- `name text NOT NULL`
- `slug text UNIQUE NOT NULL`
- `type text NOT NULL`
- `country_code text`
- `country_name text`
- `parent_destination_id uuid NULL FK destinations(id)`
- `latitude numeric`
- `longitude numeric`
- `bounding_box jsonb NULL`
- `is_sellable boolean DEFAULT false`
- `is_featured boolean DEFAULT false`
- timestamps

Types: `country`, `region`, `island`, `city`, `area`.

Hierarchy rule: an entitlement for a destination may cover descendants. Implement this through a recursive query/helper, not duplicated entitlements.

### brands
- `id uuid PK`
- `name text NOT NULL`
- `slug text UNIQUE NOT NULL`
- `website_url text`
- `logo_url text`
- `parent_brand_id uuid NULL FK brands(id)`
- timestamps

### hotels
- `id uuid PK`
- `name text NOT NULL`
- `slug text UNIQUE NOT NULL`
- `brand_id uuid NULL FK brands(id)`
- `destination_id uuid FK destinations(id)`
- `country_code text`
- `address text`
- `latitude numeric`
- `longitude numeric`
- `website_url text`
- `instagram_url text`
- `hotel_type text`
- `star_rating numeric NULL` — **hospitality star classification**, never a
  guest-review score (D060). V1 publishable inventory is exactly 4 or 5, and the
  value requires provenance to be publishable (D062). The column is unchanged by
  this contract; no migration was added.
- `description_short text`
- `active_status text NOT NULL DEFAULT 'unknown'`
- `editorial_verified_at timestamptz NULL`
- `editorial_verification_status text NOT NULL DEFAULT 'unverified'`
- timestamps

Active: `active`, `temporarily_closed`, `closed`, `unknown`.
Verification: `verified`, `needs_review`, `stale`, `unverified`.

Do not store a permanent boolean `creator_friendly`.

**Conceptual future entities — contract only, none of these exists.** D063 and
D064 define, without creating: `hotel_source_identities` (canonical hotel ↔
provider property id/url/name/address/coordinates/stars/type, first and last
seen, last synced, match method/confidence/status, provenance), a
location-evidence concept retaining source coordinates and their resolution
provenance while `hotels.latitude`/`longitude` stay the resolved canonical
values, `hotel_media` (provenance- and rights-backed media as a child resource,
with cover vs gallery role and official-vs-user-generated flagging), and an
auditable destination coverage run. See
[`PROPERTY_CONTENT_COVERAGE_CONTRACT.md`](PROPERTY_CONTENT_COVERAGE_CONTRACT.md)
§11–§15. **No migration in this contract block.**

### hotel_contacts
- `id uuid PK`
- `hotel_id uuid FK hotels(id)`
- `first_name text`
- `last_name text`
- `job_title text`
- `department text`
- `email text`
- `phone text`
- `linkedin_url text`
- `contact_type text`
- `status text`
- `source_type text`
- `source_reference text NULL`
- `verified_at timestamptz NULL`
- `last_checked_at timestamptz NULL`
- timestamps

Departments: marketing, pr, social_media, communications, partnerships, sales, general, other.
Statuses: active, unverified, stale, invalid, replaced.
Source types: editorial, public_source, creator_signal, hotel_claim.

Never expose this table through unrestricted public selects.

## 5a. Property-content source infrastructure (migration 0027)

Provider-sourced property data enters the controlled pipeline through these six
tables. All are editorial/operational internals: `service_role` + admin/editor
through RLS, **no anon grant**. Full model and rationale:
[`PROPERTY_CONTENT_IMPLEMENTATION_SPEC.md`](PROPERTY_CONTENT_IMPLEMENTATION_SPEC.md).

The rule that shapes all six: **a provider ID is a source identity, never
canonical identity** (D063). `hotels` gains no provider column — there is no
`hotelbeds_id`, `booking_id` or `expedia_id` anywhere in the canonical schema,
and a test asserts it.

### source_runs
One execution of one source. Not `import_batches`: a batch is keyed on a parsed
file; a run has no file and needs exhaustion/coverage/quota evidence instead.
- `id uuid PK`
- `source text NOT NULL` — provider namespace, free text (a new provider must
  not require a migration)
- `source_environment text NOT NULL` — `evaluation` | `production`. **The
  isolation axis.**
- `destination_id uuid NULL FK destinations(id)`
- `provider_geography jsonb`, `run_mode text`, `run_status text`
- `raw_records_seen`, `unique_source_property_ids integer`
- `provider_reported_total integer NULL` — NULL means the provider said nothing;
  never defaulted to 0
- `pagination_walk_completed boolean`,
  `provider_enumeration_exhaustion_proven boolean` — separate, because they fail
  for different reasons
- `enumeration_risks text[]` — risks to the enumeration itself (cursor loop,
  provider total disagreeing with rows returned, budget stop). **These block
  exhaustion.**
- `coverage_risks text[]` — risks about what the enumerated set *means*
  (geography caveats, unresolved star authority, pending second source).
  Recorded, never emptied, and they do **not** falsify a completed walk: "we read
  every record this provider offers" and "this destination's coverage is settled"
  are different questions.
- `request_count`, `cache_hit_count`
- timestamps, `created_by`
- UNIQUE `(id, source, source_environment)` — redundant as a key, present so
  identities and observations can foreign-key a run's **source and
  environment**, not merely its id

CHECKs: enumeration exhaustion requires a completed walk **and** zero
`enumeration_risks`; a run cannot be `running` with a completion time or finished
without one.

### source_property_identities
Durable `(source, source_environment, source_property_id)`, independent of any
canonical hotel. Not `import_rows`: an import row is immutable and dies with its
batch; a source identity must outlive every run.
- `id uuid PK` — our surrogate, never the provider's id
- `source`, `source_environment`, `source_property_id text NOT NULL`
- `first_seen_at`/`last_seen_at`, `first_seen_run_id`/`last_seen_run_id` —
  **composite** FKs to `source_runs (id, source, source_environment)`, so an
  identity cannot name a run from another provider or another environment as the
  run that saw it
- `resolution_state text` — `unresolved` | `resolved_eligible` |
  `duplicate_matched` | `final_exclusion` (D061 §15.1 A/B/C plus the hold state).
  A **post-decision record**, written by the future apply step; it stays
  `unresolved` through investigation, review and the D062 preview, so it is
  never evidence *for* a D062 condition (see
  `PROPERTY_CONTENT_IMPLEMENTATION_SPEC.md` §21.3)
- `resolution_reason text NULL` — required for a final exclusion; the vocabulary
  deliberately has **no** value for "star unresolved" or "identity unresolved",
  which are hold states that keep a candidate inside the coverage-critical count
- `matched_hotel_id` — the durable answer to "matched to WHAT?" for
  `duplicate_matched`. **A canonical hotel only.** Allowing another source
  identity would let coverage close on a cycle (A↔B, or A→B→C→A): nothing
  `unresolved`, and no published property anywhere. Cross-source equivalence
  lives in `source_match_candidates` as pre-publication evidence instead.
- `promoted_hotel_id` — which canonical row this identity's **own** resolution
  produced, written by the future promotion apply step. Composite FK to
  `hotel_source_identities (source_property_identity_id, hotel_id)`, so it cannot
  name a hotel this identity has no canonical link to.

UNIQUE `(source, source_environment, source_property_id)`, plus
`(id, source, source_environment)` and
`(id, source, source_environment, source_property_id)` so observations and the
canonical link can key on the identity's own values.

`resolved_eligible` is gated four ways, because each closes a different way of
faking it: it requires `promoted_hotel_id` (CHECK), a production environment
(CHECK), that the named hotel is **this identity's own** canonical link
(composite FK), and that the link is **active**
(`enforce_eligible_requires_active_link()`, with
`forbid_demoting_promoted_link()` in the other direction). Naming any existing
hotel row is not evidence that this identity was promoted. `duplicate_matched`
requires `matched_hotel_id`; a match target on a non-matched identity is refused.

### source_property_observations
One snapshot per `(run, identity)`. Nothing is overwritten, so a future
canonical star or coordinate can cite which observation supported it.
- typed source fields: name, destination/zone code, address, postal code, city,
  coordinates, website, email, phone (+ `source_phone_type`, so a fax is never
  reported as a contact phone), brand/chain codes, property type code + label
- provider classification: code, label, group, `source_classification_simple_code
  text` — **TEXT deliberately**, because `simpleCode 5` covers 5 STARS, 5 KEYS,
  aparthotel and hostel alike, and a numeric column invites `>= 4`
- `source_classification_evidence_kind` — CHECKed to **exactly one** value,
  `provider_classification_evidence`. No issuing-authority hierarchy exists yet,
  so a source must not be able to label itself canonical star evidence; that
  judgement belongs to the future star-resolution layer
- `source_lifecycle_status text NULL` — only when the provider supplies one
- `source_image_count`, `source_provider_designated_principal_image` — media
  **availability summary only**; no image rows (D064 storage strategy is open)
- `source_attributes jsonb` — bounded to 8 KB by trigger
- `source_payload_digest`, `source_payload_uri` — raw-payload boundary

**No range CHECK on source coordinates.** Invalid provider values are evidence
to audit, not rows to erase; `source_coordinates_plausible` records the verdict.
`hotels.latitude`/`hotels.longitude` remain the resolved canonical values.

UNIQUE `(source_run_id, source_property_identity_id)` — one run observes a
property at most once.

`source`/`source_environment` are carried on the row so **both** parents can be
composite-FK'd on them: the run and the identity must be the same provider in the
same environment, or the observation cannot be inserted at all.

**APPEND-ONLY.** A future canonical star or coordinate cites an observation id as
its provenance, so the row must stay citable. Neither `authenticated` nor
`service_role` holds UPDATE or DELETE (the grant is `select, insert` only), and
`forbid_observation_mutation()` fires `before update`/`before delete` so the
refusal holds for the table owner too and survives a future over-broad grant. A
later fact is a **new observation in a new run**.

### source_match_candidates
Entity-resolution evidence. Not `import_match_candidates`: that requires a NOT
NULL `score`, and D063 §12.2 refuses to invent a confidence number.
- `name_evidence` — `exact` | `token_containment` | `none`: **one dimension with
  two strengths**, never two signals
- `domain_evidence`, `address_evidence`, `phone_evidence`, `brand_evidence` —
  `agrees` | `differs` | `unavailable`. `unavailable` is not `differs`.
- `coordinate_distance_metres numeric NULL` — raw, no threshold stored
- `agreeing_dimensions integer` — **GENERATED ALWAYS … STORED** from the evidence
  columns; independent dimensions only, so a name alone is 1. Derived rather than
  supplied because a hand-written count beside the evidence it summarises is
  duplicate truth and drifts. Coordinate distance is deliberately not counted:
  there is no approved threshold to count it against.
  **It summarises evidence; it does not decide a match.** There is no
  `agreeing_dimensions >= n` constraint anywhere and there must not be one — D063
  §12.2 refuses a universal threshold, and an integer floor would be one. One
  authoritative known source mapping can outweigh three circumstantial
  agreements; the future resolution/review layer weighs it.
- `source` / `source_environment` — denormalised, with composite FKs to both the
  identity and (when present) `source_run_id`, so a candidate cannot cite a run
  from another provider or environment as its provenance
- `candidate_kind text` — `canonical_hotel` | `source_identity` | `new_property`,
  with `candidate_hotel_id` / `candidate_source_property_identity_id` and a shape
  CHECK binding each kind to exactly one target. **Source↔source matching is
  first-class**: two providers can be recognised as the same physical property
  before either is published, so de-duplication never requires publishing one
  provider first. NULL is not overloaded — `new_property` says so by name. A
  source↔source candidate is *evidence*; it never terminally resolves an
  identity (see `matched_hotel_id` above).

### hotel_source_identities
The D063 §11.1 link: canonical hotel ↔ source identity. An **apply output** — the
durable receipt of a promotion already authorised, written in the same
transaction as the `hotels` row. It is never a D062 precondition: for
`approve_create` no hotel exists before the gate, so no link can
(`PROPERTY_CONTENT_IMPLEMENTATION_SPEC.md` §21.2).
- partial UNIQUE on `(source_property_identity_id) WHERE link_status='active'` —
  one active source identity maps to at most one canonical hotel
- **composite FK** on `(source_property_identity_id, source, source_environment,
  source_property_id)` → the identity's own values, so the denormalised labels
  cannot misdescribe what the link points at
- CHECK `source_environment = 'production'` — **evaluation data can never become
  canonical evidence**. The composite FK is what makes this true of the
  *identity* rather than of this row's label: an evaluation identity claiming
  `production` now fails at INSERT rather than being detectable afterwards
- UNIQUE `(source_property_identity_id, hotel_id)` so an identity's
  `promoted_hotel_id` can key against the pair
- a canonical hotel may hold many source identities, by design

**Deleting a hotel** cascades its link rows — except where an identity was
promoted into it, since `promoted_hotel_id` holds the link `ON DELETE RESTRICT`
and the delete therefore fails. The repo has no product contract for deleting a
published canonical hotel and this migration does not invent one; see
`PROPERTY_CONTENT_IMPLEMENTATION_SPEC.md` §11.1.

### source_property_reviews
Durable decision per identity, UNIQUE on the identity. Uses the **same decision
vocabulary** as `import_property_reviews` (`approve_create` | `approve_match` |
`reject` | `defer`), because both pipelines converge on one D062 gate.
`decided_in_run_id` carries the same composite-FK provenance rule as match
candidates: NULL means "decided outside a run", but a run from another provider
or environment cannot be cited.

## 5b. Pre-publication resolution (migration 0028)

Six tables plus two views. Same access posture as 5a: `service_role` +
admin/editor through RLS, **no anon grant**. They turn provider observations into
resolved product facts, attached to the **source property identity** — never to a
`hotel_id`, because under D062 a row in `hotels` is publication and a candidate
has none until after the gate.

### provider_classification_policies / provider_classification_policy_mappings
The reviewed classification policy (D066), as DATA rather than as a property of
one code path.
- `policies` PK `(provider, version)`, plus UNIQUE `(provider, version, field)`
  so mappings and resolutions can key against the field the policy is contracted
  to read.
- `mappings` PK `(provider, version, source_code)`, `outcome` restricted to
  `exact_four | exact_five | classified_not_v1_scope`, with a CHECK tying the
  star value to the outcome.

`unresolved` is deliberately **not** a storable mapping. Absence of a row IS
unresolved; storing it would make "we reviewed this code and it means nothing"
and "we never reviewed this code" the same row. Seeded with the Hotelbeds
`categoryCode` policy v1 (14 codes). A new provider adds rows here and changes no
canonical schema.

**A version has two lives.** While `approved_at` is NULL it is a DRAFT: mappings
are freely writable, and §5's trigger refuses it as the basis of any resolution.
Setting `approved_at` freezes the field and the entire mapping set — update,
delete, and *adding a new code* are all refused by
`forbid_approved_policy_mutation()` / `forbid_approved_policy_mapping_mutation()`,
on both the version a mapping leaves and the one it arrives at.

That is what makes immutable revisions mean anything. A revision reading
`hotelbeds-classification/1` + `5EST` → `exact_five` stays byte-identical while
someone edits that version's mapping to `exact_four`: the row is untouched and
its provenance is now false. D066 says a mapping change is a NEW VERSION; the
freeze makes it the only representable one. The grants stay full because
assembling and approving a *new* version must remain possible — a privilege
cannot tell a draft row from a frozen one, and a trigger can.

### provider_location_policies
The location twin, PK `(provider, version)`, seeded with
`hotelbeds / hotelbeds-location/1`. There is no mapping table because the
location rule has no per-code semantics — coordinates are usable exactly when
both are supplied and the audit found them plausible — so there is nothing to
freeze. What it provides is the same proof the star side had: the version a
revision NAMES was actually reviewed. Without it `hotelbeds-location/999` was
insertable.

### source_property_star_resolution_revisions / _location_resolution_revisions
**IMMUTABLE, append-only.** A future D062 publication cites a revision id as the
evidence that authorised it, so the row must never be rewritten — otherwise a
hotel published in August from `5EST → exact_five` would, after an October
observation of `4EST`, appear to have been authorised by evidence that did not
exist at the time. No client role holds UPDATE or DELETE, and a trigger refuses
both even for the table owner.

Integrity is layered, because each layer catches what the one before cannot:
- composite FK `(evidence_observation_id, source_property_identity_id)` — the
  cited observation provably belongs to THIS candidate;
- composite FK `(id, source, source_environment)` to the identity — provider and
  environment streams cannot cross;
- composite FK `(supersedes_revision_id, source_property_identity_id)` — lineage
  is provenance too, and a pointer into another candidate's history is a false
  statement about both of them; plus a CHECK that a revision is not its own
  ancestor;
- FK `(policy_provider, policy_version, policy_field)` — the policy named exists,
  and a trigger additionally requires it to be APPROVED, not a draft;
- CHECK `policy_provider = source` — a provider's policy applies only to that
  provider's observations;
- `enforce_star_revision_integrity()` — `source_value` equals the cited
  observation's own code, AND the outcome is the one the approved policy maps it
  to, AND a conflict cites an observation that maps under the same policy and
  genuinely disagrees;
- `enforce_location_revision_integrity()` — coordinates copied verbatim,
  resolution refused from missing/implausible evidence, each unresolved reason
  checked against what the evidence actually carries in BOTH directions, and a
  conflict required to have usable coordinates that actually differ.

`source_coordinates_plausible` is nullable, so an unresolved location carries one
of THREE reasons, not two: `coordinates_missing` (at least one absent),
`coordinates_implausible` (both supplied, verdict explicitly FALSE) and
`coordinates_plausibility_unknown` (both supplied, no verdict). UNKNOWN is not
FALSE — reporting an unjudged coordinate as implausible would accuse the provider
of bad data on evidence that says nothing. Each reason is checked against the
cited observation in both directions.

`revision_digest` is `GENERATED ALWAYS ... STORED` over the semantic fields, with
UNIQUE `(source_property_identity_id, revision_digest)`. Re-deriving the same
conclusion from the same evidence under the same policy inserts nothing.

### source_property_star_resolutions / source_property_location_resolutions
**HEAD POINTERS.** `source_property_identity_id` PK, `current_revision_id` with a
composite FK to `(id, source_property_identity_id)` of the revision table — so a
head can only ever name a revision of its own candidate. Exactly one current
resolution per candidate per dimension. The pointer moves; the revisions do not.

### source_property_current_star_resolutions / _current_location_resolutions
Read model: one join from the head, `security_invoker = true` so RLS reaches
through. Not an aggregate over history — reading current state never replays it.

## 5c. Pre-publication physical-hospitality scope (migration 0029)

Four tables plus one view, resolving D062's condition 3 — "it is a physical
hospitality property" — and **nothing else**. Same access posture as 5a/5b:
`service_role` + admin/editor through RLS, **no anon grant**.

**This is not V1 eligibility.** D060 says property type alone does not decide it;
the gate is physical hospitality AND an exact 4/5 classification AND a supported
destination, composed at the future D062 preview. No column here is named
`eligible`, `publishable` or `resolved_eligible`, and a test asserts that.

### provider_hospitality_scope_policies / _policy_mappings
The reviewed scope policy as DATA, `(provider, version)` + a redundant
`(provider, version, field)` for the mappings and revisions to key against.
`outcome` is restricted to `physical_hospitality | not_physical_hospitality` —
`unresolved` is deliberately **not** storable, because absence of a row IS
unresolved and storing it would make an unreviewed type look adjudicated.

Deliberately SEPARATE tables from the classification policy rather than one with
a `dimension` column: a shared outcome domain would have to admit every value of
both, which is exactly how `exact_five` becomes insertable as a scope answer.

Draft/frozen semantics are 0028's, including the reason: an immutable revision
saying `H → physical_hospitality` is worthless if `H` can be remapped inside the
version it cites. `approved_at` NULL = draft, assemblable and not citable; once
set, the field and the whole mapping set are immutable, on both the version a
mapping leaves and the one it arrives at. Seeded with the Hotelbeds
`accommodationTypeCode` policy v1 — 10 codes in scope, 2 out, 12 of the 24-code
master deliberately unmapped
([`PROPERTY_SOURCE_HOSPITALITY_SCOPE_POLICY.md`](PROPERTY_SOURCE_HOSPITALITY_SCOPE_POLICY.md)).

### source_property_scope_resolution_revisions
**IMMUTABLE, append-only**, with the same layered integrity as 0028: composite
FK to `(observation, identity)`, composite FK to `(identity, source,
source_environment)`, composite FK on `(supersedes_revision_id, identity)` plus a
no-self-supersession CHECK, a policy FK, a `policy_provider = source` CHECK, and
a trigger requiring the cited policy to be APPROVED and the outcome to be the one
it maps. `revision_digest` is generated and unique per candidate, so a replay
appends nothing.

### source_property_scope_resolutions / source_property_current_scope_resolutions
Head pointer, composite-FK'd so a head can only name a revision of its own
candidate; and a `security_invoker` read model over it.

## 5d. Entity-resolution evidence (migration 0030)

**No new table.** 0027's `source_match_candidates` already models the candidate
kinds, the evidence vocabulary, the generated `agreeing_dimensions` and the
review status vocabulary, so 0030 adds no new concept — only the minimum
lifecycle column (`superseded_reason`), constraints and indexes that CURRENT
candidate semantics need and application code cannot keep on its own. Full
contract:
[`PROPERTY_ENTITY_RESOLUTION_CONTRACT.md`](PROPERTY_ENTITY_RESOLUTION_CONTRACT.md).

### A candidate pair is ONE row
A CHECK first: for `candidate_kind = 'source_identity'` the left identity must
sort before the right. An index alone is DIRECTIONAL — it stops `A → B` twice but
not `A → B` and `B → A`, which is the same pair recorded as two candidates for a
reviewer to decide twice. Application code orienting pairs is a convention;
a future writer, a Provider B workflow, a manual tool and psql are not bound by
it. UUID ordering carries no meaning of its own, which makes it a safe canonical
form.

Then three partial unique indexes — `(identity, candidate_identity)` for
`source_identity`, `(identity, candidate_hotel_id)` for `canonical_hotel`, and
`(identity)` for `new_property` — which are genuinely unordered because only one
orientation is legal. Without them, re-running discovery over unchanged evidence
inserts a second row per pair; select-then-insert would be a race and a
convention rather than a guarantee.

### `superseded_reason`
Set ONLY by candidate generation, and only to `no_current_blocking_rule`: no
current blocking rule supports this pair any more. A pending candidate is a claim
about CURRENT evidence, but `pending` alone does **not** establish generator
ownership. The generator stands down only its own stale rows:
`candidate_kind = 'source_identity'` AND `status = 'pending'` AND
`match_method like 'blocking:%'`. It deletes nothing, rewrites no evidence, and
reactivates only the same row it previously stood down if the evidence returns. A
manual pending row or human decision is not generator-owned and carries no
machine stand-down authority, which is exactly what stops a script seizing or
overturning one.

Keyed on the PAIR, not the pair plus the reason it surfaced: a pair found by
both a shared domain and a shared phone is one candidate carrying both reasons in
`match_method`, because a reviewer deciding the same pair twice is the duplicated
work this queue exists to prevent.

### `new_property` requires a finding
`candidate_kind` DEFAULTS to `new_property` in 0027, so the constraint
`source_match_candidates_new_property_requires_finding` requires such a row to
carry a `review_note`. The inference it blocks is "the sweep produced no
candidate, therefore this is a new property" — a statement about the RULES read
as a statement about the world, which D062 would later treat as authorisation to
publish. A sweep has no justification to write; a reviewer does.

## 5e. Lifecycle / closure evidence (migration 0031)

The evidence path for D062's condition 4, "the property is not known inactive /
closed". Four tables, all editorial internals with the 0027–0030 posture:
`service_role` plus admin/editor through RLS, **no anon grant**. Full contract:
[`PROPERTY_LIFECYCLE_EVIDENCE_CONTRACT.md`](PROPERTY_LIFECYCLE_EVIDENCE_CONTRACT.md).

### provider_lifecycle_issue_policies / _policy_mappings
The 0028/0029 pattern again: the mapping from a provider's vocabulary to our
semantics is a reviewed product decision, so it is data, and it freezes on
approval. Draft while `approved_at` is NULL; immutable afterwards, both sides —
a mapping can neither leave an approved version nor be inserted into one.

The mapping key is the **PAIR** `(issue_code, issue_type)`, and that is the whole
point. Hotelbeds documents `issues[]` as facility incidences, and in the real
data 13 rows are `CLOSED` while only **2** are `HOTEL` + `CLOSED`; the other
eleven are a water park, a restaurant, a spa and a car park. A rule keyed on
`issue_type` alone would have closed eleven operating hotels. `outcome` has
exactly one legal value, `property_closed_window` — there is deliberately no
"open": no provider issue is evidence that a hotel is operating, and an
unreviewed pair gets no row rather than a row saying it is harmless.

`date_semantics` records the reviewed reading of the interval —
`inclusive_day_interval`, `dateFrom <= as_of <= dateTo` — because "does dateTo
include the last day?" changes real outcomes at a boundary and must not be an
assumption.

### source_property_issue_snapshots
One row per observation whose provider issue list was extracted COMPLETELY,
UNIQUE on `evidence_observation_id`. Its existence IS the completeness claim, and
`provider_issue_count` always equals the number of child rows — an entry the
extractor cannot read produces NO snapshot rather than a complete-looking one
missing a row. The evaluator re-checks that equality independently
(`issue_count_mismatch`), because a hand-written row could create what the
extractor cannot.

`source_payload_digest` and `evidence_source_run_id` are both NOT NULL and both
composite-FK'd to the observation — `(observation, digest)` and
`(observation, run)`. Together they make the binding checkable: "which
observation does this artifact record describe?" is a different question from
"which observation is newest?", and re-extracting an OLD cached artifact after a
NEWER run exists would otherwise move old issue evidence onto a new observation.

The run is required because a digest alone does not name one. Observations are
unique per `(source_run_id, source_property_identity_id)`, **not** per digest, so
two runs that both saw an unchanged property carry identical digests and
`(property, digest)` would select both — picking one by accident of ordering. The
digest proves CONTENT equality; the run names WHICH OBSERVATION. It is derived
with the ingestion pipeline's own `deterministicUuid(runFingerprint(manifest))`,
so it is the id already in the database rather than a second scheme. Identical
records across runs stay valid: `source_payload_digest` is deliberately not
unique.

Without it, zero issue rows would mean either "the provider reported none" or
"nobody extracted this" — evidence and ignorance behind one absence, and an
unextracted property would read as "no known closure". Hotelbeds makes this
concrete: it OMITS the `issues` key entirely rather than sending an empty array,
on 3,936 of 4,110 records, so "the array was empty" is not observable.
`provider_issue_count = 0` is a provider statement; no snapshot at all is
ignorance, and the evaluator returns `unresolved`.

Composite-FK'd to `(observation, identity)` so a snapshot provably describes an
observation of its own property.

### source_property_issue_evidence
The provider's structured fields, verbatim — `issue_code`, `issue_type`,
`date_from_raw`, `date_to_raw`, `provider_order`, `alternative`. Lifecycle is
never inferred from `description`, a hotel name or a destination label, and
provider codes are stored and matched EXACTLY: `"HOTEL "` is not `HOTEL`.

**The date columns are `text`, not `date`.** A `date` column cannot keep the
contract's promise that malformed evidence survives: `2026-02-31` has the shape
of a date and is not one, so the cast rolls the whole extraction back; and
`2026-08-31garbage` would have to be trimmed to fit, inventing a clean date the
provider never sent. The bytes are kept whole and validation belongs to the
evaluator, which distinguishes an ABSENT endpoint from a present-but-unreadable
one and reports them as different reasons. `evidence_digest` is
`GENERATED ALWAYS` over those raw values.

### Currentness
Lifecycle reads the observation belonging to the identity's
`last_seen_run_id` — the pointer ingestion already advances only on a strictly
newer `started_at`. Not "latest by timestamp", and never by UUID: observations
are unique per `(source_run_id, source_property_identity_id)`, not per
`(identity, observed_at)`, so a tie is representable and a UUID tie-breaker would
decide a closure by accident. Joining on the run selects at most one observation,
with no ordering at all. A pointer that resolves to no observation fails closed
as `unresolved` and the property stays in the sweep.

### Append-only
Both evidence tables refuse UPDATE and DELETE by trigger. A snapshot is bound to
an immutable observation, so rewriting it would change what the provider is
recorded as having said at a moment that has passed. A newer statement is a new
observation and a new snapshot.

**No durable lifecycle status column exists anywhere.** A closure window changes
its current meaning when the calendar moves and nobody said anything new, so the
outcome is computed by an evaluator holding an explicit `as_of` date. Nothing
here writes `hotels.active_status`, and
`source_property_observations.source_lifecycle_status` — NULL on all 4,110
current observations — is neither read nor written: absence of issues is never
laundered into "lifecycle = active".

## 5f. Human pre-publication review evidence (migration 0032)

The evidence path for D062's conditions 1 and 2 on the `approve_create` route:
an explicit human decision that a source identity is a distinct property in a
named supported destination. Three tables, same posture as 0027–0031 —
`service_role` plus admin/editor through RLS, **no anon grant** — and all three
are append-only by trigger *and* by grant: no role holds UPDATE or DELETE. Full
contract:
[`A04_5_HUMAN_REVIEW_EVIDENCE_CONTRACT.md`](A04_5_HUMAN_REVIEW_EVIDENCE_CONTRACT.md).

0032 also adds two additive unique constraints that carry no new data and exist
only so the receipt's composite foreign keys can be declared:
`source_property_observations (id, source_property_identity_id)` and
`source_match_candidates (id, source_property_identity_id)`.

### source_property_review_receipts
One immutable row per human decision, binding identity · source · environment ·
provider id · the **current** observation · that observation's source run · its
`source_payload_digest` · the decision · the reviewed destination · the accepted
human-owned finding · reviewer · `reviewed_at` · the A04 pre-review fingerprint
and its as-of date · a `receipt_digest`.

`decision` is exactly `approve_create` or `defer`. `approve_match` and `reject`
are absent from the vocabulary **at the database level**, not merely
unimplemented — a final exclusion and a match to an existing canonical hotel are
different decisions with different consequences, and this pilot implements
neither. A shape CHECK enforces the difference: `approve_create` must carry both
a destination and a finding; `defer` must carry neither and must carry a note.

Five composite foreign keys make misattribution unrepresentable rather than
merely discouraged. A receipt cannot cite another identity's observation, a
payload digest that observation never carried, a run that did not produce it, or
a finding belonging to a different identity. `(source_property_identity_id,
evidence_observation_id)` is unique, so one identity gets one decision per
observation; a new observation is new evidence and may be reviewed afresh.

`prereview_fingerprint` is the A04 preview fingerprint at review time. It is a
`^[0-9a-f]{64}$` CHECK with an explicit algorithm column pinned to `sha256`, in
the shape 0031 established for `source_payload_digest` — `timestamptz` has no
immutable text cast, so the digest is computed in the application and stored.

`receipt_digest` covers the decision's semantics and deliberately **excludes**
`reviewed_at`, so replaying an identical manifest is not called "different"
merely because the clock moved.

**One identity may hold several receipts** — one per evidence observation. That
is the point: when ingestion advances an identity, the old receipt stops being
current, the reviewer looks at the new observation, and a NEW receipt records
that fresh decision while the old one stays byte-unchanged. The two neighbouring
tables have different lifetimes and must not be confused with this history:

- `source_property_reviews` (0027) has `source_property_identity_id` **UNIQUE**.
  It is the ONE CURRENT decision — a projection, not a log. A fresh-observation
  `approve_create` **advances that row in place**; it never appends a second.
- the `human_review:distinct_property` `new_property` finding (0030, one per
  identity) is **entity-level and reused** across later confirmations. 0030 is
  right that a second row "is not new information", so several receipts may cite
  the same finding id. A `new_property` row that is not that exact accepted
  human finding is **refused**, never re-owned or rewritten.

### source_property_review_verifications
Six dimensions per `approve_create` receipt — `distinct_property`, `name`,
`city_locality`, `address`, `coordinates`, `destination_membership` — each a
separate row with verdict `supports` | `contradicts` | `unavailable`, unique per
`(receipt, dimension)`.

`unavailable` is never silently promoted to `supports`: a provider not supplying
an address is not evidence that the address agrees. A dimension may not be
omitted because its field is NULL — it is recorded as `unavailable`. A
`contradicts` verdict is legal and a CHECK requires it to carry the reviewer's
written explanation, so a lower dimension may contradict while the destination
judgement stays affirmative without the contradiction becoming invisible.

### source_property_review_evidence_references
What the reviewer actually read: `reference_kind`, `locator`, the dimensions it
`bears_on`, a stance and an optional note. At least one is required for
`approve_create`. This is not a source count — one authoritative reference may
establish several facts, but zero establishes none. **Nothing in the apply path
ever fetches a locator**; a review is the human's assertion about what they read,
and a machine re-fetch would be a different claim made at a different time.

### Completeness is enforced at COMMIT
The `approve_create` rules span rows, so no CHECK can express them. A **deferred
constraint trigger** (`DEFERRABLE INITIALLY DEFERRED`) runs at COMMIT, when the
receipt and its children are all visible, and fails the whole transaction unless
the receipt has all six verification dimensions, an affirmative
`distinct_property`, an affirmative `destination_membership`, and at least one
evidence reference. Because it fires at COMMIT, a childless receipt INSERTs
without error and the transaction dies at the end — taking the receipt, its
children, the human-owned finding and the `source_property_reviews` row with it.
There is no half-decision.

### The writer runs SERIALIZABLE
The A04.5 apply path opens `begin isolation level serializable`, not a plain
`begin`. Readiness is composed from nine evidence surfaces across many
statements; under READ COMMITTED each statement gets its own snapshot, so the
evaluator could compose a view that never existed and evidence could move
between the verdict and the write. Locking `source_property_identities` does not
help — it freezes one row, not the resolution, candidate, review or lifecycle
tables. REPEATABLE READ would give one snapshot but still permit write skew,
since this transaction reads evidence and inserts elsewhere. A serialization
abort is **never retried**; it is surfaced as a refusal and nothing is written.

**0032 writes nothing canonical.** No `hotels` row, no `hotel_source_identities`
link, no `resolution_state` transition. Publication remains A05.

### source_property_review_revocations (0033)
One immutable row meaning exactly: *this receipt's approval was withdrawn by this
reviewer, at this time, for this stated reason.* It is a new fact, not an edit of
an old one, which is why the receipt it revokes stays byte-identical.

`revocation_note` is NOT NULL and non-empty: a withdrawal with no stated reason
is not auditable. `revoked_receipt_id` is composite-FK'd as
`(revoked_receipt_id, source_property_identity_id)`, so a revocation cannot cite
another identity's approval, and `unique (revoked_receipt_id)` means a second
withdrawal of the same approval is refused by the database, not only by the
application. Append-only by trigger **and** by grant, with the 0027–0032 RLS
posture: admin/editor plus `service_role`, no anon grant, and no UPDATE or DELETE
for any role.

### review_status and current_receipt_id (0033)
0033 adds two columns to `source_property_reviews` because `decision` and
`review_status` answer different questions:

| column | question |
|---|---|
| `decision` | what the human **concluded** |
| `review_status` | whether that conclusion is **currently authorized for use** |

A revoked row therefore stays `decision = 'approve_create'` with
`review_status = 'revoked'`. Rewriting `decision` would destroy the record of
what was decided, and reusing `decision = 'defer'` would claim the human said
something they never said.

`current_receipt_id` names the immutable receipt the projection currently
represents, composite-FK'd to the same identity via the additive
`source_property_review_receipts (id, source_property_identity_id)` unique. NULL
is honest for legacy or hand-made rows that have no receipt at all; those rows
are excluded from the revocation pack rather than bound to a guess.

The FK proves same **identity**, which is not enough: an identity legitimately
holds one receipt per reviewed observation, so a projection advanced onto run B
could be pointed back at receipt A and still satisfy it.
`enforce_review_projection_receipt_coherence()` closes that, firing before every
INSERT and every UPDATE on `source_property_reviews` — not only when the pointer
column changes, because moving `decision`, `destination_id` or `decided_in_run_id`
breaks the invariant just as effectively. For a non-NULL pointer it requires both
sides to be `approve_create`, the destinations to agree, and
`receipt.evidence_source_run_id` to equal `review.decided_in_run_id` — the
load-bearing distinction between receipt A and receipt B for one identity.
Comparisons use `is distinct from`; `reviewed_at` is not part of the predicate;
and `review_status` deliberately is not either, because a `revoked` projection
must keep pointing at the receipt that was withdrawn.

The backfill binds on the **same full predicate the trigger enforces** — identity,
both decisions, destination and `decided_in_run_id = evidence_source_run_id` —
and **not** `order by reviewed_at desc limit 1`, which would silently bind the
wrong receipt if two were written in one transaction or a clock moved. Nor the
run alone: a receipt agreeing on the run but recording a different destination
does not represent the projection, so the pointer stays NULL. The `do $$ … $$`
ambiguity guard runs **before** the UPDATE, so a binding nobody can prove is never
computed rather than merely rolled back, and it fails the migration with
`data_exception` rather than breaking a tie on `reviewed_at`. That guard is unreachable on a schema-valid database — two
receipts for one identity sharing a run would need two observations of that
identity inside one run, which `source_property_observations_unique_per_run`
refuses — and it exists anyway, because "impossible today" is not "safe to guess
tomorrow".

### review_status must match the revocation record (0033)

The pointer being honest is not enough if the STATUS can lie.
`source_property_reviews` is deliberately mutable — a fresh review advances it,
so 0024 gives `authenticated` SIUD and `service_role` all — while a revocation is
append-only history. One statement was therefore enough to undo the brake:
`update source_property_reviews set review_status = 'active'`, touching nothing
else, restored a 11/11 PASS with the identical pre-revocation fingerprint.

`enforce_review_status_matches_revocation()` fires before every INSERT and UPDATE
and requires, for a receipt-backed projection, that `review_status = 'revoked'`
**iff** an immutable revocation exists for the receipt the projection currently
represents. Both directions matter: the first stops an un-revoke, the second
stops a column manufacturing a withdrawal no human made. A projection with
`current_receipt_id = NULL` may be `active` and may never claim `revoked`.

The predicate names the CURRENT receipt only. A historical revocation of receipt
A must not follow the identity forever — a fresh review produces receipt B, B
carries no revocation, and B is legitimately active. Removing UPDATE from the
table was rejected: it would break the legitimate advance this layer depends on.
The semantic transition is protected instead, and the invariant binds trusted
writers exactly as it binds untrusted ones.

### The IFF holds from both tables (0033)

A trigger on `source_property_reviews` alone covers only one direction of a
two-table invariant. `source_property_review_revocations` grants INSERT to
`authenticated` (admin/editor via RLS) and `service_role`, and its append-only
trigger forbids only UPDATE and DELETE — so the immutable event could be created
with the projection never touched and no projection trigger firing.

`enforce_revocation_targets_current_receipt()` (immediate, `before insert`)
requires a revocation to name the receipt the projection **currently** represents:
V1 withdraws the current approval and has no historical-revocation semantic.
Status is deliberately not checked there, because the apply path inserts the
event while the projection is still `active`.

`assert_review_revocation_state_coherent()` is a `deferrable initially deferred`
**constraint trigger registered on both tables**, checking at COMMIT that
`revocation exists for current_receipt_id` ⇔ `review_status = 'revoked'`. Deferred
timing is load-bearing: the legitimate transaction is lock → INSERT event → move
status, so an immediate check would forbid the correct path. What must be
coherent is the state that survives COMMIT. A bare direct INSERT is therefore
refused at commit rather than silently repaired.

**0033 writes nothing canonical either.** A revocation removes authorization; it
never publishes, unpublishes, deletes or rewrites history, and there is no
un-revoke. Authorization returns only through a fresh human review of a fresh
observation.

## 5g. Atomic source publication (migration 0034)

The first migration in this chain that *does* write canonical rows — not itself,
but by making the write representable. Full contract:
[`A05_ATOMIC_D062_PUBLICATION_CONTRACT.md`](A05_ATOMIC_D062_PUBLICATION_CONTRACT.md).

0034 also adds one additive unique constraint carrying no new data, so a
publication receipt can composite-FK the review receipt's own accepted finding:
`source_property_review_receipts (id, new_property_finding_id)`.

### source_property_publication_receipts
One immutable row per publication, meaning exactly: *this exact production source
identity, against this exact D062 PASS and this exact human review authorization,
created this canonical hotel — because this human explicitly authorized
publication, at this time, for this stated reason.*

It binds identity · source · environment · provider id · **hotel** · the
published observation · the human review receipt · that receipt's accepted
`new_property` finding · the star, location and scope revisions · the preview
as-of, schema version and fingerprint · the authorizing user, label, note and
time · a `publication_digest`.

**A D062 PASS is necessary and is not authorization**, which is why the
authorization columns exist at all. `authorization_note` is NOT NULL and
non-empty, for 0033's reason: an irreversible action with no stated reason is not
auditable. `--apply` is a flag, not a person.

`source_environment` is CHECKed `= 'production'` and the composite identity FK
makes that CHECK true of the IDENTITY rather than of this row's label —
**evaluation data never becomes canonical data**, a third independent layer
beside 0027's `hotel_source_identities_production_only` and
`source_property_identities_eligible_is_production`.

`unique (source_property_identity_id)` means one source identity creates at most
ONE canonical hotel on this path; `unique (hotel_id)` means two identities cannot
both claim to have created the same canonical row. Nine composite FKs make it
impossible to cite another identity's observation, approval, finding or
resolution revision, to cite a finding the named approval does not rest on, or to
name a hotel this identity never linked to.

Append-only by trigger **and** by grant, with the 0027–0033 RLS posture:
admin/editor plus `service_role`, no anon grant, and no UPDATE or DELETE for any
role. The canonical `hotels` row is public; the provenance behind it is editorial
internals. No provider payload is stored here.

### The receipt's claim is checked, not assumed (0034)
The composite FKs prove WHICH rows are cited.
`enforce_publication_receipt_evidence()` (BEFORE INSERT) proves WHAT they say and
whether they still AUTHORIZE anything.

*(A05 amendment #1.)* The original trigger read the immutable review receipt and
never asked whether that receipt is still the authorization in force — not the
same question, and exactly the one A04.6 exists to answer. So
`approve A → revoke A` left A looking unchanged to it, and a direct INSERT could
publish an approval a human had explicitly withdrawn. It now requires: a current
`source_property_reviews` projection with `decision = 'approve_create'`; that
projection's `current_receipt_id` to BE the cited receipt (so a historical
approval is never usable); no immutable revocation for it and `review_status =
'active'`, read as an OR so the append-only event dominates the mutable column;
the cited receipt to be an `approve_create` that reviewed the published
observation, agreeing with the projection on destination; and that observation to
still be the identity's CURRENT observation.

It then requires the canonical row to say what the evidence says: destination
from the human review; star equal to the current star revision's resolved value
with outcome `exact_four`/`exact_five`; coordinates equal to the current location
revision's; scope `physical_hospitality`; **name** equal to the affirmed provider
name with the human's `name` verification `supports`; **address** equal to the
affirmed provider address when `supports` and NULL when `unavailable` or
`contradicts`; **country_code** exactly the canonical destination's, NULL
included; `active_status` `unknown`; and `editorial_verification_status`
`unverified` with `website_url`, `instagram_url`, `description_short`,
`hotel_type`, `brand_id` and `editorial_verified_at` all NULL — the fields A05
deliberately does not own.

`public.canonical_published_text()` is the single definition of the trim applied
to provider text before publishing it, mirrored character for character by
`canonicalPublishedText()` in the writer.

### Receipt and terminal state are one fact (0034)
0027 already refuses `resolved_eligible` without an ACTIVE canonical link to the
named hotel. That is necessary and — *A05 amendment #1* — was not sufficient: it
says nothing about who authorized the publication, so
`hotel → ACTIVE link → resolved_eligible` with **no receipt at all** committed
happily, and 0034's original trigger returned early precisely because no receipt
existed. The invariant is two-sided:

> **A** a publication receipt → its identity is `resolved_eligible`,
> `promoted_hotel_id = receipt.hotel_id`, and `resolution_reason IS NULL`
>
> **B** an identity that is `resolved_eligible` → a publication receipt exists for
> it, naming that same hotel

`unique (source_property_identity_id)` is what makes "a receipt" in B mean exactly
one. `assert_publication_state_coherent()` is `DEFERRABLE INITIALLY DEFERRED`
because the legitimate write order — hotel → link → receipt → promote — leaves the
receipt existing while the identity is still `unresolved` for a few statements. An
immediate check would make the correct path impossible; what must be coherent is
the state that survives COMMIT, which is also why the function re-reads both rows
fresh rather than trusting the queued row image. It is registered on **both**
write origins, and the identity-side triggers carry WHEN clauses so ordinary
ingestion never enqueues them.

`resolution_reason` is D061 §9 EXCLUSION vocabulary, so a published property may
not carry one.

### 0034 refuses to migrate rather than invent history
Any source identity already carrying `resolved_eligible` when 0034 runs would be
a publication with no receipt to account for it. A guard at the top of the
migration raises `data_exception` naming those identities **before anything is
created** — 0033's fail-before-choice rule applied to a migration. It counts zero
on every current database.

### What 0034 does NOT prove
PostgreSQL does not recompute D062. The eleven-condition verdict, the semantic
fingerprint, the observation/run/payload pins and the SERIALIZABLE no-retry rule
remain the writer's responsibility; see
[`A05_ATOMIC_D062_PUBLICATION_CONTRACT.md`](A05_ATOMIC_D062_PUBLICATION_CONTRACT.md)
§7b for the exact boundary. The database makes a specific set of wrong
publications unrepresentable — not publication correct.

**0034 itself publishes nothing.** It creates structure: no `hotels` row, no
link, no `resolution_state` transition. A populated pre-0034 database — including
one carrying the A04.7 pilot's eight evaluation 11/11 PASS identities — migrates
with hotels still 0, links still 0 and every D062 verdict and fingerprint
byte-identical.

## 5h. Mail account, consent and the private communication boundary (migration 0035)

Phase B's first table set, and the posture is **deliberately unlike everything in
0027–0034**. Those are editorial internals that admin/editor read through
`public.is_admin_or_editor()` because reviewing hotel data is staff work. A
creator's mailbox is private correspondence; that function appears **nowhere**
here. Full contract:
[`B01_GMAIL_DATA_BOUNDARY_CONTRACT.md`](B01_GMAIL_DATA_BOUNDARY_CONTRACT.md);
closed decision: D067.

**No OAuth credential exists in this plane.** No access token, no refresh token,
no client secret, no authorization code — in any table, under any name. B02 keeps
credentials in server-side secret storage; `granted_scopes` is scope METADATA and
nothing more.

### mail_accounts
One connected mailbox: `user_id` (cascade — deleting a user takes their private
plane with it), `provider` (Gmail only in V1), `provider_account_subject` (the
DURABLE identity — Google's stable subject, never the address, which can be
renamed or reassigned to a different human), `email_address` (display/routing
only), `connection_state`, `granted_scopes`, and the connection timestamps.

`mail_accounts_provider_account_uidx`, a unique index on
`(provider, provider_account_subject)` **where `connection_state <> 'deleted'`** —
a durable provider identity has at most ONE LIVE mailbox record. Two live rows
would be two simultaneous connections with two consent histories, and no reader
could say which one governs. Retired records are excluded because `deleted` is
terminal: a creator who deletes their mailbox data and later reconnects the same
Google account gets a NEW row, since the old one asserts their data was removed
and may never be revived. A full unique index would have turned terminality into
"you can never reconnect this address", which is a bug wearing a privacy
guarantee's clothes.

**This index does not decide ownership, and must not be read as doing so** — see
`mail_provider_account_owners` below. It governs the live present of a durable
identity; ownership spans its whole history, retired rows included.

`mail_accounts_provider_owner_fk`, a composite FK on
`(provider, provider_account_subject, user_id)` into the ownership registry, is
what binds every mail account — live or retired — to the one app user that owns
its durable provider identity.

`unique (id, user_id)` is the **provenance spine**: every future Gmail-origin or
Gmail-derived table composite-FKs the PAIR, so no such row can lose the account
and owner it must be deleted with. Deletion-addressability is a restricted-scope
obligation, not a convenience.

`granted_scopes` carries an allow-list CHECK calling
`public.approved_gmail_scopes()`, which names exactly `gmail.readonly`
(restricted, required for historical analysis), `gmail.send` (sensitive,
requested later through incremental authorization) and the identity scopes.
`gmail.modify`, `gmail.compose`, `gmail.insert`, `gmail.metadata`,
`mail.google.com` and the settings scopes are refused by the database — a scope
contract that lives only in a document is one a script can break. The allow-list
is a FUNCTION rather than two array literals so the account side and the consent
side cannot drift apart; `public.canonical_scope_set()` normalises every scope
array on write to sorted-distinct form, which is what lets scope sets be compared
as SETS with `=`.

`connection_state` is `pending_authorization` · `consent_required` ·
`connected` · `reauth_required` · `disconnecting` · `disconnected` ·
`deletion_pending` · `deleted`. **`consent_required` and `disconnecting` were
added by 0036**, which ALTERs the CHECK 0035
created: B01 wrote its vocabulary before any credential existed anywhere, so
`pending_authorization` meant "the human has not finished at Google and we hold
no access" — a sentence that cannot describe the moment after a successful
authorization but before the product permission, when a verified `sub`, the
approved scope set and a usable refresh token are all in hand. The two states now
divide that ground: `pending_authorization` keeps its merged meaning exactly, and
`consent_required` means Google authorized us, a credential exists, and no
current private-processing consent covers the granted scope set. CHECKs require a
`connected` row
to name when it connected, to hold at least one scope, and to hold
**`gmail.readonly` specifically** — `openid` plus `gmail.send` is a mailbox we may
write to and may not read, which is not a Gmail connection in this product's
sense. Every disconnected/deleting state must record `disconnected_at` with an
EMPTY scope set — the metadata half of revocation, which does not substitute for
revoking at Google.

`current_deletion_request_id` names the specific deletion a `deletion_pending` or
`deleted` state rests on, composite-FK'd as `(current_deletion_request_id, id)` so
it must be THIS mailbox's request. CHECKs require the pointer in those two states
and forbid it in every other, so the field always means what it says.

### mail_provider_account_owners
**One durable provider identity, one owning app user.** `(provider,
provider_account_subject)` is the primary key; `owner_user_id` cascades from
`users`. Shared-inbox ownership, agency delegation and cross-tenant transfer are
all future work requiring explicit authorization, not a row edit — a trigger
refuses UPDATE outright, because editing `owner_user_id` would BE that transfer,
performed in one statement.

Ownership needs its own table because neither shape of index on `mail_accounts`
can express it. A FULL unique index on the subject forbids same-owner
reconnection, which terminal `deleted` makes necessary. A PARTIAL index over live
rows permits that reconnection but stops seeing retired rows entirely — so user A
could retire a mailbox and user B claim the same Google account while A's consent
receipts, consent projections and deletion request were still on file and still
A's. The registry separates the two questions the single index was being asked to
answer: **who owns a durable identity** (registry, whole history) and **how many
live connections it may have** (partial index, present only).

The primary key is also the **serialization point**. A trigger that merely
SELECTed for an existing owner would let two concurrent transactions both find
nothing and both proceed, since neither sees the other's uncommitted row.
`claim_provider_account_owner()` instead does an `insert … on conflict do
nothing` on `mail_accounts` INSERT: the second claimant blocks on the index until
the first commits, then reads the winner and is refused. The composite FK is the
declarative backstop — if the trigger were removed, no registry row would be
created and every insert would fail closed rather than open.

**Release semantics are deliberate and asymmetric.** Deleting a `mail_accounts`
ROW leaves the reservation standing: the owner still exists, it is still their
claim, and they may reconnect — only a stranger is kept out. Erasing the USER
drops it with the rest of their private plane, because a reservation that
outlived its human would ban a Google account permanently with nothing left in
the product to protect.

**Erasing the owner is the ONLY release.** `forbid_provider_account_owner_release()`
is a BEFORE DELETE trigger that refuses whenever the owning `users` row still
exists — which is precisely the condition that distinguishes a direct delete from
the referential action of erasing that user, since PostgreSQL removes the parent
before applying the cascade. It is deliberately not `pg_trigger_depth()`, for the
reason amendment #1 established about the consent-receipt guard.

The FK from `mail_accounts` is a second, narrower layer: it refuses while any
mailbox still references the reservation. It is not sufficient on its own,
because it stops meaning anything once the last such row is physically removed —
which was enough to move a Google account between app users in three ordinary
statements, with the owner untouched.

`service_role` therefore holds `SELECT, INSERT, UPDATE` and **no DELETE**:
directly removing a reservation is not a supported operation, and a referential
action needs no privilege on the referencing table. The withheld grant is the
first layer; the trigger is the one that matters, because a privilege cannot stop
the table owner or a superuser and the invariant holds against them too.

RLS is owner-only, like the rest of the plane: "which app user owns Google
subject X" would otherwise let anyone probe whether a given Gmail account is
connected here and to whom.

### mail_account_consent_receipts (append-only)
Immutable history of what a human agreed to: the permission, the decision, the
policy version, a **digest of the exact text shown**, and the scopes in force at
the time — because consent given against read-only access is not consent to a
later, wider grant. Append-only by trigger and by grant; a withdrawal is a NEW
receipt, never an edit. `decided_by_user_id = user_id` is CHECKed, so
acting-on-behalf-of is unrepresentable rather than merely unimplemented.

`event_seq` is a `generated always as identity` ordinal and is **the** order of
consent events. It exists because none of the alternatives is an ordering:
`decided_at` is caller-supplied and can be back-dated (deliberately or by clock
skew); `created_at` is `now()`, which is transaction start time and identical for
two receipts written together; and a random UUID's lexical order is not chronology
at all. `generated ALWAYS` means a writer cannot supply or override it.

`granted_scopes_at_decision` is **evidence, not narration**: a deferred check
requires it to equal the account's actual scope set at COMMIT of the transaction
that created the receipt, and an allow-list CHECK stops a forbidden scope entering
through the consent side after being refused on the account side. It is never
rewritten when scopes later change — each receipt stays true about its own moment.
A writer that wants to record "withdrew while holding gmail.readonly" writes the
withdrawal receipt BEFORE clearing the account's scopes.

The DELETE guard permits removal only when the receipt's mailbox row or its user
row is already gone, which is precisely the state an FK cascade from either parent
produces (PostgreSQL removes the parent before applying the referential action).
Both parents are checked because `users` cascades to `mail_accounts` and to these
receipts through two separate constraints and does not promise an order. The
earlier `pg_trigger_depth() > 1` test was replaced: it is true of ANY nested
trigger context, so it did not prove the cascade it was documented as proving.

### mail_account_consents
The CURRENT answer, one row per (mailbox, permission), composite-FK'd to its
receipt on `(id, mail_account_id, consent_kind, decision, event_seq)`. A
projection that says `granted` while naming a withdrawal, that borrows another
mailbox's or another permission's decision, or whose `current_event_seq`
disagrees with the receipt it names, is **unrepresentable** — declaratively, not
by trigger.

Three layers make the current consent the LATEST consent:

1. the composite FK above — the projection agrees with the receipt it names;
2. a BEFORE UPDATE trigger — `current_event_seq` never decreases, so a projection
   cannot be re-pointed at a grant the human already withdrew. Re-granting after
   a withdrawal happens ONLY through a new granted receipt, which carries a
   higher ordinal by construction;
3. `assert_mail_consent_projection_dominant()`, deferred and registered on
   **receipt INSERT and projection INSERT/UPDATE/DELETE** — for every (mailbox,
   permission) with any history, exactly one projection exists and it names the
   receipt with the greatest `event_seq`.

Layer 3 is registered on both origins for the reason A04.6 amendment #3
established: the same broken state is reachable from either side — append a
withdrawal and stop, or move the projection off the latest decision — so both
sides have to refuse it. Without it a withdrawal could be recorded and never take
effect, and `mail_account_has_consent()` (which every future G1/G2 caller reads)
would keep answering `true` about a permission that had been taken back.

Two permissions: `private_gmail_processing` (required for the product to do
anything) and `network_intelligence_contribution` (**separate, explicit,
revocable, default NOT granted**). `public.mail_account_has_consent()` is the
single definition of "may we?", and **no row means NOT granted** — one function,
because a second reading of "no row" is how a default-false permission becomes
accidentally true.

### mail_account_deletion_requests
**Disconnect is not delete.** Stopping provider access and removing stored data
are different acts; a disconnected mailbox with no request is the first, a
request row is the second. `scope` records how much was asked for at request
time, and `network_contributions_invalidated_at` exists so a later phase can
PROVE a withdrawal reached the aggregate layer. Owner-initiated only; one open
request per mailbox.

### The state labels mean something (0035)
`assert_mail_account_state_coherent()` is `DEFERRABLE INITIALLY DEFERRED` and
registered on all four write origins (accounts, consents, consent receipts,
deletion requests):

- `connected` requires a granted `private_gmail_processing` consent — holding
  access and being permitted to use it are different facts;
- `connected` requires the account's scope set to EQUAL the snapshot on its
  current private-processing receipt. Incremental authorization can widen access
  after the fact, and Google's screen asks about ACCESS, not about what this
  product may do with the data — so widening (or narrowing) requires a NEW
  private-processing receipt naming the new set. Documentation and database now
  say the same thing;
- `deletion_pending` requires the request the account NAMES to be outstanding;
- `deleted` requires the request the account NAMES to be `completed` **and**
  scoped `account_and_gmail_derived_data`. A completed `gmail_derived_data`
  request means the opposite — derived data goes, the record is KEPT so the
  connection stays auditable — so letting it retire the record would delete
  something nobody asked to delete and then read back as evidence that they had.

`enforce_mail_account_state_transition()` is a BEFORE UPDATE trigger and holds
the rules a deferred check structurally cannot, because a deferred check only
ever sees where a transaction ended up:

- entering `deletion_pending` requires the named request to exist and be running
  AT THAT MOMENT. Otherwise a writer could pass through `deletion_pending`
  pointing at a request that finished long ago and land on `deleted` in the same
  transaction — the end state looks perfect and the waiting never happened;
- `deleted` is reachable only FROM `deletion_pending`, on the same request, so
  the request that ran is the request that is credited;
- **`deleted` is terminal.** No transition out, to any state, and the request it
  names cannot be swapped afterwards. A revived row would make the assertion
  "your data was removed" false while still carrying the completed deletion as
  its evidence;
- **owner and provider identity are immutable.** `user_id`, `provider` and
  `provider_account_subject` cannot change after creation. Every consent receipt
  and deletion request on a mailbox is about THIS human and THIS Google account;
  re-pointing the row would make all of them describe something else — a transfer
  performed in one UPDATE.

### Access
Owner reads their own rows; that is the entire client surface, because every
write is a server action behind an OAuth flow or a deletion job. Another creator
sees nothing. **Admin/editor see nothing through a client session.** `anon` holds
no privilege at all. `service_role` is the trusted server path — a capability,
never a user-facing permission — and does not hold UPDATE or DELETE on consent
history either.

**0035 creates no message, thread, attachment, sync or job table, connects no
mailbox, infers no consent, enrols no user and stores no token.**

## 5i. Gmail OAuth credentials and transactions (migration 0036)

B01 promised that B02 would keep credentials server-side, encrypted, out of any
generally queryable table, and unreachable by a client. This is where that is
made true.

### The `private` schema
**No `usage` grant for `anon`, `authenticated` or `service_role`** — not a narrow
grant, no path at all. `service_role` is `BYPASSRLS`, so RLS could never have
protected a credential from the trusted role; withholding schema usage does. The
only door is a set of SECURITY DEFINER functions in `public`, executable by
`service_role` alone, each pinning its `search_path` and each one transaction.

### private.gmail_oauth_transactions
One in-flight authorization: owner-bound, TTL ~10 minutes, **consumed once** by a
single `delete … returning` scoped to the user, so a replay finds nothing and a
state started by user A cannot be completed by user B.

`state` and `nonce` are stored as **digests** — the raw values travel in the URL,
so what we keep recognises them without being able to forge one. The **PKCE
verifier is encrypted** rather than hashed, because the token exchange needs the
plaintext back. A `reconnect` target is composite-FK'd to `mail_accounts (id,
user_id)`, so a caller-supplied account id cannot aim the flow at somebody else's
mailbox. `return_path` carries a CHECK forbidding absolute and protocol-relative
values.

`purpose`, `target_mail_account_id` and `target_authorization_revision` are an
**IFF**: `connect` ⇔ neither, `reconnect` ⇔ both. "Reconnect implies a target" left the other half open,
and a `connect` carrying a target is a transaction whose two fields describe
different flows — the callback would then have to pick one, and a caller who can
influence that pick can steer where a fresh Google grant lands.

### 0036 refuses to install on state it cannot make true
Before anything else, the migration aborts if any pre-existing `mail_accounts`
row contradicts a rule 0036 is about to install. **Two** rules can already be
false:

- any row that is `connected` — it cannot hold a credential, because this
  migration is what creates the credential store;
- any `pending_authorization` row with a **non-empty** scope set — 0035 permits
  that combination (its empty-scope CHECK covers only `disconnected`,
  `deletion_pending` and `deleted`) and 0036 forbids it.

The remaining states need no guard: `reauth_required` legitimately retains its
scopes and can hold no credential yet; `disconnected`/`deletion_pending`/`deleted`
already require empty scopes under 0035; `consent_required` cannot exist, because
0035's CHECK does not permit the value.

B02 cannot attach a refresh token retroactively and cannot know which half of a
`pending_authorization`-with-scopes row is true, so there is no honest repair: it
does not synthesize a credential, clear the scopes, demote or promote the state,
delete rows, or leave it for the next write. It names the rows and stops. The
expected count is zero, because B01 shipped schema only.

### mail_accounts.authorization_revision (added by 0036)
The **lifecycle revision an in-flight OAuth flow pins.** A `bigint` from
`public.mail_account_authorization_revision_seq`, advanced by a BEFORE UPDATE
trigger whenever `connection_state` or `granted_scopes` changes — the changes
that invalidate an authorization started against the older state. Unrelated
display-metadata edits leave it alone.

The trigger assigns the column on every update, so it is **not caller-settable**,
and a direct SQL lifecycle change invalidates in-flight OAuth exactly as a server
action does. A successful explicit reconnect also advances it: landing a fresh Google
credential is a provider-authorization event, so two flows begun against the same
version cannot both land. The persist function REQUESTS that bump and the trigger
chooses the number; a background `gmail_credential_replace` deliberately does not
request one, because rotation is not a human authorization event. The trigger
fires on INSERT as well as UPDATE, so a supplied value is overwritten either way.

`gmail_oauth_begin` captures it for a reconnect and `gmail_connection_persist`
loads the target **`for no key update`** before comparing anything — a plpgsql
function is VOLATILE and takes a fresh snapshot per statement, so an unlocked
comparison is evidence about a row rather than a hold on it. It requires the
exact value — because a mailbox can leave
a reconnectable state and return to one, and a stale callback would otherwise
find the state name it expects while knowing nothing about the decisions in
between.

### private.gmail_oauth_credentials
The encrypted refresh token, **one per mailbox** — a replacement supersedes its
predecessor completely, because keeping the old one would be keeping a live key
we decided to stop using. Ciphertext, IV, authentication tag and key version are
stored; the AES-256-GCM key is not, and the database has never seen it.

**Absent on purpose:** access token, ID token, authorization code, raw state, raw
nonce. An access token lives minutes and belongs in memory; the rest are
single-use inputs whose job is over.

`credential_generation` is the **concurrency token**: a `bigint` from a sequence,
returned by every load and supplied by every mutation derived from one. A refresh
spans a network call, so without it a slow worker could overwrite a newer
credential, delete one it never saw, or drag a disconnected mailbox back to
`reauth_required`. Not a timestamp (equal values collide, clock order is not
causal order) and not a per-row counter (a reconnection deletes and re-creates
the row, so a per-row counter would reissue generation 1 and a stale value would
match). `gmail_credential_replace`, `gmail_mark_reauth_required` and
`gmail_credential_currentness` are all compare-and-swap on it, and each also
re-checks that the mailbox is still `connected` and still consented.

`provider_refresh_token_expires_at` is NULL when Google did not state one — *not
stated*, never *never expires*. **The production adapter always writes NULL**:
`google-auth-library@11.0.2` does not surface `refresh_token_expires_in`, so B02
does not currently capture provider refresh-token expiry metadata.

The composite FK on `(mail_account_id, user_id)` is B01's provenance spine: the
credential cannot lose either the mailbox or the human, and cascades with both.

### The state word and the credential are one fact
`assert_gmail_credential_state_coherent()` is a **deferred** constraint trigger
registered on `mail_accounts`, on `private.gmail_oauth_credentials` (INSERT,
UPDATE **and DELETE**) and on `mail_account_consents`. At COMMIT:

- `connected` / `consent_required` → **exactly one** credential;
- `disconnecting` → **zero or one**. This is the one state that spans a network
  call by design: the owner has asked to stop, and the credential is retained
  until revocation resolves because it is the only thing that can revoke. Stating
  "exactly one" would refuse the row the instant finalize deleted it, and stating
  nothing would leave a state with no upper bound at all — so the trigger
  enforces at most one and says why. What it holds is **revocation retry
  material**, either the token the Disconnect loaded or the fresher token a
  superseded callback stored when its own revocation failed; `gmail_credential_load`
  refuses this state, so nothing can process the mailbox with it;
- every other state → **no** credential;
- `consent_required` additionally requires `gmail.readonly`, and may not survive
  a granted private-processing consent whose snapshot equals the current scope
  set — that decision has already been made, and the mailbox is `connected`;
- `pending_authorization` additionally requires an **empty scope set**. 0035
  defines it as "the human has not completed Google's consent screen and no
  provider access is current"; a granted scope set is the record of an
  authorization that state says did not happen. `reauth_required` is deliberately
  exempt — it retains the last known scope set by contract, because that is what
  a reconnection is trying to restore.

Deferred because every legitimate write passes through an intermediate state:
persist sets the account row before inserting the credential, disconnect deletes
the credential before moving the state. Registered on all three write origins for
the reason A04.6 and A05 established — deleting the credential of a `connected`
mailbox never touches `mail_accounts`, so a trigger watching only that table
would never see it. Cascades are handled by reading the FINAL database state: if
the account row is gone, there is nothing left to be coherent with. No
`pg_trigger_depth()`.

### The RPC surface
`gmail_oauth_begin` · `gmail_oauth_consume_transaction` ·
`gmail_connection_persist` · `gmail_grant_private_processing_consent` ·
`gmail_credential_load` · `gmail_credential_load_for_owner` ·
`gmail_credential_replace` · `gmail_credential_currentness` ·
`gmail_mark_reauth_required` · `gmail_disconnect_prepare` ·
`gmail_disconnect_finalize` · `gmail_record_superseded_disconnect_credential` ·
`gmail_connection_status`.

`gmail_disconnect_finalize` **requires the prepared state**: only `disconnecting`
may be consumed (→ `disconnected`), `disconnected` is idempotent, and every other
live state answers `prepare_required` without touching the row. Without it a
trusted caller could go `connected` → `disconnected` in one call — credential
deleted, scopes emptied — with no durable intent, no in-flight OAuth cancelled
and nothing said to Google, which is the original provider/local divergence
rebuilt through the RPC surface. `service_role` is a capability, not proof that a
caller followed the protocol.

`gmail_record_superseded_disconnect_credential` is the durable half of the one
revocation B02 performs on a refused callback. Revoking a superseded grant is a
network call and can fail; the token that can remove that grant is the one the
callback just received, so it is stored FIRST — sealed, in `disconnecting`, where
`gmail_credential_load` refuses it — and revoked second. It re-checks owner,
verified subject and the supersession predicate under its own lock, and refuses
outright if a newer successful Reconnect has made the mailbox live again, so an
old callback can neither overwrite that credential nor revoke that authorization.

`gmail_grant_private_processing_consent` may connect **only from
`consent_required`**, checked inside the lock it already holds; anything else
answers `consent_not_applicable` and writes no receipt. `disconnecting`
deliberately retains its credential, so without this gate a consent form
submitted before a Disconnect could land after it and undo the newer decision.

`gmail_disconnect_prepare` is the step that makes Disconnect dominate the
provider. It runs BEFORE the network call, in one transaction: it deletes the
mailbox's outstanding OAuth transactions (a flow that has not come back can never
be completed), moves the row to `disconnecting`, records
`disconnect_requested_revision` from the revision the trigger just issued, and
returns the credential envelope for the revocation about to happen. Doing any of
that after Google answered would be making the decision too late to beat a
callback already in flight. It refuses `deletion_pending` with
`deletion_in_progress` and `deleted` with `account_retired`, so a user-facing
Disconnect cannot rewrite a lifecycle a deletion request owns — without that
refusal the `disconnecting` write hits B01's
`mail_accounts_non_deletion_state_has_no_request` CHECK and raises instead of
answering.

`gmail_connection_persist` is the atomic landing point after every Google-side
check has passed. When the transaction named a reconnect target, it binds that
target FIRST — same owner, `gmail`, a reconnectable state, and a
`provider_account_subject` equal to the subject Google just verified — and
answers `account_mismatch` otherwise. Without that, choosing a different Google
account at the account chooser fell through to "identity never seen" and silently
created a new mailbox. A `deleted` target answers `account_retired`; B01's
terminality is not something a reconnect may undo.

It also requires the pinned `target_authorization_revision` to still be the
mailbox's current one, so an OAuth flow the human abandoned cannot undo the
Disconnect they chose instead.

**The checks are ordered by meaning**: identity (owner, provider, verified
subject) → supersession → the ordinary lifecycle refusals. Supersession is a
statement about a specific Google account, so identity settles first; and it must
be asked before the reconnectable-state gate, because that gate destroys the
information. Ordering it last is what made the `disconnecting` half of the
supersession condition dead code — the gate answered `account_mismatch` for
exactly the state in which a live, freshly-created grant is most likely to exist.
Nothing is widened by the reorder: `connected`, `disconnecting`,
`deletion_pending` and `deleted` are still states no callback may persist into.

**The supersession fence is `mail_account_lifecycle_intent_seq`, not the
revision.** Every OAuth transaction draws an `oauth_intent_seq` at INSERT and
every explicit Disconnect draws a `disconnect_intent_seq` at prepare, from the
SAME sequence — so "did this flow begin before the human's Disconnect?" is one
comparison, and it works for a **generic CONNECT**, which has no target and
therefore no revision to pin. That was the remaining hole: `prepare` can only
cancel transactions that name a mailbox, so a "Connect another Gmail" begun
before a Disconnect could come back with the disconnected identity, exchange its
code, and be waved through as `reconnect_required` while Google's grant was
active again. Both branches — targeted and generic — now consult
`private.gmail_flow_superseded_by_disconnect()`, one predicate in one place.

A sequence and not a timestamp, for amendment #2's reason: equal values collide
and clock order is not causal order. `authorization_revision` is kept for what it
alone can do — the exact-version CAS on a known target.

`superseded_by_disconnect` is the one refusal the application answers by revoking
at Google, because there the project-wide revocation is the thing the human
actually asked for; every other refusal still revokes nothing.

It then implements B01's account selection — new identity, never revive a
`deleted` one, refuse an identity owned by another user without naming them — and
stores the credential in the same transaction. A generic connect landing on an
existing LIVE row of this owner answers `reconnect_required` and persists
nothing: it never pinned that mailbox's revision, so it does not get to revive
it. A successful authorization lands in `consent_required`, never `connected`,
unless a current exact-scope consent already exists.

`gmail_credential_load` returns the ENVELOPE and its generation, never a token:
decryption happens in the application. It takes **no user id**, which is right for a trusted internal
caller in B03 and wrong for anything a browser reaches, so user-initiated actions
use `gmail_credential_load_for_owner(p_user_id, p_mail_account_id)` instead —
the owner is part of the lookup, so a stranger's mailbox id returns `not_found`
and no envelope is ever assembled.

**0036 connects no mailbox, opens no OAuth transaction, stores no credential and
infers no consent. It adds no message, thread, attachment, sync or import table.**

## 6. Editorial evidence and signals

### contact_signals
- `id uuid PK`
- `contact_id uuid FK hotel_contacts(id)`
- `hotel_id uuid FK hotels(id)`
- `creator_id uuid FK creator_profiles(id)`
- `signal_type text NOT NULL`
- `details text NULL` — internal/private, never public intelligence
- `created_at timestamptz`

Signals: email_worked, email_bounced, person_changed, wrong_department, auto_reply, other.

### verification_events
- `id uuid PK`
- `entity_type text`
- `entity_id uuid`
- `verification_type text`
- `status text`
- `performed_by uuid NULL FK users(id)`
- `source_type text`
- `notes text NULL`
- `created_at timestamptz`

Polymorphic entity references require application validation. Do not cascade-delete verification history.

### editorial_evidence
Provenance for a research claim. Migration `0027` adds one nullable column:
- `source_run_id uuid NULL FK source_runs(id)` — so a provider claim and a
  file-research claim are auditable in the same place. `import_batch_id` and
  `import_row_id` are unchanged.

### admin_flags
- `id uuid PK`
- `entity_type text`
- `entity_id uuid`
- `flag_type text`
- `source text`
- `severity text`
- `status text`
- `created_at timestamptz`
- `resolved_at timestamptz NULL`
- `resolved_by uuid NULL FK users(id)`

## 7. Commerce and authorization

### subscriptions
Commercial state only.
- ids/provider identifiers
- `user_id`
- `provider`
- `plan_code`
- `status`
- `price_paid numeric`
- `currency text`
- `started_at`, `renews_at`, `cancelled_at`, `ended_at`
- timestamps

### purchases
One-off transactions.
- provider transaction identifiers
- `user_id`
- `product_type`
- `product_reference`
- amount/currency/status
- purchase/refund timestamps

### access_entitlements
Authorization source of truth.
- `id uuid PK`
- `user_id uuid FK users(id)`
- `access_type text`
- `destination_id uuid NULL FK destinations(id)`
- `source text`
- `source_reference text`
- `starts_at timestamptz`
- `expires_at timestamptz NULL`
- `status text`
- timestamps

Access types: free, destination, pro, admin.
Status at minimum: active, expired, revoked, pending.

Invariant:
- `destination` requires `destination_id`.
- `pro/admin` require `destination_id IS NULL`.
- Access checks use active time-bounded entitlements, not subscription UI state.

Add uniqueness/idempotency around provider/source references where possible.

## 8. Creator workflow

### trips
- `id uuid PK`
- `creator_id uuid FK creator_profiles(id)`
- `destination_id uuid FK destinations(id)`
- `name text NULL`
- `start_date date`
- `end_date date`
- `status text`
- `visibility text DEFAULT 'private'`
- timestamps

Statuses: planning, upcoming, active, completed, cancelled.
Constraint: `end_date >= start_date`.

### trip_hotels
- `id uuid PK`
- `trip_id uuid FK trips(id) ON DELETE CASCADE`
- `hotel_id uuid FK hotels(id)`
- `priority text NULL`
- `created_at timestamptz`
Unique `(trip_id, hotel_id)`.

### pipeline_items
Represents one creator↔hotel relationship cycle.
- `id uuid PK`
- `creator_id uuid FK creator_profiles(id)`
- `hotel_id uuid FK hotels(id)`
- `trip_id uuid NULL FK trips(id)`
- `status text NOT NULL`
- `priority text NULL`
- `private_notes text NULL`
- `next_followup_at timestamptz NULL`
- `saved_at timestamptz`
- `first_pitched_at timestamptz NULL`
- `last_activity_at timestamptz`
- `cycle_number integer NOT NULL DEFAULT 1`
- timestamps

Statuses: saved, planned, pitched, replied, follow_up, negotiating, won, closed.

Multiple historical cycles per `(creator_id, hotel_id)` are allowed. Multiple simultaneously active cycles are prevented by a partial unique index. The active definition is finalized (see DECISIONS D023): a cycle is active in every status except `closed` (so `won` is still active), and only `closed` frees the pair for a new cycle:

`pipeline_items_single_active_cycle_uidx (creator_id, hotel_id) WHERE status <> 'closed'`.

### outreach_events
Strategic append-oriented domain ledger.
- `id uuid PK`
- `creator_id uuid FK creator_profiles(id)`
- `hotel_id uuid FK hotels(id)`
- `pipeline_item_id uuid FK pipeline_items(id)`
- `event_type text NOT NULL`
- `event_at timestamptz NOT NULL`
- `channel text NULL`
- `metadata jsonb NOT NULL DEFAULT '{}'`
- `source text NOT NULL`
- `created_at timestamptz DEFAULT now()`

Events:
hotel_saved, pitch_sent, followup_sent, reply_received, positive_reply, negative_reply, contact_bounced, offer_received, negotiation_started, deal_won, deal_lost, collaboration_started, collaboration_completed, creator_closed_pipeline.

Channels: email, instagram, linkedin, website_form, whatsapp, in_person, other.

Do not create domain events from contact views/unlocks.

### collaborations
- `id uuid PK`
- `creator_id uuid FK creator_profiles(id)`
- `hotel_id uuid FK hotels(id)`
- `pipeline_item_id uuid FK pipeline_items(id)`
- `status text`
- `collaboration_type text`
- `agreed_at timestamptz NULL`
- `start_date date NULL`
- `end_date date NULL`
- `terms_matched text DEFAULT 'unknown'`
- `would_work_again boolean NULL`
- `private_value_amount numeric NULL`
- `private_value_currency text NULL`
- timestamps

Types: stay, product, paid, stay_plus_paid, other.
Statuses: agreed, scheduled, active, completed, cancelled.
Private financial values MUST NOT feed public aggregates in V1.

## 9. Intelligence

### hotel_intelligence
Derived/rebuildable.
- `hotel_id uuid PK FK hotels(id)`
- rolling interaction counts
- pitch/reply/positive/negative/collaboration counts
- `reply_rate numeric NULL`
- `median_reply_hours numeric NULL`

Added by migration `0026` for the premium layer (D058). All derived, all
rebuildable, all server-only:

- `pitched_cycles_365d`, `replied_cycles_365d integer`
- `distinct_pitch_creators_365d`, `distinct_reply_creators_365d integer`
- `reply_rate_365d`, `median_reply_hours_365d numeric NULL`
- `distinct_creators_7d`, `distinct_creators_30d`, `distinct_creators_90d`,
  `distinct_creators_365d integer` — contributor diversity per window
- `collaboration_type_creators_365d jsonb` — type → distinct creators observed

Two browser-safe projections read from this table; nothing else may:

- `hotel_public_intelligence` — everyone. No reply rate since `0026`.
- `hotel_premium_intelligence` — entitlement-gated inside the view by
  `has_premium_hotel_access()`. `anon` holds no privilege on it.

Neither projects an identifier, a raw outreach count (pitches, replies, events,
cycle denominators) or a raw timestamp. The single count either projection
publishes is the premium `contributor_count`, and only at >= 5 distinct
creators.
- `last_creator_activity_at timestamptz NULL`
- `last_reply_at timestamptz NULL`
- `last_collaboration_at timestamptz NULL`
- `activity_level text`
- `confidence_level text`
- `calculated_at timestamptz`

### destination_intelligence
Derived/rebuildable by destination.
Fields from PRD plus `calculated_at`.

### Safe public projection
Implement a dedicated view/materialized view or server DTO such as `hotel_public_intelligence`.
It MUST contain no:
- creator_id
- pipeline_item_id
- private notes
- private financial values
- raw low-N timestamps when privacy rules suppress them.

Public pages query only safe projections.

## 10. Growth entities

### hotel_claims
Lead capture only in MVP.

### public_creator_profile_views
Store anonymous/session-level portfolio views. Do not imply hotel identity unless reliably established.

### milestones
System-generated from real domain data.

### share_cards
Use non-guessable public tokens. Never serialize active target hotel names into public payloads.

### referrals
Attribution and conversion record. Payout implementation is separate.

## 11. Delete/retention semantics

- Subscription expiry never deletes creator workflow.
- Closing a hotel preserves historical references.
- Account deletion must allow PII/private data deletion or anonymization while preserving lawful anonymous aggregates.
- Hotel merge uses canonicalization, not blind deletion.
- Historical events referencing merged hotels must be migrated transactionally or resolved through canonical IDs.

## 12. Required indexes

At minimum:
- hotels(destination_id), hotels(brand_id), hotels(slug)
- hotel_contacts(hotel_id, status)
- pipeline_items(creator_id, status), pipeline_items(hotel_id)
- outreach_events(hotel_id, event_at), outreach_events(creator_id, event_at), outreach_events(pipeline_item_id, event_at), outreach_events(event_type, event_at)
- trips(creator_id, status)
- access_entitlements(user_id, status, starts_at, expires_at), access_entitlements(destination_id)
- contact_signals(contact_id, created_at)
- intelligence confidence/activity fields used by filters
- geospatial index if PostGIS is adopted for map bounding-box queries.

## 13. Migration order

1. extensions/helpers
2. users/profiles
3. destinations/brands/hotels/contacts
4. commerce/entitlements
5. trips/pipeline
6. events/collaborations
7. verification/signals/admin flags
8. intelligence
9. milestones/share/referrals/claims
10. RLS policies/views/functions
11. import/editorial infrastructure (0014-0016)
12. explicit privilege contract (0024) — every later migration must state its
    own grants, because `alter default privileges` gives new tables none
13. property-content source infrastructure (0027)
14. pre-publication resolution (0028) — provider policy as data, immutable
    resolution revisions, head pointers
15. pre-publication physical-hospitality scope (0029) — the same shape applied to
    D062's condition 3; an INPUT to eligibility, never eligibility itself
16. entity-resolution idempotency (0030) — no new table: a candidate pair is one
    row, `new_property` must carry the finding behind it, and
    `superseded_reason` separates a machine stand-down from a human decision
17. pre-publication lifecycle evidence (0031) — provider issue evidence,
    extraction completeness as its own row, and a policy that refuses to read
    `issueType` without its `issueCode`
18. human pre-publication review evidence (0032) — the immutable receipt behind
    an `approve_create`, its structured verification dimensions and evidence
    references, plus the two additive uniques its composite FKs require;
    append-only by trigger and by grant, and canonical-write-free
19. human review revocation (0033) — `review_status` and `current_receipt_id` on
    the current projection, plus the append-only revocation event that withdraws
    a previous `approve_create` without touching the receipt it revokes;
    backfilled on run provenance rather than wall-clock recency, and
    canonical-write-free; semantic triggers keep the mutable projection honest —
    its pointer must name the receipt it IS, its `review_status` must match the
    immutable revocation record for that receipt, a revocation may only withdraw
    the approval the projection currently represents, and a deferred constraint
    trigger on BOTH tables re-checks that equivalence at COMMIT
20. atomic source publication (0034) — the append-only publication receipt that
    binds one production source identity, one 11/11 D062 PASS and one explicit
    human publication authorization to one canonical hotel; production-only by
    CHECK made true of the identity by composite FK, one hotel per identity and
    one identity per hotel; the cited approval must be the CURRENT, ACTIVE,
    unwithdrawn one about the CURRENT observation, and the canonical row —
    including name, address and country — must say what that evidence says;
    a deferred constraint trigger on BOTH write origins makes the receipt and the
    identity's `resolved_eligible` promotion one fact in BOTH directions, so
    neither can exist without the other. The migration refuses to run against a
    database that already carries an unaccountable `resolved_eligible` identity,
    and publishes nothing itself
21. mail account, consent and the private communication boundary (0035) — the
    Phase-B privacy plane: one owning user per provider account, an append-only
    consent history with a separate default-OFF network-contribution permission,
    a current projection composite-FK'd to the decision it represents, an
    explicit deletion request distinct from disconnecting, and an RLS posture
    that deliberately gives admin/editor NOTHING. No OAuth credential column
    exists, and the migration connects no mailbox and infers no consent
22. Gmail OAuth connection, reconnect and disconnect (0036) — the first
    long-lived secret in the system, and the `private` schema that keeps it out
    of reach. See §5i

Every migration must be reproducible from an empty database.