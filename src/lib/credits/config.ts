/**
 * Creator plan amounts (D131, D132).
 *
 * `credit_config` is what a grant and an unlock read. This module is the same
 * numbers for the UI and for the test that refuses drift. Change both together.
 *
 * `legacyFreeGrant` is the one-time amount already written as `free_grant:v1`.
 * New accounts do not receive it. Prices are config. This module does not
 * charge a card, and a price is not an entitlement (D007, D134).
 */
export const CREDITS_CONFIG = {
  /** Historical one-time Free grant. Not issued after D132. */
  legacyFreeGrant: 15,
  /** Free allowance per rolling week. Unused weekly credits do not stack past this. */
  freeWeeklyCredits: 5,
  freeWeeklyPeriodDays: 7,
  planMonthlyCredits: {
    pro: 150,
    max: 500,
  },
  unlockCost: 1,
  /** One successful AI pitch draft (D143). The ledger row is reason ai_draft. */
  aiDraftCost: 1,
  /** A provider miss is stored and is not charged. */
  chargeOnNotFound: false,
  cacheTtlDays: 365,
  packs: [
    { credits: 50, priceUsd: 10 },
    { credits: 150, priceUsd: 20 },
    { credits: 500, priceUsd: 40 },
  ],
} as const;

/** Live creator subscription prices (D131). Not the historical D052 annual figure. */
export const PLAN_PRICES = {
  pro: { annualPerMonthUsd: 20, monthlyUsd: 30 },
  max: { annualPerMonthUsd: 50, monthlyUsd: 60 },
} as const;

export type PaidPlanTier = keyof typeof PLAN_PRICES;

export const PLAN_TIERS = ["free", "pro", "max"] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

/** Flags only an active Max entitlement turns on. They do not change Discover or Pipeline order, and they do not send mail. */
export const MAX_PLAN_FLAGS = [
  "priority_ai",
  "advanced_signals",
  "priority_support",
  "future_premium",
] as const;

export type MaxPlanFlag = (typeof MAX_PLAN_FLAGS)[number];

export function unlockContactLabel(cost: number = CREDITS_CONFIG.unlockCost): string {
  const unit = cost === 1 ? "credit" : "credits";
  return `Unlock contact · ${cost} ${unit}`;
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
  "You're out of credits. Pack purchases are not open yet. An admin can grant credits.";

/** Hunter budget, kill switch, or an in-flight lookup. Not a missing contact. */
export const CONTACT_LOOKUP_UNAVAILABLE = "Contact lookup temporarily unavailable";

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
