# Property-source bake-off — Bali & Dubai

Date: **2026-08-15**
Governing contract: [`PROPERTY_CONTENT_COVERAGE_CONTRACT.md`](../PROPERTY_CONTENT_COVERAGE_CONTRACT.md) (D060–D064)
Specification: [`PROPERTY_SOURCE_EVALUATION.md`](../PROPERTY_SOURCE_EVALUATION.md)

> ## STATUS: BLOCKED ON LIVE PROVIDER ACCESS
>
> **No provider was measured. No provider is recommended. No star verdict is
> issued. The bake-off is NOT complete.**
>
> Official provider documentation **has** now been established — independently
> verified during external review on 2026-08-15 — so Section A is populated.
> Section B remains empty: no provider API was called, because credentials are
> unavailable and the provider hosts are unreachable from the Claude Code
> execution environment.

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

### A.1 Booking.com Demand API v3.2

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

### A.2 Expedia Rapid (lodging content)

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

#### ⚠️ A.2.1 The documented coverage cap — the single most important fact in this section

> For larger geography types (`high_level_region`, `province_state`, `country`,
> `continent`), property mappings return **up to the top 500 properties**. To
> obtain the full list, request properties from the **descendants** comprising
> that region.

A single large-region `property_ids` result therefore **must not be treated as
exhaustive**. Doing so would silently cap a destination's inventory — exactly the
D055/D061 failure the coverage contract exists to prevent, and invisible in the
output because 500 looks like a number rather than a ceiling.

This is encoded as `documentedHardCap: 500` in the Expedia descriptor, so the
paginator raises a **COVERAGE RISK** rather than reporting a total on reaching it.

#### A.2.2 Star ratings

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

### A.3 Google Places

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

**EMPTY. No provider API was called.**

| Metric group | Booking | Expedia |
|---|---|---|
| Inventory counts (Bali) | NOT RUN — ACCESS REQUIRED | NOT RUN — ACCESS REQUIRED |
| Inventory counts (Dubai) | NOT RUN — ACCESS REQUIRED | NOT RUN — ACCESS REQUIRED |
| Star distribution + suitability | NOT RUN — ACCESS REQUIRED | NOT RUN — ACCESS REQUIRED |
| Coordinate coverage | NOT RUN — ACCESS REQUIRED | NOT RUN — ACCESS REQUIRED |
| Address / website / brand coverage | NOT RUN — ACCESS REQUIRED | NOT RUN — ACCESS REQUIRED |
| Photo + hero coverage, photos per property | NOT RUN — ACCESS REQUIRED | NOT RUN — ACCESS REQUIRED |
| Property-type distribution | NOT RUN — ACCESS REQUIRED | NOT RUN — ACCESS REQUIRED |
| Pagination / exhaustion evidence | NOT RUN — ACCESS REQUIRED | NOT RUN — ACCESS REQUIRED |
| Cross-source overlap | NOT RUN — BOTH PROVIDERS REQUIRED | NOT RUN — BOTH PROVIDERS REQUIRED |
| Dubai 30-property probe | NOT RUN — ACCESS REQUIRED | NOT RUN — ACCESS REQUIRED |

### Credential status (presence only)

| Variable | Status |
|---|---|
| `BOOKING_DEMAND_API_TOKEN` | **NOT AVAILABLE** |
| `BOOKING_AFFILIATE_ID` | **NOT AVAILABLE** |
| `EXPEDIA_RAPID_API_KEY` | **NOT AVAILABLE** |
| `EXPEDIA_RAPID_SHARED_SECRET` | **NOT AVAILABLE** |

No credential value was read, printed, logged or stored at any point.

### The one thing that WAS measured

The Dubai pilot probe **input** was built from the local, gitignored Sprint 1C
workbook — no provider and no production database involved:

| Field | Coverage across the 30 pilot entries |
|---|---|
| Name | 30 / 30 |
| Address | 30 / 30 |
| Website | 30 / 30 |
| Star value (research-supplied, provenance not established) | 30 / 30 |
| **Coordinates** | **0 / 30** |

This is a real and load-bearing finding — see §D.5.

---

## C. INFERENCE / RECOMMENDATION

Everything below is reasoning, not evidence.

### C.1 No source-strategy recommendation is defensible

With neither provider run, **no provider winner exists**. Not "Booking pending
confirmation", not "Expedia likely" — nothing. A recommendation formed now would
be a preference dressed as a finding, and it would be quoted later as the outcome
of a bake-off that never happened.

Documentation now establishes what each provider *claims* to offer. It does not
establish what either actually returns for Bali or Dubai, which is the entire
question.

### C.2 Expedia star strategy — an evidence-backed HYPOTHESIS, not a verdict

Recorded in the descriptor as `hypothesis`, with `verdict: null`:

