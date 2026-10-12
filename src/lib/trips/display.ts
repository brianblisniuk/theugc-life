/**
 * How a trip summary figure is shown (PRD §7.5).
 *
 * `null` is unknown: the trip has no linked pipeline or collaboration rows.
 * Unknown is a word, never the digit 0. A real zero is only the digit 0.
 */

export function formatTripMetric(value: number | null): string {
  if (value === null) return "Unknown";
  return String(value);
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
