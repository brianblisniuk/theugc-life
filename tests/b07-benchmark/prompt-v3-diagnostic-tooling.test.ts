/**
 * B07 benchmark — PR #40 prompt-v3 experiment: the diagnostic tooling
 * (comparator, generalization scorer, interpretation helper), tested against
 * small SYNTHETIC fixtures constructed in this file — never against real
 * Sonnet output, since none exists yet (Phase 1 makes zero provider calls).
 *
 * Also covers CLI wiring for `promptv3-diagnostic` (parseArgs, and a
 * dry-run/no-key invocation that makes zero provider calls).
 */
import { existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { parseArgs, runStage } from "../../scripts/b07-benchmark/cli";
import type { MessageCase } from "../../scripts/b07-benchmark/corpus/schema";
import { CORPUS_VERSION } from "../../scripts/b07-benchmark/corpus/schema";
import {
  loadSupplementalAmbiguityPack,
  supplementalPackManifest,
} from "../../scripts/b07-benchmark/corpus/supplemental-ambiguity-pack";
import {
  generalizationPackManifest,
  loadPromptV3GeneralizationChallenge,
} from "../../scripts/b07-benchmark/corpus/prompt-v3-generalization-challenge";
import { PROMPT_VERSION } from "../../scripts/b07-benchmark/prompt/render";
import { PROMPT_VERSION_V3 } from "../../scripts/b07-benchmark/prompt/render-v3";
import { B07_BENCHMARK_SCHEMA_VERSION } from "../../scripts/b07-benchmark/schema";
import type { CaseResult, SupplementalCaseResult } from "../../scripts/b07-benchmark/run/types";
import { runDir } from "../../scripts/b07-benchmark/run/artifacts";
import {
  comparePromptV2AndV3OnHoldout,
  PROMPT_V3_DIAGNOSTIC_LABEL,
} from "../../scripts/b07-benchmark/scoring/promptv3-comparator";
import { scorePromptV3Generalization } from "../../scripts/b07-benchmark/scoring/promptv3-generalization-score";
import {
  resolvePromptV3Interpretation,
  summarizeGeneralizationForInterpretation,
  type GeneralizationSideSummary,
  type HoldoutSideSummary,
} from "../../scripts/b07-benchmark/scoring/promptv3-interpretation";

const cleanupDirs: string[] = [];
function freshRunId(label: string): string {
  const id = `test-promptv3-${label}-${randomUUID().slice(0, 8)}`;
  cleanupDirs.push(runDir(id));
  return id;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.ANTHROPIC_API_KEY;
  for (const dir of cleanupDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Synthetic holdout cases + rows for the comparator.
// ---------------------------------------------------------------------------

function syntheticMessageCase(
  caseId: string,
  invariantId: string,
  expectedOverrides: Partial<MessageCase["expected"]> = {},
): MessageCase {
  return {
    case_id: caseId,
    task: "message",
    split: "holdout",
    language: "en",
    subject: "Synthetic test case",
    messages: [
      { from: "creator", text: "Synthetic creator message." },
      { from: "target", text: "Synthetic target reply." },
    ],
    focus_index: 1,
    adversarial_tags: ["synthetic"],
    critical_invariants: [invariantId],
    gold_rationale: "Synthetic case for comparator unit testing.",
    expected: {
      disposition: "neutral",
      signals: ["redirect"],
      evidence_strength: "moderate",
      ...expectedOverrides,
    },
  };
}

function syntheticCaseResult(
  c: MessageCase,
  promptVersion: string,
  prediction: CaseResult["prediction"],
): CaseResult {
  return {
    run_id: "synthetic",
    candidate_id: "anthropic-sonnet-5",
    provider_id: "anthropic",
    requested_model: "claude-sonnet-5",
    inference_config: {
      policy_version: "test",
      provider_id: "anthropic",
      model_capability_profile: "test",
      thinking_mode: "adaptive",
      effort: "medium",
      budget_tokens: null,
      reasoning_effort: "medium",
      temperature: "provider_default",
      max_output_tokens: 512,
      structured_output_transport_version: "test",
    },
    inference_config_digest: "testdigest0000000",
    endpoint: "https://api.anthropic.com/v1/messages",
    case_id: c.case_id,
    task: "message",
    split: c.split,
    corpus_version: CORPUS_VERSION,
    prompt_version: promptVersion,
    schema_version: B07_BENCHMARK_SCHEMA_VERSION,
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
          output_tokens: 10,
          reasoning_tokens: 0,
          cached_input_tokens: 0,
        },
        returned_model: "claude-sonnet-5",
      },
    ],
    first_pass_schema_valid: true,
    retry_used: false,
    final_schema_valid: true,
    prediction,
    total_latency_ms: 10,
    usage_totals: {
      input_tokens: 100,
      output_tokens: 10,
      reasoning_tokens: 0,
      cached_input_tokens: 0,
    },
    evaluated_at: new Date().toISOString(),
  };
}

