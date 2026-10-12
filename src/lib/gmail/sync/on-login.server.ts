import "server-only";

import { syncOnCreatorLogin } from "@/lib/gmail/sync/on-login";
import { defaultSyncDeps } from "@/lib/gmail/sync/worker.server";

export async function syncOnCreatorLoginServer(userId: string): Promise<void> {
  await syncOnCreatorLogin(userId, defaultSyncDeps());
}
