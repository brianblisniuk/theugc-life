/**
 * Discover and Hotel Detail metric figures.
 * A missing sample is Insufficient data. It is not 0% and not a lock.
 * A lock carries no value.
 */
import type { HotelSignalsLoad, MetricId, MetricSignal } from "@/lib/metrics/contract";

export const INSUFFICIENT_DATA = "Insufficient data";

export type DiscoverFigure =
  | { state: "value"; text: string; percent: number | null; note: string | null }
  | { state: "insufficient" }
  | { state: "locked" }
  | { state: "error" };

export interface DiscoverFigures {
  replyRate: DiscoverFigure;
  replyTime: DiscoverFigure;
  activity: DiscoverFigure;
}

function percentOf(label: string): number | null {
  const match = /^(\d{1,3})%$/.exec(label);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n < 0 || n > 100 || `${n}%` !== label) return null;
  return n;
}

function figureFor(signal: MetricSignal | undefined, failed: boolean): DiscoverFigure {
  if (failed || !signal) return { state: "error" };
  if (signal.state === "locked") return { state: "locked" };
  if (signal.state !== "available" || signal.valueLabel === null) return { state: "insufficient" };
  const percent = signal.metric === "response_rate" ? percentOf(signal.valueLabel) : null;
  if (signal.metric === "response_rate" && percent === null) return { state: "error" };
  return { state: "value", text: signal.valueLabel, percent, note: signal.sampleBasis };
}

export function discoverFigures(load: HotelSignalsLoad | undefined): DiscoverFigures {
  const failed = !load || load.status === "error";
  const byId = new Map<MetricId, MetricSignal>();
  if (load?.status === "ok") {
    for (const metric of load.metrics) byId.set(metric.metric, metric);
  }
  return {
    replyRate: figureFor(byId.get("response_rate"), failed),
    replyTime: figureFor(byId.get("response_time"), failed),
    activity: figureFor(byId.get("creator_activity"), failed),
  };
}

export type ActivityTag =
  | { state: "value"; text: string }
  | { state: "insufficient" }
  | { state: "error" };

/** Public card activity can fill a metric that is below its floor. An error stays an error. */
export function activityTag(figure: DiscoverFigure, publicLabel: string | null): ActivityTag {
  if (figure.state === "value") return { state: "value", text: figure.text };
  if (figure.state === "error") return { state: "error" };
  if (publicLabel && publicLabel.trim().length > 0) return { state: "value", text: publicLabel };
  return { state: "insufficient" };
}

export function figureText(figure: DiscoverFigure): string {
  if (figure.state === "value") return figure.text;
  if (figure.state === "locked") return "Pro";
  if (figure.state === "error") return "Couldn't load";
  return INSUFFICIENT_DATA;
}
