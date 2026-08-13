/**
 * Pure creator-intelligence display decisions (PRD §12.6/§12.7,
 * DESIGN_SYSTEM.md §5).
 *
 * The governing rule: absence of data is not negative data. When there is no
 * intelligence row — or a row whose confidence is too low for anything to
 * survive the privacy gates — the UI must show an insufficient-data state
 * rather than a zeroed metric ("0% reply rate", "Low activity").
 *
 * Framework-free so the decision is unit-testable without rendering.
 */

export interface IntelligenceSignal {
  activityLevel: string | null;
  confidenceLevel: string | null;
  replyRate: number | null;
  hasConfirmedCollaboration: boolean | null;
  recencyBand: string | null;
}

/** Copy for the insufficient-data state (DESIGN_SYSTEM.md §5). */
export const INSUFFICIENT_INTELLIGENCE_COPY = {
  title: "Not enough creator data yet",
  description:
    "Creator activity and reply insights will appear here as creators track real outreach through theugc.life.",
} as const;

/** Precise reply rate is only ever shown at strong confidence (PRD §12.7). */
export function canShowReplyRate(signal: IntelligenceSignal | null): boolean {
  return Boolean(
    signal && signal.confidenceLevel === "strong" && typeof signal.replyRate === "number",
  );
}

/**
 * True when the UI must render the insufficient-data state: no row at all,
 * explicitly insufficient confidence, or nothing displayable left after the
 * confidence/privacy gates.
 */
export function shouldShowInsufficientData(signal: IntelligenceSignal | null): boolean {
  if (!signal) return true;
  if (signal.confidenceLevel === "insufficient" || signal.confidenceLevel === null) return true;

  const hasActivity = Boolean(signal.activityLevel);
  const hasRecency = Boolean(signal.recencyBand);
  const hasCollab = signal.hasConfirmedCollaboration === true;

  return !hasActivity && !hasRecency && !hasCollab && !canShowReplyRate(signal);
}

const ACTIVITY_LABEL: Record<string, string> = {
  high: "High creator activity",
  medium: "Medium creator activity",
  low: "Creator activity detected",
  emerging: "Emerging creator activity",
};

const RECENCY_LABEL: Record<string, string> = {
  past_month: "Creator activity in the past month",
  past_quarter: "Creator activity in the past quarter",
  older: "Creator activity on record",
};

/** Coarse activity label; never implies absence when data is simply missing. */
export function activityLabel(level: string | null): string | null {
  if (!level) return null;
  return ACTIVITY_LABEL[level] ?? "Creator activity detected";
}

/** Coarse recency label (the view already suppresses it below moderate). */
export function recencyLabel(band: string | null): string | null {
  if (!band) return null;
  return RECENCY_LABEL[band] ?? null;
}

/** Reply rate as a whole-percent string, or null when it must stay hidden. */
export function replyRateLabel(signal: IntelligenceSignal | null): string | null {
  if (!canShowReplyRate(signal) || !signal || signal.replyRate === null) return null;
  return `${Math.round(signal.replyRate * 100)}%`;
}
