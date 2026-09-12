/**
 * Result record shapes shared by the runner, the scorer and the reporter.
 *
 * Everything the hostile-review attack list needs to be checkable is recorded
 * per case: which candidate produced it, which model actually answered, which
 * prompt/schema/corpus versions were in force, every attempt (including the
 * failed ones, so retries are not free in the cost or latency accounting), and
 * an explicit `status` that distinguishes "wrong answer" from "never ran".
 */
import type { MessageOutput, ThreadOutput } from "../schema";
import type { BenchmarkTask, CorpusSplit } from "../taxonomy";

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
  /** Reasoning/thinking tokens where the provider exposes them; else null. */
  reasoning_tokens: number | null;
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

export interface RunManifest {
  run_id: string;
  stage: string;
  split: CorpusSplit | "all";
  corpus_version: string;
  prompt_version: string;
  schema_version: string;
  candidate_ids: string[];
  started_at: string;
  finished_at: string | null;
  concurrency: number;
  max_schema_retries: number;
  dry_run: boolean;
}

/**
 * Compatibility key for resume. A stored result may only be reused when every
 * component matches the current run — otherwise a prompt or schema change
 * would silently mix incompatible results into one report.
 */
export function resultCompatibilityKey(
  r: Pick<
    CaseResult,
    "candidate_id" | "case_id" | "corpus_version" | "prompt_version" | "schema_version"
  >,
): string {
  return [r.candidate_id, r.case_id, r.corpus_version, r.prompt_version, r.schema_version].join(
    "::",
  );
}

/** Statuses that represent a completed, non-repeatable unit of work. */
export function isTerminalForResume(status: CaseStatus): boolean {
  return status === "ok" || status === "schema_failed" || status === "not_run_missing_key";
}
