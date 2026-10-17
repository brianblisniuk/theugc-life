import "server-only";

import {
  REBILL_API_BASE,
  REBILL_PAYMENT_LINK_BASE,
  directCardCharge,
  isRebillPlanProduct,
  rebillPlanFrequency,
  rebillProductTitle,
  type RebillProductCode,
  type RebillServerEnv,
} from "@/lib/billing/rebill-catalog";
import { confirmRebillSubscription } from "@/lib/billing/rebill-confirm";

export type CheckoutFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type HostedCheckoutResult =
  | { result: "ready"; url: string; linkId: string }
  | { result: "not_configured" | "live_disabled" | "provider_error" | "rejected_url" };

type OrgBody = { environment?: unknown };

function apiHeaders(secretKey: string): HeadersInit {
  return {
    "x-api-key": secretKey,
    accept: "application/json",
    "content-type": "application/json",
  };
}

export async function readRebillOrganization(
  env: RebillServerEnv,
  fetchImpl: CheckoutFetch,
): Promise<"sandbox" | "productive" | null> {
  if (!env.secretKey) return null;
  let response: Response;
  try {
    response = await fetchImpl(`${REBILL_API_BASE}/organizations/me`, {
      method: "GET",
      headers: apiHeaders(env.secretKey),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: OrgBody;
  try {
    body = (await response.json()) as OrgBody;
  } catch {
    return null;
  }
  if (body.environment === "sandbox" || body.environment === "productive") return body.environment;
  return null;
}

/** Sandbox may open a hosted link. A productive org may not, unless live is on. */
export function hostedCheckoutAllowed(
  environment: "sandbox" | "productive" | null,
  env: RebillServerEnv,
): HostedCheckoutResult | { result: "allowed" } {
  if (!env.secretKey) return { result: "not_configured" };
  if (environment === "sandbox") return { result: "allowed" };
  if (environment === "productive" && env.live) return { result: "allowed" };
  return { result: "live_disabled" };
}

export async function ensureRebillPlan(input: {
  env: RebillServerEnv;
  product: RebillProductCode;
  amountUsd: number;
  existingPlanId: string | null;
  fetchImpl: CheckoutFetch;
}): Promise<string | null> {
  if (!isRebillPlanProduct(input.product)) return null;
  if (input.existingPlanId && /^pln_[A-Za-z0-9]+$/.test(input.existingPlanId)) {
    return input.existingPlanId;
  }
  if (!input.env.secretKey) return null;
  const frequency = rebillPlanFrequency(input.product);
  let response: Response;
  try {
    response = await input.fetchImpl(`${REBILL_API_BASE}/plans`, {
      method: "POST",
      headers: apiHeaders(input.env.secretKey),
      body: JSON.stringify({
        name: [{ language: "en", text: rebillProductTitle(input.product) }],
        frequency: { period: frequency, count: 1 },
        prices: [{ amount: input.amountUsd, currency: "USD", isDefault: true }],
        metadata: { internal_id: input.product },
      }),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: { id?: unknown };
  try {
    body = (await response.json()) as { id?: unknown };
  } catch {
    return null;
  }
  return typeof body.id === "string" && /^pln_[A-Za-z0-9]+$/.test(body.id) ? body.id : null;
}

/**
 * Creates a hosted payment link. The body carries the checkout id only.
 * It does not carry an account id. It does not call POST /v3/checkout.
 */
export async function createHostedPaymentLink(input: {
  env: RebillServerEnv;
  product: RebillProductCode;
  checkoutId: string;
  amountUsd: number;
  planId: string | null;
  siteUrl: string;
  fetchImpl: CheckoutFetch;
}): Promise<HostedCheckoutResult> {
  const charge = directCardCharge(input.env);
  if (charge.reason === "live_disabled" && !input.env.secretKey) {
    return { result: "not_configured" };
  }
  if (!input.env.secretKey) return { result: "not_configured" };

  const approved = `${input.siteUrl.replace(/\/$/, "")}/app/billing?checkout=returned`;
  const metadata = { checkoutId: input.checkoutId };
  const title = [{ language: "en", text: rebillProductTitle(input.product) }];
  const paymentMethods = [{ methods: ["card"], currency: "USD" }];
  const body = isRebillPlanProduct(input.product)
    ? {
        title,
        paymentMethods,
        plan: { id: input.planId },
        metadata,
        showCoupon: false,
        isSingleUse: true,
        redirectUrls: { approved, rejected: approved, pending: approved },
      }
    : {
        title,
        paymentMethods,
        prices: [
          {
            amount: input.amountUsd,
            currency: "USD",
            isPriceFixed: true,
            isDefault: true,
          },
        ],
        metadata,
        showCoupon: false,
        isSingleUse: true,
        redirectUrls: { approved, rejected: approved, pending: approved },
      };

  if (isRebillPlanProduct(input.product) && !input.planId) return { result: "provider_error" };

  let response: Response;
  try {
    response = await input.fetchImpl(`${REBILL_API_BASE}/payment-links`, {
      method: "POST",
      headers: apiHeaders(input.env.secretKey),
      body: JSON.stringify(body),
    });
  } catch {
    return { result: "provider_error" };
  }
  if (!response.ok) return { result: "provider_error" };

  let payload: { id?: unknown; url?: unknown };
  try {
    payload = (await response.json()) as { id?: unknown; url?: unknown };
  } catch {
    return { result: "provider_error" };
  }
  if (typeof payload.id !== "string" || typeof payload.url !== "string") {
    return { result: "provider_error" };
  }
  if (!payload.url.startsWith(`${REBILL_PAYMENT_LINK_BASE}/`)) {
    return { result: "rejected_url" };
  }
  if (!payload.url.includes(payload.id)) return { result: "rejected_url" };
  return { result: "ready", url: payload.url, linkId: payload.id };
}

const SUBSCRIPTION_ID = /^sub_[A-Za-z0-9]+$/;

/**
 * Cancels one Rebill subscription.
 * PATCH /v3/subscriptions/:id with `{ "status": "cancelled" }`.
 * Docs: https://docs.rebill.com/api/reference/subscriptions (retrieved 2026-10-17).
 * `cancelled` is terminal: no further charges. Active, paused, and retrying may
 * move there. A 400 on an already-cancelled subscription is success after GET.
 * This does not refund a captured payment.
 */
export async function cancelRebillSubscription(input: {
  env: RebillServerEnv;
  subscriptionId: string;
  fetchImpl: CheckoutFetch;
}): Promise<"cancelled" | "not_configured" | "provider_error"> {
  if (!input.env.secretKey) return "not_configured";
  if (!SUBSCRIPTION_ID.test(input.subscriptionId)) return "provider_error";

  let response: Response;
  try {
    response = await input.fetchImpl(`${REBILL_API_BASE}/subscriptions/${input.subscriptionId}`, {
      method: "PATCH",
      headers: apiHeaders(input.env.secretKey),
      body: JSON.stringify({ status: "cancelled" }),
    });
  } catch {
    return "provider_error";
  }

  if (response.ok) {
    try {
      const body = (await response.json()) as { id?: unknown; status?: unknown };
      if (body.id === input.subscriptionId && body.status === "cancelled") return "cancelled";
    } catch {
      return "provider_error";
    }
    return "provider_error";
  }

  if (response.status === 400) {
    const confirmed = await confirmRebillSubscription(
      input.env,
      input.subscriptionId,
      input.fetchImpl,
    );
    if (confirmed?.status === "cancelled") return "cancelled";
  }
  return "provider_error";
}

/** Cancels each id. One failure does not stop the others and does not refund. */
export async function cancelRebillSubscriptions(input: {
  env: RebillServerEnv;
  subscriptionIds: readonly string[];
  fetchImpl: CheckoutFetch;
}): Promise<Array<"cancelled" | "not_configured" | "provider_error">> {
  const results: Array<"cancelled" | "not_configured" | "provider_error"> = [];
  for (const subscriptionId of input.subscriptionIds) {
    try {
      results.push(
        await cancelRebillSubscription({
          env: input.env,
          subscriptionId,
          fetchImpl: input.fetchImpl,
        }),
      );
    } catch {
      results.push("provider_error");
    }
  }
  return results;
}
