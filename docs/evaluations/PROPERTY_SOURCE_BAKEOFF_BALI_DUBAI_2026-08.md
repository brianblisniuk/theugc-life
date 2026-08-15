# Property-source bake-off — Bali & Dubai

Date: **2026-08-15**
Governing contract: [`PROPERTY_CONTENT_COVERAGE_CONTRACT.md`](../PROPERTY_CONTENT_COVERAGE_CONTRACT.md) (D060–D064)
Specification: [`PROPERTY_SOURCE_EVALUATION.md`](../PROPERTY_SOURCE_EVALUATION.md)

> ## STATUS: HOTELBEDS CREDENTIALS AVAILABLE · LIVE RUN BLOCKED BY NETWORK EGRESS
>
> **No provider was measured. No provider is recommended. No star verdict is
> issued. The bake-off is NOT complete.**
>
> The strategy has changed: **HBX Group / Hotelbeds is now the active live
> evaluation target** and real evaluation credentials are held. Booking and
> Expedia are preserved as documented **future strategic sources** with direct
> access unavailable.
>
> The live run did not happen because `api.test.hotelbeds.com` is **blocked by
> this environment's network egress policy**, which returned
> `x-deny-reason: host_not_allowed`. **Zero Hotelbeds requests reached the
> provider, so zero of the 50/day quota was consumed** and the credentials remain
> **UNTESTED** — not invalid.

---

## How to read this document

Four sections, never mixed:

| | Meaning |
|---|---|
| **A. VERIFIED FROM OFFICIAL DOCUMENTATION** | Established from the provider's own developer site, with URL and access date |
| **B. MEASURED FROM LIVE API** | Produced by running the harness against the provider |
| **C. INFERENCE / RECOMMENDATION** | Our reasoning, clearly marked as reasoning |
| **D. BLOCKED / UNKNOWN** | What could not be established, and exactly why |

### Provenance of Section A

Every fact in Section A was **independently verified during external review on
2026-08-15 from official provider documentation**. Claude Code did **not** fetch
those pages: all three official documentation domains were blocked by this
environment's egress proxy (HTTP 403 on CONNECT), verified twice roughly two
hours apart, and the proxy recorded each denial as a policy denial rather than a
transient failure.

Each source is carried in the adapter descriptors with
`verifiedBy: "external_review"`, and a test asserts that attribution so it cannot
drift into an implied first-hand claim.

---

## A. VERIFIED FROM OFFICIAL DOCUMENTATION

### A.1 HBX Group / Hotelbeds Hotel Content API — ACTIVE EVALUATION TARGET

Sources (all external review, 2026-08-15): `developer.hotelbeds.com` —
`/documentation/getting-started/` · `/documentation/hotels/content-api/` ·
`.../how-use-content-api/` · `.../categories-category-group/` ·
`.../photos-images/` · `.../use-images/` · `.../api-reference/`

| Fact | Value |
|---|---|
| Evaluation base URL | `https://api.test.hotelbeds.com` |
| Authentication | `Api-key` + `X-Signature` = **lowercase hex SHA256(apiKey + secret + unixTimestampSeconds)** |
| **Static content endpoint** | Hotel Content API — static content, **not** availability |
| Intended usage | HBX recommends **batch retrieval into the integrator's own database**; not a per-user realtime lookup |
| Pagination | `from`/`to` window, up to **1000 hotels** per page |
| Differential updates | `lastUpdateTime` |
| Content sections | hotel identity, descriptions, location/address, coordinates, category, accommodation metadata, facilities, images |
| Images | `images[]` with `path`, `order`, `visualOrder`, `type`, room metadata; `visualOrder = 0` can identify a principal image |
| Image base | `https://photos.hotelbeds.com/giata/`, variants: standard, small, medium, bigger (~800), xl (~1024), xxl (~2048), original |
| Evaluation quota | 50 requests/day; owner dashboard also reports 8 requests / 4 seconds, reset every 86 400 s |

#### ⚠️ A.1.1 Category is NOT automatically a hotel star rating

Official documentation states category standards **differ by country**, and the
examples distinguish:

```
HOTEL     + "5 STAR"
APARTMENT + "5 KEY"
```

