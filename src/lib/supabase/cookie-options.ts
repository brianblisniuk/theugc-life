import type { CookieOptions } from "@supabase/ssr";

/**
 * Session cookies are not readable by page scripts.
 * Secure is required even when the local site is http: a cookie that a
 * script can read, or that travels on plain http in production, is not a
 * session cookie.
 */
export const AUTH_COOKIE_OPTIONS: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
};
