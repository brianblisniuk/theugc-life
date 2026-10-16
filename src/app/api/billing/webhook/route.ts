import "server-only";

import { readRebillEnv } from "@/lib/billing/rebill-catalog";
import { applyResultFromRpc, handleRebillWebhook } from "@/lib/billing/rebill-webhook";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

async function defaultApply(event: Record<string, unknown>): Promise<{ result: string }> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("apply_rebill_event", { p_event: event });
  return applyResultFromRpc(data, error);
}

export async function POST(request: Request) {
  return handleRebillWebhook(request, {
    env: readRebillEnv(),
    fetchImpl: fetch,
    apply: defaultApply,
  });
}
