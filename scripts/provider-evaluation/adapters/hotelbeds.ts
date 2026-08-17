/**
 * HBX Group / Hotelbeds Hotel Content API — adapter descriptor.
 *
 * STATUS: documentation `partially_verified` · access `credentials_available`.
 *
 * Egress and credential state are RUNTIME observations, established by the probe
 * on each run — not static descriptor facts. `liveValidationStatus` records the
 * last outcome for reporting; it never gates a future run.
 *
 * ## Provenance
 *
 * Endpoint, authentication, pagination and content facts were **independently
 * verified during external review on 2026-08-15 from official HBX/Hotelbeds
 * documentation** and supplied to this repository. Claude Code did not fetch
 * those pages: `developer.hotelbeds.com` is blocked by this environment's egress
 * proxy (HTTP 403 on CONNECT). The API host `api.test.hotelbeds.com` was
 * subsequently allowlisted and HAS been reached (2026-08-16).
 *
 * ## Star classification — SETTLED BY EXTERNAL REVIEW, 2026-08-16
 *
 * The live category master (65 codes, enumerated to exhaustion) settled the open
 * question, and it settled it against the optimistic reading:
 *
 *   simpleCode 5 → 5EST, 5LUX, H5_5 … and also 5LL (5 KEYS), APTH5, BB5, HS5,
 *                  HR5, HIST
 *   simpleCode 4 → 4EST, 4LUX, H4_5 … and also 4LL (4 KEYS), VILLA, BOU, RSORT,
 *                  AT1 (APARTMENT 1ST CATEGORY), AG, POUSA, SUP
 *
 * `simpleCode` conflates different classification SYSTEMS and different property
 * TYPES. `accommodationType` — the intended discriminator — was EMPTY (`""`) on
 * all 65 records, so it cannot separate them either.
 *
 * The finding stands: neither `simpleCode`, nor `group`, nor free-text
 * `description` alone is canonical provenance, and an observation here is
 * PROVIDER_CLASSIFICATION_EVIDENCE, never canonical by itself (D065).
 *
 * SUPERSEDED 2026-08-17 (D066): the CONCLUSION that this "requires secondary
 * verification" is withdrawn. Canonical classification is theugc.life's resolved
 * product truth backed by accepted source evidence, and one approved provider is
 * sufficient when a reviewed policy maps the exact `categoryCode`. That mapping
 * lives in `scripts/provider-classification/hotelbeds.ts` and is documented in
 * `docs/PROPERTY_SOURCE_CLASSIFICATION_POLICY.md` §5 — four approved codes
 * (`4EST`, `4LUX`, `5EST`, `5LUX`), every other register unresolved.
 *
 * This EVALUATION descriptor is unchanged in behaviour: it measures what the
 * provider exposes, and Hotelbeds exposes no star FIELD, so
 * `starKindsAcceptedAsD060Evidence` stays empty and this harness still resolves
 * nothing. Resolution is the star resolver's job, through the policy — not this
 * module's.
 *
 * What we DO with the evidence here: preserve the exact provider `categoryCode`,
 * preserve the joined master, and report distributions — including a
 * PROVIDER-APPARENT star breakdown clearly labelled as provider classification,
 * not D060 resolution. "4.5"/"5.5"-style categories (`H4_5`, `H5_5`) must never
 * become exact 4 or exact 5.
 */
import type { AdapterDescriptor, DocumentationSource } from "../types";

const EXTERNAL_REVIEW: Pick<DocumentationSource, "accessedAt" | "verifiedBy"> = {
  accessedAt: "2026-08-15",
  verifiedBy: "external_review",
};

