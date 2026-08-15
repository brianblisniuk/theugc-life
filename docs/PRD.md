# theugc.life — Product Requirements Document (PRD) v1.0

**Status:** Approved product specification for MVP implementation  
**Primary implementation agent:** Claude Code / Claude Cowork  
**Product language:** English  
**Internal documentation language:** English  
**Initial commercial model:** Free + Creator Destination Pass + Creator Pro  
**Primary market:** Travel UGC creators, initially creator-side; hotel/brand marketplace is post-MVP  
**Last updated:** 2026-08-12

---

## 1. Product Definition

### 1.1 What theugc.life is

theugc.life is the operating system for travel UGC creators.

It combines:

1. A worldwide, editorially maintained database of hotels and hospitality brands that work with creators. *Curated* here means "researched and provenance-backed", never "a selected subset" — a destination's inventory is complete, not capped (D055, D061).
2. Verified and time-stamped hotel marketing/contact information.
3. A creator-specific CRM for saving hotels, planning trips, pitching, following up, negotiating, and tracking collaborations.
4. A proprietary intelligence layer derived from anonymized creator workflow events.
5. A public data layer that exposes safe, aggregated signals such as creator activity, reply behavior, and collaboration recency without revealing contributors.
6. A creator portfolio/profile layer.
7. Later: AI-assisted outreach, connected email, community features, brand accounts, and a two-sided creator↔brand marketplace.

### 1.2 Core product thesis

The initial hotel/contact database creates immediate value, but it is not the long-term moat.

The defensible asset is the outcome graph generated after creators use the platform to manage their real outreach:

> Database → Pitches → Outcomes → Proprietary Data → Better Intelligence → Better Creator Decisions → More Usage → More Data

Core strategic principle:

> Anyone can scrape hotel contact data. Nobody can scrape what happens after the creator presses Send.

### 1.3 What theugc.life is not

MVP is not:

- A generic CRM.
- A social network.
- A Discord replacement.
- A review website with free-text reviews.
- A points/coins/XP system.
- A leaderboard of collaborations.
- A mass-email automation platform.
- A hotel marketplace yet.
- A native mobile application.
- A creator rating system.

---

## 2. MVP Goals

MVP must validate four hypotheses.

### H1 — Discovery value
Creators will pay to access a complete, useful, fresh database of hotels and contacts.

"Complete" is the operative word: for a supported destination it means every eligible property in that destination's coverage universe (D055, D061), not a curated selection.

### H2 — Workflow value
Creators will manage part of their outreach inside theugc.life instead of immediately exporting contacts to spreadsheets, Notion, or another CRM.

### H3 — Data flywheel
While creators manage their work, the platform will capture enough structured outreach outcomes to create useful collective intelligence.

### H4 — Retention
CRM + trips + live intelligence will create reasons to return weekly and support annual renewal.

---

## 3. Non-Goals for MVP

The following are explicitly out of scope unless this PRD is amended:

- Creator↔brand marketplace.
- Brand dashboard.
- Brand payments to creators.
- Creator-to-creator direct messaging.
- Global social feed.
- Free-text hotel reviews.
- Complex community reputation.
- Points, XP, coins, credits.
- Cashback or economic incentives for contributing data.
- Leaderboards.
- AI matching scores.
- Autonomous mass outreach.
- Connected Gmail/Outlook sending in first implementation phase.
- Native iOS or Android apps.
- Creator ratings by brands.

---

## 4. User Types

### 4.1 Anonymous Visitor
Can browse safe public hotel/destination intelligence and public creator portfolios.

### 4.2 Free Creator
Registered creator with limited workspace functionality.

### 4.3 Creator Destination Pass User
Paid creator with premium access for one destination for a fixed period.

### 4.4 Creator Pro User
Paid annual creator with worldwide premium access.

### 4.5 Editor
Internal role responsible for hotel/contact database maintenance.

### 4.6 Admin
Internal business/operations role with account, entitlement, verification, and platform management permissions.

### 4.7 Future Brand User
Reserved conceptually only. Not implemented in MVP.

---

## 5. Commercial Plans

### 5.1 Free
Purpose: demonstrate that the opportunity and the proprietary data asset exist.

Free creators may:

- Discover **all publishable hotels worldwide** (D049 — there is no gated hotel inventory).
- View hotel basic/public information.
- View the approved **Public Intelligence** layer where confidence and privacy thresholds allow (§12.8).
- Use the limited creator workspace under the configured Free limits: save up to 10 hotels, 5 active pipeline items, 1 active trip.
- Maintain a basic creator profile.

Free does **not** receive:

- Premium hotel contacts.
- **Premium Intelligence** (§12.8).
- AI outreach.

**Discoverable ≠ fully unlocked.** A Free creator can open any hotel, understand
that creator activity exists there, and see plainly that richer intelligence and
actionable contacts are locked. Nothing is hidden from the catalogue to create
scarcity.

Free limits must be configuration-driven, not hardcoded in UI business logic.

### 5.2 Creator Destination Pass
Working commercial name: **Creator Destination Pass**.

**V1 commercial contract (D051):**

- **USD 39.**
- **30 days.**
- **One destination.**
- Price and duration must remain configurable.

Job to be done: *"I'm going to Bali and I want to get collaborations."* This is
the low-friction paid acquisition product, bought by a creator with a trip
already in view.

Includes inside the entitled destination (and its valid descendant
destinations), per **D056**:

- **Premium Intelligence** (§12.8).
- Premium/actionable hotel contacts.
- The **full approved pipeline/workflow**: all pipeline states and transitions,
  the follow-up/outreach lifecycle, and the collaboration lifecycle.
- **Relationships in the entitled destination are not constrained by the Free
  saved/open/engaged workspace limits** (§5.1, D042). A creator pitching a
  destination works through far more than five hotels.
- Trips.
- Creator profile and portfolio.

**The destination has no property cap** (D055). A Pass covers *all* in-scope
properties in that destination's coverage universe — not a curated subset.

Outside the entitled destination the creator falls back to the Free experience:

- **Hotel discovery remains worldwide** (D049) — a Pass never restricts what can
  be found.
- Public Intelligence remains visible.
- Premium Intelligence and premium contacts remain locked.
- Normal Free-tier workspace capabilities and limits apply.
- User is offered another Destination Pass or Creator Pro.

**A paid Pass never removes a right the account would have had as Free.** Paying
is strictly additive.

On expiry:

- Premium Intelligence for that destination locks again.
- Premium contacts lock again.
- **Creator-owned historical pipeline, outreach and collaboration data does not
  disappear** and remains readable (§11.10, PERMISSIONS.md §8).

Important: “CDP” may be used internally, but public marketing should prefer the full name because CDP commonly means Customer Data Platform.

### 5.3 Creator Pro
**V1 launch price: USD 199/year, worldwide (D052).**

The USD 299 reference and USD 249 later prices remain future pricing
hypotheses, not commitments. Pricing must be editable without code deployment.

Job to be done: *"I'm a travel creator and I want theugc.life to be my operating
system."*

Includes, worldwide:

- **Premium Intelligence** (§12.8).
- All premium/actionable hotel contacts.
- Full CRM/workflow scope, unconstrained by the Free workspace limits (D056).
- Trips.
- Creator portfolio/profile.

Future AI outreach and community capabilities may become Pro benefits when they
are genuinely built and separately approved.

Do not promise “all future features forever”.

### 5.3.1 Plan matrix (product semantics, not literal UI copy)

