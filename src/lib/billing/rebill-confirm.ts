import "server-only";

import {
  REBILL_API_BASE,
  isRebillPlanProduct,
  type RebillServerEnv,
} from "@/lib/billing/rebill-catalog";

type CheckoutFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type ConfirmedPayment = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  subscriptionId: string | null;
  checkoutId: string | null;
  paymentLinkId: string | null;
};

export type ConfirmedSubscription = {
  id: string;
  status: string;
  statusDetail: string | null;
  planId: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function readWebhookEnvelope(body: unknown): {
  logId: string | null;
  event: string | null;
  paymentId: string | null;
  checkoutId: string | null;
  paymentLinkId: string | null;
  subscriptionId: string | null;
  planUpdated: boolean;
} | null {
  const root = asRecord(body);
  if (!root) return null;
  const webhook = asRecord(root.webhook);
  const data = asRecord(root.data);
  const payment = asRecord(data?.payment) ?? data;
  const paymentMetadata = asRecord(payment?.metadata);
  const dataMetadata = asRecord(data?.metadata);
  return {
    logId: asString(webhook?.logId),
    event: asString(webhook?.event),
    paymentId: asString(asRecord(data?.payment)?.id),
    checkoutId: asString(paymentMetadata?.checkoutId) ?? asString(dataMetadata?.checkoutId),
    paymentLinkId:
      asString(data?.paymentLinkId) ??
      asString(paymentMetadata?.paymentLinkId) ??
      asString(payment?.paymentLinkId),
    subscriptionId:
      asString(data?.subscriptionId) ??
      asString(payment?.subscriptionId) ??
      (asString(data?.id)?.startsWith("sub_") ? asString(data?.id) : null),
    planUpdated: data?.planUpdated === true,
  };
}

export async function confirmRebillPayment(
  env: RebillServerEnv,
  paymentId: string,
  fetchImpl: CheckoutFetch,
): Promise<ConfirmedPayment | null> {
  if (!env.secretKey || !/^pay_[A-Za-z0-9]+$/.test(paymentId)) return null;
  let response: Response;
  try {
    response = await fetchImpl(`${REBILL_API_BASE}/payments/${paymentId}`, {
      method: "GET",
      headers: { "x-api-key": env.secretKey, accept: "application/json" },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: Record<string, unknown>;
  try {
    const parsed = asRecord(await response.json());
    if (!parsed) return null;
    body = parsed;
  } catch {
    return null;
  }
  if (body.id !== paymentId) return null;
  if (typeof body.status !== "string" || typeof body.amount !== "number") return null;
  if (typeof body.currency !== "string") return null;
  const metadata = asRecord(body.metadata);
  return {
    id: paymentId,
    status: body.status,
    amount: body.amount,
    currency: body.currency,
    subscriptionId: asString(body.subscriptionId),
    checkoutId: asString(metadata?.checkoutId),
    paymentLinkId: asString(metadata?.paymentLinkId),
  };
}

export async function confirmRebillSubscription(
  env: RebillServerEnv,
  subscriptionId: string,
  fetchImpl: CheckoutFetch,
): Promise<ConfirmedSubscription | null> {
  if (!env.secretKey || !/^sub_[A-Za-z0-9]+$/.test(subscriptionId)) return null;
  let response: Response;
  try {
    response = await fetchImpl(`${REBILL_API_BASE}/subscriptions/${subscriptionId}`, {
      method: "GET",
      headers: { "x-api-key": env.secretKey, accept: "application/json" },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: Record<string, unknown>;
  try {
    const parsed = asRecord(await response.json());
    if (!parsed) return null;
    body = parsed;
  } catch {
    return null;
  }
  if (body.id !== subscriptionId || typeof body.status !== "string") return null;
  const plan = asRecord(body.plan);
  return {
    id: subscriptionId,
    status: body.status,
    statusDetail: asString(body.statusDetail),
    planId: asString(plan?.id) ?? asString(body.planId),
  };
}

export async function confirmRebillPlanProduct(
  env: RebillServerEnv,
  planId: string,
  fetchImpl: CheckoutFetch,
): Promise<string | null> {
  if (!env.secretKey || !/^pln_[A-Za-z0-9]+$/.test(planId)) return null;
  let response: Response;
  try {
    response = await fetchImpl(`${REBILL_API_BASE}/plans/${planId}`, {
      method: "GET",
      headers: { "x-api-key": env.secretKey, accept: "application/json" },
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: Record<string, unknown>;
  try {
    const parsed = asRecord(await response.json());
    if (!parsed) return null;
    body = parsed;
  } catch {
    return null;
  }
  const metadata = asRecord(body.metadata);
  const code = asString(metadata?.internal_id);
  return code && isRebillPlanProduct(code) ? code : null;
}