So **`simpleCode == 5` does not mean "5-star hotel"** — it may mean five *keys*
on an apartment, a different classification scheme entirely. Combined with D060's
exact-4-or-5 rule and the existing half-star handling, the harness accepts **no**
Hotelbeds category value as D060 evidence:
`starKindsAcceptedAsD060Evidence` is empty.

Under the layered-source principle this does **not** disqualify Hotelbeds. A
provider can be an excellent inventory, location and media source while its
classification requires secondary verification.

#### ⚠️ A.1.2 The 173-request global load must not be attempted

HBX documents a global initial-load procedure of roughly **173 hotel-page
requests**. Against a **50-request/day** evaluation quota that is impossible and
would burn the allowance without producing Bali or Dubai. Only targeted
destination retrieval is acceptable, and this is recorded as a geography
enumeration risk on the descriptor.

### A.2 Nuitee / LiteAPI — SECONDARY CANDIDATE

No documentation was established and none is asserted. Recorded as
`SELF_SERVICE_SANDBOX_AVAILABLE` / `CREDENTIAL_NOT_YET_SUPPLIED` /
`LIVE_NOT_RUN`, with an intentionally **empty** field map — a plausible-looking
guess is the failure mode this harness exists to prevent.

### A.3 Booking.com Demand API v3.2

Sources (all external review, 2026-08-15):
`developers.booking.com/demand/docs/open-api/3.2/demand-api` ·
`.../accommodations/look-accommodation-details` ·
`.../migration-guide/v3.2/accommodations/details` ·
`.../migration-guide/v3.2/accommodations/intro` ·
`.../development-guide/pagination` · `developers.booking.com/demand/docs`

| Fact | Value |
|---|---|
| Base URL (production) | `https://demandapi.booking.com/3.2` |
| Base URL (sandbox) | `https://demandapi-sandbox.booking.com/3.2` |
| Authentication | Bearer token + `X-Affiliate-Id` |
| Integration model | "Content only" is explicitly supported |
| **Static content endpoint** | `POST /accommodations/details` — availability and pricing are separate endpoints |
| Required scope param | At least one of `accommodations`, `airport`, `city`, `country`, `region` |
| Pagination | `page` token from `metadata.next_page`; `rows` a multiple of 10, 10..1000 for details |
| Result count | `metadata` includes `next_page` and may include `total_results` |
| Change detection | `/accommodations/details/changes`; v3.2 closure statuses expanded to temporary, permanent, fraud |
| Photos | `extras=["photos"]` retrieves photo / main-photo information |

Documented response fields: `id`, `name`, `accommodation_type`, `brands`,
`contacts`, `location.address`, `location.coordinates.latitude`,
`location.coordinates.longitude`, `rating.review_score`, `rating.stars`,
`rating.stars_type`, `url`.

**Star semantics: NOT established.** `official` appears as a documented
`stars_type` example. The **complete enum and the provenance meaning of each
value are unresolved**, so no `stars_type` value is accepted as D060 evidence —
inferring an enum from one example is the precise move D060 forbids.

### A.4 Expedia Rapid (lodging content)

Sources (all external review, 2026-08-15):
`developers.expediagroup.com/rapid/lodging` ·
`.../content/about-content-api` · `.../content/content-pagination` ·
`.../content/content-filtering` · `.../content/content-reference-lists` ·
`.../content/star-ratings` · `.../geography/about-geography-api` ·
`.../reference/signature-authentication`

| Fact | Value |
|---|---|
| **Static content endpoint** | `GET https://api.ean.com/v3/properties/content` (e.g. `language=en-US`, `supply_source=expedia`) |
| Authentication | `Authorization: EAN APIKey=…,Signature=SHA512(apiKey + sharedSecret + unixTimestamp),timestamp=…` |
| Pagination | Follow the `Link` response header `rel="next"` until absent; `Pagination-Total-Results` gives a result count |
| Preferred source | Content API is recommended over Content File APIs for expanded global inventory; the Property Catalog File covers the primary active-property list, but Content File APIs have limited expanded-global-inventory support |
| Incremental sync | `date_updated_start` / `date_added_start` filters; an inactive-property endpoint exists |
| Refresh cadence | Static content requires **daily** refreshes |
| Content sections | `property_id`, `name`, `address`, `location`, `category`, `chain`, `brand`, `phone`, `ratings`, `images`, … |
| Images | `images[]` with `caption`, `hero_image`, `category`, and links at multiple sizes |
| Property categories | Hotel, Resort, Villa, Lodge, Apartment, Aparthotel, Residence and many others |
| Geography | Region hierarchy plus property mappings |

