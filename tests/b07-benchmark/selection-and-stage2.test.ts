/**
 * B07 benchmark — exact selection reproducibility (external audit finding 3)
 * and Stage-2 finalist safety (external audit finding 4), exercised through
 * the actual CLI entry points (`runStage`, `commandReport`, `parseArgs`).
 *
 * No live network or real API key is used anywhere in this file — every test
 * either uses only the local deterministic baseline, or stubs `fetch` to
 * throw so an accidental provider call fails the test loudly.
 *
 * Acceptance tests covered: 6 (critical-only report reproduces exact
 * selected cases), 7 (case-set/selection mismatch is refused), 8 (`final`
 * without explicit validated finalists causes zero provider calls and fails
 * early), 9 (ceiling candidate is never implicit).
 */
import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { commandReport, parseArgs, runStage } from "../../scripts/b07-benchmark/cli";
import { candidateById, resolveModel } from "../../scripts/b07-benchmark/config/candidates";
import {
  effectiveInferenceConfig,
  inferenceConfigDigest,
} from "../../scripts/b07-benchmark/config/inference-config";
import { selectCases } from "../../scripts/b07-benchmark/corpus/load";
import { readManifest, runDir, writeJson } from "../../scripts/b07-benchmark/run/artifacts";
import { caseSetDigest } from "../../scripts/b07-benchmark/run/digest";
import { MAX_OUTPUT_TOKENS } from "../../scripts/b07-benchmark/run/runner";
import { SelectionMismatchError } from "../../scripts/b07-benchmark/run/selection";
import { writeStage1FinalistFixture } from "./helpers/stage1-fixture";

