/**
 * B07 benchmark — Stage-2 FINAL DECISION unit tests (`scoring/stage2-final.ts`).
 *
 * These exercise `evaluateStage2Final` directly over synthetic
 * `CandidateScoreV2`/`SupplementalScore` fixtures (built the ordinary way,
 * via the real scorers over the real holdout corpus and the real frozen
 * supplemental pack) rather than through the full CLI, so every attack case
 * below runs in milliseconds with zero mocked network at all — this module
 * never calls a provider, so there is nothing to mock.
 *
 * Numbers below map to the round's acceptance-test list (1-33).
 */
import { describe, expect, it } from "vitest";

import { selectCases } from "../../scripts/b07-benchmark/corpus/load";
import {
  loadSupplementalAmbiguityPack,
  supplementalPackManifest,
} from "../../scripts/b07-benchmark/corpus/supplemental-ambiguity-pack";
import type { EffectiveInferenceConfig } from "../../scripts/b07-benchmark/config/inference-config";
import type { CaseResult, SupplementalCaseResult } from "../../scripts/b07-benchmark/run/types";
import { scoreCandidateV2 } from "../../scripts/b07-benchmark/scoring/score-v2";
import {
  scoreSupplementalPack,
  type SupplementalScore,
} from "../../scripts/b07-benchmark/scoring/score-supplemental";
import {
  evaluateStage2Final,
  renderStage2Status,
  STAGE2_STATUSES,
} from "../../scripts/b07-benchmark/scoring/stage2-final";

const TEST_INFERENCE_CONFIG: EffectiveInferenceConfig = {
  policy_version: "test-policy-v1",
  provider_id: "openai" as const,
  model_capability_profile: "openai_provider_default_v1",
  thinking_mode: "disabled" as const,
  effort: null,
  budget_tokens: null,
  reasoning_effort: "medium" as const,
  temperature: "provider_default" as const,
  max_output_tokens: 512,
  structured_output_transport_version: "test-transport-v1",
};

const OTHER_INFERENCE_CONFIG = { ...TEST_INFERENCE_CONFIG, reasoning_effort: "high" as const };

function mainResultFor(
  c: ReturnType<typeof selectCases>[number],
  overrides: {
    disposition?: string;
    signals?: string[];
    thread_state?: string;
    compensation_structure?: string;
  } = {},
  inferenceConfig = TEST_INFERENCE_CONFIG,
  model = "m",
): CaseResult {
  const base =
    c.task === "message"
      ? {
          disposition: overrides.disposition ?? c.expected.disposition,
          signals: overrides.signals ?? [...c.expected.signals],
          evidence_strength: c.expected.evidence_strength,
        }
      : {
          thread_state: overrides.thread_state ?? c.expected.thread_state,
          compensation_structure:
            overrides.compensation_structure ?? c.expected.compensation_structure,
          evidence_strength: c.expected.evidence_strength,
        };
  return {
    run_id: "r",
    candidate_id: "x",
    provider_id: "openai",
    requested_model: model,
    inference_config: inferenceConfig,
    inference_config_digest:
      inferenceConfig === TEST_INFERENCE_CONFIG ? "test-config-digest" : "other-config-digest",
    endpoint: "https://example.invalid",
    case_id: c.case_id,
    task: c.task,
    split: c.split,
    corpus_version: "v",
    prompt_version: "p",
    schema_version: "s",
    status: "ok",
    attempts: [
      {
        index: 1,
        kind: "initial",
        outcome: "schema_valid",
        http_status: 200,
        error_summary: null,
        latency_ms: 10,
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          reasoning_tokens: 0,
          cached_input_tokens: 0,
        },
        returned_model: "m-2026",
      },
    ],
    first_pass_schema_valid: true,
    retry_used: false,
    final_schema_valid: true,
    prediction: base as CaseResult["prediction"],
    total_latency_ms: 10,
    usage_totals: {
      input_tokens: 100,
      output_tokens: 20,
      reasoning_tokens: 0,
      cached_input_tokens: 0,
    },
    evaluated_at: "2026-09-13T00:00:00.000Z",
  };
}

