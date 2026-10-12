/**
 * STUB — NOT THE REBILL INTEGRATION.
 *
 * Shared-secret billing webhook used only to exercise the idempotent
 * entitlement-grant path (PR #43). It performs NO payment verification and
 * trusts the body's user/product fields. Therefore:
 *
 *   BILLING_WEBHOOK_SECRET MUST NEVER BE SET IN PRODUCTION until Rebill
 *   signature verification (and a payment record) replaces this stub.
 *
 * With the secret unset, every request is rejected with 401.
 * Payments and entitlements stay separate (D007); see docs/PAYMENT_PROVIDER.md.
 */
import { NextResponse } from "next/server";

import { grantDestinationPass, grantPro, type GrantResult } from "@/lib/billing/grant";
import { isAllowedEvent, secretMatches } from "@/lib/billing/webhook-auth";
import { bindServerActions } from "@/lib/entitlements/inventory";
import { serverEnv } from "@/lib/env.server";

bindServerActions(["commerce.grant"]);

export const runtime = "nodejs";

interface WebhookBody {
  event?: unknown;
  user_id?: unknown;
  product?: unknown;
  destination_id?: unknown;
  source_reference?: unknown;
}

function respond(result: GrantResult) {
  const status =
    result.result === "granted" || result.result === "already_granted"
      ? 200
      : result.result === "source_reference_conflict"
        ? 409
        : result.result === "invalid_input"
          ? 400
          : 500;
  return NextResponse.json(result, { status });
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);

export async function POST(request: Request) {
  const { BILLING_WEBHOOK_SECRET } = serverEnv();
  if (!secretMatches(request.headers.get("x-billing-secret"), BILLING_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: WebhookBody;
  try {
    body = (await request.json()) as WebhookBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  if (!isAllowedEvent(body.event)) {
    return NextResponse.json({ error: "unsupported_event" }, { status: 400 });
  }

  const userId = str(body.user_id);
  const sourceReference = str(body.source_reference);
  if (!userId || !sourceReference) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  if (body.product === "destination_pass") {
    const destinationId = str(body.destination_id);
    if (!destinationId) {
      return NextResponse.json({ error: "destination_required" }, { status: 400 });
    }
    return respond(await grantDestinationPass(userId, destinationId, sourceReference));
  }

  if (body.product === "pro") {
    return respond(await grantPro(userId, sourceReference));
  }

  return NextResponse.json({ error: "unknown_product" }, { status: 400 });
}
