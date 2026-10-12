import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getClientEnv } from "@/env";
import { isProtectedPath } from "@/lib/auth/routes";
import { consumeShareLinkRequest, shareLinkClientKey } from "@/lib/profile/share-rate-limit";

/**
 * Refreshes the Supabase auth session (rotating cookies) and redirects
 * unauthenticated users away from protected route groups.
 *
 * Follows the official @supabase/ssr middleware pattern: the same response
 * object must carry the refreshed cookies, so we mutate `supabaseResponse`
 * rather than creating a new one after `getUser()`.
 */
export async function updateSession(request: NextRequest): Promise<NextResponse> {
  const { pathname } = request.nextUrl;
  if (pathname.startsWith("/p/")) {
    const limit = consumeShareLinkRequest(
      shareLinkClientKey(request.headers.get("x-forwarded-for"), request.headers.get("x-real-ip")),
    );
    if (!limit.allowed) {
      return new NextResponse("Too many requests.", {
        status: 429,
        headers: {
          "Cache-Control": "private, no-store",
          "Retry-After": String(limit.retryAfterSeconds),
          "X-Robots-Tag": "noindex, nofollow",
        },
      });
    }
  }

  let supabaseResponse = NextResponse.next({ request });

  const env = getClientEnv();
  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: CookieOptions }[]) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          supabaseResponse = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // IMPORTANT: getUser() revalidates the token with the auth server. Do not put
  // any logic between createServerClient and getUser or sessions may break.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user && isProtectedPath(pathname)) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    // Preserve intended destination so we can return the user after auth
    // (ROUTES.md §7: return users to the intent that triggered the flow).
    redirectUrl.searchParams.set("redirect", pathname);
    return NextResponse.redirect(redirectUrl);
  }

  if (pathname.startsWith("/p/")) {
    supabaseResponse.headers.set("Cache-Control", "private, no-store");
    supabaseResponse.headers.set("X-Robots-Tag", "noindex, nofollow");
    supabaseResponse.headers.set("Referrer-Policy", "no-referrer");
  }

  return supabaseResponse;
}
