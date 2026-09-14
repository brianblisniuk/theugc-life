/**
 * EXPERIMENT 2 — scorer/reporter for the NEW frozen 36-case
 * `b07_prompt_v3_generalization_challenge_v1` blind generalization-challenge
 * fixture (PR #40 prompt-v3 experiment).
 *
 * Unlike Experiment 1 (`promptv3-comparator.ts`), this is NOT a posthoc
 * diagnostic over already-opened evidence — it is a genuine blind test over
 * fixture content Sonnet has never seen. This scorer is therefore
 * self-contained: it scores against the fixture's OWN gold
 * (`corpus/prompt-v3-generalization-challenge.ts`), never against the main
 * holdout's gold, and never feeds any main-holdout metric.
 *
 * Reports exactly what the task requires: critical invariant violations,
 * per-category accuracy for the 5 coverage buckets, contrast-case accuracy
 * specifically, and multilingual accuracy specifically.
 */
import {
  GENERALIZATION_CATEGORIES,
  generalizationPackManifest,
  loadPromptV3GeneralizationChallenge,
  type GeneralizationCase,
  type GeneralizationCategory,
} from "../corpus/prompt-v3-generalization-challenge";
import { isAcceptableCorrect, isAcceptableCorrectSignals } from "./acceptable";
import { evaluateInvariants, type InvariantViolation } from "./invariants";
import { predictionForSupplemental } from "./score-supplemental";
import type { SupplementalCaseResult } from "../run/types";
import { canonicalizeSignals } from "../taxonomy";

export interface GeneralizationCaseOutcome {
  case_id: string;
  category: GeneralizationCategory;
  language: string;
  is_contrast: boolean;
  predicted_disposition: string | null;
  predicted_signals: readonly string[] | null;
  predicted_evidence_strength: string | null;
  disposition_acceptable_correct: boolean;
  signals_acceptable_correct: boolean;
  evidence_strength_acceptable_correct: boolean;
  /** disposition AND signals both acceptable-correct. Evidence-strength is reported separately, not required for "fully correct" (mirrors the main benchmark's own field-by-field reporting discipline). */
  fully_correct: boolean;
  critical_violations: InvariantViolation[];
}

export interface CategoryBreakdown {
  category: GeneralizationCategory;
  n: number;
  fully_correct: number;
  fully_correct_rate: number;
  disposition_acceptable_accuracy: number;
  signals_acceptable_accuracy: number;
  critical_violations_total: number;
}

export interface BucketAccuracy {
  n: number;
  fully_correct: number;
  fully_correct_rate: number;
  disposition_acceptable_accuracy: number;
  signals_acceptable_accuracy: number;
  critical_violations_total: number;
}

export interface GeneralizationReliability {
  cases_selected: number;
  cases_ok: number;
  cases_final_schema_valid: number;
  all_36_attempted: boolean;
  all_36_valid_predictions: boolean;
}

export interface PromptV3GeneralizationScore {
  candidate_id: string;
  provider_id: string;
  requested_model: string;
  pack_version: string;
  pack_digest: string;
  invalidated_reason: string | null;
  n: number;
  overall: BucketAccuracy;
  by_category: CategoryBreakdown[];
  /** "contrast-case accuracy specifically" (task requirement). */
  contrast: BucketAccuracy;
  /** The complementary conservative-answer (`is_contrast: false`) bucket, where critical invariants are the primary safety signal. */
  conservative: BucketAccuracy;
  /** "multilingual accuracy specifically" (task requirement) — same as `by_category`'s `multilingual` entry, surfaced at the top level for convenience. */
  multilingual: BucketAccuracy;
  critical_violations_by_invariant: Record<string, number>;
  reliability: GeneralizationReliability;
  case_outcomes: GeneralizationCaseOutcome[];
}

export interface GeneralizationScoreInput {
  candidateId: string;
  providerId: string;
  requestedModel: string;
  results: readonly SupplementalCaseResult[];
  /** Override for testing; defaults to the real frozen 36-case fixture. */
  cases?: readonly GeneralizationCase[];
}

function normaliseResults(
  input: GeneralizationScoreInput,
  packVersion: string,
  packDigest: string,
): {
  byCaseId: Map<string, SupplementalCaseResult>;
  identityConflicts: string[];
  driftDetected: boolean;
} {
  const rowsByCase = new Map<string, SupplementalCaseResult[]>();
  let driftDetected = false;
  for (const result of input.results) {
    if (result.candidate_id !== input.candidateId) continue;
    if (result.pack_version === packVersion && result.pack_digest !== packDigest) {
      driftDetected = true;
      continue;
    }
    if (result.pack_version !== packVersion) continue;
    const bucket = rowsByCase.get(result.case_id) ?? [];
    bucket.push(result);
    rowsByCase.set(result.case_id, bucket);
  }
  const byCaseId = new Map<string, SupplementalCaseResult>();
  const identityConflicts: string[] = [];
  for (const [caseId, rows] of rowsByCase) {
    const identities = new Set(
      rows.map((r) => `${r.requested_model}::${r.inference_config_digest}`),
    );
    if (identities.size > 1) {
      identityConflicts.push(caseId);
      continue;
    }
    const last = rows[rows.length - 1];
    if (last) byCaseId.set(caseId, last);
  }
  return { byCaseId, identityConflicts: identityConflicts.sort(), driftDetected };
}