function supplementalResultFor(
  c: ReturnType<typeof loadSupplementalAmbiguityPack>[number],
  disposition: string,
  packVersion: string,
  packDigest: string,
  inferenceConfig = TEST_INFERENCE_CONFIG,
  model = "m",
): SupplementalCaseResult {
  return {
    run_id: "r",
    candidate_id: "x",
    provider_id: "openai",
    requested_model: model,
    inference_config: inferenceConfig,
    inference_config_digest:
      inferenceConfig === TEST_INFERENCE_CONFIG ? "test-config-digest" : "other-config-digest",
    endpoint: "https://example.invalid",
    case_id: c.case_id,
    task: "message",
    pack_version: packVersion,
    pack_digest: packDigest,
    prompt_version: "p",
    schema_version: "s",
    status: "ok",
    attempts: [
      {
        index: 1,
        kind: "initial",
        outcome: "schema_valid",
        http_status: 200,
        error_summary: null,
        latency_ms: 10,
        usage: { input_tokens: 50, output_tokens: 10, reasoning_tokens: 0, cached_input_tokens: 0 },
        returned_model: "m-2026",
      },
    ],
    first_pass_schema_valid: true,
    retry_used: false,
    final_schema_valid: true,
    prediction: {
      disposition,
      signals: [...c.expected.signals],
      evidence_strength: c.expected.evidence_strength,
    } as SupplementalCaseResult["prediction"],
    total_latency_ms: 10,
    usage_totals: {
      input_tokens: 50,
      output_tokens: 10,
      reasoning_tokens: 0,
      cached_input_tokens: 0,
    },
    evaluated_at: "2026-09-13T00:00:00.000Z",
  };
}

function buildPerfectMainScore(
  overrides: Partial<{
    threadStatePredictions: Map<string, string>;
    compensationPredictions: Map<string, string>;
    signalOverride: () => string[] | undefined;
  }> = {},
) {
  const cases = selectCases({ split: "holdout" });
  const results = cases.map((c) => {
    if (c.task === "thread") {
      const threadOverride = overrides.threadStatePredictions?.get(c.case_id);
      const compOverride = overrides.compensationPredictions?.get(c.case_id);
      return mainResultFor(c, {
        thread_state: threadOverride,
        compensation_structure: compOverride,
      });
    }
    const signalOverride = overrides.signalOverride?.();
    return mainResultFor(c, signalOverride ? { signals: signalOverride } : {});
  });
  return scoreCandidateV2({
    candidateId: "x",
    providerId: "openai",
    requestedModel: "m",
    corpusVersion: "v",
    promptVersion: "p",
    schemaVersion: "s",
    cases,
    results,
    priceBook: null,
  });
}

function buildPerfectSupplementalScore() {
  const pack = loadSupplementalAmbiguityPack();
  const manifest = supplementalPackManifest();
  const results = pack.map((c) =>
    supplementalResultFor(c, c.expected.disposition, manifest.pack_version, manifest.digest),
  );
  return scoreSupplementalPack({
    candidateId: "x",
    providerId: "openai",
    requestedModel: "m",
    results,
    priceBook: null,
  });
}

const baseMainManifest = () => ({
  split: "holdout" as const,
  case_set_digest: "digest-x",
  selected_case_count: selectCases({ split: "holdout" }).length,
  expected_full_holdout_count: selectCases({ split: "holdout" }).length,
});

