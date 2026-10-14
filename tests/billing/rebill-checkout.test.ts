/**
 * Hosted Rebill checkout. POST /v3/checkout is never called. A productive
 * organization is refused unless REBILL_LIVE is exactly true. The link body
 * carries the checkout id and not an account id.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  directCardCharge,
  readRebillEnv,
  rebillAmountUsd,
  REBILL_API_BASE,
  REBILL_PAYMENT_LINK_BASE,
} from "@/lib/billing/rebill-catalog";
import {
  createHostedPaymentLink,
  ensureRebillPlan,
  hostedCheckoutAllowed,
} from "@/lib/billing/rebill-checkout";
import { rebillPublicKey } from "@/lib/billing/rebill-public";
import { PLAN_PRICES } from "@/lib/credits/config";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const env = {
  secretKey: "sk_test_secret",
  publicKey: "pk_test_public",
  signingSecret: "whsec_test",
  live: false,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("rebill checkout gate", () => {
  it("never allows a direct card charge, including when live is on", () => {
    expect(directCardCharge({ live: false })).toEqual({ allowed: false, reason: "live_disabled" });
    expect(directCardCharge({ live: true })).toEqual({
      allowed: false,
      reason: "card_data_refused",
    });
  });

  it("allows sandbox without live, and a productive org only when live is on", () => {
    expect(hostedCheckoutAllowed("sandbox", env).result).toBe("allowed");
    expect(hostedCheckoutAllowed("productive", env).result).toBe("live_disabled");
    expect(hostedCheckoutAllowed("productive", { ...env, live: true }).result).toBe("allowed");
    expect(hostedCheckoutAllowed(null, env).result).toBe("live_disabled");
    expect(hostedCheckoutAllowed("sandbox", { ...env, secretKey: undefined }).result).toBe(
      "not_configured",
    );
  });

  it("reads live only from the exact string true", () => {
    vi.stubEnv("REBILL_LIVE", "TRUE");
    vi.stubEnv("REBILL_SECRET_KEY", " sk_test ");
    expect(readRebillEnv().live).toBe(false);
    expect(readRebillEnv().secretKey).toBe("sk_test");
    vi.stubEnv("REBILL_LIVE", "true");
    expect(readRebillEnv().live).toBe(true);
  });

  it("prices annual as twelve months and packs from config", () => {
    expect(rebillAmountUsd("pro_monthly")).toBe(PLAN_PRICES.pro.monthlyUsd);
    expect(rebillAmountUsd("pro_annual")).toBe(PLAN_PRICES.pro.annualPerMonthUsd * 12);
    expect(rebillAmountUsd("max_monthly")).toBe(PLAN_PRICES.max.monthlyUsd);
    expect(rebillAmountUsd("max_annual")).toBe(PLAN_PRICES.max.annualPerMonthUsd * 12);
    expect(rebillAmountUsd("pack_50")).toBe(10);
    expect(rebillAmountUsd("pack_150")).toBe(20);
    expect(rebillAmountUsd("pack_500")).toBe(40);
  });
});

describe("hosted payment link", () => {
  it("posts a plan link without a user id and never calls card checkout", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: String(init?.body ?? "") });
      return Response.json({
        id: "pl_abc123",
        url: `${REBILL_PAYMENT_LINK_BASE}/pl_abc123`,
      });
    });
    const ready = await createHostedPaymentLink({
      env,
      product: "pro_monthly",
      checkoutId: "11111111-1111-4111-8111-111111111111",
      amountUsd: 30,
      planId: "pln_pro",
      siteUrl: "https://theugc.life",
      fetchImpl,
    });
    expect(ready).toEqual({
      result: "ready",
      url: `${REBILL_PAYMENT_LINK_BASE}/pl_abc123`,
      linkId: "pl_abc123",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${REBILL_API_BASE}/payment-links`);
    expect(calls[0]!.url).not.toContain("/checkout");
    const body = JSON.parse(calls[0]!.body) as {
      plan: { id: string };
      metadata: Record<string, unknown>;
      prices?: unknown;
    };
    expect(body.plan.id).toBe("pln_pro");
    expect(body.metadata).toEqual({ checkoutId: "11111111-1111-4111-8111-111111111111" });
    expect(body.prices).toBeUndefined();
    expect(JSON.stringify(body)).not.toMatch(/user_id|userId/);
  });

  it("rejects a link that is not the theugc-life payment host", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({ id: "pl_abc123", url: "https://pay.rebill.com/other/pl_abc123" }),
    );
    const rejected = await createHostedPaymentLink({
      env,
      product: "pack_50",
      checkoutId: "11111111-1111-4111-8111-111111111111",
      amountUsd: 10,
      planId: null,
      siteUrl: "https://theugc.life",
      fetchImpl,
    });
    expect(rejected.result).toBe("rejected_url");
  });

  it("creates a plan without a trial", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.trialPeriodDays).toBeUndefined();
      expect(body.metadata).toEqual({ internal_id: "max_annual" });
      expect(body.frequency).toEqual({ period: "year", count: 1 });
      return Response.json({ id: "pln_maxyear" });
    });
    const id = await ensureRebillPlan({
      env,
      product: "max_annual",
      amountUsd: 600,
      existingPlanId: null,
      fetchImpl,
    });
    expect(id).toBe("pln_maxyear");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("public key module", () => {
  it("reads only the public key", () => {
    const source = readFileSync(path.join(ROOT, "src/lib/billing/rebill-public.ts"), "utf8");
    expect(source).not.toMatch(/REBILL_SECRET_KEY|REBILL_WEBHOOK_SIGNING_SECRET/);
    vi.stubEnv("REBILL_PUBLIC_KEY", " pk_live_x ");
    expect(rebillPublicKey()).toBe("pk_live_x");
  });
});
