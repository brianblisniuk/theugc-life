import "server-only";

import { redirect } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import type { AppRole } from "@/lib/auth/roles";

export { isAdminOrEditor, type AppRole } from "@/lib/auth/roles";

export interface SessionContext {
  userId: string;
  email: string | null;
  role: AppRole;
}

/**
 * Resolve the authenticated user and their DB-backed role, or null if there is
 * no valid session. Role comes from `public.users`, never from client state.
 */
export async function getSessionContext(): Promise<SessionContext | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

  const { data: row } = await supabase
    .from("users")
    .select("role, email")
    .eq("id", user.id)
    .maybeSingle();

  // A brand-new user may not yet have a public.users row if the signup trigger
  // has not completed; default to the least-privileged role.
  const role = (row?.role as AppRole | undefined) ?? "creator";

  return {
    userId: user.id,
    email: (row?.email as string | null | undefined) ?? user.email ?? null,
    role,
  };
}

/**
 * Require an authenticated user. Redirects to /login (preserving intent) when
 * absent. Returns the session context for authorized callers.
 */
export async function requireUser(redirectTo?: string): Promise<SessionContext> {
  const ctx = await getSessionContext();
  if (!ctx) {
    const target = redirectTo ? `/login?redirect=${encodeURIComponent(redirectTo)}` : "/login";
    redirect(target);
  }
  return ctx;
}

/**
 * Require one of the given roles. This is the authoritative server-side check
 * for privileged surfaces such as `/admin` (PRD §25.4, PERMISSIONS.md §11).
 * Non-matching users are sent to the app home, never shown the protected UI.
 */
export async function requireRole(
  allowed: readonly AppRole[],
  redirectTo?: string,
): Promise<SessionContext> {
  const ctx = await requireUser(redirectTo);
  if (!allowed.includes(ctx.role)) {
    redirect("/app");
  }
  return ctx;
}
