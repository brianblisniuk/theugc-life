import type { Metadata } from "next";

import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/shell/page-header";
import { listCrumbs } from "@/lib/shell/navigation";
import { requireUser } from "@/lib/auth/guards";
import { startRebillCheckoutAction } from "@/lib/billing/actions";
import { loadBillingAccess } from "@/lib/billing/queries";
import { billingAccessState } from "@/lib/billing/view";
import { FREE_LIMITS } from "@/lib/config";
import { CREDITS_CONFIG, PLAN_PRICES } from "@/lib/credits/config";
import { refreshOwnGrants } from "@/lib/credits/queries";

function planLabel(accessType: string): string {
  if (accessType === "pro") return "Pro";
  if (accessType === "max") return "Max";
  if (accessType === "destination") return "Destination Pass";
  if (accessType === "admin") return "Admin";
  return accessType;
}

const CHECKOUT_NOTES: Record<string, string> = {
  invalid_product: "That product is not for sale.",
  not_configured: "Checkout is not configured on this server.",
  live_disabled: "Live charges are off. Sandbox checkout is not available for this key.",
  provider_error: "Rebill did not open a checkout. Nothing was granted.",
  rejected_url: "The checkout URL was not the theugc-life payment page. Nothing was granted.",
  returned: "If the payment succeeded, access appears after the verified webhook. A payment alone is not access.",
};

export const metadata: Metadata = { title: "Billing" };

/**
 * Billing/access overview. Reads the creator's own entitlements under RLS.
 * Opening the page refreshes this account's credit grants (D132, D135).
 * Checkout is a hosted Rebill link. The form does not send an account id.
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const session = await requireUser("/app/billing");
  await refreshOwnGrants();
  const state = billingAccessState(await loadBillingAccess(session.userId));
  const checkoutCode = (await searchParams).checkout;
  const checkoutNote =
    checkoutCode && CHECKOUT_NOTES[checkoutCode] ? CHECKOUT_NOTES[checkoutCode] : null;

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
        <p className="mt-2">
          Checkout opens on Rebill. This server does not charge a card. A payment row is not
          access.
        </p>
      </div>

      {checkoutNote ? (
        <p className="rounded-[var(--radius-app)] border border-border bg-surface px-5 py-3 text-sm text-text">
          {checkoutNote}
        </p>
      ) : null}

      <div className="space-y-3">
        <p className="text-sm font-semibold text-text">Checkout</p>
        <div className="flex flex-wrap gap-2">
          {(
            [
              ["pro_monthly", `Pro monthly · $${PLAN_PRICES.pro.monthlyUsd}`],
              ["pro_annual", `Pro annual · $${PLAN_PRICES.pro.annualPerMonthUsd * 12}`],
              ["max_monthly", `Max monthly · $${PLAN_PRICES.max.monthlyUsd}`],
              ["max_annual", `Max annual · $${PLAN_PRICES.max.annualPerMonthUsd * 12}`],
              ...CREDITS_CONFIG.packs.map(
                (pack): [string, string] => [
                  `pack_${pack.credits}`,
                  `${pack.credits} credits · $${pack.priceUsd}`,
                ],
              ),
            ] satisfies Array<[string, string]>
          ).map(([product, label]) => (
            <form key={product} action={startRebillCheckoutAction}>
              <input type="hidden" name="product" value={product} />
              <button
                type="submit"
                className="rounded-[var(--radius-app)] border border-border bg-surface px-3 py-2 text-sm text-text"
              >
                {label}
              </button>
            </form>
          ))}
        </div>
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