#### ⚠️ A.4.1 The documented geography-enumeration cap

> For larger geography types (`high_level_region`, `province_state`, `country`,
> `continent`), property mappings return **up to the top 500 properties**. To
> obtain the full list, request properties from the **descendants** comprising
> that region.

A single large-region `property_ids` result therefore **must not be treated as
exhaustive**. Doing so would silently cap a destination's inventory — exactly the
D055/D061 failure the coverage contract exists to prevent, and invisible in the
output because 500 looks like a number rather than a ceiling.

**Correction applied in this amendment.** The previous version encoded this as
`documentedHardCap: 500` on the Content API's pagination. That was wrong: the
500 limit applies to Geography property **mappings** for large region types, not
to `GET /properties/content` paging. Conflating them would raise a false coverage
alarm on any content extraction past 500 records. It now lives in
`geographyEnumerationRisks`, and a regression test proves a 900-record content
extraction paginates cleanly with **no** geography risk raised.

#### A.4.2 Star ratings

- `ratings.property.type` **distinguishes official local-authority ratings from
  Expedia Group assigned ratings**, in regions where local authorities designate
  official ratings.
- Documented such regions include **France, Italy, Turkey, United Arab Emirates,
  Israel**.
- In those regions, `type=star` means the rating came from the property's **local
  star-rating authority**. `alternate` is **not** that official signal.
- For properties in **other** regions, the documentation states the returned
  rating is **Expedia-assigned regardless of type**, and an official rating is
  unavailable through that mechanism.
- `descriptions.national_ratings` describes the **source** of the star rating
  (for example a regional or national tourism agency).
- **Half-star values such as 3.5 and 4.5 are supported.**

That last point is a correctness fact, not a footnote: D060 requires *exactly* 4
or 5, so a 4.5-star property is a genuine classification that is **not** eligible,
and rounding it into the 4-star bucket would manufacture eligibility. The harness
now classifies exact-4 / exact-5 / classified-not-V1-scope / unresolved
separately (§ "What this block delivered").

### A.5 Google Places

Sources (all external review, 2026-08-15):
`developers.google.com/maps/documentation/places/web-service/policies` ·
`.../place-id` · `.../place-photos`

| Fact | Value |
|---|---|
| Caching | Places content generally **must not** be prefetched, cached or stored beyond stated exceptions |
| Place IDs | **Exempt** from the caching restriction and may be stored; Google recommends refreshing stored IDs older than **12 months** |
| Attribution | Places content displayed without a Google Map carries Google attribution/logo requirements; map display has its own Maps attribution rules |
| Photos | Photo resource names **must not** be cached and can expire |
| Photo authorship | Author attribution must be displayed where returned |

**Contract consequence:** Google Places is a **QA / identity cross-check /
Place-ID mapping candidate only**. It is **not** an appropriate canonical
persistent inventory or media backbone under our architecture — the caching
restriction is incompatible with storing property content and imagery as
canonical data, and photo resource names cannot be persisted at all. Place IDs
are the one field we could durably retain.

And, from our own contract rather than Google's: **a Google user rating is never
D060 star evidence.** It is a guest-satisfaction score.

---

## B. MEASURED FROM LIVE API

**EMPTY. No provider API was reached.**

### B.1 Hotelbeds access result

| Question | Answer |
|---|---|
| `HOTELBEDS_API_KEY` | **AVAILABLE** |
| `HOTELBEDS_SECRET` | **AVAILABLE** |
| `.env.local` gitignored | **verified** before writing (`git check-ignore`) |
| CREDENTIALS_VALID | **UNTESTED** — see below |
| EGRESS to `api.test.hotelbeds.com` | **BLOCKED** (`x-deny-reason: host_not_allowed`) |
| Requests that reached Hotelbeds | **0** |
| Hotelbeds daily quota consumed | **0 of 50** |
| Local run-budget attempts spent | 1 (the probe) |

