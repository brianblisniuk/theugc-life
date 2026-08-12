import Link from "next/link";

import { AnalyticsPageView } from "@/components/analytics-page-view";

export default function LandingPage() {
  return (
    <div className="max-w-2xl">
      <AnalyticsPageView event="landing_viewed" />
      <h1 className="text-3xl font-semibold tracking-tight text-text sm:text-4xl">
        The operating system for travel UGC creators.
      </h1>
      <p className="mt-4 text-base text-muted">
        Discover creator-friendly hotels, manage your outreach, and track what happens after you
        press send. This is the Sprint 0 foundation — product surfaces arrive in later sprints.
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
    </div>
  );
}
