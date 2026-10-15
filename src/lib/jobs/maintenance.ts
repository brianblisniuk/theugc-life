/**
 * Database jobs the schedules call. No Gmail client and no Claude client.
 * A database error is reported as a result code. The message is not returned.
 */

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

export async function runAccountErasure(db: JobDb): Promise<{ result: string; erased: number }> {
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
