import type { Metadata } from "next";

import { AnalyticsPageView } from "@/components/analytics-page-view";
import { FREE_LIMITS, PRICING } from "@/lib/config";
import { CREDITS_CONFIG, PLAN_PRICES } from "@/lib/credits/config";

export const metadata: Metadata = { title: "Pricing" };

/**
 * Plan catalogue (D131). Amounts come from typed config, which matches
 * credit_config. This page does not start a checkout and does not grant access.
 */
export default function PricingPage() {
  return (
    <div>
      <AnalyticsPageView event="pricing_viewed" />
      <h1 className="text-2xl font-semibold text-text">Pricing</h1>
      <p className="mt-2 max-w-2xl text-sm text-muted">
        Every hotel is discoverable on every plan. Prices below are the current plan config.
        Checkout is not open, and a payment does not by itself turn a plan on.
      </p>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <div className="rounded-[var(--radius-app)] border border-border bg-surface p-5">
          <h2 className="text-base font-semibold text-text">Free</h2>
          <p className="mt-1 text-sm text-muted">$0</p>
          <ul className="mt-3 space-y-1 text-sm text-muted">
            <li>
              {CREDITS_CONFIG.freeWeeklyCredits} credits every {CREDITS_CONFIG.freeWeeklyPeriodDays}{" "}
              days, from the day the account was created. Unused weekly credits do not stack past{" "}
              {CREDITS_CONFIG.freeWeeklyCredits}.
            </li>
            <li>Manual emails: copy a template. No full AI email generation.</li>
            <li>Save up to {FREE_LIMITS.savedHotels} hotels</li>
            <li>{FREE_LIMITS.activePipelineItems} active pipeline items</li>
            <li>{FREE_LIMITS.activeTrips} active trip</li>
            <li>Public intelligence and a basic portfolio</li>
            <li>No Outreach Assisted and no Premium Intelligence</li>
          </ul>
        </div>

        <div className="rounded-[var(--radius-app)] border border-border bg-surface p-5">
          <h2 className="text-base font-semibold text-text">Pro</h2>
          <p className="mt-1 text-sm text-muted">
            ${PLAN_PRICES.pro.annualPerMonthUsd}/mo billed annually, or $
            {PLAN_PRICES.pro.monthlyUsd}
            /mo monthly
          </p>
          <ul className="mt-3 space-y-1 text-sm text-muted">
            <li>{CREDITS_CONFIG.planMonthlyCredits.pro} credits each month</li>
            <li>Full AI email generation</li>
            <li>Outreach Assisted (Gmail detection and drafts)</li>
            <li>Premium Intelligence worldwide</li>
            <li>Unlimited CRM</li>
            <li>Credit packs, basic ranking, and next actions</li>
          </ul>
        </div>

        <div className="rounded-[var(--radius-app)] border border-border bg-surface p-5">
          <h2 className="text-base font-semibold text-text">Max</h2>
          <p className="mt-1 text-sm text-muted">
            ${PLAN_PRICES.max.annualPerMonthUsd}/mo billed annually, or $
            {PLAN_PRICES.max.monthlyUsd}
            /mo monthly
          </p>
          <ul className="mt-3 space-y-1 text-sm text-muted">
            <li>{CREDITS_CONFIG.planMonthlyCredits.max} credits each month</li>
            <li>Everything in Pro</li>
            <li>Priority AI, advanced signals and rankings, and priority support</li>
            <li>Room for later premium features</li>
          </ul>
        </div>
      </div>

      <h2 className="mt-8 text-base font-semibold text-text">Credit packs</h2>
      <ul className="mt-3 space-y-1 text-sm text-muted">
        {CREDITS_CONFIG.packs.map((pack) => (
          <li key={pack.credits}>
            {pack.credits} credits · ${pack.priceUsd}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-sm text-muted">
        Signed-in creators buy packs from the billing page.
      </p>

      <p className="mt-6 text-sm text-muted">
        Creator Destination Pass remains ${PRICING.destinationPass.priceUsd} for{" "}
        {PRICING.destinationPass.durationDays} days in one destination.
      </p>
    </div>
  );
}
