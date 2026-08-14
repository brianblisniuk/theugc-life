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
 * Tri-state on purpose. "We could not read the role" is NOT "this user is a
 * creator" — the first is a technical failure, the second is a claim about the
 * account. Collapsing them is the same class of bug the pipeline and hotel
 * surfaces already guard against, and here it silently downgrades every
 * privileged session whenever the lookup breaks.
 */
export type SessionResolution =
  | { status: "authenticated"; session: SessionContext }
  | { status: "anonymous" }
  | { status: "error" };

/**
 * Thrown when the session is real but its role could not be resolved. Carries
 * no PostgREST payload: the underlying error never reaches a rendered page.
 */
export class SessionUnavailableError extends Error {
  constructor() {
    super("session_unavailable");
    this.name = "SessionUnavailableError";
  }
}

const ROLES: readonly AppRole[] = ["creator", "editor", "admin"];

/**
 * Resolve the authenticated user and their database-backed role.
 *
 * The role comes from `public.users` read under the caller's own RLS
 * (`users_select_own` restricts it to `id = auth.uid()`), never from
 * `user_metadata`, a client-supplied field, a query parameter or an
 * application-controlled cookie. The database is the only authority.
 *
 * Four outcomes, deliberately distinct:
 *
 *  - no Supabase user            -> `anonymous`
 *  - lookup succeeded, row found -> `authenticated` with the stored role
 *  - lookup succeeded, no row    -> `authenticated` as `creator`. This is the
 *    ONLY case where the fallback is legitimate: a brand-new account whose
 *    signup trigger has not landed yet genuinely has no role, and the
 *    least-privileged answer is the correct one.
 *  - lookup failed               -> `error`. A permission failure, a transport
 *    failure or a malformed row is a technical error, not a role.
 */
export async function resolveSession(): Promise<SessionResolution> {
  const supabase = await createClient();
  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError) return { status: "error" };
  if (!user) return { status: "anonymous" };

  const { data: row, error } = await supabase
    .from("users")
    .select("role, email")
    .eq("id", user.id)
    .maybeSingle();

  // The query itself failed. Reporting this as "creator" would turn an
  // infrastructure problem into a domain fact about the account.
  if (error) return { status: "error" };

  const rawRole = (row as { role?: unknown } | null)?.role;

  // A row exists but carries a role this application does not model
  // (`moderator`/`brand` are reserved, and anything else is corruption). That is
  // not a creator either — it is an unresolvable session.
  if (rawRole !== undefined && rawRole !== null && !ROLES.includes(rawRole as AppRole)) {
    return { status: "error" };
  }

  const role = (rawRole as AppRole | undefined | null) ?? "creator";
  const rowEmail = (row as { email?: unknown } | null)?.email;

  return {
    status: "authenticated",
    session: {
      userId: user.id,
      email: (typeof rowEmail === "string" ? rowEmail : null) ?? user.email ?? null,
      role,
    },
  };
}

/**
 * Require an authenticated user.
 *
 * Redirects to /login (preserving intent) when there is no session. Throws a
 * sanitized {@link SessionUnavailableError} when the session exists but its role
 * could not be resolved — a protected surface is never rendered under a guessed
 * role, and the caller is never told "you are signed out" because of a database
 * error.
 */
export async function requireUser(redirectTo?: string): Promise<SessionContext> {
  const resolution = await resolveSession();

  if (resolution.status === "error") {
    throw new SessionUnavailableError();
  }
  if (resolution.status === "anonymous") {
    const target = redirectTo ? `/login?redirect=${encodeURIComponent(redirectTo)}` : "/login";
    redirect(target);
  }
  return resolution.session;
}

/**
 * Require one of the given roles. This is the authoritative server-side check
 * for privileged surfaces such as `/admin` (PRD §25.4, PERMISSIONS.md §11).
 * Non-matching users are sent to the app home, never shown the protected UI;
 * an unresolvable session raises instead, so a lookup failure can never present
 * itself as "you are not an admin".
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
