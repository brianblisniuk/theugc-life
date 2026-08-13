# theugc.life — RESEARCH_PROMPT_TEMPLATE.md
Version: 1.0
Purpose: Standard prompt for all future hotel/contact research

Use this template whenever generating a new destination dataset. Replace bracketed variables.

---

You are researching hospitality properties for **theugc.life**, a professional database and workflow platform for travel UGC creators.

## Objective

Research high-quality accommodation properties in **[DESTINATION]** and return structured property/contact data that conforms exactly to theugc.life's canonical research contract.

Prioritize data quality and provenance over volume. Do not guess missing values merely to complete a row.

## Property selection

Target properties that are plausible collaboration prospects for travel content creators, including relevant:
- hotels
- resorts
- boutique hotels
- aparthotels
- lodges
- villas/other hospitality properties only when commercially relevant

Do not include unrelated businesses.

## Contacts

For each property, search in priority order for:
1. Marketing
2. PR / Communications
3. Social Media
4. Partnerships
5. Events / Commercial
6. General contact
7. Reservations only if no more relevant route is available

Named decision-maker contacts are preferred, but generic official marketing/PR mailboxes are valid.

Never invent an email based on a domain pattern unless it is explicitly labeled `inferred`.

## Verification

Each contact must use exactly one verification status:
- `verified` — explicitly published by hotel/brand/operator/authorized representative or equivalent authoritative source
- `probable` — strong indirect evidence but insufficient for verified
- `inferred` — reconstructed/guessed pattern
- `unverified` — present in research without sufficient supporting evidence
- `invalid` — malformed/masked/obsolete/unusable

Do not call an inferred email verified.

## Required output

Return three tables/sheets with these exact fields.

### PROPERTIES

`source_property_id, property_name, brand_name, hotel_type, star_rating, country_code, region, city, destination_name, parent_destination_name, address, latitude, longitude, website_url, instagram_url, source_url, notes`

Rules:
- `source_property_id` must be a stable ID within this research batch, e.g. `bali-001`.
- `country_code` must be ISO alpha-2.
- `hotel_type` must be one of: hotel, resort, boutique_hotel, aparthotel, hostel, villa, residence, guesthouse, lodge, other, unknown.
- Leave unknown fields blank. Do not guess.

### CONTACTS

`source_property_id, contact_name, job_title, department, email, phone, linkedin_url, contact_scope, organization_name, verification_status, source_url, verified_at, notes`

Rules:
- one row per contact/endpoint;
- multiple contacts per property are allowed;
- generic mailboxes have blank `contact_name`;
- `department` must be one of: marketing, pr, communications, social_media, partnerships, events, sales, reservations, general, other, unknown;
- `contact_scope` must be one of: property, brand, group, operator, agency, unknown;
- `organization_name` is the explicit name of the brand/group/operator/agency the
  contact belongs to. Provide it whenever `contact_scope` is brand, group,
  operator, or agency and the organization is known. Never put a person's name,
  an email address, or a property key in `organization_name`; leave it blank if
  the organization identity is genuinely unknown (it will be flagged for review);
- if an email is masked or incomplete, do not put it in `email`; describe it in notes and mark invalid evidence separately;
- `verified_at` only when a real verification date is known.

### EVIDENCE

`source_property_id, claim_type, source_type, source_url, verification_status, observed_at, notes`

Use this for important claims beyond basic property existence.

`claim_type` must be one of:
- property_exists
- contact_confirmation
- brand_relationship
- operator_relationship
- agency_representation
- creator_collaboration_evidence
- other

`source_type` must be one of:
- official_website
- official_social
- official_media_kit
- official_privacy_policy
- authorized_representative
- public_registry
- reputable_third_party
- research_compilation
- unknown

## Creator-collaboration evidence

If you find evidence that the property has previously worked with creators/influencers/UGC, record it ONLY in the EVIDENCE table as `creator_collaboration_evidence` with the exact supporting source.

Do not invent reply rates, collaboration counts, response speed or any live creator-intelligence metric.

## Groups / operators / agencies

Do not create hotel rows for PR agencies, management companies, hotel groups or operators.

If a corporate/agency contact represents a property, attach it to that property's `source_property_id`, set the appropriate `contact_scope`, provide the explicit `organization_name`, and explain the relationship in notes/evidence.

If one contact represents multiple properties, repeat the contact row for the relevant property IDs while preserving the same source and scope. Do not pretend they are separate people.

## Sources

Prefer in this order:
1. official property website
2. official brand/operator/group website
3. official social/profile/media kit/privacy page
4. authorized representative
5. public registry / reputable third-party source

Avoid data brokers when a better first-party source exists.

Every contact intended to be `verified` must have a supporting `source_url`.

## Final quality summary

After the tables, provide only aggregate QA numbers:
- properties researched
- properties with at least one contact
- properties with marketing/PR/communications contact
- verified contacts
- probable contacts
- inferred contacts
- properties with no usable email
- creator-collaboration evidence records
- rows requiring manual review

Do not count inferred contacts as verified.

---

The output should be machine-importable with minimal normalization. Accuracy and traceability are more important than maximizing the number of rows.
