# Property-source bake-off — Bali & Dubai

Governing contract: [`PROPERTY_CONTENT_COVERAGE_CONTRACT.md`](../PROPERTY_CONTENT_COVERAGE_CONTRACT.md) (D060–D064)
Specification: [`PROPERTY_SOURCE_EVALUATION.md`](../PROPERTY_SOURCE_EVALUATION.md)

---

# CURRENT STATUS

**As of 2026-08-16. This section is the single authoritative statement of where
the evaluation stands. Anything describing a different state is history and
lives under [Chronological attempt history](#chronological-attempt-history).**

| | |
|---|---|
| Active evaluation target | **HBX Group / Hotelbeds Hotel Content API** |
| Egress to `api.test.hotelbeds.com` | **REACHABLE** |
| Credentials | **VALID** (live probe, cache bypassed) |
| Live extraction | **DONE for Bali (BAI) and Dubai (DXB)** — static content only |
| Hotelbeds daily quota | **11 confirmed · 0 ambiguous · 39 safe remaining of 50** |
| Geography mapping | **BAI = Bali, DXB = Dubai**, approved by external review for this bake-off |
| D060 canonical stars from Hotelbeds | **REQUIRES SECONDARY VERIFICATION** — locked by external review |
| Promotion into `hotels` | **NONE.** No Supabase, no canonical write, no Coverage Engine |
| Bake-off complete? | **NO** |
| Bali or Dubai coverage complete? | **NO.** D061 closure is untouched |

**What "geography approved" does and does not mean.** It means *provider
enumeration mapping accepted for the Hotelbeds bake-off*. It does **not** mean
Bali or Dubai coverage is complete. Those are different claims and only the
first has been made.

---

# CURRENT FINDINGS

## 1. Inventory — both destinations enumerated to exhaustion

| | Bali (`BAI`) | Dubai (`DXB`) |
|---|---|---|
| Raw provider records | **3,275** | **835** |
| Provider's own reported total | 3,275 | 835 |
| Unique provider ids | 3,275 | 835 |
| Duplicate provider ids | **0** | **0** |
| Records with no provider id | **0** | **0** |
| Requests / pages | 4 / 4 | 1 / 1 |
| Pagination walk completed | **YES** | **YES** |
| Combined "exhaustion proven" flag | NO — see below | NO — see below |

The walk is complete on both: every page was consumed and the provider's own
total was matched exactly. The combined flag is `false` only because the
destination mappings carry **recorded caveats** (BAI's 76 zones were not
individually enumerated; Lombok is excluded by decision). Those are two
different failures and they were being reported as one, so `walkCompleted` is
now reported separately from `exhaustionProven` — a completed walk carrying a
mapping caveat must not send anyone to fix a paginator that worked perfectly.

**Every returned record is retained.** Nothing was dropped for being an
unrecognised type or an unresolvable category.

## 2. Geography — no contradictions

| | Bali | Dubai |
|---|---|---|
| `destinationCode` values returned | `BAI` × 3,275 | `DXB` × 835 |
| Records outside the approved mapping | **0** | **0** |
| Distinct zone codes present | **59** (of BAI's 76) | **21** (of DXB's 29) |
| Records with no zone | 0 | 0 |

**No `GEOGRAPHY_MAPPING_CONTRADICTION`.** Every record came back under the
approved code.

Bali's zones are broadly spread — the largest holds 476 properties and the top
eight hold roughly half the inventory — which is consistent with `BAI` covering
the island rather than one resort strip. The 17 Bali and 8 Dubai zones with no
properties are not evidence of missing data; a zone with no hotels is a valid
state.

## 3. Provider classification — NOT canonical D060 stars

**Locked by external review: Hotelbeds category data is
`PROVIDER_CLASSIFICATION_EVIDENCE`, never `CANONICAL_D060_CLASSIFICATION_EVIDENCE`.**
`simpleCode`, category `group` and free-text `description` are each rejected as
canonical provenance. Everything in this section is provider-apparent.

| | Bali | Dubai |
|---|---|---|
| Records carrying a `categoryCode` | 3,275 (100%) | 835 (100%) |
| Distinct category codes | 37 | 25 |
| **Master join resolved** | **100.00%** | **100.00%** |
| Codes missing from master | none | none |
| STAR-labelled | 2,425 | 648 |
| KEY-labelled | 7 | 11 |
| Other category labels | 843 | 176 |

**PROVIDER-APPARENT category breakdown — PROVIDER CLASSIFICATION, NOT D060 RESOLUTION:**

| Category | Bali | Dubai |
|---|---|---|
| `5EST` 5 STARS | 313 | 199 |
| `5LUX` 5 STARS LUXURY | 21 | 13 |
| `4EST` 4 STARS | 609 | 220 |
| `4LUX` 4 STARS LUXURY | 16 | 8 |
| `3EST` 3 STARS | 911 | 154 |
| `2EST` 2 STARS | 304 | 41 |
| `1EST` 1 STAR | 66 | 13 |
| `H3_5` 3 STARS AND A HALF | 108 | — |
| `H2_5` 2 STARS AND A HALF | 60 | — |
| `VILLA` | 135 | — |
| `SPC` (unlabelled special category) | 602 | 88 |
| KEY categories (`1LL`–`5LL`) | 7 | 11 |

`H3_5` and `H2_5` are reported as their own buckets. **A half-star category is
never rounded into an exact 4 or exact 5.**

### 3a. New evidence: the discriminator exists on the PROPERTY

The category master's `accommodationType` was empty on all 65 codes. But the
**hotels payload carries `accommodationTypeCode` on 100% of records**, and the
accommodations master (24 codes, fetched to exhaustion) explains it:

| Type | Bali | Dubai |
|---|---|---|
| `H` Hotel | 2,614 | 717 |
| `G` Guest house | 164 | — |
| `W` Resort | 163 | 4 |
| `V` Vacation home or villa | 137 | 4 |
| `K` Bed and breakfast | 126 | — |
| `S` Hostel | 25 | 1 |
| `Q` Boutique | 22 | 1 |
| `P` Aparthotel | 5 | 55 |
| `A` Apartment | 7 | 46 |
| `C` Vacation condo or apartment | — | 4 |
| others (`D`, `M`, `N`, `R`, `B`) | 12 | 4 |

This makes the `HOTEL × "5 STARS"` pairing **observable**, which is what D060
eventually needs. It does **not** unlock D060, for two reasons — one recorded,
one newly observed:

1. **The issuing authority is still unestablished**, so publishability
   condition 7 (D062) cannot be satisfied. This is the binding blocker.
2. **A STAR label does not imply a hotel.** Dubai returns `Apartment × 4 STARS`
   (5) and `Aparthotel × 5 STARS` (5); Bali returns Bed-and-breakfast,
   Guest-house and Resort records carrying STAR categories. Filtering on "has a
   star category" would have admitted them.

For the record, the provider-apparent `Hotel ×` star pairing is:
Bali — `H × 5 STARS` 258, `H × 4 STARS` 522, `H × 3 STARS` 728, `H × 3.5` 66;
Dubai — `H × 5 STARS` 188, `H × 5 STARS LUXURY` 13, `H × 4 STARS` 212,
`H × 4 STARS LUXURY` 8. **These are provider labels, not D060 counts, and must
not be cited as V1 inventory.**

## 4. Location

| | Bali | Dubai |
|---|---|---|
| Coordinates present | 3,273 / 3,275 (99.94%) | **835 / 835 (100%)** |
| **Coordinates valid** | **3,272 (99.91%)** | **835 (100%)** |
| `0,0` coordinates | 0 | 0 |
| Out-of-range coordinates | **1** | 0 |
| Address present | 3,275 (100%) | 835 (100%) |
| Postal code present | 2,530 (77.3%) | 586 (70.2%) |

One Bali record carries an out-of-range coordinate. It is reported rather than
silently dropped — a single bad value is a data-quality fact about the source.

## 5. Identity and contact

| | Bali | Dubai |
|---|---|---|
| Name | 3,275 (100%) | 835 (100%) |
| Chain code | 739 (22.6%) | 438 (52.5%) |
| Website | 1,203 (36.7%) | 513 (61.4%) |
| Any phone | 2,851 (87.1%) | 812 (97.2%) |
| **Phone that is not a fax** | **2,851 (87.1%)** | **812 (97.2%)** |
| Email | 1,917 (58.5%) | 690 (82.6%) |

`phones[]` carries a `phoneType`, and the mapped path `phones.0.phoneNumber`
can land on a `FAXNUMBER`. A fax reported as a contact phone is a wrong fact,
not a missing one, so the two are counted separately. On this data every
property with a phone has at least one non-fax number, so the distinction costs
nothing here — but it will matter the first time it doesn't.

## 6. Media

| | Bali | Dubai |
|---|---|---|
| Properties with ≥1 image | 2,628 (80.2%) | 742 (88.9%) |
| Total images | 137,328 | 67,982 |
| **Average images / property** | **41.93** | **81.42** |
| **Median images / property** | **28** | **44** |
| Images with a usable path | 137,328 (100%) | 67,982 (100%) |
| Principal image deterministically selectable | 2,623 | 740 |
| Properties matching the DOCUMENTED `visualOrder = 0` rule | **103 (3.1%)** | **20 (2.4%)** |

Top image types — Bali: `HAB` 69,651 · `GEN` 26,746 · `RES` 10,271 · `DEP`
8,388 · `COM` 7,736 · `PIS` 6,930. Dubai: `HAB` 35,302 · `RES` 8,807 · `GEN`
7,786 · `DEP` 4,008 · `CON` 3,435 · `COM` 3,303.

Mean and median are far apart because a long tail of image-rich properties drags
the mean up. Both are reported; the mean alone would overstate a typical listing.

**No image binary was downloaded.** Media rights remain
TECHNICALLY_AVAILABLE / PRODUCTION_RIGHTS_REVIEW_REQUIRED (D064).

## 7. Dubai 30-property pilot × live DXB — NON-CANONICAL

| Outcome | Count |
|---|---|
| Strong multi-signal candidate | **22** |
| Plausible single-signal candidate | 2 |
| Ambiguous — multiple candidates | 2 |
| No textual evidence | 4 |
| Not yet assessable | 0 |
| **COORDINATE ENRICHMENT AVAILABLE** | **26 of 30** |

**Nothing was resolved and no match threshold was invented** (D063).

The pilot has **0 of 30 coordinates**, so a provider coordinate here can never
be coordinate *agreement* — there is nothing to agree with. It is
**COORDINATE ENRICHMENT AVAILABLE**, and it stays that way until identity is
resolved by a process that is allowed to resolve identity.

"No textual evidence" on 4 entries means our signals did not agree. It does not
mean Hotelbeds lacks the property: names transliterate, rebrand and abbreviate.

## 8. Field-map findings

Live validation ran against the actual payloads before any aggregate was
computed. Two documented facts did not survive it.

| Finding | Class | Resolution |
|---|---|---|
| `activeStatus` → `status` | **FIELD_MAP_MISMATCH** | The key does not exist anywhere in the hotels payload — the Content API carries **no lifecycle field**. Unmapped, with the reason recorded. Left in place it would have reported "0% active-status coverage" as a provider weakness. |
| Principal image = `visualOrder === 0` | **DOCUMENTED SEMANTICS CONTRADICTED** | Live `visualOrder` values are large ranks (813, 805, 804 …); zero appears on ~3% of properties. Replaced with a deterministic-extremum selector that claims only what the data supports. Both numbers are reported. |
| Accommodations master → `description.content` | **FIELD_MAP_MISMATCH** | That master uses `typeDescription` / `typeMultiDescription.content`. Reading `description` returned 24 empty strings — a provider that looked like it shipped unlabelled types. Fixed. |
| Category master `accommodationType` | **FIELD_NOT_POPULATED** | The key exists and is `""` on all 65 records. Our path is right; the provider does not fill it here. |

Everything else — `code`, `name.content`, `categoryCode`, `destinationCode`,
`zoneCode`, `accommodationTypeCode`, `coordinates.*`, `address.content`,
`postalCode`, `chainCode`, `web`, `phones[]`, `email`, `images[]` and its
`path` / `imageTypeCode` / `visualOrder` — **resolved as documented**.

`classification.codePath = "categoryCode"` is now **CONFIRMED** against live
payloads for both destinations.

## 9. Source-strategy verdicts — by dimension, not one winner

A source is not one thing. These are separate findings because a provider can be
excellent at three of them and unusable for a fourth.

| Dimension | Verdict | Evidence |
|---|---|---|
| **Inventory source** | **SUITABLE** | 3,275 Bali and 835 Dubai records, exhaustive walks, provider totals matched exactly, zero duplicate ids, zero missing ids, zero geography contradictions. |
| **Location source** | **SUITABLE** | 99.91% valid coordinates in Bali, 100% in Dubai, 100% addresses, no `0,0`, one out-of-range value. Directly addresses the pilot's 0/30 coordinate gap. |
| **Media source** | **SUITABLE — subject to rights review** | 80–89% of properties carry images, median 28–44 per property, 100% usable paths, principal image deterministically selectable on ~99% of properties that have any. Rights are **not** established by developer documentation (D064). |
| **Contact source** | **PARTIALLY SUITABLE** | Strong in Dubai (97.2% phone, 82.6% email, 61.4% website); materially weaker in Bali (87.1% phone, 58.5% email, **36.7% website**). Usable as enrichment, not as a sole contact authority — and the fax/phone distinction must be preserved. |
| **Canonical D060 classification source** | **REQUIRES SECONDARY VERIFICATION** | Locked by external review and independently supported by the live data: no issuing authority, `simpleCode` conflates keys with stars, and STAR-labelled categories appear on apartments and aparthotels. |

**Hotelbeds being unable to establish canonical star provenance does not make it
a weak source.** It is a strong inventory, location and media source that cannot
close D060 alone — which is exactly what the layered-source principle predicts,
and it is strategically useful on that basis.

---
# VERIFIED FROM OFFICIAL DOCUMENTATION

### Source 1 — HBX Group / Hotelbeds Hotel Content API — ACTIVE EVALUATION TARGET

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

### Source 2 — Nuitee / LiteAPI — SECONDARY CANDIDATE

No documentation was established and none is asserted. Recorded as
`SELF_SERVICE_SANDBOX_AVAILABLE` / `CREDENTIAL_NOT_YET_SUPPLIED` /
`LIVE_NOT_RUN`, with an intentionally **empty** field map — a plausible-looking
guess is the failure mode this harness exists to prevent.

### Source 3 — Booking.com Demand API v3.2

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

### Source 4 — Expedia Rapid (lodging content)

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

### Source 5 — Google Places

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

# STILL BLOCKED / UNKNOWN

### Canonical D060 classification — REQUIRES SECONDARY VERIFICATION

Locked. See CURRENT FINDINGS §3. No exact-four or exact-five **canonical**
inventory count exists for either destination, and none may be manufactured from
Hotelbeds alone.

### Coverage closure — NOT ESTABLISHED FOR ANY DESTINATION

D061 requires zero coverage-critical unresolved candidates. We have now
enumerated a provider's population; that is not the same thing and does not
approach it. **Neither Bali nor Dubai is coverage complete.**

### Media rights — PRODUCTION_RIGHTS_REVIEW_REQUIRED

Structure, principal-image selection and size variants are established.
Redistribution and storage rights are governed by the commercial contract and
are **not** established by developer documentation. No image binary was
downloaded (D064).

### Identity resolution — NOT PERFORMED

The pilot comparison is evidence, not resolution. No canonical identity was
created, matched or written (D063).

### Zone-level completeness — UNVERIFIED

BAI reports 76 zones and returned properties in 59; DXB reports 29 and returned
21. Nothing indicates the missing zones hold hidden inventory, and nothing
proves they don't. It is recorded as a caveat rather than resolved by assumption.

### Booking, Expedia, Nuitee — NO LIVE ACCESS

Booking and Expedia: documented, `direct_access_unavailable`, `not_run`. Nuitee:
no documentation established, credential not supplied. **No cross-source overlap
analysis is possible with one live source**, so the bake-off cannot conclude.

---

# EXACT NEXT ACTION

**Stopped for external review.** Nothing further should run until these are
decided:

1. **Is a single-source bake-off enough to conclude?** Hotelbeds is measured;
   nothing else is. A "winner" declared against no competitor is not a
   comparison, and cross-source overlap (D063) needs a second live source.
2. **Secondary verification path for D060.** The provider-apparent
   `Hotel × 5 STARS` pairing is observable and its issuer is not. Deciding where
   canonical star provenance comes from is the gating question for V1 inventory.
3. **Media rights review** before any image work (D064).
4. **Whether coordinate enrichment proceeds** for the 26 pilot properties with a
   plausible Hotelbeds record — which requires an identity-resolution decision
   first, not a threshold invented here.

**The bake-off is not complete. The Coverage Engine must not start. Nothing has
been promoted into `hotels`.**

---

# CHRONOLOGICAL ATTEMPT HISTORY

Everything below is the record of how this evaluation got here. **It describes
past states, including states that are no longer true** — egress blocked,
credentials untested, extractions not run. It is preserved because the
corrections it documents are the reason the current numbers can be trusted, and
it must not be read as current status.

## Timeline

| Date | State |
|---|---|
| 2026-08-15 | Booking/Expedia documented from external review; both commercially unreachable. Documentation domains blocked by egress policy. |
| 2026-08-15 | Pivot to Hotelbeds. Credentials supplied and stored gitignored. `api.test.hotelbeds.com` **blocked**; credentials **untested**; 0 quota consumed. |
| 2026-08-15 | Correctness amendment I (below): capability gates, category master modelling, persistent quota ledger, account-aware cache. |
| 2026-08-16 | Correctness amendment II (below): egress modelled as a runtime observation, exhaustive master enumeration, category master wired into runs, cross-process lock. |
| 2026-08-16 | Host allowlisted. Probe: **credentials VALID**. Category master, Indonesia and UAE destination masters enumerated to exhaustion. 4 of 50 quota. |
| 2026-08-16 | External review approved `BAI`/`DXB` and locked the D060 decision. **Bali and Dubai extracted**; pilot comparison run. 11 of 50 quota. |

## Correctness amendment I (post-review of `6be3bf0`)

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

## Correctness amendment II — Phase A (post-review of `21345fc`)

Seven further issues, all fixed **without a single provider request**. Three were
blockers in the strict sense: with them in place, opening the network would not
have produced a correct run.

### A.1 The egress block was a permanent descriptor fact — CRITICAL

`capabilities.ts` folded `descriptor.blockers` into *every* capability, and the
Hotelbeds descriptor carried a hardcoded `"EGRESS BLOCKED"` string. Allowlisting
the host would have changed nothing: the stale string would still have blocked
every capability, and `liveValidationStatus: "blocked"` would have hardened a
temporary network condition into a permanent property of the provider.

Static facts and runtime observations are now separate kinds:

| Kind | Examples | Changes between runs? |
|---|---|---|
| **Descriptor fact** | endpoint, field semantics, classification issuer, geography | No |
| **`RuntimeObservation`** | egress, credential acceptance, live validation | Yes, every run |

A runtime observation starts at `egress: "unknown"` / `credentials: "untested"`,
and **`unknown` does not block** — the probe is what decides, so it has to be
allowed to run. Only a *currently observed* block blocks, and its reason says so
in words: "this is a runtime observation, not a provider fact — re-probe after
the host is allowlisted."

A regression test asserts the exact scenario: same descriptor, same run, only the
observation flipped to `reachable` — inventory, location and media become
runnable while `resolve_d060_classification` stays blocked on the unestablished
issuer. D060 is not weakened by any of this.

### A.2 Geography discovery was not exhaustive — CRITICAL

`fetchDestinations()` made **one** `from=1&to=1000` request and returned. Under
D061 that cannot silently mean "all destinations": a country with 1001 would lose
one and nothing in the output would say so.

It now uses the shared paginator, so exhaustion evidence, cursor-loop detection,
provider-total disagreement and budget interruption are handled identically to
every other enumeration rather than by a weaker parallel implementation. The walk
continues while the provider fills pages **or** its own reported total says there
is more; a full page is never assumed to be the end. Pagination evidence is
persisted with the candidates, and a budget or quota interruption marks the
result **INCOMPLETE** instead of returning a partial list as if it were whole.

### A.3 The category master was never wired into a live run — CRITICAL

`runProvider()` built no reference data and passed none to `executeEvaluation`,
so **every** category code would have resolved to `unresolved_no_master_entry`. A
provider supplying perfectly good classification evidence would have measured as
supplying none — and that number would have been used to judge it.

`fetchHotelbedsCategoryMaster()` now fetches the master — budget-guarded, cached,
raw persistence gitignored, duplicate codes surfaced rather than silently
overwritten — and a live run fetches it **first**, then hands the resulting
`ReferenceData` to the pipeline. It is available on its own as
`npm run eval:sources:categories`. A master that cannot be proven exhaustive is
reported as a coverage risk, because in that state an `unresolved` result may be
**our** gap rather than the provider's. Tested both ways: without the master the
codes are unresolved; with it they resolve.

### A.4 The property category field is DOCUMENTED, not CONFIRMED

`classification.codePath = "categoryCode"` is retained as the documented and
expected path and is explicitly **UNCONFIRMED** until a real payload settles it.

The failure this guards against is silent: a wrong path does not crash. It reads
`undefined`, normalizes cleanly, and reports **0% classification coverage** for a
provider that populates the field on every property — output indistinguishable
from a genuine finding.

So `field-verification.ts` checks every mapped path, including `codePath`,
against the actual payload **before any aggregate is computed**. A mapped path
resolving on zero sampled records raises `FIELD_MAP_MISMATCH`, writes the
verification artifact and stops the run. A path mismatch is our bug; it is never
published as the provider's zero.

### A.5 Ambiguous network failures now protect the allowance honestly

Four outcomes, three different answers:

| Outcome | Quota |
|---|---|
| Cache hit | not counted — no request was made |
| Explicit local egress denial (`x-deny-reason`) | not counted — it never left the sandbox |
| Any provider response, including 4xx/5xx and retries | counted |
| Network failure *after* the request was attempted | **counted as possibly consumed** |

The last row is the honest one. When a connection dies without a response we
cannot prove Hotelbeds did not receive and count it, so it is recorded as
`provider_reach_unknown` and reported separately from
`provider_reached_confirmed`. The summary carries both — `confirmed`,
`possiblyConsumed`, and a `remaining` that assumes the ambiguous ones were
charged. Under a 50/day allowance that asymmetry is the correct one: it can
under-spend, never over-spend.

### A.6 Two processes could both issue request 50

A cross-process lock now lives beside the ledger under the gitignored data
directory, created with an exclusive-create flag so a race loses cleanly rather
than overwriting. A second process refuses with a message naming the holder
instead of proceeding. A lock older than the staleness threshold is reclaimed —
deliberately, and the reclamation is **reported**, never silent.

Without it the ledger was necessary but not sufficient: two processes both
reading 49/50 would both have believed they had the last request.

### A.7 The daily-quota error misreported the limit

`new DailyQuotaExhaustedError(spent, spent + ledger.remaining())` collapses to
`spent` exactly when it fires — remaining is 0 at that moment — so a 50-request
account exhausted at 50 would report a limit of 50 only by coincidence, and any
other ledger state would print a fabricated number. The configured quota is now
passed directly and exposed as an explicit getter, so no caller reconstructs it.

---