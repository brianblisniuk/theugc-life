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
 * proxy (HTTP 403 on CONNECT), as is `api.test.hotelbeds.com`.
 *
 * ## Star classification — the careful part
 *
 * Hotelbeds category standards **differ by country**, and the official examples
 * distinguish `HOTEL + "5 STAR"` from `APARTMENT + "5 KEY"`. So
 * `simpleCode == 5` does NOT mean "5-star hotel": it may mean five keys on an
 * apartment, which is a different classification scheme entirely.
 *
 * `starKindsAcceptedAsD060Evidence` is therefore EMPTY. The category code alone
 * cannot resolve D060 until the accommodation-type semantics and the issuing
 * authority are established per country. That is a live-data question.
 *
 * This does **not** disqualify Hotelbeds. Under the layered-source principle a
 * provider may be an excellent inventory, location and media source while its
 * classification requires secondary verification.
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
  liveValidationStatus: "blocked",
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
      note: "images[] carry path, order, visualOrder, type and room metadata where relevant; visualOrder = 0 can identify a principal image when present.",
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
    // collection via `visualOrder = 0` (see imageFieldMap).
    heroImage: null,
    activeStatus: "status",
  },
  imageFieldMap: {
    path: "path",
    type: "imageTypeCode",
    visualOrder: "visualOrder",
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
  geography: [],
  geographyEnumerationRisks: [
    "Bali and Dubai destination codes are UNRESOLVED. They must be read from Content API country/destination master data, never assumed, and Bali may require a UNION of several destination codes rather than one city.",
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
    assess_classification: [
      "Category master join is documented but unexercised: the exact category-code field on the hotels response has not been confirmed against a live payload.",
    ],
    resolve_d060_classification: [
      "Category standards are country-dependent and the issuing authority is undocumented, so no category resolves D060 ('5 KEY' on an apartment is not five hotel stars).",
      "accommodationType distribution has not been observed, so no accommodation type is accepted as carrying a hotel star classification.",
      "Whether classification provenance can be stored and cited — publishability condition 7 (D062) — is unresolved.",
    ],
  },
};