describe("EXPERIMENT 1 comparator — known-violation fixed/regression detection", () => {
  // Case A: v2 VIOLATES redirect_not_terminal (predicts rejection on a
  // redirect-tagged case); v3 predicts the honest redirect reading — FIXED.
  const caseA = syntheticMessageCase("synthetic-hold-a", "redirect_not_terminal");
  // Case B: v2 does NOT violate no_fabricated_strong_evidence (predicts
  // weak); v3 DOES (predicts strong) — a NEW regression.
  const caseB = syntheticMessageCase("synthetic-hold-b", "no_fabricated_strong_evidence", {
    disposition: "ambiguous",
    signals: [],
    evidence_strength: "insufficient_evidence",
  });

  const v2Results: CaseResult[] = [
    syntheticCaseResult(caseA, PROMPT_VERSION, {
      disposition: "negative",
      signals: ["rejection"],
      evidence_strength: "moderate",
    }),
    syntheticCaseResult(caseB, PROMPT_VERSION, {
      disposition: "ambiguous",
      signals: [],
      evidence_strength: "weak",
    }),
  ];
  const v3Results: CaseResult[] = [
    syntheticCaseResult(caseA, PROMPT_VERSION_V3, {
      disposition: "neutral",
      signals: ["redirect"],
      evidence_strength: "moderate",
    }),
    syntheticCaseResult(caseB, PROMPT_VERSION_V3, {
      disposition: "ambiguous",
      signals: [],
      evidence_strength: "strong",
    }),
  ];

  it("recomputes exactly 2 known v2 violations, 1 fixed and 1 not, plus 1 new v3 regression", () => {
    const comparison = comparePromptV2AndV3OnHoldout({
      candidateId: "anthropic-sonnet-5",
      providerId: "anthropic",
      requestedModel: "claude-sonnet-5",
      v2HoldoutResults: v2Results,
      v2SupplementalResults: [],
      v3HoldoutResults: v3Results,
      v3SupplementalResults: [],
      holdoutCases: [caseA, caseB],
      supplementalCases: [],
    });

    expect(comparison.label).toBe(PROMPT_V3_DIAGNOSTIC_LABEL);
    expect(comparison.identity.v2_prompt_version).toBe(PROMPT_VERSION);
    expect(comparison.identity.v3_prompt_version).toBe(PROMPT_VERSION_V3);

    const {
      known_v2_critical_violations,
      new_v3_critical_regressions,
      known_violations_fixed_count,
      known_violations_total_count,
      new_regressions_count,
    } = comparison.main_holdout;

    expect(known_violations_total_count).toBe(1);
    expect(known_v2_critical_violations).toHaveLength(1);
    expect(known_v2_critical_violations[0]?.case_id).toBe("synthetic-hold-a");
    expect(known_v2_critical_violations[0]?.invariant_id).toBe("redirect_not_terminal");
    expect(known_v2_critical_violations[0]?.fixed_under_v3).toBe(true);
    expect(known_violations_fixed_count).toBe(1);

    expect(new_regressions_count).toBe(1);
    expect(new_v3_critical_regressions).toHaveLength(1);
    expect(new_v3_critical_regressions[0]?.case_id).toBe("synthetic-hold-b");
    expect(new_v3_critical_regressions[0]?.invariant_id).toBe("no_fabricated_strong_evidence");
  });

  it("a violation present under BOTH v2 and v3 is reported as known-but-not-fixed, never as a regression", () => {
    const persistentV3Results: CaseResult[] = [
      syntheticCaseResult(caseA, PROMPT_VERSION_V3, {
        disposition: "negative",
        signals: ["rejection"],
        evidence_strength: "moderate",
      }),
      syntheticCaseResult(caseB, PROMPT_VERSION_V3, {
        disposition: "ambiguous",
        signals: [],
        evidence_strength: "weak",
      }),
    ];
    const comparison = comparePromptV2AndV3OnHoldout({
      candidateId: "anthropic-sonnet-5",
      providerId: "anthropic",
      requestedModel: "claude-sonnet-5",
      v2HoldoutResults: v2Results,
      v2SupplementalResults: [],
      v3HoldoutResults: persistentV3Results,
      v3SupplementalResults: [],
      holdoutCases: [caseA, caseB],
      supplementalCases: [],
    });
    expect(comparison.main_holdout.known_violations_fixed_count).toBe(0);
    expect(comparison.main_holdout.known_v2_critical_violations[0]?.fixed_under_v3).toBe(false);
    expect(comparison.main_holdout.new_regressions_count).toBe(0);
  });

  it("aggregate deltas are numeric and reflect improvement direction when v3 predicts every disposition correctly", () => {
    const perfectV3Results: CaseResult[] = [
      syntheticCaseResult(caseA, PROMPT_VERSION_V3, {
        disposition: "neutral",
        signals: ["redirect"],
        evidence_strength: "moderate",
      }),
      syntheticCaseResult(caseB, PROMPT_VERSION_V3, {
        disposition: "ambiguous",
        signals: [],
        evidence_strength: "insufficient_evidence",
      }),
    ];
    const comparison = comparePromptV2AndV3OnHoldout({
      candidateId: "anthropic-sonnet-5",
      providerId: "anthropic",
      requestedModel: "claude-sonnet-5",
      v2HoldoutResults: v2Results,
      v2SupplementalResults: [],
      v3HoldoutResults: perfectV3Results,
      v3SupplementalResults: [],
      holdoutCases: [caseA, caseB],
      supplementalCases: [],
    });
    const { disposition_macro_f1_strict, signal_micro_f1_strict } =
      comparison.main_holdout.aggregate_deltas;
    expect(typeof disposition_macro_f1_strict.v2).toBe("number");
    expect(typeof disposition_macro_f1_strict.v3).toBe("number");
    expect(disposition_macro_f1_strict.v3).toBeGreaterThanOrEqual(disposition_macro_f1_strict.v2);
    expect(typeof signal_micro_f1_strict.delta).toBe("number");
  });
});

