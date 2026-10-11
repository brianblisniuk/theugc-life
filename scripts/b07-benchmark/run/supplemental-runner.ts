/**
 * Stage-2 SUPPLEMENTAL evidence-source runner — SOURCE B
 * (`b07_disposition_ambiguity_support_v1`).
 *
 * THIS IS THE FIX FOR THE ROUND'S BLOCKER: before this file existed, the
 * Stage-2 `final` flow resolved the main holdout, ran provider candidates
 * against it, and scored it — but NEVER sent the six frozen supplemental
 * cases to the finalist, so `evaluateStage2DispositionMacroF1Target()` could
 * never be invoked with real supplemental predictions. `preflight` could say
 * `resolvable: true` (a statement about GOLD SUPPORT ARITHMETIC only) with no
 * corresponding execution path that would ever produce the supplemental
 * evidence needed to actually resolve it.
 *
 * PROVIDER PARITY (round requirement): this file contains no
 * `candidate.id === "..."` / `providerId === "..."` branch anywhere. Every
 * future finalist — any provider — is run through the exact same adapter
 * dispatch, prompt builder, schema and retry policy as the main holdout
 * (`executeCaseAttempts`, shared verbatim with `run/runner.ts`).
 *
 * NEVER touches `results.jsonl` / `readResults` / `appendResult` (the main
 * holdout's own stream) or `normaliseResults`/`scoreCandidateV2` — this is a
 * STRUCTURALLY SEPARATE stream (`supplemental-results.jsonl`,
 * `SupplementalCaseResult`, no `corpus_version`/`split` field at all) so it
 * cannot silently enter main-holdout reliability, latency, economics, or any
 * main-holdout metric (round requirement: "separate raw result streams" /
 * "denominator contamination").
 *
 * CASE SELECTION IS LOCKED: there is no `cases`/`caseIds` parameter here at
 * all. The six cases always come from `loadSupplementalAmbiguityPack()`
 * directly — a caller cannot accidentally run a subset, and "all 6
 * supplemental cases are required" is enforced structurally rather than by
 * convention.
 */
import { hasApiKey, resolveModel, type Candidate } from "../config/candidates";
import {
  effectiveInferenceConfig,
  inferenceConfigDigest,
  type EffectiveInferenceConfig,
} from "../config/inference-config";
import {
  loadSupplementalAmbiguityPack,
  supplementalPackManifest,
  type SupplementalCase,
} from "../corpus/supplemental-ambiguity-pack";
import { adapterFor } from "../providers/registry";
import {
  buildSystemPrompt,
  buildUserPrompt,
  toCandidateVisibleCase,
  PROMPT_VERSION,
} from "../prompt/render";
import { B07_BENCHMARK_SCHEMA_VERSION } from "../schema";
import {
  DEFAULT_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS,
  executeCaseAttempts,
  mapWithConcurrency,
} from "./runner";
import { appendSupplementalResult, readSupplementalResults } from "./artifacts";
import {
  isTerminalForResume,
  supplementalResultCompatibilityKey,
  type SupplementalCaseResult,
} from "./types";

/**
 * Refused, not silently worked around: a stored supplemental row exists under
 * the pack's CURRENT `pack_version` but a DIFFERENT `pack_digest` than the
 * pack currently on disk. Under the freeze contract this can only mean the
 * frozen fixture changed content without a version bump — corruption or an
 * unauthorised edit — and resuming or reporting over a mix of old and new
 * pack content would silently misattribute predictions to cases whose wording
 * may have changed. (Round attack case: "pack drift".)
 */
export class SupplementalPackDriftError extends Error {}

export interface SupplementalRunnerOptions {
  runId: string;
  candidate: Candidate;
  concurrency: number;
  maxSchemaRetries: number;
  timeoutMs?: number;
  dryRun: boolean;
  resume: boolean;
  log: (...parts: unknown[]) => void;
}

export interface SupplementalRunOutcome {
  candidateId: string;
  model: string;
  packVersion: string;
  packDigest: string;
  caseIds: readonly string[];
  results: SupplementalCaseResult[];
  reusedFromResume: number;
  availability: "available" | "unavailable" | "unknown" | "not_run_missing_key";
}

function emptyUsage(): SupplementalCaseResult["usage_totals"] {
  return {
    input_tokens: null,
    output_tokens: null,
    reasoning_tokens: null,
    cached_input_tokens: null,
  };
}

