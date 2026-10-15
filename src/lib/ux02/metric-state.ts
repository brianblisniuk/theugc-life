/**
 * Four metric states. They are not collapsed into each other.
 * Locked has no value. Insufficient is not zero. Error is not an empty ranking.
 */
import {
  CONFIDENCE_LABELS,
  FRESHNESS_LABELS,
  type StrengthLoad,
} from "@/lib/intelligence/contract";
import {
  METRIC_IDS,
  METRIC_LAYERS,
  METRIC_TITLES,
  NOT_ENOUGH_DATA_LABEL,
  type HotelSignalsLoad,
  type MetricId,
  type RankingHotel,
  type RankingLoad,
} from "@/lib/metrics/contract";

import {
  METRIC_ERROR,
  RESPONSE_INSIGHTS_PLAN,
  RESPONSE_INSIGHTS_TITLE,
  RESPONSE_INSIGHTS_USE,
} from "./copy";

export type MetricCell =
  | {
      state: "available";
      metric: MetricId;
      title: string;
      valueLabel: string;
      confidence: string | null;
      freshness: string | null;
      sampleBasis: string | null;
    }
  | {
      state: "locked";
      metric: MetricId;
      title: string;
      capability: string;
      use: string;
      plan: string;
    }
  | {
      state: "insufficient";
      metric: MetricId;
      title: string;
      label: typeof NOT_ENOUGH_DATA_LABEL;
    }
  | {
      state: "error";
      metric: MetricId;
      title: string;
      notice: string;
    };

function lockedCopy(metric: MetricId): {
  capability: string;
  use: string;
  plan: string;
} {
  if (METRIC_LAYERS[metric] === "premium") {
    return {
      capability: RESPONSE_INSIGHTS_TITLE,
      use: RESPONSE_INSIGHTS_USE,
      plan: RESPONSE_INSIGHTS_PLAN,
    };
  }
  return {
    capability: METRIC_TITLES[metric],
    use: "This public metric is not available for this account.",
    plan: "A locked metric shows no value and no ranking.",
  };
}

export function metricCells(input: {
  signals: HotelSignalsLoad;
  strength: StrengthLoad | null;
}): MetricCell[] {
  const signals = input.signals;
  if (signals.status === "error") {
    const notice = signals.notice || METRIC_ERROR;
    return METRIC_IDS.map((metric) => ({
      state: "error" as const,
      metric,
      title: METRIC_TITLES[metric],
      notice,
    }));
  }

  const strengthByMetric = new Map(
    input.strength?.status === "ok" ? input.strength.metrics.map((row) => [row.metric, row]) : [],
  );

  return METRIC_IDS.map((metric) => {
    const title = METRIC_TITLES[metric];
    const signal = signals.metrics.find((row) => row.metric === metric);
    if (!signal) {
      return { state: "error" as const, metric, title, notice: METRIC_ERROR };
    }
    if (signal.state === "locked") {
      return { state: "locked" as const, metric, title, ...lockedCopy(metric) };
    }
    if (signal.state === "not_enough_data" || signal.valueLabel === null) {
      return { state: "insufficient" as const, metric, title, label: NOT_ENOUGH_DATA_LABEL };
    }
    const meta = strengthByMetric.get(metric);
    const showMeta = meta?.state === "available";
    return {
      state: "available" as const,
      metric,
      title,
      valueLabel: signal.valueLabel,
      confidence: showMeta && meta.confidenceLevel ? CONFIDENCE_LABELS[meta.confidenceLevel] : null,
      freshness: showMeta && meta.freshnessBand ? FRESHNESS_LABELS[meta.freshnessBand] : null,
      sampleBasis: signal.sampleBasis,
    };
  });
}

export type RankingPanel =
  | { state: "list"; metric: MetricId; title: string; hotels: readonly RankingHotel[] }
  | {
      state: "locked";
      metric: MetricId;
      title: string;
      capability: string;
      use: string;
      plan: string;
    }
  | { state: "empty"; metric: MetricId; title: string; notice: string }
  | { state: "error"; metric: MetricId | null; title: string; notice: string };

export function rankingPanel(ranking: RankingLoad, emptyNotice: string): RankingPanel {
  if (ranking.status === "error") {
    return { state: "error", metric: null, title: "Ranking", notice: ranking.notice };
  }
  if (ranking.status === "locked") {
    return {
      state: "locked",
      metric: ranking.metric,
      title: ranking.title,
      ...lockedCopy(ranking.metric),
    };
  }
  if (ranking.hotels.length === 0) {
    return { state: "empty", metric: ranking.metric, title: ranking.title, notice: emptyNotice };
  }
  return { state: "list", metric: ranking.metric, title: ranking.title, hotels: ranking.hotels };
}