describe("EXPERIMENT 1 comparator — supplemental 6-case comparison", () => {
  const cases = loadSupplementalAmbiguityPack();
  const pack = supplementalPackManifest();

  function supplementalRow(
    caseId: string,
    promptVersion: string,
    disposition: "ambiguous" | "positive",
  ): SupplementalCaseResult {
    return {
      run_id: "synthetic",
      candidate_id: "anthropic-sonnet-5",
      provider_id: "anthropic",
      requested_model: "claude-sonnet-5",
      inference_config: {
        policy_version: "test",
        provider_id: "anthropic",
        model_capability_profile: "test",
        thinking_mode: "adaptive",
        effort: "medium",
        budget_tokens: null,
        reasoning_effort: "medium",
        temperature: "provider_default",
        max_output_tokens: 512,
        structured_output_transport_version: "test",
      },
      inference_config_digest: "testdigest0000000",
      endpoint: "https://api.anthropic.com/v1/messages",
      case_id: caseId,
      task: "message",
      pack_version: pack.pack_version,
      pack_digest: pack.digest,
      prompt_version: promptVersion,
      schema_version: B07_BENCHMARK_SCHEMA_VERSION,
      status: "ok",
      attempts: [],
      first_pass_schema_valid: true,
      retry_used: false,
      final_schema_valid: true,
      prediction: { disposition, signals: [], evidence_strength: "moderate" },
      total_latency_ms: 10,
      usage_totals: {
        input_tokens: 100,
        output_tokens: 10,
        reasoning_tokens: 0,
        cached_input_tokens: 0,
      },
      evaluated_at: new Date().toISOString(),
    };
  }

  it("v2 wrong-on-all-6 vs v3 correct-on-all-6 produces a full accuracy delta and correct per-case flags", () => {
    const v2Rows = cases.map((c) => supplementalRow(c.case_id, PROMPT_VERSION, "positive"));
    const v3Rows = cases.map((c) => supplementalRow(c.case_id, PROMPT_VERSION_V3, "ambiguous"));
    const comparison = comparePromptV2AndV3OnHoldout({
      candidateId: "anthropic-sonnet-5",
      providerId: "anthropic",
      requestedModel: "claude-sonnet-5",
      v2HoldoutResults: [],
      v2SupplementalResults: v2Rows,
      v3HoldoutResults: [],
      v3SupplementalResults: v3Rows,
      holdoutCases: [],
    });
    expect(comparison.supplemental.disposition_strict_accuracy_delta.v2).toBe(0);
    expect(comparison.supplemental.disposition_strict_accuracy_delta.v3).toBe(1);
    expect(comparison.supplemental.disposition_strict_accuracy_delta.delta).toBe(1);
    expect(comparison.supplemental.case_by_case).toHaveLength(6);
    for (const row of comparison.supplemental.case_by_case) {
      expect(row.v2_correct).toBe(false);
      expect(row.v3_correct).toBe(true);
    }
  });
});

