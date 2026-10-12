import type { SyncDeps } from "@/lib/gmail/sync/worker";
import { runAccountSync } from "@/lib/gmail/sync/worker";

/**
 * Creator login is a sync trigger. It marks this user's connected mailboxes
 * due and discharges them. A Gmail failure must not fail the login; callers
 * catch.
 */
export async function syncOnCreatorLogin(userId: string, deps: SyncDeps): Promise<void> {
  const { data, error } = await deps.db.rpc("gmail_incremental_sync_request_login", {
    p_user_id: userId,
  });
  if (error) throw new Error(error.message);
  const body = (data ?? {}) as { result?: string; mail_account_ids?: string[] };
  if (body.result !== "ok") return;
  for (const mailAccountId of body.mail_account_ids ?? []) {
    await runAccountSync({ userId, mailAccountId }, deps);
  }
}
