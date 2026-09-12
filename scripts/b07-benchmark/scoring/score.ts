/**
 * Candidate scoring: semantic quality, critical safety, reliability,
 * performance and economics — reported side by side, never blended.
 */
import type { CorpusCase } from "../corpus/schema";
import type { PriceBook } from "../config/pricing";
import { estimateCaseCostUsd } from "../config/pricing";
import type { CaseResult } from "../run/types";
import type { MessageOutput, ThreadOutput } from "../schema";
import {
  COMPENSATION_STRUCTURES,
  DISPOSITIONS,
  EVIDENCE_STRENGTHS,
  SIGNALS,
  THREAD_STATES,
  canonicalizeSignals,
  signalSetKey,
} from "../taxonomy";
import { evaluateInvariants } from "./invariants";
import type { InvariantViolation } from "./invariants";
import {
  scoreMultiLabel,
  scoreSingleLabel,
  summariseLatency,
  type LatencySummary,
  type MultiLabelReport,
  type SingleLabelReport,
} from "./metrics";

/**
 * Resolve the effective gold for one field against the case's acceptable set.
 *
 * When D072 genuinely permits more than one answer, a prediction inside the
 * acceptable set is scored as if it were the gold answer. This is the fix for
 * "multiple acceptable answers scored falsely wrong" — and it is applied
 * identically to every candidate, including the baseline.
 */
function effectiveGold(
  goldPrimary: string,
  acceptable: readonly string[] | undefined,
  predicted: string | null,
): string {
  if (predicted === null) return goldPrimary;
  if (predicted === goldPrimary) return goldPrimary;
  if (acceptable && acceptable.includes(predicted)) return predicted;
  return goldPrimary;
}

function effectiveGoldSignals(
  goldPrimary: readonly string[],
  acceptable: readonly (readonly string[])[] | undefined,
  predicted: readonly string[] | null,
): string[] {
  const primary = canonicalizeSignals(goldPrimary);
  if (predicted === null) return primary;
  const predictedKey = signalSetKey(predicted);
  if (predictedKey === signalSetKey(primary)) return primary;
  if (acceptable) {
    const match = acceptable.find((set) => signalSetKey(set) === predictedKey);
    if (match) return canonicalizeSignals(match);
  }
  return primary;
}

export interface ReliabilityReport {
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
  /** Distinct model/version strings the provider actually returned. */
  returned_models: string[];
}

export interface EconomicsReport {
  pricing_basis: "estimated_from_published_prices" | "no_pricing_metadata";
  price_source: string | null;
  price_source_url: string | null;
  price_accessed_at: string | null;
  /** Includes tokens burned by failed attempts and retries. */
  total_input_tokens: number;
  total_output_tokens: number;
  total_reasoning_tokens: number;
  estimated_total_cost_usd: number | null;
  estimated_cost_per_case_usd: number | null;
  estimated_cost_per_1k_messages_usd: number | null;
  estimated_cost_per_1k_threads_usd: number | null;
  cases_priced: number;
}

export interface CandidateScore {
  candidate_id: string;
  provider_id: string;
  requested_model: string;
  corpus_version: string;
  prompt_version: string;
  schema_version: string;
  reliability: ReliabilityReport;
  critical_suite: {
    cases: number;
    cases_evaluated: number;
    cases_not_evaluated: number;
    violations: number;
    violations_by_invariant: Record<string, number>;
    violation_details: InvariantViolation[];
    passes_hard_gate: boolean;
  };
  message_task: {
    n: number;
    disposition: SingleLabelReport;
    signals: MultiLabelReport;
    evidence_strength: SingleLabelReport;
  } | null;
  thread_task: {
    n: number;
    thread_state: SingleLabelReport;
    compensation_structure: SingleLabelReport;
    evidence_strength: SingleLabelReport;
    /** D072 §8's single most dangerous confusion, counted explicitly. */
    unknown_predicted_as_unpaid: number;
    unpaid_predicted_as_unknown: number;
  } | null;
  latency: LatencySummary;
  latency_excluded_failed_calls: number;
  economics: EconomicsReport;
}