describe("EXPERIMENT 2 generalization scorer", () => {
  const cases = loadPromptV3GeneralizationChallenge();
  const manifest = { pack_version: cases[0]!.pack_version };

  function rowFor(
    caseId: string,
    prediction: SupplementalCaseResult["prediction"],
  ): SupplementalCaseResult {
    const c = cases.find((x) => x.case_id === caseId)!;
    return {
      run_id: "synthetic",
      candidate_id: "anthropic-sonnet-5",
      provider_id: "anthropic",
      requested_model: "claude-sonnet-5",
      inference_config: {
        policy_version: "test",
        provider_id: "anthropic",
        model_capability_profile: "test",
        thinking_mode: "adaptive",
        effort: "medium",
        budget_tokens: null,
        reasoning_effort: "medium",
        temperature: "provider_default",
        max_output_tokens: 512,
        structured_output_transport_version: "test",
      },
      inference_config_digest: "testdigest0000000",
      endpoint: "https://api.anthropic.com/v1/messages",
      case_id: caseId,
      task: "message",
      pack_version: manifest.pack_version,
      pack_digest: "will-be-overridden-by-real-digest-check",
      prompt_version: PROMPT_VERSION_V3,
      schema_version: B07_BENCHMARK_SCHEMA_VERSION,
      status: "ok",
      attempts: [],
      first_pass_schema_valid: true,
      retry_used: false,
      final_schema_valid: true,
      prediction,
      total_latency_ms: 10,
      usage_totals: {
        input_tokens: 100,
        output_tokens: 10,
        reasoning_tokens: 0,
        cached_input_tokens: 0,
      },
      evaluated_at: new Date().toISOString(),
    };
  }

  it("a fully-correct run (predicts gold exactly for all 36) scores 100% everywhere and zero critical violations", () => {
    // Use the REAL current pack digest so rows are not flagged as drifted.
    const realDigest = generalizationPackManifest().digest;
    const rows = cases.map((c) => ({ ...rowFor(c.case_id, c.expected), pack_digest: realDigest }));

    const score = scorePromptV3Generalization({
      candidateId: "anthropic-sonnet-5",
      providerId: "anthropic",
      requestedModel: "claude-sonnet-5",
      results: rows,
    });

    expect(score.invalidated_reason).toBeNull();
    expect(score.n).toBe(36);
    expect(score.overall.fully_correct_rate).toBe(1);
    expect(score.contrast.fully_correct_rate).toBe(1);
    expect(score.conservative.fully_correct_rate).toBe(1);
    expect(score.conservative.critical_violations_total).toBe(0);
    expect(score.reliability.all_36_valid_predictions).toBe(true);
    expect(score.by_category).toHaveLength(5);
    for (const cat of score.by_category) {
      expect(cat.fully_correct_rate).toBe(1);
    }
  });

  it("a single decisive-wrong answer on a conservative case is counted as both a fully_correct miss AND a critical invariant violation", () => {
    const realDigest = generalizationPackManifest().digest;
    const target = cases.find((c) => c.case_id === "gc-unc-en-001")!;
    expect(target.is_contrast).toBe(false);
    expect(target.critical_invariants).toContain("explicit_uncertainty_not_rejection");

    const decisiveWrongPrediction: SupplementalCaseResult["prediction"] = {
      disposition: "negative",
      signals: ["rejection"],
      evidence_strength: "weak",
    };
    const rows = cases.map((c) => {
      const prediction = c.case_id === target.case_id ? decisiveWrongPrediction : c.expected;
      return { ...rowFor(c.case_id, prediction), pack_digest: realDigest };
    });

    const score = scorePromptV3Generalization({
      candidateId: "anthropic-sonnet-5",
      providerId: "anthropic",
      requestedModel: "claude-sonnet-5",
      results: rows,
    });

    expect(score.overall.fully_correct).toBe(35);
    expect(score.conservative.critical_violations_total).toBe(1);
    expect(score.critical_violations_by_invariant.explicit_uncertainty_not_rejection).toBe(1);
    expect(score.contrast.fully_correct_rate).toBe(1); // no contrast case was touched
    const uncCategory = score.by_category.find((c) => c.category === "uncertainty_pending");
    expect(uncCategory?.fully_correct).toBe(7);
    expect(uncCategory?.n).toBe(8);

    const caseOutcome = score.case_outcomes.find((o) => o.case_id === target.case_id);
    expect(caseOutcome?.fully_correct).toBe(false);
    expect(caseOutcome?.critical_violations).toHaveLength(1);
  });

  it("pack drift (same version, different digest) invalidates the score rather than silently scoring stale rows", () => {
    const rows = cases.map((c) => ({
      ...rowFor(c.case_id, c.expected),
      pack_digest: "clearly-stale-digest",
    }));
    const score = scorePromptV3Generalization({
      candidateId: "anthropic-sonnet-5",
      providerId: "anthropic",
      requestedModel: "claude-sonnet-5",
      results: rows,
    });
    expect(score.invalidated_reason).toMatch(/DRIFT/);
  });
});

