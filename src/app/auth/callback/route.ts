import { NextResponse, type NextRequest } from "next/server";

import { getClientEnv } from "@/env";
import { pkceLanding } from "@/lib/auth/pkce-landing";
import { createClient } from "@/lib/supabase/server";

/**
 * Auth callback: exchanges the one-time `code` (email confirmation / password
 * recovery) for a session cookie, then redirects to the `next` path. Only
 * same-origin relative `next` targets are honored (no open redirect). The
 * landing URL does not keep `code`.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const site = getClientEnv().NEXT_PUBLIC_SITE_URL;
  const landing = pkceLanding({
    pathname: url.pathname,
    searchParams: url.searchParams,
    siteOrigin: site,
  });
  const code = url.searchParams.get("code");

  if (landing.kind === "exchange" && code) {
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
      return NextResponse.redirect(new URL(landing.next, site));
    }
  }

  return NextResponse.redirect(new URL("/login?error=auth_callback", site));
}
