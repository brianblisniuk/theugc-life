/**
 * C02–C05 display decisions (D099).
 *
 * The database view is the gate. These functions only choose which already
 * suppressed fields are safe to render. A missing row is not zero, and an
 * insufficient band does not become a precise metric.
 */

export const GMAIL_CONFIRM_PROMPT = "Did this happen this way?";

export const NETWORK_BUILDING_COPY = {
  title: "No network fact yet",
  description:
    "The anonymous network appears after at least three different creators leave confirmed facts. Until then, there is no figure.",
} as const;

export const NETWORK_INSUFFICIENT_COPY = {
  title: "There is activity, but not enough",
  description:
    "Fewer than five confirmed facts are not shown as a number. Insufficient data is not zero and not a bad hotel.",
} as const;

export const NETWORK_ERROR_COPY = {
  title: "The anonymous network could not be loaded",
  description: "Reload the page to try again. This does not say the hotel has no data.",
} as const;

export const GMAIL_CONFIRMED_ADMITTED =
  "You confirmed this. It stays as a Gmail fact, separate from what you recorded by hand.";

export const GMAIL_CONFIRMED_NOT_ADMITTED =
  "You confirmed this. It did not enter the network: there is no single canonical hotel for this email.";

export const GMAIL_DISMISSED = "You said no. This reading does not enter the network.";

export const GMAIL_STALE =
  "This reading is out of date and does not enter the network until it is current again.";

export const PRIORITY_SAVED =
  "You marked this hotel as a priority. That does not change the network fact.";

export interface NetworkPublicRow {
  confidenceLevel: "insufficient" | "emerging" | "moderate" | "strong" | null;
  activityLevel: string | null;
  hasObservedCollaboration: boolean | null;
  recencyBand: string | null;
  freshnessBand: string | null;
}

export type NetworkPanelState = "signal" | "insufficient" | "building" | "error";

const CONFIDENCE = new Set(["insufficient", "emerging", "moderate", "strong"]);

export function confidenceBand(sampleSize: number): NetworkPublicRow["confidenceLevel"] {
  if (!Number.isInteger(sampleSize) || sampleSize < 0) return null;
  if (sampleSize >= 50) return "strong";
  if (sampleSize >= 15) return "moderate";
  if (sampleSize >= 5) return "emerging";
  return "insufficient";
}

/** A published row still hides precise fields while the band is insufficient. */
export function networkPanelState(
  result: { status: "ok"; row: NetworkPublicRow } | { status: "none" } | { status: "error" },
): NetworkPanelState {
  if (result.status === "error") return "error";
  if (result.status === "none") return "building";
  const row = result.row;
  if (row.confidenceLevel === "insufficient" || row.confidenceLevel === null) return "insufficient";
  const hasSignal =
    Boolean(row.activityLevel) ||
    Boolean(row.recencyBand) ||
    Boolean(row.freshnessBand) ||
    row.hasObservedCollaboration === true;
  return hasSignal ? "signal" : "insufficient";
}

export function activityLabel(level: string | null): string | null {
  if (level === "emerging") return "Emerging activity";
  if (level === "medium") return "Moderate activity";
  if (level === "high") return "Strong activity";
  return null;
}

export function recencyLabel(band: string | null): string | null {
  if (band === "past_month") return "Activity in the past month";
  if (band === "past_quarter") return "Activity in the past quarter";
  if (band === "older") return "Older activity";
  return null;
}

export function responseTimeBandLabel(band: string | null): string | null {
  if (band === "under_24h") return "Under 24 hours";
  if (band === "1_3_days") return "1–3 days";
  if (band === "3_7_days") return "3–7 days";
  if (band === "1_2_weeks") return "1–2 weeks";
  if (band === "2_plus_weeks") return "2 weeks or more";
  return null;
}

const FACT_LABEL: Record<string, string> = {
  pitch_sent: "Pitch sent",
  followup_sent: "Follow-up sent",
  reply_received: "Reply received",
  positive_reply: "Positive reply",
  negative_reply: "Negative reply",
  offer_received: "Offer received",
  negotiation_started: "Negotiation started",
  deal_won: "Agreement recorded",
  deal_lost: "Closed without an agreement",
  collaboration_started: "Collaboration started",
  collaboration_completed: "Collaboration completed",
  creator_closed_pipeline: "Cycle closed",
  collaboration_type_observed: "Collaboration type",
  gmail_thread_commercial_state: "Thread reading",
  gmail_human_reply_observed: "Human reply observed",
  gmail_reply_latency: "Observed response time",
};

export function factTypeLabel(factType: string): string {
  return FACT_LABEL[factType] ?? "Confirmed fact";
}

export function parseConfidence(value: unknown): NetworkPublicRow["confidenceLevel"] {
  return typeof value === "string" && CONFIDENCE.has(value)
    ? (value as NetworkPublicRow["confidenceLevel"])
    : null;
}

export function gmailPromptCopy(result: string): string | null {
  if (result === "confirmed_admitted") return GMAIL_CONFIRMED_ADMITTED;
  if (result === "confirmed_not_admitted") return GMAIL_CONFIRMED_NOT_ADMITTED;
  if (result === "dismissed") return GMAIL_DISMISSED;
  if (result === "stale") return GMAIL_STALE;
  return null;
}
