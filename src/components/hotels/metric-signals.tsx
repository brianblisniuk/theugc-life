import Link from "next/link";

import type { StrengthLoad } from "@/lib/intelligence/contract";
import {
  type HotelSignalsLoad,
  type MetricId,
  type RankingLoad,
} from "@/lib/metrics/contract";
import { METRIC_ERROR, VIEW_PLANS } from "@/lib/screens/copy";
import { metricCells, type MetricCell } from "@/lib/screens/metric-state";

import { RankingPicker } from "./ranking-picker";

export function MetricCells({
  signals,
  strength,
}: {
  signals: HotelSignalsLoad;
  strength: StrengthLoad | null;
}) {
  const cells = metricCells({ signals, strength });
  return (
    <div className="ux-metrics" data-testid="metric-signals">
      {cells.map((cell) => (
        <MetricCellView key={cell.metric} cell={cell} />
      ))}
    </div>
  );
}

function MetricCellView({ cell }: { cell: MetricCell }) {
  return (
    <article className="ux-metric" data-metric-state={cell.state}>
      <p className="ux-label">{cell.title}</p>
      {cell.state === "available" ? (
        <>
          <p className="ux-key">{cell.valueLabel}</p>
          {cell.confidence || cell.freshness ? (
            <p className="ux-meta">
              {[
                cell.confidence ? `Confidence: ${cell.confidence}.` : null,
                cell.freshness ? `Freshness: ${cell.freshness}.` : null,
              ]
                .filter(Boolean)
                .join(" ")}
            </p>
          ) : null}
          {cell.sampleBasis ? <p className="ux-meta">{cell.sampleBasis}</p> : null}
        </>
      ) : null}
      {cell.state === "locked" ? (
        <>
          <h3 className="ux-name">{cell.capability}</h3>
          <p>{cell.use}</p>
          <p className="ux-meta">{cell.plan}</p>
          <Link href="/app/billing">{VIEW_PLANS}</Link>
        </>
      ) : null}
      {cell.state === "insufficient" ? <p className="ux-key">{cell.label}</p> : null}
      {cell.state === "error" ? (
        <>
          <h3 className="ux-name">{METRIC_ERROR}</h3>
          <p className="ux-meta">{cell.notice}</p>
          <a className="ux-btn" href="">
            Retry
          </a>
        </>
      ) : null}
    </article>
  );
}

export function RankingBoards({
  destinationName,
  rankings,
}: {
  destinationName: string | null;
  rankings: Record<MetricId, RankingLoad>;
}) {
  return <RankingPicker destinationName={destinationName} rankings={rankings} />;
}