describe("26/27. a perfect fixture qualifies, and the status is never a production-winner string", () => {
  it("perfect main + perfect supplemental -> STAGE2_QUALIFIED_CANDIDATE", () => {
    const mainScore = buildPerfectMainScore();
    const supplementalScore = buildPerfectSupplementalScore();
    const evaluation = evaluateStage2Final({
      candidateId: "x",
      mainManifest: baseMainManifest(),
      mainScore,
      supplementalScore,
      finalistProvenance: {
        screen_run_id: "screen-1",
        finalist_reason: "closes disposition support",
        candidate_roles: { x: "screening" },
      },
    });
    expect(evaluation.status).toBe("stage2_qualified_candidate");
    expect(evaluation.isQualified).toBe(true);
    expect(renderStage2Status(evaluation)).toBe("STAGE2_QUALIFIED_CANDIDATE");
  });

  it("renderStage2Status never renders WINNER / SELECTED PROVIDER / PRODUCTION MODEL for ANY status", () => {
    for (const status of STAGE2_STATUSES) {
      const rendered = renderStage2Status({
        candidate_id: "x",
        status,
        isQualified: status === "stage2_qualified_candidate",
        reasons: [],
        identity: {
          main: {
            corpus_version: "v",
            prompt_version: "p",
            schema_version: "s",
            main_case_set_digest: "d",
            main_case_count: 120,
          },
          supplemental: { pack_version: "pv", pack_digest: "pd", case_ids: [] },
          inference: {
            candidate_id: "x",
            provider_id: "openai",
            requested_model: "m",
            returned_models: [],
            inference_config_digest: null,
          },
          scoring_version: "v2",
        },
        targets: [],
        finalist_provenance: null,
        main_holdout_only_disposition_macro_f1: null,
      });
      for (const forbidden of ["WINNER", "SELECTED PROVIDER", "PRODUCTION MODEL"]) {
        expect(rendered).not.toContain(forbidden);
      }
    }
  });

  it("21. main-holdout-only disposition macro F1 is reported separately but NEVER decides Stage 2 — it stays `insufficient_support` even while qualified", () => {
    const mainScore = buildPerfectMainScore();
    const supplementalScore = buildPerfectSupplementalScore();
    const evaluation = evaluateStage2Final({
      candidateId: "x",
      mainManifest: baseMainManifest(),
      mainScore,
      supplementalScore,
      finalistProvenance: null,
    });
    expect(evaluation.status).toBe("stage2_qualified_candidate");
    // The main-only figure is unresolvable on its own (0 strict `ambiguous`
    // support in the 120-case holdout) — yet this NEVER blocks qualification.
    expect(evaluation.main_holdout_only_disposition_macro_f1?.state).toBe("insufficient_support");
    const supportCompleted = evaluation.targets.find((t) => t.key === "disposition_macro_f1");
    expect(supportCompleted?.state).toBe("pass");
  });
});

describe("PASS C attack: identity invalid", () => {
  it("main and supplemental requested_model mismatch -> blocked_identity_invalid, never a verdict", () => {
    const mainScore = buildPerfectMainScore();
    const cases = selectCases({ split: "holdout" });
    const drivenMainScore = scoreCandidateV2({
      candidateId: "x",
      providerId: "openai",
      requestedModel: "model-A",
      corpusVersion: "v",
      promptVersion: "p",
      schemaVersion: "s",
      cases,
      results: cases.map((c) => mainResultFor(c, {}, TEST_INFERENCE_CONFIG, "model-A")),
      priceBook: null,
    });
    const pack = loadSupplementalAmbiguityPack();
    const manifest = supplementalPackManifest();
    const supplementalScore = scoreSupplementalPack({
      candidateId: "x",
      providerId: "openai",
      requestedModel: "model-B",
      results: pack.map((c) =>
        supplementalResultFor(
          c,
          c.expected.disposition,
          manifest.pack_version,
          manifest.digest,
          TEST_INFERENCE_CONFIG,
          "model-B",
        ),
      ),
      priceBook: null,
    });
    expect(mainScore).toBeDefined();
    const evaluation = evaluateStage2Final({
      candidateId: "x",
      mainManifest: baseMainManifest(),
      mainScore: drivenMainScore,
      supplementalScore,
      finalistProvenance: null,
    });
    expect(evaluation.status).toBe("blocked_identity_invalid");
    expect(evaluation.isQualified).toBe(false);
    expect(evaluation.reasons.join(" ")).toContain("requested_model");
  });

  it("main and supplemental inference_config_digest mismatch -> blocked_identity_invalid", () => {
    const cases = selectCases({ split: "holdout" });
    const mainScore = scoreCandidateV2({
      candidateId: "x",
      providerId: "openai",
      requestedModel: "m",
      corpusVersion: "v",
      promptVersion: "p",
      schemaVersion: "s",
      cases,
      results: cases.map((c) => mainResultFor(c, {}, TEST_INFERENCE_CONFIG, "m")),
      priceBook: null,
    });
    const pack = loadSupplementalAmbiguityPack();
    const manifest = supplementalPackManifest();
    const supplementalScore = scoreSupplementalPack({
      candidateId: "x",
      providerId: "openai",
      requestedModel: "m",
      results: pack.map((c) =>
        supplementalResultFor(
          c,
          c.expected.disposition,
          manifest.pack_version,
          manifest.digest,
          OTHER_INFERENCE_CONFIG,
          "m",
        ),
      ),
      priceBook: null,
    });
    const evaluation = evaluateStage2Final({
      candidateId: "x",
      mainManifest: baseMainManifest(),
      mainScore,
      supplementalScore,
      finalistProvenance: null,
    });
    expect(evaluation.status).toBe("blocked_identity_invalid");
    expect(evaluation.reasons.join(" ")).toContain("inference_config_digest");
  });

  it("8. pack digest drift (SAME pack_version, DIFFERENT digest than the pack on disk) -> blocked_identity_invalid via the supplemental scorer's own invalidated_reason", () => {
    const mainScore = buildPerfectMainScore();
    const pack = loadSupplementalAmbiguityPack();
    const manifest = supplementalPackManifest();
    const driftedResults = pack.map((c) =>
      supplementalResultFor(
        c,
        c.expected.disposition,
        manifest.pack_version,
        "DEFINITELY-NOT-THE-REAL-DIGEST",
      ),
    );
    const supplementalScore = scoreSupplementalPack({
      candidateId: "x",
      providerId: "openai",
      requestedModel: "m",
      results: driftedResults,
      priceBook: null,
    });
    expect(supplementalScore.invalidated_reason).toMatch(/PACK_DRIFT/);
    const evaluation = evaluateStage2Final({
      candidateId: "x",
      mainManifest: baseMainManifest(),
      mainScore,
      supplementalScore,
      finalistProvenance: null,
    });
    expect(evaluation.status).toBe("blocked_identity_invalid");
    expect(evaluation.reasons.join(" ")).toMatch(/PACK_DRIFT/);
  });
});

