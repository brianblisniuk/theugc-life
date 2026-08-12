"use client";

import { useEffect } from "react";

import { initAnalytics } from "@/lib/analytics/posthog.client";

/**
 * Mount-once analytics initializer. Renders nothing. Safe to include at the root
 * layout: it no-ops when no analytics key is configured.
 */
export function AnalyticsProvider() {
  useEffect(() => {
    initAnalytics();
  }, []);
  return null;
}
