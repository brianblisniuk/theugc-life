/**
 * C02–C05 reads (D146–D150).
 *
 * Confidence and freshness annotate an H01 metric. They are not a second
 * value and not a score. Personal counts belong to the caller. A network
 * payload below the floor has no metrics. Creator fit orders one public
 * activity key. Max may add rank, confidence, and freshness. A forbidden
 * key is an error, not a ranking.
 */

export const CONFIDENCE_LEVELS = ["emerging", "moderate", "strong"] as const;
export type ConfidenceLevel = (typeof CONFIDENCE_LEVELS)[number];

export const FRESHNESS_BANDS = ["past_month", "past_quarter", "older"] as const;
export type FreshnessBand = (typeof FRESHNESS_BANDS)[number];

export const COLLABORATION_TYPES = ["stay", "product", "paid", "stay_plus_paid", "other"] as const;
export type CollaborationType = (typeof COLLABORATION_TYPES)[number];

export const ACTIVITY_FIT_LABELS = ["High", "Medium", "Emerging"] as const;
export type ActivityFitLabel = (typeof ACTIVITY_FIT_LABELS)[number];

export const DATA_STRENGTH_NOTICE =
  "Data strength couldn't be loaded. This is a temporary problem, not a weak hotel.";

export const PERSONAL_NOTICE =
  "Your history couldn't be loaded. That does not mean it is empty.";

export const NETWORK_AGGREGATE_NOTICE =
  "The confirmed network couldn't be loaded. That does not mean the hotel has no activity.";

export const FIT_NOTICE =
  "Creator fit couldn't be loaded. This is a temporary problem, not an empty list.";

export const FIT_LOCKED_COPY = {
  title: "Creator fit",
  description:
    "Creator fit is Premium Intelligence. A Pass covers this destination. Pro and Max cover every destination. A locked fit shows no hotels.",
} as const;

export const FIT_EMPTY_COPY =
  "No hotel here matches a collaboration type you have confirmed. A type needs three other creators before it can match, and hotels below the activity floor stay off the list.";

export const CONFIDENCE_LABELS: Record<ConfidenceLevel, string> = {
  emerging: "Emerging",
  moderate: "Moderate",
  strong: "Strong",
};

export const FRESHNESS_LABELS: Record<FreshnessBand, string> = {
  past_month: "Past month",
  past_quarter: "Past quarter",
  older: "Older",
};

export const TYPE_LABELS: Record<CollaborationType, string> = {
  stay: "Stay",
  product: "Product",
  paid: "Paid",
  stay_plus_paid: "Stay + paid",
  other: "Other",
};

const METRICS = ["response_rate", "response_time", "creator_activity"] as const;
type StrengthMetric = (typeof METRICS)[number];

const FORBIDDEN_KEY =
  /^(owner_user_id|creator_id|creator_user_id|evidence_id|mail_account_id|source_family|provenance|provenance_class|score|composite|hours|median_hours|milliseconds|pitch_count|reply_count|cycle_count|sample_size|sample_creators|rank_key|private_value|sponsored|paid_placement)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => hasForbiddenKey(item));
  if (!isRecord(value)) return false;
  return Object.keys(value).some((key) => FORBIDDEN_KEY.test(key) || hasForbiddenKey(value[key]));
}

function isConfidence(value: unknown): value is ConfidenceLevel {
  return typeof value === "string" && (CONFIDENCE_LEVELS as readonly string[]).includes(value);
}

function isFreshness(value: unknown): value is FreshnessBand {
  return typeof value === "string" && (FRESHNESS_BANDS as readonly string[]).includes(value);
}

function isType(value: unknown): value is CollaborationType {
  return typeof value === "string" && (COLLABORATION_TYPES as readonly string[]).includes(value);
}

function isActivityLabel(value: unknown): value is ActivityFitLabel {
  return typeof value === "string" && (ACTIVITY_FIT_LABELS as readonly string[]).includes(value);
}

export interface StrengthMetricRow {
  metric: StrengthMetric;
  state: "available" | "not_enough_data" | "locked";
  confidenceLevel: ConfidenceLevel | null;
  freshnessBand: FreshnessBand | null;
}

export type StrengthLoad =
  | { status: "ok"; metrics: readonly StrengthMetricRow[] }
  | { status: "error"; notice: string };

