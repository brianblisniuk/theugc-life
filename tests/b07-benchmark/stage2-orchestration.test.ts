/**
 * B07 benchmark — Stage-2 BLIND end-to-end wiring (this round's deliverable).
 *
 * PASS A — PRE-MORTEM (reproducing the round's blocker):
 *
 * At base head `0606016e920622336f183f426a778fca23884e62`, `scripts/b07-
 * benchmark/cli.ts` referenced the supplemental pack ONLY inside the
 * metadata-only `holdoutSupportPreflight` call and its log/error lines
 * (`git show 0606016:scripts/b07-benchmark/cli.ts | grep -i supplemental`
 * shows every hit lives in the preflight block, none in the provider-calling
 * loop). `final`'s actual candidate loop called `runCandidate` over the main
 * holdout ONLY; nothing sent any of the 6 frozen supplemental cases to any
 * provider, and nothing ever built the supplemental strict confusion
 * `evaluateStage2DispositionMacroF1Target()` requires. So `preflight` could
 * print `resolvable: { disposition_macro_f1: true, ... }` — a statement
 * purely about GOLD SUPPORT ARITHMETIC — while the very next `final`
 * invocation still had no execution path that would ever produce the
 * supplemental prediction evidence needed to actually resolve it.
 *
 * This file pins the fix: `runStage("final", ...)` now schedules BOTH
 * sources, using a fully mocked transport (zero real network calls anywhere
 * in this file — an accidental real call fails the suite loudly via
 * `fetchMustNotBeCalled`/an unstubbed real `fetch`, since no test here ever
 * lets a request escape the mock).
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import { commandReport, parseArgs, runStage } from "../../scripts/b07-benchmark/cli";
import {
  MODEL_CANDIDATES,
  modelOverrideEnvVar,
} from "../../scripts/b07-benchmark/config/candidates";
import { selectCases } from "../../scripts/b07-benchmark/corpus/load";
import {
  loadSupplementalAmbiguityPack,
  supplementalPackManifest,
} from "../../scripts/b07-benchmark/corpus/supplemental-ambiguity-pack";
import {
  readJsonArtifact,
  readResults,
  readSupplementalResults,
  resultsPath,
  runDir,
  supplementalResultsPath,
} from "../../scripts/b07-benchmark/run/artifacts";
import type { CandidateScoreV2 } from "../../scripts/b07-benchmark/scoring/score-v2";
import type { SupplementalScore } from "../../scripts/b07-benchmark/scoring/score-supplemental";
import type { Stage2Evaluation } from "../../scripts/b07-benchmark/scoring/stage2-final";

const openaiCandidate = MODEL_CANDIDATES.find((c) => c.id === "openai-gpt-5-6-luna");
if (!openaiCandidate)
  throw new Error("test fixture assumption broken: openai-gpt-5-6-luna missing");
const OVERRIDE_ENV_VAR = modelOverrideEnvVar(openaiCandidate.id);

const cleanupDirs: string[] = [];
function freshRunId(label: string): string {
  const id = `test-stage2-${label}-${randomUUID().slice(0, 8)}`;
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

function okBody(model: string, jsonText: string) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        model,
        output_text: jsonText,
        usage: { input_tokens: 10, output_tokens: 5, output_tokens_details: {} },
      }),
    text: () => Promise.resolve("{}"),
  } as Response;
}

const availabilityCheckOk = {
  ok: true,
  status: 200,
  json: () => Promise.resolve({ id: "available" }),
  text: () => Promise.resolve("{}"),
} as Response;

/**
 * A PERFECT mocked finalist: it "cheats" by returning each case's own gold
 * answer, in the EXACT order `runStage` sends requests (concurrency 1: main
 * holdout — in the same order `selectCases({split:"holdout"})` returns — then
 * the 6 supplemental cases, in `loadSupplementalAmbiguityPack()`'s own sorted
 * order). This proves the orchestration end to end without any live network
 * call: every POST body is inspected here only to assert what it does and
 * does NOT contain, never to reach a real provider.
 */
