/**
 * Pending owner credit numbers (D101).
 *
 * These placeholders are not a pricing decision. The database row
 * `credit_config` is what an unlock debits. This module is the same numbers
 * for the UI and for the test that refuses drift. Change both together, and
 * only when the owner sets them.
 *
 * Pack checkout, plan prices, and a monthly grant job are not in this block.
 */
export const CREDITS_CONFIG = {
  /** Total Free grant, once, not a monthly refill. */
  freeCredits: 15,
  planMonthlyCredits: {
    pro: 50,
    proPlus: 150,
  },
  unlockCost: 1,
  /** A provider miss is stored and is not charged. */
  chargeOnNotFound: false,
  cacheTtlDays: 365,
  packSizes: [10, 25, 50],
} as const;

export type CreditPlanKey = keyof typeof CREDITS_CONFIG.planMonthlyCredits;

export function unlockContactLabel(cost: number = CREDITS_CONFIG.unlockCost): string {
  const unit = cost === 1 ? "credit" : "credits";
  return `Unlock contact (${cost} ${unit})`;
}

export const ALREADY_UNLOCKED_LABEL = "Already unlocked";

/** Shown only when this unlock inserted the pipeline row (D108). */
export const ADDED_TO_PIPELINE_TOAST = "Added to Pipeline";

export function addedToPipelineToast(
  input: {
    status: string;
    pipelineAdded?: boolean;
  } | null,
): string | null {
  if (!input?.pipelineAdded) return null;
  if (input.status !== "unlocked" && input.status !== "already_unlocked") return null;
  return ADDED_TO_PIPELINE_TOAST;
}

export const OUT_OF_CREDITS_COPY =
  "You're out of credits. Packs are not for sale in this pilot. An admin can grant credits.";

export function creditsLeftLabel(balance: number): string {
  const unit = balance === 1 ? "credit" : "credits";
  return `${balance} ${unit} left`;
}

export type UnlockChrome = "already" | "unlock" | "out" | "unknown";

/** A failed balance read is unknown, not zero and not an upgrade. */
export function unlockChrome(input: {
  unlocked: boolean;
  balance: number | null;
  cost: number;
}): UnlockChrome {
  if (input.unlocked) return "already";
  if (input.balance === null || !Number.isInteger(input.balance)) return "unknown";
  if (input.balance < input.cost) return "out";
  return "unlock";
}