export function parseMetricConfidence(data: unknown): StrengthLoad {
  if (hasForbiddenKey(data) || !isRecord(data)) return { status: "error", notice: DATA_STRENGTH_NOTICE };
  if (data.result === "not_found") return { status: "error", notice: DATA_STRENGTH_NOTICE };
  if (data.result !== "ok" || !Array.isArray(data.metrics) || data.metrics.length !== 3) {
    return { status: "error", notice: DATA_STRENGTH_NOTICE };
  }
  const metrics: StrengthMetricRow[] = [];
  for (const item of data.metrics) {
    if (!isRecord(item)) return { status: "error", notice: DATA_STRENGTH_NOTICE };
    if (typeof item.metric !== "string" || !(METRICS as readonly string[]).includes(item.metric)) {
      return { status: "error", notice: DATA_STRENGTH_NOTICE };
    }
    if (item.state !== "available" && item.state !== "not_enough_data" && item.state !== "locked") {
      return { status: "error", notice: DATA_STRENGTH_NOTICE };
    }
    const confidence = item.confidence_level;
    const freshness = item.freshness_band;
    if (confidence !== null && !isConfidence(confidence)) {
      return { status: "error", notice: DATA_STRENGTH_NOTICE };
    }
    if (freshness !== null && !isFreshness(freshness)) {
      return { status: "error", notice: DATA_STRENGTH_NOTICE };
    }
    if (item.state !== "available" && (confidence !== null || freshness !== null)) {
      return { status: "error", notice: DATA_STRENGTH_NOTICE };
    }
    if (freshness !== null && confidence !== "moderate" && confidence !== "strong") {
      return { status: "error", notice: DATA_STRENGTH_NOTICE };
    }
    metrics.push({
      metric: item.metric as StrengthMetric,
      state: item.state,
      confidenceLevel: confidence,
      freshnessBand: freshness,
    });
  }
  const names = metrics.map((metric) => metric.metric);
  if (names[0] !== "response_rate" || names[1] !== "response_time" || names[2] !== "creator_activity") {
    return { status: "error", notice: DATA_STRENGTH_NOTICE };
  }
  return { status: "ok", metrics };
}

export interface PersonalAggregate {
  manualEvents: number;
  gmailEvents: number;
  lastEventAt: string | null;
  collaborationTypes: readonly CollaborationType[];
}

export type PersonalLoad =
  | { status: "ok"; aggregate: PersonalAggregate }
  | { status: "hidden" }
  | { status: "error"; notice: string };

export function parsePersonalAggregate(data: unknown): PersonalLoad {
  if (hasForbiddenKey(data) || !isRecord(data)) return { status: "error", notice: PERSONAL_NOTICE };
  if (data.result === "not_found") return { status: "hidden" };
  if (data.result !== "ok") return { status: "error", notice: PERSONAL_NOTICE };
  if (!Number.isInteger(data.manual_events) || !Number.isInteger(data.gmail_events)) {
    return { status: "error", notice: PERSONAL_NOTICE };
  }
  if ((data.manual_events as number) < 0 || (data.gmail_events as number) < 0) {
    return { status: "error", notice: PERSONAL_NOTICE };
  }
  if (data.last_event_at !== null && typeof data.last_event_at !== "string") {
    return { status: "error", notice: PERSONAL_NOTICE };
  }
  if (!Array.isArray(data.collaboration_types) || data.collaboration_types.some((type) => !isType(type))) {
    return { status: "error", notice: PERSONAL_NOTICE };
  }
  return {
    status: "ok",
    aggregate: {
      manualEvents: data.manual_events as number,
      gmailEvents: data.gmail_events as number,
      lastEventAt: data.last_event_at,
      collaborationTypes: data.collaboration_types,
    },
  };
}

export interface NetworkAggregate {
  confidenceLevel: string | null;
  activityLevel: string | null;
  recencyBand: FreshnessBand | null;
  freshnessBand: FreshnessBand | null;
  hasObservedCollaboration: true | null;
  responseRate: string | null;
  responseTime: string | null;
  replyVisible: boolean;
}

export type NetworkAggregateLoad =
  | { status: "ok"; aggregate: NetworkAggregate }
  | { status: "insufficient" }
  | { status: "error"; notice: string };

export function parseNetworkAggregate(data: unknown): NetworkAggregateLoad {
  if (hasForbiddenKey(data) || !isRecord(data)) {
    return { status: "error", notice: NETWORK_AGGREGATE_NOTICE };
  }
  if (data.result === "not_found") return { status: "error", notice: NETWORK_AGGREGATE_NOTICE };
  if (data.result === "insufficient") {
    if (Object.keys(data).some((key) => key !== "result")) {
      return { status: "error", notice: NETWORK_AGGREGATE_NOTICE };
    }
    return { status: "insufficient" };
  }
  if (data.result !== "ok") return { status: "error", notice: NETWORK_AGGREGATE_NOTICE };
  if (data.has_observed_collaboration !== true && data.has_observed_collaboration !== null) {
    return { status: "error", notice: NETWORK_AGGREGATE_NOTICE };
  }
  if (data.recency_band !== null && !isFreshness(data.recency_band)) {
    return { status: "error", notice: NETWORK_AGGREGATE_NOTICE };
  }
  if (data.freshness_band !== null && !isFreshness(data.freshness_band)) {
    return { status: "error", notice: NETWORK_AGGREGATE_NOTICE };
  }
  const replyVisible = Object.prototype.hasOwnProperty.call(data, "response_rate");
  if (replyVisible !== Object.prototype.hasOwnProperty.call(data, "response_time")) {
    return { status: "error", notice: NETWORK_AGGREGATE_NOTICE };
  }
  if (replyVisible && data.response_rate !== null && typeof data.response_rate !== "string") {
    return { status: "error", notice: NETWORK_AGGREGATE_NOTICE };
  }
  if (replyVisible && data.response_time !== null && typeof data.response_time !== "string") {
    return { status: "error", notice: NETWORK_AGGREGATE_NOTICE };
  }
  return {
    status: "ok",
    aggregate: {
      confidenceLevel: typeof data.confidence_level === "string" ? data.confidence_level : null,
      activityLevel: typeof data.activity_level === "string" ? data.activity_level : null,
      recencyBand: data.recency_band,
      freshnessBand: data.freshness_band,
      hasObservedCollaboration: data.has_observed_collaboration,
      responseRate: replyVisible ? (data.response_rate as string | null) : null,
      responseTime: replyVisible ? (data.response_time as string | null) : null,
      replyVisible,
    },
  };
}

