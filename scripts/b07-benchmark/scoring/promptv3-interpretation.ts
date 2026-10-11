/**
 * Interpretation helper — combines Experiment 1 (`promptv3-comparator.ts`)
 * and Experiment 2 (`promptv3-generalization-score.ts`) results into ONE of
 * the three broad conclusions the round's task spec defines, verbatim:
 *
 *   A — PROMPT-LIMITED EVIDENCE
 *   B — MODEL-LIMITED EVIDENCE
 *   C — OVERFIT / INCONCLUSIVE
 *
 * This is a GENUINE FUNCTION of whatever the two experiments' results turn
 * out to be — nothing here is a hardcoded conclusion. Phase 1 (this round)
 * never calls this against real results, because no Prompt-v3 provider call
 * has been made yet; Phase 2 calls it against the real Experiment 1/2 output.
 *
 * ONE DOCUMENTED JUDGEMENT CALL (not a new product decision — a literal
 * reading of the task's own prose, which itself acknowledges some overlap
 * between B and C): the task states BOTH that MODEL-LIMITED covers "analogous
 * failures recur on the blind generalization set" AND that OVERFIT/
 * INCONCLUSIVE covers "fixes known original cases but fails analogous NEW
 * blind cases" — the same underlying observation. This module resolves the
 * overlap the same way the task's own examples are ordered (A's conditions
 * first, then B, then C): if the known holdout failures are NOT fully fixed,
 * or a new critical regression appeared on the holdout, that is MODEL-LIMITED
 * regardless of how the generalization set went (the model still fails even
 * when explicitly told the rule, on cases it has already seen). Only when the
 * holdout side is clean (known violations all fixed, zero new regressions)
 * does generalization-set performance decide between PROMPT-LIMITED (strong)
 * and OVERFIT/INCONCLUSIVE (weak) — i.e. "fixes known cases but fails
 * analogous new ones" is scoped to exactly the cases where the holdout side
 * was otherwise clean. A product owner who wants a different resolution of
 * this ambiguity can adjust `resolvePromptV3Interpretation` directly; nothing
 * about the underlying computed metrics changes.
 *
 * "Strongly" (task's own word, otherwise undefined) is operationalised as two
 * explicit, adjustable constants below, never silently assumed.
 */
import type { PromptV3GeneralizationScore } from "./promptv3-generalization-score";

/**
 * Minimal structural input this module actually needs from Experiment 1 —
 * exactly `PromptV3HoldoutComparison["main_holdout"]`'s own shape, so a
 * caller can pass that field directly, and a test can construct a tiny
 * literal instead of an entire `PromptV3HoldoutComparison` (which itself
 * embeds two full `CandidateScoreV2`s it does not need for this decision).
 */
export interface HoldoutSideSummary {
  known_violations_fixed_count: number;
  known_violations_total_count: number;
  new_regressions_count: number;
}

/** Minimal structural input this module needs from Experiment 2. See `summarizeGeneralizationForInterpretation`. */
export interface GeneralizationSideSummary {
  conservative_critical_violations_total: number;
  contrast_fully_correct_rate: number;
  overall_fully_correct_rate: number;
  n: number;
  conservative_n: number;
}

/** Builds the minimal `GeneralizationSideSummary` this module needs from a full `PromptV3GeneralizationScore`. */
export function summarizeGeneralizationForInterpretation(
  score: PromptV3GeneralizationScore,
): GeneralizationSideSummary {
  return {
    conservative_critical_violations_total: score.conservative.critical_violations_total,
    contrast_fully_correct_rate: score.contrast.fully_correct_rate,
    overall_fully_correct_rate: score.overall.fully_correct_rate,
    n: score.n,
    conservative_n: score.conservative.n,
  };
}

export const PROMPT_V3_INTERPRETATIONS = [
  "PROMPT_LIMITED_EVIDENCE",
  "MODEL_LIMITED_EVIDENCE",
  "OVERFIT_INCONCLUSIVE",
] as const;
export type PromptV3Interpretation = (typeof PROMPT_V3_INTERPRETATIONS)[number];

/**
 * This round's explicit bar for "performs strongly on the NEW blind
 * challenge" (task's own word). A product owner may revise these before
 * Phase 2 applies this helper to real results — they are named constants,
 * not buried magic numbers.
 */
export const GENERALIZATION_STRONG_CONTRAST_ACCURACY_THRESHOLD = 0.8;
export const GENERALIZATION_STRONG_CONSERVATIVE_CRITICAL_VIOLATIONS_MAX = 0;
export const GENERALIZATION_STRONG_OVERALL_FULLY_CORRECT_THRESHOLD = 0.75;

export interface PromptV3InterpretationResult {
  interpretation: PromptV3Interpretation;
  headline: string;
  reasons: string[];
  metrics: {
    known_violations_fixed_count: number;
    known_violations_total_count: number;
    all_known_violations_fixed: boolean;
    new_holdout_regressions_count: number;
    holdout_side_clean: boolean;
    generalization_conservative_critical_violations: number;
    generalization_contrast_accuracy: number;
    generalization_overall_fully_correct_rate: number;
    generalization_performs_strongly: boolean;
  };
}

