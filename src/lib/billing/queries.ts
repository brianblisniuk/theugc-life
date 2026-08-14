/**
 * Billing & access reads (PERMISSIONS.md §12).
 *
 * Entitlements are read with the cookie-bound client, so
 * `access_entitlements_select` (`user_id = auth.uid() or is_admin_or_editor()`)
 * decides which rows the caller MAY see. `authenticated` holds SELECT only —
 * entitlement rows are written by the billing path under service_role.
 *
 * That policy is deliberately broad on its second arm: an admin or editor may
 * read every entitlement row, which is what reconciliation and support work
 * need. It is therefore NOT a scope for a self-service surface. A page that
 * answers "what does THIS account have" must say whose account it means, in the
 * query, with an id that came from the server session — otherwise an admin with
 * no entitlement of their own reads somebody else's Pro and is told they have
 * premium access.
 *
 * Hence `loadBillingAccess(userId)`: RLS decides what is permitted, the explicit
 * predicate decides what is being asked.
 */
import "server-only";

import { createClient } from "@/lib/supabase/server";

export type BillingQueryClient = Awaited<ReturnType<typeof createClient>>;

export interface Entitlement {
  accessType: string;
  status: string;
  startsAt: string | null;
  expiresAt: string | null;
}

/**
 * Tri-state, for the reason the whole codebase is tri-state: "we could not read
 * your entitlements" is NOT "you have none". Collapsing the two tells a paying
 * creator they are on the Free plan because a query failed.
 */
export type BillingAccessResult =
  { status: "ok"; entitlements: Entitlement[] } | { status: "error" };

/**
 * The entitlement rows belonging to ONE user, most recently started first.
 *
 * `userId` MUST come from the server-side session (`requireUser()`), never from
 * a query parameter, a form field, a browser payload or an application-set
 * cookie. It is the scope of the question, not an authorization decision — RLS
 * still independently limits what the caller is allowed to read.
 */
export async function loadBillingAccess(
  userId: string,
  /** Injectable for tests; production always uses the cookie-bound client. */
  injectedClient?: BillingQueryClient,
): Promise<BillingAccessResult> {
  const supabase = injectedClient ?? (await createClient());

  const { data, error } = await supabase
    .from("access_entitlements")
    .select("access_type, status, starts_at, expires_at")
    .eq("user_id", userId)
    .order("starts_at", { ascending: false });

  // Never surface a raw Postgres/PostgREST error to the browser.
  if (error) return { status: "error" };

  const entitlements = (data ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    return {
      accessType: String(row.access_type ?? ""),
      status: String(row.status ?? ""),
      startsAt: (row.starts_at as string | null) ?? null,
      expiresAt: (row.expires_at as string | null) ?? null,
    } satisfies Entitlement;
  });

  return { status: "ok", entitlements };
}
