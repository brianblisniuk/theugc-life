import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { OutreachDeps } from "@/lib/gmail/outreach/service";

/**
 * B05's REAL application entrypoint. Exists only to attach a real Supabase
 * admin client to the pure logic in `./service` — see B04's identical
 * `service.server.ts` for why this split exists (the `server-only`
 * package's `react-server` export condition cannot be satisfied by a plain
 * `tsx`/Node CLI process). The operator CLI imports `./service` directly.
 */
export * from "@/lib/gmail/outreach/service";

export function defaultOutreachDeps(): OutreachDeps {
  return { db: createAdminClient() };
}
