# theugc.life — HOTEL_DATA_CONTRACT.md
Version: 1.0
Status: Approved canonical contract for hotel/contact research

## 1. Purpose

This document defines the format future hotel research should produce.

> **This is the RESEARCH / STAGING contract, and it deliberately tolerates
> incompleteness.** A research record may lack coordinates, stars, contacts and
> photography and still be a valid research record. The stricter rule for a
> **canonical publishable hotel** lives in
> [`PROPERTY_CONTENT_COVERAGE_CONTRACT.md`](PROPERTY_CONTENT_COVERAGE_CONTRACT.md)
> §7 (D062) and binds at the promotion boundary, not here. Nothing below is
> relaxed by that contract, and nothing below authorises publication.

The contract is designed from product requirements, not from any legacy spreadsheet. Existing messy files are one-time migration inputs and MUST adapt to this contract, never the reverse.

## 2. Canonical research unit

One research record represents one **hotel/property**. Contacts are child records and evidence is attached explicitly.

A property record should be able to exist even when no contact has been found yet.

## 3. Property fields

Required:
- `property_name`
- `country_code` — ISO 3166-1 alpha-2
- `destination_name` — commercial destination/city/area used for discovery
- `source_url` — URL supporting that the property exists or the researched fact

Strongly preferred:
- `destination_slug` — the canonical destination slug (DESTINATION_CATALOG.md §3). SHOULD be supplied when the research targets an already-approved canonical destination; it is the preferred deterministic destination identity. Legacy adapters may leave it null. The importer never invents a slug from ambiguous free text.
- `city`
- `region`
- `address`
- `latitude`
- `longitude`
- `website_url`
- `instagram_url`
- `brand_name`
- `hotel_type`
- `star_rating` — the **hospitality star classification**, never a guest-review
  score (D060). See §3.1.

Optional:
- `parent_destination_name`
- `notes`

### hotel_type taxonomy

Use only:
- `hotel`
- `resort`
- `boutique_hotel`
- `aparthotel`
- `hostel`
- `villa`
- `residence`
- `guesthouse`
- `lodge`
- `other`
- `unknown`

Do not invent new types during research. Unknown is acceptable.

`hotel_type` is descriptive metadata. It is **not** the V1 eligibility gate —
eligibility is "physical hospitality property + resolved 4/5-star
classification" (D060). A `villa` or `residence` with a valid 4/5-star
classification is in scope; a `hotel` without a resolved classification is not
yet.

### 3.1 star_rating is a hospitality classification

`star_rating` records the property's **hotel/hospitality star classification**.

It is never a Google review score, a Booking guest review score, an Expedia
review score, a TripAdvisor rating, or any other user-review score. Both are
"out of five"; only one of them is a classification an authority issued.

- Never infer stars from review scores.
- Never average conflicting classifications — 4 and 5 do not make 4.5.
- Never fabricate a missing classification. Leave it null.
- Unknown is a **review state**, not a below-scope exclusion (D060, D061).

A classification supplied without supporting provenance may stay in research, but
it cannot reach publication: star-classification provenance is a publishability
condition (D062).

## 4. Contact fields

A property may contain zero or many contact records.

For each contact:
- `contact_name` — nullable for generic mailboxes
- `job_title` — nullable
- `department`
- `email` — nullable if no email is known
- `phone` — nullable
- `linkedin_url` — nullable
- `contact_scope`
- `organization_name` — nullable. Explicit organization identity. Required *when known* whenever `contact_scope` is `brand`, `group`, `operator`, or `agency`. A person is not an organization: this value is NEVER derived from `contact_name`, an email address, or a property key. If it is missing for a broader-than-property scope, the contact stays attached to the property and is flagged `organization_identity_missing` for review.
- `verification_status`
- `source_url`
- `verified_at` — nullable if not actually verified
- `notes` — nullable

### department taxonomy

Use only:
- `marketing`
- `pr`
- `communications`
- `social_media`
- `partnerships`
- `events`
- `sales`
- `reservations`
- `general`
- `other`
- `unknown`

### contact_scope taxonomy

Use only:
- `property`
- `brand`
- `group`
- `operator`
- `agency`
- `unknown`

## 5. Verification status

This is independent from whether an email is syntactically valid.

### `verified`
The endpoint/person is explicitly published by the hotel, brand, operator, agency, authorized representative, or other authoritative source.

### `probable`
Strong evidence exists, but the source is indirect or role recency is uncertain.

### `inferred`
The value was reconstructed from a naming/domain pattern or other inference.

### `unverified`
The value exists in research but does not have sufficient evidence to classify as probable/verified.

### `invalid`
Malformed, masked, known-bounced, obsolete, or otherwise unusable.

Never promote `inferred` to `verified` because the format looks plausible.

## 6. Evidence fields

Every important research fact should have explicit provenance.

For each evidence item:
- `claim_type`
- `source_type`
- `source_url`
- `verification_status`
- `observed_at` — nullable
- `notes` — nullable

### claim_type initial taxonomy
- `property_exists`
- `contact_confirmation`
- `brand_relationship`
- `operator_relationship`
- `agency_representation`
- `creator_collaboration_evidence`
- `other`

### source_type initial taxonomy
- `official_website`
- `official_social`
- `official_media_kit`
- `official_privacy_policy`
- `authorized_representative`
- `public_registry`
- `reputable_third_party`
- `research_compilation`
- `unknown`

## 7. Critical distinction: editorial evidence vs creator intelligence

Research may establish:

`Evidence this hotel has worked with creators.`

That is editorial evidence.

Research NEVER creates:
- `outreach_events`
- reply rates
- creator activity
- creator collaboration counts
- response-time metrics

Live creator intelligence can only come from actual creator workflow/outcome data inside theugc.life.

## 8. Organization handling

Hotel groups, operators, management companies and PR agencies are not hotel properties.

Research should identify them using `contact_scope` **plus an explicit `organization_name`** and relationship evidence, rather than creating fake hotel rows. An organization is only recognized from an explicit organization name (or explicit structured relationship evidence) — never inferred from a contact person's name, email address, or property key.

The canonical database may model organizations separately when required by Sprint 1 implementation, but the property remains the discovery unit shown to creators.

## 9. Recommended future research output

Preferred interchange format: UTF-8 CSV or XLSX with one `properties` sheet and one `contacts` sheet.

### `properties` sheet

`source_property_id, property_name, brand_name, hotel_type, star_rating, country_code, region, city, destination_name, destination_slug, parent_destination_name, address, latitude, longitude, website_url, instagram_url, source_url, notes`

### `contacts` sheet

`source_property_id, contact_name, job_title, department, email, phone, linkedin_url, contact_scope, organization_name, verification_status, source_url, verified_at, notes`

A third optional `evidence` sheet may be used:

`source_property_id, claim_type, source_type, source_url, verification_status, observed_at, notes`

## 9.1 Relationship to inventory coverage

Research is one input to a destination's **coverage universe**, not the whole of
it (`PROPERTY_CONTENT_COVERAGE_CONTRACT.md` §4). A destination is complete when
every eligible property in that universe is resolved — not when a research batch
is finished.

Research also never establishes that a property is *the only* property, and a
research batch's size is never a destination's inventory target (D061).

## 10. Research quality rule

A smaller dataset with clear provenance is preferred over a larger dataset of guessed contacts.

The research process should never invent missing values merely to complete a row.
