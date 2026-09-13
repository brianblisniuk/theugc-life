/**
 * Stage-2 FINAL DECISION — the explicit evaluation function/status the round
 * requires.
 *
 * Combines the two INDEPENDENTLY scored evidence sources
 * (`scoring/score-v2.ts`'s `CandidateScoreV2` for the main 120-case holdout,
 * `scoring/score-supplemental.ts`'s `SupplementalScore` for the 6-case
 * `b07_disposition_ambiguity_support_v1` pack) into ONE verdict. This module
 * never calls a provider and never reads a raw prediction directly — it only
 * reads already-computed scores/reports, exactly like
 * `evaluateStage2DispositionMacroF1Target` itself.
 *
 * PROVIDER PARITY: no branch anywhere in this file inspects `candidate_id` or
 * `provider_id` to change behaviour — the identical decision pipeline runs
 * for every future finalist.
 *
 * ATOMICITY (round requirement): qualification can be produced ONLY when
 * BOTH sources are identity-valid AND fully executed. A main-only or
 * supplemental-only evidence set can never reach `stage2_qualified_candidate`
 * — it is reported `incomplete` instead, explicitly and loudly, never as a
 * silent partial pass.
 */
import { inferenceConfigDigest } from "../config/inference-config";
import { SUPPLEMENTAL_PACK_SIZE } from "../corpus/supplemental-ambiguity-pack";
import type { FinalistProvenance } from "../run/types";
import type { CandidateScoreV2 } from "./score-v2";
import type { SupplementalScore } from "./score-supplemental";
import {
  evaluateCandidateV2,
  evaluateStage2DispositionMacroF1Target,
  type TargetResultV2,
} from "./targets-v2";
import type { CorpusSplit } from "../taxonomy";

export const STAGE2_STATUSES = [
  /** Identity missing/inconsistent between the two sources, OR pack drift detected. A verdict is REFUSED, never guessed. */
  "blocked_identity_invalid",
  /** One or both sources are not fully executed. NEVER treated as a pass/fail on the source that DID complete. */
  "incomplete",
  /** Main-holdout critical-invariant hard gate failed. Never relaxed by any scoring methodology. */
  "eliminated_critical_safety",
  /** An evaluated quality target failed its threshold, or a statistical target remains unresolved even after the supplemental pack. */
  "eliminated_quality_target_fail",
  /**
   * Qualifies for Stage 2. NEVER a production/vendor winner — the round is
   * explicit that this benchmark currently has only one Stage-2 finalist and
   * that provider/vendor selection requires a later, separate cross-candidate
   * comparison and privacy approval. No code in this module, and no caller of
   * it, may ever render this status as "WINNER" / "SELECTED PROVIDER" /
   * "PRODUCTION MODEL".
   */
  "stage2_qualified_candidate",
] as const;
export type Stage2Status = (typeof STAGE2_STATUSES)[number];

/**
 * STAGE-2 ARTIFACT IDENTITY (round requirement) — a real Stage-2 result must
 * be provenance-bound to BOTH evidence sources. Every field here is required
 * (never optional) precisely so a report missing either source's identity is
 * structurally incomplete rather than silently rendering a partial one.
 */
export interface Stage2ResultIdentity {
  main: {
    corpus_version: string;
    prompt_version: string;
    schema_version: string;
    main_case_set_digest: string;
    main_case_count: number;
  };
  supplemental: {
    pack_version: string;
    pack_digest: string;
    case_ids: readonly string[];
  };
  inference: {
    candidate_id: string;
    provider_id: string;
    requested_model: string;
    returned_models: readonly string[];
    inference_config_digest: string | null;
  };
  scoring_version: string;
}

export interface Stage2Evaluation {
  candidate_id: string;
  status: Stage2Status;
  /** `true` if, and only if, `status === "stage2_qualified_candidate"`. Never a production-winner signal. */
  isQualified: boolean;
  reasons: string[];
  identity: Stage2ResultIdentity;
  targets: TargetResultV2[];
  finalist_provenance: FinalistProvenance | null;
  /** Reported for transparency ONLY — round requirement: never used to eliminate or qualify Stage 2 (the support-completed target in `targets` decides it). */
  main_holdout_only_disposition_macro_f1: TargetResultV2 | null;
}

