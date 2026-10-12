import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

/** Stub event names. Real Rebill event names are set by the real integration. */
export const ALLOWED_EVENTS: readonly string[] = ["entitlement.grant"];

export function isAllowedEvent(event: unknown): boolean {
  return typeof event === "string" && ALLOWED_EVENTS.includes(event);
}

/** Length-safe constant-time comparison: both sides are hashed to 32 bytes first. */
export function secretMatches(provided: string | null, expected: string | undefined): boolean {
  if (!expected || provided === null) return false;
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
