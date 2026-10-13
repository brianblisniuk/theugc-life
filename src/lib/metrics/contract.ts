/**
 * H01 metric contract (D120).
 *
 * One metric at a time. The strings match the database reads. A payload that
 * carries a creator, a raw count, an hour count, or a composite score is an
 * error, not a ranking.
 */

export const METRIC_IDS = ["response_rate", "response_time", "creator_activity"] as const;

export type MetricId = (typeof METRIC_IDS)[number];

export const METRIC_TITLES: Record<MetricId, string> = {
  response_rate: "Most responsive",
  response_time: "Fastest replying",
  creator_activity: "Most active with creators",
};

export const METRIC_LAYERS: Record<MetricId, "public" | "premium"> = {
  response_rate: "premium",
  response_time: "premium",
  creator_activity: "public",
};

export const THRESHOLD_RULES: Record<MetricId, string> = {
  response_rate:
    "Shown when at least 15 confirmed pitches from at least 5 creators in the last 365 days. A follow-up is not another pitch. Below that, not enough data.",
  response_time:
    "Shown when at least 10 confirmed replies from at least 5 creators in the last 365 days. The value is a time band, not an hour count. Below that, not enough data.",
  creator_activity:
    "Shown when at least 3 creators have confirmed activity and the sample reaches emerging (5 or more confirmed events). Below that, not enough data.",
};

export const RESPONSE_TIME_LABELS = [
  "Under 24h",
  "1–3 days",
  "3–7 days",
  "1–2 weeks",
  "2+ weeks",
] as const;

export const ACTIVITY_LABELS = ["High", "Medium", "Emerging"] as const;

export const NOT_ENOUGH_DATA_LABEL = "Not enough data";

export const METRIC_READ_NOTICE =
  "Metric rankings couldn't be loaded. This is a temporary problem, not an empty ranking.";

export const RANKING_EMPTY_COPY =
  "No hotel in this destination has enough confirmed data for this metric yet.";

export const LOCKED_METRIC_COPY = {
  title: "Premium metric",
  description:
    "Response rate and response time stay locked until a Pass covers this destination, or Pro covers every destination. A locked metric shows no value and no ranking.",
} as const;

const FORBIDDEN_KEY =
  /^(owner_user_id|creator_id|evidence_id|mail_account_id|source_family|provenance|provenance_class|score|composite|hours|median_hours|milliseconds|pitch_count|reply_count|cycle_count|sample_size|sample_creators|private_value|sponsored|paid_placement|rank_key)$/;

export type MetricState = "available" | "not_enough_data" | "locked";

export interface MetricSignal {
  metric: MetricId;
  title: string;
  layer: "public" | "premium";
  state: MetricState;
  valueLabel: string | null;
  sampleBasis: string | null;
  thresholdRule: string;
}

export type HotelSignalsLoad =
  { status: "ok"; metrics: readonly MetricSignal[] } | { status: "error"; notice: string };

export interface RankingHotel {
  hotelId: string;
  name: string;
  rank: number;
  valueLabel: string;
  sampleBasis: string | null;
}

export type RankingLoad =
  | {
      status: "ok";
      metric: MetricId;
      title: string;
      thresholdRule: string;
      hotels: readonly RankingHotel[];
    }
  | {
      status: "locked";
      metric: MetricId;
      title: string;
      thresholdRule: string;
    }
  | { status: "error"; notice: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some((item) => hasForbiddenKey(item));
  if (!isRecord(value)) return false;
  return Object.keys(value).some((key) => FORBIDDEN_KEY.test(key) || hasForbiddenKey(value[key]));
}

export function isMetricId(value: unknown): value is MetricId {
  return typeof value === "string" && (METRIC_IDS as readonly string[]).includes(value);
}

export function isSampleBasis(value: string | null): boolean {
  if (value === null) return true;
  const match = /^Based on activity from (\d+) creators$/.exec(value);
  if (!match) return false;
  const count = Number(match[1]);
  return count >= 5 && String(count) === match[1];
}

export function isPublishedValue(metric: MetricId, label: string): boolean {
  if (metric === "response_rate") {
    if (!/^(?:100|[1-9]?\d)%$/.test(label)) return false;
    const n = Number(label.slice(0, -1));
    return n >= 0 && n <= 100 && `${n}%` === label;
  }
  if (metric === "response_time") {
    return (RESPONSE_TIME_LABELS as readonly string[]).includes(label);
  }
  return (ACTIVITY_LABELS as readonly string[]).includes(label);
}

