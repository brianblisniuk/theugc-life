import type { Metadata } from "next";

import { AnalyticsPageView } from "@/components/analytics-page-view";
import { FREE_LIMITS, PRICING } from "@/lib/config";

export const metadata: Metadata = { title: "Pricing" };

/**
 * Pricing overview driven by the typed config source (PRD §5, D051/D052).
 *
 * The catalogue is never the product being sold: every publishable hotel is
 * discoverable on every plan (D049). What a plan unlocks is Premium
 * Intelligence, verified contacts and workflow scope — so no copy here may
 * imply "premium hotels" or a gated database.
 */
export default function PricingPage() {
  return (
    <div>
      <AnalyticsPageView event="pricing_viewed" />
      <h1 className="text-2xl font-semibold text-text">Pricing</h1>
      <p className="mt-2 text-sm text-muted">
        Every hotel is discoverable on every plan. Paid plans unlock Premium Intelligence and
        verified contacts.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="rounded-[var(--radius-app)] border border-border bg-surface p-5">
          <h2 className="text-base font-semibold text-text">Free</h2>
          <p className="mt-1 text-sm text-muted">Worldwide discovery, no card required.</p>
          <ul className="mt-3 space-y-1 text-sm text-muted">
            <li>Discover every hotel worldwide</li>
            <li>Public creator intelligence</li>
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
          <ul className="mt-3 space-y-1 text-sm text-muted">
            <li>Premium creator intelligence in that destination</li>
            <li>Verified hotel contacts in that destination</li>
            <li>Unlimited pipeline for that destination</li>
            <li>Worldwide discovery continues</li>
          </ul>
        </div>

        <div className="rounded-[var(--radius-app)] border border-border bg-surface p-5">
          <h2 className="text-base font-semibold text-text">Creator Pro</h2>
          <p className="mt-1 text-sm text-muted">${PRICING.pro.launchPriceUsd}/year</p>
          <ul className="mt-3 space-y-1 text-sm text-muted">
            <li>Premium creator intelligence worldwide</li>
            <li>Verified hotel contacts worldwide</li>
            <li>Full CRM, trips and portfolio</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