const cleanupDirs: string[] = [];
function freshRunId(label: string): string {
  const id = `test-stage-${label}-${randomUUID().slice(0, 8)}`;
  cleanupDirs.push(runDir(id));
  return id;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const dir of cleanupDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

/** A fetch stub that fails the test if the harness ever tries a real call. */
function fetchMustNotBeCalled() {
  return vi.fn().mockImplementation(() => {
    throw new Error("TEST FAILURE: a provider fetch call was made when none should have happened");
  });
}

describe("6/7. exact selection reproducibility", () => {
  it("6. a --critical-only run's later report reproduces exactly the critical-only case set, not the full split", async () => {
    vi.stubGlobal("fetch", fetchMustNotBeCalled());
    const runId = freshRunId("critical-only");
    const expectedCases = selectCases({ split: "dev", criticalOnly: true });
    expect(expectedCases.length).toBeGreaterThan(0);
    expect(expectedCases.length).toBeLessThan(selectCases({ split: "dev" }).length);

    const args = parseArgs([
      "screen",
      "--candidate",
      "benchmark-rules-baseline",
      "--critical-only",
      "--run",
      runId,
    ]);
    await runStage("screen", args);

    const manifest = readManifest(runId);
    expect(manifest).not.toBeNull();
    expect(manifest?.selection.critical_only).toBe(true);
    expect(manifest?.selected_case_ids.length).toBe(expectedCases.length);
    expect(manifest?.case_set_digest).toBe(caseSetDigest(expectedCases.map((c) => c.case_id)));

    // report --run must reconstruct the SAME critical-only set, not the full
    // dev split — this is precisely the defect finding 3 describes.
    expect(() => commandReport(parseArgs(["report", "--run", runId]))).not.toThrow();
  });

  it("7. a manifest whose recorded ids disagree with its own digest is refused, never silently reinterpreted", async () => {
    vi.stubGlobal("fetch", fetchMustNotBeCalled());
    const runId = freshRunId("tampered-digest");
    const args = parseArgs([
      "baseline",
      "--candidate",
      "benchmark-rules-baseline",
      "--split",
      "dev",
      "--run",
      runId,
    ]);
    await runStage("baseline", args);

    const manifest = readManifest(runId);
    expect(manifest).not.toBeNull();
    if (!manifest) return;
    // Corrupt the manifest: keep the ids, but poison the digest — simulating
    // a hand-edited or corrupted artifact.
    writeJson(runId, "manifest.json", { ...manifest, case_set_digest: "0000deadbeef0000" });

    expect(() => commandReport(parseArgs(["report", "--run", runId]))).toThrow(
      SelectionMismatchError,
    );
  });

  it("7b. resuming the same --run id under a different selection is refused, not silently accepted", async () => {
    vi.stubGlobal("fetch", fetchMustNotBeCalled());
    const runId = freshRunId("selection-change-resume");
    await runStage(
      "screen",
      parseArgs([
        "screen",
        "--candidate",
        "benchmark-rules-baseline",
        "--split",
        "dev",
        "--run",
        runId,
      ]),
    );
    await expect(
      runStage(
        "screen",
        parseArgs([
          "screen",
          "--candidate",
          "benchmark-rules-baseline",
          "--split",
          "dev",
          "--critical-only",
          "--run",
          runId,
          "--resume",
        ]),
      ),
    ).rejects.toThrow(/selection changed/);
  });
});

/**
 * Sets up a genuine, locally-persisted Stage-1 "screen" finalist fixture for
 * `candidateId` (via `writeStage1FinalistFixture` — zero network, zero CLI
 * invocation) and registers its artifact directory for cleanup. Used by every
 * "provenance satisfied -> proceeds" test below so they exercise the REAL
 * post-hardening validation path rather than bypassing it.
 */
function setUpValidStage1Run(candidateId: string): string {
  const candidate = candidateById(candidateId);
  if (!candidate)
    throw new Error(`test fixture assumption broken: unknown candidate ${candidateId}`);
  const model = resolveModel(candidate);
  const inferenceConfig = effectiveInferenceConfig(
    { providerId: candidate.providerId, model },
    MAX_OUTPUT_TOKENS,
  );
  const { runId } = writeStage1FinalistFixture({
    candidateId,
    providerId: candidate.providerId,
    model,
    inferenceConfig,
    inferenceConfigDigest: inferenceConfigDigest(inferenceConfig),
  });
  cleanupDirs.push(runDir(runId));
  return runId;
}

describe("8/9. Stage-2 finalist safety", () => {
  it("8. `final` without an explicit --candidate fails before any case selection or provider call", async () => {
    const fetchMock = fetchMustNotBeCalled();
    vi.stubGlobal("fetch", fetchMock);
    const args = parseArgs(["final"]);
    await expect(runStage("final", args)).rejects.toThrow(/requires explicit --candidate/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PASS C attack: missing provenance — `final --candidate X` without --from-run fails BEFORE any provider call, for a ceiling candidate exactly like any other", async () => {
    const fetchMock = fetchMustNotBeCalled();
    vi.stubGlobal("fetch", fetchMock);
    const runId = freshRunId("ceiling-no-from-run");
    const args = parseArgs([
      "final",
      "--candidate",
      "anthropic-opus-5",
      "--finalist-reason",
      "screening left the achievable ceiling ambiguous",
      "--split",
      "holdout",
      "--run",
      runId,
    ]);
    await expect(runStage("final", args)).rejects.toThrow(/--from-run.*REQUIRED/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PASS C attack: missing --finalist-reason (valid --from-run present) still fails BEFORE any provider call", async () => {
    vi.stubGlobal("fetch", fetchMustNotBeCalled());
    const stage1RunId = setUpValidStage1Run("anthropic-opus-5");
    const runId = freshRunId("ceiling-no-reason");
    const args = parseArgs([
      "final",
      "--candidate",
      "anthropic-opus-5",
      "--from-run",
      stage1RunId,
      "--split",
      "holdout",
      "--run",
      runId,
    ]);
    await expect(runStage("final", args)).rejects.toThrow(/--finalist-reason.*REQUIRED/);
  });

  it("PASS C attack: fake provenance — --from-run pointing at a run id that does not exist fails BEFORE any provider call", async () => {
    vi.stubGlobal("fetch", fetchMustNotBeCalled());
    const runId = freshRunId("ceiling-fake-provenance");
    const args = parseArgs([
      "final",
      "--candidate",
      "anthropic-opus-5",
      "--split",
      "holdout",
      "--from-run",
      "screen-run-abc123-does-not-exist",
      "--finalist-reason",
      "screening left the achievable ceiling ambiguous",
      "--run",
      runId,
    ]);
    await expect(runStage("final", args)).rejects.toThrow(
      /does not resolve to any persisted run manifest/,
    );
  });

  it("PASS C attack: fake provenance — --from-run pointing at a BASELINE run (not a screen run) fails BEFORE any provider call", async () => {
    vi.stubGlobal("fetch", fetchMustNotBeCalled());
    const baselineRunId = freshRunId("baseline-not-screen");
    await runStage(
      "baseline",
      parseArgs([
        "baseline",
        "--candidate",
        "benchmark-rules-baseline",
        "--split",
        "dev",
        "--run",
        baselineRunId,
      ]),
    );
    const runId = freshRunId("ceiling-from-baseline-run");
    const args = parseArgs([
      "final",
      "--candidate",
      "anthropic-opus-5",
      "--split",
      "holdout",
      "--from-run",
      baselineRunId,
      "--finalist-reason",
      "screening left the achievable ceiling ambiguous",
      "--run",
      runId,
    ]);
    await expect(runStage("final", args)).rejects.toThrow(/not a Stage-1 "screen" run/);
  });

  it("PASS C attack: fake provenance — --from-run pointing at a screen run where the candidate was ELIMINATED fails BEFORE any provider call", async () => {
    vi.stubGlobal("fetch", fetchMustNotBeCalled());
    const candidate = candidateById("anthropic-opus-5");
    if (!candidate) throw new Error("fixture assumption broken");
    const model = resolveModel(candidate);
    const inferenceConfig = effectiveInferenceConfig(
      { providerId: candidate.providerId, model },
      MAX_OUTPUT_TOKENS,
    );
    const { runId: stage1RunId } = writeStage1FinalistFixture({
      candidateId: "anthropic-opus-5",
      providerId: candidate.providerId,
      model,
      inferenceConfig,
      inferenceConfigDigest: inferenceConfigDigest(inferenceConfig),
      // Force an eliminated Stage-1 status regardless of the underlying
      // (otherwise perfect) evidence — an eliminated candidate's provenance
      // must never be laundered through by a `--from-run` pointing at it.
      scoreOverrides: {
        critical_suite: {
          cases: 1,
          cases_evaluated: 1,
          cases_not_evaluated: 0,
          violations: 2,
          violations_by_invariant: { politeness_not_positive: 2 },
          violation_details: [],
          passes_hard_gate: false,
        },
      },
    });
    cleanupDirs.push(runDir(stage1RunId));

    const runId = freshRunId("ceiling-from-eliminated-run");
    const args = parseArgs([
      "final",
      "--candidate",
      "anthropic-opus-5",
      "--split",
      "holdout",
      "--from-run",
      stage1RunId,
      "--finalist-reason",
      "screening left the achievable ceiling ambiguous",
      "--run",
      runId,
    ]);
    await expect(runStage("final", args)).rejects.toThrow(/not a Stage-1 finalist/);
  });

  it("PASS C attack: requested-model mismatch (Stage-1 evaluated a different model than Stage 2 resolves) fails BEFORE any provider call", async () => {
    vi.stubGlobal("fetch", fetchMustNotBeCalled());
    const candidate = candidateById("anthropic-opus-5");
    if (!candidate) throw new Error("fixture assumption broken");
    const inferenceConfig = effectiveInferenceConfig(
      { providerId: candidate.providerId, model: "claude-opus-5" },
      MAX_OUTPUT_TOKENS,
    );
    const { runId: stage1RunId } = writeStage1FinalistFixture({
      candidateId: "anthropic-opus-5",
      providerId: candidate.providerId,
      model: "claude-opus-5-DIFFERENT-SNAPSHOT",
      inferenceConfig,
      inferenceConfigDigest: inferenceConfigDigest(inferenceConfig),
    });
    cleanupDirs.push(runDir(stage1RunId));

    const runId = freshRunId("ceiling-model-mismatch");
    const args = parseArgs([
      "final",
      "--candidate",
      "anthropic-opus-5",
      "--split",
      "holdout",
      "--from-run",
      stage1RunId,
      "--finalist-reason",
      "screening left the achievable ceiling ambiguous",
      "--run",
      runId,
    ]);
    await expect(runStage("final", args)).rejects.toThrow(/requested_model/);
  });

  it("PASS C attack: inference-config mismatch (same model, different effective config) fails BEFORE any provider call", async () => {
    vi.stubGlobal("fetch", fetchMustNotBeCalled());
    const candidate = candidateById("anthropic-opus-5");
    if (!candidate) throw new Error("fixture assumption broken");
    const model = resolveModel(candidate);
    const realInferenceConfig = effectiveInferenceConfig(
      { providerId: candidate.providerId, model },
      MAX_OUTPUT_TOKENS,
    );
    const differentInferenceConfig = { ...realInferenceConfig, effort: "low" as const };
    const { runId: stage1RunId } = writeStage1FinalistFixture({
      candidateId: "anthropic-opus-5",
      providerId: candidate.providerId,
      model,
      inferenceConfig: differentInferenceConfig,
      inferenceConfigDigest: inferenceConfigDigest(differentInferenceConfig),
    });
    cleanupDirs.push(runDir(stage1RunId));

    const runId = freshRunId("ceiling-config-mismatch");
    const args = parseArgs([
      "final",
      "--candidate",
      "anthropic-opus-5",
      "--split",
      "holdout",
      "--from-run",
      stage1RunId,
      "--finalist-reason",
      "screening left the achievable ceiling ambiguous",
      "--run",
      runId,
    ]);
    await expect(runStage("final", args)).rejects.toThrow(/inference-config digest/);
  });

  it("PASS C attack: scoring-version mismatch fails BEFORE any provider call", async () => {
    vi.stubGlobal("fetch", fetchMustNotBeCalled());
    const candidate = candidateById("anthropic-opus-5");
    if (!candidate) throw new Error("fixture assumption broken");
    const model = resolveModel(candidate);
    const inferenceConfig = effectiveInferenceConfig(
      { providerId: candidate.providerId, model },
      MAX_OUTPUT_TOKENS,
    );
    const { runId: stage1RunId } = writeStage1FinalistFixture({
      candidateId: "anthropic-opus-5",
      providerId: candidate.providerId,
      model,
      inferenceConfig,
      inferenceConfigDigest: inferenceConfigDigest(inferenceConfig),
      scoringVersionOverride: "b07_benchmark_scoring_v1_stale",
    });
    cleanupDirs.push(runDir(stage1RunId));

    const runId = freshRunId("ceiling-scoring-version-mismatch");
    const args = parseArgs([
      "final",
      "--candidate",
      "anthropic-opus-5",
      "--split",
      "holdout",
      "--from-run",
      stage1RunId,
      "--finalist-reason",
      "screening left the achievable ceiling ambiguous",
      "--run",
      runId,
    ]);
    await expect(runStage("final", args)).rejects.toThrow(/scoring_version/);
  });

  it("PASS C attack: prompt-version mismatch fails BEFORE any provider call", async () => {
    vi.stubGlobal("fetch", fetchMustNotBeCalled());
    const candidate = candidateById("anthropic-opus-5");
    if (!candidate) throw new Error("fixture assumption broken");
    const model = resolveModel(candidate);
    const inferenceConfig = effectiveInferenceConfig(
      { providerId: candidate.providerId, model },
      MAX_OUTPUT_TOKENS,
    );
    const { runId: stage1RunId } = writeStage1FinalistFixture({
      candidateId: "anthropic-opus-5",
      providerId: candidate.providerId,
      model,
      inferenceConfig,
      inferenceConfigDigest: inferenceConfigDigest(inferenceConfig),
      manifestOverrides: { prompt_version: "b07_benchmark_prompt_v1_stale" },
    });
    cleanupDirs.push(runDir(stage1RunId));

    const runId = freshRunId("ceiling-prompt-version-mismatch");
    const args = parseArgs([
      "final",
      "--candidate",
      "anthropic-opus-5",
      "--split",
      "holdout",
      "--from-run",
      stage1RunId,
      "--finalist-reason",
      "screening left the achievable ceiling ambiguous",
      "--run",
      runId,
    ]);
    await expect(runStage("final", args)).rejects.toThrow(/prompt_version/);
  });

  it("a ceiling candidate WITH valid provenance and a stated reason proceeds, and both are recorded in the manifest", async () => {
    vi.stubGlobal("fetch", fetchMustNotBeCalled());
    const stage1RunId = setUpValidStage1Run("anthropic-opus-5");
    const runId = freshRunId("ceiling-with-reason");
    const args = parseArgs([
      "final",
      "--candidate",
      "anthropic-opus-5",
      "--split",
      "holdout",
      "--from-run",
      stage1RunId,
      "--finalist-reason",
      "screening left the achievable ceiling ambiguous",
      "--run",
      runId,
    ]);
    // No ANTHROPIC_API_KEY is set in this test environment, so this never
    // makes a real provider call — it settles as not_run_missing_key.
    await expect(runStage("final", args)).resolves.toBeUndefined();

    const manifest = readManifest(runId);
    expect(manifest?.finalist_provenance).not.toBeNull();
    expect(manifest?.finalist_provenance?.screen_run_id).toBe(stage1RunId);
    expect(manifest?.finalist_provenance?.finalist_reason).toMatch(/achievable ceiling/);
    expect(manifest?.finalist_provenance?.candidate_roles["anthropic-opus-5"]).toBe("ceiling");
    const validated = manifest?.finalist_provenance?.validated_stage1?.["anthropic-opus-5"];
    expect(validated?.stage1_run_id).toBe(stage1RunId);
    expect(validated?.stage1_status).toMatch(/^stage1_finalist/);
  });

  it("`final` with a non-ceiling finalist STILL requires --from-run/--finalist-reason (every finalist, not only ceiling roles) — with valid provenance it proceeds", async () => {
    vi.stubGlobal("fetch", fetchMustNotBeCalled());
    const stage1RunId = setUpValidStage1Run("anthropic-sonnet-5");
    const runId = freshRunId("final-no-ceiling");
    const args = parseArgs([
      "final",
      "--candidate",
      "anthropic-sonnet-5",
      "--split",
      "holdout",
      "--from-run",
      stage1RunId,
      "--finalist-reason",
      "Stage-1 finalist advancing to blind Stage-2 holdout",
      "--run",
      runId,
    ]);
    await expect(runStage("final", args)).resolves.toBeUndefined();
  });
});

describe("BLOCKER 2 attack: `final` can never spend against the wrong selection", () => {
  it("`final --split dev` fails before any provider call and makes zero provider calls", async () => {
    const fetchMock = fetchMustNotBeCalled();
    vi.stubGlobal("fetch", fetchMock);
    const stage1RunId = setUpValidStage1Run("anthropic-sonnet-5");
    const runId = freshRunId("wrong-selection-dev");
    const args = parseArgs([
      "final",
      "--candidate",
      "anthropic-sonnet-5",
      "--split",
      "dev",
      "--from-run",
      stage1RunId,
      "--finalist-reason",
      "attack case",
      "--run",
      runId,
    ]);
    await expect(runStage("final", args)).rejects.toThrow(/STAGE2_WRONG_SELECTION/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("`final --split all` fails before any provider call and makes zero provider calls", async () => {
    const fetchMock = fetchMustNotBeCalled();
    vi.stubGlobal("fetch", fetchMock);
    const stage1RunId = setUpValidStage1Run("anthropic-sonnet-5");
    const runId = freshRunId("wrong-selection-all");
    const args = parseArgs([
      "final",
      "--candidate",
      "anthropic-sonnet-5",
      "--split",
      "all",
      "--from-run",
      stage1RunId,
      "--finalist-reason",
      "attack case",
      "--run",
      runId,
    ]);
    await expect(runStage("final", args)).rejects.toThrow(/STAGE2_WRONG_SELECTION/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("`final --critical-only` (on the holdout split) fails before any provider call and makes zero provider calls", async () => {
    const fetchMock = fetchMustNotBeCalled();
    vi.stubGlobal("fetch", fetchMock);
    const stage1RunId = setUpValidStage1Run("anthropic-sonnet-5");
    const runId = freshRunId("wrong-selection-critical-only");
    const args = parseArgs([
      "final",
      "--candidate",
      "anthropic-sonnet-5",
      "--split",
      "holdout",
      "--critical-only",
      "--from-run",
      stage1RunId,
      "--finalist-reason",
      "attack case",
      "--run",
      runId,
    ]);
    await expect(runStage("final", args)).rejects.toThrow(/STAGE2_WRONG_SELECTION/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("`final` with the EXACT full frozen holdout selection passes the selection lock (proceeds to provenance/availability handling)", async () => {
    vi.stubGlobal("fetch", fetchMustNotBeCalled());
    const stage1RunId = setUpValidStage1Run("anthropic-sonnet-5");
    const runId = freshRunId("right-selection");
    const args = parseArgs([
      "final",
      "--candidate",
      "anthropic-sonnet-5",
      "--split",
      "holdout",
      "--from-run",
      stage1RunId,
      "--finalist-reason",
      "attack case",
      "--run",
      runId,
    ]);
    // No ANTHROPIC_API_KEY is set — settles as not_run_missing_key, never a
    // provider call, but it must NOT throw STAGE2_WRONG_SELECTION.
    await expect(runStage("final", args)).resolves.toBeUndefined();
  });
});
