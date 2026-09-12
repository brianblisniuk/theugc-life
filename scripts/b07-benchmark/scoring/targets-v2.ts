/**
 * Scoring-v2 quality-target evaluation, Stage-1 disposition and the
 * Stage-2 holdout-support preflight.
 *
 * TRI-STATE, not boolean: a macro/micro-F1 target is only HARD-EVALUABLE when
 * every taxonomy class/label that actually appears in the corpus (full,
 * corpus-derived support — never candidate-derived) also has enough STRICT
 * gold support (`>= MIN_RELIABLE_CLASS_SUPPORT`) to make its contribution to
 * the metric a reliable read rather than a single-case coin flip. Below that,
 * the target is `insufficient_support` — never a fabricated PASS, never a
 * punitive FAIL. The `0.90`/`0.95` thresholds themselves are UNCHANGED from
 * `scoring/targets.ts` (v1) — this file only changes what the metric fed into
 * the comparison means and whether the comparison may be made at all.
 */
import { CORPUS_VERSION, type CorpusCase } from "../corpus/schema";
import { DISPOSITIONS, SIGNALS } from "../taxonomy";
import { isStrictSignalSet, isStrictSingleLabel } from "./acceptable";
import { MIN_RELIABLE_CLASS_SUPPORT } from "./metrics";
import {
  fullCorpusSignalSupport,
  fullCorpusSupport,
  type CandidateScoreV2,
  type SignalFieldScoreV2,
  type SingleLabelFieldScoreV2,
} from "./score-v2";
import { QUALITY_TARGETS } from "./targets";

export const TARGET_STATES = ["pass", "fail", "insufficient_support"] as const;
export type TargetState = (typeof TARGET_STATES)[number];

export interface TargetResultV2 {
  key: string;
  label: string;
  state: TargetState;
  threshold: number | null;
  value: number | null;
  detail: string;
}

/**
 * Which classes/labels are "expected to participate" in a hard gate: every
 * value with NONZERO support in the full (unfiltered) case set. A class that
 * never appears in the corpus at all is not this benchmark's problem to
 * resolve with more data — it simply cannot occur, so it is not counted
 * against sufficiency (same convention `macro_f1_supported_classes` already
 * uses in v1's metric primitives).
 */
function classSupportSufficiency(
  requiredClasses: readonly string[],
  fullSupport: Readonly<Record<string, number>>,
  strictSupport: Readonly<Record<string, number>>,
): { sufficient: boolean; insufficientClasses: string[] } {
  const insufficient = requiredClasses.filter(
    (cls) => (fullSupport[cls] ?? 0) > 0 && (strictSupport[cls] ?? 0) < MIN_RELIABLE_CLASS_SUPPORT,
  );
  return { sufficient: insufficient.length === 0, insufficientClasses: insufficient };
}

function evaluateStrictMacroF1Target(
  key: string,
  label: string,
  threshold: number,
  classes: readonly string[],
  field: SingleLabelFieldScoreV2,
  fullSupport: Readonly<Record<string, number>>,
): TargetResultV2 {
  const strictSupport = Object.fromEntries(
    classes.map((c) => [c, field.strict.per_class[c]?.support ?? 0]),
  );
  const { sufficient, insufficientClasses } = classSupportSufficiency(
    classes,
    fullSupport,
    strictSupport,
  );
  const value = field.strict.macro_f1;
  if (!sufficient) {
    return {
      key,
      label,
      state: "insufficient_support",
      threshold,
      value,
      detail: `insufficient strict gold support (< ${MIN_RELIABLE_CLASS_SUPPORT}) for class(es): ${insufficientClasses.join(", ")} (strict n=${field.strict.n}, excluded multi-answer cases=${field.strict.excluded_multi_answer_cases}; strict macro F1=${value} is NOT a hard PASS/FAIL basis until every participating class clears the support floor)`,
    };
  }
  return {
    key,
    label,
    state: value >= threshold ? "pass" : "fail",
    threshold,
    value,
    detail: `strict macro F1 ${value} ${value >= threshold ? ">=" : "<"} ${threshold} (strict n=${field.strict.n}, excluded multi-answer cases=${field.strict.excluded_multi_answer_cases}, every participating class >= ${MIN_RELIABLE_CLASS_SUPPORT} strict support)`,
  };
}