describe("interpretation helper — a genuine function of results, not a hardcoded conclusion", () => {
  function holdout(fixed: number, total: number, regressions: number): HoldoutSideSummary {
    return {
      known_violations_fixed_count: fixed,
      known_violations_total_count: total,
      new_regressions_count: regressions,
    };
  }
  function generalization(
    conservativeViolations: number,
    contrastAccuracy: number,
    overallAccuracy: number,
  ): GeneralizationSideSummary {
    return {
      conservative_critical_violations_total: conservativeViolations,
      contrast_fully_correct_rate: contrastAccuracy,
      overall_fully_correct_rate: overallAccuracy,
      n: 36,
      conservative_n: 21,
    };
  }

  it("A — PROMPT_LIMITED_EVIDENCE: all known violations fixed, no regressions, strong generalization", () => {
    const result = resolvePromptV3Interpretation(holdout(3, 3, 0), generalization(0, 0.9, 0.85));
    expect(result.interpretation).toBe("PROMPT_LIMITED_EVIDENCE");
    expect(result.metrics.holdout_side_clean).toBe(true);
    expect(result.metrics.generalization_performs_strongly).toBe(true);
  });

  it("B — MODEL_LIMITED_EVIDENCE: a known violation persists, even with strong generalization elsewhere", () => {
    const result = resolvePromptV3Interpretation(holdout(2, 3, 0), generalization(0, 0.9, 0.9));
    expect(result.interpretation).toBe("MODEL_LIMITED_EVIDENCE");
  });

  it("B — MODEL_LIMITED_EVIDENCE: all known violations fixed, but a NEW regression appears on the holdout", () => {
    const result = resolvePromptV3Interpretation(holdout(3, 3, 1), generalization(0, 0.9, 0.9));
    expect(result.interpretation).toBe("MODEL_LIMITED_EVIDENCE");
  });

  it("C — OVERFIT_INCONCLUSIVE: holdout side is clean, but the blind generalization set fails", () => {
    const result = resolvePromptV3Interpretation(holdout(3, 3, 0), generalization(2, 0.4, 0.5));
    expect(result.interpretation).toBe("OVERFIT_INCONCLUSIVE");
  });

  it("is a pure function: identical inputs always produce the identical bucket", () => {
    const a = resolvePromptV3Interpretation(holdout(1, 3, 0), generalization(0, 1, 1));
    const b = resolvePromptV3Interpretation(holdout(1, 3, 0), generalization(0, 1, 1));
    expect(a.interpretation).toBe(b.interpretation);
    expect(a.interpretation).toBe("MODEL_LIMITED_EVIDENCE");
  });

  it("summarizeGeneralizationForInterpretation extracts exactly the fields the interpreter reads", () => {
    const cases = loadPromptV3GeneralizationChallenge();
    const score = scorePromptV3Generalization({
      candidateId: "x",
      providerId: "anthropic",
      requestedModel: "claude-sonnet-5",
      results: [],
      cases,
    });
    const summary = summarizeGeneralizationForInterpretation(score);
    expect(summary.n).toBe(score.n);
    expect(summary.conservative_n).toBe(score.conservative.n);
    expect(summary.conservative_critical_violations_total).toBe(
      score.conservative.critical_violations_total,
    );
    expect(summary.contrast_fully_correct_rate).toBe(score.contrast.fully_correct_rate);
    expect(summary.overall_fully_correct_rate).toBe(score.overall.fully_correct_rate);
  });
});