| Destination | Hypothesis | Basis |
|---|---|---|
| **Dubai (UAE)** | `ratings.property.type=star` is a **candidate for SUITABLE** D060 evidence, subject to live validation and a provenance-storage review. `alternate` is **not** sufficient as official-local-authority evidence. | UAE is documented among the regions where local authorities designate official ratings |
| **Bali (Indonesia)** | An Expedia-assigned rating alone is **likely NOT sufficient** to resolve D060 classification; **REQUIRES SECONDARY VERIFICATION** rather than being used alone for publication. | Indonesia is not among the documented official-rating regions, and the documentation says ratings there are Expedia-assigned regardless of type |

This is exactly the destination-specific outcome the coverage contract
anticipated: one provider, two markets, two different answers. Forcing a global
verdict would hide the thing most worth knowing.

**It remains a hypothesis.** Two things must be settled before it becomes a
verdict: live confirmation of the actual `type` distribution in each market, and
whether the rating's provenance can be **stored and cited** — publishability
condition 7 (D062), which documentation alone does not answer.

`descriptions.national_ratings` is the most promising lead for that provenance
and should be evaluated live in both destinations.

### C.3 Booking star strategy — no hypothesis is warranted

`official` is one documented `stars_type` example. The complete enum and each
value's provenance meaning are unknown. Forming even a hypothesis from a single
example would be inferring an enum, so the descriptor accepts **no** `stars_type`
value as D060 evidence and states the gap as a blocker.

### C.4 Google is settled enough to act on

Documentation is sufficient here, and the conclusion is negative in a useful way:
Google Places **cannot** be a canonical persistent inventory or media backbone
under our architecture. Content caching is restricted, and photo resource names
must not be cached at all. Place IDs are the exception and may be stored, which
makes Google a viable **identity cross-check and location-QA** aid — and nothing
more. That is a product constraint, recorded rather than engineered around.

### C.5 The environment blocker, restated after the amendment

External review has now supplied the documentation, so the ordering has changed:

1. ~~Documentation access~~ — **resolved by external review** for the facts above.
2. **Credentials** — still absent; nothing can be executed.
3. **Provider API egress** from the Claude Code environment — still blocked.