describe("PASS C attack: partial execution in either direction -> incomplete, never qualified", () => {
  it("9. main-only complete (supplemental produced zero rows) cannot produce a Stage-2 qualified status", () => {
    const mainScore = buildPerfectMainScore();
    const supplementalScore = scoreSupplementalPack({
      candidateId: "x",
      providerId: "openai",
      requestedModel: "m",
      results: [],
      priceBook: null,
    });
    const evaluation = evaluateStage2Final({
      candidateId: "x",
      mainManifest: baseMainManifest(),
      mainScore,
      supplementalScore,
      finalistProvenance: null,
    });
    expect(evaluation.status).toBe("incomplete");
    expect(evaluation.isQualified).toBe(false);
  });

  it("10. supplemental-only complete (main produced zero attempted rows) cannot produce a Stage-2 qualified status", () => {
    const cases = selectCases({ split: "holdout" });
    const emptyMainScore = scoreCandidateV2({
      candidateId: "x",
      providerId: "openai",
      requestedModel: "m",
      corpusVersion: "v",
      promptVersion: "p",
      schemaVersion: "s",
      cases,
      results: [], // nothing attempted at all
      priceBook: null,
    });
    const supplementalScore = buildPerfectSupplementalScore();
    const evaluation = evaluateStage2Final({
      candidateId: "x",
      mainManifest: baseMainManifest(),
      mainScore: emptyMainScore,
      supplementalScore,
      finalistProvenance: null,
    });
    expect(evaluation.status).toBe("incomplete");
    expect(evaluation.isQualified).toBe(false);
  });
});

