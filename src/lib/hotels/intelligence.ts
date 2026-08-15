/**
 * Pure creator-intelligence display decisions (PRD §12.6/§12.7/§12.8,
 * DESIGN_SYSTEM.md §5).
 *
 * The governing rule: absence of data is not negative data. When there is no
 * intelligence row — or a row whose confidence is too low for anything to
 * survive the privacy gates — the UI must show an insufficient-data state
 * rather than a zeroed metric ("0% reply rate", "Low activity").
 *
 * Framework-free so the decision is unit-testable without rendering.
 */
import type { ContactAccessResult } from "./access";

export interface IntelligenceSignal {
  activityLevel: string | null;
  confidenceLevel: string | null;
  hasConfirmedCollaboration: boolean | null;
  recencyBand: string | null;
}

/**
 * Outcome of loading a hotel's public intelligence.
 *
 * Product integrity rule: a TECHNICAL ERROR IS NOT A DOMAIN FACT. A failed
 * query must never be reported as "not enough creator data" — that is a claim
 * about the world, not about our backend.
 */
export type IntelligenceResult =
  | { status: "ok"; signal: IntelligenceSignal }
  /** The hotel genuinely has no intelligence row. */
  | { status: "none" }
  /** The query/view failed; we learned nothing about the hotel. */
  | { status: "error" };

/** Which intelligence UI state to render. */
export type IntelligencePanelState = "signal" | "insufficient" | "error";

/** Map a load outcome (plus the confidence gates) to a UI state. */
export function intelligencePanelState(result: IntelligenceResult): IntelligencePanelState {
  if (result.status === "error") return "error";
  if (result.status === "none") return "insufficient";
  return shouldShowInsufficientData(result.signal) ? "insufficient" : "signal";
}

/** Copy for the temporarily-unavailable state — never an absence claim. */
export const INTELLIGENCE_ERROR_COPY = {
  title: "Creator intelligence is temporarily unavailable",
  description: "Reload the page to try again.",
} as const;

/** Copy for the insufficient-data state (DESIGN_SYSTEM.md §5). */
export const INSUFFICIENT_INTELLIGENCE_COPY = {
  title: "Not enough creator data yet",
  description:
    "Creator activity and reply insights will appear here as creators track real outreach through theugc.life.",
} as const;

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

  return !hasActivity && !hasRecency && !hasCollab;
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

/* ------------------------------------------------------------------ */
/* PREMIUM Creator Network Intelligence (D050, D058)                    */
/* ------------------------------------------------------------------ */

/**
 * The premium projection, as the database is willing to disclose it.
 *
 * Every field is already threshold-gated in `hotel_premium_intelligence`: a
 * `null` here means the sample or the contributor diversity behind that metric
 * did not clear its floor, NOT that the answer is zero or negative. No exact
 * pitch/reply count and no raw timestamp exists in this shape at all, because
 * neither exists in the view.
 */
export interface PremiumIntelligenceSignal {
  confidenceLevel: string | null;
  /** 0–1. Whole-percent for display; never rendered as "0%" when suppressed. */
  replyRate: number | null;
  replyTimeBand: string | null;
  recentActivityBand: string | null;
  collaborationTypes: string[] | null;
  /** Distinct contributing creators, only once that disclosure itself is safe. */
  contributorCount: number | null;
}

export type PremiumIntelligenceResult =
  | { status: "ok"; signal: PremiumIntelligenceSignal }
  /** Entitled, and the hotel genuinely has no premium row. */
  | { status: "none" }
  /** The premium query failed; we learned nothing. */
  | { status: "error" };

/**
 * The four premium states, which must never be confused (brief §11):
 *
 *  - `available` — entitled, and at least one metric cleared its thresholds;
 *  - `locked`    — the capability exists, this viewer is not entitled;
 *  - `building`  — entitled, but the network has not produced enough qualifying
 *                  evidence yet. Unknown is not zero and not a bad hotel;
 *  - `error`     — the entitlement check or the query failed. This is never
 *                  reported as "not entitled", "no data" or "building".
 */
export type PremiumIntelligenceState = "available" | "locked" | "building" | "error";

