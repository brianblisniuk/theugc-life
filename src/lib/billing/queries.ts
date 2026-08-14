/**
 * Billing & access reads (PERMISSIONS.md §12).
 *
 * Entitlements are read with the cookie-bound client, so
 * `access_entitlements_select` (`user_id = auth.uid() or is_admin_or_editor()`)
 * decides which rows the caller sees. `authenticated` holds SELECT only —
 * entitlement rows are written by the billing path under service_role.
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

/** Every entitlement row the caller owns, most recently started first. */
export async function loadBillingAccess(
  /** Injectable for tests; production always uses the cookie-bound client. */
  injectedClient?: BillingQueryClient,
): Promise<BillingAccessResult> {
  const supabase = injectedClient ?? (await createClient());

  const { data, error } = await supabase
    .from("access_entitlements")
    .select("access_type, status, starts_at, expires_at")
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
