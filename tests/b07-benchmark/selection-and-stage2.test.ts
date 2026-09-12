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
import { selectCases } from "../../scripts/b07-benchmark/corpus/load";
import { readManifest, runDir, writeJson } from "../../scripts/b07-benchmark/run/artifacts";
import { caseSetDigest } from "../../scripts/b07-benchmark/run/digest";
import { SelectionMismatchError } from "../../scripts/b07-benchmark/run/selection";

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

describe("8/9. Stage-2 finalist safety", () => {
  it("8. `final` without an explicit --candidate fails before any case selection or provider call", async () => {
    const fetchMock = fetchMustNotBeCalled();
    vi.stubGlobal("fetch", fetchMock);
    const args = parseArgs(["final"]);
    await expect(runStage("final", args)).rejects.toThrow(/requires explicit --candidate/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("9. a ceiling-role candidate requires --finalist-reason and is never implicitly included", async () => {
    vi.stubGlobal("fetch", fetchMustNotBeCalled());
    const runId = freshRunId("ceiling-no-reason");
    const args = parseArgs([
      "final",
      "--candidate",
      "anthropic-opus-5",
      "--split",
      "holdout",
      "--run",
      runId,
    ]);
    await expect(runStage("final", args)).rejects.toThrow(/require --finalist-reason/);
  });

  it("a ceiling candidate WITH a stated reason proceeds, and the reason is recorded in the manifest", async () => {
    vi.stubGlobal("fetch", fetchMustNotBeCalled());
    const runId = freshRunId("ceiling-with-reason");
    const args = parseArgs([
      "final",
      "--candidate",
      "anthropic-opus-5",
      "--split",
      "holdout",
      "--from-run",
      "screen-run-abc123",
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
    expect(manifest?.finalist_provenance?.screen_run_id).toBe("screen-run-abc123");
    expect(manifest?.finalist_provenance?.finalist_reason).toMatch(/achievable ceiling/);
    expect(manifest?.finalist_provenance?.candidate_roles["anthropic-opus-5"]).toBe("ceiling");
  });

  it("`final` with only explicit non-ceiling finalists proceeds without a --finalist-reason", async () => {
    vi.stubGlobal("fetch", fetchMustNotBeCalled());
    const runId = freshRunId("final-no-ceiling");
    const args = parseArgs([
      "final",
      "--candidate",
      "anthropic-sonnet-5",
      "--split",
      "holdout",
      "--run",
      runId,
    ]);
    await expect(runStage("final", args)).resolves.toBeUndefined();
  });
});
