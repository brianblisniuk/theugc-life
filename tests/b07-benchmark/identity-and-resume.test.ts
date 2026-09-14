/**
 * B07 benchmark — result identity and resume safety (external audit findings
 * 1 and 2), exercised end to end through `runCandidate` with a mocked
 * `fetch`. No live network or real API key is used anywhere in this file.
 *
 * Acceptance tests covered: 1 (compatibility identity changes when requested
 * model changes), 2 (compatibility identity changes when inference config
 * changes), 3 (`not_run_missing_key` is re-runnable once key exists), 4
 * (model A rows cannot score as model B), 5 (mixed incompatible model/config
 * rows are refused, not last-row-wins), 19 (provider-returned model/version
 * drift is detected).
 *
 * Attack cases covered: model override A → B with same candidate and
 * `--resume`; missing key → key later → resume; provider error → resume;
 * interrupted run.
 */
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MODEL_CANDIDATES,
  modelOverrideEnvVar,
} from "../../scripts/b07-benchmark/config/candidates";
import { selectCases } from "../../scripts/b07-benchmark/corpus/load";
import { readResults, runDir } from "../../scripts/b07-benchmark/run/artifacts";
import { runCandidate } from "../../scripts/b07-benchmark/run/runner";
import { resultCompatibilityKey } from "../../scripts/b07-benchmark/run/types";
import { scoreCandidate } from "../../scripts/b07-benchmark/scoring/score";

const openaiCandidate = MODEL_CANDIDATES.find((c) => c.id === "openai-gpt-5-6-luna");
if (!openaiCandidate)
  throw new Error("test fixture assumption broken: openai-gpt-5-6-luna missing");

const OVERRIDE_ENV_VAR = modelOverrideEnvVar(openaiCandidate.id);

function okBody(model: string) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        model,
        output_text: '{"disposition":"positive","signals":[],"evidence_strength":"strong"}',
        usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: {} },
      }),
    text: () => Promise.resolve("{}"),
  } as Response;
}

function errorBody(status: number) {
  return {
    ok: false,
    status,
    json: () => Promise.reject(new Error("nope")),
    text: () => Promise.resolve("server error"),
  } as Response;
}

const availabilityCheckOk = {
  ok: true,
  status: 200,
  json: () => Promise.resolve({ id: "available" }),
  text: () => Promise.resolve("{}"),
} as Response;

/**
 * `runCandidate` also performs a GET availability check against the
 * provider's own model listing before scoring any case (a separate, honest
 * concern from the actual invoke calls this suite is measuring). This helper
 * routes GET requests to a canned "available" response and POST requests
 * (the actual case invocations) through `onInvoke`, so tests can assert
 * invoke-call counts and per-call bodies without the availability check
 * shifting call indices.
 */
function makeInvokeFetchMock(onInvoke: (invokeCallIndex: number) => Response) {
  let invokeCalls = 0;
  const fn = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if (!init || init.method === "GET") return Promise.resolve(availabilityCheckOk);
    const response = onInvoke(invokeCalls);
    invokeCalls += 1;
    return Promise.resolve(response);
  });
  return fn;
}

function invokeCallCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((call) => {
    const init = call[1] as RequestInit | undefined;
    return init?.method === "POST";
  }).length;
}

