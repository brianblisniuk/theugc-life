/**
 * Creator intelligence panel (PRD §12.6/§12.7, DESIGN_SYSTEM.md §5).
 *
 * The product rule is that absence of data is NOT negative data. When a hotel
 * has no intelligence row we render an explicit insufficient-data state — never
 * "0% reply rate", never "Low activity", never "no creators contacted".
 *
 * All display decisions live in lib/hotels/intelligence so they are unit-tested
 * independently of rendering. Precise metrics are additionally suppressed
 * upstream by the `hotel_public_intelligence` view, which nulls `reply_rate`
 * below strong confidence and `recency_band` below moderate confidence.
 */
import {
  INSUFFICIENT_INTELLIGENCE_COPY,
  activityLabel,
  recencyLabel,
  replyRateLabel,
  shouldShowInsufficientData,
} from "@/lib/hotels/intelligence";
import type { HotelIntelligence } from "@/lib/hotels/queries";

function Insufficient() {
  return (
    <div className="rounded-[var(--radius-app)] border border-border bg-surface p-6">
      <h3 className="text-base font-semibold text-text">{INSUFFICIENT_INTELLIGENCE_COPY.title}</h3>
      <p className="mt-2 max-w-prose text-sm text-muted">
        {INSUFFICIENT_INTELLIGENCE_COPY.description}
      </p>
    </div>
  );
}

export function IntelligencePanel({ intelligence }: { intelligence: HotelIntelligence | null }) {
  if (shouldShowInsufficientData(intelligence)) return <Insufficient />;

  const activity = activityLabel(intelligence?.activityLevel ?? null);
  const recency = recencyLabel(intelligence?.recencyBand ?? null);
  const replyRate = replyRateLabel(intelligence);

  return (
    <div className="space-y-3 rounded-[var(--radius-app)] border border-border bg-surface p-6">
      {activity ? <p className="text-base font-semibold text-text">{activity}</p> : null}
      <dl className="space-y-1.5 text-sm">
        {replyRate ? (
          <div className="flex gap-2">
            <dt className="text-muted">Reply rate</dt>
            <dd className="text-text">{replyRate}</dd>
          </div>
        ) : null}
        {recency ? (
          <div className="flex gap-2">
            <dt className="text-muted">Recency</dt>
            <dd className="text-text">{recency}</dd>
          </div>
        ) : null}
        {intelligence?.hasConfirmedCollaboration ? (
          <div className="flex gap-2">
            <dt className="text-muted">Collaboration</dt>
            <dd className="text-text">Creator collaboration confirmed</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
