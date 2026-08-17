/**
 * Pair evidence for pre-publication entity resolution.
 *
 * Given two candidate records, this module states what the evidence SAYS. It
 * does not say what the evidence MEANS, and there is no function here that
 * returns a match, a score, a confidence or a recommendation — D063 §12.2
 * refuses a universal entity-resolution threshold, and any such return value
 * would be one.
 *
 * The vocabulary is 0027's, unchanged:
 *
 *   name_evidence     exact | token_containment | none
 *   *_evidence        agrees | differs | unavailable
 *   coordinate_distance_metres   raw number, or NULL
 *
 * `unavailable` is NOT `differs`. "Neither side supplied a phone" is not
 * evidence against a match, and collapsing the two would turn missing data into
 * a negative finding — which, in a review queue, reads as a reason to reject.
 */
import {
  haversineMetres,
  isComparablePhoneType,
  nameContainment,
  normalizeAddress,
  normalizeBrand,
  normalizeDomain,
  normalizeName,
  normalizePhone,
} from "./normalize";

export type NameEvidence = "exact" | "token_containment" | "none";
export type DimensionEvidence = "agrees" | "differs" | "unavailable";

/** One side of a comparison, as observed. Nothing here is canonical. */
export interface ComparableRecord {
  name: string | null;
  websiteUrl: string | null;
  address: string | null;
  phone: string | null;
  phoneType: string | null;
  brandCode: string | null;
  chainCode: string | null;
  latitude: number | null;
  longitude: number | null;
}

export interface PairEvidence {
  nameEvidence: NameEvidence;
  domainEvidence: DimensionEvidence;
  addressEvidence: DimensionEvidence;
  phoneEvidence: DimensionEvidence;
  brandEvidence: DimensionEvidence;
  coordinateDistanceMetres: number | null;
}

/**
 * Compare two normalised values.
 *
 * The whole of the `agrees`/`differs`/`unavailable` rule lives here, in three
 * lines, so it cannot drift between dimensions: EITHER side missing means the
 * comparison could not be made.
 */
function compare(a: string | null, b: string | null): DimensionEvidence {
  if (a === null || b === null) return "unavailable";
  return a === b ? "agrees" : "differs";
}

function compareName(a: string | null, b: string | null): NameEvidence {
  const left = normalizeName(a);
  const right = normalizeName(b);
  if (left === null || right === null) return "none";
  if (left === right) return "exact";
  return nameContainment(a, b) ? "token_containment" : "none";
}

/**
 * The brand dimension reads the provider's brand code, falling back to its
 * chain code — one dimension, because a property has one operator identity and
 * counting brand and chain separately would manufacture two agreements from
 * one fact.
 *
 * Note what agreement here means: two Hiltons agree on brand and are still two
 * different hotels. That is exactly why this is evidence and not a decision.
 */
function brandOf(record: ComparableRecord): string | null {
  return normalizeBrand(record.brandCode) ?? normalizeBrand(record.chainCode);
}

/** The phone this record can be compared on, if any. */
export function comparablePhone(record: ComparableRecord): string | null {
  if (!isComparablePhoneType(record.phoneType)) return null;
  return normalizePhone(record.phone);
}

export function compareRecords(a: ComparableRecord, b: ComparableRecord): PairEvidence {
  return {
    nameEvidence: compareName(a.name, b.name),
    domainEvidence: compare(normalizeDomain(a.websiteUrl), normalizeDomain(b.websiteUrl)),
    addressEvidence: compare(normalizeAddress(a.address), normalizeAddress(b.address)),
    phoneEvidence: compare(comparablePhone(a), comparablePhone(b)),
    brandEvidence: compare(brandOf(a), brandOf(b)),
    // RAW. Never bucketed, never thresholded, never turned into agrees/differs.
    coordinateDistanceMetres: haversineMetres(a.latitude, a.longitude, b.latitude, b.longitude),
  };
}
