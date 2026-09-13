/**
 * Stage-2 SUPPLEMENTAL scoring — SOURCE B
 * (`b07_disposition_ambiguity_support_v1`).
 *
 * Deliberately a SEPARATE scorer from `scoring/score-v2.ts`, over a
 * STRUCTURALLY SEPARATE result type (`SupplementalCaseResult`, never
 * `CaseResult`): a supplemental prediction can never enter main-holdout
 * disposition/signal/thread-state/compensation scoring, reliability, latency
 * or economics, because there is no function anywhere that accepts both types
 * at once.
 *
 * SUPPLEMENTAL SCORING CONTRACT (round requirement):
 *  - disposition: ordinary strict single-label confusion, gold ALWAYS
 *    `"ambiguous"` (structurally, per the pack's own schema), prediction =
 *    candidate disposition. No prediction-dependent gold rewriting — every
 *    one of the 6 gold values is literally `"ambiguous"`, never adjusted
 *    toward whatever the candidate happened to answer.
 *  - signals / evidence_strength: reported descriptively only. NEITHER feeds
 *    the Stage-2 hard signal micro-F1 target, which remains MAIN-HOLDOUT-ONLY
 *    (`scoring/targets-v2.ts`'s `evaluateStrictSignalMicroF1Target`, called
 *    only over `CandidateScoreV2.message_task.signals`, never over anything
 *    built here).
 *  - `no_fabricated_strong_evidence`: reported descriptively as supplemental
 *    safety evidence (a concerning `strong` evidence_strength claim on a case
 *    this pack's own gold_rationale ties to genuinely thin/self-contradicting
 *    evidence is surfaced, never silently dropped) — this NEVER redefines or
 *    substitutes for the locked main-holdout critical-invariant gate
 *    (`scoring/invariants.ts`), which continues to run only against the main
 *    holdout exactly as before.
 */
import type { PriceBook } from "../config/pricing";
import { estimateCaseCostUsd } from "../config/pricing";
import type { EffectiveInferenceConfig } from "../config/inference-config";
import {
  loadSupplementalAmbiguityPack,
  supplementalPackManifest,
  SUPPLEMENTAL_PACK_SIZE,
  type SupplementalCase,
} from "../corpus/supplemental-ambiguity-pack";
import type { MessageOutput } from "../schema";
import { DISPOSITIONS } from "../taxonomy";
import { scoreSingleLabel, summariseLatency, type LatencySummary } from "./metrics";
import type { StrictSingleLabelReport } from "./score-v2";
import type { SupplementalCaseResult } from "../run/types";

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 10000) / 10000;
}

/** Only a schema-valid, `status === "ok"` row ever becomes a semantic prediction — identical discipline to `predictionFor` in `scoring/score.ts`. */
export function predictionForSupplemental(r: SupplementalCaseResult): MessageOutput | null {
  return r.status === "ok" && r.final_schema_valid ? r.prediction : null;
}

export interface SupplementalReliabilityReport {
  cases_selected: number;
  cases_attempted: number;
  cases_not_run_missing_key: number;
  cases_unavailable: number;
  first_pass_schema_valid: number;
  first_pass_schema_valid_rate: number;
  retries_used: number;
  retry_rate: number;
  final_schema_valid: number;
  final_schema_valid_rate: number;
  provider_errors: number;
  provider_error_rate: number;
  timeouts: number;
  timeout_rate: number;
  returned_models: string[];
  /** True only when every one of the 6 frozen cases produced a terminal (ok/schema_failed) attempt — never fewer, never a subset. */
  all_six_completed: boolean;
}

export interface SupplementalEconomicsReport {
  pricing_basis: "estimated_from_published_prices" | "unverified" | "no_pricing_metadata";
  price_source: string | null;
  price_source_url: string | null;
  price_accessed_at: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  total_reasoning_tokens: number;
  total_cached_input_tokens: number;
  estimated_total_cost_usd: number | null;
  estimated_cost_per_case_usd: number | null;
  cases_priced: number;
}

/** Descriptive-only signal/evidence-strength read per supplemental case. NEVER an input to any hard gate. */
export interface SupplementalDescriptiveCase {
  case_id: string;
  predicted_disposition: string | null;
  predicted_signals: readonly string[] | null;
  predicted_evidence_strength: string | null;
  /**
   * Descriptive flag: the candidate reported `strong` evidence_strength on a
   * case this pack's own construction ties to genuinely thin/ambiguous
   * evidence. Surfaced prominently, never silently dropped, and NEVER treated
   * as a redefinition of the locked main-holdout critical-invariant gate
   * (`no_fabricated_strong_evidence` there runs only against the main
   * holdout, unchanged).
   */
  concerning_fabricated_strong_evidence: boolean;
}

