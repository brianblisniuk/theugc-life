import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient as createUserScopedClient } from "@/lib/supabase/server";
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

/**
 * EXTERNAL AUDIT AMENDMENT #1, Finding 2: `recordCreatorDecision` is the one
 * B05 write that claims to be unforgeable human truth, so it must run as the
 * REAL signed-in creator, never as the service-role admin identity every
 * other B05 dependency uses. `@/lib/supabase/server`'s cookie-bound client
 * (anon key + the caller's own session) is this repository's existing,
 * documented pattern for exactly that — "Server Actions that act *as the
 * user*" — used here for the first time in B05 because it is the first B05
 * write that needs it.
 */
export async function defaultCreatorDecisionDeps(): Promise<OutreachDeps> {
  return { db: await createUserScopedClient() };
}