function readSignal(value: unknown): MetricSignal | null {
  if (!isRecord(value) || hasForbiddenKey(value)) return null;
  if (!isMetricId(value.metric)) return null;
  if (value.title !== METRIC_TITLES[value.metric]) return null;
  if (value.layer !== METRIC_LAYERS[value.metric]) return null;
  if (value.threshold_rule !== THRESHOLD_RULES[value.metric]) return null;
  const sampleBasis = value.sample_basis === null ? null : value.sample_basis;
  if (typeof sampleBasis !== "string" && sampleBasis !== null) return null;
  if (!isSampleBasis(sampleBasis)) return null;
  if (value.state === "locked" || value.state === "not_enough_data") {
    if (value.value_label !== null || sampleBasis !== null) return null;
    return {
      metric: value.metric,
      title: METRIC_TITLES[value.metric],
      layer: METRIC_LAYERS[value.metric],
      state: value.state,
      valueLabel: null,
      sampleBasis: null,
      thresholdRule: THRESHOLD_RULES[value.metric],
    };
  }
  if (value.state !== "available") return null;
  if (typeof value.value_label !== "string" || !isPublishedValue(value.metric, value.value_label)) {
    return null;
  }
  return {
    metric: value.metric,
    title: METRIC_TITLES[value.metric],
    layer: METRIC_LAYERS[value.metric],
    state: "available",
    valueLabel: value.value_label,
    sampleBasis,
    thresholdRule: THRESHOLD_RULES[value.metric],
  };
}

/** A null or malformed read is an error notice, never an empty metric list. */
export function parseHotelSignals(data: unknown): HotelSignalsLoad {
  if (
    !isRecord(data) ||
    hasForbiddenKey(data) ||
    data.result !== "ok" ||
    !Array.isArray(data.metrics)
  ) {
    return { status: "error", notice: METRIC_READ_NOTICE };
  }
  if (data.metrics.length !== METRIC_IDS.length)
    return { status: "error", notice: METRIC_READ_NOTICE };
  const metrics: MetricSignal[] = [];
  for (let i = 0; i < METRIC_IDS.length; i += 1) {
    const signal = readSignal(data.metrics[i]);
    if (!signal || signal.metric !== METRIC_IDS[i])
      return { status: "error", notice: METRIC_READ_NOTICE };
    metrics.push(signal);
  }
  return { status: "ok", metrics };
}

export function parseRanking(data: unknown, metric: MetricId): RankingLoad {
  if (!isRecord(data) || hasForbiddenKey(data))
    return { status: "error", notice: METRIC_READ_NOTICE };
  if (data.metric !== metric) return { status: "error", notice: METRIC_READ_NOTICE };
  if (data.title !== METRIC_TITLES[metric]) return { status: "error", notice: METRIC_READ_NOTICE };
  if (data.layer !== METRIC_LAYERS[metric]) return { status: "error", notice: METRIC_READ_NOTICE };
  if (data.scope !== "destination_and_descendants") {
    return { status: "error", notice: METRIC_READ_NOTICE };
  }
  if (data.threshold_rule !== THRESHOLD_RULES[metric]) {
    return { status: "error", notice: METRIC_READ_NOTICE };
  }
  if (data.result === "locked") {
    if ("hotels" in data) return { status: "error", notice: METRIC_READ_NOTICE };
    return {
      status: "locked",
      metric,
      title: METRIC_TITLES[metric],
      thresholdRule: THRESHOLD_RULES[metric],
    };
  }
  if (data.result !== "ok" || !Array.isArray(data.hotels)) {
    return { status: "error", notice: METRIC_READ_NOTICE };
  }
  const hotels: RankingHotel[] = [];
  data.hotels.forEach((item, index) => {
    if (!isRecord(item)) return;
    const valueLabel = item.value_label;
    const sampleBasis = item.sample_basis === null ? null : item.sample_basis;
    if (typeof item.hotel_id !== "string") return;
    if (typeof item.rank !== "number" || item.rank !== index + 1) return;
    if (typeof valueLabel !== "string" || !isPublishedValue(metric, valueLabel)) return;
    if (typeof sampleBasis !== "string" && sampleBasis !== null) return;
    if (!isSampleBasis(sampleBasis)) return;
    hotels.push({
      hotelId: item.hotel_id,
      name: "",
      rank: item.rank,
      valueLabel,
      sampleBasis,
    });
  });
  if (hotels.length !== data.hotels.length) return { status: "error", notice: METRIC_READ_NOTICE };
  return {
    status: "ok",
    metric,
    title: METRIC_TITLES[metric],
    thresholdRule: THRESHOLD_RULES[metric],
    hotels,
  };
}