| | Free | Destination Pass — $39 / 30 days / 1 destination | Creator Pro — $199/year |
|---|---|---|---|
| Worldwide hotel discovery | Yes | Yes | Yes |
| Hotel basics | Yes | Yes | Yes |
| Public Intelligence | Yes | Yes | Yes |
| **Premium Intelligence** | No | Entitled destination | Worldwide |
| **Premium contacts** | No | Entitled destination | Worldwide |
| CRM / workspace | Limited by Free limits | **Unlimited inside the entitled destination**; Free limits elsewhere | Full, worldwide |
| Trips | 1 active | Approved scope | Yes |
| Creator profile / portfolio | Basic | Yes | Yes |

The hotel is never the premium object (D049). What is sold is richer
intelligence, actionable contacts, and the capacity to act on the opportunity.

Destinations are **not capped** (D055): a Pass covers every in-scope property in
that destination's coverage universe, however many that turns out to be.

### 5.4 Referral Program
Economic incentives are permitted only for customer acquisition/referral.

No creator receives money, discounts, credits, or free renewal for contributing hotel data or outreach outcomes.

---

## 6. Core Navigation

Authenticated app navigation must remain simple:

1. Home
2. Discover
3. Pipeline
4. Trips
5. Profile

Secondary:

- Account
- Billing / Upgrade

No additional primary navigation item may be added without product approval.

---

## 7. Core Screens

## 7.1 Dashboard / Home

Purpose: become the creator’s operating homepage.

Must show:

- Greeting.
- Next/upcoming trip summary.
- Follow-ups due.
- Recommended hotels relevant to active/upcoming trip.
- Destination intelligence snapshot where data exists.
- Personal activity summary for current month.

Example blocks:

- “3 follow-ups due.”
- “Barcelona · Sep 12–19 · 18 hotels saved · 7 pitched · 3 replied · 2 collaborations.”
- “12 creator-active hotels match your Bali trip.”

MVP recommendation logic may be rules-based. Do not claim AI matching unless actual AI matching exists.

---

## 7.2 Discover

Purpose: hotel discovery and initial wow factor.

**Map coverage is 100% of publishable inventory (D054).** Every hotel Discover
lists has canonical coordinates and appears on the map; coordinates are a
publishability precondition, not later enrichment. The unmapped state in the UI
is a defensive fallback for bad data escaping validation, not a planned
condition. Coordinates are never fabricated — an unlocated hotel is held back
from publication.

Must include:

- World map.
- Search by destination/hotel.
- List/card view synchronized with map.
- Filters:
  - country
  - destination
  - hotel category/type
  - creator activity
  - collaboration type where reliable
  - last verified

Hotel card must include at minimum:

- Hotel name.
- Destination.
- Category/type.
- Creator activity label where available.
- Last observed creator interaction label where safe.
- CTA: View hotel.

Premium contact details must never appear directly on map cards.

---

## 7.3 Hotel Detail — Authenticated

This is a critical screen.

### Header

- Hotel name.
- Destination.
- Category / star classification if known — the hospitality classification, never
  a guest-review score (D060).
- Website.
- Instagram.
- Map link.
- Save/Add to Pipeline.

### Creator Intelligence

Display only according to confidence/privacy rules.

Potential fields:

- Creator Activity: High / Medium / Low / Emerging.
- Reply rate.
- Typical reply time.
- Last observed creator interaction.
- Reported collaboration types.
- Observation count/confidence where appropriate.

High-value copy example:

> Creator collaboration observed 9 days ago.

This copy may only be used when supported by qualifying collaboration events.

### Contact Section

Premium data may include:

- Name.
- Role/department.
- Email.
- Phone if available.
- LinkedIn if available.
- Last verified date.

Permissions depend on entitlement.

### Your Activity

Private creator-specific relationship to hotel.

Examples:

- Not contacted yet.
- Saved.
- Pitched Aug 3.
- Waiting 9 days.
- Follow-up due.
- Replied.
- Negotiating.
- Collaboration observed.

Private activity must never be visible to other creators.

---

## 7.4 Pipeline

Two views:

- List.
- Board/Kanban.

Allowed pipeline statuses:

1. saved
2. planned
3. pitched
4. replied
5. follow_up
6. negotiating
7. won
8. closed

Changing state may create structured domain events.

Pipeline is not a “report submission” UI.

Important product rule:

> There is no “Submit Report” concept in the creator UX. Creators update their own workflow; the system derives intelligence from that behavior.

---

## 7.5 Trips

Purpose: connect destination planning, hotel discovery, and outreach.

Trip properties:

- Destination.
- Start date.
- End date.
- Status.
- Private by default.

Trip workspace must show:

- Target hotels.
- Hotels pitched.
- Replies.
- Negotiations.
- Confirmed collaborations.
- Follow-ups due.
- CTA to discover more hotels in destination.

Users may later opt to expose destination availability on their public portfolio; default must remain private.

---

## 7.6 Creator Profile

### Private profile data

May include:

- Display name.
- Username.
- Home base.
- Languages.
- Niches.
- Content formats.
- Social accounts.
- Website.
- Portfolio assets.
- Travel dates.
- Previous collaborations.

Do not request unnecessary fields during MVP onboarding.

### Public portfolio

Public route such as:

`/creators/[username]`

May show:

- Creator name.
- Profile image.
- Short bio.
- Niche/content types.
- Portfolio media.
- Public social links.
- Publicly opted-in upcoming destinations.
- Past brand logos if manually added and legally appropriate.

The portfolio should be usable as the URL a creator sends in outreach.

---

## 7.7 Destination Page

Public and authenticated variants.

Example route:

`/destinations/bali`

Must support:

- Hotel count.
- Map.
- Hotel list.
- Public creator intelligence.
- Premium upgrade CTA.

Destination Pass CTA example:

> Unlock Bali

Creator Pro CTA example:

> All destinations. One membership.

---

## 7.8 Public Hotel Page

Public route:

`/hotels/[slug]`

Purpose:

- SEO.
- Social sharing.
- Creator acquisition.
- Future hotel claim/B2B lead generation.

May show:

- Hotel basic data.
- Safe aggregated creator activity.
- Last activity label if privacy threshold met.
- Reported collaboration types where confidence is sufficient.

Must not show premium contact details.

Must include creator CTA:

> View verified contact

Future-facing CTA:

> Are you this hotel? Claim this profile.

Claim can initially collect a lead only.

---

## 7.9 Milestone / Share Experience

Milestones are based on real creator activity, not points.

Examples:

- First pitch.
- First reply.
- First collaboration.
- 10/50/100/250 pitches.
- 5/10 collaborations.
- 3/5/10 countries.
- Year recap.

Share cards must not reveal specific hotels, active negotiations, contact data, or private notes.

Future annual “Your UGC Life” recap may include:

- hotels pitched
- replies
- collaborations
- countries
- distance traveled where computable/consented
- most active destination
- most active month
- number of hotel profiles helped keep fresh

Design target: Spotify Wrapped / running app shareability.

---

## 7.10 Admin

Admin must include:

- Hotel search/edit.
- Contact management.
- Verification history.
- Duplicate detection/merge workflow.
- Stale records.
- Creator contact signals.
- Flags.
- User/account lookup.
- Access/entitlement lookup.
- Database health dashboard.

Suggested database health metrics:

- Total hotels.
- Verified within 90 days.
- Stale.
- Missing contact.
- Contact bounce signals.
- Possible duplicates.
- Records needing review.

---

## 8. Data Architecture Principles

The implementation must preserve these decisions:

1. Hotel ≠ Contact.
2. Payment ≠ Access entitlement.
3. Pipeline state ≠ Event history.
4. Creator private activity ≠ Community intelligence.
5. Community signal ≠ Editorial truth.
6. Raw event ≠ Score.
7. Destination ≠ City necessarily.
8. Collaboration is an entity, not only `status = won`.
9. Public intelligence is derived only from safe aggregates.
10. Raw structured events are retained so future scores can be recalculated.
11. There is no primary “reports” table exposed to creators.
12. CRM behavior creates intelligence as a side effect.
13. Canonical coordinates are a publishability precondition, not enrichment
    (D054). Publishable inventory is 100% mapped.
