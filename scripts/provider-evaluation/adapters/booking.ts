/**
 * Booking.com Demand API — adapter descriptor.
 *
 * STATUS: UNVERIFIED. Every provider-specific field below is intentionally
 * empty.
 *
 * Why it is empty rather than filled in from memory: the evaluation brief
 * requires that technical/API/field/terms claims come from
 * `developers.booking.com` only, and that documentation was NOT reachable from
 * the environment this block ran in (the egress proxy returned 403 for
 * `developers.booking.com` and `demandapi.booking.com`). Field paths written
 * from recollection would not fail loudly — they would read `undefined` and
 * report 0% coverage for fields the provider actually supplies, which is worse
 * than an empty descriptor because it looks like a measurement.
 *
 * TO COMPLETE THIS DESCRIPTOR, from official documentation only:
 *
 *  1. Identify the STATIC property-content endpoint used to enumerate what
 *     exists in a geography. Do NOT use an availability/search endpoint —
 *     "which properties have a room for these dates" is a different question
 *     from "which properties exist", and only the second can define a coverage
 *     universe.
 *  2. Record the pagination mechanism, page-size parameter, maximum page size
 *     and any documented hard cap on total results.
 *  3. Record the exact response paths for: property id, name, property type,
 *     address, latitude, longitude, brand/chain, website, photos, hero image,
 *     active/closed status, and any provider-supplied contact.
 *  4. Establish the star field's semantics — the value field, its type/qualifier
 *     field, the allowed values of that qualifier, and what each one means.
 *     Record which qualifier values represent an official hospitality
 *     classification whose provenance we can store and cite, and put ONLY those
 *     into `starKindsAcceptedAsD060Evidence`.
 *  5. Record the guest-review-score field separately in `fieldMap.reviewScore`
 *     so the harness can prove it is never read as a classification.
 *  6. Resolve how the provider models Bali and Dubai — the entity kind, the
 *     ids, and whether a union of several entities is required. Bali is the
 *     case that punishes assumption: it is an island of several areas, and
 *     querying a handful of well-known towns is not "Bali".
 *  7. Record content/storage/licensing constraints relevant to persisting
 *     property content and imagery.
 *
 * Set `documentationStatus` to "verified" only when every item above is backed
 * by a URL and an access date in `sources`.
 */
import type { AdapterDescriptor } from "../types";

export const bookingDemandDescriptor: AdapterDescriptor = {
  provider: "booking",
  displayName: "Booking.com Demand API",
  documentationStatus: "unverified",
  sources: [],
  // Names only — values are never read into this object.
  requiredCredentialEnvVars: ["BOOKING_DEMAND_API_TOKEN", "BOOKING_AFFILIATE_ID"],
  staticContentEndpoint: null,
  usesAvailabilityEndpointForCoverage: false,
  pagination: null,
  fieldMap: {},
  starSemantics: null,
  starKindsAcceptedAsD060Evidence: [],
  geography: [],
  blockers: [
    "Official documentation at developers.booking.com was not reachable from the evaluation environment (egress proxy returned HTTP 403 on CONNECT).",
    "API host demandapi.booking.com was not reachable from the evaluation environment (egress proxy returned HTTP 403 on CONNECT).",
    "Credentials BOOKING_DEMAND_API_TOKEN and BOOKING_AFFILIATE_ID are NOT AVAILABLE in this environment.",
  ],
};