function predictionFor(result: CaseResult): MessageOutput | ThreadOutput | null {
  // A provider exception or an unparsable body NEVER becomes a semantic
  // prediction. Only a schema-valid parse populates `prediction`.
  return result.status === "ok" && result.final_schema_valid ? result.prediction : null;
}

export interface ScoreInput {
  candidateId: string;
  providerId: string;
  requestedModel: string;
  corpusVersion: string;
  promptVersion: string;
  schemaVersion: string;
  cases: readonly CorpusCase[];
  results: readonly CaseResult[];
  priceBook: PriceBook | null;
}

/**
 * Reduce a raw result stream to exactly one row per selected case.
 *
 * Three separate hostile-review defects live here, and all three are fixed by
 * the same normalisation:
 *
 *  - REPLAY: a resumed run re-runs non-terminal work and APPENDS it, so
 *    `results.jsonl` can legitimately hold two rows for one candidate/case
 *    pair. Counting both would double-charge its tokens and double-count its
 *    reliability. The last row wins, because it is the one that settled.
 *  - VERSIONING: a row computed under a different prompt/schema/corpus version
 *    is not comparable and is dropped rather than silently mixed in.
 *  - IDENTITY: a row for a case outside the current selection (for example a
 *    `--critical-only` run reported against the full corpus) is dropped, so
 *    economics and latency cover the selection they claim to cover.
 */
function normaliseResults(input: ScoreInput): Map<string, CaseResult> {
  const selected = new Set(input.cases.map((c) => c.case_id));
  const byCaseId = new Map<string, CaseResult>();
  for (const result of input.results) {
    if (result.candidate_id !== input.candidateId) continue;
    if (!selected.has(result.case_id)) continue;
    if (
      result.corpus_version !== input.corpusVersion ||
      result.prompt_version !== input.promptVersion ||
      result.schema_version !== input.schemaVersion
    ) {
      continue;
    }
    byCaseId.set(result.case_id, result);
  }
  return byCaseId;
}

export function scoreCandidate(input: ScoreInput): CandidateScore {
  const byCaseId = normaliseResults(input);
  const results = [...byCaseId.values()];

  const reliability = buildReliability(input.cases, byCaseId);
  const criticalSuite = buildCriticalSuite(input.cases, byCaseId);
  const messageTask = buildMessageTask(input.cases, byCaseId);
  const threadTask = buildThreadTask(input.cases, byCaseId);

  const succeeded = results.filter((r) => r.status === "ok" && r.final_schema_valid);
  const latency = summariseLatency(succeeded.map((r) => r.total_latency_ms));
  const latencyExcluded = results.filter(
    (r) => r.status === "provider_error" || r.status === "timeout" || r.status === "schema_failed",
  ).length;

  return {
    candidate_id: input.candidateId,
    provider_id: input.providerId,
    requested_model: input.requestedModel,
    corpus_version: input.corpusVersion,
    prompt_version: input.promptVersion,
    schema_version: input.schemaVersion,
    reliability,
    critical_suite: criticalSuite,
    message_task: messageTask,
    thread_task: threadTask,
    latency,
    latency_excluded_failed_calls: latencyExcluded,
    economics: buildEconomics(results, input.priceBook),
  };
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 10000) / 10000;
}

function buildReliability(
  cases: readonly CorpusCase[],
  byCaseId: Map<string, CaseResult>,
): ReliabilityReport {
  const results = cases.map((c) => byCaseId.get(c.case_id)).filter((r): r is CaseResult => !!r);
  const missingKey = results.filter((r) => r.status === "not_run_missing_key").length;
  const unavailable = results.filter((r) => r.status === "unavailable").length;
  // Rates are computed over calls actually ATTEMPTED. A model that was never
  // called has no reliability figure, it has an absence.
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
  for (const r of attempted) {
    for (const a of r.attempts) if (a.returned_model) returned.add(a.returned_model);
  }

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
  };
}

