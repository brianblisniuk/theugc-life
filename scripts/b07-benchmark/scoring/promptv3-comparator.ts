/**
 * EXPERIMENT 1 — case-by-case v2-vs-v3 comparator (PR #40
 * `POSTHOC_PROMPT_DIAGNOSTIC`, NOT a Stage-2 qualification comparison).
 *
 * Compares Sonnet 5's FROZEN, permanent `b07_benchmark_prompt_v2` Stage-2
 * result (`ELIMINATED_CRITICAL_SAFETY`) against a `b07_benchmark_prompt_v3`
 * diagnostic run over the IDENTICAL 120-case main holdout + 6-case
 * supplemental pack, under the SAME scoring-v2 methodology
 * (`scoring/score-v2.ts`'s `scoreCandidateV2`/`scoring/score-supplemental.ts`'s
 * `scoreSupplementalPack` — reused verbatim, never re-derived, so "same
 * scoring-v2 methodology" is true by construction).
 *
 * READS v2 evidence AS READ-ONLY INPUT. Nothing in this file writes to, or
 * mutates, the v2 raw result files — the caller passes already-loaded rows
 * (or a path to load them from); this module never resolves a path against
 * the sibling `stage2-live` worktree itself, so it carries no risk of
 * accidentally writing into another worktree.
 *
 * CRITICAL VIOLATIONS ARE RECOMPUTED, NEVER HARDCODED (WORKING_METHOD.md
 * §6.13 "RECOMPUTE, DO NOT COPY"): the "3 known v2 critical violations" the
 * round's task spec names (`m-en-hold-017`/`temporary_timing_not_permanent_decline`,
 * `m-en-hold-027`/`redirect_not_terminal`, `m-es-hold-017`/`redirect_not_terminal`)
 * are NOT a literal constant here — they fall out of calling the SAME
 * `scoreCandidateV2` over the caller-supplied v2 raw rows, exactly like every
 * other v2 evidence in this codebase. If the v2 raw evidence file ever
 * differed from what the task spec describes, this comparator would report
 * whatever it actually recomputes, not the task spec's prose.
 */
import type { CorpusCase } from "../corpus/schema";
import { CORPUS_VERSION } from "../corpus/schema";
import { loadCorpus } from "../corpus/load";
import {
  loadSupplementalAmbiguityPack,
  type SupplementalCase,
} from "../corpus/supplemental-ambiguity-pack";
import { PROMPT_VERSION } from "../prompt/render";
import { PROMPT_VERSION_V3 } from "../prompt/render-v3";
import { B07_BENCHMARK_SCHEMA_VERSION } from "../schema";
import type { PriceBook } from "../config/pricing";
import type { CaseResult, SupplementalCaseResult } from "../run/types";
import { predictionFor } from "./score";
import { scoreCandidateV2, type CandidateScoreV2 } from "./score-v2";
import {
  predictionForSupplemental,
  scoreSupplementalPack,
  type SupplementalScore,
} from "./score-supplemental";
import type { InvariantViolation } from "./invariants";

export const PROMPT_V3_DIAGNOSTIC_LABEL = "POSTHOC_PROMPT_DIAGNOSTIC" as const;

export interface PromptV3ComparatorInput {
  candidateId: string;
  providerId: string;
  requestedModel: string;
  /** v2 raw main-holdout rows — READ-ONLY input, e.g. loaded from the sibling worktree's `results.jsonl`. */
  v2HoldoutResults: readonly CaseResult[];
  /** v2 raw supplemental-pack rows — READ-ONLY input, e.g. loaded from `supplemental-results.jsonl`. */
  v2SupplementalResults: readonly SupplementalCaseResult[];
  /** v3 diagnostic raw main-holdout rows, from `run/promptv3-diagnostic-runner.ts`'s `promptv3-diagnostic-results.jsonl`. */
  v3HoldoutResults: readonly CaseResult[];
  /** v3 diagnostic raw supplemental-pack rows, from `promptv3-diagnostic-supplemental-results.jsonl`. */
  v3SupplementalResults: readonly SupplementalCaseResult[];
  /** Optional — economics are reported for context only, never part of the pass/fail comparison. */
  priceBook?: PriceBook | null;
  /** Override for testing; defaults to the real frozen holdout. */
  holdoutCases?: readonly CorpusCase[];
  /** Override for testing; defaults to the real frozen supplemental pack. */
  supplementalCases?: readonly SupplementalCase[];
}