function buildPerfectAnswers(): { bodies: string[]; requestSink: unknown[] } {
  const mainCases = selectCases({ split: "holdout" });
  const supplementalCases = loadSupplementalAmbiguityPack();
  const bodies: string[] = [];
  for (const c of mainCases) {
    const answer =
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
    bodies.push(JSON.stringify(answer));
  }
  for (const c of supplementalCases) {
    bodies.push(
      JSON.stringify({
        disposition: c.expected.disposition,
        signals: [...c.expected.signals],
        evidence_strength: c.expected.evidence_strength,
      }),
    );
  }
  return { bodies, requestSink: [] };
}

function makePerfectFetchMock(bodies: readonly string[], requestSink: unknown[]) {
  let invokeCalls = 0;
  const fn = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
    if (!init || init.method === "GET") return Promise.resolve(availabilityCheckOk);
    requestSink.push(init.body);
    const jsonText = bodies[invokeCalls];
    invokeCalls += 1;
    if (jsonText === undefined) {
      throw new Error(
        `TEST FAILURE: mock received more POST calls (${invokeCalls}) than expected (${bodies.length})`,
      );
    }
    return Promise.resolve(okBody("gpt-5.6-luna-2026", jsonText));
  });
  return fn;
}

function invokeCallCount(fetchMock: ReturnType<typeof vi.fn>): number {
  return fetchMock.mock.calls.filter((call) => {
    const init = call[1] as RequestInit | undefined;
    return init?.method === "POST";
  }).length;
}

