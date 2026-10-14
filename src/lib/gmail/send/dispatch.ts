import "server-only";

import { spacingSeconds, planCapsFromEnv } from "@/lib/gmail/send/guard";
import { deliverReservedSend, type SendDeps } from "@/lib/gmail/send/service.server";

export interface DispatchSummary {
  sent: number;
  deferred: number;
  failed: number;
  paused: number;
}

/**
 * Claims due queued sends and delivers each one through the mocked or real
 * Gmail adapter the caller passed. This function does not read process.env
 * for the provider call beyond the deps it is given.
 */
export async function dispatchDueGmailSends(
  deps: SendDeps,
  options?: { now?: Date; limit?: number; random?: () => number },
): Promise<DispatchSummary> {
  const now = options?.now ?? new Date();
  const caps = planCapsFromEnv(deps.env);
  const spacing = spacingSeconds(options?.random ?? Math.random);
  const { data, error } = await deps.db.rpc("gmail_send_claim_due", {
    p_now: now.toISOString(),
    p_limit: options?.limit ?? 10,
    p_spacing_seconds: spacing,
    p_pro_cap: caps.pro,
    p_max_cap: caps.max,
  });
  if (error || !data || typeof data !== "object") {
    return { sent: 0, deferred: 0, failed: 0, paused: 0 };
  }
  const claims = (data as { claims?: unknown }).claims;
  const summary: DispatchSummary = { sent: 0, deferred: 0, failed: 0, paused: 0 };
  if (!Array.isArray(claims)) return summary;

  for (const claim of claims) {
    if (!claim || typeof claim !== "object") continue;
    const row = claim as Record<string, unknown>;
    const userId = typeof row.user_id === "string" ? row.user_id : "";
    if (!userId) continue;
    const outcome = await deliverReservedSend(row, userId, deps, caps);
    if (outcome.result === "sent") summary.sent += 1;
    else if (outcome.result === "deferred") summary.deferred += 1;
    else if (outcome.result === "paused") summary.paused += 1;
    else summary.failed += 1;
  }
  return summary;
}
