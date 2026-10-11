/**
 * B07 benchmark — secret redaction at the persistence boundary (external
 * audit finding 15).
 *
 * The prior implementation cached `collectSecretValues()` in a module-level
 * constant computed once at import time, which misses any secret-looking env
 * var set (or changed) afterwards — exactly what happens in real use, since
 * `loadLocalEnv()` and per-run key configuration both happen after this
 * module is first imported. This suite proves redaction is computed fresh
 * against the CURRENT environment on every write, and that a fake credential
 * echoed in a provider error body never reaches console output or a
 * persisted artifact.
 *
 * Acceptance test covered: 20 (secret echoed in provider error is absent
 * from persisted artifacts/logs).
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { MODEL_CANDIDATES } from "../../scripts/b07-benchmark/config/candidates";
import { selectCases } from "../../scripts/b07-benchmark/corpus/load";
import {
  appendResult,
  readResults,
  resultsPath,
  runDir,
  writeJson,
} from "../../scripts/b07-benchmark/run/artifacts";
import { runCandidate } from "../../scripts/b07-benchmark/run/runner";
import { collectSecretValues, createSafeLogger } from "../../scripts/provider-evaluation/redact";

const openaiCandidate = MODEL_CANDIDATES.find((c) => c.id === "openai-gpt-5-6-luna");
if (!openaiCandidate)
  throw new Error("test fixture assumption broken: openai-gpt-5-6-luna missing");

const cleanupDirs: string[] = [];
function freshRunId(label: string): string {
  const id = `test-secrets-${label}-${randomUUID().slice(0, 8)}`;
  cleanupDirs.push(runDir(id));
  return id;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.OPENAI_API_KEY;
  delete process.env.B07_TEST_LATE_SECRET_KEY;
  for (const dir of cleanupDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("FIXED: redaction is recomputed against the current environment on every write", () => {
  it("redacts a secret-looking env var that was set AFTER this module was first imported", () => {
    // `artifacts.ts` (and this test file) were already imported by the time
    // this line runs — that is the exact gap the prior module-level cache
    // missed. B07_TEST_LATE_SECRET_KEY's name matches the secret-name
    // patterns (contains KEY) only because we set it here, well after import.
    const lateSecret = "late-secret-value-0123456789";
    process.env.B07_TEST_LATE_SECRET_KEY = lateSecret;
    expect(collectSecretValues()).toContain(lateSecret);

    const runId = freshRunId("late-secret");
    writeJson(runId, "manifest.json", { note: `carries ${lateSecret} inline` });
    const path = resultsPath(runId).replace("results.jsonl", "manifest.json");
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).not.toContain(lateSecret);
    expect(onDisk).toContain("[REDACTED]");
  });
});

describe("20. a secret echoed in a provider error is absent from persisted artifacts and logs", () => {
  it("redacts a fake API key that a mocked provider error body deliberately echoes back", async () => {
    const fakeKey = "sk-fake-leaked-key-9876543210abcdef";
    process.env.OPENAI_API_KEY = fakeKey;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        if (!init || init.method === "GET") {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ id: "available" }),
            text: () => Promise.resolve("{}"),
          } as Response);
        }
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.reject(new Error("not json")),
          // A hostile/misconfigured provider echoing the caller's own key
          // back in an error body — the worst-case leak surface.
          text: () => Promise.resolve(`invalid request, your key was: ${fakeKey}`),
        } as Response);
      }),
    );

    const runId = freshRunId("echoed-key");
    const cases = selectCases({ split: "dev" }).slice(0, 1);

    const logLines: string[] = [];
    const log = createSafeLogger(collectSecretValues());
    const originalConsoleLog = console.log;
    // eslint-disable-next-line no-console -- capturing for the assertion below
    console.log = (...args: unknown[]) => {
      logLines.push(args.map(String).join(" "));
    };
    try {
      const outcome = await runCandidate({
        runId,
        candidate: openaiCandidate,
        cases,
        concurrency: 1,
        maxSchemaRetries: 0,
        dryRun: false,
        resume: false,
        log,
      });

      expect(outcome.results).toHaveLength(1);
      const result = outcome.results[0];
      expect(result?.status).toBe("provider_error");
      // In-memory result must already be redacted (error-normalisation
      // boundary), not just the eventual file write.
      const attemptSummary = result?.attempts[0]?.error_summary ?? "";
      expect(attemptSummary).not.toContain(fakeKey);
      expect(attemptSummary).toContain("[REDACTED]");

      log(`diagnostic: ${JSON.stringify(result)}`);
    } finally {
      console.log = originalConsoleLog;
    }

    for (const line of logLines) expect(line).not.toContain(fakeKey);

    // And the persisted artifact on disk — the actual thing this finding is
    // about — must not contain the key either.
    const persisted = readResults(runId);
    expect(persisted).toHaveLength(1);
    expect(JSON.stringify(persisted)).not.toContain(fakeKey);
    const rawFile = readFileSync(resultsPath(runId), "utf8");
    expect(rawFile).not.toContain(fakeKey);
  });

  it("appendResult redacts even when the secret was added to the environment after import", () => {
    const secret = "sk-appendresult-secret-1122334455";
    process.env.B07_TEST_LATE_SECRET_KEY = secret;
    const runId = freshRunId("append-late-secret");
    appendResult(runId, {
      run_id: runId,
      candidate_id: "c",
      provider_id: "openai",
      requested_model: "m",
      inference_config: {
        policy_version: "v",
        provider_id: "openai",
        model_capability_profile: "openai_provider_default_v1",
        thinking_mode: "disabled",
        effort: null,
        budget_tokens: null,
        reasoning_effort: "medium",
        temperature: "provider_default",
        max_output_tokens: 512,
        structured_output_transport_version: "v",
      },
      inference_config_digest: "d",
      endpoint: "https://example.invalid",
      case_id: "m-en-dev-001",
      task: "message",
      split: "dev",
      corpus_version: "v",
      prompt_version: "p",
      schema_version: "s",
      status: "provider_error",
      attempts: [
        {
          index: 1,
          kind: "initial",
          outcome: "provider_error",
          http_status: 401,
          error_summary: `leaked ${secret} in error body`,
          latency_ms: 10,
          usage: {
            input_tokens: null,
            output_tokens: null,
            reasoning_tokens: null,
            cached_input_tokens: null,
          },
          returned_model: null,
        },
      ],
      first_pass_schema_valid: false,
      retry_used: false,
      final_schema_valid: false,
      prediction: null,
      total_latency_ms: 10,
      usage_totals: {
        input_tokens: null,
        output_tokens: null,
        reasoning_tokens: null,
        cached_input_tokens: null,
      },
      evaluated_at: new Date().toISOString(),
    });
    const raw = readFileSync(resultsPath(runId), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("[REDACTED]");
  });
});