function buildCriticalSuite(
  cases: readonly CorpusCase[],
  byCaseId: Map<string, CaseResult>,
): CandidateScore["critical_suite"] {
  const suite = cases.filter((c) => c.critical_invariants.length > 0);
  const details: InvariantViolation[] = [];
  let evaluated = 0;
  for (const c of suite) {
    const result = byCaseId.get(c.case_id);
    const prediction = result ? predictionFor(result) : null;
    if (!prediction) continue; // no prediction cannot violate — but it also cannot pass
    evaluated += 1;
    details.push(...evaluateInvariants(c, prediction));
  }
  const byInvariant: Record<string, number> = {};
  for (const v of details) byInvariant[v.invariant_id] = (byInvariant[v.invariant_id] ?? 0) + 1;
  return {
    cases: suite.length,
    cases_evaluated: evaluated,
    cases_not_evaluated: suite.length - evaluated,
    violations: details.length,
    violations_by_invariant: byInvariant,
    violation_details: details,
    // A candidate only clears the hard gate when it produced a prediction for
    // every critical case AND violated nothing. Silence is not safety.
    passes_hard_gate: details.length === 0 && evaluated === suite.length && suite.length > 0,
  };
}

function buildMessageTask(
  cases: readonly CorpusCase[],
  byCaseId: Map<string, CaseResult>,
): CandidateScore["message_task"] {
  const messageCases = cases.filter((c) => c.task === "message");
  if (messageCases.length === 0) return null;

  const dispositionPairs: { gold: string; predicted: string | null }[] = [];
  const strengthPairs: { gold: string; predicted: string | null }[] = [];
  const signalPairs: { gold: string[]; predicted: string[] | null }[] = [];

  for (const c of messageCases) {
    if (c.task !== "message") continue;
    const result = byCaseId.get(c.case_id);
    const prediction = result ? predictionFor(result) : null;
    const message = prediction && "disposition" in prediction ? prediction : null;

    dispositionPairs.push({
      gold: effectiveGold(
        c.expected.disposition,
        c.acceptable?.disposition,
        message?.disposition ?? null,
      ),
      predicted: message?.disposition ?? null,
    });
    strengthPairs.push({
      gold: effectiveGold(
        c.expected.evidence_strength,
        c.acceptable?.evidence_strength,
        message?.evidence_strength ?? null,
      ),
      predicted: message?.evidence_strength ?? null,
    });
    const predictedSignals = message ? canonicalizeSignals(message.signals) : null;
    signalPairs.push({
      gold: effectiveGoldSignals(c.expected.signals, c.acceptable?.signals, predictedSignals),
      predicted: predictedSignals,
    });
  }

  return {
    n: messageCases.length,
    disposition: scoreSingleLabel(DISPOSITIONS, dispositionPairs),
    signals: scoreMultiLabel(SIGNALS, signalPairs),
    evidence_strength: scoreSingleLabel(EVIDENCE_STRENGTHS, strengthPairs),
  };
}