describe("Stage-2 mocked end-to-end: main holdout + supplemental pack, fully mocked, ZERO real network calls", () => {
  it("final schedules exactly the 120 main-holdout cases AND exactly the 6 frozen supplemental cases, in two structurally separate artifact streams, and a perfect finalist reaches STAGE2_QUALIFIED_CANDIDATE", async () => {
    const runId = freshRunId("full-e2e");
    const { bodies, requestSink } = buildPerfectAnswers();
    expect(bodies.length).toBe(126); // 120 main + 6 supplemental — never conflated into one 126-case main selection.

    process.env.OPENAI_API_KEY = "sk-test-e2e-0123456789abcdef";
    const fetchMock = makePerfectFetchMock(bodies, requestSink);
    vi.stubGlobal("fetch", fetchMock);

    const args = parseArgs([
      "final",
      "--candidate",
      "openai-gpt-5-6-luna",
      "--run",
      runId,
      "--concurrency",
      "1",
    ]);
    await runStage("final", args);

    // -- 1/2: both sources scheduled, exactly. -------------------------
    expect(invokeCallCount(fetchMock)).toBe(126);
    const mainResults = readResults(runId);
    const supplementalResults = readSupplementalResults(runId);
    expect(mainResults.length).toBe(120);
    expect(supplementalResults.length).toBe(6);

    // -- 6: structurally separate artifact streams. ---------------------
    expect(existsSync(resultsPath(runId))).toBe(true);
    expect(existsSync(supplementalResultsPath(runId))).toBe(true);
    // Never mixed into one file, and never a 126-row results.jsonl.
    const rawMain = readFileSync(resultsPath(runId), "utf8").trim().split("\n");
    expect(rawMain.length).toBe(120);

    // -- no supplemental case id ever entered the main stream. -----------
    const packIds = new Set(loadSupplementalAmbiguityPack().map((c) => c.case_id));
    for (const r of mainResults) expect(packIds.has(r.case_id)).toBe(false);
    for (const r of supplementalResults) expect(packIds.has(r.case_id)).toBe(true);

    // -- 7: supplemental manifest records exact version/digest/case ids. -
    const supplementalManifest = readJsonArtifact<ReturnType<typeof supplementalPackManifest>>(
      runId,
      "supplemental-manifest.json",
    );
    const pack = supplementalPackManifest();
    expect(supplementalManifest?.pack_version).toBe(pack.pack_version);
    expect(supplementalManifest?.digest).toBe(pack.digest);
    expect(supplementalManifest?.case_ids).toEqual(pack.case_ids);

    // -- 5: expected/gold/rationale is NEVER sent in the supplemental request. --
    const supplementalCase = loadSupplementalAmbiguityPack()[0];
    expect(supplementalCase).toBeDefined();
    const allBodies = requestSink.map((b) => String(b));
    const joined = allBodies.join("\n");
    expect(joined).not.toContain("gold_rationale");
    expect(joined).not.toContain(supplementalCase!.gold_rationale);
    expect(joined).not.toContain("critical_invariants");
    expect(joined).not.toContain("supplemental_blind_support");
    expect(joined).not.toContain("pack_version");

    // -- 3/4: same canonical prompt v2 + same candidate/model/inference config for both sources. --
    const mainConfigDigests = new Set(mainResults.map((r) => r.inference_config_digest));
    const supplementalConfigDigests = new Set(
      supplementalResults.map((r) => r.inference_config_digest),
    );
    expect(mainConfigDigests.size).toBe(1);
    expect(supplementalConfigDigests.size).toBe(1);
    expect([...mainConfigDigests]).toEqual([...supplementalConfigDigests]);
    const mainModels = new Set(mainResults.map((r) => r.requested_model));
    const supplementalModels = new Set(supplementalResults.map((r) => r.requested_model));
    expect([...mainModels]).toEqual([...supplementalModels]);

    // -- main scoring sees no supplemental case; signal micro-F1 unaffected. --
    const scoresV2 = readJsonArtifact<{ scores: CandidateScoreV2[] }>(runId, "scores-v2.json");
    const mainScore = scoresV2?.scores.find((s) => s.candidate_id === "openai-gpt-5-6-luna");
    expect(mainScore?.message_task?.n).toBe(72); // 72 message-task cases in the 120-case holdout, never 78 (72+6).
    expect(mainScore?.message_task?.signals.strict.n).toBeGreaterThan(0);
    expect(mainScore?.reliability.cases_selected).toBe(120);
    expect(mainScore?.reliability.cases_attempted).toBe(120);

    // -- 12/13/14: supplemental scorer scored exactly 6, main scoring untouched. --
    const supplementalScoresArtifact = readJsonArtifact<{
      supplemental_pack: ReturnType<typeof supplementalPackManifest>;
      scores: SupplementalScore[];
    }>(runId, "supplemental-scores.json");
    const supplementalScore = supplementalScoresArtifact?.scores.find(
      (s) => s.candidate_id === "openai-gpt-5-6-luna",
    );
    expect(supplementalScore?.disposition_strict.n).toBe(6);
    expect(supplementalScore?.reliability.cases_selected).toBe(6);
    expect(supplementalScore?.reliability.all_six_completed).toBe(true);

    // -- 15/16/17: support-completed disposition macro F1 is actually invoked, threshold unchanged. --
    const stage2Evaluations = readJsonArtifact<Stage2Evaluation[]>(
      runId,
      "stage2-evaluations.json",
    );
    const evaluation = stage2Evaluations?.find((e) => e.candidate_id === "openai-gpt-5-6-luna");
    expect(evaluation).toBeDefined();
    const dispositionTarget = evaluation?.targets.find((t) => t.key === "disposition_macro_f1");
    expect(dispositionTarget?.label).toContain("support-completed");
    expect(dispositionTarget?.threshold).toBe(0.9);
    expect(dispositionTarget?.state).toBe("pass");
    expect(dispositionTarget?.value).toBe(1);

    // -- 18/19: signal (0.90) and thread-state (0.90) thresholds present and unchanged. --
    const signalTarget = evaluation?.targets.find((t) => t.key === "signal_micro_f1");
    expect(signalTarget?.threshold).toBe(0.9);
    expect(signalTarget?.state).toBe("pass");
    const threadTarget = evaluation?.targets.find((t) => t.key === "thread_state_accuracy");
    expect(threadTarget?.threshold).toBe(0.9);
    const compensationTarget = evaluation?.targets.find((t) => t.key === "compensation_accuracy");
    expect(compensationTarget?.threshold).toBe(0.95);

    // -- 26/27: perfect fixture -> STAGE2_QUALIFIED_CANDIDATE, never a production-winner string. --
    expect(evaluation?.status).toBe("stage2_qualified_candidate");
    expect(evaluation?.isQualified).toBe(true);
    const evaluationText = JSON.stringify(evaluation);
    for (const forbidden of ["WINNER", "SELECTED PROVIDER", "PRODUCTION MODEL"]) {
      expect(evaluationText).not.toContain(forbidden);
    }

    // -- 28/29: reliability denominators stay separate — main=120, supplemental=6. --
    expect(mainScore?.reliability.cases_selected).toBe(120);
    expect(supplementalScore?.reliability.cases_selected).toBe(6);

    // -- 30: cost/tokens separately reported. ----------------------------
    expect(mainScore?.economics.cases_priced).toBe(120);
    expect(supplementalScore?.economics.cases_priced).toBe(6);

    // -- 31: finalist provenance persisted. ------------------------------
    expect(evaluation?.finalist_provenance).not.toBeNull();

    // -- 32: mocked end-to-end makes zero real provider/network calls. --
    // (implicit: `fetch` was stubbed for the whole test; nothing here ever
    // called the real global fetch.)

    // -- report --run round-trips to the identical Stage-2 status. -------
    const reportArgs = parseArgs(["report", "--run", runId]);
    commandReport(reportArgs);
    const reReadEvaluations = readJsonArtifact<Stage2Evaluation[]>(
      runId,
      "stage2-evaluations.json",
    );
    const reReadEvaluation = reReadEvaluations?.find(
      (e) => e.candidate_id === "openai-gpt-5-6-luna",
    );
    expect(reReadEvaluation?.status).toBe("stage2_qualified_candidate");
  }, 30_000);
});

