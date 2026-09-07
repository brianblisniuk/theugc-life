import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { ReplyDeps } from "@/lib/gmail/reply/service";

/**
 * B06's REAL application entrypoint — see B04/B05's identical
 * `service.server.ts` for why this split exists. The operator CLI imports
 * `./service` directly.
 */
export * from "@/lib/gmail/reply/service";

export function defaultReplyDeps(): ReplyDeps {
  return { db: createAdminClient() };
}
