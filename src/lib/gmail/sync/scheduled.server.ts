import "server-only";

import { getFreshGmailAccessToken } from "@/lib/gmail/connection.server";
import { gmailIncrementalReadAdapter } from "@/lib/gmail/sync/read-adapter.server";
import { runDueSyncs, syncDeps } from "@/lib/gmail/sync/worker";
import { createAdminClient } from "@/lib/supabase/admin";

/** Same batch the operator command uses when `--limit` is omitted. */
export const INBOX_SYNC_BATCH = 10;

/**
 * Discharges mailboxes the database already marked due. Gmail is reached
 * only through the adapter the worker is given. Tests pass their own deps.
 */
export async function runProductionInboxSync(): Promise<{
  accounts: number;
  results: string[];
}> {
  const db = createAdminClient();
  const outcome = await runDueSyncs(
    syncDeps({
      db,
      gmail: gmailIncrementalReadAdapter,
      accessToken: (input) => getFreshGmailAccessToken(input),
    }),
    INBOX_SYNC_BATCH,
  );
  return {
    accounts: outcome.accounts,
    results: outcome.outcomes.map((item) => item.result),
  };
}
