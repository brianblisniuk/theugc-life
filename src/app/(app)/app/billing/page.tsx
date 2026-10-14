import type { Metadata } from "next";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { listCrumbs } from "@/lib/shell/navigation";
import { requireUser } from "@/lib/auth/guards";
import { loadBillingAccess } from "@/lib/billing/queries";
import { billingAccessState } from "@/lib/billing/view";
import { FREE_LIMITS } from "@/lib/config";
import { CREDITS_CONFIG, PLAN_PRICES } from "@/lib/credits/config";

function planLabel(accessType: string): string {
  if (accessType === "pro") return "Pro";
  if (accessType === "max") return "Max";
  if (accessType === "destination") return "Destination Pass";
  if (accessType === "admin") return "Admin";
  return accessType;
}

export const metadata: Metadata = { title: "Billing" };

/**
 * Billing/access overview. Reads the creator's own entitlements under RLS.
 *
 * This is a SELF-SERVICE surface: it answers "what does this account have".
 * The user id therefore comes from the server session and is applied as an
 * explicit predicate. `access_entitlements_select` also lets an admin or editor
 * read every entitlement row — correctly, for reconciliation — so without the
 * predicate an admin with no entitlement of their own would be shown somebody
 * else's Pro as their own plan.
 *
 * "You're on the Free plan" is a claim about the account and is made only when
 * the read succeeded and found no active access. A failed read establishes
 * nothing — not Free, not expired, not revoked — so it renders a neutral,
 * recoverable notice instead (see src/lib/billing/view.ts).
 */
export default async function BillingPage() {
  const session = await requireUser("/app/billing");
  const state = billingAccessState(await loadBillingAccess(session.userId));

  return (
    <div className="space-y-6">
      <PageHeader title="Billing & access" crumbs={listCrumbs("Billing")} />

      <div className="rounded-[var(--radius-app)] border border-border bg-surface p-5 text-sm text-muted">
        <p className="font-semibold text-text">Plans</p>
        <ul className="mt-2 space-y-1">
          <li>
            Free · {CREDITS_CONFIG.freeWeeklyCredits} credits every{" "}
            {CREDITS_CONFIG.freeWeeklyPeriodDays} days · {FREE_LIMITS.savedHotels} saved hotels,{" "}
            {FREE_LIMITS.activePipelineItems} active pipeline items, {FREE_LIMITS.activeTrips}{" "}
            active trip
          </li>
          <li>
            Pro · ${PLAN_PRICES.pro.annualPerMonthUsd}/mo billed annually or $
            {PLAN_PRICES.pro.monthlyUsd}/mo · {CREDITS_CONFIG.planMonthlyCredits.pro} credits a
            month
          </li>
          <li>
            Max · ${PLAN_PRICES.max.annualPerMonthUsd}/mo billed annually or $
            {PLAN_PRICES.max.monthlyUsd}/mo · {CREDITS_CONFIG.planMonthlyCredits.max} credits a
            month
          </li>
        </ul>
        <p className="mt-2">These prices are config. This page does not charge a card.</p>
      </div>

      {state.kind === "error" ? (
        <EmptyState title={state.title} description={state.body} />
      ) : state.kind === "free" ? (
        <EmptyState title={state.title} description={state.body} />
      ) : (
        <ul className="divide-y divide-border rounded-[var(--radius-app)] border border-border bg-surface text-sm">
          {state.entitlements.map((entitlement, i) => (
            <li key={i} className="flex items-center justify-between px-5 py-3">
              <span className="text-text">{planLabel(entitlement.accessType)}</span>
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
