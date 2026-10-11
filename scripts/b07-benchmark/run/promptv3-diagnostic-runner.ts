/**
 * PROMPT-V3 POSTHOC DIAGNOSTIC runner (PR #40).
 *
 * THIS IS NOT A STAGE-1/STAGE-2 QUALIFICATION PATH. The round's own task spec
 * is explicit: a Prompt-v3 rerun against the already-opened 120+6 holdout is
 * a `POSTHOC_PROMPT_DIAGNOSTIC` (direct v2-vs-v3 A/B comparison on identical
 * evidence), never a new blind qualification test. This file therefore never
 * imports, calls, or otherwise touches `scoring/stage2-final.ts`'s
 * `evaluateStage2Final`, `run/stage1-provenance.ts`'s provenance assertions,
 * or `cli.ts`'s `runStage("final", ...)` — those remain exclusively the
 * historical Stage-2 qualification path for `b07_benchmark_prompt_v2`.
 *
 * PROVIDER PARITY (same discipline as `run/supplemental-runner.ts`): no
 * `candidate.id === "..."` / `providerId === "..."` branch anywhere here.
 * Every candidate is run through the exact same adapter dispatch, schema and
 * bounded retry policy as the historical v2 runs
 * (`executeCaseAttempts`/`mapWithConcurrency`, reused verbatim from
 * `./runner.ts` — never a second, divergent copy).
 *
 * THE ONE THING THAT DIFFERS FROM THE V2 RUNNER: the system prompt is built
 * with `buildSystemPromptV3` (RULES A-J) instead of `buildSystemPrompt`
 * (RULES A-D), and every row is stamped `prompt_version: PROMPT_VERSION_V3`.
 * Model, inference config (adaptive thinking, effort, schema, retry policy),
 * corpus semantics and D072 are all held IDENTICAL to the historical v2 run —
 * this file changes nothing else.
 *
 * THREE EVIDENCE SOURCES, THREE STRUCTURALLY SEPARATE ARTIFACT STREAMS (never
 * mixed with `results.jsonl`/`supplemental-results.jsonl`, and never with
 * each other):
 *  - `runHoldoutUnderPromptV3`      -> `promptv3-diagnostic-results.jsonl`
 *    (the SAME frozen 120-case main holdout, `CaseResult` rows).
 *  - `runSupplementalUnderPromptV3` -> `promptv3-diagnostic-supplemental-results.jsonl`
 *    (the SAME frozen 6-case `b07_disposition_ambiguity_support_v1` pack,
 *    `SupplementalCaseResult` rows — case selection is LOCKED, exactly like
 *    `run/supplemental-runner.ts`: no `cases`/`caseIds` parameter exists).
 *  - `runGeneralizationUnderPromptV3` -> `promptv3-diagnostic-generalization-results.jsonl`
 *    (the NEW frozen 36-case `b07_prompt_v3_generalization_challenge_v1`
 *    fixture, also `SupplementalCaseResult` rows — that type's
 *    `pack_version`/`pack_digest` fields fit a second frozen auxiliary
 *    fixture exactly as well as the first, so no new result type is needed).
 *
 * NO LIVE PROVIDER CALL IS MADE BY THIS FILE UNLESS THE CALLER INVOKES IT
 * against a real API key. This round (Phase 1) never invokes it that way —
 * see the round's own "NO LIVE API CALLS IN THIS PHASE" instruction. Phase 2
 * (the parent session, with a live Anthropic key) invokes these functions via
 * the `promptv3-diagnostic` CLI subcommand in `../cli.ts`.
 */
