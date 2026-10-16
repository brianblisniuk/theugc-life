import "server-only";

import { NextResponse } from "next/server";

import {
  confirmRebillPayment,
  confirmRebillPlanProduct,
  confirmRebillSubscription,
  readWebhookEnvelope,
} from "@/lib/billing/rebill-confirm";
import type { RebillServerEnv } from "@/lib/billing/rebill-catalog";
import { rebillSignatureValid } from "@/lib/billing/rebill-signature";

type ApplyResult = { result?: string };

/** An RPC failure is result `error`. The handler answers 503 so Rebill retries. */
export function applyResultFromRpc(
  data: unknown,
  error: { message?: string } | null,
): { result: string } {
  if (error || !data || typeof data !== "object") return { result: "error" };
  const result = (data as { result?: unknown }).result;
  return { result: typeof result === "string" ? result : "error" };
}

export type WebhookDeps = {
  env: RebillServerEnv;
  fetchImpl: typeof fetch;
  apply: (event: Record<string, unknown>) => Promise<ApplyResult>;
};

function json(body: Record<string, unknown>, status: number) {
  return NextResponse.json(body, { status });
}

/**
 * Rebill retries a 503. `applied`, `duplicate`, `ignored`, and `revoked`
 * are finished. `invalid` is a bad payload. An apply error is not finished.
 */
export function rebillWebhookHttpStatus(result: string | undefined): number {
  if (result === "invalid") return 400;
  if (!result || result === "error") return 503;
  return 200;
}

async function appliedResponse(
  apply: WebhookDeps["apply"],
  event: Record<string, unknown>,
): Promise<Response> {
  let applied: ApplyResult;
  try {
    applied = await apply(event);
  } catch {
    return json({ result: "error" }, 503);
  }
  const result = applied.result ?? "error";
  return json({ result }, rebillWebhookHttpStatus(result));
}

/**
 * Verified Rebill webhook. A bad signature does not apply. The account is not
 * taken from the body. Payment status comes from GET /v3/payments/:id.
 */
export async function handleRebillWebhook(request: Request, deps: WebhookDeps): Promise<Response> {
  const raw = new Uint8Array(await request.arrayBuffer());
  const signature = request.headers.get("x-rebill-signature");
  if (!rebillSignatureValid(raw, signature, deps.env.signingSecret)) {
    return json({ error: "unauthorized" }, 401);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw)) as unknown;
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  const envelope = readWebhookEnvelope(parsed);
  if (!envelope?.logId || !envelope.event) {
    return json({ error: "invalid_input" }, 400);
  }

  if (
    envelope.event === "subscription.renewal_soon" ||
    envelope.event === "payment.available" ||
    envelope.event === "payout.updated" ||
    envelope.event === "subscription.created"
  ) {
    return appliedResponse(deps.apply, {
      logId: envelope.logId,
      event: envelope.event,
    });
  }

  if (!deps.env.secretKey) {
    return json({ error: "provider_unconfirmed" }, 503);
  }

  const event: Record<string, unknown> = {
    logId: envelope.logId,
    event: envelope.event,
  };

  if (envelope.event === "payment.created" || envelope.event === "payment.updated") {
    if (!envelope.paymentId) return json({ error: "invalid_input" }, 400);
    const confirmed = await confirmRebillPayment(deps.env, envelope.paymentId, deps.fetchImpl);
    if (!confirmed) return json({ error: "provider_unconfirmed" }, 503);
    if (
      confirmed.checkoutId &&
      envelope.checkoutId &&
      confirmed.checkoutId !== envelope.checkoutId
    ) {
      return json({ error: "checkout_mismatch" }, 400);
    }
    event.payment = {
      id: confirmed.id,
      status: confirmed.status,
      amount: confirmed.amount,
      currency: confirmed.currency,
      checkoutId: confirmed.checkoutId,
      paymentLinkId: confirmed.paymentLinkId,
      subscriptionId: confirmed.subscriptionId,
    };
  }

  if (envelope.event === "subscription.updated") {
    const subscriptionId = envelope.subscriptionId;
    if (!subscriptionId) return json({ error: "invalid_input" }, 400);
    const confirmed = await confirmRebillSubscription(deps.env, subscriptionId, deps.fetchImpl);
    if (!confirmed) return json({ error: "provider_unconfirmed" }, 503);
    let productCode: string | null = null;
    if (envelope.planUpdated && confirmed.planId) {
      productCode = await confirmRebillPlanProduct(deps.env, confirmed.planId, deps.fetchImpl);
    }
    event.subscription = {
      id: confirmed.id,
      status: confirmed.status,
      statusDetail: confirmed.statusDetail,
      planUpdated: envelope.planUpdated,
      productCode,
    };
  }

  return appliedResponse(deps.apply, event);
}
