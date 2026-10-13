import {
  LOCKED_METRIC_COPY,
  METRIC_IDS,
  NOT_ENOUGH_DATA_LABEL,
  RANKING_EMPTY_COPY,
  type HotelSignalsLoad,
  type MetricId,
  type RankingLoad,
} from "@/lib/metrics/contract";

function Notice({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-[var(--radius-app)] border border-border bg-surface p-6" role="status">
      <h3 className="text-base font-semibold text-text">{title}</h3>
      <p className="mt-2 max-w-prose text-sm text-muted">{description}</p>
    </div>
  );
}

function RankingList({
  destinationName,
  ranking,
}: {
  destinationName: string | null;
  ranking: RankingLoad;
}) {
  if (ranking.status === "error") {
    return <Notice title="Ranking unavailable" description={ranking.notice} />;
  }
  const place = destinationName ? ` in ${destinationName}` : "";
  if (ranking.status === "locked") {
    return (
      <Notice title={`${ranking.title}${place}`} description={LOCKED_METRIC_COPY.description} />
    );
  }
  return (
    <div
      className="space-y-3 rounded-[var(--radius-app)] border border-border bg-surface p-6"
      data-testid={`metric-ranking-${ranking.metric}`}
    >
      <h3 className="text-base font-semibold text-text">
        {ranking.title}
        {place}
      </h3>
      {ranking.hotels.length === 0 ? (
        <p className="max-w-prose text-sm text-muted">{RANKING_EMPTY_COPY}</p>
      ) : (
        <ol className="space-y-3">
          {ranking.hotels.map((hotel) => (
            <li key={hotel.hotelId} className="text-sm">
              <p className="font-semibold text-text">
                {hotel.rank}. {hotel.name}
              </p>
              <p className="text-text">{hotel.valueLabel}</p>
              {hotel.sampleBasis ? <p className="text-muted">{hotel.sampleBasis}</p> : null}
            </li>
          ))}
        </ol>
      )}
      <p className="max-w-prose text-xs text-muted">{ranking.thresholdRule}</p>
    </div>
  );
}

/**
 * One card per metric, then one ranking per metric. The lists are not merged
 * into a score, and a failed read stays a notice.
 */
export function MetricSignals({
  destinationName,
  signals,
  rankings,
}: {
  destinationName: string | null;
  signals: HotelSignalsLoad;
  rankings: Record<MetricId, RankingLoad>;
}) {
  return (
    <div className="space-y-4" data-testid="metric-signals">
      <div className="space-y-1">
        <h3 className="text-base font-semibold text-text">Hotel signals</h3>
        <p className="max-w-prose text-sm text-muted">
          Each line is one metric from confirmed creator events. These are not combined into a
          score.
        </p>
      </div>
      {signals.status === "error" ? (
        <Notice title="Hotel signals unavailable" description={signals.notice} />
      ) : (
        <div className="space-y-3 rounded-[var(--radius-app)] border border-border bg-surface p-6">
          {signals.metrics.map((signal) => (
            <div key={signal.metric} className="space-y-1">
              <h4 className="text-sm font-semibold text-text">{signal.title}</h4>
              {signal.state === "locked" ? (
                <p className="text-sm text-muted">{LOCKED_METRIC_COPY.description}</p>
              ) : (
                <p className="text-sm text-text">
                  {signal.state === "available" ? signal.valueLabel : NOT_ENOUGH_DATA_LABEL}
                </p>
              )}
              {signal.sampleBasis ? (
                <p className="text-xs text-muted">{signal.sampleBasis}</p>
              ) : null}
              <p className="max-w-prose text-xs text-muted">{signal.thresholdRule}</p>
            </div>
          ))}
        </div>
      )}
      {METRIC_IDS.map((metric) => (
        <RankingList key={metric} destinationName={destinationName} ranking={rankings[metric]} />
      ))}
    </div>
  );
}
