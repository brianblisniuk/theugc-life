import type { Metadata } from "next";

import { EmptyState } from "@/components/empty-state";
import { requireUser } from "@/lib/auth/guards";
import { loadBillingAccess } from "@/lib/billing/queries";
import { billingAccessState } from "@/lib/billing/view";

export const metadata: Metadata = { title: "Billing" };

/**
 * Billing/access overview. Reads the creator's own entitlements under RLS.
 *
 * "You're on the Free plan" is a claim about the account and is made only when
 * the read succeeded and found no active access. A failed read establishes
 * nothing — not Free, not expired, not revoked — so it renders a neutral,
 * recoverable notice instead (see src/lib/billing/view.ts).
 */
export default async function BillingPage() {
  await requireUser("/app/billing");
  const state = billingAccessState(await loadBillingAccess());

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-text">Billing &amp; access</h1>

      {state.kind === "error" ? (
        <EmptyState title={state.title} description={state.body} />
      ) : state.kind === "free" ? (
        <EmptyState title={state.title} description={state.body} />
      ) : (
        <ul className="divide-y divide-border rounded-[var(--radius-app)] border border-border bg-surface text-sm">
          {state.entitlements.map((entitlement, i) => (
            <li key={i} className="flex items-center justify-between px-5 py-3">
              <span className="capitalize text-text">{entitlement.accessType}</span>
              <span className="text-muted">
                {entitlement.expiresAt
                  ? `Until ${new Date(entitlement.expiresAt).toLocaleDateString()}`
                  : "Active"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
