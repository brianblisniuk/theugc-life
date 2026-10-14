import "server-only";

import { CREDITS_CONFIG, PLAN_PRICES } from "@/lib/credits/config";

/** Hosted checkout for the theugc-life Rebill organization. */
export const REBILL_PAYMENT_LINK_BASE = "https://pay.rebill.com/theugc-life";

export const REBILL_API_BASE = "https://api.rebill.com/v3";

export const REBILL_PLAN_PRODUCTS = [
  "pro_monthly",
  "pro_annual",
  "max_monthly",
  "max_annual",
] as const;

export const REBILL_PACK_PRODUCTS = ["pack_50", "pack_150", "pack_500"] as const;

export const REBILL_PRODUCT_CODES = [...REBILL_PLAN_PRODUCTS, ...REBILL_PACK_PRODUCTS] as const;

export type RebillProductCode = (typeof REBILL_PRODUCT_CODES)[number];

export type RebillPlanProduct = (typeof REBILL_PLAN_PRODUCTS)[number];

export function isRebillProductCode(value: string): value is RebillProductCode {
  return (REBILL_PRODUCT_CODES as readonly string[]).includes(value);
}

export function isRebillPlanProduct(value: string): value is RebillPlanProduct {
  return (REBILL_PLAN_PRODUCTS as readonly string[]).includes(value);
}

/** Whole USD charged once. Annual is twelve times the per-month annual price. */
export function rebillAmountUsd(product: RebillProductCode): number {
  switch (product) {
    case "pro_monthly":
      return PLAN_PRICES.pro.monthlyUsd;
    case "pro_annual":
      return PLAN_PRICES.pro.annualPerMonthUsd * 12;
    case "max_monthly":
      return PLAN_PRICES.max.monthlyUsd;
    case "max_annual":
      return PLAN_PRICES.max.annualPerMonthUsd * 12;
    case "pack_50":
    case "pack_150":
    case "pack_500": {
      const credits = Number(product.slice("pack_".length));
      const pack = CREDITS_CONFIG.packs.find((row) => row.credits === credits);
      if (!pack) throw new Error("pack price missing");
      return pack.priceUsd;
    }
    default: {
      const unreachable: never = product;
      return unreachable;
    }
  }
}

export function rebillProductTitle(product: RebillProductCode): string {
  switch (product) {
    case "pro_monthly":
      return "Pro monthly";
    case "pro_annual":
      return "Pro annual";
    case "max_monthly":
      return "Max monthly";
    case "max_annual":
      return "Max annual";
    case "pack_50":
      return "50 credits";
    case "pack_150":
      return "150 credits";
    case "pack_500":
      return "500 credits";
    default: {
      const unreachable: never = product;
      return unreachable;
    }
  }
}

export function rebillPlanFrequency(product: RebillPlanProduct): "month" | "year" {
  return product.endsWith("_annual") ? "year" : "month";
}

export type RebillServerEnv = {
  secretKey?: string;
  publicKey?: string;
  signingSecret?: string;
  live: boolean;
};

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Read at call time. Live charges stay off unless REBILL_LIVE is exactly true. */
export function readRebillEnv(): RebillServerEnv {
  return {
    secretKey: present(process.env.REBILL_SECRET_KEY),
    publicKey: present(process.env.REBILL_PUBLIC_KEY),
    signingSecret: present(process.env.REBILL_WEBHOOK_SIGNING_SECRET),
    live: process.env.REBILL_LIVE === "true",
  };
}

/**
 * POST /v3/checkout charges a card. This block never calls it.
 * Hosted payment links are the checkout. A productive organization is refused
 * unless REBILL_LIVE=true.
 */
export function directCardCharge(env: Pick<RebillServerEnv, "live">): {
  allowed: false;
  reason: "live_disabled" | "card_data_refused";
} {
  if (!env.live) return { allowed: false, reason: "live_disabled" };
  return { allowed: false, reason: "card_data_refused" };
}
