"use client";

import posthog from "posthog-js";

import { getClientEnv } from "@/env";

import { setAnalyticsProvider, type AnalyticsProperties, type AnalyticsProvider } from "./index";
import type { ProductEvent } from "./events";

let initialized = false;

class PostHogProvider implements AnalyticsProvider {
  capture(event: ProductEvent, properties?: AnalyticsProperties): void {
    posthog.capture(event, properties);
  }
  identify(distinctId: string, properties?: AnalyticsProperties): void {
    posthog.identify(distinctId, properties);
  }
  reset(): void {
    posthog.reset();
  }
}

/**
 * Initialize the PostHog client adapter once, on the browser. If no key is
 * configured the function is a no-op and the default no-op provider remains
 * active, so analytics is entirely optional in local/dev environments.
 */
export function initAnalytics(): void {
  if (initialized || typeof window === "undefined") return;

  const env = getClientEnv();
  const key = env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return;

  posthog.init(key, {
    api_host: env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
    capture_pageview: false, // routed explicitly to avoid noisy high-volume events
    autocapture: false,
    person_profiles: "identified_only",
  });

  setAnalyticsProvider(new PostHogProvider());
  initialized = true;
}
