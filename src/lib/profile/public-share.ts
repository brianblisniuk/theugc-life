/**
 * Public read of one hotel share link.
 *
 * Uses the anon key and does not attach a session. The database function is
 * the authorization boundary. A transport failure is not a 404.
 */
import "server-only";

import { createClient } from "@supabase/supabase-js";

import { getClientEnv } from "@/env";

import { mapPublicShare, type PublicShareLoad } from "./share-contract";

const TOKEN = /^[0-9a-f]{64}$/;

export async function readPublicCreatorShare(token: string): Promise<PublicShareLoad> {
  if (!TOKEN.test(token)) return { status: "not_found" };
  try {
    const env = getClientEnv();
    const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await supabase.rpc("read_creator_share_profile", { p_token: token });
    if (error) return { status: "error" };
    return mapPublicShare(data);
  } catch {
    return { status: "error" };
  }
}