function evaluateStrictSignalMicroF1Target(
  threshold: number,
  labels: readonly string[],
  field: SignalFieldScoreV2,
  fullSupport: Readonly<Record<string, number>>,
): TargetResultV2 {
  const strictSupport = Object.fromEntries(
    labels.map((l) => [l, field.strict.per_label[l]?.support ?? 0]),
  );
  const { sufficient, insufficientClasses } = classSupportSufficiency(
    labels,
    fullSupport,
    strictSupport,
  );
  const value = field.strict.micro.f1;
  if (!sufficient) {
    return {
      key: "signal_micro_f1",
      label: "signal micro F1",
      state: "insufficient_support",
      threshold,
      value,
      detail: `insufficient strict gold support (< ${MIN_RELIABLE_CLASS_SUPPORT}) for signal label(s): ${insufficientClasses.join(", ")} (strict n=${field.strict.n}, excluded multi-answer cases=${field.strict.excluded_multi_answer_cases})`,
    };
  }
  return {
    key: "signal_micro_f1",
    label: "signal micro F1",
    state: value >= threshold ? "pass" : "fail",
    threshold,
    value,
    detail: `strict micro F1 ${value} ${value >= threshold ? ">=" : "<"} ${threshold} (strict n=${field.strict.n}, excluded multi-answer cases=${field.strict.excluded_multi_answer_cases})`,
  };
}

/**
 * Family-A (acceptable-answer) accuracy target: candidate-independent
 * denominator (`n` = case count), always hard-evaluable — no per-class
 * support question arises because this is not a per-class metric.
 */
function evaluateAcceptableAccuracyTarget(
  key: string,
  label: string,
  threshold: number,
  field: SingleLabelFieldScoreV2,
): TargetResultV2 {
  const value = field.acceptable_answer.accuracy;
  return {
    key,
    label,
    state: value >= threshold ? "pass" : "fail",
    threshold,
    value,
    detail: `acceptable-answer accuracy ${value} over n=${field.acceptable_answer.n} (every case, candidate-independent support)`,
  };
}

function evaluateRateTarget(
  key: string,
  label: string,
  threshold: number,
  value: number,
  comparison: ">=" | "=",
): TargetResultV2 {
  const pass = comparison === ">=" ? value >= threshold : value === threshold;
  return {
    key,
    label,
    state: pass ? "pass" : "fail",
    threshold,
    value,
    detail: `${(value * 100).toFixed(1)}% ${comparison} ${(threshold * 100).toFixed(1)}%`,
  };
}

export const STAGE1_STATUSES = [
  "no_evidence",
  "eliminated_invalidated",
  "eliminated_critical_safety",
  "eliminated_quality_target_fail",
  "stage1_finalist",
  "stage1_finalist_with_unresolved_quality_target",
] as const;
export type Stage1Status = (typeof STAGE1_STATUSES)[number];

export interface CandidateEvaluationV2 {
  candidate_id: string;
  scoring_version: CandidateScoreV2["scoring_version"];
  hasEvidence: boolean;
  invalidated_reason: string | null;
  criticalViolations: number;
  passesCriticalGate: boolean;
  targets: TargetResultV2[];
  status: Stage1Status;
  /**
   * `true` only when `status` is `stage1_finalist` or
   * `stage1_finalist_with_unresolved_quality_target` — a Stage-1 finalist is
   * NEVER a production/vendor winner on its own (round requirement 10/11).
   */
  isStage1Finalist: boolean;
  eliminationReasons: string[];
}

/**
 * A candidate may become a Stage-1 finalist ONLY when: (1) it has complete
 * Stage-1 evidence; (2) zero critical invariant violations; (3) every
 * statistically evaluable quality target passes; (4) any unresolved target
 * is unresolved ONLY because of insufficient support, never an observed
 * failure. Haiku (two genuine critical violations, per the locked evidence)
 * cannot pass step 2 under any scoring methodology — this function applies
 * the identical rule to every candidate_id, hard-coding none of them.
 */