/** Detects pack drift across EVERY stored row for this candidate, not just rows for the current 6 case ids — a drifted pack may have renamed or dropped a case id entirely. */
function assertNoPackDrift(
  candidateId: string,
  packVersion: string,
  packDigest: string,
  storedRows: readonly SupplementalCaseResult[],
): void {
  for (const row of storedRows) {
    if (row.candidate_id !== candidateId) continue;
    if (row.pack_version === packVersion && row.pack_digest !== packDigest) {
      throw new SupplementalPackDriftError(
        `SUPPLEMENTAL_PACK_DRIFT_DETECTED: stored supplemental result for case ${row.case_id} was computed against pack "${row.pack_version}" digest ${row.pack_digest}, but the pack currently on disk is the SAME version with a DIFFERENT digest (${packDigest}). A frozen pack's content must never change under one version string. Refusing to resume or report — investigate the fixture change before proceeding (a genuine correction requires a NEW pack version).`,
      );
    }
  }
}

async function runOneSupplementalCase(
  options: SupplementalRunnerOptions,
  supplementalCase: SupplementalCase,
  model: string,
  inferenceConfig: EffectiveInferenceConfig,
  packVersion: string,
  packDigest: string,
): Promise<SupplementalCaseResult> {
  const base = {
    run_id: options.runId,
    candidate_id: options.candidate.id,
    provider_id: options.candidate.providerId,
    requested_model: model,
    inference_config: inferenceConfig,
    inference_config_digest: inferenceConfigDigest(inferenceConfig),
    case_id: supplementalCase.case_id,
    task: "message" as const,
    pack_version: packVersion,
    pack_digest: packDigest,
    prompt_version: PROMPT_VERSION,
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

  // NARROW TECHNICAL ADAPTER: `toCandidateVisibleCase` is the SAME function,
  // unmodified, that the main holdout uses (`prompt/render.ts`'s
  // `VisibleCaseSource` structural interface). `SupplementalCase` exposes
  // exactly `case_id`/`task`/`subject`/`messages`/`focus_index` and nothing
  // else reaches this call — gold rationale, expected labels, critical tags,
  // pack version/manifest metadata are all declared on `SupplementalCase` but
  // are simply never read here. The candidate-visible payload is therefore
  // byte-for-byte the same SHAPE an ordinary message-task holdout case would
  // produce, and the system/user prompt text is the identical
  // `b07_benchmark_prompt_v2` used for the main holdout (SAME canonical
  // prompt — no easier/special prompt is ever built for this pack).
  const visible = toCandidateVisibleCase(supplementalCase);
  const systemPrompt = buildSystemPrompt("message");
  const userPrompt = buildUserPrompt(visible);

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

  let usage_totals = emptyUsage();
  {
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
    usage_totals = {
      input_tokens: input,
      output_tokens: output,
      reasoning_tokens: reasoning,
      cached_input_tokens: cached,
    };
  }

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
    usage_totals,
  };
}

/**
 * Runs the SAME finalist/model against ALL 6 frozen supplemental cases, using
 * the SAME prompt v2, SAME message schema, SAME provider adapter and SAME
 * bounded retry policy as the main holdout. This is what makes
 * `evaluateStage2DispositionMacroF1Target()` invokable with REAL supplemental
 * predictions instead of only the metadata-only preflight arithmetic.
 */
export async function runSupplementalPack(
  options: SupplementalRunnerOptions,
): Promise<SupplementalRunOutcome> {
  const cases = loadSupplementalAmbiguityPack();
  const pack = supplementalPackManifest();
  const model = resolveModel(options.candidate);
  const inferenceConfig = effectiveInferenceConfig(
    { providerId: options.candidate.providerId, model },
    MAX_OUTPUT_TOKENS,
  );
  const configDigest = inferenceConfigDigest(inferenceConfig);

  let availability: SupplementalRunOutcome["availability"] = "unknown";
  if (!hasApiKey(options.candidate.providerId)) {
    availability = "not_run_missing_key";
  } else if (!options.dryRun) {
    const adapter = adapterFor(options.candidate.providerId);
    const check = adapter ? await adapter.isModelAvailable(model) : null;
    availability = check === true ? "available" : check === false ? "unavailable" : "unknown";
  }

  const priorByKey = new Map<string, SupplementalCaseResult>();
  if (options.resume) {
    const stored = readSupplementalResults(options.runId);
    assertNoPackDrift(options.candidate.id, pack.pack_version, pack.digest, stored);
    for (const prior of stored) {
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
      prompt_version: PROMPT_VERSION,
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
        prompt_version: PROMPT_VERSION,
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

    const result = await runOneSupplementalCase(
      options,
      supplementalCase,
      model,
      inferenceConfig,
      pack.pack_version,
      pack.digest,
    );
    appendSupplementalResult(options.runId, result);
    return result;
  });

  return {
    candidateId: options.candidate.id,
    model,
    packVersion: pack.pack_version,
    packDigest: pack.digest,
    caseIds: pack.case_ids,
    results,
    reusedFromResume: reused,
    availability,
  };
}