describe("PASS C / acceptance 20/22/23/24/25: individual failing targets each eliminate qualification", () => {
  it("20. main-holdout critical invariant violations eliminate qualification regardless of everything else", () => {
    const cases = selectCases({ split: "holdout" });
    // Predict `positive` for every message case — guaranteed to trip
    // `politeness_not_positive` on at least one critical-tagged case, and to
    // break signal/disposition accuracy too, but the critical gate alone is
    // enough to eliminate.
    const results = cases.map((c) =>
      c.task === "message" ? mainResultFor(c, { disposition: "positive" }) : mainResultFor(c, {}),
    );
    const mainScore = scoreCandidateV2({
      candidateId: "x",
      providerId: "openai",
      requestedModel: "m",
      corpusVersion: "v",
      promptVersion: "p",
      schemaVersion: "s",
      cases,
      results,
      priceBook: null,
    });
    expect(mainScore.critical_suite.violations).toBeGreaterThan(0);
    const evaluation = evaluateStage2Final({
      candidateId: "x",
      mainManifest: baseMainManifest(),
      mainScore,
      supplementalScore: buildPerfectSupplementalScore(),
      finalistProvenance: null,
    });
    expect(evaluation.status).toBe("eliminated_critical_safety");
    expect(evaluation.isQualified).toBe(false);
  });

  it("22. a failing support-completed disposition macro-F1 (supplemental predictions all wrong) eliminates qualification", () => {
    const mainScore = buildPerfectMainScore();
    const pack = loadSupplementalAmbiguityPack();
    const manifest = supplementalPackManifest();
    // Every supplemental case predicted as something OTHER than `ambiguous`.
    const badResults = pack.map((c) =>
      supplementalResultFor(c, "neutral", manifest.pack_version, manifest.digest),
    );
    const supplementalScore = scoreSupplementalPack({
      candidateId: "x",
      providerId: "openai",
      requestedModel: "m",
      results: badResults,
      priceBook: null,
    });
    const evaluation = evaluateStage2Final({
      candidateId: "x",
      mainManifest: baseMainManifest(),
      mainScore,
      supplementalScore,
      finalistProvenance: null,
    });
    const target = evaluation.targets.find((t) => t.key === "disposition_macro_f1");
    expect(target?.state).toBe("fail");
    expect(evaluation.status).toBe("eliminated_quality_target_fail");
    expect(evaluation.isQualified).toBe(false);
  });

  it("23. failing main-holdout strict signal micro F1 eliminates qualification", () => {
    // Always predict an empty signal set — drives recall (and micro F1)
    // toward 0 on any case with non-empty gold signals, without touching
    // disposition/critical safety.
    const mainScore = buildPerfectMainScore({ signalOverride: () => [] });
    const target = evaluateStage2Final({
      candidateId: "x",
      mainManifest: baseMainManifest(),
      mainScore,
      supplementalScore: buildPerfectSupplementalScore(),
      finalistProvenance: null,
    });
    const signalTarget = target.targets.find((t) => t.key === "signal_micro_f1");
    expect(signalTarget?.state).toBe("fail");
    expect(target.status).toBe("eliminated_quality_target_fail");
    expect(target.isQualified).toBe(false);
  });

  it("24. failing main-holdout thread-state accuracy eliminates qualification", () => {
    const cases = selectCases({ split: "holdout" }).filter((c) => c.task === "thread");
    const wrongThreadState = new Map(cases.map((c) => [c.case_id, "ambiguous"]));
    const mainScore = buildPerfectMainScore({ threadStatePredictions: wrongThreadState });
    const evaluation = evaluateStage2Final({
      candidateId: "x",
      mainManifest: baseMainManifest(),
      mainScore,
      supplementalScore: buildPerfectSupplementalScore(),
      finalistProvenance: null,
    });
    const threadTarget = evaluation.targets.find((t) => t.key === "thread_state_accuracy");
    expect(threadTarget?.state).toBe("fail");
    expect(evaluation.status).toBe("eliminated_quality_target_fail");
    expect(evaluation.isQualified).toBe(false);
  });

  it("24b. failing main-holdout compensation accuracy eliminates qualification (predicting `unknown` for every KNOWN-compensation case degrades accuracy WITHOUT tripping any critical invariant, isolating this target)", () => {
    // `unknown` is never itself a forbidden collapse in either direction, so
    // this predicts a materially wrong compensation structure for every case
    // whose gold is NOT already `unknown`, without accidentally tripping
    // `unsupported_compensation_unknown` (fires when predicted != "unknown"
    // on a case tagged for it) or `unknown_not_unpaid` (fires only on a
    // predicted `unpaid`) — isolating compensation ACCURACY from critical
    // safety so this test proves target 24 specifically, not target 20.
    const cases = selectCases({ split: "holdout" }).filter((c) => c.task === "thread");
    const wrongComp = new Map(cases.map((c) => [c.case_id, "unknown"]));
    const mainScore = buildPerfectMainScore({ compensationPredictions: wrongComp });
    expect(mainScore.critical_suite.violations).toBe(0);
    const evaluation = evaluateStage2Final({
      candidateId: "x",
      mainManifest: baseMainManifest(),
      mainScore,
      supplementalScore: buildPerfectSupplementalScore(),
      finalistProvenance: null,
    });
    const compensationTarget = evaluation.targets.find((t) => t.key === "compensation_accuracy");
    expect(compensationTarget?.state).toBe("fail");
    expect(evaluation.status).toBe("eliminated_quality_target_fail");
    expect(evaluation.isQualified).toBe(false);
  });

  it("25. an unknown->unpaid compensation collapse eliminates qualification (whichever elimination reason fires first — critical safety or the explicit target — it is NEVER qualified)", () => {
    const cases = selectCases({ split: "holdout" }).filter((c) => c.task === "thread");
    const wrongComp = new Map(
      cases
        .filter((c) => c.task === "thread" && c.expected.compensation_structure === "unknown")
        .map((c) => [c.case_id, "unpaid"]),
    );
    expect(wrongComp.size).toBeGreaterThan(0);
    const mainScore = buildPerfectMainScore({ compensationPredictions: wrongComp });
    expect(mainScore.thread_task?.unknown_predicted_as_unpaid ?? 0).toBe(wrongComp.size);
    const evaluation = evaluateStage2Final({
      candidateId: "x",
      mainManifest: baseMainManifest(),
      mainScore,
      supplementalScore: buildPerfectSupplementalScore(),
      finalistProvenance: null,
    });
    // D072 §8 forbids this collapse unconditionally — whether the harness
    // catches it via the critical-invariant hard gate or via the explicit
    // `unknown_not_unpaid` quality target, qualification must never happen.
    expect(["eliminated_critical_safety", "eliminated_quality_target_fail"]).toContain(
      evaluation.status,
    );
    expect(evaluation.isQualified).toBe(false);
  });
});