export function evaluateCandidateV2(score: CandidateScoreV2): CandidateEvaluationV2 {
  const hasEvidence = score.reliability.cases_attempted > 0;
  const base = {
    candidate_id: score.candidate_id,
    scoring_version: score.scoring_version,
    hasEvidence,
    criticalViolations: score.critical_suite.violations,
    passesCriticalGate: score.critical_suite.passes_hard_gate,
  };

  if (score.invalidated_reason) {
    return {
      ...base,
      invalidated_reason: score.invalidated_reason,
      targets: [],
      status: "eliminated_invalidated",
      isStage1Finalist: false,
      eliminationReasons: [score.invalidated_reason],
    };
  }

  if (!hasEvidence) {
    return {
      ...base,
      invalidated_reason: null,
      targets: [],
      status: "no_evidence",
      isStage1Finalist: false,
      eliminationReasons: ["no cases were attempted — no evidence exists for this candidate"],
    };
  }

  if (
    !score.critical_suite.passes_hard_gate ||
    score.critical_suite.violations > QUALITY_TARGETS.criticalViolations
  ) {
    return {
      ...base,
      invalidated_reason: null,
      targets: [],
      status: "eliminated_critical_safety",
      isStage1Finalist: false,
      eliminationReasons: [
        `${score.critical_suite.violations} critical invariant violation(s) evaluated=${score.critical_suite.cases_evaluated}/${score.critical_suite.cases} — the critical-safety hard gate is never relaxed by a scoring-methodology change, and applies identically to every candidate`,
      ],
    };
  }

  const targets: TargetResultV2[] = [
    evaluateRateTarget(
      "first_pass_schema_valid_rate",
      "first-pass structured output",
      QUALITY_TARGETS.firstPassSchemaValidRate,
      score.reliability.first_pass_schema_valid_rate,
      ">=",
    ),
    evaluateRateTarget(
      "final_schema_valid_rate",
      "final structured output",
      QUALITY_TARGETS.finalSchemaValidRate,
      score.reliability.final_schema_valid_rate,
      "=",
    ),
  ];

  if (score.message_task) {
    targets.push(
      evaluateStrictMacroF1Target(
        "disposition_macro_f1",
        "disposition macro F1 (strict)",
        QUALITY_TARGETS.dispositionMacroF1,
        DISPOSITIONS,
        score.message_task.disposition,
        score.message_task.disposition_full_support,
      ),
    );
    targets.push(
      evaluateStrictSignalMicroF1Target(
        QUALITY_TARGETS.signalMicroF1,
        SIGNALS,
        score.message_task.signals,
        score.message_task.signals_full_support,
      ),
    );
  }

  if (score.thread_task) {
    targets.push(
      evaluateAcceptableAccuracyTarget(
        "thread_state_accuracy",
        "thread-state accuracy (acceptable-answer)",
        QUALITY_TARGETS.threadStateAccuracy,
        score.thread_task.thread_state,
      ),
    );
    targets.push(
      evaluateAcceptableAccuracyTarget(
        "compensation_accuracy",
        "compensation accuracy (acceptable-answer)",
        QUALITY_TARGETS.compensationAccuracy,
        score.thread_task.compensation_structure,
      ),
    );
    if (score.thread_task.unknown_predicted_as_unpaid > 0) {
      targets.push({
        key: "unknown_not_unpaid",
        label: "unknown->unpaid compensation collapse",
        state: "fail",
        threshold: 0,
        value: score.thread_task.unknown_predicted_as_unpaid,
        detail: `${score.thread_task.unknown_predicted_as_unpaid} case(s) — D072 §8 forbids this collapse unconditionally`,
      });
    }
  }

  const failed = targets.filter((t) => t.state === "fail");
  const insufficient = targets.filter((t) => t.state === "insufficient_support");

  if (failed.length > 0) {
    return {
      ...base,
      invalidated_reason: null,
      targets,
      status: "eliminated_quality_target_fail",
      isStage1Finalist: false,
      eliminationReasons: failed.map((t) => `${t.label}: ${t.detail}`),
    };
  }

  if (insufficient.length > 0) {
    return {
      ...base,
      invalidated_reason: null,
      targets,
      status: "stage1_finalist_with_unresolved_quality_target",
      isStage1Finalist: true,
      eliminationReasons: [],
    };
  }

  return {
    ...base,
    invalidated_reason: null,
    targets,
    status: "stage1_finalist",
    isStage1Finalist: true,
    eliminationReasons: [],
  };
}

