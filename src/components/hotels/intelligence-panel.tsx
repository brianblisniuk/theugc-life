/**
 * Creator intelligence panel (PRD §12.6/§12.7, DESIGN_SYSTEM.md §5).
 *
 * Two product rules govern this panel:
 *  - absence of data is NOT negative data (no "0% reply rate", no "Low");
 *  - a technical error is NOT a domain fact — a failed query must never be
 *    reported as "not enough creator data" (F2).
 *
 * All state selection lives in lib/hotels/intelligence so it is unit-tested
 * independently of rendering. Precise metrics are additionally suppressed
 * upstream by the `hotel_public_intelligence` view.
 */
import {
  INSUFFICIENT_INTELLIGENCE_COPY,
  INTELLIGENCE_ERROR_COPY,
  activityLabel,
  intelligencePanelState,
  recencyLabel,
  replyRateLabel,
  type IntelligenceResult,
} from "@/lib/hotels/intelligence";

function Card({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-[var(--radius-app)] border border-border bg-surface p-6">
      <h3 className="text-base font-semibold text-text">{title}</h3>
      <p className="mt-2 max-w-prose text-sm text-muted">{description}</p>
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
  const replyRate = replyRateLabel(signal);

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
        {signal?.hasConfirmedCollaboration ? (
          <div className="flex gap-2">
            <dt className="text-muted">Collaboration</dt>
            <dd className="text-text">Creator collaboration confirmed</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
}