14. A destination's inventory is complete, not capped (D055). Exclusions are
    explicit and auditable; a missing contact, insufficient intelligence or
    absent photography are field states, never reasons to omit a property.
15. Inventory coverage ≠ enrichment coverage (D061). "Do we have every eligible
    property?" and "how much do we know about each one?" are different
    questions, measured separately and never reported as one number. A
    destination is not coverage complete while any candidate in its coverage
    universe is still unresolved.
16. Canonical property identity is owned by theugc.life (D063). An external
    provider ID is a source identity attached to a hotel, never the hotel's
    primary key.
17. Star classification is a hospitality classification with provenance, never a
    guest-review score (D060).

### 8.1 Inventory scope, coverage and publishability (D060–D064)

The full contract is
[`PROPERTY_CONTENT_COVERAGE_CONTRACT.md`](PROPERTY_CONTENT_COVERAGE_CONTRACT.md).
It is authoritative on everything below; this section states only what a reader
of the PRD must not get wrong.

**V1 inventory scope.** Every unique, in-scope, **physical hospitality property
with a resolved canonical hotel star classification of 4 or 5 stars**, in each
supported destination. Stars means the hospitality classification — never a
Google, Booking, Expedia or TripAdvisor review score. Property type does not by
itself admit or exclude: hotels, resorts, boutique hotels, aparthotels, lodges,
residences and villa-style hospitality operations may all qualify. Corporate
HQs, agencies and other non-property organizations are not hotels.

**No cap.** A destination's inventory count is an **output** of its coverage
universe, never an input chosen by packaging. 724 eligible properties means 724.
Nothing may be described as "top 100", "selected", "curated" or "representative"
inventory. The 30-property Dubai set is a **technical pilot**, never Dubai
inventory.

**Coverage closure.** A destination may be called *coverage complete* only when
**zero** candidates from its coverage universe remain unresolved on a
coverage-critical dimension — identity, duplicates, hospitality-property status,
destination membership, active/closed status or star classification. Published
hotel count, coordinate coverage, photo coverage and contact coverage are all
irrelevant to that judgement. Reporting always carries both the resolved eligible
count and the unresolved count, and completeness is never computed over a
denominator that excludes unresolved records (D061).

**Promotion into `hotels` is publication** (D062). There is no
canonical-but-unpublished state in V1: a promoted property **is** a publishable
property, and a candidate that fails the conditions below stays in staging/review
rather than entering `hotels`.

**Publishable requires** resolved identity, a supported destination, a physical
hospitality property, not-known-closed, resolved scope status, a 4-or-5 star
classification **with provenance**, canonical coordinates **with provenance**,
and no unresolved identity conflict.

**Publishable does NOT require** a photo, any contact, a target contact, a
premium contact, Creator Network Intelligence, Hotel-Confirmed Intelligence or
collaboration evidence. Those are enrichment work queues; a missing one never
removes an eligible property from the destination.

**Not decided:** which inventory provider, which geocoder, star-source authority
hierarchy, match thresholds, media supplier priority, storage strategy, sync
cadence, or any destination's property count. See
[`PROPERTY_SOURCE_EVALUATION.md`](PROPERTY_SOURCE_EVALUATION.md).

---

## 9. Logical Database Schema

Exact SQL types and migration definitions belong in implementation, but logical entities are fixed here.

### 9.1 users

Fields:

- id
- email
- role
- status
- created_at
- updated_at
- last_active_at
- timezone
- locale

Roles:

- creator
- admin
- editor
- moderator (reserved)
- brand (reserved)

### 9.2 creator_profiles

- id
- user_id unique
- display_name
- username unique
- bio
- home_city
- home_country
- profile_photo_url
- primary_language
- languages
- creator_niches
- content_formats
- instagram_url / handle
- tiktok_url / handle
- youtube_url
- website_url
- portfolio_visibility
- public_profile_enabled
- created_at
- updated_at

### 9.3 portfolio_assets

- id
- creator_id
- type
- storage_path or external_url
- thumbnail_path
- title
- description
- sort_order
- is_public
- created_at

Types:

- video
- image
- link
- case_study

### 9.4 destinations

- id
- name
- slug
- type
- country_code
- country_name
- parent_destination_id nullable
- latitude
- longitude
- bounding_box
- is_sellable
- is_featured
- created_at
- updated_at

Types:

- country
- region
- island
- city
- area

### 9.5 brands

- id
- name
- slug
- website_url
- logo_url
- parent_brand_id nullable
- created_at

### 9.6 hotels

- id
- name
- slug
- brand_id nullable
- destination_id
- country_code
- address
- latitude
- longitude
- website_url
- instagram_url
- hotel_type
- star_rating
- description_short
- active_status
- editorial_verified_at
- editorial_verification_status
- created_at
- updated_at

Active statuses:

- active
- temporarily_closed
- closed
- unknown

Verification statuses:

- verified
- needs_review
- stale
- unverified

### 9.7 hotel_contacts

- id
- hotel_id
- first_name
- last_name
- job_title
- department
- email
- phone
- linkedin_url
- contact_type
- status
- source_type
- source_reference nullable
- verified_at
- last_checked_at
- created_at
- updated_at

Departments:

- marketing
- pr
- social_media
- communications
- partnerships
- sales
- general
- other

Statuses:

- active
- unverified
- stale
- invalid
- replaced

Source types:

- editorial
- public_source
- creator_signal
- hotel_claim

### 9.8 contact_signals

- id
- contact_id
- hotel_id
- creator_id
- signal_type
- created_at

Signal types:

- email_worked
- email_bounced
- person_changed
- wrong_department
- auto_reply
- other

Creator signals do not directly mutate master hotel contact truth.

### 9.9 verification_events

- id
- entity_type
- entity_id
- verification_type
- status
- performed_by
- source_type
- notes nullable
- created_at

### 9.10 access_entitlements

- id
- user_id
- access_type
- destination_id nullable
- source
- source_reference
- starts_at
- expires_at nullable
- status
- created_at
- updated_at

Access types:

- free
- destination
- pro
- admin

### 9.11 subscriptions

- id
- user_id
- provider
- provider_customer_id
- provider_subscription_id
- plan_code
- status
- price_paid
- currency
- started_at
- renews_at
- cancelled_at
- ended_at
- created_at
- updated_at

### 9.12 purchases

- id
- user_id
- provider
- provider_transaction_id
- product_type
- product_reference
- amount
- currency
- status
- purchased_at
- refunded_at

### 9.13 trips

- id
- creator_id
- destination_id
- name nullable
- start_date
- end_date
- status
- visibility
- created_at
- updated_at

Statuses:

- planning
- upcoming
- active
- completed
- cancelled

Default visibility: private.

### 9.14 trip_hotels

- id
- trip_id
- hotel_id
- priority
- created_at

### 9.15 pipeline_items

- id
- creator_id
- hotel_id
- trip_id nullable
- status
- priority
- private_notes
- next_followup_at nullable
- saved_at
- first_pitched_at nullable
- last_activity_at
- cycle_number or equivalent relationship-cycle model
- created_at
- updated_at

Must support multiple historical creator↔hotel relationship cycles.

### 9.16 outreach_events

Strategically critical append-oriented event table.

- id
- creator_id
- hotel_id
- pipeline_item_id
- event_type
- event_at
- channel nullable
- metadata JSONB
- source
- created_at

Event types:

- hotel_saved
- pitch_sent
- followup_sent
- reply_received
- positive_reply
- negative_reply
- contact_bounced
- offer_received
- negotiation_started
- deal_won
- deal_lost
- collaboration_started
- collaboration_completed
- creator_closed_pipeline