describe("28/29/30. denominators and cost/tokens stay separate", () => {
  it("main reliability denominator is exactly the main holdout size; supplemental is exactly 6", () => {
    const mainScore = buildPerfectMainScore();
    const supplementalScore = buildPerfectSupplementalScore();
    expect(mainScore.reliability.cases_selected).toBe(selectCases({ split: "holdout" }).length);
    expect(supplementalScore.reliability.cases_selected).toBe(6);
    expect(mainScore.reliability.cases_selected).not.toBe(126);
  });

  it("main and supplemental economics are computed independently (no shared totals) — token totals scale with each source's own case count, never combined", () => {
    const mainScore = buildPerfectMainScore();
    const supplementalScore = buildPerfectSupplementalScore();
    const mainCaseCount = selectCases({ split: "holdout" }).length;
    // Each mocked attempt in these fixtures uses a fixed per-case token cost
    // (100 input / 20 output for main, 50 input / 10 output for supplemental)
    // — so the totals scale EXACTLY with each source's own case count, and
    // neither total ever reflects the other source's cases (never 126).
    expect(mainScore.economics.total_input_tokens).toBe(mainCaseCount * 100);
    expect(mainScore.economics.total_output_tokens).toBe(mainCaseCount * 20);
    expect(supplementalScore.economics.total_input_tokens).toBe(6 * 50);
    expect(supplementalScore.economics.total_output_tokens).toBe(6 * 10);
    expect(mainScore.economics.total_input_tokens).not.toBe(
      mainScore.economics.total_input_tokens + supplementalScore.economics.total_input_tokens,
    );
  });
});

// ---------------------------------------------------------------------------
// BLOCKER 3 — "six attempts != six valid supplemental predictions". A schema
// failure, timeout, or provider error on even ONE of the 6 frozen
// supplemental cases must produce `incomplete`, never a qualified verdict —
// regardless of how well the other 5 predictions (or the main holdout) did.
// ---------------------------------------------------------------------------

/** A supplemental row whose status is NOT `ok` — no valid semantic prediction. */
function brokenSupplementalResultFor(
  c: ReturnType<typeof loadSupplementalAmbiguityPack>[number],
  status: "schema_failed" | "timeout" | "provider_error",
  packVersion: string,
  packDigest: string,
): SupplementalCaseResult {
  return {
    run_id: "r",
    candidate_id: "x",
    provider_id: "openai",
    requested_model: "m",
    inference_config: TEST_INFERENCE_CONFIG,
    inference_config_digest: "test-config-digest",
    endpoint: "https://example.invalid",
    case_id: c.case_id,
    task: "message",
    pack_version: packVersion,
    pack_digest: packDigest,
    prompt_version: "p",
    schema_version: "s",
    status,
    attempts: [
      {
        index: 1,
        kind: "initial",
        outcome:
          status === "schema_failed"
            ? "schema_invalid"
            : status === "timeout"
              ? "timeout"
              : "provider_error",
        http_status: status === "provider_error" ? 500 : null,
        error_summary: `${status} on this attempt`,
        latency_ms: 10,
        usage: { input_tokens: 50, output_tokens: 10, reasoning_tokens: 0, cached_input_tokens: 0 },
        returned_model: status === "schema_failed" ? "m-2026" : null,
      },
    ],
    first_pass_schema_valid: false,
    retry_used: false,
    final_schema_valid: false,
    prediction: null,
    total_latency_ms: 10,
    usage_totals: {
      input_tokens: 50,
      output_tokens: 10,
      reasoning_tokens: 0,
      cached_input_tokens: 0,
    },
    evaluated_at: "2026-09-13T00:00:00.000Z",
  };
}