import { hasApiKey, resolveModel, type Candidate } from "../config/candidates";
import {
  effectiveInferenceConfig,
  inferenceConfigDigest,
  type EffectiveInferenceConfig,
} from "../config/inference-config";
import { resolveSelection } from "./selection";
import type { CorpusCase } from "../corpus/schema";
import { CORPUS_VERSION } from "../corpus/schema";
import {
  loadSupplementalAmbiguityPack,
  supplementalPackManifest,
  type SupplementalCase,
} from "../corpus/supplemental-ambiguity-pack";
import {
  GENERALIZATION_PACK_VERSION,
  generalizationPackManifest,
  loadPromptV3GeneralizationChallenge,
  type GeneralizationCase,
} from "../corpus/prompt-v3-generalization-challenge";
import { adapterFor } from "../providers/registry";
import {
  buildSystemPromptV3,
  buildUserPromptV3,
  toCandidateVisibleCaseV3,
  PROMPT_VERSION_V3,
} from "../prompt/render-v3";
import { B07_BENCHMARK_SCHEMA_VERSION } from "../schema";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS,
  executeCaseAttempts,
  mapWithConcurrency,
} from "./runner";
import {
  appendPromptV3DiagnosticGeneralizationResult,
  appendPromptV3DiagnosticResult,
  appendPromptV3DiagnosticSupplementalResult,
  readPromptV3DiagnosticGeneralizationResults,
  readPromptV3DiagnosticResults,
  readPromptV3DiagnosticSupplementalResults,
} from "./artifacts";
import {
  isTerminalForResume,
  resultCompatibilityKey,
  supplementalResultCompatibilityKey,
  type CaseResult,
  type SupplementalCaseResult,
} from "./types";

/** `POSTHOC_PROMPT_DIAGNOSTIC` — printed in the CLI banner and stamped into every manifest this runner writes. Never `stage2_final`/`stage1_screen`. */
export const PROMPT_V3_DIAGNOSTIC_LABEL = "POSTHOC_PROMPT_DIAGNOSTIC" as const;

export interface PromptV3DiagnosticRunnerOptions {
  runId: string;
  candidate: Candidate;
  concurrency: number;
  maxSchemaRetries: number;
  timeoutMs?: number;
  dryRun: boolean;
  resume: boolean;
  log: (...parts: unknown[]) => void;
}

function emptyUsage(): CaseResult["usage_totals"] {
  return {
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cached_input_tokens: null,
  };
}

type Attempt = CaseResult["attempts"][number];

