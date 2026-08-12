import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookies } from "next/headers";

import { getClientEnv } from "@/env";

/**
 * Server Supabase client bound to the request's cookies.
 *
 * Uses the anon key + the authenticated user's session cookie, so RLS applies
 * with the caller's identity (`auth.uid()`). This is the correct client for
 * Server Components, Route Handlers, and Server Actions that act *as the user*.
 *
 * For privileged operations that must bypass RLS (webhooks, admin server jobs),
 * use `createAdminClient()` in `admin.ts` instead — never this one.
 */
export async function createClient() {
  const cookieStore = await cookies();
  const env = getClientEnv();

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // `setAll` was called from a Server Component where cookies are
          // read-only. Session refresh is handled by middleware instead, so
          // this is safe to ignore.
        }
      },
    },
  });
}
