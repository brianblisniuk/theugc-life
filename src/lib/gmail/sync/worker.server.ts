import "server-only";

import { getFreshGmailAccessToken } from "@/lib/gmail/connection.server";
import { createAdminClient } from "@/lib/supabase/admin";
import { gmailIncrementalReadAdapter } from "@/lib/gmail/sync/read-adapter.server";
import { syncDeps, type SyncDeps } from "@/lib/gmail/sync/worker";

export function defaultSyncDeps(): SyncDeps {
  return syncDeps({
    db: createAdminClient(),
    gmail: gmailIncrementalReadAdapter,
    accessToken: (input) => getFreshGmailAccessToken(input),
  });
}