function sumUsage(attempts: readonly Attempt[]): CaseResult["usage_totals"] {
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

async function resolveAvailability(
  candidate: Candidate,
  model: string,
  dryRun: boolean,
): Promise<"available" | "unavailable" | "unknown" | "not_run_missing_key"> {
  if (!hasApiKey(candidate.providerId)) return "not_run_missing_key";
  if (dryRun) return "unknown";
  const adapter = adapterFor(candidate.providerId);
  const check = adapter ? await adapter.isModelAvailable(model) : null;
  return check === true ? "available" : check === false ? "unavailable" : "unknown";
}

// ---------------------------------------------------------------------------
// SOURCE A — the frozen 120-case main holdout, under prompt v3.
// ---------------------------------------------------------------------------

export interface PromptV3HoldoutOutcome {
  candidateId: string;
  model: string;
  results: CaseResult[];
  reusedFromResume: number;
  availability: "available" | "unavailable" | "unknown" | "not_run_missing_key";
  caseCount: number;
}

async function runOneHoldoutCaseV3(
  options: PromptV3DiagnosticRunnerOptions,
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
    prompt_version: PROMPT_VERSION_V3,
    schema_version: B07_BENCHMARK_SCHEMA_VERSION,
    evaluated_at: new Date().toISOString(),
  };

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

  const visible = toCandidateVisibleCaseV3(corpusCase);
  const systemPrompt = buildSystemPromptV3(corpusCase.task);
  const userPrompt = buildUserPromptV3(visible);

  const { attempts, prediction, lastError } = await executeCaseAttempts({
    adapter,
    model,
    task: corpusCase.task,
    systemPrompt,
    userPrompt,
    maxSchemaRetries: options.maxSchemaRetries,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    inferenceConfig,
  });

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

/**
 * Runs ONE candidate, under prompt v3, against the SAME frozen 120-case main
 * holdout used by the historical v2 Stage-2 run. Case selection is always
 * `resolveSelection({split:"holdout", criticalOnly:false})` — the full frozen
 * holdout, never a subset an operator could pass in.
 */
export async function runHoldoutUnderPromptV3(
  options: PromptV3DiagnosticRunnerOptions,
): Promise<PromptV3HoldoutOutcome> {
  const cases = resolveSelection({ split: "holdout", criticalOnly: false }).cases;
  const model = resolveModel(options.candidate);
  const inferenceConfig = effectiveInferenceConfig(
    { providerId: options.candidate.providerId, model },
    MAX_OUTPUT_TOKENS,
  );
  const configDigest = inferenceConfigDigest(inferenceConfig);
  const availability = await resolveAvailability(options.candidate, model, options.dryRun);

  const priorByKey = new Map<string, CaseResult>();
  if (options.resume) {
    for (const prior of readPromptV3DiagnosticResults(options.runId)) {
      if (prior.candidate_id !== options.candidate.id) continue;
      if (!isTerminalForResume(prior.status)) continue;
      priorByKey.set(resultCompatibilityKey(prior), prior);
    }
  }

  let reused = 0;
  const results = await mapWithConcurrency(cases, options.concurrency, async (corpusCase) => {
    const key = resultCompatibilityKey({
      candidate_id: options.candidate.id,
      provider_id: options.candidate.providerId,
      requested_model: model,
      inference_config_digest: configDigest,
      case_id: corpusCase.case_id,
      corpus_version: CORPUS_VERSION,
      prompt_version: PROMPT_VERSION_V3,
      schema_version: B07_BENCHMARK_SCHEMA_VERSION,
    });
    const prior = priorByKey.get(key);
    if (prior) {
      reused += 1;
      return prior;
    }
    if (availability === "unavailable") {
      const unavailable: CaseResult = {
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
        prompt_version: PROMPT_VERSION_V3,
        schema_version: B07_BENCHMARK_SCHEMA_VERSION,
        status: "unavailable",
        attempts: [],
        first_pass_schema_valid: false,
        retry_used: false,
        final_schema_valid: false,
        prediction: null,
        total_latency_ms: 0,
        usage_totals: emptyUsage(),
        evaluated_at: new Date().toISOString(),
      };
      return unavailable;
    }
    const result = await runOneHoldoutCaseV3(options, corpusCase, model, inferenceConfig);
    appendPromptV3DiagnosticResult(options.runId, result);
    return result;
  });

  return {
    candidateId: options.candidate.id,
    model,
    results,
    reusedFromResume: reused,
    availability,
    caseCount: cases.length,
  };
}

// ---------------------------------------------------------------------------
// SOURCE B — the frozen 6-case supplemental ambiguity pack, under prompt v3.
// ---------------------------------------------------------------------------

export interface PromptV3SupplementalOutcome {
  candidateId: string;
  model: string;
  packVersion: string;
  packDigest: string;
  results: SupplementalCaseResult[];
  reusedFromResume: number;
  availability: "available" | "unavailable" | "unknown" | "not_run_missing_key";
}

async function runOneAuxCaseV3(
  options: PromptV3DiagnosticRunnerOptions,
  auxCase: SupplementalCase | GeneralizationCase,
  packVersion: string,
  packDigest: string,
  model: string,
  inferenceConfig: EffectiveInferenceConfig,
): Promise<SupplementalCaseResult> {
  const base = {
    run_id: options.runId,
    candidate_id: options.candidate.id,
    provider_id: options.candidate.providerId,
    requested_model: model,
    inference_config: inferenceConfig,
    inference_config_digest: inferenceConfigDigest(inferenceConfig),
    case_id: auxCase.case_id,
    task: "message" as const,
    pack_version: packVersion,
    pack_digest: packDigest,
    prompt_version: PROMPT_VERSION_V3,
    schema_version: B07_BENCHMARK_SCHEMA_VERSION,
    evaluated_at: new Date().toISOString(),
  };

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

  const visible = toCandidateVisibleCaseV3(auxCase);
  const systemPrompt = buildSystemPromptV3("message");
  const userPrompt = buildUserPromptV3(visible);

  const { attempts, prediction, lastError } = await executeCaseAttempts({
    adapter,
    model,
    task: "message",
    systemPrompt,
    userPrompt,
    maxSchemaRetries: options.maxSchemaRetries,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    inferenceConfig,
  });

  const firstAttempt = attempts[0];
  const status: SupplementalCaseResult["status"] = prediction
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
    prediction: prediction as SupplementalCaseResult["prediction"],
    total_latency_ms: attempts.reduce((sum, a) => sum + a.latency_ms, 0),
    usage_totals: sumUsage(attempts),
  };
}