Channels:

- email
- instagram
- linkedin
- website_form
- whatsapp
- in_person
- other

Important:

Contact reveal/view is product analytics, not an outreach domain event.

### 9.17 collaborations

- id
- creator_id
- hotel_id
- pipeline_item_id
- status
- collaboration_type
- agreed_at
- start_date
- end_date
- terms_matched
- would_work_again
- private_value_amount nullable
- private_value_currency nullable
- created_at
- updated_at

Collaboration types:

- stay
- product
- paid
- stay_plus_paid
- other

Terms matched:

- yes
- partially
- no
- unknown

Statuses:

- agreed
- scheduled
- active
- completed
- cancelled

Financial collaboration values are private by default and excluded from public intelligence unless future privacy rules explicitly allow safe aggregation.

### 9.18 hotel_intelligence

Derived table. Not manually edited by creators.

Fields may include:

- hotel_id
- interaction_count_30d
- interaction_count_90d
- interaction_count_365d
- pitch_count
- reply_count
- positive_reply_count
- negative_reply_count
- collaboration_count
- reply_rate
- median_reply_hours
- last_creator_activity_at
- last_reply_at
- last_collaboration_at
- activity_level
- confidence_level
- calculated_at

Access Score and Experience Score may be added later, but readable metrics are preferred in V1.

### 9.19 destination_intelligence

- destination_id
- hotel_count
- creator_activity_count
- pitch_count
- reply_count
- collaboration_count
- reply_rate
- median_reply_hours
- active_hotels_count
- calculated_at

### 9.20 hotel_claims

- id
- hotel_id
- claimant_name
- claimant_email
- company
- status
- created_at
- reviewed_at

MVP behavior may be lead capture only.

### 9.21 public_creator_profile_views

- id
- creator_id
- viewer_session_id
- referrer
- utm_source
- hotel_id nullable
- viewed_at

Do not promise identifiable hotel viewer names unless identity can be reliably and lawfully established.

### 9.22 milestones

- id
- creator_id
- milestone_type
- value
- achieved_at
- share_card_generated
- shared_at nullable

### 9.23 share_cards

- id
- creator_id
- milestone_id nullable
- card_type
- period_start
- period_end
- public_token
- image_url
- created_at
- expires_at nullable

### 9.24 referrals

- id
- referrer_user_id
- referral_code
- referred_user_id nullable
- status
- conversion_purchase_id nullable
- reward_status
- created_at
- converted_at

### 9.25 admin_flags

- id
- entity_type
- entity_id
- flag_type
- source
- severity
- status
- created_at
- resolved_at
- resolved_by

Flag types may include:

- contact_bounced
- possible_duplicate
- hotel_closed
- data_conflict
- creator_signal_spike

---

## 10. Permissions

### 10.1 Anonymous

Can read:

- public hotel profiles
- public destination profiles
- safe aggregated intelligence
- public creator portfolios

Cannot read:

- premium contacts
- creator private pipeline/trips/notes
- raw outreach events

### 10.2 Free Creator

Additionally can:

- manage own creator profile
- save limited hotels
- use limited pipeline
- create limited trips

Cannot access premium hotel contacts.

### 10.3 Destination Pass

Can access **Premium Intelligence** and premium/actionable contacts where the
hotel belongs to an entitled destination or a valid descendant destination
according to access rules. Hotel discovery itself is never entitlement-gated
(D049).

### 10.4 Creator Pro

Can access worldwide **Premium Intelligence**, premium/actionable contacts, CRM,
trips, portfolio, and approved Pro features. Hotel discovery itself is never
entitlement-gated (D049).

### 10.5 Private creator data

Private data is owner-only by default.

Examples:

- pipeline items
- trips
- private notes
- negotiation details
- private collaboration values

Admin access to sensitive creator fields must be minimized and logged where feasible.

### 10.6 Public intelligence

Public/frontend collective intelligence must never query or expose raw creator events directly.

Use safe aggregate tables/views only.

### 10.7 RLS Principle

Supabase Row Level Security must enforce ownership server-side.

UI hiding alone is insufficient.

Conceptual examples:

`pipeline_items.creator_id = auth.uid()`

`trips.creator_id = auth.uid()`

---

## 11. User Flows

## 11.1 Anonymous → Free

1. Visitor lands on public site.
2. Explores hotel/destination/public map.
3. Opens hotel.
4. Sees useful public intelligence but locked contact.
5. CTA encourages account creation to save hotel/start workspace.
6. Signup.
7. Lightweight onboarding.
8. User enters app at relevant destination/hotel, not a generic dead dashboard.

### Onboarding questions

Keep minimal:

1. Where are you planning to create next?
2. What kind of creator are you?

Target: time to first useful hotel interaction under 2 minutes.

---

## 11.2 Free → Destination Pass

1. Free user views hotel in destination.
2. Attempts premium contact.
3. Upgrade modal explains destination-specific access.
4. User purchases Destination Pass.
5. Payment/webhook creates entitlement.
6. User returns directly to the hotel/contact they were viewing.

Do not redirect newly paid user to unrelated dashboard.

---

## 11.3 Free/Destination → Pro

Trigger examples:

- user tries premium hotel outside destination
- user hits free CRM limit
- pricing page

Messaging must emphasize worldwide access and complete system, not simply “more contacts”.

---

## 11.4 Pipeline: Mark as Pitched

When user moves or changes hotel to `pitched`:

Ask minimally:

- contact channel
- date (default today)

Create `pitch_sent` event.

Do not infer pitch from viewing/revealing a contact.

---

## 11.5 Pipeline: Reply

When moving `pitched → replied`:

Ask:

- reply date
- positive / negative / unclear
- optional offer indication: stay / paid / both / nothing yet

Create:

- reply_received
- positive_reply OR negative_reply where applicable
- offer_received if applicable

---

## 11.6 Negotiation

When starting negotiation:

- status → negotiating
- create negotiation_started

No unnecessary form.

---

## 11.7 Won

When moving to won:

Ask:

- what was agreed: stay / product / paid / stay + paid / other
- date agreed
- optional collaboration dates

Create:

- deal_won
- collaboration record

---

## 11.8 Collaboration Completed

At completion ask only contextually relevant structured questions:

- Did the terms match what was agreed? yes / partially / no
- Would you work with them again? yes / no

Create collaboration_completed.

This preserves the original two-layer concept:

- Access Intelligence: pitching/reply behavior.
- Experience Intelligence: actual collaboration quality.

---

## 11.9 Closed

When creator closes pipeline item ask why:

- no reply
- rejected
- not a fit
- timing
- other

Create appropriate deal_lost or creator_closed_pipeline event.

---

## 11.10 Expired Destination Pass

On expiry:

- do not delete pipeline/trips/history/notes.
- remove premium contact/intelligence access.
- keep creator workspace/history intact.

Message:

> Your Bali Pass has ended. Your work is still here.

Offer renewal or Pro.

---

## 11.11 Cancelled Pro

- User retains Pro until entitlement expiry.
- After expiry, downgrade access to Free.
- Never delete private CRM history because subscription ended.

---

## 11.12 Refund / Failed Renewal

Payment provider event changes commercial state.

Entitlement logic, not raw payment UI state, determines access.

Grace periods only if reliably supported by payment workflow.

---

## 11.13 Account Deletion

Architecture must support:

- deletion/anonymization of PII/private user data according to legal requirements
- anonymization of creator identifiers in retained historical domain events where legally appropriate
- retention of genuinely anonymous safe aggregates where lawful

Exact legal retention policy requires jurisdiction/privacy review before launch.

---

## 12. Intelligence Rules

### 12.1 General principle

Intelligence is derived from creator workflow events, not manual reviews.

### 12.2 Creator Activity

Do not count mere hotel views.