export interface CriticalViolationKey {
  case_id: string;
  invariant_id: string;
}

export interface KnownViolationOutcome extends CriticalViolationKey {
  contract_ref: string;
  description: string;
  /** True iff this EXACT (case_id, invariant_id) pair does not recur in the v3 diagnostic evidence. */
  fixed_under_v3: boolean;
}

export interface RegressionOutcome extends CriticalViolationKey {
  contract_ref: string;
  description: string;
}

function keyOf(v: CriticalViolationKey): string {
  return `${v.case_id}::${v.invariant_id}`;
}

function diffViolations(
  v2: readonly InvariantViolation[],
  v3: readonly InvariantViolation[],
): { known: KnownViolationOutcome[]; regressions: RegressionOutcome[] } {
  const v3Keys = new Set(v3.map(keyOf));
  const v2Keys = new Set(v2.map(keyOf));
  const known: KnownViolationOutcome[] = v2.map((v) => ({
    case_id: v.case_id,
    invariant_id: v.invariant_id,
    contract_ref: v.contract_ref,
    description: v.description,
    fixed_under_v3: !v3Keys.has(keyOf(v)),
  }));
  const regressions: RegressionOutcome[] = v3
    .filter((v) => !v2Keys.has(keyOf(v)))
    .map((v) => ({
      case_id: v.case_id,
      invariant_id: v.invariant_id,
      contract_ref: v.contract_ref,
      description: v.description,
    }));
  return { known, regressions };
}

export interface MetricDelta {
  v2: number;
  v3: number;
  delta: number;
}

export interface PromptV3HoldoutComparison {
  label: typeof PROMPT_V3_DIAGNOSTIC_LABEL;
  candidate_id: string;
  identity: {
    corpus_version: string;
    v2_prompt_version: string;
    v3_prompt_version: string;
    schema_version: string;
  };
  main_holdout: {
    v2_score: CandidateScoreV2;
    v3_score: CandidateScoreV2;
    known_v2_critical_violations: KnownViolationOutcome[];
    new_v3_critical_regressions: RegressionOutcome[];
    known_violations_fixed_count: number;
    known_violations_total_count: number;
    new_regressions_count: number;
    aggregate_deltas: {
      disposition_macro_f1_strict: MetricDelta;
      signal_micro_f1_strict: MetricDelta;
      thread_state_accuracy_acceptable: MetricDelta | null;
      compensation_structure_accuracy_acceptable: MetricDelta | null;
    };
  };
  supplemental: {
    v2_score: SupplementalScore;
    v3_score: SupplementalScore;
    disposition_strict_accuracy_delta: MetricDelta;
    case_by_case: {
      case_id: string;
      v2_predicted_disposition: string | null;
      v3_predicted_disposition: string | null;
      gold_disposition: "ambiguous";
      v2_correct: boolean;
      v3_correct: boolean;
    }[];
  };
}

function delta(v2: number, v3: number): MetricDelta {
  return { v2, v3, delta: Math.round((v3 - v2) * 10000) / 10000 };
}

/**
 * The full Experiment-1 comparison: recomputes v2 and v3 scores from raw
 * evidence via the SAME `scoreCandidateV2`/`scoreSupplementalPack` used
 * everywhere else in this benchmark, then diffs the two.
 */
