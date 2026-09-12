/**
 * The benchmark runner.
 *
 * Guarantees this file is responsible for:
 *
 *  - FAIRNESS: every candidate gets the same prompt text, the same logical
 *    schema and the same retry budget (`maxSchemaRetries`, default 1).
 *  - HONESTY: a missing key yields `not_run_missing_key`; an unavailable model
 *    yields `unavailable`; a provider exception yields `provider_error`. None
 *    of those can become a semantic prediction.
 *  - REPLAY: resume reuses a stored result only when candidate, case, corpus,
 *    prompt and schema versions all match. A changed prompt re-runs the case.
 *  - COST/LATENCY HONESTY: every attempt, including failed ones and retries,
 *    is recorded with its own tokens and latency.
 */
import { randomUUID } from "node:crypto";

import { BASELINE_CANDIDATE, hasApiKey, resolveModel, type Candidate } from "../config/candidates";
import {
  effectiveInferenceConfig,
  inferenceConfigDigest,
  type EffectiveInferenceConfig,
} from "../config/inference-config";
import type { CorpusCase } from "../corpus/schema";
import { baselineClassify } from "../baseline/rules-baseline";
import { adapterFor } from "../providers/registry";
import { ProviderCallError, type ProviderResponse } from "../providers/types";
import { collectSecretValues, redactSecrets } from "../../provider-evaluation/redact";
import {
  MESSAGE_JSON_SCHEMA,
  SCHEMA_NAMES,
  THREAD_JSON_SCHEMA,
  B07_BENCHMARK_SCHEMA_VERSION,
  messageOutputZod,
  threadOutputZod,
  type MessageOutput,
  type ThreadOutput,
} from "../schema";
import {
  PROMPT_VERSION,
  buildSystemPrompt,
  buildUserPrompt,
  toCandidateVisibleCase,
} from "../prompt/render";
import { CORPUS_VERSION } from "../corpus/schema";
import { appendResult, readResults } from "./artifacts";
import {
  isTerminalForResume,
  resultCompatibilityKey,
  type CaseAttempt,
  type CaseResult,
} from "./types";

const MAX_OUTPUT_TOKENS = 512;
const DEFAULT_TIMEOUT_MS = 60_000;

export interface RunnerOptions {
  runId: string;
  candidate: Candidate;
  cases: readonly CorpusCase[];
  concurrency: number;
  maxSchemaRetries: number;
  timeoutMs?: number;
  dryRun: boolean;
  resume: boolean;
  log: (...parts: unknown[]) => void;
}

function emptyUsage(): CaseAttempt["usage"] {
  return {
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cached_input_tokens: null,
  };
}

function sumUsage(attempts: readonly CaseAttempt[]): CaseResult["usage_totals"] {
  let input: number | null = null;
  let output: number | null = null;
  let reasoning: number | null = null;
  let cached: number | null = null;
  const add = (current: number | null, next: number | null): number | null =>
    next === null ? current : (current ?? 0) + next;
  for (const a of attempts) {
    input = add(input, a.usage.input_tokens);
    output = add(output, a.usage.output_tokens);
    reasoning = add(reasoning, a.usage.reasoning_tokens);
    cached = add(cached, a.usage.cached_input_tokens);
  }
  return {
    input_tokens: input,
    output_tokens: output,
    reasoning_tokens: reasoning,
    cached_input_tokens: cached,
  };
}

/** Redact known secrets at the exact point an error is normalised into text
 * the harness will persist. Defence in depth beyond the artifact-write
 * boundary — a persisted `error_summary` must never carry a credential even
 * if a future write path forgets to redact. */
function safeErrorSummary(text: string): string {
  return redactSecrets(text, collectSecretValues()).slice(0, 500);
}