const HEADLINES: Record<PromptV3Interpretation, string> = {
  PROMPT_LIMITED_EVIDENCE:
    "EVIDENCE STRONGLY SUGGESTS SONNET'S V2 FAILURE WAS PRIMARILY INSTRUCTION/PROMPT LIMITED",
  MODEL_LIMITED_EVIDENCE: "EVIDENCE SUGGESTS A MODEL/CAPABILITY LIMITATION REMAINS",
  OVERFIT_INCONCLUSIVE:
    "PROMPT V3 FIXED KNOWN CASES BUT DID NOT GENERALIZE — POSTHOC OVERFIT / INCONCLUSIVE",
};

/**
 * Combine Experiment 1 + Experiment 2 into one interpretation bucket. Pure
 * function of its inputs — see the module doc for the one documented
 * judgement call resolving the task's own B/C wording overlap.
 */
export function resolvePromptV3Interpretation(
  holdoutSide: HoldoutSideSummary,
  generalizationSide: GeneralizationSideSummary,
): PromptV3InterpretationResult {
  const { known_violations_fixed_count, known_violations_total_count, new_regressions_count } =
    holdoutSide;
  const allKnownFixed = known_violations_fixed_count === known_violations_total_count;
  const holdoutSideClean = allKnownFixed && new_regressions_count === 0;

  const generalizationPerformsStrongly =
    generalizationSide.conservative_critical_violations_total <=
      GENERALIZATION_STRONG_CONSERVATIVE_CRITICAL_VIOLATIONS_MAX &&
    generalizationSide.contrast_fully_correct_rate >=
      GENERALIZATION_STRONG_CONTRAST_ACCURACY_THRESHOLD &&
    generalizationSide.overall_fully_correct_rate >=
      GENERALIZATION_STRONG_OVERALL_FULLY_CORRECT_THRESHOLD;

  const reasons: string[] = [];
  let interpretation: PromptV3Interpretation;

  if (!holdoutSideClean) {
    interpretation = "MODEL_LIMITED_EVIDENCE";
    if (!allKnownFixed) {
      reasons.push(
        `${known_violations_total_count - known_violations_fixed_count} of ${known_violations_total_count} known v2 critical violation(s) persist under prompt v3 despite explicit RULES E-J.`,
      );
    }
    if (new_regressions_count > 0) {
      reasons.push(
        `${new_regressions_count} NEW critical invariant violation(s) appeared under prompt v3 on the main holdout that were not violations under v2 — a material safety regression, never tolerated regardless of any other improvement.`,
      );
    }
  } else if (generalizationPerformsStrongly) {
    interpretation = "PROMPT_LIMITED_EVIDENCE";
    reasons.push(
      `All ${known_violations_total_count} known v2 critical violation(s) are fixed under prompt v3, with zero new holdout regressions.`,
      `The NEW blind generalization challenge (${generalizationSide.n} cases, never seen under v2) is performed strongly: ${generalizationSide.conservative_critical_violations_total} critical invariant violation(s) on the ${generalizationSide.conservative_n} conservative-answer cases, ${Math.round(generalizationSide.contrast_fully_correct_rate * 100)}% contrast-case accuracy, ${Math.round(generalizationSide.overall_fully_correct_rate * 100)}% overall accuracy.`,
    );
  } else {
    interpretation = "OVERFIT_INCONCLUSIVE";
    reasons.push(
      `All ${known_violations_total_count} known v2 critical violation(s) are fixed under prompt v3, with zero new holdout regressions.`,
      `However the NEW blind generalization challenge does NOT meet this round's "performs strongly" bar: ${generalizationSide.conservative_critical_violations_total} critical invariant violation(s) on conservative-answer cases (bar: <= ${GENERALIZATION_STRONG_CONSERVATIVE_CRITICAL_VIOLATIONS_MAX}), ${Math.round(generalizationSide.contrast_fully_correct_rate * 100)}% contrast-case accuracy (bar: >= ${Math.round(GENERALIZATION_STRONG_CONTRAST_ACCURACY_THRESHOLD * 100)}%), ${Math.round(generalizationSide.overall_fully_correct_rate * 100)}% overall accuracy (bar: >= ${Math.round(GENERALIZATION_STRONG_OVERALL_FULLY_CORRECT_THRESHOLD * 100)}%).`,
      "This suggests prompt v3 taught Sonnet to answer the SPECIFIC known cases correctly without generalizing the underlying conservative-reasoning rule to novel instances.",
    );
  }

  return {
    interpretation,
    headline: HEADLINES[interpretation],
    reasons,
    metrics: {
      known_violations_fixed_count,
      known_violations_total_count,
      all_known_violations_fixed: allKnownFixed,
      new_holdout_regressions_count: new_regressions_count,
      holdout_side_clean: holdoutSideClean,
      generalization_conservative_critical_violations:
        generalizationSide.conservative_critical_violations_total,
      generalization_contrast_accuracy: generalizationSide.contrast_fully_correct_rate,
      generalization_overall_fully_correct_rate: generalizationSide.overall_fully_correct_rate,
      generalization_performs_strongly: generalizationPerformsStrongly,
    },
  };
}
