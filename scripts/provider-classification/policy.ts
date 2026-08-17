/**
 * Reviewed provider classification policies (D066).
 *
 * A provider observation is source evidence and never canonical (D065). What
 * turns a provider code into a canonical classification is a policy WE reviewed
 * — once per provider/field/code, not once per property — and this module is
 * where those policies live.
 *
 * Pure and offline: a lookup table plus a lookup. No database, no network, no
 * resolver. The star-resolution layer that will consume this is a future block;
 * the product contract it implements against is
 * `docs/PROPERTY_SOURCE_CLASSIFICATION_POLICY.md`.
 */
import type { StarEligibility } from "../provider-evaluation/types";

export type { StarEligibility };

export interface ClassificationPolicy {
  provider: string;
  /**
   * Version of the reviewed mapping. A resolution must be able to name the
   * policy that produced it, so changing any mapping is a NEW version.
   */
  version: string;
  /** The provider field the policy reads. Anything else is out of contract. */
  field: string;
  /**
   * Codes with reviewed semantics. A code that is absent is `unresolved` — the
   * table is deliberately an allow-list, so a provider adding a code we have
   * never seen cannot silently acquire a meaning.
   */
  mappings: Readonly<Record<string, StarEligibility>>;
  /** Why this policy exists in this shape, for the reviewer reading it later. */
  notes: string;
}

/**
 * Resolve one code through a policy.
 *
 * Everything unknown is `unresolved`, which means REVIEW — and is explicitly not
 * the same fact as "below scope" (D061 §9).
 */
export function classifyProviderCode(
  policy: ClassificationPolicy,
  code: string | null | undefined,
): StarEligibility {
  if (code === null || code === undefined) return "unresolved";
  const trimmed = code.trim();
  if (trimmed === "") return "unresolved";
  return policy.mappings[trimmed] ?? "unresolved";
}

/** Does this outcome put a property inside V1 scope? Exactly 4 or exactly 5. */
export function isV1Eligible(outcome: StarEligibility): boolean {
  return outcome === "exact_four" || outcome === "exact_five";
}

/**
 * Combine a NEW approved observation with an ALREADY RESOLVED classification.
 *
 * D066's second-source rule, and the reason it is a function rather than a
 * comment: agreement corroborates, disagreement goes to REVIEW, and nothing
 * averages. There is no arithmetic here at all, which is the point — 4 and 5
 * cannot produce 4.5 because no code path can add them.
 *
 * This is EXCEPTION HANDLING. A second source is never required to classify a
 * property in the first place.
 */
export type ConflictOutcome =
  | { state: "corroborated"; value: StarEligibility }
  | { state: "conflict"; existing: StarEligibility; incoming: StarEligibility }
  | { state: "no_change"; value: StarEligibility };

export function reconcile(existing: StarEligibility, incoming: StarEligibility): ConflictOutcome {
  // An unresolved incoming observation tells us nothing; it cannot unset a
  // resolved value, and it cannot manufacture a conflict.
  if (incoming === "unresolved") return { state: "no_change", value: existing };
  if (existing === "unresolved") return { state: "corroborated", value: incoming };
  if (existing === incoming) return { state: "corroborated", value: existing };
  // Two approved sources disagree. The canonical value is NOT flipped and NOT
  // averaged: it goes to a human, per D066.
  return { state: "conflict", existing, incoming };
}