function bucketAccuracy(outcomes: readonly GeneralizationCaseOutcome[]): BucketAccuracy {
  const n = outcomes.length;
  const fullyCorrect = outcomes.filter((o) => o.fully_correct).length;
  const dispositionCorrect = outcomes.filter((o) => o.disposition_acceptable_correct).length;
  const signalsCorrect = outcomes.filter((o) => o.signals_acceptable_correct).length;
  const criticalTotal = outcomes.reduce((sum, o) => sum + o.critical_violations.length, 0);
  const rate = (num: number): number => (n === 0 ? 0 : Math.round((num / n) * 10000) / 10000);
  return {
    n,
    fully_correct: fullyCorrect,
    fully_correct_rate: rate(fullyCorrect),
    disposition_acceptable_accuracy: rate(dispositionCorrect),
    signals_acceptable_accuracy: rate(signalsCorrect),
    critical_violations_total: criticalTotal,
  };
}

/**
 * Scores exactly the 36 frozen generalization-challenge cases for one
 * candidate. Never touches the main holdout, the supplemental pack, or any
 * Stage-1/Stage-2 machinery.
 */
export function scorePromptV3Generalization(
  input: GeneralizationScoreInput,
): PromptV3GeneralizationScore {
  const cases = input.cases ?? loadPromptV3GeneralizationChallenge();
  const manifest = generalizationPackManifest();
  const { byCaseId, identityConflicts, driftDetected } = normaliseResults(
    input,
    manifest.pack_version,
    manifest.digest,
  );

  const caseOutcomes: GeneralizationCaseOutcome[] = cases.map((c) => {
    const row = byCaseId.get(c.case_id);
    const prediction = row ? predictionForSupplemental(row) : null;
    const predictedSignals = prediction ? canonicalizeSignals(prediction.signals) : null;

    const dispositionCorrect = isAcceptableCorrect(
      c.expected.disposition,
      c.acceptable?.disposition,
      prediction?.disposition ?? null,
    );
    const signalsCorrect = isAcceptableCorrectSignals(
      c.expected.signals,
      c.acceptable?.signals,
      predictedSignals,
    );
    const evidenceCorrect = isAcceptableCorrect(
      c.expected.evidence_strength,
      c.acceptable?.evidence_strength,
      prediction?.evidence_strength ?? null,
    );

    const violations = prediction ? evaluateInvariants(c, prediction) : [];

    return {
      case_id: c.case_id,
      category: c.category,
      language: c.language,
      is_contrast: c.is_contrast,
      predicted_disposition: prediction?.disposition ?? null,
      predicted_signals: predictedSignals,
      predicted_evidence_strength: prediction?.evidence_strength ?? null,
      disposition_acceptable_correct: dispositionCorrect,
      signals_acceptable_correct: signalsCorrect,
      evidence_strength_acceptable_correct: evidenceCorrect,
      fully_correct: dispositionCorrect && signalsCorrect,
      critical_violations: violations,
    };
  });

  const byCategory: CategoryBreakdown[] = GENERALIZATION_CATEGORIES.map((category) => {
    const outcomes = caseOutcomes.filter((o) => o.category === category);
    const acc = bucketAccuracy(outcomes);
    return { category, ...acc };
  });

  const contrastOutcomes = caseOutcomes.filter((o) => o.is_contrast);
  const conservativeOutcomes = caseOutcomes.filter((o) => !o.is_contrast);
  const multilingualOutcomes = caseOutcomes.filter((o) => o.category === "multilingual");

  const violationsByInvariant: Record<string, number> = {};
  for (const o of caseOutcomes) {
    for (const v of o.critical_violations) {
      violationsByInvariant[v.invariant_id] = (violationsByInvariant[v.invariant_id] ?? 0) + 1;
    }
  }

  const results = [...byCaseId.values()];
  const attempted = results.filter(
    (r) =>
      r.status !== "not_run_missing_key" && r.status !== "unavailable" && r.status !== "dry_run",
  );
  const casesOk = attempted.filter((r) => r.status === "ok").length;
  const casesValid = attempted.filter((r) => r.final_schema_valid).length;
  const all36Attempted =
    cases.length === 36 &&
    cases.every((c) => {
      const r = byCaseId.get(c.case_id);
      return (
        !!r &&
        r.status !== "not_run_missing_key" &&
        r.status !== "unavailable" &&
        r.status !== "dry_run"
      );
    });
  const all36Valid =
    cases.length === 36 &&
    cases.every((c) => {
      const r = byCaseId.get(c.case_id);
      return !!r && r.status === "ok" && r.final_schema_valid && r.prediction !== null;
    });

  let invalidatedReason: string | null = null;
  if (identityConflicts.length > 0) {
    invalidatedReason = `refusing to score ${identityConflicts.length} generalization case(s) with incompatible result rows under one run id: ${identityConflicts.join(", ")}.`;
  } else if (driftDetected) {
    invalidatedReason = `GENERALIZATION_PACK_DRIFT_DETECTED: at least one stored result was computed against pack "${manifest.pack_version}" with a digest that does not match the pack currently on disk (${manifest.digest}).`;
  }

  return {
    candidate_id: input.candidateId,
    provider_id: input.providerId,
    requested_model: input.requestedModel,
    pack_version: manifest.pack_version,
    pack_digest: manifest.digest,
    invalidated_reason: invalidatedReason,
    n: cases.length,
    overall: bucketAccuracy(caseOutcomes),
    by_category: byCategory,
    contrast: bucketAccuracy(contrastOutcomes),
    conservative: bucketAccuracy(conservativeOutcomes),
    multilingual: bucketAccuracy(multilingualOutcomes),
    critical_violations_by_invariant: violationsByInvariant,
    reliability: {
      cases_selected: cases.length,
      cases_ok: casesOk,
      cases_final_schema_valid: casesValid,
      all_36_attempted: all36Attempted,
      all_36_valid_predictions: all36Valid,
    },
    case_outcomes: caseOutcomes,
  };
}
