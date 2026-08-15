/**
 * Creator intelligence panels (PRD §12.6/§12.7/§12.8, DESIGN_SYSTEM.md §5).
 *
 * Two panels, two provenance-identical but access-different layers (D050):
 *
 *  - `IntelligencePanel` renders PUBLIC Creator Network Intelligence. Everyone
 *    sees exactly this — anonymous, Free, Destination Pass, Pro. It contains no
 *    reply rate and no reply timing; those live in the premium projection.
 *
 *  - `PremiumIntelligencePanel` renders one of four states that must never be
 *    confused: available, locked, building, error.
 *
 * Product rules governing both:
 *  - absence of data is NOT negative data (no "0% reply rate", no "Low");
 *  - a technical error is NOT a domain fact — a failed query or a failed
 *    entitlement check must never be reported as "no data" or "not entitled".
 *
 * All state selection lives in lib/hotels/intelligence so it is unit-tested
 * independently of rendering. Metric suppression additionally happens upstream
 * in the database views, which is where it is actually enforced.
 */
import Link from "next/link";

import { AnalyticsPageView } from "@/components/analytics-page-view";
import {
  BUILDING_INTELLIGENCE_COPY,
  INSUFFICIENT_INTELLIGENCE_COPY,
  INTELLIGENCE_ERROR_COPY,
  LOCKED_INTELLIGENCE_COPY,
  PREMIUM_INTELLIGENCE_ERROR_COPY,
  activityLabel,
  collaborationTypeLabels,
  contributorSampleLabel,
  intelligencePanelState,
  premiumReplyRateLabel,
  recencyLabel,
  recentActivityBandLabel,
  replyTimeBandLabel,
  type IntelligenceResult,
  type PremiumIntelligenceResult,
  type PremiumIntelligenceState,
} from "@/lib/hotels/intelligence";

function Card({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-[var(--radius-app)] border border-border bg-surface p-6">
      <h3 className="text-base font-semibold text-text">{title}</h3>
      <p className="mt-2 max-w-prose text-sm text-muted">{description}</p>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="text-muted">{label}</dt>
      <dd className="text-text">{value}</dd>
    </div>
  );
}

export function IntelligencePanel({ result }: { result: IntelligenceResult }) {
  const state = intelligencePanelState(result);

  if (state === "error") {
    return (
      <Card
        title={INTELLIGENCE_ERROR_COPY.title}
        description={INTELLIGENCE_ERROR_COPY.description}
      />
    );
  }

  if (state === "insufficient") {
    return (
      <Card
        title={INSUFFICIENT_INTELLIGENCE_COPY.title}
        description={INSUFFICIENT_INTELLIGENCE_COPY.description}
      />
    );
  }

  const signal = result.status === "ok" ? result.signal : null;
  const activity = activityLabel(signal?.activityLevel ?? null);
  const recency = recencyLabel(signal?.recencyBand ?? null);

  return (
    <div className="space-y-3 rounded-[var(--radius-app)] border border-border bg-surface p-6">
      {activity ? <p className="text-base font-semibold text-text">{activity}</p> : null}
      <dl className="space-y-1.5 text-sm">
        {recency ? <Metric label="Recency" value={recency} /> : null}
        {signal?.hasConfirmedCollaboration ? (
          <Metric label="Collaboration" value="Creator collaboration confirmed" />
        ) : null}
      </dl>
    </div>
  );
}

/**
 * The premium layer.
 *
 * `locked` deliberately names the metrics without showing any of them: the
 * creator learns what a Pass buys, and learns nothing about this hotel. The
 * analytics event fires only in `available`, so "premium intelligence viewed"
 * means premium content was actually rendered.
 */
export function PremiumIntelligencePanel({
  state,
  result,
}: {
  state: PremiumIntelligenceState;
  /** `null` whenever the query was deliberately not issued. */
  result: PremiumIntelligenceResult | null;
}) {
  if (state === "error") {
    return (
      <Card
        title={PREMIUM_INTELLIGENCE_ERROR_COPY.title}
        description={PREMIUM_INTELLIGENCE_ERROR_COPY.description}
      />
    );
  }

  if (state === "locked") {
    return (
      <div className="space-y-4 rounded-[var(--radius-app)] border border-border bg-surface p-6">
        <div className="space-y-1">
          <h3 className="text-base font-semibold text-text">{LOCKED_INTELLIGENCE_COPY.title}</h3>
          <p className="max-w-prose text-sm text-muted">{LOCKED_INTELLIGENCE_COPY.description}</p>
        </div>
        <Link
          href="/app/billing"
          className="inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast"
        >
          View access options
        </Link>
      </div>
    );
  }

  if (state === "building") {
    return (
      <Card
        title={BUILDING_INTELLIGENCE_COPY.title}
        description={BUILDING_INTELLIGENCE_COPY.description}
      />
    );
  }

  const signal = result?.status === "ok" ? result.signal : null;
  const replyRate = premiumReplyRateLabel(signal);
  const replyTime = replyTimeBandLabel(signal?.replyTimeBand ?? null);
  const recentActivity = recentActivityBandLabel(signal?.recentActivityBand ?? null);
  const types = collaborationTypeLabels(signal?.collaborationTypes ?? null);
  const sample = contributorSampleLabel(signal);

  return (
    <div className="space-y-3 rounded-[var(--radius-app)] border border-border bg-surface p-6">
      <AnalyticsPageView event="premium_intelligence_viewed" />
      <dl className="space-y-1.5 text-sm">
        {replyRate ? <Metric label="Reply rate" value={replyRate} /> : null}
        {replyTime ? <Metric label="Typical reply" value={replyTime} /> : null}
        {recentActivity ? <Metric label="Recent creator activity" value={recentActivity} /> : null}
        {types.length > 0 ? (
          <Metric label="Collaboration types observed" value={types.join(" · ")} />
        ) : null}
      </dl>
      {sample ? <p className="text-xs text-muted">{sample}</p> : null}
    </div>
  );
}
