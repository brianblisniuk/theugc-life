/**
 * Single typed configuration source for product limits, pricing hypotheses, and
 * intelligence confidence thresholds.
 *
 * PERMISSIONS.md §14 and PRD §5.1 require these to be configuration-driven, not
 * scattered literals in UI/business logic. Every value here is a documented
 * hypothesis from the PRD; none is invented. Runtime editability without a code
 * deploy (DB-backed pricing/limits) is a later-sprint concern — Sprint 0 only
 * establishes the typed source of truth so future sprints read from one place.
 *
 * These are NOT authorization. Entitlement/ownership is enforced server-side via
 * RLS and helper functions (see PERMISSIONS.md). Limits below are business rules
 * layered on top of that, enforced transactionally server-side when the relevant
 * CRM features land.
 */

/** Free plan workspace limits (PRD §5.1). */
export const FREE_LIMITS = {
  savedHotels: 10,
  activePipelineItems: 5,
  activeTrips: 1,
} as const;

/**
 * V1 commercial terms (PRD §5.2, §5.3 / DECISIONS D051, D052).
 * Amounts are in the smallest currency unit's whole-dollar value (USD).
 *
 * These are FIXED V1 terms, not hypotheses — what remains to be measured is
 * conversion at these numbers, not the numbers themselves. They stay in typed
 * config so no surface hardcodes them and so they can move without a code
 * change to business logic.
 */
export const PRICING = {
  destinationPass: {
    // D051: USD 39 / 30 days / one destination. The earlier 90-day figure
    // (D024) was superseded — pitching one trip is a weeks-long task, and a
    // quarter of idle access weakened the upgrade path to Pro.
    priceUsd: 39,
    durationDays: 30,
  },
  pro: {
    // D052: USD 199/year is the fixed V1 launch price, worldwide.
    // The 299 reference and 249 later prices remain future hypotheses (D005).
    referencePriceUsd: 299,
    launchPriceUsd: 199,
    laterPriceUsd: 249,
    durationDays: 365,
  },
} as const;

/**
 * Intelligence confidence thresholds (PRD §12.6 / DECISIONS D012).
 * Number of qualifying observations required to reach each confidence band.
 * Used by later-sprint intelligence display gating.
 */
export const CONFIDENCE_THRESHOLDS = {
  insufficientMax: 4, // 0–4 observations
  emergingMax: 14, // 5–14
  moderateMax: 49, // 15–49
  // 50+ => strong
} as const;

export type ConfidenceLevel = "insufficient" | "emerging" | "moderate" | "strong";

/** Derive a confidence band from an observation count. */
export function confidenceForObservations(count: number): ConfidenceLevel {
  if (count <= CONFIDENCE_THRESHOLDS.insufficientMax) return "insufficient";
  if (count <= CONFIDENCE_THRESHOLDS.emergingMax) return "emerging";
  if (count <= CONFIDENCE_THRESHOLDS.moderateMax) return "moderate";
  return "strong";
}
