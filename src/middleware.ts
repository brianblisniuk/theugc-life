import { type NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/middleware";

/**
 * Root middleware: refreshes the Supabase session on every matched request and
 * gates the `/app` and `/admin` route groups behind authentication. Role-based
 * authorization for `/admin` is enforced additionally in the admin layout
 * (server-side, defense in depth).
 */
export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  /**
   * Run on all paths except Next.js internals and static assets. This keeps the
   * auth-session cookie fresh across the app while avoiding needless work on
   * asset requests.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"],
};
