/**
 * Scoring v2 — the scoring-integrity correction.
 *
 * SEE `scoring-version.ts` for the audit finding this file fixes. The short
 * version: `score.ts` (v1, UNCHANGED, preserved for history) rewrites the
 * gold value used in its confusion matrix to match an accepted alternative
 * prediction, which makes per-class SUPPORT depend on what the candidate
 * predicted. This file never does that. It reports two candidate-independent
 * metric families per field instead:
 *
 *  - METRIC FAMILY A (`acceptable_answer`): correctness over ALL cases —
 *    correct iff prediction == primary gold OR prediction is in the case's
 *    declared acceptable set. Support is simply `n` (case count). Nothing
 *    about "gold" is ever rewritten here; this is a boolean per case.
 *  - METRIC FAMILY B (`strict`): ordinary precision/recall/F1 computed ONLY
 *    over cases whose gold is single-valued for that field (no genuine
 *    acceptable alternative exists), always using the untouched PRIMARY gold
 *    value. Class/label support in this family is 100% corpus-derived: which
 *    cases are "strict" depends only on the corpus's own `acceptable`
 *    declarations, never on any candidate's prediction.
 *
 * Reliability, the critical-invariant hard gate, latency and economics are
 * unaffected by the v1 defect (none of them touch `effectiveGold`), so this
 * module reuses `scoring/score.ts`'s exported builders for those rather than
 * forking a second implementation that could silently drift.
 */
import type { CorpusCase } from "../corpus/schema";
import type { CaseResult } from "../run/types";
import type { EffectiveInferenceConfig } from "../config/inference-config";
import {
  COMPENSATION_STRUCTURES,
  DISPOSITIONS,
  EVIDENCE_STRENGTHS,
  SIGNALS,
  THREAD_STATES,
} from "../taxonomy";
import {
  acceptableSignalSetKeys,
  acceptableValueSet,
  isAcceptableCorrect,
  isAcceptableCorrectSignals,
  isStrictSignalSet,
  isStrictSingleLabel,
  primarySignals,
} from "./acceptable";
import {
  scoreMultiLabel,
  scoreSingleLabel,
  summariseLatency,
  type LatencySummary,
  type MultiLabelReport,
  type SingleLabelReport,
} from "./metrics";
import {
  buildCriticalSuite,
  buildEconomics,
  buildReliability,
  normaliseResults,
  predictionFor,
  type CandidateScore,
  type EconomicsReport,
  type ReliabilityReport,
  type ScoreInput,
} from "./score";
import { SCORING_VERSION_V2 } from "./scoring-version";

