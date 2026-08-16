/**
 * Nuitee / LiteAPI — secondary candidate, documentary only.
 *
 * Recorded so the source strategy has a named self-service fallback, and so a
 * later block can supply a credential without re-deriving the context.
 *
 * NOTHING here is measured and nothing is claimed about its content schema: the
 * evaluation environment could not reach its documentation either, and no
 * external-review evidence was supplied for it. Its field map is therefore
 * empty rather than plausible — a plausible-looking guess is the failure mode
 * this harness exists to prevent.
 */
import type { AdapterDescriptor } from "../types";

export const nuiteeLiteApiDescriptor: AdapterDescriptor = {
  provider: "nuitee",
  displayName: "Nuitee / LiteAPI",
  documentationStatus: "unverified",
  accessStatus: "self_service_available_credential_not_supplied",
  liveValidationStatus: "not_run",
  strategicRole: "secondary_candidate",
  sources: [],
  requiredCredentialEnvVars: ["NUITEE_API_KEY"],
  baseUrl: null,
  staticContentEndpoint: null,
  usesAvailabilityEndpointForCoverage: false,
  pagination: null,
  fieldMap: {},
  imageFieldMap: {},
  classification: {
    mode: "unknown",
    hotelAccommodationTypes: [],
    issuerEstablished: false,
  },
  starSemantics: [],
  starKindsAcceptedAsD060Evidence: [],
  starKindDocumentedAbsent: false,
  hospitalityPropertyTypes: [],
  geography: [],
  geographyEnumerationRisks: [],
  operations: {
    paginationMethod: null,
    stablePropertyIds: null,
    updateMechanism: null,
    closedOrInactiveSupport: null,
    documentedRefreshCadence: null,
    documentedRateLimits: null,
    credentialLevelRequired: "Self-service sandbox key (not yet supplied)",
    sandboxVsProductionNotes: null,
  },
  media: { documentedUsageConstraints: [] },
  capabilityBlockers: {},
  blockers: [
    "SELF_SERVICE_SANDBOX_AVAILABLE / CREDENTIAL_NOT_YET_SUPPLIED: NUITEE_API_KEY is NOT AVAILABLE.",
    "LIVE_NOT_RUN: no request has been made and no metric exists.",
    "No official documentation has been established for this provider in this repository; its field map is intentionally empty rather than guessed.",
  ],
};