export interface FitHotel {
  hotelId: string;
  name?: string;
  activityLabel: ActivityFitLabel;
  matchedType: CollaborationType;
  rank: number | null;
  confidenceLevel: ConfidenceLevel | null;
  freshnessBand: FreshnessBand | null;
}

export type FitLoad =
  | { status: "ok"; detailed: boolean; hotels: readonly FitHotel[] }
  | { status: "locked" }
  | { status: "hidden" }
  | { status: "error"; notice: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseCreatorFit(data: unknown): FitLoad {
  if (hasForbiddenKey(data) || !isRecord(data)) return { status: "error", notice: FIT_NOTICE };
  if (data.result === "not_found") return { status: "hidden" };
  if (data.result === "locked") {
    if (Object.prototype.hasOwnProperty.call(data, "hotels")) {
      return { status: "error", notice: FIT_NOTICE };
    }
    return { status: "locked" };
  }
  if (data.result !== "ok" || data.prior_applied !== false || data.prior_reason !== "no_proven_lift") {
    return { status: "error", notice: FIT_NOTICE };
  }
  if (typeof data.detailed !== "boolean" || !Array.isArray(data.hotels)) {
    return { status: "error", notice: FIT_NOTICE };
  }
  const hotels: FitHotel[] = [];
  for (const item of data.hotels) {
    if (!isRecord(item)) return { status: "error", notice: FIT_NOTICE };
    if (typeof item.hotel_id !== "string" || !UUID_RE.test(item.hotel_id)) {
      return { status: "error", notice: FIT_NOTICE };
    }
    if (!isActivityLabel(item.activity_label) || !isType(item.matched_type)) {
      return { status: "error", notice: FIT_NOTICE };
    }
    const detailedKeys = ["rank", "confidence_level", "freshness_band"] as const;
    const present = detailedKeys.filter((key) => Object.prototype.hasOwnProperty.call(item, key));
    if (data.detailed && present.length !== 3) return { status: "error", notice: FIT_NOTICE };
    if (!data.detailed && present.length !== 0) return { status: "error", notice: FIT_NOTICE };
    let rank: number | null = null;
    let confidence: ConfidenceLevel | null = null;
    let freshness: FreshnessBand | null = null;
    if (data.detailed) {
      if (typeof item.rank !== "number" || !Number.isInteger(item.rank) || item.rank < 1) {
        return { status: "error", notice: FIT_NOTICE };
      }
      if (!isConfidence(item.confidence_level)) return { status: "error", notice: FIT_NOTICE };
      if (item.freshness_band !== null && !isFreshness(item.freshness_band)) {
        return { status: "error", notice: FIT_NOTICE };
      }
      if (item.freshness_band !== null && item.confidence_level !== "moderate" && item.confidence_level !== "strong") {
        return { status: "error", notice: FIT_NOTICE };
      }
      rank = item.rank;
      confidence = item.confidence_level;
      freshness = item.freshness_band;
    }
    hotels.push({
      hotelId: item.hotel_id,
      activityLabel: item.activity_label,
      matchedType: item.matched_type,
      rank,
      confidenceLevel: confidence,
      freshnessBand: freshness,
    });
  }
  return { status: "ok", detailed: data.detailed, hotels };
}

export type FitDecision = "pursue" | "skip";

export type FitDecisionLoad =
  | { status: "ok"; decision: FitDecision | null }
  | { status: "hidden" }
  | { status: "error"; notice: string };

export function parseFitDecision(data: unknown): FitDecisionLoad {
  if (hasForbiddenKey(data) || !isRecord(data)) {
    return { status: "error", notice: FIT_NOTICE };
  }
  if (data.result === "not_found") return { status: "hidden" };
  if (data.result !== "ok") return { status: "error", notice: FIT_NOTICE };
  if (data.decision !== null && data.decision !== "pursue" && data.decision !== "skip") {
    return { status: "error", notice: FIT_NOTICE };
  }
  return { status: "ok", decision: data.decision };
}
