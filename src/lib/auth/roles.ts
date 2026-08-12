/**
 * Application roles (mirrors DATABASE.md §3). `moderator` and `brand` are
 * reserved and not assignable in MVP. Pure module — safe to import anywhere and
 * to unit test.
 */
export type AppRole = "creator" | "editor" | "admin";

/** Editorial/admin surfaces (PERMISSIONS.md §11). */
export function isAdminOrEditor(role: AppRole): boolean {
  return role === "admin" || role === "editor";
}