/**
 * Runs ONE candidate, under prompt v3, against the SAME frozen 6-case
 * `b07_disposition_ambiguity_support_v1` pack used by the historical v2
 * Stage-2 run. Case selection is LOCKED: there is no `cases`/`caseIds`
 * parameter, mirroring `run/supplemental-runner.ts`.
 */
export async function runSupplementalUnderPromptV3(
  options: PromptV3DiagnosticRunnerOptions,
): Promise<PromptV3SupplementalOutcome> {
  const cases = loadSupplementalAmbiguityPack();
  const pack = supplementalPackManifest();
  const model = resolveModel(options.candidate);
  const inferenceConfig = effectiveInferenceConfig(
    { providerId: options.candidate.providerId, model },
    MAX_OUTPUT_TOKENS,
  );
  const configDigest = inferenceConfigDigest(inferenceConfig);
  const availability = await resolveAvailability(options.candidate, model, options.dryRun);

  const priorByKey = new Map<string, SupplementalCaseResult>();
  if (options.resume) {
    for (const prior of readPromptV3DiagnosticSupplementalResults(options.runId)) {
      if (prior.candidate_id !== options.candidate.id) continue;
      if (!isTerminalForResume(prior.status)) continue;
      priorByKey.set(supplementalResultCompatibilityKey(prior), prior);
    }
  }

  let reused = 0;
  const results = await mapWithConcurrency(cases, options.concurrency, async (supplementalCase) => {
    const key = supplementalResultCompatibilityKey({
      candidate_id: options.candidate.id,
      provider_id: options.candidate.providerId,
      requested_model: model,
      inference_config_digest: configDigest,
      case_id: supplementalCase.case_id,
      pack_version: pack.pack_version,
      pack_digest: pack.digest,
      prompt_version: PROMPT_VERSION_V3,
      schema_version: B07_BENCHMARK_SCHEMA_VERSION,
    });
    const prior = priorByKey.get(key);
    if (prior) {
      reused += 1;
      return prior;
    }
    if (availability === "unavailable") {
      const unavailable: SupplementalCaseResult = {
        run_id: options.runId,
        candidate_id: options.candidate.id,
        provider_id: options.candidate.providerId,
        requested_model: model,
        inference_config: inferenceConfig,
        inference_config_digest: configDigest,
        endpoint: null,
        case_id: supplementalCase.case_id,
        task: "message",
        pack_version: pack.pack_version,
        pack_digest: pack.digest,
        prompt_version: PROMPT_VERSION_V3,
        schema_version: B07_BENCHMARK_SCHEMA_VERSION,
        status: "unavailable",
        attempts: [],
        first_pass_schema_valid: false,
        retry_used: false,
        final_schema_valid: false,
        prediction: null,
        total_latency_ms: 0,
        usage_totals: emptyUsage(),
        evaluated_at: new Date().toISOString(),
      };
      return unavailable;
    }
    const result = await runOneAuxCaseV3(
      options,
      supplementalCase,
      pack.pack_version,
      pack.digest,
      model,
      inferenceConfig,
    );
    appendPromptV3DiagnosticSupplementalResult(options.runId, result);
    return result;
  });

  return {
    candidateId: options.candidate.id,
    model,
    packVersion: pack.pack_version,
    packDigest: pack.digest,
    results,
    reusedFromResume: reused,
    availability,
  };
}

