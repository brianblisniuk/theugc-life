import {
  metricRingLabel,
  metricRingPercent,
  type MetricRingModel,
} from "@/lib/design-system/metric-ring";

export function MetricRing({ model }: { model: MetricRingModel }) {
  const label = metricRingLabel(model);
  const percent = metricRingPercent(model);
  const empty = percent === null;
  return (
    <div className="v12-metric">
      <div
        className={empty ? "v12-ring is-empty" : "v12-ring"}
        style={
          empty ? undefined : ({ ["--pct" as string]: String(percent) } as React.CSSProperties)
        }
        role="img"
        aria-label={empty ? `${model.label}: Insufficient data` : `${model.label}: ${label}`}
      >
        <b>{empty ? "—" : label}</b>
      </div>
      <div>
        <div className="v12-metric-name">{model.label}</div>
        <div className="v12-metric-note">
          {empty ? "Insufficient data" : "Sample basis shown with the figure"}
        </div>
      </div>
    </div>
  );
}
