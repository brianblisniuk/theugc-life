/**
 * Expedia Rapid (lodging) — adapter descriptor.
 *
 * STATUS: UNVERIFIED. Every provider-specific field below is intentionally
 * empty, for the same reason as the Booking descriptor: the evaluation brief
 * permits technical claims only from `developers.expediagroup.com`, and that
 * documentation was NOT reachable from the environment this block ran in (the
 * egress proxy returned 403 for `developers.expediagroup.com` and for
 * `api.ean.com`).
 *
 * TO COMPLETE THIS DESCRIPTOR, from official documentation only:
 *
 *  1. Identify the Property Content / Catalog endpoint used to enumerate
 *     properties, and the Geography endpoint used to resolve a region to its
 *     properties. Use content/geography rather than shopping availability to
 *     define existence.
 *  2. Record how large content responses are chunked or paginated, including
 *     any file-based delivery mechanism, and any documented cap.
 *  3. Record the exact response paths for: property id, name, category/type,
 *     address, coordinates, chain and brand, images and their metadata
 *     (including any hero/main indicator and dimensions), inactive/closed
 *     handling, and any provider-supplied contact.
 *  4. Establish the property rating field's semantics — the value, its type,
 *     and how the provider distinguishes ratings that originate from a local
 *     star authority from ratings the provider assigns itself. This distinction
 *     is the entire question for D060, and it must be measured in BOTH Bali and
 *     Dubai because it can differ by market. Put only authority-backed rating
 *     types into `starKindsAcceptedAsD060Evidence`.
 *  5. Record the guest-review score separately in `fieldMap.reviewScore`.
 *  6. Resolve how the provider's geography models Bali and Dubai, including
 *     whether several regions must be unioned.
 *  7. Record content and media usage constraints — attribution, caching,
 *     redistribution and storage — before any image is persisted.
 *
 * The star verdict is allowed to be destination-specific. If the evidence shows
 * authority-backed ratings in one market and provider-assigned ratings in the
 * other, record two findings rather than forcing one global verdict.
 */
import type { AdapterDescriptor } from "../types";

export const expediaRapidDescriptor: AdapterDescriptor = {
  provider: "expedia",
  displayName: "Expedia Rapid (lodging content)",
  documentationStatus: "unverified",
  sources: [],
  // Names only — values are never read into this object.
  requiredCredentialEnvVars: ["EXPEDIA_RAPID_API_KEY", "EXPEDIA_RAPID_SHARED_SECRET"],
  staticContentEndpoint: null,
  usesAvailabilityEndpointForCoverage: false,
  pagination: null,
  fieldMap: {},
  starSemantics: null,
  starKindsAcceptedAsD060Evidence: [],
  geography: [],
  blockers: [
    "Official documentation at developers.expediagroup.com was not reachable from the evaluation environment (egress proxy returned HTTP 403 on CONNECT).",
    "API host api.ean.com was not reachable from the evaluation environment (egress proxy returned HTTP 403 on CONNECT).",
    "Credentials EXPEDIA_RAPID_API_KEY and EXPEDIA_RAPID_SHARED_SECRET are NOT AVAILABLE in this environment.",
  ],
};
