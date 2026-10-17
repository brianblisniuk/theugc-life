import Link from "next/link";

import { AnalyticsPageView } from "@/components/analytics-page-view";
import { CREDITS_CONFIG, PLAN_PRICES } from "@/lib/credits/config";

export default function LandingPage() {
  return (
    <div className="max-w-2xl">
      <AnalyticsPageView event="landing_viewed" />
      <h1 className="text-3xl font-semibold tracking-tight text-text sm:text-4xl">
        The operating system for travel UGC creators.
      </h1>
      <p className="mt-4 text-base text-muted">
        Discover creator-friendly hotels, manage your outreach, and track what happens after you
        press send. Free includes {CREDITS_CONFIG.freeWeeklyCredits} credits every{" "}
        {CREDITS_CONFIG.freeWeeklyPeriodDays} days. Pro is ${PLAN_PRICES.pro.annualPerMonthUsd}/mo
        billed annually. Max is ${PLAN_PRICES.max.annualPerMonthUsd}/mo billed annually.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link
          href="/signup"
          className="rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
        >
          Start free
        </Link>
        <Link
          href="/pricing"
          className="rounded-[var(--radius-app)] border border-border px-4 py-2 text-sm font-semibold text-text"
        >
          See pricing
        </Link>
      </div>
      <p className="mt-10 text-sm text-muted">
        <Link
          href="/privacy"
          className="underline decoration-border underline-offset-2 hover:text-text"
        >
          Privacy
        </Link>
        <span aria-hidden="true"> · </span>
        <Link
          href="/terms"
          className="underline decoration-border underline-offset-2 hover:text-text"
        >
          Terms
        </Link>
      </p>
    </div>
  );
}