describe("PASS C attack: missing supplemental execution must NEVER qualify", () => {
  it("main holdout completes perfectly and all 126 calls succeed, but a re-score against only 5 of the 6 supplemental predictions (an interrupted supplemental phase) must report `incomplete`, never a qualified status", async () => {
    const runId = freshRunId("missing-supplemental");
    const { bodies, requestSink } = buildPerfectAnswers();

    process.env.OPENAI_API_KEY = "sk-test-main-only-0123456789";
    vi.stubGlobal("fetch", makePerfectFetchMock(bodies, requestSink));

    const args1 = parseArgs([
      "final",
      "--candidate",
      "openai-gpt-5-6-luna",
      "--run",
      runId,
      "--concurrency",
      "1",
    ]);
    await runStage("final", args1);
    expect(readResults(runId).length).toBe(120);
    const supplementalRows = readSupplementalResults(runId);
    expect(supplementalRows.length).toBe(6); // the full run actually completed all 6 — proving the blocker is fixed.

    // Now simulate the ATTACK: an interrupted supplemental phase (5 of 6
    // attempted, 1 never ran) by re-scoring with a truncated supplemental
    // result set, exactly the shape `emitReport` would see mid-interruption.
    const { scoreSupplementalPack } =
      await import("../../scripts/b07-benchmark/scoring/score-supplemental");
    const { scoreCandidateV2 } = await import("../../scripts/b07-benchmark/scoring/score-v2");
    const { evaluateStage2Final } =
      await import("../../scripts/b07-benchmark/scoring/stage2-final");
    const { priceBookFor } = await import("../../scripts/b07-benchmark/config/pricing");

    const truncatedSupplemental = supplementalRows.slice(0, 5);
    const mainCases = selectCases({ split: "holdout" });
    const mainScoreInput = {
      candidateId: "openai-gpt-5-6-luna",
      providerId: "openai",
      requestedModel: openaiCandidate!.model,
      corpusVersion: "b07_gold_corpus_v2",
      promptVersion: "b07_benchmark_prompt_v2",
      schemaVersion: "b07_benchmark_schema_v1",
      cases: mainCases,
      results: readResults(runId),
      priceBook: priceBookFor("openai-gpt-5-6-luna"),
    };
    const mainScore = scoreCandidateV2(mainScoreInput);
    const supplementalScore = scoreSupplementalPack({
      candidateId: "openai-gpt-5-6-luna",
      providerId: "openai",
      requestedModel: openaiCandidate!.model,
      results: truncatedSupplemental,
      priceBook: priceBookFor("openai-gpt-5-6-luna"),
    });
    expect(supplementalScore.reliability.all_six_completed).toBe(false);

    const evaluation = evaluateStage2Final({
      candidateId: "openai-gpt-5-6-luna",
      mainManifest: {
        split: "holdout",
        case_set_digest: "irrelevant-for-this-check",
        selected_case_count: mainCases.length,
        expected_full_holdout_count: mainCases.length,
      },
      mainScore,
      supplementalScore,
      finalistProvenance: null,
    });

    expect(evaluation.status).toBe("incomplete");
    expect(evaluation.isQualified).toBe(false);
    expect(evaluation.reasons.join(" ")).toContain("supplemental pack incomplete");
  }, 30_000);
});