function buildFiveValidOneBrokenSupplementalScore(
  brokenStatus: "schema_failed" | "timeout" | "provider_error",
) {
  const pack = loadSupplementalAmbiguityPack();
  const manifest = supplementalPackManifest();
  const results = pack.map((c, i) =>
    i === 0
      ? brokenSupplementalResultFor(c, brokenStatus, manifest.pack_version, manifest.digest)
      : supplementalResultFor(c, c.expected.disposition, manifest.pack_version, manifest.digest),
  );
  return scoreSupplementalPack({
    candidateId: "x",
    providerId: "openai",
    requestedModel: "m",
    results,
    priceBook: null,
  });
}

describe("PASS C attack: BLOCKER 3 — 5 valid + 1 broken supplemental case is ALWAYS incomplete, never qualified, regardless of how well the other 5 would score", () => {
  it.each([
    ["schema_failed", "15"],
    ["timeout", "16"],
    ["provider_error", "17"],
  ] as const)(
    "%s (acceptance %s): 5 valid `ambiguous` predictions + 1 %s -> incomplete, even though the 5 correct predictions would otherwise leave combined macro-F1 >= 0.90",
    (brokenStatus: "schema_failed" | "timeout" | "provider_error", _acceptance: string) => {
      const mainScore = buildPerfectMainScore();
      const supplementalScore = buildFiveValidOneBrokenSupplementalScore(brokenStatus);

      // Sanity: the 5 valid predictions are genuinely all correct, and the
      // scorer does NOT drop the broken row from `disposition_strict` — it is
      // scored as an explicit miss (never silently excluded) — so this test
      // is not accidentally passing because macro-F1 already failed on its
      // own arithmetic; the completeness gate is a SEPARATE, independent
      // check from the metric.
      expect(supplementalScore.disposition_strict.n).toBe(6);
      expect(supplementalScore.reliability.cases_ok).toBe(5);
      expect(supplementalScore.reliability.all_six_attempted).toBe(true);
      expect(supplementalScore.reliability.all_six_valid_predictions).toBe(false);

      const evaluation = evaluateStage2Final({
        candidateId: "x",
        mainManifest: baseMainManifest(),
        mainScore,
        supplementalScore,
        finalistProvenance: null,
      });
      expect(evaluation.status).toBe("incomplete");
      expect(evaluation.isQualified).toBe(false);
      expect(evaluation.reasons.join(" ")).toContain("supplemental pack incomplete");
    },
  );

  it("18: only 6/6 schema-valid, status=ok, non-null predictions count as complete supplemental evidence", () => {
    const supplementalScore = buildPerfectSupplementalScore();
    expect(supplementalScore.reliability.cases_ok).toBe(6);
    expect(supplementalScore.reliability.cases_final_schema_valid).toBe(6);
    expect(supplementalScore.reliability.all_six_attempted).toBe(true);
    expect(supplementalScore.reliability.all_six_valid_predictions).toBe(true);

    const evaluation = evaluateStage2Final({
      candidateId: "x",
      mainManifest: baseMainManifest(),
      mainScore: buildPerfectMainScore(),
      supplementalScore,
      finalistProvenance: null,
    });
    expect(evaluation.status).toBe("stage2_qualified_candidate");
  });
});

// ---------------------------------------------------------------------------
// BLOCKER 4 — returned-model identity, WITHIN the supplemental pack and
// CROSS-SOURCE between main and supplemental.
// ---------------------------------------------------------------------------

