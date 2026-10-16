/**
 * Contact provider boundary (D100, D180, D181).
 *
 * `found` and `not_found` are cacheable provider outcomes. `error` and
 * `unavailable` are not: they must not be stored as a missing contact, and
 * they must not debit a credit.
 *
 * D181 tier 1 is the best fallback. A found Hunter address carries that tier
 * on the result and on the stored provider note.
 */

export type ContactSelectionTier = 1 | 2 | 3 | 4;

export interface ContactLookup {
  hotelId: string;
  name: string;
  domain: string | null;
  /**
   * Named person. The hotel unlock action does not set these. Email Finder
   * runs only when a person is present and the hotel has no website domain.
   */
  firstName?: string | null;
  lastName?: string | null;
}

export interface ContactProviderRaw {
  provider: "fake" | "hunter";
  status: "found" | "not_found";
  operation?: "domain_search" | "email_finder" | "none" | "cache";
  domain?: string | null;
  confidence?: number | null;
  department?: string | null;
  position?: string | null;
  verification?: string | null;
  decisionMaker?: boolean | null;
  /** D181 fallback tier. Null when no tier was chosen. */
  tier?: ContactSelectionTier | null;
}

export type ContactLookupResult =
  | { status: "found"; email: string; tier?: ContactSelectionTier | null; raw: ContactProviderRaw }
  | { status: "not_found"; email: null; raw: ContactProviderRaw }
  | { status: "error"; email: null }
  | { status: "unavailable"; email: null };

export interface ContactProvider {
  findHotelEmail(input: ContactLookup): Promise<ContactLookupResult>;
}

export type UnlockFollowUp =
  | { kind: "stop"; status: "error" | "unavailable" }
  | {
      kind: "cache";
      email: string | null;
      status: "found" | "not_found";
      raw: ContactProviderRaw;
    };

/** A provider failure is not written to the contact cache. */
export function unlockFollowUp(result: ContactLookupResult): UnlockFollowUp {
  if (result.status === "error" || result.status === "unavailable") {
    return { kind: "stop", status: result.status };
  }
  if (result.status === "found") {
    if (result.email.trim().length === 0) return { kind: "stop", status: "error" };
    return { kind: "cache", email: result.email, status: "found", raw: result.raw };
  }
  return { kind: "cache", email: null, status: "not_found", raw: result.raw };
}
