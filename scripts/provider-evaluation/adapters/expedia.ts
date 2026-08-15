/**
 * Expedia Rapid (lodging content) — adapter descriptor.
 *
 * STATUS: PARTIALLY VERIFIED — not runnable.
 *
 * ## Provenance of the facts below
 *
 * The official documentation domains were NOT reachable from the Claude Code
 * execution environment (egress proxy returned HTTP 403 on CONNECT for
 * `developers.expediagroup.com` and `api.ean.com`). The endpoint,
 * authentication, pagination, geography and ratings facts recorded here were
 * **independently verified during external review on 2026-08-15 from official
 * provider documentation** and supplied to this repository. Claude Code did not
 * fetch these pages.
 *
 * ## The coverage rule that matters most
 *
 * For larger geography types (`high_level_region`, `province_state`, `country`,
 * `continent`) property mappings return **up to the top 500 properties**, and the
 * full list requires requesting the descendants that comprise the region. A
 * single large-region result is therefore NOT exhaustive, and treating one as a
 * destination universe would silently cap inventory — precisely the D055/D061
 * failure the coverage contract exists to prevent. It is recorded under
 * `geographyEnumerationRisks` — NOT as a Content API pagination cap, because the
 * two are different mechanisms and conflating them would raise a false coverage
 * alarm on any content extraction past 500 records.
 *
 * ## What is still missing, and why it blocks a run
 *
 *  1. **Bali and Dubai geography ids and their descendant sets** — these require
 *     live Geography API calls, not documentation.
 *  2. **Live confirmation of the ratings hypothesis** below.
 *  3. **Credentials** are unavailable in this environment.
 */
import type { AdapterDescriptor, DocumentationSource } from "../types";

const EXTERNAL_REVIEW: Pick<DocumentationSource, "accessedAt" | "verifiedBy"> = {
  accessedAt: "2026-08-15",
  verifiedBy: "external_review",
};