Do not treat contact reveal as creator activity.

Meaningful events may include:

- pitch_sent
- reply_received
- deal_won
- collaboration_started
- collaboration_completed

### 12.3 “Observed active creator collaboration”

May only be shown when supported by qualifying events such as:

- deal_won
- collaboration_started
- collaboration_completed

A pitch alone does not justify this label.

### 12.4 Reply Rate

Must be computed only from eligible pitches/outcomes according to defined event rules.

Avoid showing precise rates when sample size is too low.

### 12.5 Typical Reply Time

Based on pitch_sent → reply_received elapsed time for eligible interactions.

Median preferred over mean initially because response-time distributions may be skewed.

### 12.6 Confidence

Initial configurable hypothesis:

- 0–4 observations: insufficient
- 5–14: emerging
- 15–49: moderate
- 50+: strong

Thresholds must be configuration-driven.

### 12.7 Privacy-aware display

Low-density data should use coarse language.

Examples:

Low confidence:

> Creator activity detected

Higher confidence:

> Creators often receive replies

Strong confidence:

> Reply rate: 63%

Exact dates may be replaced with coarser labels if re-identification risk is material.

### 12.8 Public vs Premium Intelligence

**Approved V1 contract (D050).** There are exactly **two** deliberately designed,
browser-safe intelligence projections. Both are aggregates. Neither is a base
table.

#### 12.8.1 Public Intelligence

Purpose: show that theugc.life has proprietary creator-network knowledge, and
make Discover useful before payment.

Available to everyone, including anonymous visitors and Free creators, where
confidence and privacy thresholds allow:

- creator activity level;
- a broad creator-activity / freshness signal;
- a safe collaboration-presence signal where supported;
- confidence / data-availability state where useful.

#### 12.8.2 Premium Intelligence

Purpose: help a paying creator evaluate whether and how to pursue an
opportunity.

Available inside an entitled destination (Destination Pass) or worldwide (Pro).
May include, where derivable from real qualifying data:

- reply rate;
- typical reply-time range;
- richer recency of qualifying creator activity;
- collaboration types observed;
- stronger, detail-oriented network signals;
- data-strength / confidence context.

The exact field projection is designed in the implementation PR. **Do not invent
fields that are not derivable from real creator workflow data.**

#### 12.8.3 Privacy does not change by plan — non-negotiable

Free, Destination Pass and Pro obey **the same** contributor anonymity, minimum
observation thresholds, confidence thresholds, suppression rules, NULL-vs-zero
semantics, and protection of raw creator events. Premium buys more of the safe
aggregate; it never buys weaker privacy, and no price exposes a contributor.

A Pro subscription must never expose raw creator workflow data or base
intelligence tables. Premium Intelligence must **never** be implemented by
granting a browser role access to `hotel_intelligence`,
`destination_intelligence`, `outreach_events`, `collaborations`, or any
creator-level or raw aggregate source. Those remain trusted/server-only
(PERMISSIONS.md §9, D046, migration 0022). Premium Intelligence gets its own
scoped projection with its own suppression rules, entitlement-gated in the
database rather than in the UI.

Editorial/research evidence never manufactures network metrics (D027). Reply
rate, response time, interaction recency and similar signals derive only from
qualifying real creator workflow/outcome data, at every tier. Premium status
does not change this.

#### 12.8.4 Exact V1 metric contract (D058)

Implemented by migration `0026`. Analysis window is a trailing **365 days**,
measured on `event_at`, never `created_at`. Each metric has **metric-specific
publication thresholds**: reply metrics require both qualifying-cycle volume and
contributor diversity, while recency and collaboration-type signals rely on their
approved distinct-creator population floor. Payment lowers none of them.

| Metric | Layer | Sample floor | Contributor floor | Output |
|---|---|---|---|---|
| Creator activity level | Public | confidence >= `emerging` | 3 distinct creators in 90d | coarse label / NULL |
| Observed-collaboration presence | Public | — | 3 distinct collaborating creators in 365d | true / NULL — never `false` |
| Coarse recency band | Public | confidence >= `moderate` | 3 distinct creators in 90d, for the RECENT bands | `past_month` / `past_quarter` / `older` |
| **Reply rate** | Premium | 15 qualifying pitched cycles | 5 distinct creators | whole percent |
| **Typical reply time** | Premium | 10 qualifying replied cycles | 5 distinct creators who received one | band |
| **Recent creator activity** | Premium | — | 3 distinct creators in the band | `within_7_days` / `within_30_days` / `within_90_days` |
| **Collaboration types observed** | Premium | — | 3 distinct creators **per type** | type list |
| **Contributor sample** | Premium | — | 5 distinct creators | "Based on activity from N creators" |

**Reply rate** counts qualifying outreach **cycles**, not raw events: a
follow-up never becomes another denominator, and a creator's repeat cycle with
the same hotel counts once each time. Autoresponders, out-of-office replies,
delivery and bounce notifications, duplicate classification events and synthetic
activity do not count — a qualifying `reply_received` represents an actual human
hotel-side response.

**Typical reply time** is the median from initial qualifying pitch to first
qualifying reply in the same cycle, published as a band: Under 24h · 1–3 days ·
3–7 days · 1–2 weeks · 2+ weeks. Never an hour count, never a reply count.

Below any threshold the value is **NULL** — never `0%`, never `low`, never
`false`, never a negative claim. A measured zero above the thresholds *is*
published, because "measured, and nobody replied" is a real finding while "we
withheld it" is not.

**Premium never exposes raw outreach volume** — no pitch counts, reply counts,
event counts, cycle denominators or raw timestamps. The **contributor sample**
is the deliberate exception: a threshold-protected distinct-creator count shown
only at >= 5 creators, because it is what makes a percentage interpretable.

**Reply rate is no longer public.** §12.8 above once disclosed it at `strong`
confidence to everyone; `0026` removed the column from the public projection.

**No composite score.** There is no "Creator Friendly Score" and no 0–100 hotel
reputation number in V1. A metric must remain interpretable on its own.

#### 12.8.5 Locked, building and error (D059)

Four states, three of which are damaging to confuse:

- **available** — entitled, at least one metric cleared its floors;
- **locked** — the capability exists, this viewer is not entitled;
- **building** — entitled, but qualifying evidence is insufficient. Copy:
  *"Creator intelligence is building — track your outreach here and help make
  this hotel's insights more useful for the creator community."*
- **error** — a lookup or query failed. Never rendered as "not entitled", "no
  data" or "building".

Unknown ≠ zero. Unknown ≠ negative. Insufficient evidence ≠ bad hotel. There is
no "submit data" mechanic and no reward for contributing (D001, D002).

#### 12.8.6 Provenance never mixes (D057)

Three domains, permanently separate:

- **Research / editorial** — what theugc.life verifies. A trust layer. Never
  creates network metrics.
- **Hotel-confirmed** — what an authorized hotel representative states.
  *Future; not built.* Distinguishable internally as HOTEL CONFIRMED, never as
  "verified by theugc.life".
- **Creator Network** — derived only from qualifying creator workflow data.

"The hotel says it accepts paid UGC" and "creators have actually received paid
collaborations here" are different facts. A reply from a hotel **to
theugc.life** is not a creator reply and never enters reply-rate data.

---

## 13. Privacy and Trust Rules

1. Contributors are never publicly identified through intelligence.
2. Another creator cannot inspect another creator’s pipeline.
3. Private notes are never used for public intelligence.
4. Negotiation values are private by default.
5. Public intelligence reads aggregate/safe views only.
6. A creator signal is not automatically master truth.
7. Contact changes require verification workflow or sufficient trusted evidence.
8. Do not expose exact low-N activity in a way that can identify a creator.
9. Account deletion must be technically possible without corrupting aggregate analytics.
10. Connected email, when introduced, must use explicit OAuth authorization and minimal required scopes.

