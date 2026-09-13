/**
 * Result record shapes shared by the runner, the scorer and the reporter.
 *
 * Everything the hostile-review attack list needs to be checkable is recorded
 * per case: which candidate produced it, which model actually answered, which
 * prompt/schema/corpus versions were in force, which effective inference
 * configuration was in force, every attempt (including the failed ones, so
 * retries are not free in the cost or latency accounting), and an explicit
 * `status` that distinguishes "wrong answer" from "never ran".
 */
import type { MessageOutput, ThreadOutput } from "../schema";
import type { BenchmarkTask, CorpusSplit } from "../taxonomy";
import type { EffectiveInferenceConfig } from "../config/inference-config";

/**
 * Terminal status of one candidate/case pair.
 *
 * `not_run_missing_key` and `unavailable` are NOT failures of the model — they
 * are absences of evidence, and the report must never present them as if the
 * model had been tested.
 */
export const CASE_STATUSES = [
  "ok",
  "schema_failed",
  "provider_error",
  "timeout",
  "not_run_missing_key",
  "unavailable",
  "dry_run",
] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

export interface TokenUsage {
  input_tokens: number | null;
  output_tokens: number | null;
  /** OBSERVABLE reasoning/thinking tokens where the provider exposes them; else null. */
  reasoning_tokens: number | null;
  /** OBSERVABLE cached-input tokens (a subset of input_tokens), else null. */
  cached_input_tokens: number | null;
}

export const ATTEMPT_KINDS = ["initial", "schema_retry"] as const;
export type AttemptKind = (typeof ATTEMPT_KINDS)[number];

export interface CaseAttempt {
  index: number;
  kind: AttemptKind;
  outcome: "schema_valid" | "schema_invalid" | "provider_error" | "timeout";
  http_status: number | null;
  /** Redacted. Never contains a credential or raw provider payload. */
  error_summary: string | null;
  latency_ms: number;
  usage: TokenUsage;
  /** Model/version string the provider reported, when it exposes one. */
  returned_model: string | null;
}

export interface CaseResult {
  run_id: string;
  candidate_id: string;
  provider_id: string;
  requested_model: string;
  /** Versioned effective inference behaviour actually used for this case. */
  inference_config: EffectiveInferenceConfig;
  /** `digestOf(inference_config)`. Participates in result/resume identity. */
  inference_config_digest: string;
  endpoint: string | null;
  case_id: string;
  task: BenchmarkTask;
  split: CorpusSplit;
  corpus_version: string;
  prompt_version: string;
  schema_version: string;
  status: CaseStatus;
  attempts: CaseAttempt[];
  first_pass_schema_valid: boolean;
  retry_used: boolean;
  final_schema_valid: boolean;
  prediction: MessageOutput | ThreadOutput | null;
  /** Sum over ALL attempts, including failed ones. */
  total_latency_ms: number;
  usage_totals: TokenUsage;
  evaluated_at: string;
}

/** Explicit, persisted selection identity — the fix for "manifest cannot reconstruct exact selection". */
export interface RunSelectionMeta {
  split: CorpusSplit | "all";
  task: BenchmarkTask | null;
  critical_only: boolean;
  include_few_shot: boolean;
}

/** Auditable Stage-2 finalist provenance. Never populated for baseline/screen runs. */
export interface FinalistProvenance {
  /** Stage-1 screening run this finalist selection was drawn from, if any. */
  screen_run_id: string | null;
  /** Human-authored rationale, REQUIRED when any selected candidate has role "ceiling". */
  finalist_reason: string | null;
  /** candidate_id -> role, so the report can show which finalists were ceiling opt-ins. */
  candidate_roles: Record<string, string>;
}

export interface RunManifest {
  run_id: string;
  stage: string;
  split: CorpusSplit | "all";
  corpus_version: string;
  prompt_version: string;
  schema_version: string;
  inference_policy_version: string;
  candidate_ids: string[];
  started_at: string;
  finished_at: string | null;
  concurrency: number;
  max_schema_retries: number;
  dry_run: boolean;
  /** Full selection identity — required to reproduce EXACTLY the scored case set later. */
  selection: RunSelectionMeta;
  selected_case_ids: string[];
  /** `caseSetDigest(selected_case_ids)`. A later report refuses on mismatch. */
  case_set_digest: string;
  finalist_provenance: FinalistProvenance | null;
}

