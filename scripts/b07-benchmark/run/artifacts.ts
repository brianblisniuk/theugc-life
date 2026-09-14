/**
 * Run-artifact IO.
 *
 * Artifacts land in a gitignored directory. Only the corpus, schemas, scoring
 * logic, harness, tests, specification and a derived, content-free SUMMARY are
 * ever committed — raw provider responses are not, and neither are secrets.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { redactSecrets, collectSecretValues } from "../../provider-evaluation/redact";
import type { CaseResult, RunManifest, SupplementalCaseResult } from "./types";

export const ARTIFACT_ROOT = resolve(process.cwd(), "artifacts", "b07-benchmark");

export function runDir(runId: string): string {
  return resolve(ARTIFACT_ROOT, runId);
}

export function resultsPath(runId: string): string {
  return resolve(runDir(runId), "results.jsonl");
}

export function manifestPath(runId: string): string {
  return resolve(runDir(runId), "manifest.json");
}

function ensureDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}

/**
 * Recomputed on every write rather than cached at module-load time.
 *
 * FIXED (external audit finding 15): a module-level constant captured once at
 * import time misses any secret-looking env var set (or changed) afterwards
 * — a real, exploitable gap, since `loadLocalEnv()` and per-test/per-run key
 * configuration both happen after this module is first imported. Every
 * artifact write must be secret-safe against the CURRENT environment.
 */
function currentSecrets(): string[] {
  return collectSecretValues();
}

/** Every artifact write passes through redaction. Defence in depth. */
function safeSerialize(value: unknown): string {
  return redactSecrets(JSON.stringify(value), currentSecrets());
}

export function writeManifest(manifest: RunManifest): void {
  const path = manifestPath(manifest.run_id);
  ensureDir(path);
  writeFileSync(path, `${safeSerialize(manifest)}\n`, "utf8");
}

export function readManifest(runId: string): RunManifest | null {
  const path = manifestPath(runId);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as RunManifest;
}

/** Generic JSON artifact reader — used to read a prior run's `scores-v2.json` etc. */
export function readJsonArtifact<T>(runId: string, filename: string): T | null {
  const path = resolve(runDir(runId), filename);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function appendResult(runId: string, result: CaseResult): void {
  const path = resultsPath(runId);
  ensureDir(path);
  appendFileSync(path, `${safeSerialize(result)}\n`, "utf8");
}

export function readResults(runId: string): CaseResult[] {
  const path = resultsPath(runId);
  if (!existsSync(path)) return [];
  const out: CaseResult[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    out.push(JSON.parse(trimmed) as CaseResult);
  }
  return out;
}

/**
 * Stage-2 SUPPLEMENTAL evidence stream (SOURCE B) — a STRUCTURALLY SEPARATE
 * file from `results.jsonl`, never appended to it and never read by
 * `readResults`. This is the round's "separate raw result streams"
 * requirement: nothing downstream can accidentally treat main-holdout and
 * supplemental rows as one 126-row corpus selection, because they are not
 * even in the same file.
 */
export function supplementalResultsPath(runId: string): string {
  return resolve(runDir(runId), "supplemental-results.jsonl");
}

export function appendSupplementalResult(runId: string, result: SupplementalCaseResult): void {
  const path = supplementalResultsPath(runId);
  ensureDir(path);
  appendFileSync(path, `${safeSerialize(result)}\n`, "utf8");
}

export function readSupplementalResults(runId: string): SupplementalCaseResult[] {
  const path = supplementalResultsPath(runId);
  if (!existsSync(path)) return [];
  const out: SupplementalCaseResult[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    out.push(JSON.parse(trimmed) as SupplementalCaseResult);
  }
  return out;
}

// ---------------------------------------------------------------------------
// PROMPT-V3 POSTHOC DIAGNOSTIC streams (PR #40) — STRUCTURALLY SEPARATE files
// from `results.jsonl`/`supplemental-results.jsonl`, never read by
// `readResults`/`readSupplementalResults` and never written by
// `appendResult`/`appendSupplementalResult`. A prompt-v3 diagnostic run must
// never be confusable with, or silently mixed into, a v2 `screen`/`final`
// run's own evidence — separate files are the structural enforcement of that,
// on top of the `prompt_version` field difference every row already carries.
// ---------------------------------------------------------------------------

export function promptV3DiagnosticResultsPath(runId: string): string {
  return resolve(runDir(runId), "promptv3-diagnostic-results.jsonl");
}

export function appendPromptV3DiagnosticResult(runId: string, result: CaseResult): void {
  const path = promptV3DiagnosticResultsPath(runId);
  ensureDir(path);
  appendFileSync(path, `${safeSerialize(result)}\n`, "utf8");
}

export function readPromptV3DiagnosticResults(runId: string): CaseResult[] {
  const path = promptV3DiagnosticResultsPath(runId);
  if (!existsSync(path)) return [];
  const out: CaseResult[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    out.push(JSON.parse(trimmed) as CaseResult);
  }
  return out;
}

export function promptV3DiagnosticSupplementalResultsPath(runId: string): string {
  return resolve(runDir(runId), "promptv3-diagnostic-supplemental-results.jsonl");
}

export function appendPromptV3DiagnosticSupplementalResult(
  runId: string,
  result: SupplementalCaseResult,
): void {
  const path = promptV3DiagnosticSupplementalResultsPath(runId);
  ensureDir(path);
  appendFileSync(path, `${safeSerialize(result)}\n`, "utf8");
}

export function readPromptV3DiagnosticSupplementalResults(runId: string): SupplementalCaseResult[] {
  const path = promptV3DiagnosticSupplementalResultsPath(runId);
  if (!existsSync(path)) return [];
  const out: SupplementalCaseResult[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    out.push(JSON.parse(trimmed) as SupplementalCaseResult);
  }
  return out;
}

export function promptV3DiagnosticGeneralizationResultsPath(runId: string): string {
  return resolve(runDir(runId), "promptv3-diagnostic-generalization-results.jsonl");
}

export function appendPromptV3DiagnosticGeneralizationResult(
  runId: string,
  result: SupplementalCaseResult,
): void {
  const path = promptV3DiagnosticGeneralizationResultsPath(runId);
  ensureDir(path);
  appendFileSync(path, `${safeSerialize(result)}\n`, "utf8");
}

export function readPromptV3DiagnosticGeneralizationResults(
  runId: string,
): SupplementalCaseResult[] {
  const path = promptV3DiagnosticGeneralizationResultsPath(runId);
  if (!existsSync(path)) return [];
  const out: SupplementalCaseResult[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    out.push(JSON.parse(trimmed) as SupplementalCaseResult);
  }
  return out;
}

export function writeText(runId: string, filename: string, contents: string): string {
  const path = resolve(runDir(runId), filename);
  ensureDir(path);
  writeFileSync(path, redactSecrets(contents, currentSecrets()), "utf8");
  return path;
}

export function writeJson(runId: string, filename: string, value: unknown): string {
  const path = resolve(runDir(runId), filename);
  ensureDir(path);
  writeFileSync(
    path,
    `${redactSecrets(JSON.stringify(value, null, 2), currentSecrets())}\n`,
    "utf8",
  );
  return path;
}