// ---------------------------------------------------------------------------
// The NEW 36-case blind generalization-challenge fixture, under prompt v3.
// ---------------------------------------------------------------------------

export interface PromptV3GeneralizationOutcome {
  candidateId: string;
  model: string;
  packVersion: string;
  packDigest: string;
  results: SupplementalCaseResult[];
  reusedFromResume: number;
  availability: "available" | "unavailable" | "unknown" | "not_run_missing_key";
}

/**
 * Runs ONE candidate, under prompt v3, against the NEW frozen 36-case
 * `b07_prompt_v3_generalization_challenge_v1` fixture. Case selection is
 * LOCKED exactly like `runSupplementalUnderPromptV3` — always all 36 frozen
 * cases from `loadPromptV3GeneralizationChallenge()`, never an operator
 * subset.
 */
export async function runGeneralizationUnderPromptV3(
  options: PromptV3DiagnosticRunnerOptions,
): Promise<PromptV3GeneralizationOutcome> {
  const cases = loadPromptV3GeneralizationChallenge();
  const pack = generalizationPackManifest();
  const model = resolveModel(options.candidate);
  const inferenceConfig = effectiveInferenceConfig(
    { providerId: options.candidate.providerId, model },
    MAX_OUTPUT_TOKENS,
  );
  const configDigest = inferenceConfigDigest(inferenceConfig);
  const availability = await resolveAvailability(options.candidate, model, options.dryRun);

  const priorByKey = new Map<string, SupplementalCaseResult>();
  if (options.resume) {
    for (const prior of readPromptV3DiagnosticGeneralizationResults(options.runId)) {
      if (prior.candidate_id !== options.candidate.id) continue;
      if (!isTerminalForResume(prior.status)) continue;
      priorByKey.set(supplementalResultCompatibilityKey(prior), prior);
    }
  }

  let reused = 0;
  const results = await mapWithConcurrency(cases, options.concurrency, async (genCase) => {
    const key = supplementalResultCompatibilityKey({
      candidate_id: options.candidate.id,
      provider_id: options.candidate.providerId,
      requested_model: model,
      inference_config_digest: configDigest,
      case_id: genCase.case_id,
      pack_version: pack.pack_version,
      pack_digest: pack.digest,
      prompt_version: PROMPT_VERSION_V3,
      schema_version: B07_BENCHMARK_SCHEMA_VERSION,
    });
    const prior = priorByKey.get(key);
    if (prior) {
      reused += 1;
      return prior;
    }
    if (availability === "unavailable") {
      const unavailable: SupplementalCaseResult = {
        run_id: options.runId,
        candidate_id: options.candidate.id,
        provider_id: options.candidate.providerId,
        requested_model: model,
        inference_config: inferenceConfig,
        inference_config_digest: configDigest,
        endpoint: null,
        case_id: genCase.case_id,
        task: "message",
        pack_version: pack.pack_version,
        pack_digest: pack.digest,
        prompt_version: PROMPT_VERSION_V3,
        schema_version: B07_BENCHMARK_SCHEMA_VERSION,
        status: "unavailable",
        attempts: [],
        first_pass_schema_valid: false,
        retry_used: false,
        final_schema_valid: false,
        prediction: null,
        total_latency_ms: 0,
        usage_totals: emptyUsage(),
        evaluated_at: new Date().toISOString(),
      };
      return unavailable;
    }
    const result = await runOneAuxCaseV3(
      options,
      genCase,
      pack.pack_version,
      pack.digest,
      model,
      inferenceConfig,
    );
    appendPromptV3DiagnosticGeneralizationResult(options.runId, result);
    return result;
  });

  return {
    candidateId: options.candidate.id,
    model,
    packVersion: pack.pack_version,
    packDigest: pack.digest,
    results,
    reusedFromResume: reused,
    availability,
  };
}

export { GENERALIZATION_PACK_VERSION };