/**
 * Compatibility key for resume. A stored result may only be reused when every
 * identity component matches the current run — candidate, provider, EXACT
 * requested model, effective inference configuration, case, and every
 * corpus/prompt/schema version — otherwise a model swap, an inference-config
 * change, or a prompt/schema change would silently mix incompatible results
 * into one report.
 */
export function resultCompatibilityKey(
  r: Pick<
    CaseResult,
    | "candidate_id"
    | "provider_id"
    | "requested_model"
    | "inference_config_digest"
    | "case_id"
    | "corpus_version"
    | "prompt_version"
    | "schema_version"
  >,
): string {
  return [
    r.candidate_id,
    r.provider_id,
    r.requested_model,
    r.inference_config_digest,
    r.case_id,
    r.corpus_version,
    r.prompt_version,
    r.schema_version,
  ].join("::");
}

/**
 * Statuses that represent a completed, non-repeatable unit of work.
 *
 * `not_run_missing_key` is DELIBERATELY excluded: it is an absence of
 * evidence, not completed model work. Once the required API key becomes
 * present, a resume must actually call the provider for that case rather than
 * reusing the old absence as if it were a settled result.
 */
export function isTerminalForResume(status: CaseStatus): boolean {
  return status === "ok" || status === "schema_failed";
}

// ---------------------------------------------------------------------------
// Stage-2 SUPPLEMENTAL evidence stream — SOURCE B
// (`b07_disposition_ambiguity_support_v1`).
//
// Deliberately a STRUCTURALLY DISTINCT type from `CaseResult`, not a
// `CorpusSplit`-tagged variant of it: it has no `corpus_version` and no
// `split` at all (there is no schema-legal value to put there — this stream
// never belongs to the main holdout selection), and it carries `pack_version`
// / `pack_digest` instead. This makes it structurally impossible for a
// supplemental row to be silently accepted anywhere that expects a
// `CaseResult` (`normaliseResults`, `scoreCandidateV2`, `buildReliability`,
// `buildEconomics`, …) — the round's "separate raw result streams" /
// "denominator contamination" requirement enforced by the type system, not
// merely by file-naming convention.
// ---------------------------------------------------------------------------

export interface SupplementalCaseResult {
  run_id: string;
  candidate_id: string;
  provider_id: string;
  requested_model: string;
  inference_config: EffectiveInferenceConfig;
  inference_config_digest: string;
  endpoint: string | null;
  case_id: string;
  task: "message";
  /** `SUPPLEMENTAL_PACK_VERSION` — distinct from, and never confused with, `corpus_version`. */
  pack_version: string;
  /** `supplementalPackManifest().digest` AT THE TIME OF THIS ATTEMPT. Participates in resume/report identity — a later silent pack edit is detectable and refused. */
  pack_digest: string;
  prompt_version: string;
  schema_version: string;
  status: CaseStatus;
  attempts: CaseAttempt[];
  first_pass_schema_valid: boolean;
  retry_used: boolean;
  final_schema_valid: boolean;
  prediction: MessageOutput | null;
  total_latency_ms: number;
  usage_totals: TokenUsage;
  evaluated_at: string;
}

/**
 * Compatibility key for supplemental resume — mirrors
 * `resultCompatibilityKey`, but additionally binds `pack_digest` (never just
 * `pack_version`): a stale row computed against a pack that later drifted
 * under the SAME version string must never be silently reused (round attack
 * case: "pack drift — same version string but different pack digest").
 */
export function supplementalResultCompatibilityKey(
  r: Pick<
    SupplementalCaseResult,
    | "candidate_id"
    | "provider_id"
    | "requested_model"
    | "inference_config_digest"
    | "case_id"
    | "pack_version"
    | "pack_digest"
    | "prompt_version"
    | "schema_version"
  >,
): string {
  return [
    r.candidate_id,
    r.provider_id,
    r.requested_model,
    r.inference_config_digest,
    r.case_id,
    r.pack_version,
    r.pack_digest,
    r.prompt_version,
    r.schema_version,
  ].join("::");
}
