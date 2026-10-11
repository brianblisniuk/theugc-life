/**
 * Acceptable-answer-set primitives, shared by every scoring-v2 field builder.
 *
 * These are the ONLY functions in the codebase allowed to reason about
 * "acceptable alternatives", and they never look at what a candidate
 * predicted to decide what counts as a class or as a strict case — that
 * decision is 100% corpus-derived (finding 3 of the correction round). What a
 * candidate predicted is used ONLY to decide whether that one case is
 * "correct", never to decide which class a case's gold belongs to.
 */
import { canonicalizeSignals, signalSetKey } from "../taxonomy";

/**
 * The full set of D072-acceptable distinct values for one field on one case:
 * the primary gold plus every declared acceptable alternative. Corpus-only —
 * takes no prediction.
 */
export function acceptableValueSet(
  primary: string,
  acceptable: readonly string[] | undefined,
): Set<string> {
  return new Set([primary, ...(acceptable ?? [])]);
}

/**
 * A case is STRICT for a single-label field when D072 genuinely permits only
 * one honest answer for it — i.e. the acceptable-value set collapses to
 * exactly one distinct value. A declared `acceptable` array that only ever
 * repeats the primary value (a redundant declaration) is still strict; only a
 * GENUINE second value excludes the case from strict per-class scoring.
 */
export function isStrictSingleLabel(
  primary: string,
  acceptable: readonly string[] | undefined,
): boolean {
  return acceptableValueSet(primary, acceptable).size === 1;
}

/**
 * Family A correctness for a single-label field: correct iff the prediction
 * equals the primary gold OR is inside the declared acceptable set. This is
 * the ENTIRE acceptable-answer-accuracy contract — it mutates nothing, it
 * returns a boolean, and it is evaluated identically for every candidate.
 */
export function isAcceptableCorrect(
  primary: string,
  acceptable: readonly string[] | undefined,
  predicted: string | null,
): boolean {
  if (predicted === null) return false;
  return acceptableValueSet(primary, acceptable).has(predicted);
}

/** Canonical signal-set keys standing in for each of a case's acceptable answers. */
export function acceptableSignalSetKeys(
  primary: readonly string[],
  acceptable: readonly (readonly string[])[] | undefined,
): Set<string> {
  const keys = new Set<string>([signalSetKey(primary)]);
  for (const alt of acceptable ?? []) keys.add(signalSetKey(alt));
  return keys;
}

/** Signal-set analogue of `isStrictSingleLabel`. */
export function isStrictSignalSet(
  primary: readonly string[],
  acceptable: readonly (readonly string[])[] | undefined,
): boolean {
  return acceptableSignalSetKeys(primary, acceptable).size === 1;
}

/** Signal-set analogue of `isAcceptableCorrect` — exact-set membership. */
export function isAcceptableCorrectSignals(
  primary: readonly string[],
  acceptable: readonly (readonly string[])[] | undefined,
  predicted: readonly string[] | null,
): boolean {
  if (predicted === null) return false;
  return acceptableSignalSetKeys(primary, acceptable).has(signalSetKey(predicted));
}

/** Canonicalised primary signal set — never rewritten to match a prediction. */
export function primarySignals(primary: readonly string[]): string[] {
  return canonicalizeSignals(primary);
}
