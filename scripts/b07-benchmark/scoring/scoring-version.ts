/**
 * Scoring-policy identity.
 *
 * `scoring_version` is a DOWNSTREAM INTERPRETATION of inference evidence, not
 * part of inference identity (that remains corpus/prompt/schema/model/
 * inference-config/case-evidence — see `run/types.ts`). Changing how we score
 * a fixed set of raw provider predictions never invalidates those
 * predictions; it produces a differently-versioned report over the SAME
 * evidence. This file exists so that fact is structural, not a comment: every
 * v2 score/report artifact stamps `SCORING_VERSION_V2`, every v1 one stamps
 * `SCORING_VERSION_V1`, and nothing downstream may treat one as the other.
 *
 * EXTERNAL AUDIT FINDING (2026-09, this round): `scoring/score.ts`'s
 * `effectiveGold()` / `effectiveGoldSignals()` rewrite the GOLD value fed into
 * the confusion matrix to match whichever acceptable alternative a candidate
 * predicted. That makes per-class gold SUPPORT a function of the candidate's
 * own prediction — two candidates scored against the identical corpus case
 * can contribute that case to two different classes' support, so their
 * confusion matrices are not drawn from one fixed target distribution and
 * macro F1 across candidates is not comparable. `scoring/score.ts` (v1) is
 * PRESERVED UNCHANGED — old reports must remain reproducible exactly as
 * computed — and `scoring/score-v2.ts` implements the fix: acceptable-answer
 * correctness is scored as its own metric family over ALL cases, and strict
 * per-class/per-label precision/recall/F1 is computed only over cases whose
 * gold is single-valued for that field, always using the untouched primary
 * gold value. See `docs/evaluations/B07_INFERENCE_BENCHMARK_RUN_2026-09.md`
 * for the full audit narrative.
 */

export const SCORING_VERSION_V1 = "b07_benchmark_scoring_v1" as const;
export const SCORING_VERSION_V2 = "b07_benchmark_scoring_v2" as const;

export type ScoringVersion = typeof SCORING_VERSION_V1 | typeof SCORING_VERSION_V2;