No free-text hotel review system in V1.

---

## 14. Contact Freshness and Verification

Every premium contact should support:

- verified_at
- last_checked_at
- source type
- status

User-facing language should prefer freshness:

> Verified July 28, 2026

rather than unverifiable absolute claims like “100% accurate”.

Creator may signal issues such as:

- bounced email
- person changed
- wrong department

Signals create review work; they do not directly mutate editorial truth.

---

## 15. Payments and Entitlements

Initial payment provider: Hotmart.

### 15.1 Separation rule

Payment record and access entitlement are different concepts.

A purchase/subscription event may create/update entitlement.

### 15.2 Supported commercial events

At minimum handle:

- successful purchase
- active subscription
- renewal
- cancellation
- expiration
- refund
- failed renewal where provider exposes it

### 15.3 Idempotency

Payment webhooks must be idempotent.

Repeated webhook delivery must not duplicate entitlements or purchases.

### 15.4 Destination access hierarchy

Conceptually:

```
if active_pro:
    premium_access = worldwide
elif active_destination_entitlement_for(hotel):
    premium_access = hotel_destination
else:
    premium_access = none
```

Destination hierarchy must support a pass for Bali granting access to child destinations such as Ubud/Seminyak when configured accordingly.

---

## 16. Product Analytics

Product analytics and domain intelligence events are separate systems.

### 16.1 Product analytics examples

- landing_viewed
- signup_started
- signup_completed
- onboarding_completed
- map_viewed
- hotel_viewed
- contact_unlock_clicked
- pricing_viewed
- checkout_started
- purchase_completed
- hotel_saved
- pipeline_opened
- trip_created
- share_card_created
- share_card_shared

### 16.2 Domain/business events

Stored in outreach event architecture:

- pitch_sent
- reply_received
- deal_won
- collaboration_completed

Do not use analytics events as source-of-truth for hotel intelligence.

---

## 17. North Star and Core KPIs

### 17.1 Product North Star

**Tracked Outreach Outcomes / month**

Outcomes include meaningful known results such as:

- reply_received
- deal_won
- deal_lost
- collaboration_completed

### 17.2 Outcome Coverage

```
known outreach outcomes / pitches sent
```

This measures how effectively the CRM captures what happens after a pitch.

### 17.3 Business KPIs

Track:

- visitor → signup
- signup → first hotel save
- free → Destination Pass
- free → Pro
- Destination Pass → Pro
- contact unlock attempts
- contact unlock → pipeline add
- pipeline add → pitch_sent
- pitch_sent → outcome recorded
- WAU / MAU for paid creators
- 30/90/180-day retention
- annual renewal
- refund rate
- churn
- referral conversion

### 17.4 Initial validation benchmarks

Benchmarks are hypotheses, not industry standards:

- Free → city/destination paid: >3–5%
- Destination → annual: >10–20%
- Paid users revealing ≥1 contact: >60%
- Contact reveals / active paid user / month: >5
- Reveal → pitch recorded: >40%
- Pitched → outcome recorded: >35% initially
- Outcome recorded with reminders/workflow: target >50%
- 30-day CRM reuse: >25–30%
- inconsistent/fraudulent structured events: <3–5%

These must be revisited after real cohort data.

---

## 18. Public Growth / Viral Layer

### 18.1 Public hotel intelligence pages

Primary viral/SEO loop:

Creator activity → hotel intelligence → public page → creator discovers theugc.life → joins/uses CRM → more data.

### 18.2 Public reports

Future route:

`/reports/[slug]`

Examples:

- Travel Creator Report — Barcelona 2026
- Most Responsive Hotel Destinations
- Hotel Creator Response Index
- The UGC Travel Index

Only publish metrics with sufficient sample size and methodological clarity.

### 18.3 Creator milestones

Generate shareable outputs based on creator’s own real career progress.

Do not reveal active hotel targets.

### 18.4 Potential future B2B loop

Public hotel page includes:

> Claim this profile

Future:

hotel claims → brand dashboard → campaign opportunity → creator demand → marketplace.

Not MVP.

---

## 19. Future Proprietary Analytics

The architecture must preserve the ability to answer questions such as:

- Which hotel brands reply fastest to creators?
- Which destinations are most open to paid UGC?
- Does following up improve conversion?
- What is median creator reply time by destination?
- Boutique vs chain reply behavior.
- Pitch-to-deal conversion by channel.
- Seasonality of creator collaborations.
- Number of pitches needed for one collaboration.
- Repeat collaboration rate.
- Stay vs paid vs hybrid collaboration mix.

Future creator benchmarking may show private comparisons like:

> Your response rate: 38%  
> Similar creators: 27%

Only after cohort size and privacy thresholds are sufficient.

This analytics layer may become valuable for creators, hotels, agencies, chains, enterprise customers, PR, and fundraising.

---

## 20. Routes

### 20.1 Public

- `/`
- `/pricing`
- `/hotels`
- `/hotels/[slug]`
- `/destinations/[slug]`
- `/creators/[username]`
- `/reports/[slug]`
- `/share/[token]`

### 20.2 Auth

- `/login`
- `/signup`
- `/forgot-password`
- `/onboarding`

### 20.3 App

- `/app`
- `/app/discover`
- `/app/hotels/[id]`
- `/app/pipeline`
- `/app/trips`
- `/app/trips/[id]`
- `/app/profile`
- `/app/profile/portfolio`
- `/app/account`
- `/app/billing`

### 20.4 Checkout

- `/checkout/destination/[slug]`
- `/checkout/pro`
- `/payment/success`
- `/payment/cancelled`

### 20.5 Admin

- `/admin`
- `/admin/hotels`
- `/admin/hotels/[id]`
- `/admin/contacts`
- `/admin/flags`
- `/admin/verifications`
- `/admin/users`
- `/admin/access`
- `/admin/database-health`

### 20.6 Reserved Future Routes

Do not implement yet:

- `/brands`
- `/brands/[slug]/dashboard`
- `/marketplace`
- `/campaigns`
- `/community`
- `/messages`

---

## 21. URL and ID Rules

- Public hotel URL uses human-readable slug.
- Internal app relationships use immutable UUIDs.
- Never use slug as foreign key.
- Destination slug must be unique in public routing context.
- Public share routes use non-guessable token.

---

## 22. Search and Filtering

MVP search must support:

- hotel name
- destination name
- country

Filters should be server-queryable, not purely client-side over full dataset.

Map must support marker clustering at scale.

Do not load every hotel/contact record into browser memory.

---

## 23. Admin Workflows

### 23.1 Stale Contact

1. Creator signals bounce/problem.
2. Contact signal is stored.
3. Admin/editor sees flag if threshold/rule triggers.
4. Editor verifies.
5. Contact is kept, replaced, marked stale, or invalid.
6. Verification event is stored.

### 23.2 Duplicate Hotel

Must support merge/canonicalization.

Merging must preserve references from:

- pipeline items
- outreach events
- contacts
- trips
- intelligence

Avoid destructive deletion that breaks historical relationships.

### 23.3 Hotel Closure

Editor can mark closed/temporarily closed while preserving history.

### 23.4 Database Health

Prioritize records requiring human action rather than manual review of entire database.

---

## 24. Error and Edge States

Implementation must explicitly handle:

- no hotels in destination
- hotel missing contact
- stale contact
- low-confidence intelligence
- expired Destination Pass
- cancelled Pro
- refunded purchase
- duplicate webhook
- failed payment state sync
- user without creator profile
- destination hierarchy mismatch
- deleted/closed hotel referenced in historical pipeline
- hotel slug changed
- duplicate hotel import
- creator attempts prohibited cross-user access
- creator closes collaboration without completing experience questions
- user deletes trip containing active pipeline items

