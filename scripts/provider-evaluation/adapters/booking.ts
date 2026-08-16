/**
 * Booking.com Demand API v3.2 — adapter descriptor.
 *
 * STATUS: PARTIALLY VERIFIED — not runnable.
 *
 * ## Provenance of the facts below
 *
 * The official documentation domains were NOT reachable from the Claude Code
 * execution environment (egress proxy returned HTTP 403 on CONNECT for
 * `developers.booking.com` and `demandapi.booking.com`). The endpoint,
 * authentication, pagination and response-field facts recorded here were
 * **independently verified during external review on 2026-08-15 from official
 * provider documentation** and supplied to this repository. Claude Code did not
 * fetch these pages.
 *
 * ## What is still missing, and why it blocks a run
 *
 *  1. **`rating.stars_type` semantics.** `official` is documented as one value,
 *     but the COMPLETE enum and the provenance meaning of each value are not
 *     established. Accepting `official` alone would be inferring an enum from a
 *     single example — the exact move D060 forbids — so
 *     `starKindsAcceptedAsD060Evidence` stays empty.
 *  2. **Bali and Dubai geography ids.** These require a live Booking location
 *     lookup; documentation alone does not supply them.
 *  3. **Credentials** are unavailable in this environment.
 */
import type { AdapterDescriptor, DocumentationSource } from "../types";

const EXTERNAL_REVIEW: Pick<DocumentationSource, "accessedAt" | "verifiedBy"> = {
  accessedAt: "2026-08-15",
  verifiedBy: "external_review",
};