describe("PASS C attack: pack drift (same pack_version, different digest) refuses report --run, not silently rendering a verdict", () => {
  it("hand-tampering a stored supplemental row's pack_digest under the SAME pack_version makes `report --run` throw SupplementalPackDriftError instead of rendering a Stage-2 status", async () => {
    const runId = freshRunId("pack-drift");
    const { bodies, requestSink } = buildPerfectAnswers();
    process.env.OPENAI_API_KEY = "sk-test-drift-0123456789";
    vi.stubGlobal("fetch", makePerfectFetchMock(bodies, requestSink));

    const args = parseArgs([
      "final",
      "--candidate",
      "openai-gpt-5-6-luna",
      "--run",
      runId,
      "--concurrency",
      "1",
    ]);
    await runStage("final", args);
    expect(readSupplementalResults(runId).length).toBe(6);

    // Tamper: rewrite the stored supplemental stream so every row keeps
    // its real `pack_version` but carries a DIFFERENT digest than the pack
    // currently on disk — simulating an unauthorised/corrupted edit to the
    // frozen fixture after results were already computed against it.
    const rawLines = readFileSync(supplementalResultsPath(runId), "utf8")
      .trim()
      .split("\n")
      .map((line) => {
        const row = JSON.parse(line) as { pack_digest: string };
        row.pack_digest = "TAMPERED-DIGEST-NOT-ON-DISK";
        return JSON.stringify(row);
      });
    writeFileSync(supplementalResultsPath(runId), `${rawLines.join("\n")}\n`, "utf8");

    const { SupplementalPackDriftError } =
      await import("../../scripts/b07-benchmark/run/supplemental-runner");
    const reportArgs = parseArgs(["report", "--run", runId]);
    expect(() => commandReport(reportArgs)).toThrow(SupplementalPackDriftError);
  }, 30_000);
});

describe("provider parity: no candidate/provider-specific semantic branch in the new orchestration files", () => {
  it("run/supplemental-runner.ts and scoring/stage2-final.ts contain no literal candidate id or provider-name branch", () => {
    const supplementalRunnerSource = readFileSync(
      new URL("../../scripts/b07-benchmark/run/supplemental-runner.ts", import.meta.url),
      "utf8",
    );
    const stage2FinalSource = readFileSync(
      new URL("../../scripts/b07-benchmark/scoring/stage2-final.ts", import.meta.url),
      "utf8",
    );
    for (const forbidden of [
      "anthropic-sonnet-5",
      "anthropic-haiku",
      "openai-gpt",
      "google-gemini",
      "anthropic-opus",
      'providerId === "openai"',
      'providerId === "anthropic"',
      'providerId === "google"',
    ]) {
      expect(supplementalRunnerSource).not.toContain(forbidden);
      expect(stage2FinalSource).not.toContain(forbidden);
    }
  });
});
