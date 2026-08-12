/**
 * Route-protection predicate shared by middleware (and tested in isolation).
 *
 * These are the authenticated route groups. `/app` requires any authenticated
 * user; `/admin` additionally requires an admin/editor role, enforced
 * server-side in the admin layout (defense in depth) — middleware only enforces
 * the authentication gate.
 */
export const PROTECTED_PREFIXES = ["/app", "/admin"] as const;

export function isProtectedPath(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}