export interface SupplementalScore {
  candidate_id: string;
  provider_id: string;
  requested_model: string;
  pack_version: string;
  pack_digest: string;
  case_ids: readonly string[];
  /** Non-null refuses any Stage-2 verdict from this evidence — identity conflict or pack drift. */
  invalidated_reason: string | null;
  identity_conflicts: string[];
  /** Effective inference config actually used (from the first settled row) — bound into Stage-2 identity alongside the main holdout's own. */
  inference_config: EffectiveInferenceConfig | null;
  disposition_strict: StrictSingleLabelReport;
  descriptive: SupplementalDescriptiveCase[];
  reliability: SupplementalReliabilityReport;
  latency: LatencySummary;
  economics: SupplementalEconomicsReport;
}

export interface SupplementalScoreInput {
  candidateId: string;
  providerId: string;
  requestedModel: string;
  results: readonly SupplementalCaseResult[];
  priceBook: PriceBook | null;
}

/**
 * Reduces a raw supplemental result stream to exactly one row per frozen case
 * id, refusing (never silently picking a side) when two rows for the same
 * case disagree about requested model/inference-config digest, or when any
 * relevant row was computed against a DIFFERENT `pack_digest` than the pack
 * currently on disk under the same `pack_version` (pack drift).
 */
function normaliseSupplementalResults(input: SupplementalScoreInput): {
  byCaseId: Map<string, SupplementalCaseResult>;
  identityConflicts: string[];
  driftDetected: boolean;
} {
  const pack = supplementalPackManifest();
  const rowsByCase = new Map<string, SupplementalCaseResult[]>();
  let driftDetected = false;
  for (const result of input.results) {
    if (result.candidate_id !== input.candidateId) continue;
    if (!pack.case_ids.includes(result.case_id)) continue;
    if (result.pack_version === pack.pack_version && result.pack_digest !== pack.digest) {
      driftDetected = true;
      continue;
    }
    if (result.pack_version !== pack.pack_version) continue;
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

function buildReliability(
  cases: readonly SupplementalCase[],
  byCaseId: Map<string, SupplementalCaseResult>,
): SupplementalReliabilityReport {
  const results = cases
    .map((c) => byCaseId.get(c.case_id))
    .filter((r): r is SupplementalCaseResult => !!r);
  const missingKey = results.filter((r) => r.status === "not_run_missing_key").length;
  const unavailable = results.filter((r) => r.status === "unavailable").length;
  const attempted = results.filter(
    (r) =>
      r.status !== "not_run_missing_key" && r.status !== "unavailable" && r.status !== "dry_run",
  );
  const firstPass = attempted.filter((r) => r.first_pass_schema_valid).length;
  const retries = attempted.filter((r) => r.retry_used).length;
  const finalValid = attempted.filter((r) => r.final_schema_valid).length;
  const providerErrors = attempted.filter((r) => r.status === "provider_error").length;
  const timeouts = attempted.filter((r) => r.status === "timeout").length;
  const returned = new Set<string>();
  for (const r of attempted)
    for (const a of r.attempts) if (a.returned_model) returned.add(a.returned_model);

  return {
    cases_selected: cases.length,
    cases_attempted: attempted.length,
    cases_not_run_missing_key: missingKey,
    cases_unavailable: unavailable,
    first_pass_schema_valid: firstPass,
    first_pass_schema_valid_rate: rate(firstPass, attempted.length),
    retries_used: retries,
    retry_rate: rate(retries, attempted.length),
    final_schema_valid: finalValid,
    final_schema_valid_rate: rate(finalValid, attempted.length),
    provider_errors: providerErrors,
    provider_error_rate: rate(providerErrors, attempted.length),
    timeouts,
    timeout_rate: rate(timeouts, attempted.length),
    returned_models: [...returned].sort(),
    all_six_completed:
      attempted.length === SUPPLEMENTAL_PACK_SIZE && cases.length === SUPPLEMENTAL_PACK_SIZE,
  };
}

function buildEconomics(
  results: readonly SupplementalCaseResult[],
  priceBook: PriceBook | null,
): SupplementalEconomicsReport {
  const billable = results.filter(
    (r) =>
      r.status !== "not_run_missing_key" && r.status !== "unavailable" && r.status !== "dry_run",
  );
  let input = 0;
  let output = 0;
  let reasoning = 0;
  let cached = 0;
  for (const r of billable) {
    for (const a of r.attempts) {
      input += a.usage.input_tokens ?? 0;
      output += a.usage.output_tokens ?? 0;
      reasoning += a.usage.reasoning_tokens ?? 0;
      cached += a.usage.cached_input_tokens ?? 0;
    }
  }

  if (!priceBook) {
    return {
      pricing_basis: "no_pricing_metadata",
      price_source: null,
      price_source_url: null,
      price_accessed_at: null,
      total_input_tokens: input,
      total_output_tokens: output,
      total_reasoning_tokens: reasoning,
      total_cached_input_tokens: cached,
      estimated_total_cost_usd: null,
      estimated_cost_per_case_usd: null,
      cases_priced: 0,
    };
  }

  const total = estimateCaseCostUsd(priceBook, {
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
    cachedInputTokens: cached,
  });
  const pricingBasis: SupplementalEconomicsReport["pricing_basis"] =
    total === null ? "unverified" : "estimated_from_published_prices";
  const perCase = billable.length === 0 || total === null ? null : total / billable.length;

  return {
    pricing_basis: pricingBasis,
    price_source: priceBook.source,
    price_source_url: priceBook.source_url,
    price_accessed_at: priceBook.accessed_at,
    total_input_tokens: input,
    total_output_tokens: output,
    total_reasoning_tokens: reasoning,
    total_cached_input_tokens: cached,
    estimated_total_cost_usd: total,
    estimated_cost_per_case_usd: perCase,
    cases_priced: billable.length,
  };
}

/**
 * Scores exactly the 6 frozen supplemental cases for one candidate.
 *
 * `disposition_strict` is built via the ordinary, unmodified `scoreSingleLabel`
 * primitive over ALL 6 cases (a missing/invalid prediction scores as
 * `"(invalid)"`, never silently excluded) — the caller
 * (`scoring/targets-v2.ts`'s `evaluateStage2DispositionMacroF1Target`) merges
 * this report's `confusion` counts with the main holdout's own, purely by
 * cell-wise addition. Nothing here ever redefines what "strict" or "gold"
 * means for the main holdout.
 */
export function scoreSupplementalPack(input: SupplementalScoreInput): SupplementalScore {
  const cases = loadSupplementalAmbiguityPack();
  const pack = supplementalPackManifest();
  const { byCaseId, identityConflicts, driftDetected } = normaliseSupplementalResults(input);
  const results = [...byCaseId.values()];

  const pairs = cases.map((c) => {
    const result = byCaseId.get(c.case_id);
    const prediction = result ? predictionForSupplemental(result) : null;
    return { gold: c.expected.disposition as string, predicted: prediction?.disposition ?? null };
  });
  const dispositionStrict: StrictSingleLabelReport = {
    ...scoreSingleLabel(DISPOSITIONS, pairs),
    excluded_multi_answer_cases: 0,
  };

  const descriptive: SupplementalDescriptiveCase[] = cases.map((c) => {
    const result = byCaseId.get(c.case_id);
    const prediction = result ? predictionForSupplemental(result) : null;
    return {
      case_id: c.case_id,
      predicted_disposition: prediction?.disposition ?? null,
      predicted_signals: prediction?.signals ?? null,
      predicted_evidence_strength: prediction?.evidence_strength ?? null,
      // Descriptive supplemental-safety signal only (never a gate): the
      // candidate claimed `strong` evidence on a case this pack's own
      // gold_rationale ties to deliberately sparse/ambiguous evidence.
      concerning_fabricated_strong_evidence: prediction?.evidence_strength === "strong",
    };
  });

  const succeeded = results.filter((r) => r.status === "ok" && r.final_schema_valid);
  const latency = summariseLatency(succeeded.map((r) => r.total_latency_ms));

  let invalidatedReason: string | null = null;
  if (identityConflicts.length > 0) {
    invalidatedReason = `refusing to score ${identityConflicts.length} supplemental case(s) with incompatible result rows under one run id: ${identityConflicts.join(", ")}. Rerun the supplemental pack under a fresh run id.`;
  } else if (driftDetected) {
    invalidatedReason = `SUPPLEMENTAL_PACK_DRIFT_DETECTED: at least one stored supplemental result was computed against pack "${pack.pack_version}" with a digest that does not match the pack currently on disk (${pack.digest}). Refusing to present a Stage-2 verdict from this evidence.`;
  }

  return {
    candidate_id: input.candidateId,
    provider_id: input.providerId,
    requested_model: input.requestedModel,
    pack_version: pack.pack_version,
    pack_digest: pack.digest,
    case_ids: pack.case_ids,
    invalidated_reason: invalidatedReason,
    identity_conflicts: identityConflicts,
    inference_config: results[0]?.inference_config ?? null,
    disposition_strict: dispositionStrict,
    descriptive,
    reliability: buildReliability(cases, byCaseId),
    latency,
    economics: buildEconomics(results, input.priceBook),
  };
}