export function comparePromptV2AndV3OnHoldout(
  input: PromptV3ComparatorInput,
): PromptV3HoldoutComparison {
  const holdoutCases = input.holdoutCases ?? loadCorpus().filter((c) => c.split === "holdout");
  const supplementalCases = input.supplementalCases ?? loadSupplementalAmbiguityPack();

  const v2Score = scoreCandidateV2({
    candidateId: input.candidateId,
    providerId: input.providerId,
    requestedModel: input.requestedModel,
    corpusVersion: CORPUS_VERSION,
    promptVersion: PROMPT_VERSION,
    schemaVersion: B07_BENCHMARK_SCHEMA_VERSION,
    cases: holdoutCases,
    results: input.v2HoldoutResults,
    priceBook: input.priceBook ?? null,
  });
  const v3Score = scoreCandidateV2({
    candidateId: input.candidateId,
    providerId: input.providerId,
    requestedModel: input.requestedModel,
    corpusVersion: CORPUS_VERSION,
    promptVersion: PROMPT_VERSION_V3,
    schemaVersion: B07_BENCHMARK_SCHEMA_VERSION,
    cases: holdoutCases,
    results: input.v3HoldoutResults,
    priceBook: input.priceBook ?? null,
  });

  const { known, regressions } = diffViolations(
    v2Score.critical_suite.violation_details,
    v3Score.critical_suite.violation_details,
  );

  const threadDelta =
    v2Score.thread_task && v3Score.thread_task
      ? delta(
          v2Score.thread_task.thread_state.acceptable_answer.accuracy,
          v3Score.thread_task.thread_state.acceptable_answer.accuracy,
        )
      : null;
  const compDelta =
    v2Score.thread_task && v3Score.thread_task
      ? delta(
          v2Score.thread_task.compensation_structure.acceptable_answer.accuracy,
          v3Score.thread_task.compensation_structure.acceptable_answer.accuracy,
        )
      : null;

  const v2SupplementalScore = scoreSupplementalPack({
    candidateId: input.candidateId,
    providerId: input.providerId,
    requestedModel: input.requestedModel,
    results: input.v2SupplementalResults,
    priceBook: input.priceBook ?? null,
  });
  const v3SupplementalScore = scoreSupplementalPack({
    candidateId: input.candidateId,
    providerId: input.providerId,
    requestedModel: input.requestedModel,
    results: input.v3SupplementalResults,
    priceBook: input.priceBook ?? null,
  });

  const v2ByCaseId = new Map(input.v2SupplementalResults.map((r) => [r.case_id, r]));
  const v3ByCaseId = new Map(input.v3SupplementalResults.map((r) => [r.case_id, r]));
  const caseByCase = supplementalCases.map((c) => {
    const v2Row = v2ByCaseId.get(c.case_id);
    const v3Row = v3ByCaseId.get(c.case_id);
    const v2Prediction = v2Row ? predictionForSupplemental(v2Row) : null;
    const v3Prediction = v3Row ? predictionForSupplemental(v3Row) : null;
    return {
      case_id: c.case_id,
      v2_predicted_disposition: v2Prediction?.disposition ?? null,
      v3_predicted_disposition: v3Prediction?.disposition ?? null,
      gold_disposition: "ambiguous" as const,
      v2_correct: v2Prediction?.disposition === "ambiguous",
      v3_correct: v3Prediction?.disposition === "ambiguous",
    };
  });

  return {
    label: PROMPT_V3_DIAGNOSTIC_LABEL,
    candidate_id: input.candidateId,
    identity: {
      corpus_version: CORPUS_VERSION,
      v2_prompt_version: PROMPT_VERSION,
      v3_prompt_version: PROMPT_VERSION_V3,
      schema_version: B07_BENCHMARK_SCHEMA_VERSION,
    },
    main_holdout: {
      v2_score: v2Score,
      v3_score: v3Score,
      known_v2_critical_violations: known,
      new_v3_critical_regressions: regressions,
      known_violations_fixed_count: known.filter((k) => k.fixed_under_v3).length,
      known_violations_total_count: known.length,
      new_regressions_count: regressions.length,
      aggregate_deltas: {
        disposition_macro_f1_strict: delta(
          v2Score.message_task?.disposition.strict.macro_f1 ?? 0,
          v3Score.message_task?.disposition.strict.macro_f1 ?? 0,
        ),
        signal_micro_f1_strict: delta(
          v2Score.message_task?.signals.strict.micro.f1 ?? 0,
          v3Score.message_task?.signals.strict.micro.f1 ?? 0,
        ),
        thread_state_accuracy_acceptable: threadDelta,
        compensation_structure_accuracy_acceptable: compDelta,
      },
    },
    supplemental: {
      v2_score: v2SupplementalScore,
      v3_score: v3SupplementalScore,
      disposition_strict_accuracy_delta: delta(
        v2SupplementalScore.disposition_strict.accuracy,
        v3SupplementalScore.disposition_strict.accuracy,
      ),
      case_by_case: caseByCase,
    },
  };
}

export { predictionFor };