// ---------------------------------------------------------------------------
// Stage-2 holdout-support preflight — LOCKED CONTRACT, NOT EXERCISED THIS ROUND.
// ---------------------------------------------------------------------------

export interface HoldoutPreflightReport {
  corpus_version: string;
  n_message: number;
  n_thread: number;
  disposition_full_support: Record<string, number>;
  disposition_strict_support: Record<string, number>;
  disposition_insufficient_classes: string[];
  signals_full_support: Record<string, number>;
  signals_strict_support: Record<string, number>;
  signals_insufficient_labels: string[];
  /** key -> whether the frozen holdout can resolve that quality target. */
  resolvable: Record<string, boolean>;
}

/**
 * Computes STRICT and full per-class/per-label gold support from the
 * HOLDOUT corpus alone. Takes `CorpusCase[]` and returns arithmetic over
 * their own `expected`/`acceptable` fields — it has no parameter through
 * which a model prediction could enter, so it performs, and can perform,
 * ZERO provider calls (acceptance test: "holdout-support preflight performs
 * ZERO provider calls").
 */
export function holdoutSupportPreflight(cases: readonly CorpusCase[]): HoldoutPreflightReport {
  const messageCases = cases.filter(
    (c): c is Extract<CorpusCase, { task: "message" }> => c.task === "message",
  );
  const threadCases = cases.filter(
    (c): c is Extract<CorpusCase, { task: "thread" }> => c.task === "thread",
  );

  const dispositionFull = fullCorpusSupport(messageCases.map((c) => c.expected.disposition));
  const dispositionStrict = fullCorpusSupport(
    messageCases
      .filter((c) => isStrictSingleLabel(c.expected.disposition, c.acceptable?.disposition))
      .map((c) => c.expected.disposition),
  );
  const dispositionCheck = classSupportSufficiency(
    DISPOSITIONS,
    dispositionFull,
    dispositionStrict,
  );

  const signalsFull = fullCorpusSignalSupport(messageCases.map((c) => c.expected.signals));
  const signalsStrict = fullCorpusSignalSupport(
    messageCases
      .filter((c) => isStrictSignalSet(c.expected.signals, c.acceptable?.signals))
      .map((c) => c.expected.signals),
  );
  const signalsCheck = classSupportSufficiency(SIGNALS, signalsFull, signalsStrict);

  // Thread-state/compensation quality targets use acceptable-answer accuracy
  // (Family A), which is always hard-evaluable over all n — no support gate
  // is needed for them, so they are intentionally absent from `resolvable`.

  return {
    corpus_version: CORPUS_VERSION,
    n_message: messageCases.length,
    n_thread: threadCases.length,
    disposition_full_support: dispositionFull,
    disposition_strict_support: dispositionStrict,
    disposition_insufficient_classes: dispositionCheck.insufficientClasses,
    signals_full_support: signalsFull,
    signals_strict_support: signalsStrict,
    signals_insufficient_labels: signalsCheck.insufficientClasses,
    resolvable: {
      disposition_macro_f1: dispositionCheck.sufficient,
      signal_micro_f1: signalsCheck.sufficient,
    },
  };
}

/**
 * Given the preflight report and the set of quality-target keys that Stage 1
 * left `insufficient_support` (from `evaluateCandidateV2`, union across every
 * Stage-1 finalist), returns whether the frozen holdout is even CAPABLE of
 * resolving them, using metadata only. Called BEFORE any Stage-2 provider
 * call is made; the caller (`cli.ts`) must refuse to proceed when
 * `canResolve` is false and report `HOLDOUT_INSUFFICIENT_TO_RESOLVE_TARGET`.
 */
export function checkHoldoutCanResolve(
  preflight: HoldoutPreflightReport,
  unresolvedTargetKeys: readonly string[],
): { canResolve: boolean; blockingTargets: string[] } {
  const blocking = unresolvedTargetKeys.filter((key) => preflight.resolvable[key] === false);
  return { canResolve: blocking.length === 0, blockingTargets: blocking };
}