describe("promptv3-diagnostic CLI wiring", () => {
  function fetchMustNotBeCalled() {
    return vi.fn().mockImplementation(() => {
      throw new Error(
        "TEST FAILURE: a provider fetch call was made when none should have happened",
      );
    });
  }

  it("parseArgs recognises --against holdout|generalization", () => {
    const holdoutArgs = parseArgs([
      "promptv3-diagnostic",
      "--candidate",
      "anthropic-sonnet-5",
      "--against",
      "holdout",
    ]);
    expect(holdoutArgs.against).toBe("holdout");
    const genArgs = parseArgs([
      "promptv3-diagnostic",
      "--candidate",
      "anthropic-sonnet-5",
      "--against",
      "generalization",
    ]);
    expect(genArgs.against).toBe("generalization");
  });

  it("parseArgs rejects an unrecognised --against value", () => {
    expect(() => parseArgs(["promptv3-diagnostic", "--against", "nonsense"])).toThrow();
  });

  it("without an API key, a real invocation makes ZERO provider calls and records not_run_missing_key evidence, never a fake result", async () => {
    vi.stubGlobal("fetch", fetchMustNotBeCalled());
    delete process.env.ANTHROPIC_API_KEY;
    const runId = freshRunId("no-key-generalization");
    // Exercises the actual runner path via the CLI's own command, using a
    // minimal, fast selection surface: the generalization pack (36 cases) —
    // every case resolves to `not_run_missing_key` without any network call.
    const { runGeneralizationUnderPromptV3 } =
      await import("../../scripts/b07-benchmark/run/promptv3-diagnostic-runner");
    const { candidateById } = await import("../../scripts/b07-benchmark/config/candidates");
    const candidate = candidateById("anthropic-sonnet-5")!;
    const outcome = await runGeneralizationUnderPromptV3({
      runId,
      candidate,
      concurrency: 4,
      maxSchemaRetries: 1,
      dryRun: false,
      resume: false,
      log: () => {},
    });
    expect(outcome.availability).toBe("not_run_missing_key");
    expect(outcome.results.every((r) => r.status === "not_run_missing_key")).toBe(true);
    expect(outcome.results.every((r) => r.prediction === null)).toBe(true);
    expect(outcome.results.every((r) => r.prompt_version === PROMPT_VERSION_V3)).toBe(true);
  });
});

// Referenced to keep `runStage` imported (guards against an accidental
// removal of the v2 stage path while wiring the new CLI command) without
// actually invoking it in this file's tests.
void runStage;
