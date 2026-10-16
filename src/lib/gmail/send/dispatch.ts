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
 * Stop claiming before Netlify's 30s scheduled limit. A kill at 30s can
 * still interrupt the one send already in progress. That row stays reserved
 * and is not claimed again. Rows not yet claimed stay queued.
 */
export const DISPATCH_CLAIM_BUDGET_MS = 25_000;

/**
 * Claims due queued sends and delivers each one through the mocked or real
 * Gmail adapter the caller passed. This function does not read process.env
 * for the provider call beyond the deps it is given.
 *
 * Each database claim reserves one row and commits that reservation. The
 * next row is claimed only after this one has been delivered, and only while
 * the budget remains. A claim that repeats an attempt already handled in this
 * run is not sent again.
 */
export async function dispatchDueGmailSends(
  deps: SendDeps,
  options?: {
    now?: Date;
    limit?: number;
    random?: () => number;
    budgetMs?: number;
    clock?: () => number;
  },
): Promise<DispatchSummary> {
  const now = options?.now ?? new Date();
  const caps = planCapsFromEnv(deps.env);
  const spacing = spacingSeconds(options?.random ?? Math.random);
  const clock = options?.clock ?? Date.now;
  const started = clock();
  const budgetMs = options?.budgetMs ?? DISPATCH_CLAIM_BUDGET_MS;
  const maxClaims = options?.limit ?? 10;
  const summary: DispatchSummary = { sent: 0, deferred: 0, failed: 0, paused: 0 };
  const seen = new Set<string>();
  let claimed = 0;

  while (claimed < maxClaims) {
    if (clock() - started >= budgetMs) break;
    const { data, error } = await deps.db.rpc("gmail_send_claim_due", {
      p_now: now.toISOString(),
      p_limit: 1,
      p_spacing_seconds: spacing,
      p_pro_cap: caps.pro,
      p_max_cap: caps.max,
    });
    if (error || !data || typeof data !== "object") break;
    const claims = (data as { claims?: unknown }).claims;
    if (!Array.isArray(claims) || claims.length === 0) break;

    const fresh: Record<string, unknown>[] = [];
    for (const claim of claims) {
      if (!claim || typeof claim !== "object") continue;
      const row = claim as Record<string, unknown>;
      const userId = typeof row.user_id === "string" ? row.user_id : "";
      if (!userId) continue;
      const attemptId = typeof row.attempt_id === "string" ? row.attempt_id : "";
      if (!attemptId || seen.has(attemptId)) continue;
      seen.add(attemptId);
      fresh.push(row);
    }
    if (fresh.length === 0) break;

    for (const row of fresh) {
      if (claimed >= maxClaims) break;
      claimed += 1;
      const userId = typeof row.user_id === "string" ? row.user_id : "";
      const outcome = await deliverReservedSend(row, userId, deps, caps);
      if (outcome.result === "sent") summary.sent += 1;
      else if (outcome.result === "deferred") summary.deferred += 1;
      else if (outcome.result === "paused") summary.paused += 1;
      else summary.failed += 1;
    }
  }
  return summary;
}
