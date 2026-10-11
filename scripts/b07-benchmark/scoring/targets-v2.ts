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
import {
  loadSupplementalAmbiguityPack,
  supplementalPackManifest,
  type SupplementalCase,
} from "../corpus/supplemental-ambiguity-pack";
import { DISPOSITIONS, SIGNALS } from "../taxonomy";
import { isStrictSignalSet, isStrictSingleLabel } from "./acceptable";
import { combineConfusionRecords, MIN_RELIABLE_CLASS_SUPPORT } from "./metrics";
import {
  fullCorpusSignalSupport,
  fullCorpusSupport,
  type CandidateScoreV2,
  type SignalFieldScoreV2,
  type SingleLabelFieldScoreV2,
  type StrictSingleLabelReport,
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

/**
 * CORRECTED (Stage-2 statistical closure round) global signal micro-F1
 * sufficiency rule.
 *
 * OLD RULE (over-constrained — external audit finding): reused the exact same
 * per-class `classSupportSufficiency` gate macro-F1 needs, requiring EVERY
 * signal label with any full-corpus support to independently clear
 * `>= MIN_RELIABLE_CLASS_SUPPORT` STRICT support before the metric could be
 * hard-evaluated at all. That rule is right for a MACRO average (each class
 * gets equal top-level weight, so one support-1 class can dominate the
 * aggregate's interpretation) but wrong for a MICRO average: micro-F1
 * aggregates true/false positives/negatives GLOBALLY across every strict
 * label decision, so a rare label contributes only its own (small) share of
 * that global count — it does not get outsized weight the way it would in a
 * per-class mean, and one rare label's thin support does not, by itself, make
 * the GLOBAL statistic unreliable.
 *
 * CORRECTED RULE: the global signal micro-F1 target is `insufficient_support`
 * if, and ONLY if, the strict signal-evaluation set cannot produce any
 * evaluable label decision at all — i.e. either (a) zero cases are strict for
 * signals (`field.strict.n === 0`), or (b) the strict set is non-empty but
 * every strict case's gold signal set is empty, so there is no gold-positive
 * label instance anywhere to score against (`tp + fn === 0`). Otherwise the
 * ordinary, UNCHANGED `>= 0.90` threshold is applied directly to the global
 * strict micro F1 — no per-label minimum blocks it. Individual labels below
 * `MIN_RELIABLE_CLASS_SUPPORT` are still reported (never hidden) as
 * TAXONOMY-COVERAGE limitations in the detail string, and the report layer
 * flags them — they are simply never treated as an automatic block on the
 * global metric, and never used alone as a provider-selection gate.
 */
function evaluateStrictSignalMicroF1Target(
  threshold: number,
  labels: readonly string[],
  field: SignalFieldScoreV2,
  fullSupport: Readonly<Record<string, number>>,
): TargetResultV2 {
  const strictN = field.strict.n;
  const goldLabelDecisions = field.strict.micro.tp + field.strict.micro.fn;
  const sufficient = strictN > 0 && goldLabelDecisions > 0;

  const lowSupportLabels = labels.filter((l) => {
    const support = field.strict.per_label[l]?.support ?? 0;
    return support > 0 && support < MIN_RELIABLE_CLASS_SUPPORT;
  });
  const zeroStrictSupportLabels = labels.filter((l) => {
    const strictSupport = field.strict.per_label[l]?.support ?? 0;
    return (fullSupport[l] ?? 0) > 0 && strictSupport === 0;
  });
  const coverageNote = `taxonomy-coverage (descriptive, NOT a block on the global metric): low-strict-support label(s) < ${MIN_RELIABLE_CLASS_SUPPORT}: ${lowSupportLabels.join(", ") || "none"}; zero-strict-support label(s) that do appear in the full corpus: ${zeroStrictSupportLabels.join(", ") || "none"} — their individual P/R/F1 is not an individually reliable read and must never be used alone as a provider-selection gate`;

  const value = field.strict.micro.f1;
  if (!sufficient) {
    return {
      key: "signal_micro_f1",
      label: "signal micro F1",
      state: "insufficient_support",
      threshold,
      value,
      detail: `the strict signal-evaluation set has no evaluable basis (strict n=${strictN}, gold label decisions=${goldLabelDecisions}, excluded multi-answer cases=${field.strict.excluded_multi_answer_cases}) — this is the ONLY condition that makes global signal micro F1 insufficient_support; individual rare/zero-support labels never do so on their own. ${coverageNote}`,
    };
  }
  return {
    key: "signal_micro_f1",
    label: "signal micro F1",
    state: value >= threshold ? "pass" : "fail",
    threshold,
    value,
    detail: `strict micro F1 ${value} ${value >= threshold ? ">=" : "<"} ${threshold} (strict n=${strictN}, gold label decisions=${goldLabelDecisions}, excluded multi-answer cases=${field.strict.excluded_multi_answer_cases}). ${coverageNote}`,
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
// Stage-2 preflight v2 — LOCKED CONTRACT, NOT EXERCISED THIS ROUND (no
// provider is called anywhere below; every input is corpus/pack metadata).
//
// v2 (this round's correction, on top of the original holdout-only
// preflight): inspects the frozen 120-case main holdout PLUS the frozen
// `b07_disposition_ambiguity_support_v1` supplemental pack, and applies the
// corrected signal micro-F1 sufficiency rule. The two sources are combined
// ONLY for the one target the supplemental pack exists to complete
// (disposition macro F1) — signals are evaluated from the main holdout alone,
// exactly as before, since the pack must never be used to alter signal
// distribution (round requirement: "Do NOT add the supplemental ambiguity
// pack merely to alter the signal distribution").
// ---------------------------------------------------------------------------

export interface HoldoutPreflightReport {
  corpus_version: string;
  n_message: number;
  n_thread: number;

  /** Disposition support from the MAIN holdout alone (unchanged meaning from before this round). */
  disposition_full_support: Record<string, number>;
  disposition_strict_support: Record<string, number>;

  /** The frozen supplemental pack's own metadata, always present (never optional/undefined). */
  supplemental_pack: {
    pack_version: string;
    digest: string;
    created_at: string;
    declaration: string;
    case_ids: string[];
    language_distribution: Record<string, number>;
    /** Every supplemental case's disposition — always `{ ambiguous: size }` by construction. */
    strict_support: Record<string, number>;
  };

  /**
   * SUPPORT-COMPLETED disposition support: main holdout strict support PLUS
   * the supplemental pack's strict support, class by class. This — never the
   * main-holdout-only figures above — is what `disposition_insufficient_classes`
   * and `resolvable.disposition_macro_f1` are computed from, matching the
   * FINAL STAGE-2 EVALUATION CONTRACT (disposition macro F1 uses "STRICT
   * message disposition cases from original frozen holdout + the 6
   * strict-ambiguous supplemental cases").
   */
  disposition_support_completed: Record<string, number>;
  disposition_insufficient_classes: string[];

  /** Signals: MAIN HOLDOUT ONLY — the supplemental pack never touches this. */
  signals_full_support: Record<string, number>;
  signals_strict_support: Record<string, number>;
  signals_strict_n: number;
  /** Sum of strict per-label gold support — the global label-decision count the corrected rule keys off. */
  signals_strict_label_decisions: number;
  /** Reported for descriptive taxonomy coverage; NEVER individually blocks `resolvable.signal_micro_f1`. */
  signals_low_support_labels: string[];
  signals_zero_strict_support_labels: string[];

  /** key -> whether the combined holdout+pack evidence can resolve that quality target. */
  resolvable: Record<string, boolean>;
}

/**
 * Computes STRICT and full per-class/per-label gold support from the
 * HOLDOUT corpus, plus the frozen supplemental ambiguity pack. Takes only
 * `CorpusCase[]`/`SupplementalCase[]` and returns arithmetic over their own
 * `expected`/`acceptable` fields — there is no parameter through which a
 * model prediction could enter, so it performs, and can perform, ZERO
 * provider calls (acceptance test: "holdout-support preflight performs ZERO
 * provider calls"). `supplementalCases` defaults to the frozen pack loaded
 * from disk; a caller may pass a different array only for isolated testing
 * (e.g. a synthetic pack of a different size to prove the sufficiency
 * arithmetic), never to substitute a different pack for a real Stage-2 run.
 */
export function holdoutSupportPreflight(
  cases: readonly CorpusCase[],
  supplementalCases: readonly SupplementalCase[] = loadSupplementalAmbiguityPack(),
): HoldoutPreflightReport {
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

  // Every supplemental case is structurally, unconditionally strict for
  // disposition (its schema has no `acceptable.disposition` key at all — see
  // `supplemental-ambiguity-pack.ts`), so ALL of them count toward strict
  // (and full) support, with no filtering needed.
  const supplementalStrict = fullCorpusSupport(
    supplementalCases.map((c) => c.expected.disposition),
  );
  const pack = supplementalPackManifest();

  const dispositionSupportCompleted: Record<string, number> = {};
  for (const cls of DISPOSITIONS) {
    dispositionSupportCompleted[cls] =
      (dispositionStrict[cls] ?? 0) + (supplementalStrict[cls] ?? 0);
  }
  const dispositionFullCompleted: Record<string, number> = {};
  for (const cls of DISPOSITIONS) {
    dispositionFullCompleted[cls] = (dispositionFull[cls] ?? 0) + (supplementalStrict[cls] ?? 0);
  }
  const dispositionCheck = classSupportSufficiency(
    DISPOSITIONS,
    dispositionFullCompleted,
    dispositionSupportCompleted,
  );

  const signalsFull = fullCorpusSignalSupport(messageCases.map((c) => c.expected.signals));
  const strictSignalCases = messageCases.filter((c) =>
    isStrictSignalSet(c.expected.signals, c.acceptable?.signals),
  );
  const signalsStrict = fullCorpusSignalSupport(strictSignalCases.map((c) => c.expected.signals));
  const signalsStrictN = strictSignalCases.length;
  const signalsLabelDecisions = Object.values(signalsStrict).reduce((a, b) => a + b, 0);
  // CORRECTED (this round): sufficiency is "does an evaluable strict set
  // exist at all", never "does every individual label clear the per-class
  // floor" — see `evaluateStrictSignalMicroF1Target`'s doc comment for the
  // full macro-vs-micro rationale. Individual low/zero-support labels are
  // still computed and reported below, purely descriptively.
  const signalsSufficient = signalsStrictN > 0 && signalsLabelDecisions > 0;
  const signalsLowSupportLabels = SIGNALS.filter((l) => {
    const support = signalsStrict[l] ?? 0;
    return support > 0 && support < MIN_RELIABLE_CLASS_SUPPORT;
  });
  const signalsZeroStrictSupportLabels = SIGNALS.filter(
    (l) => (signalsFull[l] ?? 0) > 0 && (signalsStrict[l] ?? 0) === 0,
  );

  // Thread-state/compensation quality targets use acceptable-answer accuracy
  // (Family A), which is always hard-evaluable over all n — no support gate
  // is needed for them, so they are intentionally absent from `resolvable`.

  return {
    corpus_version: CORPUS_VERSION,
    n_message: messageCases.length,
    n_thread: threadCases.length,
    disposition_full_support: dispositionFull,
    disposition_strict_support: dispositionStrict,
    supplemental_pack: {
      pack_version: pack.pack_version,
      digest: pack.digest,
      created_at: pack.created_at,
      declaration: pack.declaration,
      case_ids: pack.case_ids,
      language_distribution: pack.language_distribution,
      strict_support: supplementalStrict,
    },
    disposition_support_completed: dispositionSupportCompleted,
    disposition_insufficient_classes: dispositionCheck.insufficientClasses,
    signals_full_support: signalsFull,
    signals_strict_support: signalsStrict,
    signals_strict_n: signalsStrictN,
    signals_strict_label_decisions: signalsLabelDecisions,
    signals_low_support_labels: signalsLowSupportLabels,
    signals_zero_strict_support_labels: signalsZeroStrictSupportLabels,
    resolvable: {
      disposition_macro_f1: dispositionCheck.sufficient,
      signal_micro_f1: signalsSufficient,
    },
  };
}

/**
 * Given the preflight report and the set of quality-target keys that Stage 1
 * left `insufficient_support` (from `evaluateCandidateV2`, union across every
 * Stage-1 finalist), returns whether the combined holdout+pack evidence is
 * even CAPABLE of resolving them, using metadata only. Called BEFORE any
 * Stage-2 provider call is made; the caller (`cli.ts`) must refuse to proceed
 * when `canResolve` is false and report `HOLDOUT_INSUFFICIENT_TO_RESOLVE_TARGET`.
 */
export function checkHoldoutCanResolve(
  preflight: HoldoutPreflightReport,
  unresolvedTargetKeys: readonly string[],
): { canResolve: boolean; blockingTargets: string[] } {
  const blocking = unresolvedTargetKeys.filter((key) => preflight.resolvable[key] === false);
  return { canResolve: blocking.length === 0, blockingTargets: blocking };
}

// ---------------------------------------------------------------------------
// Stage-2 disposition-macro-F1 support-completed EVALUATION — LOCKED, NOT
// EXERCISED THIS ROUND (requires real Stage-2 predictions on BOTH the main
// holdout and the supplemental pack, which this round does not run).
// ---------------------------------------------------------------------------

/**
 * The one-and-only merge point where a real future Stage-2 run combines two
 * INDEPENDENTLY scored strict disposition confusion matrices — the main
 * holdout's own (`mainHoldoutStrict`, exactly `CandidateScoreV2.message_task
 * .disposition.strict` for that candidate, scored the ordinary way over ONLY
 * the 120-case holdout) and the supplemental pack's own (`supplementalStrict`,
 * built the ordinary way via `scoreSingleLabel(DISPOSITIONS, ...)` over ONLY
 * that candidate's 6 supplemental-pack predictions) — into ONE
 * support-completed macro-F1 target verdict.
 *
 * Deliberately takes two already-scored `StrictSingleLabelReport`s, never a
 * candidate id, a provider, or a raw prediction list: merging happens purely
 * over each side's own confusion COUNTS (`combineConfusionRecords`), so this
 * function cannot itself make, and never makes, a provider call, and cannot
 * be candidate-specific — the exact same code merges every future finalist's
 * two reports identically (round requirement: cross-provider fairness).
 *
 * NEVER call this to substitute for the ordinary `evaluateStrictMacroF1Target`
 * anywhere else in Stage 1 or in the main-holdout-only report — the
 * supplemental pack participates in disposition macro F1 and NOTHING else
 * (round requirement: "Do NOT double-count supplemental cases").
 */
export function evaluateStage2DispositionMacroF1Target(
  mainHoldoutStrict: Pick<
    StrictSingleLabelReport,
    "confusion" | "n" | "excluded_multi_answer_cases"
  >,
  mainHoldoutFullSupport: Readonly<Record<string, number>>,
  supplementalStrict: Pick<StrictSingleLabelReport, "confusion" | "n">,
): TargetResultV2 {
  const combined = combineConfusionRecords(DISPOSITIONS, [
    mainHoldoutStrict.confusion,
    supplementalStrict.confusion,
  ]);
  const combinedStrictSupport = Object.fromEntries(
    DISPOSITIONS.map((cls) => [cls, combined.per_class[cls]?.support ?? 0]),
  );

  // The supplemental pack's own per-class strict support (every case is
  // structurally strict, so its "full" and "strict" support are identical) —
  // read directly from its own confusion matrix, not re-derived.
  const supplementalOwnSupport: Record<string, number> = {};
  for (const cls of DISPOSITIONS) {
    const row = supplementalStrict.confusion[cls];
    supplementalOwnSupport[cls] = row ? Object.values(row).reduce((a, b) => a + b, 0) : 0;
  }
  const combinedFullSupport: Record<string, number> = {};
  for (const cls of DISPOSITIONS) {
    combinedFullSupport[cls] =
      (mainHoldoutFullSupport[cls] ?? 0) + (supplementalOwnSupport[cls] ?? 0);
  }

  const { sufficient, insufficientClasses } = classSupportSufficiency(
    DISPOSITIONS,
    combinedFullSupport,
    combinedStrictSupport,
  );

  const value = combined.macro_f1;
  const totalN = mainHoldoutStrict.n + supplementalStrict.n;
  if (!sufficient) {
    return {
      key: "disposition_macro_f1",
      label: "disposition macro F1 (strict, support-completed)",
      state: "insufficient_support",
      threshold: QUALITY_TARGETS.dispositionMacroF1,
      value,
      detail: `insufficient strict gold support (< ${MIN_RELIABLE_CLASS_SUPPORT}) for class(es) even after combining main_holdout + supplemental_ambiguity_support: ${insufficientClasses.join(", ")} (main_holdout strict n=${mainHoldoutStrict.n}, excluded multi-answer=${mainHoldoutStrict.excluded_multi_answer_cases}; supplemental strict n=${supplementalStrict.n}; combined n=${totalN})`,
    };
  }
  return {
    key: "disposition_macro_f1",
    label: "disposition macro F1 (strict, support-completed)",
    state: value >= QUALITY_TARGETS.dispositionMacroF1 ? "pass" : "fail",
    threshold: QUALITY_TARGETS.dispositionMacroF1,
    value,
    detail: `strict macro F1 ${value} ${value >= QUALITY_TARGETS.dispositionMacroF1 ? ">=" : "<"} ${QUALITY_TARGETS.dispositionMacroF1} (main_holdout strict n=${mainHoldoutStrict.n}, excluded multi-answer=${mainHoldoutStrict.excluded_multi_answer_cases}; supplemental_ambiguity_support strict n=${supplementalStrict.n}; combined n=${totalN}; every participating class >= ${MIN_RELIABLE_CLASS_SUPPORT} strict support across the two sources combined)`,
  };
}
