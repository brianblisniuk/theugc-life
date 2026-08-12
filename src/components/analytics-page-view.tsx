"use client";

import { useEffect } from "react";

import { capture } from "@/lib/analytics";
import type { ProductEvent } from "@/lib/analytics/events";

/**
 * Fires a single product-analytics event on mount. Demonstrates the typed
 * capture helper; no-ops when analytics is not configured.
 */
export function AnalyticsPageView({ event }: { event: ProductEvent }) {
  useEffect(() => {
    capture(event);
  }, [event]);
  return null;
}
