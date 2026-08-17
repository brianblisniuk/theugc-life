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

Every migration must be reproducible from an empty database.