export const expediaRapidDescriptor: AdapterDescriptor = {
  provider: "expedia",
  displayName: "Expedia Rapid (lodging content)",
  documentationStatus: "partially_verified",
  // Documented thoroughly and commercially unreachable — two different
  // facts, which is exactly why access is its own axis. Preserved as a
  // future strategic source; not deleted, not waited on.
  accessStatus: "direct_access_unavailable",
  liveValidationStatus: "not_run",
  strategicRole: "future_strategic_source",
  sources: [
    {
      url: "https://developers.expediagroup.com/rapid/lodging",
      ...EXTERNAL_REVIEW,
      note: "Rapid Lodging static content requires daily refreshes per the official Lodging overview.",
    },
    {
      url: "https://developers.expediagroup.com/rapid/lodging/content/about-content-api",
      ...EXTERNAL_REVIEW,
      note: "GET https://api.ean.com/v3/properties/content with language and supply_source parameters. Content API is recommended over Content File APIs for expanded global inventory; the Property Catalog File covers the primary active-property list but Content File APIs have limited expanded-global-inventory support.",
    },
    {
      url: "https://developers.expediagroup.com/rapid/lodging/content/content-pagination",
      ...EXTERNAL_REVIEW,
      note: 'Follow the Link response header rel="next" until no next Link exists. Pagination-Total-Results is available as result-count evidence.',
    },
    {
      url: "https://developers.expediagroup.com/rapid/lodging/content/content-filtering",
      ...EXTERNAL_REVIEW,
      note: "Incremental filters include date_updated_start and date_added_start; an inactive-property endpoint exists.",
    },
    {
      url: "https://developers.expediagroup.com/rapid/lodging/content/content-reference-lists",
      ...EXTERNAL_REVIEW,
      note: "Property category reference list includes Hotel, Resort, Villa, Lodge, Apartment, Aparthotel, Residence and many other types.",
    },
    {
      url: "https://developers.expediagroup.com/rapid/lodging/content/star-ratings",
      ...EXTERNAL_REVIEW,
      note: "ratings.property.type distinguishes official vs Expedia Group source. Half-star values such as 3.5 and 4.5 are supported. descriptions.national_ratings describes the source of the star rating.",
    },
    {
      url: "https://developers.expediagroup.com/rapid/lodging/geography/about-geography-api",
      ...EXTERNAL_REVIEW,
      note: "Region hierarchy plus property mappings. For high_level_region, province_state, country and continent, property MAPPINGS return up to the TOP 500 properties; the full list requires requesting descendants. This is a geography-enumeration limit, not a Content API pagination cap.",
    },
    {
      url: "https://developers.expediagroup.com/rapid/lodging/reference/signature-authentication",
      ...EXTERNAL_REVIEW,
      note: "Authorization: EAN APIKey=...,Signature=SHA512(apiKey + sharedSecret + unixTimestamp),timestamp=...",
    },
  ],
  requiredCredentialEnvVars: ["EXPEDIA_RAPID_API_KEY", "EXPEDIA_RAPID_SHARED_SECRET"],
  baseUrl: "https://api.ean.com/v3",
  // Content, NOT shopping availability.
  staticContentEndpoint: "GET /properties/content?language=en-US&supply_source=expedia",
  usesAvailabilityEndpointForCoverage: false,
  pagination: {
    method: 'Link response header rel="next" until absent; Pagination-Total-Results for counts',
    pageSizeParam: null,
    maxPageSize: null,
    // NO documented cap on the Content API itself. The top-500 limit belongs to
    // Geography property MAPPINGS for large region types and is recorded under
    // `geographyEnumerationRisks`. Encoding it here was wrong: it would fire a
    // coverage warning on any content extraction past 500 records, which is a
    // different mechanism entirely.
    documentedHardCap: null,
  },
  fieldMap: {
    sourcePropertyId: "property_id",
    name: "name",
    propertyType: "category.name",
    address: "address.line_1",
    latitude: "location.coordinates.latitude",
    longitude: "location.coordinates.longitude",
    brand: "brand.name",
    chain: "chain.name",
    websiteUrl: null,
    phone: "phone",
    providerContact: null,
    starValue: "ratings.property.rating",
    starKind: "ratings.property.type",
    // Left UNSET (not null): the documented content sections supplied to us do
    // not establish whether a guest-review score is present. `null` would claim
    // a documented absence we have not verified.
    reviewScore: undefined,
    photos: "images",
    heroImage: "hero_image",
    activeStatus: null,
  },
  starSemantics: [
    {
      provider: "expedia",
      destination: "dubai",
      fieldName: "ratings.property.rating",
      documentedSemantics:
        "ratings.property.type distinguishes official local-authority ratings from Expedia Group assigned ratings in regions where local authorities designate official ratings. The UAE is documented among those regions, where type=`star` means the rating came from the property's local star-rating authority. `alternate` is NOT that official signal.",
      isHospitalityClassification: true,
      issuer: "Local star-rating authority (documented for UAE among others)",
      origin: "official_authority",
      scale: "Supports half-star values such as 3.5 and 4.5",
      refreshBehaviour: "Static content requires daily refreshes",
      provenanceAvailableToUs: null,
      observedConflicts: [],
      // Documentary evidence supports a hypothesis, not a verdict.
      verdict: null,
      hypothesis:
        "CANDIDATE SUITABLE: ratings.property.type=`star` in the UAE is a candidate for D060 evidence, subject to live validation and a provenance-storage review. `alternate` is not sufficient as official-local-authority evidence.",
      sources: [
        {
          url: "https://developers.expediagroup.com/rapid/lodging/content/star-ratings",
          ...EXTERNAL_REVIEW,
        },
      ],
    },
    {
      provider: "expedia",
      destination: "bali",
      fieldName: "ratings.property.rating",
      documentedSemantics:
        "For properties in regions other than those where local authorities designate official ratings, the official documentation says the returned rating is Expedia-assigned regardless of type, and an official rating is unavailable through that mechanism. Indonesia is not among the documented official-rating regions.",
      isHospitalityClassification: false,
      issuer: "Expedia Group",
      origin: "provider_normalized",
      scale: "Supports half-star values such as 3.5 and 4.5",
      refreshBehaviour: "Static content requires daily refreshes",
      provenanceAvailableToUs: null,
      observedConflicts: [],
      verdict: null,
      hypothesis:
        "LIKELY REQUIRES SECONDARY VERIFICATION: an Expedia-assigned rating alone is not sufficient to resolve D060 canonical classification for publication. descriptions.national_ratings may carry a citable source and should be evaluated live.",
      sources: [
        {
          url: "https://developers.expediagroup.com/rapid/lodging/content/star-ratings",
          ...EXTERNAL_REVIEW,
        },
      ],
    },
  ],
  // Empty until the hypothesis is confirmed live and provenance storage reviewed.
  starKindsAcceptedAsD060Evidence: [],
  starKindDocumentedAbsent: false,
  // Documented category list. Deliberately broad: D060 §2.2 makes type
  // descriptive, and pre-filtering to Hotel would hide eligible resorts,
  // villas, aparthotels, lodges and residences.
  hospitalityPropertyTypes: [
    "Hotel",
    "Resort",
    "Villa",
    "Lodge",
    "Apartment",
    "Aparthotel",
    "Residence",
  ],
  geography: [],
  geographyEnumerationRisks: [
    "Geography API property MAPPINGS for high_level_region, province_state, country and continent return up to the TOP 500 properties. Enumerating such a region requires requesting the descendants that comprise it; a single large-region mapping result is NOT exhaustive. This constrains GEOGRAPHY ENUMERATION, not Content API pagination.",
  ],
  operations: {
    paginationMethod: 'Link header rel="next" until absent; Pagination-Total-Results for counts',
    stablePropertyIds: null,
    updateMechanism:
      "Incremental content filters (date_updated_start, date_added_start); inactive-property endpoint exists",
    closedOrInactiveSupport: "Inactive-property endpoint documented",
    documentedRefreshCadence: "Daily refreshes required for static content",
    documentedRateLimits: null,
    credentialLevelRequired:
      "EAN APIKey + Signature=SHA512(apiKey + sharedSecret + unixTimestamp) + timestamp",
    sandboxVsProductionNotes: null,
  },
  media: {
    documentedUsageConstraints: [
      "images[] supply caption, hero_image, category and links with multiple image sizes.",
      "Storage, caching, redistribution and attribution terms are NOT established and must be reviewed before any image is persisted (D064).",
    ],
  },
  blockers: [
    "Bali and Dubai provider geography ids are unresolved, including the DESCENDANT region sets required to exceed the documented top-500 property-mapping cap for larger region types.",
    "Star hypotheses (UAE type=`star` candidate-suitable; Indonesia likely requires secondary verification) are documentary and unconfirmed against live data, so no stars_type value is yet accepted as D060 evidence.",
    "Whether star provenance can be stored and cited — publishability condition 7 (D062) — is unresolved.",
    "Credentials EXPEDIA_RAPID_API_KEY and EXPEDIA_RAPID_SHARED_SECRET are NOT AVAILABLE in this environment.",
    "API host api.ean.com was not reachable from the Claude Code environment (egress proxy returned HTTP 403 on CONNECT).",
  ],
};