/** Parse and validate one raw provider body against the machine schema. */
export function validatePrediction(
  task: "message" | "thread",
  rawText: string | null,
): MessageOutput | ThreadOutput | null {
  if (rawText === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    // Some providers wrap JSON in prose despite a structured-output request.
    // One tolerant extraction attempt, then give up — a body that needs
    // creative recovery is a reliability finding, not a success.
    const start = rawText.indexOf("{");
    const end = rawText.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
      json = JSON.parse(rawText.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  const parsed =
    task === "message" ? messageOutputZod.safeParse(json) : threadOutputZod.safeParse(json);
  return parsed.success ? parsed.data : null;
}

const RETRY_NUDGE =
  "\n\nYour previous response did not match the required structure. Return ONLY the structured object with exactly the required fields and allowed values. No prose.";

async function runOneCase(
  options: RunnerOptions,
  corpusCase: CorpusCase,
  model: string,
  inferenceConfig: EffectiveInferenceConfig,
): Promise<CaseResult> {
  const base = {
    run_id: options.runId,
    candidate_id: options.candidate.id,
    provider_id: options.candidate.providerId,
    requested_model: model,
    inference_config: inferenceConfig,
    inference_config_digest: inferenceConfigDigest(inferenceConfig),
    case_id: corpusCase.case_id,
    task: corpusCase.task,
    split: corpusCase.split,
    corpus_version: CORPUS_VERSION,
    prompt_version: PROMPT_VERSION,
    schema_version: B07_BENCHMARK_SCHEMA_VERSION,
    evaluated_at: new Date().toISOString(),
  };

  // --- Stage 0 baseline: deterministic, local, no provider call. ---------
  if (options.candidate.providerId === "local") {
    const started = Date.now();
    const prediction = baselineClassify(corpusCase);
    const attempt: CaseAttempt = {
      index: 1,
      kind: "initial",
      outcome: "schema_valid",
      http_status: null,
      error_summary: null,
      latency_ms: Date.now() - started,
      usage: emptyUsage(),
      returned_model: options.candidate.model,
    };
    return {
      ...base,
      endpoint: null,
      status: "ok",
      attempts: [attempt],
      first_pass_schema_valid: true,
      retry_used: false,
      final_schema_valid: true,
      prediction,
      total_latency_ms: attempt.latency_ms,
      usage_totals: emptyUsage(),
    };
  }

  const adapter = adapterFor(options.candidate.providerId);
  if (!adapter) {
    return {
      ...base,
      endpoint: null,
      status: "unavailable",
      attempts: [],
      first_pass_schema_valid: false,
      retry_used: false,
      final_schema_valid: false,
      prediction: null,
      total_latency_ms: 0,
      usage_totals: emptyUsage(),
    };
  }

  // --- Missing key: an ABSENCE of evidence, never a failed model. --------
  if (!hasApiKey(options.candidate.providerId)) {
    return {
      ...base,
      endpoint: adapter.endpointFor(model),
      status: "not_run_missing_key",
      attempts: [],
      first_pass_schema_valid: false,
      retry_used: false,
      final_schema_valid: false,
      prediction: null,
      total_latency_ms: 0,
      usage_totals: emptyUsage(),
    };
  }

  if (options.dryRun) {
    return {
      ...base,
      endpoint: adapter.endpointFor(model),
      status: "dry_run",
      attempts: [],
      first_pass_schema_valid: false,
      retry_used: false,
      final_schema_valid: false,
      prediction: null,
      total_latency_ms: 0,
      usage_totals: emptyUsage(),
    };
  }

  const visible = toCandidateVisibleCase(corpusCase);
  const systemPrompt = buildSystemPrompt(corpusCase.task);
  const userPrompt = buildUserPrompt(visible);
  const jsonSchema = corpusCase.task === "message" ? MESSAGE_JSON_SCHEMA : THREAD_JSON_SCHEMA;
  const schemaName = SCHEMA_NAMES[corpusCase.task];

  const attempts: CaseAttempt[] = [];
  let prediction: MessageOutput | ThreadOutput | null = null;
  let lastError: ProviderCallError | null = null;

  const totalAttempts = 1 + Math.max(0, options.maxSchemaRetries);
  for (let i = 0; i < totalAttempts; i += 1) {
    const isRetry = i > 0;
    const started = Date.now();
    let response: ProviderResponse | null = null;
    let error: ProviderCallError | null = null;
    try {
      response = await adapter.invoke(model, {
        systemPrompt,
        userPrompt: isRetry ? `${userPrompt}${RETRY_NUDGE}` : userPrompt,
        jsonSchema,
        schemaName,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        inferenceConfig,
      });
    } catch (caught) {
      error =
        caught instanceof ProviderCallError
          ? caught
          : new ProviderCallError(
              "network_error",
              caught instanceof Error ? caught.message : "unknown failure",
            );
      lastError = error;
    }
    const latency = Date.now() - started;

    if (error) {
      attempts.push({
        index: i + 1,
        kind: isRetry ? "schema_retry" : "initial",
        outcome: error.kind === "timeout" ? "timeout" : "provider_error",
        http_status: error.httpStatus,
        error_summary: safeErrorSummary(`${error.kind}: ${error.message}`),
        latency_ms: latency,
        usage: emptyUsage(),
        returned_model: null,
      });
      // A provider error is not a schema failure; a format retry would not
      // help and would distort the retry statistic. Stop here.
      break;
    }

    const candidatePrediction = validatePrediction(corpusCase.task, response?.text ?? null);
    attempts.push({
      index: i + 1,
      kind: isRetry ? "schema_retry" : "initial",
      outcome: candidatePrediction ? "schema_valid" : "schema_invalid",
      http_status: response?.http_status ?? null,
      error_summary: candidatePrediction ? null : "response did not validate against the schema",
      latency_ms: latency,
      usage: response
        ? {
            input_tokens: response.usage.input_tokens,
            output_tokens: response.usage.output_tokens,
            reasoning_tokens: response.usage.reasoning_tokens,
            cached_input_tokens: response.usage.cached_input_tokens,
          }
        : emptyUsage(),
      returned_model: response?.returned_model ?? null,
    });

    if (candidatePrediction) {
      prediction = candidatePrediction;
      break;
    }
  }

  const firstAttempt = attempts[0];
  const status: CaseResult["status"] = prediction
    ? "ok"
    : lastError?.kind === "timeout"
      ? "timeout"
      : lastError
        ? "provider_error"
        : "schema_failed";

  return {
    ...base,
    endpoint: adapter.endpointFor(model),
    status,
    attempts,
    first_pass_schema_valid: firstAttempt?.outcome === "schema_valid",
    retry_used: attempts.some((a) => a.kind === "schema_retry"),
    final_schema_valid: prediction !== null,
    prediction,
    total_latency_ms: attempts.reduce((sum, a) => sum + a.latency_ms, 0),
    usage_totals: sumUsage(attempts),
  };
}

/** Bounded-concurrency map that preserves input order in the output. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await worker(item, index);
    }
  });
  await Promise.all(runners);
  return results;
}

export interface RunOutcome {
  candidateId: string;
  model: string;
  results: CaseResult[];
  reusedFromResume: number;
  availability: "available" | "unavailable" | "unknown" | "not_run_missing_key";
}

export async function runCandidate(options: RunnerOptions): Promise<RunOutcome> {
  const model = resolveModel(options.candidate);
  // Derived from the RESOLVED model id, not `options.candidate.model` — a
  // `B07_BENCH_MODEL_...` override to a model with a different capability
  // contract (e.g. a future Anthropic snapshot) must never silently run
  // under the authoring candidate's inference config (external audit
  // finding, this round: config must be candidate/model specific, and that
  // includes the actually-resolved model, not just the configured one).
  const inferenceConfig = effectiveInferenceConfig(
    { providerId: options.candidate.providerId, model },
    MAX_OUTPUT_TOKENS,
  );
  const configDigest = inferenceConfigDigest(inferenceConfig);

  // Availability is verified at execution time. A model whose id has moved is
  // recorded honestly; it never fails the round and never fakes a result.
  let availability: RunOutcome["availability"] = "unknown";
  if (options.candidate.providerId === "local") {
    availability = "available";
  } else if (!hasApiKey(options.candidate.providerId)) {
    availability = "not_run_missing_key";
  } else if (!options.dryRun) {
    const adapter = adapterFor(options.candidate.providerId);
    const check = adapter ? await adapter.isModelAvailable(model) : null;
    availability = check === true ? "available" : check === false ? "unavailable" : "unknown";
  }

  // `isTerminalForResume` DELIBERATELY excludes `not_run_missing_key`, so a
  // resume after an operator adds the missing key actually calls the
  // provider instead of reusing the old absence. The identity key below binds
  // reuse to the EXACT requested model and effective inference config, so a
  // model override or an effort change between runs can never reuse a result
  // computed under the old identity.
  const priorByKey = new Map<string, CaseResult>();
  if (options.resume) {
    for (const prior of readResults(options.runId)) {
      if (prior.candidate_id !== options.candidate.id) continue;
      if (!isTerminalForResume(prior.status)) continue;
      priorByKey.set(resultCompatibilityKey(prior), prior);
    }
  }

  let reused = 0;
  const results = await mapWithConcurrency(
    options.cases,
    options.concurrency,
    async (corpusCase) => {
      const key = resultCompatibilityKey({
        candidate_id: options.candidate.id,
        provider_id: options.candidate.providerId,
        requested_model: model,
        inference_config_digest: configDigest,
        case_id: corpusCase.case_id,
        corpus_version: CORPUS_VERSION,
        prompt_version: PROMPT_VERSION,
        schema_version: B07_BENCHMARK_SCHEMA_VERSION,
      });
      const prior = priorByKey.get(key);
      if (prior) {
        reused += 1;
        return prior;
      }

      if (availability === "unavailable") {
        return {
          run_id: options.runId,
          candidate_id: options.candidate.id,
          provider_id: options.candidate.providerId,
          requested_model: model,
          inference_config: inferenceConfig,
          inference_config_digest: configDigest,
          endpoint: null,
          case_id: corpusCase.case_id,
          task: corpusCase.task,
          split: corpusCase.split,
          corpus_version: CORPUS_VERSION,
          prompt_version: PROMPT_VERSION,
          schema_version: B07_BENCHMARK_SCHEMA_VERSION,
          status: "unavailable" as const,
          attempts: [],
          first_pass_schema_valid: false,
          retry_used: false,
          final_schema_valid: false,
          prediction: null,
          total_latency_ms: 0,
          usage_totals: emptyUsage(),
          evaluated_at: new Date().toISOString(),
        };
      }

      const result = await runOneCase(options, corpusCase, model, inferenceConfig);
      appendResult(options.runId, result);
      return result;
    },
  );

  return {
    candidateId: options.candidate.id,
    model,
    results,
    reusedFromResume: reused,
    availability,
  };
}

export function newRunId(stage: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${stage}-${stamp}-${randomUUID().slice(0, 8)}`;
}

export { BASELINE_CANDIDATE };