/** True when at least one premium metric survived its own thresholds. */
export function hasPremiumSignal(signal: PremiumIntelligenceSignal | null): boolean {
  if (!signal) return false;
  return (
    typeof signal.replyRate === "number" ||
    Boolean(signal.replyTimeBand) ||
    Boolean(signal.recentActivityBand) ||
    (signal.collaborationTypes?.length ?? 0) > 0 ||
    typeof signal.contributorCount === "number"
  );
}

/**
 * Decide the premium panel state from the entitlement answer and the load.
 *
 * Entitlement is resolved first and independently, because "we could not check
 * your access" and "you do not have access" are different claims about a paying
 * account. Only an explicit `denied` produces `locked`.
 */
export function premiumIntelligenceState(input: {
  access: ContactAccessResult;
  /** `null` when the query was deliberately not issued (unentitled/error). */
  result: PremiumIntelligenceResult | null;
}): PremiumIntelligenceState {
  if (input.access.status === "error") return "error";
  if (input.access.status === "denied") return "locked";
  // Entitled from here on.
  if (!input.result || input.result.status === "error") return "error";
  if (input.result.status === "none") return "building";
  return hasPremiumSignal(input.result.signal) ? "available" : "building";
}

/** Copy for the approved building state. Never a negative claim about a hotel. */
export const BUILDING_INTELLIGENCE_COPY = {
  title: "Creator intelligence is building",
  description:
    "Track your outreach here and help make this hotel's insights more useful for the creator community.",
} as const;

/** Copy for the locked state. Communicates value without leaking a value. */
export const LOCKED_INTELLIGENCE_COPY = {
  title: "Premium creator intelligence",
  description:
    "Reply rate, typical reply time, recent creator activity and observed collaboration types are part of a Destination Pass or Creator Pro.",
} as const;

/** Copy for a failed entitlement check or premium load. */
export const PREMIUM_INTELLIGENCE_ERROR_COPY = {
  title: "Premium intelligence is temporarily unavailable",
  description: "Reload the page to try again.",
} as const;

const REPLY_TIME_LABEL: Record<string, string> = {
  under_24h: "Under 24h",
  "1_3_days": "1–3 days",
  "3_7_days": "3–7 days",
  "1_2_weeks": "1–2 weeks",
  "2_plus_weeks": "2+ weeks",
};

const RECENT_ACTIVITY_LABEL: Record<string, string> = {
  within_7_days: "Within 7 days",
  within_30_days: "Within 30 days",
  within_90_days: "Within 90 days",
};

const COLLABORATION_TYPE_LABEL: Record<string, string> = {
  stay: "Stay",
  product: "Product",
  paid: "Paid",
  stay_plus_paid: "Stay + paid",
  other: "Other",
};

/** Reply rate as a whole-percent string, or null when the view suppressed it. */
export function premiumReplyRateLabel(signal: PremiumIntelligenceSignal | null): string | null {
  if (!signal || typeof signal.replyRate !== "number") return null;
  return `${Math.round(signal.replyRate * 100)}%`;
}

/** A band, never an hour count — "83.6 hours" is false precision. */
export function replyTimeBandLabel(band: string | null): string | null {
  if (!band) return null;
  return REPLY_TIME_LABEL[band] ?? null;
}

export function recentActivityBandLabel(band: string | null): string | null {
  if (!band) return null;
  return RECENT_ACTIVITY_LABEL[band] ?? null;
}

/** Human labels for observed collaboration types; unknown codes are dropped. */
export function collaborationTypeLabels(types: readonly string[] | null): string[] {
  if (!types) return [];
  return types.map((t) => COLLABORATION_TYPE_LABEL[t]).filter((t): t is string => Boolean(t));
}

/**
 * Sample context. Counts CREATORS, never pitches or replies — the owner's
 * position is that independent contributors are the useful denominator and raw
 * outreach counts are not for display.
 */
export function contributorSampleLabel(signal: PremiumIntelligenceSignal | null): string | null {
  const n = signal?.contributorCount;
  if (typeof n !== "number" || n <= 0) return null;
  return `Based on activity from ${n} creator${n === 1 ? "" : "s"}`;
}