const cleanupDirs: string[] = [];
function freshRunId(label: string): string {
  const id = `test-identity-${label}-${randomUUID().slice(0, 8)}`;
  cleanupDirs.push(runDir(id));
  return id;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.OPENAI_API_KEY;
  delete process.env[OVERRIDE_ENV_VAR];
  for (const dir of cleanupDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

describe("resultCompatibilityKey — unit identity (acceptance 1, 2)", () => {
  const base = {
    candidate_id: "c1",
    provider_id: "openai",
    requested_model: "gpt-5.6-luna",
    inference_config_digest: "digest-a",
    case_id: "m-en-dev-001",
    corpus_version: "v1",
    prompt_version: "p1",
    schema_version: "s1",
  };

  it("1. a changed requested model changes the key", () => {
    expect(resultCompatibilityKey(base)).not.toBe(
      resultCompatibilityKey({ ...base, requested_model: "gpt-5.6-terra" }),
    );
  });

  it("2. a changed inference-config digest changes the key", () => {
    expect(resultCompatibilityKey(base)).not.toBe(
      resultCompatibilityKey({ ...base, inference_config_digest: "digest-b" }),
    );
  });
});

describe("attack: missing key -> key later -> resume (acceptance 3)", () => {
  it("re-runs cases previously recorded not_run_missing_key once the key is present", async () => {
    const runId = freshRunId("missing-key-resume");
    const cases = selectCases({ split: "dev" }).slice(0, 3);

    delete process.env.OPENAI_API_KEY;
    const first = await runCandidate({
      runId,
      candidate: openaiCandidate,
      cases,
      concurrency: 2,
      maxSchemaRetries: 1,
      dryRun: false,
      resume: false,
      log: () => {},
    });
    expect(first.availability).toBe("not_run_missing_key");
    for (const r of first.results) expect(r.status).toBe("not_run_missing_key");

    process.env.OPENAI_API_KEY = "sk-test-now-present-0123456789";
    const fetchMock = makeInvokeFetchMock(() => okBody("gpt-5.6-luna-2026"));
    vi.stubGlobal("fetch", fetchMock);

    const second = await runCandidate({
      runId,
      candidate: openaiCandidate,
      cases,
      concurrency: 2,
      maxSchemaRetries: 1,
      dryRun: false,
      resume: true,
      log: () => {},
    });

    // Nothing was reused from the old absence: every case was actually called.
    expect(second.reusedFromResume).toBe(0);
    expect(invokeCallCount(fetchMock)).toBe(cases.length);
    for (const r of second.results) {
      expect(r.status).toBe("ok");
      expect(r.prediction).not.toBeNull();
    }
  });
});

describe("attack: provider error -> resume (transient failures are retried, not frozen)", () => {
  it("retries a case that previously failed with a provider error", async () => {
    const runId = freshRunId("provider-error-resume");
    const cases = selectCases({ split: "dev" }).slice(0, 2);
    process.env.OPENAI_API_KEY = "sk-test-0123456789";

    vi.stubGlobal(
      "fetch",
      makeInvokeFetchMock(() => errorBody(503)),
    );
    const first = await runCandidate({
      runId,
      candidate: openaiCandidate,
      cases,
      concurrency: 2,
      maxSchemaRetries: 0,
      dryRun: false,
      resume: false,
      log: () => {},
    });
    for (const r of first.results) expect(r.status).toBe("provider_error");

    const fetchMock = makeInvokeFetchMock(() => okBody("gpt-5.6-luna-2026"));
    vi.stubGlobal("fetch", fetchMock);
    const second = await runCandidate({
      runId,
      candidate: openaiCandidate,
      cases,
      concurrency: 2,
      maxSchemaRetries: 0,
      dryRun: false,
      resume: true,
      log: () => {},
    });
    expect(second.reusedFromResume).toBe(0);
    expect(invokeCallCount(fetchMock)).toBe(cases.length);
    for (const r of second.results) expect(r.status).toBe("ok");
  });
});

describe("attack: interrupted run -> resume (settled work is reused, the rest is completed)", () => {
  it("reuses the settled cases and only calls the provider for the remaining ones", async () => {
    const runId = freshRunId("interrupted-resume");
    const allCases = selectCases({ split: "dev" }).slice(0, 4);
    const firstHalf = allCases.slice(0, 2);
    process.env.OPENAI_API_KEY = "sk-test-0123456789";

    const fetchMock1 = makeInvokeFetchMock(() => okBody("gpt-5.6-luna-2026"));
    vi.stubGlobal("fetch", fetchMock1);
    await runCandidate({
      runId,
      candidate: openaiCandidate,
      cases: firstHalf,
      concurrency: 2,
      maxSchemaRetries: 1,
      dryRun: false,
      resume: false,
      log: () => {},
    });
    expect(invokeCallCount(fetchMock1)).toBe(firstHalf.length);

    const fetchMock2 = makeInvokeFetchMock(() => okBody("gpt-5.6-luna-2026"));
    vi.stubGlobal("fetch", fetchMock2);
    const resumed = await runCandidate({
      runId,
      candidate: openaiCandidate,
      cases: allCases,
      concurrency: 2,
      maxSchemaRetries: 1,
      dryRun: false,
      resume: true,
      log: () => {},
    });
    expect(resumed.reusedFromResume).toBe(firstHalf.length);
    expect(invokeCallCount(fetchMock2)).toBe(allCases.length - firstHalf.length);
    expect(resumed.results).toHaveLength(allCases.length);
  });
});

describe("attack: model override A -> B with same candidate and --resume (acceptance 4, 5)", () => {
  it("never reuses a result computed under a different requested model, and refuses to blend it into a score", async () => {
    const runId = freshRunId("model-override-resume");
    const cases = selectCases({ split: "dev" }).slice(0, 2);
    process.env.OPENAI_API_KEY = "sk-test-0123456789";

    vi.stubGlobal(
      "fetch",
      makeInvokeFetchMock(() => okBody("model-A-returned")),
    );
    const first = await runCandidate({
      runId,
      candidate: openaiCandidate,
      cases,
      concurrency: 2,
      maxSchemaRetries: 1,
      dryRun: false,
      resume: false,
      log: () => {},
    });
    expect(first.model).toBe(openaiCandidate.model);

    // Operator changes the model override between runs — same candidate id,
    // same run id, DIFFERENT requested model.
    process.env[OVERRIDE_ENV_VAR] = "gpt-5.6-luna-B-variant";
    const fetchMock2 = makeInvokeFetchMock(() => okBody("model-B-returned"));
    vi.stubGlobal("fetch", fetchMock2);
    const second = await runCandidate({
      runId,
      candidate: openaiCandidate,
      cases,
      concurrency: 2,
      maxSchemaRetries: 1,
      dryRun: false,
      resume: true,
      log: () => {},
    });

    expect(second.model).toBe("gpt-5.6-luna-B-variant");
    // 4. Model A's identity must never be reused as though it were model B's.
    expect(second.reusedFromResume).toBe(0);
    expect(invokeCallCount(fetchMock2)).toBe(cases.length);

    const rows = readResults(runId).filter((r) => r.candidate_id === openaiCandidate.id);
    expect(rows.length).toBe(cases.length * 2);

    // 5. Scoring must refuse to silently pick one identity's rows over the
    // other ("last row wins") — it must invalidate the candidate instead.
    const score = scoreCandidate({
      candidateId: openaiCandidate.id,
      providerId: openaiCandidate.providerId,
      requestedModel: second.model,
      corpusVersion: rows[0]?.corpus_version ?? "unknown",
      promptVersion: rows[0]?.prompt_version ?? "unknown",
      schemaVersion: rows[0]?.schema_version ?? "unknown",
      cases,
      results: rows,
      priceBook: null,
    });
    expect(score.invalidated_reason).not.toBeNull();
    expect(score.identity_conflicts.length).toBe(cases.length);
    expect(score.critical_suite.passes_hard_gate).toBe(false);
  });
});

describe("acceptance 19: provider-returned model/version drift is detected", () => {
  it("invalidates a candidate whose provider returned different model versions across cases, rather than blending them", async () => {
    const runId = freshRunId("returned-model-drift");
    const cases = selectCases({ split: "dev" }).slice(0, 2);
    process.env.OPENAI_API_KEY = "sk-test-0123456789";

    vi.stubGlobal(
      "fetch",
      makeInvokeFetchMock((invokeCallIndex) =>
        okBody(invokeCallIndex === 0 ? "gpt-5.6-luna-2026-08" : "gpt-5.6-luna-2026-09"),
      ),
    );
    const outcome = await runCandidate({
      runId,
      candidate: openaiCandidate,
      cases,
      concurrency: 1, // deterministic call order for the two distinct returned models
      maxSchemaRetries: 0,
      dryRun: false,
      resume: false,
      log: () => {},
    });

    const score = scoreCandidate({
      candidateId: openaiCandidate.id,
      providerId: openaiCandidate.providerId,
      requestedModel: outcome.model,
      corpusVersion: outcome.results[0]?.corpus_version ?? "unknown",
      promptVersion: outcome.results[0]?.prompt_version ?? "unknown",
      schemaVersion: outcome.results[0]?.schema_version ?? "unknown",
      cases,
      results: outcome.results,
      priceBook: null,
    });
    expect(score.reliability.returned_models.length).toBe(2);
    expect(score.invalidated_reason).not.toBeNull();
    expect(score.invalidated_reason).toMatch(/distinct model versions/);
  });
});
