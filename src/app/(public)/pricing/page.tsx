import type { Metadata } from "next";

import { AnalyticsPageView } from "@/components/analytics-page-view";
import { FREE_LIMITS, PRICING } from "@/lib/config";

export const metadata: Metadata = { title: "Pricing" };

/**
 * Pricing overview driven by the typed config source (PRD §5). Values are launch
 * hypotheses; final pricing is validated with cohort data (DECISIONS D004/D005).
 */
export default function PricingPage() {
  return (
    <div>
      <AnalyticsPageView event="pricing_viewed" />
      <h1 className="text-2xl font-semibold text-text">Pricing</h1>
      <p className="mt-2 text-sm text-muted">Launch pricing hypotheses. Subject to change.</p>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-[var(--radius-app)] border border-border bg-surface p-5">
          <h2 className="text-base font-semibold text-text">Free</h2>
          <p className="mt-1 text-sm text-muted">Discover and activate.</p>
          <ul className="mt-3 space-y-1 text-sm text-muted">
            <li>Save up to {FREE_LIMITS.savedHotels} hotels</li>
            <li>{FREE_LIMITS.activePipelineItems} active pipeline items</li>
            <li>{FREE_LIMITS.activeTrips} active trip</li>
          </ul>
        </div>

        <div className="rounded-[var(--radius-app)] border border-border bg-surface p-5">
          <h2 className="text-base font-semibold text-text">Creator Destination Pass</h2>
          <p className="mt-1 text-sm text-muted">
            ${PRICING.destinationPass.priceUsd} · {PRICING.destinationPass.durationDays} days
          </p>
          <p className="mt-3 text-sm text-muted">
            Premium hotels, contacts, and intelligence for one destination.
          </p>
        </div>

        <div className="rounded-[var(--radius-app)] border border-border bg-surface p-5">
          <h2 className="text-base font-semibold text-text">Creator Pro</h2>
          <p className="mt-1 text-sm text-muted">${PRICING.pro.launchPriceUsd}/year</p>
          <p className="mt-3 text-sm text-muted">
            Worldwide premium access and the full creator CRM.
          </p>
        </div>
      </div>
    </div>
  );
}
