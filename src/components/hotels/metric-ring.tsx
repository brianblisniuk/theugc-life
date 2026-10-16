import { figureText, type DiscoverFigure } from "@/lib/screens/discover-figures";

export function MetricRing({
  figure,
  label,
}: {
  figure: DiscoverFigure;
  label: string;
}) {
  const percent = figure.state === "value" ? figure.percent : null;
  const ringStyle =
    percent === null
      ? undefined
      : {
          background: `conic-gradient(#d1ff02 0 ${percent}%, #2a3931 ${percent}% 100%)`,
        };
  return (
    <div className="s1-metric" data-metric-state={figure.state}>
      <span className="s1-ring" style={ringStyle} aria-hidden="true">
        <b>{percent === null ? "—" : `${percent}%`}</b>
      </span>
      <span>
        <span className="s1-metric-name">{label}</span>
        <span className="s1-metric-note">
          {figure.state === "value" ? (figure.note ?? "Observed replies") : figureText(figure)}
        </span>
      </span>
    </div>
  );
}

export function MetricValue({
  figure,
  label,
}: {
  figure: DiscoverFigure;
  label: string;
}) {
  return (
    <div data-metric-state={figure.state}>
      <div className="s1-metric-name">{figure.state === "value" ? figure.text : figureText(figure)}</div>
      <div className="s1-metric-note">
        {label}
        {figure.state === "value" && figure.note ? ` · ${figure.note}` : ""}
      </div>
    </div>
  );
}
