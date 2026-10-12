/**
 * How a trip summary figure is shown (PRD §7.5).
 *
 * `null` is unknown: the trip has no linked pipeline or collaboration rows.
 * Unknown is a word, never the digit 0. A real zero is only the digit 0.
 */

import type { ShortlistResult } from "./types";

export function formatTripMetric(value: number | null): string {
  if (value === null) return "Unknown";
  return String(value);
}

/** Outcome copy for the Hotel Detail "add to trip" control. */
export function addToTripMessage(result: ShortlistResult): string {
  switch (result.result) {
    case "added":
      return "Added to this trip.";
    case "already_shortlisted":
      return "Already on this trip.";
    case "removed":
      return "Removed from this trip.";
    case "hotel_not_found":
      return "That hotel isn’t in the published catalog.";
    case "not_found":
      return "That trip isn’t available.";
    case "invalid_input":
      return "Choose a trip and try again.";
    case "creator_profile_missing":
      return "We couldn’t find your creator profile. Reload and try again.";
    default:
      return "We couldn’t add this hotel to the trip.";
  }
}

export function tripLimitMessage(limit: number): string {
  const noun = limit === 1 ? "1 active trip" : `${limit} active trips`;
  return `The Free plan includes ${noun}. Complete or cancel one to plan another, or review billing.`;
}

export const TRIP_METRIC_LABELS = [
  ["targetHotels", "Target hotels"],
  ["pitched", "Pitched"],
  ["replies", "Replies"],
  ["negotiations", "Negotiations"],
  ["confirmedCollaborations", "Confirmed collaborations"],
  ["followupsDue", "Follow-ups due"],
] as const;
