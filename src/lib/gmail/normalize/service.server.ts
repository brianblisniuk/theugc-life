import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import type { NormalizeDeps } from "@/lib/gmail/normalize/service";

/**
 * B04's REAL application entrypoint — the file server-rendered app code
 * should import. It exists ONLY to attach a real, secret-touching Supabase
 * admin client to the otherwise pure logic in `./service`, which is why it
 * is the one half of this module carrying `server-only`: `defaultNormalize
 * Deps()` is the sole place anything here calls `createAdminClient()`.
 *
 * The operator CLI (`scripts/gmail-normalize/cli.ts`) deliberately does NOT
 * import this file — see `./service`'s own doc comment for why a
 * `server-only`-marked module can never be run from a plain `tsx`/Node CLI
 * process at all, regardless of whether the import is static or dynamic.
 */
export * from "@/lib/gmail/normalize/service";

export function defaultNormalizeDeps(): NormalizeDeps {
  return { db: createAdminClient() };
}