export interface Stage2MainManifestFacts {
  split: CorpusSplit | "all";
  case_set_digest: string;
  selected_case_count: number;
  /** What "the full main holdout" means for this run — the caller's own resolved selection size (e.g. 120). Never hardcoded here so a corpus-size change is not itself a semantic decision this module makes. */
  expected_full_holdout_count: number;
}

export interface Stage2EvaluationInput {
  candidateId: string;
  mainManifest: Stage2MainManifestFacts;
  mainScore: CandidateScoreV2;
  supplementalScore: SupplementalScore;
  finalistProvenance: FinalistProvenance | null;
}

function fail(
  base: Pick<Stage2Evaluation, "candidate_id" | "identity" | "finalist_provenance">,
  status: Stage2Status,
  reasons: string[],
  targets: TargetResultV2[] = [],
): Stage2Evaluation {
  return {
    ...base,
    status,
    isQualified: false,
    reasons,
    targets,
    main_holdout_only_disposition_macro_f1: null,
  };
}

export function evaluateStage2Final(input: Stage2EvaluationInput): Stage2Evaluation {
  const { mainScore, supplementalScore, mainManifest } = input;

  const mainInferenceDigest = mainScore.inference_config
    ? inferenceConfigDigest(mainScore.inference_config)
    : null;
  const supplementalInferenceDigest = supplementalScore.inference_config
    ? inferenceConfigDigest(supplementalScore.inference_config)
    : null;
  const returnedModels = [
    ...new Set([
      ...mainScore.reliability.returned_models,
      ...supplementalScore.reliability.returned_models,
    ]),
  ].sort();

  const identity: Stage2ResultIdentity = {
    main: {
      corpus_version: mainScore.corpus_version,
      prompt_version: mainScore.prompt_version,
      schema_version: mainScore.schema_version,
      main_case_set_digest: mainManifest.case_set_digest,
      main_case_count: mainManifest.selected_case_count,
    },
    supplemental: {
      pack_version: supplementalScore.pack_version,
      pack_digest: supplementalScore.pack_digest,
      case_ids: supplementalScore.case_ids,
    },
    inference: {
      candidate_id: input.candidateId,
      provider_id: mainScore.provider_id,
      requested_model: mainScore.requested_model,
      returned_models: returnedModels,
      inference_config_digest: mainInferenceDigest,
    },
    scoring_version: mainScore.scoring_version,
  };

  const base = {
    candidate_id: input.candidateId,
    identity,
    finalist_provenance: input.finalistProvenance,
  };

  // ---------------------------------------------------------------------
  // 1. RESULT IDENTITY VALID — checked FIRST. A report missing either
  //    source's identity, or whose two sources disagree about what was
  //    actually run, must refuse to present a verdict rather than guess.
  // ---------------------------------------------------------------------
  const identityProblems: string[] = [];
  if (
    !identity.main.corpus_version ||
    !identity.main.prompt_version ||
    !identity.main.schema_version
  ) {
    identityProblems.push(
      "main holdout identity incomplete (corpus/prompt/schema version missing)",
    );
  }
  if (!identity.main.main_case_set_digest) {
    identityProblems.push("main holdout case-set digest missing");
  }
  if (mainManifest.split !== "holdout" && mainManifest.split !== "all") {
    identityProblems.push(
      `main selection split "${mainManifest.split}" is not the frozen holdout — Stage 2 requires SOURCE A to be the 120-case holdout`,
    );
  }
  if (!identity.supplemental.pack_version || !identity.supplemental.pack_digest) {
    identityProblems.push("supplemental pack identity incomplete (pack version/digest missing)");
  }
  if (identity.supplemental.case_ids.length !== SUPPLEMENTAL_PACK_SIZE) {
    identityProblems.push(
      `supplemental identity does not name exactly ${SUPPLEMENTAL_PACK_SIZE} case ids (found ${identity.supplemental.case_ids.length})`,
    );
  }
  if (mainScore.candidate_id !== supplementalScore.candidate_id) {
    identityProblems.push("main and supplemental candidate_id mismatch");
  }
  if (mainScore.provider_id !== supplementalScore.provider_id) {
    identityProblems.push("main and supplemental provider_id mismatch");
  }
  if (mainScore.requested_model !== supplementalScore.requested_model) {
    identityProblems.push(
      `main requested_model (${mainScore.requested_model}) differs from supplemental requested_model (${supplementalScore.requested_model}) — Stage 2 requires the SAME finalist/model against both evidence sources`,
    );
  }
  if (
    mainInferenceDigest !== null &&
    supplementalInferenceDigest !== null &&
    mainInferenceDigest !== supplementalInferenceDigest
  ) {
    identityProblems.push(
      `main inference_config_digest (${mainInferenceDigest}) differs from supplemental (${supplementalInferenceDigest}) — Stage 2 requires the SAME inference configuration against both evidence sources`,
    );
  }
  if (mainScore.invalidated_reason) {
    identityProblems.push(`main holdout evidence invalidated: ${mainScore.invalidated_reason}`);
  }
  if (supplementalScore.invalidated_reason) {
    identityProblems.push(
      `supplemental evidence invalidated: ${supplementalScore.invalidated_reason}`,
    );
  }

  if (identityProblems.length > 0) {
    return fail(base, "blocked_identity_invalid", identityProblems);
  }

  // ---------------------------------------------------------------------
  // 2. FULL EXECUTION OF BOTH SOURCES — atomicity. Interrupting between
  //    source A and source B (in either direction) must produce INCOMPLETE,
  //    never a qualification computed from one source alone.
  // ---------------------------------------------------------------------
  const mainComplete =
    mainManifest.selected_case_count === mainManifest.expected_full_holdout_count &&
    mainScore.reliability.cases_attempted === mainManifest.expected_full_holdout_count;
  const supplementalComplete = supplementalScore.reliability.all_six_completed;

  if (!mainComplete || !supplementalComplete) {
    const reasons: string[] = [];
    if (!mainComplete) {
      reasons.push(
        `main holdout incomplete: selected ${mainManifest.selected_case_count}, attempted ${mainScore.reliability.cases_attempted}/${mainManifest.expected_full_holdout_count} — a partial or missing main-holdout run can never produce a Stage-2 qualified status`,
      );
    }
    if (!supplementalComplete) {
      reasons.push(
        `supplemental pack incomplete: attempted ${supplementalScore.reliability.cases_attempted}/${SUPPLEMENTAL_PACK_SIZE} — all ${SUPPLEMENTAL_PACK_SIZE} frozen supplemental cases are required; a partial or absent supplemental run can never produce a Stage-2 qualified status regardless of how well the main holdout did`,
      );
    }
    return fail(base, "incomplete", reasons);
  }

  // ---------------------------------------------------------------------
  // 3. CRITICAL SAFETY — main holdout only (the pack's own descriptive
  //    critical-safety read never redefines this locked gate).
  // ---------------------------------------------------------------------
  if (mainScore.critical_suite.violations > 0 || !mainScore.critical_suite.passes_hard_gate) {
    return fail(base, "eliminated_critical_safety", [
      `${mainScore.critical_suite.violations} critical invariant violation(s) on the main holdout (evaluated ${mainScore.critical_suite.cases_evaluated}/${mainScore.critical_suite.cases}) — the critical-safety hard gate is never relaxed`,
    ]);
  }

  if (!mainScore.message_task) {
    return fail(base, "eliminated_quality_target_fail", [
      "main holdout produced no message-task evidence — disposition/signal targets cannot be resolved",
    ]);
  }
  if (!mainScore.thread_task) {
    return fail(base, "eliminated_quality_target_fail", [
      "main holdout produced no thread-task evidence — thread-state/compensation targets cannot be resolved",
    ]);
  }

  // ---------------------------------------------------------------------
  // 4. QUALITY TARGETS — reuses the LOCKED Stage-1 target evaluator for
  //    every target that is unaffected by the supplemental pack (reliability
  //    rates, main-holdout-only signal micro F1, thread-state accuracy,
  //    compensation accuracy, the unknown->unpaid collapse count), and calls
  //    the LOCKED support-completed merge primitive exactly once for
  //    disposition macro F1. The ordinary main-holdout-only disposition
  //    macro F1 target (also present in `stage1Eval.targets`) is deliberately
  //    NEVER read here for elimination/qualification — only reported
  //    separately for transparency.
  // ---------------------------------------------------------------------
  const stage1Eval = evaluateCandidateV2(mainScore);
  const findTarget = (key: string): TargetResultV2 | undefined =>
    stage1Eval.targets.find((t) => t.key === key);

  const mainHoldoutOnlyDisposition = findTarget("disposition_macro_f1") ?? null;
  const firstPass = findTarget("first_pass_schema_valid_rate");
  const finalValid = findTarget("final_schema_valid_rate");
  const signalMicro = findTarget("signal_micro_f1");
  const threadState = findTarget("thread_state_accuracy");
  const compensation = findTarget("compensation_accuracy");
  const unknownUnpaid = findTarget("unknown_not_unpaid"); // present only when count > 0

  const missing: string[] = [];
  if (!firstPass) missing.push("first_pass_schema_valid_rate");
  if (!finalValid) missing.push("final_schema_valid_rate");
  if (!signalMicro) missing.push("signal_micro_f1");
  if (!threadState) missing.push("thread_state_accuracy");
  if (!compensation) missing.push("compensation_accuracy");
  if (missing.length > 0) {
    return fail(base, "eliminated_quality_target_fail", [
      `main-holdout quality target(s) could not be evaluated: ${missing.join(", ")}`,
    ]);
  }

  const dispositionSupportCompleted = evaluateStage2DispositionMacroF1Target(
    mainScore.message_task.disposition.strict,
    mainScore.message_task.disposition_full_support,
    supplementalScore.disposition_strict,
  );

  const targets: TargetResultV2[] = [
    firstPass as TargetResultV2,
    finalValid as TargetResultV2,
    dispositionSupportCompleted,
    signalMicro as TargetResultV2,
    threadState as TargetResultV2,
    compensation as TargetResultV2,
  ];
  if (unknownUnpaid) targets.push(unknownUnpaid);

  const failedTargets = targets.filter((t) => t.state === "fail");
  const unresolvedTargets = targets.filter((t) => t.state === "insufficient_support");

  if (failedTargets.length > 0 || unresolvedTargets.length > 0) {
    const reasons = [
      ...failedTargets.map((t) => `${t.label}: ${t.detail}`),
      ...unresolvedTargets.map((t) => `UNRESOLVED statistical target — ${t.label}: ${t.detail}`),
    ];
    return {
      ...base,
      status: "eliminated_quality_target_fail",
      isQualified: false,
      reasons,
      targets,
      main_holdout_only_disposition_macro_f1: mainHoldoutOnlyDisposition,
    };
  }

  return {
    ...base,
    status: "stage2_qualified_candidate",
    isQualified: true,
    reasons: [],
    targets,
    main_holdout_only_disposition_macro_f1: mainHoldoutOnlyDisposition,
  };
}

/**
 * A single, centrally-enforced rendering rule: `STAGE2_QUALIFIED_CANDIDATE`
 * is the ONLY string any caller may print for a qualified candidate. This
 * function exists so `cli.ts` (and any future report renderer) has one place
 * to call rather than re-deriving the label, and a test can assert the
 * forbidden words never appear anywhere it is used.
 */
export function renderStage2Status(evaluation: Stage2Evaluation): string {
  if (evaluation.status === "stage2_qualified_candidate") return "STAGE2_QUALIFIED_CANDIDATE";
  return evaluation.status.toUpperCase();
}
