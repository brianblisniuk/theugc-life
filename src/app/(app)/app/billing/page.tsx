import type { Metadata } from "next";

import { EmptyState } from "@/components/empty-state";
import { getSessionContext } from "@/lib/auth/guards";
import { createClient } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Billing" };

/**
 * Billing/access overview. Reads the user's own entitlements under RLS. Purchase
 * flows (Hotmart) are a Sprint 1 non-goal for this foundation.
 */
export default async function BillingPage() {
  const session = await getSessionContext();
  const supabase = await createClient();
  const { data: entitlements } = await supabase
    .from("access_entitlements")
    .select("access_type, status, starts_at, expires_at")
    .eq("user_id", session?.userId ?? "")
    .order("starts_at", { ascending: false });

  const active = (entitlements ?? []).filter((e) => e.status === "active");

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-text">Billing &amp; access</h1>
      {active.length === 0 ? (
        <EmptyState
          title="You're on the Free plan"
          description="Premium access (Destination Pass or Pro) is created by the payment flow, which arrives in Sprint 1."
        />
      ) : (
        <ul className="divide-y divide-border rounded-[var(--radius-app)] border border-border bg-surface text-sm">
          {active.map((e, i) => (
            <li key={i} className="flex items-center justify-between px-5 py-3">
              <span className="capitalize text-text">{e.access_type}</span>
              <span className="text-muted">
                {e.expires_at ? `Until ${new Date(e.expires_at).toLocaleDateString()}` : "Active"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
