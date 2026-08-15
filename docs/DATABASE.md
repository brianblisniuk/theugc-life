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
- `star_rating numeric NULL`
- `description_short text`
- `active_status text NOT NULL DEFAULT 'unknown'`
- `editorial_verified_at timestamptz NULL`
- `editorial_verification_status text NOT NULL DEFAULT 'unverified'`
- timestamps

Active: `active`, `temporarily_closed`, `closed`, `unknown`.
Verification: `verified`, `needs_review`, `stale`, `unverified`.

Do not store a permanent boolean `creator_friendly`.

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

Every migration must be reproducible from an empty database.
