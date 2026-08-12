"use client";

import { createBrowserClient } from "@supabase/ssr";

import { getClientEnv } from "@/env";

/**
 * Browser Supabase client. Uses only the public URL + anon key. The anon key is
 * intended to be public; all authorization is enforced server-side via RLS.
 * The service-role key is never referenced here.
 */
export function createClient() {
  const env = getClientEnv();
  return createBrowserClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