No silent data loss.

---

## 25. Security Requirements

1. RLS enabled on all user-private tables.
2. Service-role keys never exposed client-side.
3. Premium contact authorization enforced server-side.
4. Admin routes require server-side role checks.
5. Payment webhooks validated using provider verification mechanism.
6. Webhooks idempotent.
7. Sensitive creator notes excluded from analytics/log payloads.
8. Audit important admin verification/merge actions where practical.
9. Rate-limit auth-sensitive and public scraping-sensitive endpoints where appropriate.
10. No bulk premium contact export in MVP unless explicitly approved later.

---

## 26. Suggested Technical Stack

Preferred implementation unless technical review finds a blocker:

- Next.js (App Router)
- TypeScript
- Tailwind CSS
- Supabase PostgreSQL
- Supabase Auth
- Supabase Storage
- Supabase Row Level Security
- Mapbox GL JS
- Vercel
- Resend for transactional product email
- Hotmart for initial payment/subscription flow
- PostHog or equivalent for product analytics

AI provider must be abstracted behind application service layer when implemented.

Do not hard-wire core domain model to one AI provider.

---

## 27. Email / AI Roadmap

### Phase A — MVP

- No connected inbox required.
- User can manage pipeline manually.
- Transactional reminders may be sent by theugc.life.

### Phase B — AI Outreach

- AI generates personalized outreach using creator profile + hotel context + trip context.
- Creator reviews/copies message.

### Phase C — Connected Email

- Gmail OAuth.
- Outlook OAuth.
- Send from creator’s own account.
- Store provider message ID.
- Detect replies where authorized.
- Update CRM with explicit rules.

Do not ask creators for raw email passwords.

Do not send autonomous mass campaigns.

Creator approval remains required for outbound messages unless future product policy explicitly changes.

---

## 28. Progressive Data Collection

Do not ask the original structured collaboration questionnaire in one block.

Capture data contextually:

### On pitch

- channel
- date

### On reply

- reply date
- positive / negative / unclear
- offer type if known

### On deal won

- collaboration type
- agreement date

### On completion

- terms matched
- work again yes/no

Goal: the creator feels they are maintaining their CRM, not completing surveys.

---

## 29. Design Principles

1. Professional, aspirational travel-creator aesthetic.
2. Product should feel like a career/work system, not a game.
3. Map has visual wow factor but dashboard becomes habitual home.
4. Intelligence must be understandable without explaining statistical models.
5. Avoid overwhelming tables and enterprise CRM complexity.
6. Primary actions should be obvious on mobile and desktop.
7. “Last verified” and recency should be prominent.
8. Locked premium data should show enough context to create desire, but not leak the premium value.
9. Milestones should feel like career achievements.
10. No fake urgency, fake social proof, or fabricated counts.

---

## 30. MVP Sprint Plan

> **Read §30.0 first.** The original plan below was written before implementation
> began, and the work did not land under those exact labels. §30.0 states what is
> actually built, where each original sprint's deliverables ended up, and what
> "Sprint 3" means from here. The original plan is preserved unedited as the
> historical record; where the two disagree, §30.0 describes reality.

### 30.0 As-built roadmap — current state and next phase

#### Delivered (Core V1 — audited and closed)

| Phase | Delivered |
|---|---|
| Sprint 0 / 0.1 | Repository, Next.js App Router, strict TypeScript, Tailwind, Supabase schema + RLS, auth, migrations, logging, analytics foundation, CI |
| Sprint 1A | Seed-import foundation: canonical contract, staging, validation, conservative entity resolution, dry-run reports |
| Sprint 1B | Destination catalog, review manifests, canonical promotion engine |
| Sprint 1C | 30-property Dubai canonical pilot promoted to production |
| Sprint 2A | Discover (search/filter/pagination) + Hotel Detail, entitlement-gated contacts |
| Sprint 2B | Save to Pipeline (transactional, limit-safe) |
| Sprint 2C | Pipeline transitions + trusted outreach event ledger |
| Sprint 2D | Negotiation → deal won → collaboration |
| Sprint 2E | Rebuildable hotel intelligence aggregation + privacy-safe public projection |
| Sprint 2F | Collaboration lifecycle + won-cycle closure |
| Sprint 2G | Pre-Sprint-3 core hardening: explicit ACL contract, session role resolution, pipeline pagination |

**The original "Sprint 3 — Data Flywheel" was delivered under Sprints 2C–2F.**
Outreach events, the collaboration entity, progressive event forms, intelligence
aggregation, the confidence system and the safe public intelligence view all
exist and are in production. Destination intelligence UI and the contact-signal
workflow from that original list remain unbuilt and are tracked as open scope,
not as a pending sprint.

Core V1 is audited and closed — see
[`docs/audits/CORE_V1_AUDIT_CLOSEOUT.md`](audits/CORE_V1_AUDIT_CLOSEOUT.md) and
[`docs/audits/PRE_SPRINT3_CORE_AUDIT.md`](audits/PRE_SPRINT3_CORE_AUDIT.md).

#### Current phase

**Visual Direction Gate — PASSED.** Visual Direction V1 is
**A2 — Sunlit Creator OS** (D047), with **Sun `#FFE01B`** as the approved primary
accent (D048). See [`docs/VISUAL_DIRECTION.md`](VISUAL_DIRECTION.md).

#### Next phase — the single meaning of "Sprint 3"

**Sprint 3 = Product Experience.** From this point forward the label refers only
to the implementation of Visual Direction V1 across the product surfaces. It
does not refer to the data flywheel, which is already built.

- **Sprint 3A** — Discover + map, implemented against A2.
- Later Sprint 3 sub-phases — Hotel Detail, Pipeline, Home, applied
  progressively as the visual language proves itself on real surfaces.

Sprint 3A has explicit prerequisites and explicit out-of-scope items recorded in
[`docs/VISUAL_DIRECTION.md`](VISUAL_DIRECTION.md) §21–§23. Sprints 4–7 and the
marketplace keep their original numbering and meaning below.

---

### Original MVP sprint plan (historical — written pre-implementation)

### Sprint 0 — Foundation

Deliverables:

- repository
- Next.js app
- TypeScript strict mode
- Tailwind
- Supabase project/config
- environment variable system
- auth foundation
- migration system
- base schema
- RLS foundation
- logging/error handling
- analytics foundation
- Vercel deployment pipeline
- docs directory

Definition of done:

- staging deployment works
- auth works
- migrations are reproducible
- no service credentials exposed client-side
- lint/typecheck/build pass

### Sprint 1 — Hotel Intelligence Database

Deliverables:

- hotel import/admin
- destinations
- brands
- hotel contacts
- hotel detail
- public hotel page
- Discover/map/search/filter
- basic public intelligence placeholders/derived data support
- entitlements
- Free/Destination/Pro authorization
- Hotmart purchase/subscription sync

Definition of done:

A paid user can reliably discover a hotel and view a premium contact according to entitlement.

This is the first sellable version.

### Sprint 2 — Creator CRM

Deliverables:

- save hotel
- pipeline list
- pipeline board
- pipeline states
- private notes
- follow-up date
- trips
- trip hotel targets
- dashboard basics

Definition of done:

A creator can manage a real hotel outreach workflow end-to-end manually.

### Sprint 3 — Data Flywheel

Deliverables:

- outreach event creation
- collaboration entity
- progressive event forms
- intelligence aggregation jobs/functions
- confidence system
- safe public intelligence view
- hotel intelligence UI
- destination intelligence UI
- contact signal workflow

Definition of done:

A creator workflow event can safely improve hotel intelligence without exposing the creator.

### Sprint 4 — Public Growth / Viral

Deliverables:

- improved public hotel pages
- destination landing pages
- share cards
- milestones
- public share routes
- report architecture placeholders
- hotel claim lead capture

Definition of done:

The product can generate public/shareable outputs without leaking premium contacts or private activity.

### Sprint 5 — AI Outreach

Deliverables:

- richer creator profile
- AI service abstraction
- hotel-aware pitch generation
- follow-up generation
- usage controls

Definition of done:

Creator can generate a personalized hotel pitch from real creator + hotel context and manually approve/use it.

### Sprint 6 — Connected Email

Post-MVP validation milestone.

Deliverables:

- Gmail OAuth
- Outlook OAuth
- send from own inbox
- reply detection where authorized
- CRM synchronization

### Sprint 7 — Community

Post-MVP.

Destination rooms, lightweight contribution identity, travel overlap, portfolio feedback.

No global feed unless separately approved.

### Marketplace

Explicitly post-MVP and requires separate PRD.

---

## 31. Acceptance Criteria — MVP Release

MVP cannot be considered ready until all of the following are true:

### Accounts

- User can sign up, log in, reset password, log out.
- Creator profile ownership is enforced.

### Database

- Hotels can be imported and edited.
- Contacts are independent entities.
- Destination hierarchy works.
- Verification dates/statuses are visible where appropriate.

### Access

- Free cannot access premium contacts.
- Destination user can access entitled destination contacts.
- Destination user cannot access non-entitled destination contacts.
- Pro can access worldwide contacts.
- Access is enforced server-side.

### CRM

- User can save hotel.
- User can add/update pipeline.
- User can create trip.
- User can associate hotel with trip.
- User can record pitch/reply/win/close.
- Private notes are owner-only.

### Intelligence

- Pitch/reply/collaboration domain events are persisted.
- Public intelligence does not expose creator_id.
- Low-sample intelligence is gated.
- “Observed collaboration” wording is only emitted from qualifying Creator
  Network data, and only above the contributor floor. "Confirmed" is reserved
  for hotel-confirmed intelligence and editorial verification (D057).

### Payments

- Successful purchase creates correct entitlement.
- Refund/cancellation/expiration updates entitlement correctly.
- Duplicate webhook delivery is safe.

### Admin

- Editor can update hotel/contact.
- Signals/flags can be reviewed.
- Verification history is recorded.

### Quality

- Typecheck passes.
- Lint passes.
- Production build passes.
- Critical flows have automated tests.
- RLS policies have permission tests.
- No known P0/P1 security bug.

---

## 32. Definition of Done for Every Feature

A feature is not done merely because UI renders.

Every feature must include where applicable:

1. Data model/migration.
2. Server-side authorization.
3. RLS policy.
4. Loading state.
5. Empty state.
6. Error state.
7. Mobile-responsive UI.
8. Analytics event.
9. Audit/log behavior where relevant.
10. Automated test for critical business rule.
11. Updated documentation.

---

## 33. Coding Agent Rules

These rules are mandatory for Claude Code or any implementation agent.

### 33.1 No product invention

Do not invent product behavior.

If implementation requires a decision not specified in this PRD or associated docs, stop and report:

- the unresolved decision
- why it blocks implementation
- 2–3 technically viable options
- recommended option

Do not silently choose.

### 33.2 No unsolicited features

Do not add:

- tables
- packages
- routes
- background jobs
- abstractions
- UI states
- permissions
- monetization behavior
- social features

unless required by this PRD or approved task specification.

### 33.3 Migrations first

All schema changes must be made through versioned migrations.

Never make undocumented manual production schema changes.

### 33.4 Security first

Do not trust client-side role/plan state.

Sensitive data access must be authorized server-side and/or with RLS.

### 33.5 Preserve history

Avoid destructive updates when historical data is strategically important.

Examples:

- do not delete hotel because it closed
- do not overwrite outreach history with only latest state
- do not mutate creator signal into editorial truth

### 33.6 Simplicity

Prefer the simplest implementation satisfying current PRD.

Avoid premature microservices, event buses, complex queues, and enterprise abstractions unless scale evidence requires them.

### 33.7 Explain before risky changes

Before any migration that may delete/rewrite data or any major dependency change, provide a migration/risk summary.

### 33.8 Keep docs synchronized

If an approved implementation changes behavior described in this PRD, update documentation in the same change set.

---

## 34. Repository Documentation Structure

Create and maintain:

```text
/docs
  PRD.md
  DATABASE.md
  PERMISSIONS.md
  EVENTS.md
  ROUTES.md
  ANALYTICS.md
  DESIGN_SYSTEM.md
  AI_RULES.md
  DECISIONS.md
  PROPERTY_CONTENT_COVERAGE_CONTRACT.md
  PROPERTY_SOURCE_EVALUATION.md
```

This PRD is the master product source of truth.

More detailed implementation docs may expand it but must not contradict it.

---

## 35. Recommended Decision Log Topics

`DECISIONS.md` should record significant architecture/product decisions such as:

- why no economic contribution incentive
- why CRM workflow replaces report submission
- why contacts are separate from hotels
- why payments are separate from entitlements
- why raw events are retained
- public aggregation privacy thresholds
- Destination Pass hierarchy behavior
- why marketplace is deferred
- email OAuth strategy

---

## 36. Open Items Requiring Validation, Not Immediate Product Debate

Items 1, 2 and 4 are **now fixed for V1** and are no longer open: Destination
Pass is USD 39 / 30 days (D051) and Pro launches at USD 199/year (D052). They
remain listed because the *conversion behaviour* at those numbers is still the
thing to measure — the price is decided, its performance is not.

Item 8 is likewise no longer an open question about *whether* a premium
intelligence layer exists: D050 fixes the two-layer contract. What remains to
test is which premium fields actually move conversion.

The rest remain hypotheses to test with real usage:

1. ~~Exact Destination Pass price: USD 29 vs 39.~~ **Fixed: USD 39 (D051).** Measure conversion at that price.
2. ~~Exact Destination Pass duration: initial recommendation 90 days.~~ **Fixed: 30 days (D051).** Measure renewal/upgrade behaviour.
3. Free saved/pipeline limits.
4. Launch Pro price conversion at USD 199 — **price fixed (D052)**; conversion still to be measured.
5. Upgrade conversion Destination → Pro.
6. Confidence thresholds for public intelligence.
7. ~~Which destinations to prioritize for marketing/data density despite worldwide database availability.~~ **The initial twenty are selected** (`INTELLIGENCE_ROADMAP.md` §11); which of them repays marketing spend fastest is still to be measured.
8. Which intelligence fields materially increase conversion.
9. Whether creator portfolio usage materially improves retention.
10. When connected email becomes worth implementation complexity.

These should be tested with analytics, not debated indefinitely.

---

## 37. Strategic Future State

The intended progression is:

### Phase 1
Curated hotel/contact database.

> Who should I pitch?

### Phase 2
Creator workflow / CRM.

> Who have I contacted and what should I do next?

### Phase 3
Collective intelligence.

> Who actually replies, how fast, and what kinds of collaborations occur?

### Phase 4
AI-assisted operation.

> Help me pitch and manage my creator business better.

### Phase 5
Two-sided marketplace.

> Connect active creators and brands/hotels directly.

### Phase 6
Industry data/analytics layer.

> Become a proprietary source of creator↔hospitality market intelligence.

Long-term positioning:

> theugc.life becomes the network that knows where creators actually get replies, deals and paid work — because creators already use it to manage their outreach.

---

## 38. Final Product Principle

The core behavioral principle for the entire platform is:

> The creator should never feel they are doing unpaid data-entry work for theugc.life.

They are managing their own creator career.

The platform captures structured outcomes from that natural workflow, anonymizes them, aggregates them, and returns improved intelligence to the whole network.

That is the central flywheel and must remain intact through implementation.

