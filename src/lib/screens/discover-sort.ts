/**
 * Discover sort gate.
 * A locked premium sort keeps the name-ordered catalog on screen.
 * Below the floor is not an empty catalog and not a lock.
 * A failed read is not either of those.
 */
import type { MetricId } from "@/lib/metrics/contract";

export type DiscoverSortGate = "catalog" | "ranked" | "locked" | "below_floor" | "error";

export function discoverSortGate(input: {
  rank: MetricId | null;
  rankedKind: "list" | "locked" | "below_floor" | null;
  failed: boolean;
}): DiscoverSortGate {
  if (input.failed) return "error";
  if (input.rank && input.rankedKind === "locked") return "locked";
  if (input.rank && input.rankedKind === "below_floor") return "below_floor";
  if (input.rank && input.rankedKind === "list") return "ranked";
  return "catalog";
}

export function sortOptionLabel(metric: MetricId, title: string, premium: boolean): string {
  return premium ? `${title} (Pro)` : title;
}
