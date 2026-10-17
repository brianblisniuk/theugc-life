/**
 * Document language for the public shell. English is the root. Spanish legal
 * pages live under /es. Anything else stays English.
 */
export function htmlLangFromPath(pathname: string | null | undefined): "en" | "es" {
  if (!pathname) return "en";
  const path = pathname.split("?")[0] ?? pathname;
  if (path === "/es" || path.startsWith("/es/")) return "es";
  return "en";
}