Descriptor completion is no longer blocked on documentation *in general*, but two
specific documentary gaps remain (Booking's `stars_type` enum) and two require
live API access rather than docs (Bali/Dubai geography ids, and Expedia's
descendant region sets).

## D. BLOCKED / UNKNOWN

### D.1 Booking.com Demand API — DOCUMENTED, NOT EVALUATED

Descriptor: `scripts/provider-evaluation/adapters/booking.ts`, status
**`partially_verified`**. Endpoint, authentication, pagination and response field
paths are now recorded from official documentation (§A.1). It remains **not
runnable**.

Outstanding:

- **`rating.stars_type` enum and provenance semantics — UNRESOLVED.** `official`
  is a documented example, not the enum. No value is accepted as D060 evidence.
- **Bali and Dubai geography ids — UNRESOLVED.** These need a live Booking
  location lookup; documentation does not supply them.
- **Field paths unexercised.** Documented, but never run against a live payload.
- **Credentials NOT AVAILABLE**; `demandapi.booking.com` unreachable from this
  environment.

### D.2 Expedia Rapid — DOCUMENTED, NOT EVALUATED

Descriptor: `scripts/provider-evaluation/adapters/expedia.ts`, status
**`partially_verified`**. Endpoint, signature authentication, `Link`-header
pagination, incremental filters, category list, image structure and the
ratings-type semantics are recorded (§A.2), including the **top-500 property
mapping cap** as `documentedHardCap: 500`. It remains **not runnable**.

Outstanding:

- **Bali and Dubai geography ids — UNRESOLVED**, including the **descendant
  region sets** required to exceed the top-500 cap. This is the difference
  between a destination universe and a truncated list.
- **Star hypotheses unconfirmed** against live data (§C.2).
- **Star provenance storage — UNRESOLVED**; publishability condition 7 (D062).
- **Credentials NOT AVAILABLE**; `api.ean.com` unreachable from this environment.

### D.3 Provider geography for Bali and Dubai — NOT RESOLVED

Unchanged, and now the sharpest remaining gap. Brief §9 forbids assuming
`Bali = city` and forbids querying a handful of well-known towns and calling the
union "Bali". Both providers require **live** geography lookups; documentation
establishes the mechanism, not the ids.

For Expedia this is compounded by the top-500 cap: resolving Bali means resolving
its descendant regions too, or the extraction is capped by construction.

`AdapterDescriptor.geography` records entity kind, ids, method, union requirement
and caveats, and the gate refuses to run while it is empty. **No geography was
assumed.**

### D.4 Google Places — ASSESSED, NOT A CANDIDATE BACKBONE

Now documented (§A.3) and resolved as a product constraint rather than an open
question: **not** an appropriate canonical persistent inventory or media
backbone. Usable as identity cross-check / Place-ID mapping / location QA, with
Place IDs the only durably storable field (refresh recommended after 12 months).

Still open: whether we will adopt it for QA at all, and the attribution
obligations that would follow if Places content is ever displayed.

### D.5 Dubai 30-property probe — INPUT AVAILABLE, EXECUTION BLOCKED

**Input: AVAILABLE.** The pilot workbook is present locally and gitignored, and
`npm run eval:sources:pilot-probe` builds a 30-entry probe input under `.data/`.
Production Supabase was **not** contacted and the 30 canonical rows were **not**
read or modified.

**Execution: BLOCKED** — a probe needs a provider to probe against.

**Finding that does not depend on any provider: 0 of 30 pilot entries carry
coordinates.** Two consequences:

1. **Coordinate agreement cannot be measured** in this probe even once providers
   are reachable. Matching will lean on name plus website domain and address,
   which is weaker; and coordinate *comparison* — the strongest available
   identity signal — will only become possible after the pilot is enriched.
2. **It corroborates the D054/D062 compliance gap** already flagged in the
   contract block. These rows are in `hotels` — i.e. published — and canonical
   coordinates are a publishability condition. The pilot predates D054/D060/D062
   and is explicitly not grandfathered (backlog 7.6). This is now measured rather
   than asserted.

Star values are present on all 30 entries, but they are research-supplied and
carry **no established provenance**, so they do not satisfy D060 condition 7 as
they stand.

### D.6 Cross-source overlap — NOT RUN

Requires both providers. The analysis is implemented and tested
(`overlap.ts`): two agreeing independent signals for high confidence, one signal
is ambiguous, and a coordinate contradiction beyond 2 km vetoes a match outright.
Deliberately **no numeric match threshold is proposed** — D063 defers that until
real source behaviour is observed, and a number invented here would later read as
a decision.

### D.7 Access and licensing questions still open

- Booking Demand API access level required for static property content, and its
  commercial terms.
- Expedia Rapid access level required for property content and geography.
- Content and media usage rights for both: caching, storage, redistribution and
  attribution — **unresolved, and a precondition for storing any provider image**
  (D064).
- Whether either provider's star field can be stored *with citable provenance*,
  which is publishability condition 7 (D062) and not merely a data-quality
  preference.
- Google Places persistent-storage compatibility (D.4).

---

## What this block delivered

- A **complete, tested execution pipeline** — auth → exhaustive pagination →
  raw-count evidence → normalize → metrics → gitignored artifacts → aggregate
  result (`execute.ts`), exercised end to end by synthetic tests. It refuses to
  run only for missing facts or missing credentials, never because extraction was
  left unimplemented.
- A **runnability gate** that refuses an incomplete descriptor, naming exactly
  what is missing.
- **D060 exact-star classification**: exact-4 / exact-5 /
  classified-not-V1-scope / unresolved. A 4.5 never becomes a 4, an unexpected
  scale is never coerced, and an unusable kind is unresolved rather than demoted.
- **Raw-vs-normalized accounting** preserved end to end, so identity-less
  provider records are visible source-quality evidence rather than a silently
  smaller denominator.
- **Overlap analysis with no invented thresholds** — an evidence matrix with raw
  coordinate distances, many-to-many ambiguity clusters, and a union that is
  simply not estimated unless a labelled PROVISIONAL heuristic is configured.
- Two descriptors carrying the official-documentation facts of §A, with
  `verifiedBy: "external_review"` attribution asserted by test.
- The Dubai probe input builder, plus one measured finding (0/30 coordinates).
- Gitignored artifact handling, secret redaction, and `.env.local` loading via
  Node's built-in `process.loadEnvFile` (no new dependency).
- **64 deterministic tests** over hand-written synthetic fixtures.

## Exact next action

1. **Obtain provider credentials** (Booking token + affiliate id; Expedia API key
   + shared secret) and **unblock egress** to `demandapi.booking.com` and
   `api.ean.com` from whatever environment runs the bake-off.
2. **Resolve Bali and Dubai geography** live in both providers — for Expedia,
   including the descendant region sets needed to exceed the top-500 cap.
3. **Establish Booking's `stars_type` enum** and each value's provenance meaning.
4. Implement the two `TRANSPORT_BUILDERS` entries against the now-documented
   endpoints, flip each descriptor to `verified`, and run.

The Coverage Engine must not start until this block has produced: a source
strategy chosen on evidence, a star-suitability **verdict** per provider per
destination, and resolved provider geography for both destinations.
