/**
 * Same-origin relative redirects.
 *
 * A value is accepted only when it is one path on NEXT_PUBLIC_SITE_URL.
 * `//host`, `/\host`, a backslash, and an ASCII control are rejected.
 * WHATWG resolution of `/\evil` against the site origin is a different origin,
 * so the check is the resolved origin, not the first character.
 */

const MAX_LENGTH = 2048;

export function safeSameOriginPath(value: unknown, siteOrigin: string): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_LENGTH) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("\\")) return null;
  if (/[\u0000-\u001F\u007F]/.test(value)) return null;

  let site: URL;
  try {
    site = new URL(siteOrigin);
  } catch {
    return null;
  }

  let resolved: URL;
  try {
    resolved = new URL(value, site);
  } catch {
    return null;
  }
  if (resolved.origin !== site.origin) return null;
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

export function safeRedirect(value: unknown, siteOrigin: string): string {
  return safeSameOriginPath(value, siteOrigin) ?? "/app";
}
