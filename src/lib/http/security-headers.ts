/**
 * Response headers for every HTML and API response (E05, D093 Proposed).
 *
 * The Maps JavaScript API is allowed to load. Nothing else is framed.
 * Referrer-Policy is no-referrer, including on /p/[token], so a share token
 * is not sent as a referrer.
 */

export const MAPS_SCRIPT_ORIGINS = [
  "https://maps.googleapis.com",
  "https://maps.gstatic.com",
] as const;

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

export function contentSecurityPolicy(supabaseUrl: string | null | undefined): string {
  const connect = connectSources(supabaseOrigin(supabaseUrl)).join(" ");
  const maps = MAPS_SCRIPT_ORIGINS.join(" ");
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' ${maps}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${maps}`,
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
  options?: { https?: boolean },
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": contentSecurityPolicy(supabaseUrl),
    "Permissions-Policy": PERMISSIONS_POLICY,
    "Referrer-Policy": REFERRER_POLICY,
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
  if (options?.https) headers["Strict-Transport-Security"] = HSTS_VALUE;
  return headers;
}