function safeDiv(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function round(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export interface AcceptableAnswerReport {
  /** Case count — corpus-derived, identical for every candidate. */
  n: number;
  correct: number;
  accuracy: number;
}

export interface StrictSingleLabelReport extends SingleLabelReport {
  /** Cases excluded because D072 genuinely permits more than one gold answer for this field. */
  excluded_multi_answer_cases: number;
}

export interface SingleLabelFieldScoreV2 {
  acceptable_answer: AcceptableAnswerReport;
  strict: StrictSingleLabelReport;
}

export interface StrictSignalReport extends MultiLabelReport {
  excluded_multi_answer_cases: number;
}

export interface SignalFieldScoreV2 {
  /** Family A: exact-set correctness against the acceptable set, over ALL cases. */
  acceptable_set: AcceptableAnswerReport;
  strict: StrictSignalReport;
}

interface SingleLabelEntry {
  primary: string;
  acceptable: readonly string[] | undefined;
  predicted: string | null;
}

function buildSingleLabelFieldV2(
  classes: readonly string[],
  entries: readonly SingleLabelEntry[],
): SingleLabelFieldScoreV2 {
  let correct = 0;
  const strictPairs: { gold: string; predicted: string | null }[] = [];
  let excluded = 0;
  for (const e of entries) {
    if (isAcceptableCorrect(e.primary, e.acceptable, e.predicted)) correct += 1;
    if (isStrictSingleLabel(e.primary, e.acceptable)) {
      strictPairs.push({ gold: e.primary, predicted: e.predicted });
    } else {
      excluded += 1;
    }
  }
  const strictReport = scoreSingleLabel(classes, strictPairs);
  return {
    acceptable_answer: {
      n: entries.length,
      correct,
      accuracy: round(safeDiv(correct, entries.length)),
    },
    strict: { ...strictReport, excluded_multi_answer_cases: excluded },
  };
}

interface SignalEntry {
  primary: readonly string[];
  acceptable: readonly (readonly string[])[] | undefined;
  predicted: readonly string[] | null;
}

function buildSignalFieldV2(
  labels: readonly string[],
  entries: readonly SignalEntry[],
): SignalFieldScoreV2 {
  let correct = 0;
  const strictPairs: { gold: string[]; predicted: string[] | null }[] = [];
  let excluded = 0;
  for (const e of entries) {
    if (isAcceptableCorrectSignals(e.primary, e.acceptable, e.predicted)) correct += 1;
    if (isStrictSignalSet(e.primary, e.acceptable)) {
      strictPairs.push({
        gold: primarySignals(e.primary),
        predicted: e.predicted ? [...e.predicted] : null,
      });
    } else {
      excluded += 1;
    }
  }
  const strictReport = scoreMultiLabel(labels, strictPairs);
  return {
    acceptable_set: {
      n: entries.length,
      correct,
      accuracy: round(safeDiv(correct, entries.length)),
    },
    strict: { ...strictReport, excluded_multi_answer_cases: excluded },
  };
}

/**
 * Corpus-derived per-class support over the FULL case set (every case,
 * strict or not), keyed by primary gold only. Used to decide which classes
 * are "expected to participate" in a macro-F1 hard gate — this NEVER reads a
 * prediction, so it cannot vary by candidate (acceptance test: "class
 * support is corpus-derived, never candidate-derived").
 */
export function fullCorpusSupport(primaryValues: readonly string[]): Record<string, number> {
  const support: Record<string, number> = {};
  for (const v of primaryValues) support[v] = (support[v] ?? 0) + 1;
  return support;
}

/** Signal analogue of `fullCorpusSupport`: counts case-level membership, not occurrences. */
export function fullCorpusSignalSupport(
  primarySignalSets: readonly (readonly string[])[],
): Record<string, number> {
  const support: Record<string, number> = {};
  for (const set of primarySignalSets) {
    for (const label of primarySignals(set)) support[label] = (support[label] ?? 0) + 1;
  }
  return support;
}

export interface CandidateScoreV2 {
  scoring_version: typeof SCORING_VERSION_V2;
  candidate_id: string;
  provider_id: string;
  requested_model: string;
  corpus_version: string;
  prompt_version: string;
  schema_version: string;
  invalidated_reason: string | null;
  identity_conflicts: string[];
  inference_config: EffectiveInferenceConfig | null;
  reliability: ReliabilityReport;
  critical_suite: CandidateScore["critical_suite"];
  message_task: {
    n: number;
    disposition: SingleLabelFieldScoreV2;
    disposition_full_support: Record<string, number>;
    signals: SignalFieldScoreV2;
    signals_full_support: Record<string, number>;
    evidence_strength: SingleLabelFieldScoreV2;
  } | null;
  thread_task: {
    n: number;
    thread_state: SingleLabelFieldScoreV2;
    thread_state_full_support: Record<string, number>;
    compensation_structure: SingleLabelFieldScoreV2;
    compensation_structure_full_support: Record<string, number>;
    evidence_strength: SingleLabelFieldScoreV2;
    /** D072 §8's single most dangerous confusion — unaffected by the acceptable-set defect, counted against PRIMARY gold exactly as v1. */
    unknown_predicted_as_unpaid: number;
    unpaid_predicted_as_unknown: number;
  } | null;
  latency: LatencySummary;
  latency_excluded_failed_calls: number;
  economics: EconomicsReport;
}

function buildMessageTaskV2(
  cases: readonly CorpusCase[],
  byCaseId: Map<string, CaseResult>,
): CandidateScoreV2["message_task"] {
  const messageCases = cases.filter((c) => c.task === "message");
  if (messageCases.length === 0) return null;

  const dispositionEntries: SingleLabelEntry[] = [];
  const strengthEntries: SingleLabelEntry[] = [];
  const signalEntries: SignalEntry[] = [];

  for (const c of messageCases) {
    if (c.task !== "message") continue;
    const result = byCaseId.get(c.case_id);
    const prediction = result ? predictionFor(result) : null;
    const message = prediction && "disposition" in prediction ? prediction : null;

    dispositionEntries.push({
      primary: c.expected.disposition,
      acceptable: c.acceptable?.disposition,
      predicted: message?.disposition ?? null,
    });
    strengthEntries.push({
      primary: c.expected.evidence_strength,
      acceptable: c.acceptable?.evidence_strength,
      predicted: message?.evidence_strength ?? null,
    });
    signalEntries.push({
      primary: c.expected.signals,
      acceptable: c.acceptable?.signals,
      predicted: message ? message.signals : null,
    });
  }

  return {
    n: messageCases.length,
    disposition: buildSingleLabelFieldV2(DISPOSITIONS, dispositionEntries),
    disposition_full_support: fullCorpusSupport(dispositionEntries.map((e) => e.primary)),
    signals: buildSignalFieldV2(SIGNALS, signalEntries),
    signals_full_support: fullCorpusSignalSupport(signalEntries.map((e) => e.primary)),
    evidence_strength: buildSingleLabelFieldV2(EVIDENCE_STRENGTHS, strengthEntries),
  };
}

function buildThreadTaskV2(
  cases: readonly CorpusCase[],
  byCaseId: Map<string, CaseResult>,
): CandidateScoreV2["thread_task"] {
  const threadCases = cases.filter((c) => c.task === "thread");
  if (threadCases.length === 0) return null;

  const stateEntries: SingleLabelEntry[] = [];
  const compEntries: SingleLabelEntry[] = [];
  const strengthEntries: SingleLabelEntry[] = [];
  let unknownAsUnpaid = 0;
  let unpaidAsUnknown = 0;

  for (const c of threadCases) {
    if (c.task !== "thread") continue;
    const result = byCaseId.get(c.case_id);
    const prediction = result ? predictionFor(result) : null;
    const thread = prediction && "thread_state" in prediction ? prediction : null;

    stateEntries.push({
      primary: c.expected.thread_state,
      acceptable: c.acceptable?.thread_state,
      predicted: thread?.thread_state ?? null,
    });
    compEntries.push({
      primary: c.expected.compensation_structure,
      acceptable: c.acceptable?.compensation_structure,
      predicted: thread?.compensation_structure ?? null,
    });
    strengthEntries.push({
      primary: c.expected.evidence_strength,
      acceptable: c.acceptable?.evidence_strength,
      predicted: thread?.evidence_strength ?? null,
    });

    // Counted against PRIMARY gold, exactly as v1 — never an acceptable
    // alternative, this confusion is a critical-safety count, not a
    // per-class-support metric.
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
    thread_state: buildSingleLabelFieldV2(THREAD_STATES, stateEntries),
    thread_state_full_support: fullCorpusSupport(stateEntries.map((e) => e.primary)),
    compensation_structure: buildSingleLabelFieldV2(COMPENSATION_STRUCTURES, compEntries),
    compensation_structure_full_support: fullCorpusSupport(compEntries.map((e) => e.primary)),
    evidence_strength: buildSingleLabelFieldV2(EVIDENCE_STRENGTHS, strengthEntries),
    unknown_predicted_as_unpaid: unknownAsUnpaid,
    unpaid_predicted_as_unknown: unpaidAsUnknown,
  };
}

/**
 * Scoring v2 entry point. Same `ScoreInput` shape as v1's `scoreCandidate` —
 * scoring is a pure downstream interpretation of the same raw evidence, so
 * both scorers can run over the identical `results.jsonl` with no re-run.
 */
export function scoreCandidateV2(input: ScoreInput): CandidateScoreV2 {
  const { byCaseId, identityConflicts } = normaliseResults(input);
  const results = [...byCaseId.values()];

  const reliability = buildReliability(input.cases, byCaseId);
  const criticalSuite = buildCriticalSuite(input.cases, byCaseId);
  const messageTask = buildMessageTaskV2(input.cases, byCaseId);
  const threadTask = buildThreadTaskV2(input.cases, byCaseId);

  const succeeded = results.filter((r) => r.status === "ok" && r.final_schema_valid);
  const latency = summariseLatency(succeeded.map((r) => r.total_latency_ms));
  const latencyExcluded = results.filter(
    (r) => r.status === "provider_error" || r.status === "timeout" || r.status === "schema_failed",
  ).length;

  const modelDrift = input.providerId !== "local" && reliability.returned_models.length > 1;

  let invalidatedReason: string | null = null;
  if (identityConflicts.length > 0) {
    const shown = identityConflicts.slice(0, 5).join(", ");
    const more = identityConflicts.length > 5 ? `, +${identityConflicts.length - 5} more` : "";
    invalidatedReason = `refusing to score ${identityConflicts.length} case(s) with incompatible result rows under one run id (requested model or inference-config digest changed without a version bump): ${shown}${more}. Rerun this candidate under a fresh run id instead of resuming across the identity change.`;
  } else if (modelDrift) {
    invalidatedReason = `refusing to combine into one score: the provider returned ${reliability.returned_models.length} distinct model versions across cases for candidate "${input.candidateId}" (${reliability.returned_models.join(", ")}). Split the comparison per returned model or rerun the candidate.`;
  }

  return {
    scoring_version: SCORING_VERSION_V2,
    candidate_id: input.candidateId,
    provider_id: input.providerId,
    requested_model: input.requestedModel,
    corpus_version: input.corpusVersion,
    prompt_version: input.promptVersion,
    schema_version: input.schemaVersion,
    invalidated_reason: invalidatedReason,
    identity_conflicts: identityConflicts,
    inference_config: results[0]?.inference_config ?? null,
    reliability,
    critical_suite: invalidatedReason
      ? { ...criticalSuite, passes_hard_gate: false }
      : criticalSuite,
    message_task: messageTask,
    thread_task: threadTask,
    latency,
    latency_excluded_failed_calls: latencyExcluded,
    economics: buildEconomics(results, input.priceBook),
  };
}

// Re-exported for tests and for `acceptableValueSet`/`acceptableSignalSetKeys`
// callers that only need the corpus-derived value sets themselves.
export { acceptableValueSet, acceptableSignalSetKeys };