**Why "UNTESTED" and not "invalid".** The probe received an HTTP 403, but that
403 came from the local egress proxy, not from Hotelbeds — the response carried
`x-deny-reason: host_not_allowed` and a plain-text body naming the host
allowlist. The request never left the sandbox.

The first implementation of the client classified any 403 as an authentication
failure and reported `CREDENTIALS_VALID: no`. That was wrong in the way this
codebase least tolerates: a technical error reported as a domain fact. It would
have slandered a working credential and mis-stated the remaining quota. The
client now detects the proxy denial explicitly and reports three distinct
outcomes — `valid`, `invalid`, `untested` — with a regression test for each.

### B.2 Everything else, still not run

| Metric group | Hotelbeds | Booking | Expedia | Nuitee |
|---|---|---|---|---|
| Bali inventory | NOT RUN — EGRESS BLOCKED | NOT RUN — NO ACCESS | NOT RUN — NO ACCESS | NOT RUN — NO CREDENTIAL |
| Dubai inventory | NOT RUN — EGRESS BLOCKED | NOT RUN — NO ACCESS | NOT RUN — NO ACCESS | NOT RUN — NO CREDENTIAL |
| Category / star distribution | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Coordinate coverage | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Image coverage | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Pagination / exhaustion | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Dubai pilot-30 comparison | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| Cross-source overlap | NOT RUN — needs ≥2 live sources | | | |

Other credentials: `BOOKING_DEMAND_API_TOKEN`, `BOOKING_AFFILIATE_ID`,
`EXPEDIA_RAPID_API_KEY`, `EXPEDIA_RAPID_SHARED_SECRET`, `NUITEE_API_KEY` — all
**NOT AVAILABLE**. No credential value was ever read, printed, logged or written
to an artifact.

### B.3 The one thing that WAS measured

Dubai pilot probe **input**, from the local gitignored workbook — no provider and
no production access:

| Field | Coverage across the 30 pilot entries |
|---|---|
| Name / Address / Website / Star value | 30 / 30 each |
| **Coordinates** | **0 / 30** |

This is why Hotelbeds coordinate coverage is strategically interesting: if it
supplies valid coordinates for these properties, that is **enrichment evidence**
for a D054/D062 gap that currently sits in published `hotels`. It is not
canonical truth and nothing is promoted.

---

## C. INFERENCE / RECOMMENDATION

Everything below is reasoning, not evidence.

### C.1 No source-strategy recommendation is defensible

Nothing was measured. No provider winner exists — not even a provisional lean.
Documentation now establishes what each provider *claims*; it does not establish
what any of them returns for Bali or Dubai, which is the entire question.

### C.2 The layered-source principle changes what "good enough" means

A provider need not solve every canonical dimension. The architecture is layered:
inventory · classification · location · media · research/verification · creator
workflow. So the useful question is not "is Hotelbeds sufficient?" but "which
layers can Hotelbeds carry, and which need a second source?"

On documentary evidence alone, the likely shape is:

| Layer | Hotelbeds outlook |
|---|---|
| Inventory / existence | Promising — static content, batch retrieval, 1000/page |
| Location / coordinates | Promising — coordinates are a documented content section |
| Media | Promising technically — structured `images[]`, principal-image marker, size variants |
| **Classification (D060)** | **Likely insufficient alone** — see C.3 |
| Contacts / hotel-confirmed | Out of scope for any inventory provider (D057) |

That is a hypothesis about layers, not a recommendation about providers.

### C.3 Hotelbeds star strategy — hypothesis, not verdict

`verdict: null`; recorded as `hypothesis`:

> **LIKELY REQUIRES SECONDARY VERIFICATION.** Category may identify a hotel
> classification, but the issuing authority is undocumented and "KEY" vs "STAR"
> semantics vary by country. `simpleCode == 5` may be five keys on an apartment.

This must be measured **separately for Indonesia (Bali) and the UAE (Dubai)**,
because the country-dependence is the whole point. Publishability condition 7
(D062) additionally requires that the classification's provenance be storable and
citable, which documentation does not answer.

### C.4 Booking and Expedia are deprioritised, not rejected

Both are documented and commercially unreachable — two different facts, which is
why `accessStatus` is now its own axis. They are preserved as
`future_strategic_source` with `direct_access_unavailable`; their transports are
deliberately unimplemented, and no work waits on them.

