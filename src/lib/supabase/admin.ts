import "server-only";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

import { getClientEnv } from "@/env";
import { serverEnv } from "@/lib/env.server";

/**
 * Service-role Supabase client. BYPASSES Row Level Security.
 *
 * `server-only` ensures this module (and therefore the service-role key) can
 * never be imported into client code. Use ONLY for trusted server operations
 * that legitimately need to bypass RLS:
 *   - payment webhook handlers creating entitlements (PERMISSIONS.md §12)
 *   - controlled admin server jobs / support tooling
 *
 * Never expose its results directly to an unauthorized caller, and never use it
 * to sidestep an authorization check that RLS would otherwise perform for a
 * user-scoped request.
 */
export function createAdminClient() {
  const { NEXT_PUBLIC_SUPABASE_URL } = getClientEnv();
  const { SUPABASE_SERVICE_ROLE_KEY } = serverEnv();

  return createSupabaseClient(NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}
