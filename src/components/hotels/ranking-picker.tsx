"use client";

import { useState } from "react";
import Link from "next/link";

import { RetryButton } from "@/components/ui/retry-button";

import {
  METRIC_IDS,
  METRIC_LAYERS,
  METRIC_TITLES,
  RANKING_EMPTY_COPY,
  type MetricId,
  type RankingLoad,
} from "@/lib/metrics/contract";
import { VIEW_PLANS } from "@/lib/screens/copy";
import { rankingPanel } from "@/lib/screens/metric-state";
import { sortOptionLabel } from "@/lib/screens/discover-sort";

/** One ranking at a time. A locked metric shows the lock, not a blurred list. */
export function RankingPicker({
  destinationName,
  rankings,
}: {
  destinationName: string | null;
  rankings: Record<MetricId, RankingLoad>;
}) {
  const [selected, setSelected] = useState<MetricId>("creator_activity");
  const panel = rankingPanel(rankings[selected], RANKING_EMPTY_COPY);
  const place = destinationName ? `${destinationName} and its destinations. ` : "";

  return (
    <section className="ux-stack">
      <h2 className="ux-name">Compare hotels in this destination</h2>
      <p className="ux-meta">{place}One metric at a time.</p>
      <div className="ux-wrap" role="group" aria-label="Ranking metric">
        {METRIC_IDS.map((metric) => {
          const pressed = metric === selected;
          return (
            <button
              key={metric}
              type="button"
              className={pressed ? "ux-chip" : "ux-btn"}
              aria-pressed={pressed}
              onClick={() => setSelected(metric)}
            >
              {sortOptionLabel(metric, METRIC_TITLES[metric], METRIC_LAYERS[metric] === "premium")}
            </button>
          );
        })}
      </div>
      {panel.state === "list" ? (
        <ol className="ux-rows" data-testid={`metric-ranking-${panel.metric}`}>
          {panel.hotels.map((hotel) => (
            <li key={hotel.hotelId} className="ux-row" style={{ minHeight: 0 }}>
              <span>{hotel.rank}</span>
              <span>
                <strong>{hotel.name}</strong>
                <br />
                {hotel.valueLabel}
                {hotel.sampleBasis ? (
                  <>
                    <br />
                    <span className="ux-meta">{hotel.sampleBasis}</span>
                  </>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
      {panel.state === "locked" ? (
        <div className="ux-lock">
          <h2 className="ux-name">{panel.capability}</h2>
          <p>{panel.use}</p>
          <p className="ux-meta">{panel.plan} A locked metric shows no value and no ranking.</p>
          <Link className="ux-btn" href="/app/billing">
            {VIEW_PLANS}
          </Link>
        </div>
      ) : null}
      {panel.state === "empty" ? (
        <p className="ux-meta" role="status">
          {panel.notice}
        </p>
      ) : null}
      {panel.state === "error" ? (
        <div className="ux-notice" role="alert">
          <h2 className="ux-name">Metric rankings couldn&apos;t be loaded.</h2>
          <p className="ux-meta">{panel.notice}</p>
          <RetryButton className="ux-btn" />
        </div>
      ) : null}
    </section>
  );
}