export const bookingDemandDescriptor: AdapterDescriptor = {
  provider: "booking",
  displayName: "Booking.com Demand API v3.2",
  documentationStatus: "partially_verified",
  // Documented thoroughly and commercially unreachable — two different
  // facts, which is exactly why access is its own axis. Preserved as a
  // future strategic source; not deleted, not waited on.
  accessStatus: "direct_access_unavailable",
  liveValidationStatus: "not_run",
  strategicRole: "future_strategic_source",
  sources: [
    {
      url: "https://developers.booking.com/demand/docs/open-api/3.2/demand-api",
      ...EXTERNAL_REVIEW,
      note: "v3.2 base URLs: production https://demandapi.booking.com/3.2, sandbox https://demandapi-sandbox.booking.com/3.2.",
    },
    {
      url: "https://developers.booking.com/demand/docs/accommodations/look-accommodation-details",
      ...EXTERNAL_REVIEW,
      note: "POST /accommodations/details is STATIC property content; availability and pricing are separate endpoints.",
    },
    {
      url: "https://developers.booking.com/demand/docs/migration-guide/v3.2/accommodations/details",
      ...EXTERNAL_REVIEW,
      note: "Response evidence: id, name, accommodation_type, brands, contacts, location.address, location.coordinates.latitude/longitude, rating.review_score, rating.stars, rating.stars_type, url. extras=['photos'] retrieves photo/main-photo information.",
    },
    {
      url: "https://developers.booking.com/demand/docs/migration-guide/v3.2/accommodations/intro",
      ...EXTERNAL_REVIEW,
      note: "v3.2 metadata includes next_page and may include total_results. /accommodations/details/changes supports static-content change detection; closure statuses expanded to temporary, permanent, fraud.",
    },
    {
      url: "https://developers.booking.com/demand/docs/development-guide/pagination",
      ...EXTERNAL_REVIEW,
      note: "page = pagination token from metadata.next_page; rows = multiple of 10, 10..1000 for details.",
    },
    {
      url: "https://developers.booking.com/demand/docs",
      ...EXTERNAL_REVIEW,
      note: "Bearer token + X-Affiliate-Id authentication. 'Content only' integration model is explicitly supported.",
    },
  ],
  requiredCredentialEnvVars: ["BOOKING_DEMAND_API_TOKEN", "BOOKING_AFFILIATE_ID"],
  baseUrl: "https://demandapi.booking.com/3.2",
  // Static content, NOT availability/search. A coverage universe must come from
  // what exists, not from what has a room free on chosen dates.
  staticContentEndpoint: "POST /accommodations/details",
  usesAvailabilityEndpointForCoverage: false,
  pagination: {
    method: "page token from metadata.next_page",
    pageSizeParam: "rows",
    maxPageSize: 1000,
    // No documented total cap on the details endpoint; rows is a page size.
    documentedHardCap: null,
  },
  // Response paths are documented, but NOT yet exercised against a live payload.
  // They stay recorded here so the gate's remaining objections are precisely the
  // things still unknown, rather than everything.
  fieldMap: {
    sourcePropertyId: "id",
    name: "name",
    propertyType: "accommodation_type",
    address: "location.address",
    latitude: "location.coordinates.latitude",
    longitude: "location.coordinates.longitude",
    brand: "brands",
    chain: null,
    websiteUrl: "url",
    phone: null,
    providerContact: "contacts",
    starValue: "rating.stars",
    starKind: "rating.stars_type",
    reviewScore: "rating.review_score",
    photos: null,
    heroImage: null,
    activeStatus: null,
  },
  imageFieldMap: {},
  classification: {
    mode: "inline_value_and_kind",
    hotelAccommodationTypes: [],
    issuerEstablished: false,
  },
  starSemantics: [
    {
      provider: "booking",
      destination: "global",
      fieldName: "rating.stars",
      documentedSemantics:
        "A star value accompanied by rating.stars_type. `official` is documented as one stars_type value; the complete enum and the provenance meaning of each value are NOT established.",
      isHospitalityClassification: null,
      issuer: null,
      origin: null,
      scale: null,
      refreshBehaviour: null,
      provenanceAvailableToUs: null,
      observedConflicts: [],
      // No verdict. A single documented example is not an enum.
      verdict: null,
      hypothesis:
        "stars_type may distinguish official hospitality classifications from other star sources, but this must not be assumed from the single documented `official` example.",
      sources: [
        {
          url: "https://developers.booking.com/demand/docs/migration-guide/v3.2/accommodations/details",
          ...EXTERNAL_REVIEW,
        },
      ],
    },
  ],
  // Deliberately empty: accepting `official` would infer an enum from one example.
  starKindsAcceptedAsD060Evidence: [],
  starKindDocumentedAbsent: false,
  // accommodation_type vocabulary not yet enumerated from documentation.
  hospitalityPropertyTypes: [],
  geography: [],
  geographyEnumerationRisks: [
    "Bali and Dubai destination ids are unresolved; /accommodations/details requires at least one of accommodations, airport, city, country or region, and those ids need a live Booking location lookup.",
  ],
  operations: {
    paginationMethod: "page token from metadata.next_page; rows 10..1000 (multiples of 10)",
    stablePropertyIds: null,
    updateMechanism: "/accommodations/details/changes for static-content change detection",
    closedOrInactiveSupport:
      "v3.2 expanded closure statuses include temporary, permanent and fraud",
    documentedRefreshCadence: null,
    documentedRateLimits: null,
    credentialLevelRequired:
      "Bearer token + X-Affiliate-Id; 'Content only' integration model is supported",
    sandboxVsProductionNotes:
      "sandbox https://demandapi-sandbox.booking.com/3.2 vs production https://demandapi.booking.com/3.2",
  },
  media: {
    documentedUsageConstraints: [
      "extras=['photos'] retrieves property photos/main-photo information; storage, caching and attribution terms are NOT established and must be reviewed before any image is persisted (D064).",
    ],
  },
  capabilityBlockers: {},
  blockers: [
    "rating.stars_type: the complete allowed enum and the provenance semantics of each value are NOT established. `official` appears as a documented example and must not be treated as the whole enum, so no stars_type value is yet accepted as D060 evidence.",
    "Bali and Dubai provider geography ids are unresolved; they require a live Booking location lookup rather than documentation.",
    "Response field paths are documented but have not been exercised against a live payload.",
    "Credentials BOOKING_DEMAND_API_TOKEN and BOOKING_AFFILIATE_ID are NOT AVAILABLE in this environment.",
    "API host demandapi.booking.com was not reachable from the Claude Code environment (egress proxy returned HTTP 403 on CONNECT).",
  ],
};
