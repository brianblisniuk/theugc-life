/**
 * F03 order (D130). One metric. The only keys are rank_key descending and
 * hotel id ascending. A second metric, a name, a timestamp, and a composite
 * score are not sort keys. A null rank key is below the floor and is omitted.
 */

import { isMetricId, type MetricId } from "./contract";

export type { MetricId };

export interface RankKeyRow {
  hotelId: string;
  rankKey: number;
}

/** Canonical lowercase UUID order matches Postgres uuid ordering. */
export function compareHotelId(a: string, b: string): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Order rows that already cleared the floor. Equal rank keys break on hotel
 * id only. Extra fields on the row are ignored.
 */
export function orderByRankKey<T extends RankKeyRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    if (a.rankKey !== b.rankKey) return b.rankKey - a.rankKey;
    return compareHotelId(a.hotelId, b.hotelId);
  });
}

export function parseMetricRank(raw: string | string[] | undefined | null): MetricId | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return isMetricId(trimmed) ? trimmed : null;
}