function buildThreadTask(
  cases: readonly CorpusCase[],
  byCaseId: Map<string, CaseResult>,
): CandidateScore["thread_task"] {
  const threadCases = cases.filter((c) => c.task === "thread");
  if (threadCases.length === 0) return null;

  const statePairs: { gold: string; predicted: string | null }[] = [];
  const compPairs: { gold: string; predicted: string | null }[] = [];
  const strengthPairs: { gold: string; predicted: string | null }[] = [];
  let unknownAsUnpaid = 0;
  let unpaidAsUnknown = 0;

  for (const c of threadCases) {
    if (c.task !== "thread") continue;
    const result = byCaseId.get(c.case_id);
    const prediction = result ? predictionFor(result) : null;
    const thread = prediction && "thread_state" in prediction ? prediction : null;

    statePairs.push({
      gold: effectiveGold(
        c.expected.thread_state,
        c.acceptable?.thread_state,
        thread?.thread_state ?? null,
      ),
      predicted: thread?.thread_state ?? null,
    });
    compPairs.push({
      gold: effectiveGold(
        c.expected.compensation_structure,
        c.acceptable?.compensation_structure,
        thread?.compensation_structure ?? null,
      ),
      predicted: thread?.compensation_structure ?? null,
    });
    strengthPairs.push({
      gold: effectiveGold(
        c.expected.evidence_strength,
        c.acceptable?.evidence_strength,
        thread?.evidence_strength ?? null,
      ),
      predicted: thread?.evidence_strength ?? null,
    });

    // Counted against the PRIMARY gold, not the acceptable-set-resolved gold:
    // this confusion is never an acceptable alternative answer.
    if (
      c.expected.compensation_structure === "unknown" &&
      thread?.compensation_structure === "unpaid"
    ) {
      unknownAsUnpaid += 1;
    }
    if (
      c.expected.compensation_structure === "unpaid" &&
      thread?.compensation_structure === "unknown"
    ) {
      unpaidAsUnknown += 1;
    }
  }

  return {
    n: threadCases.length,
    thread_state: scoreSingleLabel(THREAD_STATES, statePairs),
    compensation_structure: scoreSingleLabel(COMPENSATION_STRUCTURES, compPairs),
    evidence_strength: scoreSingleLabel(EVIDENCE_STRENGTHS, strengthPairs),
    unknown_predicted_as_unpaid: unknownAsUnpaid,
    unpaid_predicted_as_unknown: unpaidAsUnknown,
  };
}

function buildEconomics(
  results: readonly CaseResult[],
  priceBook: PriceBook | null,
): EconomicsReport {
  // Every attempt counts, including the ones that failed and the retries.
  // A candidate that needs two calls per case costs twice as much.
  const billable = results.filter(
    (r) =>
      r.status !== "not_run_missing_key" && r.status !== "unavailable" && r.status !== "dry_run",
  );
  let input = 0;
  let output = 0;
  let reasoning = 0;
  for (const r of billable) {
    for (const a of r.attempts) {
      input += a.usage.input_tokens ?? 0;
      output += a.usage.output_tokens ?? 0;
      reasoning += a.usage.reasoning_tokens ?? 0;
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
      estimated_total_cost_usd: null,
      estimated_cost_per_case_usd: null,
      estimated_cost_per_1k_messages_usd: null,
      estimated_cost_per_1k_threads_usd: null,
      cases_priced: 0,
    };
  }

  const total = estimateCaseCostUsd(priceBook, {
    inputTokens: input,
    outputTokens: output,
    reasoningTokens: reasoning,
  });
  const messageCases = billable.filter((r) => r.task === "message").length;
  const threadCases = billable.filter((r) => r.task === "thread").length;
  const perCase = billable.length === 0 ? null : total / billable.length;

  const perThousandForTask = (task: "message" | "thread"): number | null => {
    const taskResults = billable.filter((r) => r.task === task);
    if (taskResults.length === 0) return null;
    let i = 0;
    let o = 0;
    let t = 0;
    for (const r of taskResults) {
      for (const a of r.attempts) {
        i += a.usage.input_tokens ?? 0;
        o += a.usage.output_tokens ?? 0;
        t += a.usage.reasoning_tokens ?? 0;
      }
    }
    const cost = estimateCaseCostUsd(priceBook, {
      inputTokens: i,
      outputTokens: o,
      reasoningTokens: t,
    });
    return (cost / taskResults.length) * 1000;
  };

  return {
    pricing_basis: "estimated_from_published_prices",
    price_source: priceBook.source,
    price_source_url: priceBook.source_url,
    price_accessed_at: priceBook.accessed_at,
    total_input_tokens: input,
    total_output_tokens: output,
    total_reasoning_tokens: reasoning,
    estimated_total_cost_usd: total,
    estimated_cost_per_case_usd: perCase,
    estimated_cost_per_1k_messages_usd: messageCases === 0 ? null : perThousandForTask("message"),
    estimated_cost_per_1k_threads_usd: threadCases === 0 ? null : perThousandForTask("thread"),
    cases_priced: billable.length,
  };
}
