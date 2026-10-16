/**
 * Plan comparison from the live config (D131).
 *
 * Prices and credit amounts are read from config. This module does not start
 * a checkout and does not grant access.
 */
import { FREE_LIMITS, PRICING } from "@/lib/config";
import { CREDITS_CONFIG, PLAN_PRICES } from "@/lib/credits/config";

export interface PlanCard {
  id: "free" | "pro" | "max";
  name: string;
  credits: number;
  creditNote: string;
  priceNote: string;
  points: readonly string[];
  checkoutHref: string;
}

export interface CreditAction {
  action: string;
  credits: string;
  result: string;
}

export interface PackOffer {
  credits: number;
  priceUsd: number;
  href: string;
}

export function planCards(): readonly PlanCard[] {
  return [
    {
      id: "free",
      name: "Free",
      credits: CREDITS_CONFIG.freeWeeklyCredits,
      creditNote: `Every ${CREDITS_CONFIG.freeWeeklyPeriodDays} days. Unused weekly credits do not stack past ${CREDITS_CONFIG.freeWeeklyCredits}.`,
      priceNote: "$0",
      points: [
        `Save up to ${FREE_LIMITS.savedHotels} hotels`,
        `${FREE_LIMITS.activePipelineItems} active pipeline items`,
        `${FREE_LIMITS.activeTrips} active trip`,
        "Manual email templates. No full AI email generation.",
        "Public intelligence and a basic portfolio",
      ],
      checkoutHref: "/app/billing",
    },
    {
      id: "pro",
      name: "Pro",
      credits: CREDITS_CONFIG.planMonthlyCredits.pro,
      creditNote: "Credits each paid month",
      priceNote: `$${PLAN_PRICES.pro.annualPerMonthUsd}/mo billed annually, or $${PLAN_PRICES.pro.monthlyUsd}/mo`,
      points: [
        "Full AI email generation",
        "Outreach Assisted (Gmail detection and drafts)",
        "Premium Intelligence worldwide",
        "Unlimited CRM",
        "Credit packs",
      ],
      checkoutHref: "/app/billing#checkout-pro_monthly",
    },
    {
      id: "max",
      name: "Max",
      credits: CREDITS_CONFIG.planMonthlyCredits.max,
      creditNote: "Credits each paid month",
      priceNote: `$${PLAN_PRICES.max.annualPerMonthUsd}/mo billed annually, or $${PLAN_PRICES.max.monthlyUsd}/mo`,
      points: [
        "Everything in Pro",
        "Priority AI on the same model, with a fuller draft",
        "Advanced signals and priority support",
        "A hotel response is not guaranteed",
      ],
      checkoutHref: "/app/billing#checkout-max_monthly",
    },
  ];
}

export function creditActions(): readonly CreditAction[] {
  return [
    {
      action: "Unlock a hotel's available contacts",
      credits: `${CREDITS_CONFIG.unlockCost}, on success`,
      result: "The contacts this lookup actually returned",
    },
    {
      action: "Unsuccessful hotel lookup",
      credits: CREDITS_CONFIG.chargeOnNotFound ? String(CREDITS_CONFIG.unlockCost) : "0",
      result: "No charge, and no invented contact",
    },
    {
      action: "Reopen an unlocked hotel",
      credits: "0",
      result: "The same unlock stays available",
    },
    {
      action: "Successful AI pitch draft",
      credits: `${CREDITS_CONFIG.aiDraftCost} where the plan allows it`,
      result: "A draft. It is not sent.",
    },
  ];
}

export function packOffers(): readonly PackOffer[] {
  return CREDITS_CONFIG.packs.map((pack) => ({
    credits: pack.credits,
    priceUsd: pack.priceUsd,
    href: `/app/billing#checkout-pack_${pack.credits}`,
  }));
}

export function destinationPassNote(): string {
  return `Creator Destination Pass remains $${PRICING.destinationPass.priceUsd} for ${PRICING.destinationPass.durationDays} days in one destination.`;
}
