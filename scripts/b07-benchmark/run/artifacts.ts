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
import type { CaseResult, RunManifest } from "./types";

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
