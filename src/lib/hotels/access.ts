/**
 * Premium contact access + section state (PERMISSIONS.md §7).
 *
 * Product integrity rule: a TECHNICAL ERROR IS NOT A DOMAIN FACT.
 *
 * A failed entitlement check is not "you do not have access". Telling a paying
 * creator to upgrade because an RPC blipped is a false statement about their
 * account. So the access check has three outcomes, not two:
 *
 *   allowed → the contact query may run
 *   denied  → locked/upgrade state
 *   error   → neutral, recoverable error state; NO upgrade CTA, and premium
 *             fields are still never queried (security stays fail-closed)
 *
 * The mapping is pure so it can be exhaustively unit-tested without Supabase.
 */
export type ContactAccessResult =
  { status: "allowed" } | { status: "denied" } | { status: "error" };

/** Shape of a supabase-js single-value response, narrowed to what we use. */
export interface RpcOutcome {
  data: unknown;
  error: unknown;
}

/**
 * Map an entitlement RPC outcome to an access result.
 *
 * Only an explicit boolean answer is treated as a domain fact. An error — or a
 * non-boolean/absent value we cannot interpret — is an `error`, never a denial.
 */
export function mapContactAccess(outcome: RpcOutcome): ContactAccessResult {
  if (outcome.error) return { status: "error" };
  if (outcome.data === true) return { status: "allowed" };
  if (outcome.data === false) return { status: "denied" };
  // Unknown/absent answer: we did not learn that access is denied.
  return { status: "error" };
}

/** True only when premium contact fields may be fetched. */
export function mayQueryContacts(access: ContactAccessResult): boolean {
  return access.status === "allowed";
}

/** Which contact UI state the hotel page must render. */
export type ContactSectionState =
  /** Authorized and we have contacts to show. */
  | "contacts"
  /** Authorized, but this hotel genuinely has none published. */
  | "empty"
  /** Not entitled — locked state + upgrade CTA. */
  | "locked"
  /** The entitlement check itself failed — neutral retry, NO upgrade CTA. */
  | "access-error"
  /** Entitled, but loading the contacts failed — neutral retry. */
  | "fetch-error";

export function contactSectionState(input: {
  access: ContactAccessResult;
  /** Only the count matters here; the values stay in the server layer. */
  contacts: readonly unknown[];
  failed: boolean;
}): ContactSectionState {
  if (input.access.status === "error") return "access-error";
  if (input.access.status === "denied") return "locked";
  if (input.failed) return "fetch-error";
  return input.contacts.length > 0 ? "contacts" : "empty";
}

/** True when the UI is permitted to show the upgrade call to action. */
export function shouldOfferUpgrade(state: ContactSectionState): boolean {
  return state === "locked";
}
