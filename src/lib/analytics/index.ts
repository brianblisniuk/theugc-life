import { FORBIDDEN_ANALYTICS_KEYS, type AnalyticsProperties, type ProductEvent } from "./events";

export type { ProductEvent, AnalyticsProperties } from "./events";

/**
 * Provider-agnostic analytics interface. The concrete provider (PostHog today,
 * "or approved equivalent") is initialized behind this abstraction so product
 * code never imports a vendor SDK directly (PRD §26, §16).
 */
export interface AnalyticsProvider {
  capture(event: ProductEvent, properties?: AnalyticsProperties): void;
  identify(distinctId: string, properties?: AnalyticsProperties): void;
  reset(): void;
}

/**
 * Strip forbidden keys defensively so sensitive/private data can never reach the
 * analytics provider even if a caller passes it by mistake (ANALYTICS.md §6,
 * §12; PERMISSIONS.md §6).
 */
export function sanitizeProperties(properties?: AnalyticsProperties): AnalyticsProperties {
  if (!properties) return {};
  const out: AnalyticsProperties = {};
  for (const [key, value] of Object.entries(properties)) {
    const lower = key.toLowerCase();
    const forbidden = FORBIDDEN_ANALYTICS_KEYS.some((k) => lower.includes(k));
    if (forbidden) continue;
    out[key] = value;
  }
  return out;
}

/** No-op provider: used when no analytics key is configured, and on the server. */
class NoopAnalyticsProvider implements AnalyticsProvider {
  capture(): void {}
  identify(): void {}
  reset(): void {}
}

let provider: AnalyticsProvider = new NoopAnalyticsProvider();

/** Replace the active provider (used by the client initializer). */
export function setAnalyticsProvider(next: AnalyticsProvider): void {
  provider = next;
}

/**
 * Typed capture helper. All product code calls this rather than a vendor SDK.
 * Properties are sanitized before dispatch.
 */
export function capture(event: ProductEvent, properties?: AnalyticsProperties): void {
  provider.capture(event, sanitizeProperties(properties));
}

export function identify(distinctId: string, properties?: AnalyticsProperties): void {
  provider.identify(distinctId, sanitizeProperties(properties));
}

export function resetAnalytics(): void {
  provider.reset();
}
