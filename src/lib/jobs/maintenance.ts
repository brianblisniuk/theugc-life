/**
 * Database jobs the schedules call. No Gmail client and no Claude client.
 * A database error is reported as a result code. The message is not returned.
 */
import { readRebillEnv } from "@/lib/billing/rebill-catalog";
import { cancelRebillSubscription } from "@/lib/billing/rebill-checkout";

export interface JobDb {
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

function record(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function cancelReason(result: "cancelled" | "not_configured" | "provider_error"): string {
  return result === "not_configured" ? "not_configured" : "provider_error";
}

/** Retries provider ids that are not cancelled. Does not refund. */
async function retryPendingRebillCancels(db: JobDb): Promise<void> {
  const pending = await db.rpc("read_rebill_pending_cancels", { p_limit: 50 });
  if (pending.error || !Array.isArray(pending.data)) return;
  const env = readRebillEnv();
  for (const row of pending.data) {
    if (!row || typeof row !== "object") continue;
    const subscriptionId = (row as { subscription_id?: unknown }).subscription_id;
    if (typeof subscriptionId !== "string") continue;
    let result: "cancelled" | "not_configured" | "provider_error";
    try {
      result = await cancelRebillSubscription({
        env,
        subscriptionId,
        fetchImpl: fetch,
      });
    } catch {
      result = "provider_error";
    }
    if (result === "cancelled") {
      await db.rpc("rebill_finish_provider_cancel", { p_subscription_id: subscriptionId });
      continue;
    }
    await db.rpc("rebill_queue_provider_cancel", {
      p_subscription_id: subscriptionId,
      p_reason: cancelReason(result),
    });
  }
}

export async function runAccountErasure(db: JobDb): Promise<{ result: string; erased: number }> {
  await retryPendingRebillCancels(db);
  const { data, error } = await db.rpc("erase_due_creator_accounts");
  if (error) return { result: "error", erased: 0 };
  const body = record(data);
  return { result: text(body.result, "error"), erased: count(body.erased) };
}

export async function runAnnualCreditRefresh(
  db: JobDb,
): Promise<{ result: string; users: number }> {
  const { data, error } = await db.rpc("refresh_annual_credit_periods");
  if (error) return { result: "error", users: 0 };
  const body = record(data);
  return { result: text(body.result, "error"), users: count(body.users) };
}

export async function runFollowupHousekeeping(
  db: JobDb,
  now: Date,
): Promise<{ result: string; stopped: number; enqueued: number }> {
  const { data, error } = await db.rpc("gmail_followup_settle", {
    p_now: now.toISOString(),
    p_user_id: null,
  });
  if (error) return { result: "error", stopped: 0, enqueued: 0 };
  const body = record(data);
  return {
    result: text(body.result, "error"),
    stopped: count(body.stopped),
    enqueued: count(body.enqueued),
  };
}
