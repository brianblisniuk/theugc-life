/**
 * Active Discover filters as removable chips.
 * A keyword is one chip of the sanitized term. It is not sent to a model
 * and it is not split into a destination, a star rating, or a plan.
 */
import {
  buildDiscoverHref,
  hotelTypeLabel,
  verificationLabel,
  type DiscoverQuery,
} from "@/lib/hotels/filters";
import { activityLabel } from "@/lib/hotels/intelligence";

export interface DiscoverChip {
  key: string;
  label: string;
  removeHref: string;
}

export interface DiscoverChipNames {
  destinationName: string | null;
  countryName: string | null;
}

function without(query: DiscoverQuery, patch: Partial<DiscoverQuery>): string {
  return buildDiscoverHref({ ...query, ...patch, page: 1 });
}

export function discoverFilterChips(
  query: DiscoverQuery,
  names: DiscoverChipNames,
): DiscoverChip[] {
  const chips: DiscoverChip[] = [];
  if (query.q) {
    chips.push({
      key: "q",
      label: query.q,
      removeHref: without(query, { q: null }),
    });
  }
  if (query.destination) {
    chips.push({
      key: "destination",
      label: names.destinationName ?? query.destination,
      removeHref: without(query, { destination: null }),
    });
  }
  if (query.type) {
    chips.push({
      key: "type",
      label: hotelTypeLabel(query.type) ?? query.type,
      removeHref: without(query, { type: null }),
    });
  }
  if (query.country) {
    chips.push({
      key: "country",
      label: names.countryName ?? query.country,
      removeHref: without(query, { country: null }),
    });
  }
  if (query.minStars) {
    chips.push({
      key: "stars",
      label: `${query.minStars}-star`,
      removeHref: without(query, { minStars: null }),
    });
  }
  if (query.verification) {
    chips.push({
      key: "verification",
      label: verificationLabel(query.verification),
      removeHref: without(query, { verification: null }),
    });
  }
  if (query.activity) {
    chips.push({
      key: "activity",
      label: activityLabel(query.activity) ?? query.activity,
      removeHref: without(query, { activity: null }),
    });
  }
  if (query.collaboration) {
    chips.push({
      key: "collaboration",
      label: "Creator collaboration observed",
      removeHref: without(query, { collaboration: null }),
    });
  }
  return chips;
}

/** Sort is a control, not a chip. Clearing filters does not have to keep it. */
export function clearFiltersHref(): string {
  return "/app/discover";
}