### C.5 Google remains a QA aid only

Unchanged: caching restrictions make it unsuitable as a canonical persistent
inventory or media backbone; Place IDs are the one durably storable field; a
Google user rating is never D060 evidence.

---

## D. BLOCKED / UNKNOWN

### D.1 Hotelbeds — EGRESS BLOCKED, credentials UNTESTED

`api.test.hotelbeds.com`, `api.hotelbeds.com`, `developer.hotelbeds.com` and
`photos.hotelbeds.com` are all refused by this environment's egress policy
(`x-deny-reason: host_not_allowed`). **0 requests reached the provider; 0 of 50
daily quota consumed.**

Everything downstream is consequently unresolved:

- **Bali destination code(s) — UNRESOLVED.** Must come from Content API
  destination master data. Bali may require a **union** of several codes; one
  famous town is not Bali, and no code was invented from memory.
- **Dubai destination code(s) — UNRESOLVED**, same method.
- **Category / accommodationType distribution — UNOBSERVED**, so no hospitality
  property-type mapping exists and `apparentPhysicalHospitalityProperties`
  correctly returns `null`.
- **Coordinate coverage — UNMEASURED** for both destinations.
- **Image coverage, principal-image availability, images per property —
  UNMEASURED.**
- **Field paths documented but unexercised** against a live payload.
- **Pagination exhaustion — UNPROVEN**; nothing was paginated.

### D.2 Dubai pilot-30 comparison — INPUT READY, COMPARISON BLOCKED

The 30-entry probe input builds from the local gitignored workbook. The
comparison needs live Hotelbeds Dubai data, so it did not run. The pilot itself
has **0/30 coordinates**, so coordinate *agreement* can never be computed against
those rows — only coordinate *enrichment availability* from a provider.

### D.3 Media rights — TECHNICALLY_AVAILABLE / PRODUCTION_RIGHTS_REVIEW_REQUIRED

Structure, principal-image marker and size variants are documented. Redistribution
and storage rights are governed by the commercial contract and are **not**
established by developer documentation. No image binary was downloaded, and none
should be before that review (D064).

### D.4 Booking, Expedia, Nuitee — NO LIVE ACCESS

Booking and Expedia: documented, `direct_access_unavailable`, `not_run`. Nuitee:
no documentation established, `NUITEE_API_KEY` NOT AVAILABLE, `not_run`.

### D.5 Coverage closure — NOT ESTABLISHED FOR ANY DESTINATION

Neither Bali nor Dubai is coverage complete, and this block could not move that
either way. D061 requires zero coverage-critical unresolved candidates; we have
not enumerated a single candidate.

---

## Correctness amendment (post-review of `6be3bf0`)

Seven issues were found before any live run was attempted. Fixing them first is
the point: a bake-off executed against a broken gate would have produced numbers
nobody could trust, and would have spent an irreplaceable daily quota doing it.

### 1. The runnability gate was all-or-nothing

Hotelbeds deliberately has unresolved classification semantics — and the old gate
required *everything* before *anything* could run, so the live evaluation could
never have executed even with network access.

Replaced with **capability-specific gates**: `enumerate_inventory`,
`measure_location`, `measure_media`, `assess_classification`,
`resolve_d060_classification`. A run proceeds when **any** dimension is
measurable, and the result reports each independently.

**D060 is not weakened.** `resolve_d060_classification` still requires an
established issuing authority and accepted classification semantics; it simply no
longer vetoes measuring coordinates.

### 2. Geography discovery was circular

The gate demanded resolved geography before the code that *discovers* geography
could run. There is now a discovery phase —
`npm run eval:sources:geography -- --country ID` — which fetches destination
master data, caches it, and writes candidate codes for review. It is **not**
gated on classification, and no destination code is hardcoded.

### 3. The category mapping was a guessed path

The descriptor pointed `starValue` at `category.simpleCode`, assuming the hotels
response embeds a category object. The documented architecture says the hotels
operation returns **codes**, with master operations supplying their meaning.

Now modelled as `code_with_master_lookup`: `hotel.categoryCode` → category master
→ `code` / `simpleCode` / `accommodationType` / `group` / `description`.

### 4. Raw observation and D060 interpretation are now separate layers

