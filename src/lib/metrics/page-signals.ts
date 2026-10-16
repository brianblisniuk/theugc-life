/**
 * Metric signals for the hotels on one Discover page.
 * Uses the same per-hotel read as Hotel Detail, so a lock stays a lock
 * and a short sample stays insufficient. The page does not read the views.
 */
import "server-only";

import { isUuid } from "@/lib/hotels/ids";
import { DISCOVER_MAX_PAGE_SIZE } from "@/lib/hotels/filters";

import type { HotelSignalsLoad } from "./contract";
import { getHotelMetricSignals } from "./queries";

export async function loadPageMetricSignals(
  hotelIds: readonly string[],
): Promise<Map<string, HotelSignalsLoad>> {
  const ids = [...new Set(hotelIds.filter((id) => isUuid(id)))].slice(0, DISCOVER_MAX_PAGE_SIZE);
  const entries = await Promise.all(
    ids.map(async (id) => [id, await getHotelMetricSignals(id)] as const),
  );
  return new Map(entries);
}
