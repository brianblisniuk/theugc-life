/**
 * Test-only helper: writes a REAL, structurally valid Stage-1 ("screen") run
 * artifact pair (`manifest.json` + `scores-v2.json`) directly to the
 * gitignored artifacts directory, computed via the actual `scoreCandidateV2`
 * over a "perfect" (gold-cheating) result set — never hand-typed JSON shapes
 * that could silently drift from what the real scorer produces.
 *
 * This exists so every provenance-hardening test (BLOCKER 1 / FINALIST
 * PROVENANCE IDENTITY) can set up a genuine, locally-persisted Stage-1
 * finalist (or a deliberately broken one, via `overrides`) in a few lines,
 * without paying for a full mocked-fetch Stage-1 CLI run through 55 dev
 * cases every time. No network call, no CLI invocation — pure local artifact
 * construction, exactly like "Use locally persisted benchmark artifacts. No
 * provider call is needed for this check" describes for the production code
 * itself.
 */
import { randomUUID } from "node:crypto";

import { CORPUS_VERSION, selectCases } from "../../../scripts/b07-benchmark/corpus/load";
import { PROMPT_VERSION } from "../../../scripts/b07-benchmark/prompt/render";
import { B07_BENCHMARK_SCHEMA_VERSION } from "../../../scripts/b07-benchmark/schema";
import { INFERENCE_POLICY_VERSION } from "../../../scripts/b07-benchmark/config/inference-config";
import type { EffectiveInferenceConfig } from "../../../scripts/b07-benchmark/config/inference-config";
import { caseSetDigest } from "../../../scripts/b07-benchmark/run/digest";
import { writeJson } from "../../../scripts/b07-benchmark/run/artifacts";
import type { CaseResult, RunManifest } from "../../../scripts/b07-benchmark/run/types";
import {
  scoreCandidateV2,
  type CandidateScoreV2,
} from "../../../scripts/b07-benchmark/scoring/score-v2";
import { SCORING_VERSION_V2 } from "../../../scripts/b07-benchmark/scoring/scoring-version";

function perfectResultFor(
  c: ReturnType<typeof selectCases>[number],
  args: {
    candidateId: string;
    providerId: string;
    model: string;
    inferenceConfig: EffectiveInferenceConfig;
    inferenceConfigDigest: string;
    returnedModel: string;
  },
): CaseResult {
  const prediction =
    c.task === "message"
      ? {
          disposition: c.expected.disposition,
          signals: [...c.expected.signals],
          evidence_strength: c.expected.evidence_strength,
        }
      : {
          thread_state: c.expected.thread_state,
          compensation_structure: c.expected.compensation_structure,
          evidence_strength: c.expected.evidence_strength,
        };
  return {
    run_id: "stage1-fixture",
    candidate_id: args.candidateId,
    provider_id: args.providerId,
    requested_model: args.model,
    inference_config: args.inferenceConfig,
    inference_config_digest: args.inferenceConfigDigest,
    endpoint: "https://example.invalid",
    case_id: c.case_id,
    task: c.task,
    split: c.split,
    corpus_version: CORPUS_VERSION,
    prompt_version: PROMPT_VERSION,
    schema_version: B07_BENCHMARK_SCHEMA_VERSION,
    status: "ok",
    attempts: [
      {
        index: 1,
        kind: "initial",
        outcome: "schema_valid",
        http_status: 200,
        error_summary: null,
        latency_ms: 5,
        usage: { input_tokens: 80, output_tokens: 15, reasoning_tokens: 0, cached_input_tokens: 0 },
        returned_model: args.returnedModel,
      },
    ],
    first_pass_schema_valid: true,
    retry_used: false,
    final_schema_valid: true,
    prediction: prediction as CaseResult["prediction"],
    total_latency_ms: 5,
    usage_totals: {
      input_tokens: 80,
      output_tokens: 15,
      reasoning_tokens: 0,
      cached_input_tokens: 0,
    },
    evaluated_at: "2026-09-13T00:00:00.000Z",
  };
}

export interface Stage1FixtureOptions {
  candidateId: string;
  providerId: string;
  model: string;
  inferenceConfig: EffectiveInferenceConfig;
  inferenceConfigDigest: string;
  returnedModel?: string;
  /** Override the manifest before it is written — e.g. to simulate a corrupted/mismatched Stage-1 run. */
  manifestOverrides?: Partial<RunManifest>;
  /** Override the candidate's own CandidateScoreV2 before it is written — e.g. to force elimination. */
  scoreOverrides?: Partial<CandidateScoreV2>;
  /** Override the whole scores-v2.json wrapper's scoring_version (default: the accepted SCORING_VERSION_V2). */
  scoringVersionOverride?: string;
}

/**
 * Writes a Stage-1 "screen" run over the 55-case `dev` split for exactly one
 * candidate, with every prediction correct (a "perfect" finalist) by
 * default. Returns the run id (usable directly as `--from-run`) and the
 * computed `CandidateScoreV2` (usable to derive expectations in the test).
 */
export function writeStage1FinalistFixture(options: Stage1FixtureOptions): {
  runId: string;
  score: CandidateScoreV2;
} {
  const runId = `test-stage1-fixture-${randomUUID().slice(0, 8)}`;
  const cases = selectCases({ split: "dev" });
  const returnedModel = options.returnedModel ?? `${options.model}-returned`;
  const results = cases.map((c) =>
    perfectResultFor(c, {
      candidateId: options.candidateId,
      providerId: options.providerId,
      model: options.model,
      inferenceConfig: options.inferenceConfig,
      inferenceConfigDigest: options.inferenceConfigDigest,
      returnedModel,
    }),
  );

  const baseScore = scoreCandidateV2({
    candidateId: options.candidateId,
    providerId: options.providerId,
    requestedModel: options.model,
    corpusVersion: CORPUS_VERSION,
    promptVersion: PROMPT_VERSION,
    schemaVersion: B07_BENCHMARK_SCHEMA_VERSION,
    cases,
    results,
    priceBook: null,
  });
  const score: CandidateScoreV2 = { ...baseScore, ...options.scoreOverrides };

  const caseIds = cases.map((c) => c.case_id);
  const manifest: RunManifest = {
    run_id: runId,
    stage: "screen",
    split: "dev",
    corpus_version: CORPUS_VERSION,
    prompt_version: PROMPT_VERSION,
    schema_version: B07_BENCHMARK_SCHEMA_VERSION,
    inference_policy_version: INFERENCE_POLICY_VERSION,
    candidate_ids: [options.candidateId],
    started_at: "2026-09-13T00:00:00.000Z",
    finished_at: "2026-09-13T00:05:00.000Z",
    concurrency: 4,
    max_schema_retries: 1,
    dry_run: false,
    selection: { split: "dev", task: null, critical_only: false, include_few_shot: false },
    selected_case_ids: caseIds,
    case_set_digest: caseSetDigest(caseIds),
    finalist_provenance: null,
    ...options.manifestOverrides,
  };

  writeJson(runId, "manifest.json", manifest);
  writeJson(runId, "scores-v2.json", {
    scoring_version: options.scoringVersionOverride ?? SCORING_VERSION_V2,
    scores: [score],
    absences: [],
  });

  return { runId, score };
}
