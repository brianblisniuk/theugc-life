/**
 * Billing & access view state (PERMISSIONS.md §8, §12).
 *
 * Pure module: the page renders whatever this decides, so the rule that matters
 * is asserted here rather than through a DOM renderer.
 *
 * The rule: "You're on the Free plan" is a statement about the creator's
 * account, and it may be made ONLY when the entitlement query succeeded and
 * genuinely returned no active access. A failed read establishes nothing — not
 * Free, not expired, not revoked — and must never be dressed up as a plan or as
 * an upgrade opportunity.
 */
import type { BillingAccessResult, Entitlement } from "./queries";

export const BILLING_COPY = {
  errorTitle: "We couldn’t load your billing & access information.",
  errorBody: "Something went wrong on our side. Reload the page to try again.",
  freeTitle: "You’re on the Free plan",
  // Never "premium hotels" or "richer hotel data": the catalogue is not the
  // premium object (D049). What a plan unlocks is Premium Intelligence and
  // actionable contacts.
  freeBody:
    "Every hotel is already discoverable. A Destination Pass or Creator Pro unlocks Premium Intelligence and verified contacts.",
} as const;

export type BillingAccessState =
  | { kind: "error"; title: string; body: string }
  | { kind: "free"; title: string; body: string }
  | { kind: "premium"; entitlements: readonly Entitlement[] };

function instant(value: string | null): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Active access, defined exactly as the database defines it in
 * `_has_active_pro` / `_has_active_destination_access` (migration 0010):
 * `status = 'active' and starts_at <= now() and (expires_at is null or
 * expires_at > now())`. This display must not disagree with the helper that
 * actually grants premium reads.
 */
export function isActiveEntitlement(entitlement: Entitlement, now: Date = new Date()): boolean {
  if (entitlement.status !== "active") return false;

  const startsAt = instant(entitlement.startsAt);
  if (entitlement.startsAt && startsAt === null) return false;
  if (startsAt !== null && startsAt > now.getTime()) return false;

  if (!entitlement.expiresAt) return true;
  const expiresAt = instant(entitlement.expiresAt);
  if (expiresAt === null) return false;
  return expiresAt > now.getTime();
}

export function billingAccessState(
  result: BillingAccessResult,
  now: Date = new Date(),
): BillingAccessState {
  if (result.status === "error") {
    return { kind: "error", title: BILLING_COPY.errorTitle, body: BILLING_COPY.errorBody };
  }

  const active = result.entitlements.filter((e) => isActiveEntitlement(e, now));
  if (active.length === 0) {
    return { kind: "free", title: BILLING_COPY.freeTitle, body: BILLING_COPY.freeBody };
  }
  return { kind: "premium", entitlements: active };
}

/** The upgrade path is offered for a known Free account, never for a failure. */
export function shouldOfferUpgrade(state: BillingAccessState): boolean {
  return state.kind === "free";
}
