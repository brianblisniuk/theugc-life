import { NextResponse } from "next/server";

import { grantDestinationPass, grantPro } from "@/lib/billing/grant";
import { serverEnv } from "@/lib/env.server";

export const runtime = "nodejs";

interface WebhookBody {
  event?: string;
  user_id?: string;
  product?: "destination_pass" | "pro";
  destination_id?: string;
  source_reference?: string;
}

export async function POST(request: Request) {
  const { BILLING_WEBHOOK_SECRET } = serverEnv();
  const provided = request.headers.get("x-billing-secret");

  if (!BILLING_WEBHOOK_SECRET || provided !== BILLING_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: WebhookBody;
  try {
    body = (await request.json()) as WebhookBody;
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  if (!body.user_id || !body.product || !body.source_reference) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }

  if (body.product === "destination_pass") {
    if (!body.destination_id) {
      return NextResponse.json({ error: "destination_required" }, { status: 400 });
    }
    const result = await grantDestinationPass(body.user_id, body.destination_id, body.source_reference);
    return NextResponse.json(result);
  }

  if (body.product === "pro") {
    const result = await grantPro(body.user_id, body.source_reference);
    return NextResponse.json(result);
  }

  return NextResponse.json({ error: "unknown_product" }, { status: 400 });
}
