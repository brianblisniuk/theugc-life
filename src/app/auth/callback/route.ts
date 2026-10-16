import { NextResponse, type NextRequest } from "next/server";

import { getClientEnv } from "@/env";
import { safeSameOriginPath } from "@/lib/auth/safe-redirect";
import { createClient } from "@/lib/supabase/server";

/**
 * Auth callback: exchanges the one-time `code` (email confirmation / password
 * recovery) for a session cookie, then redirects to the `next` path. Only
 * same-origin relative `next` targets are honored (no open redirect).
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const site = getClientEnv().NEXT_PUBLIC_SITE_URL;
  const code = searchParams.get("code");
  const next = safeSameOriginPath(searchParams.get("next") ?? "/app", site) ?? "/app";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (user) {
        try {
          const { syncOnCreatorLoginServer } = await import("@/lib/gmail/sync/on-login.server");
          await syncOnCreatorLoginServer(user.id);
        } catch {
          // A mailbox sync must not block session establishment.
        }
      }
      return NextResponse.redirect(new URL(next, site));
    }
  }

  return NextResponse.redirect(new URL("/login?error=auth_callback", site));
}
