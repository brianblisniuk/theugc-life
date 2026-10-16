/**
 * Metric ring label. Insufficient evidence is never rendered as 0%.
 * A sufficient zero is the digit 0, without a percent sign.
 */

export interface MetricRingModel {
  sufficient: boolean;
  /** Used only when sufficient is true. Ignored otherwise, including when it is 0. */
  value: number | null;
  label: string;
}

export function metricRingLabel(model: MetricRingModel): string {
  if (!model.sufficient || model.value === null || !Number.isFinite(model.value)) {
    return "Insufficient data";
  }
  const rounded = Math.round(model.value);
  return String(rounded);
}

export function metricRingPercent(model: MetricRingModel): number | null {
  if (!model.sufficient || model.value === null || !Number.isFinite(model.value)) return null;
  return Math.min(100, Math.max(0, model.value));
}