export const hotelbedsContentDescriptor: AdapterDescriptor = {
  provider: "hotelbeds",
  displayName: "HBX Group / Hotelbeds Hotel Content API",
  documentationStatus: "partially_verified",
  accessStatus: "credentials_available",
  // Last observed outcome, for reporting only. It never gates a future run —
  // the probe does.
  liveValidationStatus: "validated",
  strategicRole: "active_evaluation",
  sources: [
    {
      url: "https://developer.hotelbeds.com/documentation/getting-started/",
      ...EXTERNAL_REVIEW,
      note: "Evaluation base https://api.test.hotelbeds.com. Every request carries Api-key and X-Signature = lowercase hex SHA256(apiKey + secret + unixTimestampSeconds).",
    },
    {
      url: "https://developer.hotelbeds.com/documentation/hotels/content-api/",
      ...EXTERNAL_REVIEW,
      note: "Hotel Content API is STATIC content, not availability.",
    },
    {
      url: "https://developer.hotelbeds.com/documentation/hotels/content-api/how-use-content-api/",
      ...EXTERNAL_REVIEW,
      note: "HBX recommends batch retrieval into the integrator's own database; Content API is not a per-user realtime lookup. Hotels operation supports pages of up to 1000 hotels; initial/global loads use from/to; differential updates use lastUpdateTime.",
    },
    {
      url: "https://developer.hotelbeds.com/documentation/hotels/content-api/categories-category-group/",
      ...EXTERNAL_REVIEW,
      note: "Category standards differ by country. Official examples distinguish HOTEL + '5 STAR' from APARTMENT + '5 KEY'.",
    },
    {
      url: "https://developer.hotelbeds.com/documentation/hotels/content-api/photos-images/",
      ...EXTERNAL_REVIEW,
      note: "images[] carry path, order, visualOrder, type and room metadata where relevant. visualOrder = 0 identifies the hotel's main/principal image, and the documentation explicitly states that some hotels may not carry that number — so its absence is a documented valid state, not a gap.",
    },
    {
      url: "https://developer.hotelbeds.com/documentation/hotels/content-api/use-images/",
      ...EXTERNAL_REVIEW,
      note: "Image base https://photos.hotelbeds.com/giata/ with documented size variants: standard, small, medium, bigger (~800), xl (~1024), xxl (~2048), original.",
    },
    {
      url: "https://developer.hotelbeds.com/documentation/hotels/content-api/api-reference/",
      ...EXTERNAL_REVIEW,
      note: "Static content includes hotel identity, descriptions, location/address, coordinates, category, accommodation metadata, facilities and images.",
    },
  ],
  requiredCredentialEnvVars: ["HOTELBEDS_API_KEY", "HOTELBEDS_SECRET"],
  baseUrl: "https://api.test.hotelbeds.com",
  staticContentEndpoint: "GET /hotel-content-api/1.0/hotels",
  usesAvailabilityEndpointForCoverage: false,
  pagination: {
    method: "from/to window over the hotels operation",
    pageSizeParam: "to",
    maxPageSize: 1000,
    // No documented total cap on the hotels operation itself.
    documentedHardCap: null,
  },
  // Field paths are documented but NOT yet exercised against a live payload;
  // that is recorded as a blocker rather than presented as confirmed.
  fieldMap: {
    sourcePropertyId: "code",
    name: "name.content",
    propertyType: "accommodationTypeCode",
    address: "address.content",
    latitude: "coordinates.latitude",
    longitude: "coordinates.longitude",
    brand: "chainCode",
    chain: "chainCode",
    websiteUrl: "web",
    phone: "phones.0.phoneNumber",
    providerContact: "email",
    // NOT a star path. Hotelbeds expresses classification as a CODE on the
    // property, resolved through the categories master (see `classification`).
    // Pointing starValue at "category.simpleCode" assumed the hotels response
    // embeds a category object, which the documented architecture does not say.
    starValue: null,
    starKind: null,
    // Content API is a static-content product; a guest-review score is not among
    // the documented sections. Left UNSET rather than null: absence has not been
    // positively documented, and claiming it would be the error class this
    // harness exists to prevent.
    reviewScore: undefined,
    photos: "images",
    // No principal-image FIELD on the property; it is derived from the images
    // collection (see imageFieldMap).
    heroImage: null,
    // FIELD_MAP_MISMATCH, fixed 2026-08-16. This pointed at `status`, which does
    // not exist anywhere in the live hotels payload — the Content API hotels
    // response carries NO lifecycle field. Left mapped it would have reported
    // "0% active-status coverage", which reads as a provider weakness rather
    // than our wrong path. Provider lifecycle state does surface elsewhere, but
    // only as a `*CLOSED` suffix inside destination NAMES.
    activeStatus: null,
  },
  imageFieldMap: {
    path: "path",
    type: "imageTypeCode",
    visualOrder: "visualOrder",
    // PROVIDER-DESIGNATED PRINCIPAL, documented semantics VERIFIED.
    //
    // HBX documents `visualOrder = 0` as the hotel's main/principal image AND
    // explicitly notes that it is possible to find hotels without that number;
    // its own examples show non-zero values (903, 38, 2 …). So a property
    // carrying no zero is in a DOCUMENTED, ALLOWED state.
    //
    // Live counts (Bali 103, Dubai 20) therefore confirm the documentation
    // rather than contradicting it: HBX designates a principal image for that
    // subset. The absence on the rest is not reinterpreted — not as a
    // documentation error, not as missing images, and not as a provider defect.
    //
    // Local fallback selection stays OFF. A deterministically-chosen image is
    // not a principal image: HBX has not documented whether maximum, minimum
    // non-zero or first-array-entry is intended, so choosing one would
    // manufacture a provider semantic we do not have.
    principalSelector: "visual_order_zero",
  },
  classification: {
    // The documented architecture: the hotels operation returns CODES, and the
    // descriptive/master operations explain them.
    mode: "code_with_master_lookup",
    codePath: "categoryCode",
    // Empty until the live accommodationType distribution is observed. With none
    // declared, no classification resolves D060 — which is the honest state.
    hotelAccommodationTypes: [],
    // No issuing authority is documented for Hotelbeds categories.
    issuerEstablished: false,
  },
  starSemantics: [
    {
      provider: "hotelbeds",
      destination: "global",
      fieldName: "category.simpleCode",
      documentedSemantics:
        "Category codes with a simpleCode and a description. Standards differ by country, and official examples distinguish HOTEL + '5 STAR' from APARTMENT + '5 KEY'. simpleCode alone therefore does not identify a hotel star classification.",
      isHospitalityClassification: null,
      issuer: null,
      origin: "unclear",
      scale: "Country-dependent; simpleCode is not a universal star scale",
      refreshBehaviour: "Static content, batch-refreshed by the integrator",
      provenanceAvailableToUs: null,
      observedConflicts: [],
      verdict: null,
      hypothesis:
        "LIKELY REQUIRES SECONDARY VERIFICATION: category may identify a hotel classification, but the issuing authority is not documented and 'KEY' vs 'STAR' semantics vary by country. Must be measured separately for Indonesia (Bali) and the UAE (Dubai).",
      sources: [
        {
          url: "https://developer.hotelbeds.com/documentation/hotels/content-api/categories-category-group/",
          ...EXTERNAL_REVIEW,
        },
      ],
    },
  ],
  // Empty on purpose: `simpleCode == 5` may be five KEYS on an apartment.
  starKindsAcceptedAsD060Evidence: [],
  starKindDocumentedAbsent: false,
  // Deliberately empty until the live accommodationType/category distribution is
  // observed. Pre-filtering to HOTEL would hide eligible hospitality properties
  // (D060 §2.2), and guessing which codes are hospitality would prejudge scope.
  hospitalityPropertyTypes: [],
  // Resolved from LIVE master data on 2026-08-16 and approved by external review.
  //
  // Approval scope is narrow and deliberate: this is "provider enumeration
  // mapping accepted for the Hotelbeds bake-off", NOT "Bali/Dubai coverage
  // complete". D061 closure is untouched by anything recorded here.
  geography: [
    {
      destination: "bali",
      providerEntityIds: ["BAI"],
      providerEntityKind: "destinationCode (provider name: Bali)",
      resolutionMethod:
        "Indonesia (ID) destination master enumerated EXHAUSTIVELY on 2026-08-16: 178 of 178 returned, provider total matched, exhaustion proven. BAI is the single provider destination named Bali and carries 76 zones. Denpasar, Ubud, Kuta, Seminyak, Canggu, Nusa Dua, Jimbaran, Sanur and Uluwatu are NOT peer destination records in that universe — they sit beneath BAI as zones. Approved by external review.",
      requiresUnion: false,
      caveats: [
        "Lombok (AMI, and 46J Lombok Timur) is a SEPARATE provider destination and is explicitly NOT part of this mapping.",
        "BAI's 76 zones have not been enumerated individually. If live hotel evidence shows records inconsistent with this mapping, that is a GEOGRAPHY_MAPPING_CONTRADICTION and the run must stop rather than reconcile it silently.",
      ],
    },
    {
      destination: "dubai",
      providerEntityIds: ["DXB"],
      providerEntityKind: "destinationCode (provider name: Dubai)",
      resolutionMethod:
        "UAE (AE) destination master enumerated EXHAUSTIVELY on 2026-08-16: 10 of 10 returned, provider total matched, exhaustion proven. DXB is the unambiguous Dubai provider destination and carries 29 zones. Approved by external review.",
      requiresUnion: false,
      caveats: [
        "DXB's 29 zones have not been enumerated individually; a record returned under DXB but inconsistent with Dubai is a GEOGRAPHY_MAPPING_CONTRADICTION.",
        "The UAE master carries lifecycle state inside the NAME string (03I 'Al Noaf *CLOSED') rather than a status field. Not part of this mapping, but it means provider lifecycle cannot be read from a structured field here.",
      ],
    },
  ],
  geographyEnumerationRisks: [
    "HBX documents a GLOBAL initial-load procedure of roughly 173 hotel-page requests. That is incompatible with a 50-request/day evaluation quota and must NOT be attempted; only targeted destination retrieval is acceptable here.",
  ],
  operations: {
    paginationMethod: "from/to window, up to 1000 hotels per page",
    stablePropertyIds: null,
    updateMechanism: "lastUpdateTime differential updates",
    closedOrInactiveSupport: null,
    documentedRefreshCadence: "Batch retrieval into the integrator's own database",
    documentedRateLimits:
      "Evaluation Plan: 50 requests/day. Owner dashboard also reports 8 requests / 4 seconds, quota reset every 86400s.",
    credentialLevelRequired: "Api-key + X-Signature (test/evaluation credentials)",
    sandboxVsProductionNotes:
      "Evaluation base https://api.test.hotelbeds.com; production is a separate host and separate approval.",
  },
  media: {
    documentedUsageConstraints: [
      "Image base https://photos.hotelbeds.com/giata/ with size variants standard, small, medium, bigger (~800), xl (~1024), xxl (~2048), original.",
      "images[] carry path, order, visualOrder and type; visualOrder = 0 can identify a principal image when present.",
      "TECHNICALLY_AVAILABLE / PRODUCTION_RIGHTS_REVIEW_REQUIRED: redistribution and storage rights are governed by the commercial contract and are NOT established by developer documentation (D064).",
    ],
  },
  // STATIC provider facts only.
  //
  // Egress state deliberately does NOT live here. It is a runtime observation
  // (see `RuntimeObservation`): baking a previous run's network failure into the
  // descriptor would leave every capability blocked by a stale string even after
  // the host is allowlisted.
  blockers: [],
  // Dimension-scoped blockers. Crucially, the unresolved classification issuer
  // does NOT appear under inventory/location/media — those are measurable as
  // soon as egress and geography exist.
  capabilityBlockers: {
    // CONFIRMED against live payloads 2026-08-16: `categoryCode` is present on
    // every Bali and Dubai record and joined the master at 100%.
    assess_classification: [],
    resolve_d060_classification: [
      "THIS EVALUATION HARNESS resolves no Hotelbeds classification, because Hotelbeds exposes no star FIELD for it to read. That is a statement about this module, not a product verdict: D060 resolution runs through the reviewed categoryCode policy in scripts/provider-classification/hotelbeds.ts (D066), which approves 4EST/4LUX as exactly four and 5EST/5LUX as exactly five.",
      "OBSERVED in the live 65-code master, and STILL BINDING: simpleCode conflates classification systems and property types. simpleCode 5 includes 5LL (5 KEYS), APTH5, BB5, HS5, HR5 and HIST; simpleCode 4 includes VILLA, BOU, RSORT and AT1 (APARTMENT 1ST CATEGORY). This is exactly why the approved policy maps categoryCode and never simpleCode.",
      "OBSERVED in live inventory, and STILL BINDING: a STAR-labelled category does NOT imply a hotel. Dubai returns Apartment x '4 STARS' and Aparthotel x '5 STARS'; Bali returns Bed-and-breakfast, Guest-house and Resort records carrying STAR categories. Under D060 property type neither admits nor excludes, and the approved policy resolves only the specific hotel-star codes regardless of the type beside them.",
      "Category `group` and free-text `description` are not accepted as canonical D060 provenance either.",
      "SUPERSEDED 2026-08-17 (D066): 'no issuing authority is established, so condition 7 cannot be satisfied' is withdrawn. Canonical classification is resolved PRODUCT truth backed by accepted source evidence; a government or tourism registry is optional corroboration, never a precondition.",
    ],
  },
};