describe("PASS C attack: BLOCKER 4 — returned-model drift", () => {
  it("19: supplemental returned-model drift (A/A/A/B/A/A across the 6 frozen cases) invalidates the supplemental source", () => {
    const pack = loadSupplementalAmbiguityPack();
    const manifest = supplementalPackManifest();
    const results = pack.map((c, i) =>
      supplementalResultFor(
        c,
        c.expected.disposition,
        manifest.pack_version,
        manifest.digest,
        TEST_INFERENCE_CONFIG,
        "m",
      ),
    );
    // Case index 3 (the 4th of 6) reports a DIFFERENT returned_model.
    const driftedResults = results.map((r, i) =>
      i === 3 ? { ...r, attempts: [{ ...r.attempts[0]!, returned_model: "m-2027-DIFFERENT" }] } : r,
    );
    const supplementalScore = scoreSupplementalPack({
      candidateId: "x",
      providerId: "openai",
      requestedModel: "m",
      results: driftedResults,
      priceBook: null,
    });
    expect(supplementalScore.reliability.returned_models.length).toBe(2);
    expect(supplementalScore.invalidated_reason).toMatch(/distinct model versions/);

    const evaluation = evaluateStage2Final({
      candidateId: "x",
      mainManifest: baseMainManifest(),
      mainScore: buildPerfectMainScore(),
      supplementalScore,
      finalistProvenance: null,
    });
    expect(evaluation.status).toBe("blocked_identity_invalid");
    expect(evaluation.reasons.join(" ")).toContain("supplemental evidence invalidated");
  });

  it("20: main returned model A, supplemental returned model B (both internally clean) -> blocked_identity_invalid, even though requested_model is identical", () => {
    const mainScore = buildPerfectMainScore(); // every main attempt reports returned_model "m-2026"
    const pack = loadSupplementalAmbiguityPack();
    const manifest = supplementalPackManifest();
    const supplementalScore = scoreSupplementalPack({
      candidateId: "x",
      providerId: "openai",
      requestedModel: "m",
      results: pack.map((c) =>
        supplementalResultFor(c, c.expected.disposition, manifest.pack_version, manifest.digest),
      ),
      priceBook: null,
    });
    // Force the supplemental source to a single, DIFFERENT returned model
    // than main's own "m-2026" (each remains internally clean: length 1).
    const crossDriftedResult: SupplementalScore = {
      ...supplementalScore,
      reliability: { ...supplementalScore.reliability, returned_models: ["m-2026-CROSS-SOURCE-B"] },
    };
    expect(mainScore.reliability.returned_models).toEqual(["m-2026"]);

    const evaluation = evaluateStage2Final({
      candidateId: "x",
      mainManifest: baseMainManifest(),
      mainScore,
      supplementalScore: crossDriftedResult,
      finalistProvenance: null,
    });
    expect(evaluation.status).toBe("blocked_identity_invalid");
    expect(evaluation.reasons.join(" ")).toContain("returned_model");
    expect(evaluation.reasons.join(" ")).not.toContain("supplemental evidence invalidated");
  });

  it("21: main and supplemental resolve to the SAME single returned model -> identity check passes (never blocks on this ground)", () => {
    const mainScore = buildPerfectMainScore(); // "m-2026" on every attempt
    const supplementalScore = buildPerfectSupplementalScore(); // also "m-2026" on every attempt
    expect(mainScore.reliability.returned_models).toEqual(["m-2026"]);
    expect(supplementalScore.reliability.returned_models).toEqual(["m-2026"]);

    const evaluation = evaluateStage2Final({
      candidateId: "x",
      mainManifest: baseMainManifest(),
      mainScore,
      supplementalScore,
      finalistProvenance: null,
    });
    // A perfect fixture with matching returned models qualifies outright —
    // proving the identity check never fires a false positive here.
    expect(evaluation.status).toBe("stage2_qualified_candidate");
  });

  it("22: resume cannot combine different returned models — a supplemental score built from mixed-version rows (simulating a resume that returned a new provider version partway through) is invalidated, never silently unioned into a qualification", () => {
    const pack = loadSupplementalAmbiguityPack();
    const manifest = supplementalPackManifest();
    // Simulates: the first 3 cases were run (and stored) under returned
    // version A, then a LATER `--resume` invocation ran the remaining 3 under
    // a provider-side version bump to B — exactly the resume/drift attack.
    const results = pack.map((c, i) => {
      const row = supplementalResultFor(
        c,
        c.expected.disposition,
        manifest.pack_version,
        manifest.digest,
      );
      const returnedModel = i < 3 ? "m-2026-A" : "m-2026-B";
      return { ...row, attempts: [{ ...row.attempts[0]!, returned_model: returnedModel }] };
    });
    const supplementalScore = scoreSupplementalPack({
      candidateId: "x",
      providerId: "openai",
      requestedModel: "m",
      results,
      priceBook: null,
    });
    expect(supplementalScore.reliability.returned_models.sort()).toEqual(["m-2026-A", "m-2026-B"]);
    expect(supplementalScore.invalidated_reason).toMatch(/distinct model versions/);

    const evaluation = evaluateStage2Final({
      candidateId: "x",
      mainManifest: baseMainManifest(),
      mainScore: buildPerfectMainScore(),
      supplementalScore,
      finalistProvenance: null,
    });
    expect(evaluation.status).not.toBe("stage2_qualified_candidate");
    expect(evaluation.status).toBe("blocked_identity_invalid");
  });
});
