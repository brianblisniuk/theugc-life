/**
 * Response headers for every HTML and API response (E05, D093 Proposed).
 *
 * The Maps JavaScript API is allowed to load. Nothing else is framed.
 * Referrer-Policy is no-referrer, including on /p/[token], so a share token
 * is not sent as a referrer.
 *
 * script-src uses a per-request nonce and 'strict-dynamic', and does not
 * include 'unsafe-inline'. Middleware copies that policy onto the forwarded
 * request so Next.js can stamp the nonce onto its own scripts. 'strict-dynamic'
 * lets that nonce-trusted script insert the Maps script. The Maps host
 * allowlist stays for browsers that ignore 'strict-dynamic'.
 *
 * style-src keeps 'unsafe-inline'. React `style={{}}` attributes (progress,
 * skeletons, spacing) are not covered by a style nonce — nonces apply to
 * style elements, not style attributes — and Next's font loader emits inline
 * style tags that would need a layout change to nonce. Those layout files
 * stay untouched here.
 */

/** Base64 or UUID token. Rejected values are omitted so they cannot break the policy. */
const CSP_NONCE = /^[A-Za-z0-9+/_-]{16,128}={0,2}$/;

export const MAPS_SCRIPT_ORIGINS = [
  "https://maps.googleapis.com",
  "https://maps.gstatic.com",
] as const;

/** Hotelbeds CDN. Forbes photographs are served from the Supabase storage origin. */
export const HOTEL_PHOTO_IMG_ORIGIN = "https://photos.hotelbeds.com";

export const REFERRER_POLICY = "no-referrer";

function connectSources(supabaseOrigin: string | null): string[] {
  const sources = ["'self'", ...MAPS_SCRIPT_ORIGINS];
  if (!supabaseOrigin) return sources;
  sources.push(supabaseOrigin);
  if (supabaseOrigin.startsWith("https://")) {
    sources.push(`wss://${supabaseOrigin.slice("https://".length)}`);
  } else if (supabaseOrigin.startsWith("http://")) {
    sources.push(`ws://${supabaseOrigin.slice("http://".length)}`);
  }
  return sources;
}

export function supabaseOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function contentSecurityPolicy(
  supabaseUrl: string | null | undefined,
  nonce: string,
): string {
  const connect = connectSources(supabaseOrigin(supabaseUrl)).join(" ");
  const maps = MAPS_SCRIPT_ORIGINS.join(" ");
  const storage = supabaseOrigin(supabaseUrl);
  const images = ["'self'", "data:", "blob:", maps, HOTEL_PHOTO_IMG_ORIGIN];
  if (storage) images.push(storage);
  const nonceSource = CSP_NONCE.test(nonce) ? `'nonce-${nonce}' ` : "";
  return [
    "default-src 'self'",
    `script-src 'self' ${nonceSource}'strict-dynamic' ${maps}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src ${images.join(" ")}`,
    "font-src 'self' data:",
    `connect-src ${connect}`,
    `frame-src ${maps}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}

export const PERMISSIONS_POLICY = [
  "accelerometer=()",
  "camera=()",
  "geolocation=()",
  "gyroscope=()",
  "magnetometer=()",
  "microphone=()",
  "payment=()",
  "usb=()",
  "interest-cohort=()",
].join(", ");

export const HSTS_VALUE = "max-age=63072000; includeSubDomains";

export function securityHeaders(
  supabaseUrl: string | null | undefined,
  options: { https?: boolean; nonce: string },
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": contentSecurityPolicy(supabaseUrl, options.nonce),
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Referrer-Policy": REFERRER_POLICY,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
  if (options?.https) headers["Strict-Transport-Security"] = HSTS_VALUE;
  return headers;
}
