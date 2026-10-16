/**
 * Plan chip for the shell. A failed entitlement read is not Free.
 * Max wins over Pro. A Destination Pass is Pass only when it is the
 * highest active row. A price is not read here.
 */
import { isActiveEntitlement, type BillingAccessState } from "@/lib/billing/view";
import type { BillingAccessResult, Entitlement } from "@/lib/billing/queries";

export const PLAN_CHIPS = ["Max", "Pro", "Pass", "Free"] as const;

export type PlanChip = (typeof PLAN_CHIPS)[number];

export function planChipFromAccess(
  result: BillingAccessResult,
  now: Date = new Date(),
): PlanChip | null {
  if (result.status === "error") return null;
  return planChipFromEntitlements(result.entitlements, now);
}

export function planChipFromEntitlements(
  entitlements: readonly Entitlement[],
  now: Date = new Date(),
): PlanChip {
  let pro = false;
  let max = false;
  let pass = false;
  for (const row of entitlements) {
    if (!isActiveEntitlement(row, now)) continue;
    if (row.accessType === "max") max = true;
    if (row.accessType === "pro" || row.accessType === "max") pro = true;
    if (row.accessType === "destination") pass = true;
  }
  if (max) return "Max";
  if (pro) return "Pro";
  if (pass) return "Pass";
  return "Free";
}

/** The billing page's own tri-state must not be relabeled as a chip on error. */
export function planChipFromBillingState(state: BillingAccessState): PlanChip | null {
  if (state.kind === "error") return null;
  if (state.kind === "free") return "Free";
  return planChipFromEntitlements(state.entitlements);
}