`RawClassificationObservation` records what the provider said and how the join
resolved. `interpretClassificationForD060` decides what that means. So:

| Source evidence | D060 |
|---|---|
| `5EST` · simpleCode 5 · **HOTEL** · "5 STAR" | `exact_five` |
| `5LL` · simpleCode 5 · **APARTMENT** · "5 KEY" | `unresolved` — five keys are not five stars |
| `3EST` · simpleCode 3 · HOTEL | `classified_not_v1_scope` |
| code present, no master entry | `unresolved_no_master_entry` |

**No numeric value is ever manufactured from a code string** — `5EST` does not
become 5; only an explicit numeric `simpleCode` counts.

### 5. The principal image is derived, not a field path

`heroImage: null` would have reported 0% hero coverage forever. Image evidence is
now derived from the images collection: count, `visualOrder = 0` principal
candidate, type distribution, and path availability.

### 6. The daily quota did not survive process restarts

The in-process budget could be reset by simply running the command again —
30 requests, exit, 40 more, and a 50/day account is at 70.

A **persistent ledger** under `.data/provider-evaluation/hotelbeds/` now records
every provider-reaching request across executions, scoped by account fingerprint.
Cache hits and egress denials are **not** counted; successes, provider 4xx/5xx and
provider-reaching retries **are**. The account exposes no authoritative reset
timestamp, so a **conservative 24-hour rolling window** is used — it can only
under-spend, never over-spend. A corrupt ledger **fails closed** rather than
silently restoring the allowance.

### 7. The cache was not account-aware

Two Hotelbeds accounts can see different portfolios. Cache identity now includes
provider, base URL and an **irreversible 12-char fingerprint** of the API key
(never the key itself), so a different credential cannot silently read another
account's inventory.

### 8. The probe answered a current question from stale data

A cached 200 from yesterday cannot prove today's credential works. The probe now
**bypasses the cache** and costs exactly one request — the right price for a
current answer.

### 9. Preserved: the egress classification

`EGRESS_BLOCKED` → credentials **UNTESTED**; provider 401/403 → **INVALID**;
provider success → **VALID**. Unchanged, and now regression-tested.

---

## What this block delivered

- **Owner-supplied Hotelbeds credentials stored safely** in the gitignored
  `.env.local`, with the ignore rule verified *before* writing.
- **A real, budget-guarded Hotelbeds transport**: SHA256 request signing,
  destination master-data resolution, `from`/`to` pagination to exhaustion.
- **A request-budget guard built for a 50/day quota** — reserve-before-request,
  ~1.5 req/s pacing, 40-request default ceiling leaving ≥10 in reserve, retries
  counted, 401/403 and quota errors terminal, and **on-disk caching so a rerun
  spends nothing**.
- **A correctness fix found by running it**: a proxy 403 was being reported as an
  authentication failure. Credentials are now `valid` / `invalid` / `untested`,
  and local attempts are counted separately from requests that actually reached
  the provider.
- **The Expedia top-500 correction**, with a regression test proving a
  900-record content extraction raises no geography risk.
- **Overlap semantics fixed**: `NO_TEXTUAL_EVIDENCE` is no longer conflated with
  `NO_POSSIBLE_MATCH`, and spatial candidate generation is explicitly
  `not_yet_assessed`.
- Hotelbeds and Nuitee descriptors; Booking and Expedia preserved as future
  strategic sources on a new `accessStatus` / `liveValidationStatus` /
  `strategicRole` triple.
- **102 deterministic tests** across the two evaluation suites, all synthetic —
  including two separate ledger instances proving a second process cannot reset
  the daily allowance, and a cache test proving two accounts never share entries.

## Exact next action

**Allowlist `api.test.hotelbeds.com` in the environment's network egress
settings** (`photos.hotelbeds.com` too if image metadata is to be fetched). Then:

1. `npm run eval:sources:probe` — one request, confirms CREDENTIALS_VALID.
2. Resolve Bali and Dubai destination codes from destination master data,
   unioning Bali's codes as needed.
3. Run each destination with `--max-requests` inside the 50/day allowance,
   paginating to exhaustion; cached responses make reruns free.
4. Record the category/accommodationType distribution before any star verdict.

The bake-off is not complete and the Coverage Engine must not start.
