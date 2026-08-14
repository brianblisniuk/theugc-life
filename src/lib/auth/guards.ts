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
 * Tri-state on purpose. "We could not establish the role" is NOT "this user is
 * a creator" — the first is a technical or integrity failure, the second is a
 * claim about the account. Collapsing them is the same class of bug the
 * pipeline and hotel surfaces already guard against, and here it silently
 * downgrades every privileged session whenever the lookup breaks.
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
 * Exactly three outcomes:
 *
 *  - no Supabase user            -> `anonymous`
 *  - lookup succeeded, valid row -> `authenticated` with the stored role
 *  - anything else               -> `error`
 *
 * "Anything else" covers an auth-service failure, a failed `public.users` read,
 * a row carrying a role this application does not model, and — deliberately —
 * an authenticated user with NO `public.users` row at all.
 *
 * That last case is not a new account mid-provisioning. `handle_new_user()`
 * (migration 0011) is an AFTER INSERT trigger on `auth.users`: it writes the
 * `public.users` row and the `creator_profiles` row inside the same transaction
 * that creates the auth user, and there is no asynchronous provisioning worker
 * anywhere in this system. An auth user without an application row is therefore
 * an integrity inconsistency, not a transient state, and resolving it to
 * `creator` would report a broken invariant as an ordinary account.
 *
 * Nothing here repairs it: no INSERT, no creator_profile creation, no fallback.
 * The signup trigger remains the only provisioning mechanism.
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

  // The query succeeded and the account has no application row. See above: this
  // is an integrity inconsistency, not a role.
  if (!row) return { status: "error" };

  const rawRole = (row as { role?: unknown }).role;

  // The row carries a role this application does not model (`moderator` and
  // `brand` are reserved; anything else is corruption). Also not a creator.
  if (!ROLES.includes(rawRole as AppRole)) return { status: "error" };

  const rowEmail = (row as { email?: unknown }).email;

  return {
    status: "authenticated",
    session: {
      userId: user.id,
      email: (typeof rowEmail === "string" ? rowEmail : null) ?? user.email ?? null,
      role: rawRole as AppRole,
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
