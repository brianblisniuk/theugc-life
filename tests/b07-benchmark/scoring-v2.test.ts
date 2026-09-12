/**
 * B07 benchmark — scoring-v2 integrity correction.
 *
 * PASS A reproduces the external-audit finding against the PRESERVED v1
 * scorer (never modified): the same corpus case, scored against two
 * different valid (acceptable-set) predictions, contributes to a DIFFERENT
 * gold class's support depending on which candidate predicted it. PASS B/C
 * cover the scoring-v2 replacement and the round's explicit attack list
 * (acceptance tests 1-18 in the task brief, cited inline by number).
 */
import { describe, expect, it } from "vitest";

import type { CorpusCase } from "../../scripts/b07-benchmark/corpus/schema";
import { estimateCaseCostUsd, type PriceBook } from "../../scripts/b07-benchmark/config/pricing";
import { scoreCandidate } from "../../scripts/b07-benchmark/scoring/score";
import { scoreCandidateV2 } from "../../scripts/b07-benchmark/scoring/score-v2";
import {
  checkHoldoutCanResolve,
  evaluateCandidateV2,
  holdoutSupportPreflight,
  type CandidateEvaluationV2,
} from "../../scripts/b07-benchmark/scoring/targets-v2";
import { QUALITY_TARGETS } from "../../scripts/b07-benchmark/scoring/targets";
import { MIN_RELIABLE_CLASS_SUPPORT } from "../../scripts/b07-benchmark/scoring/metrics";
import {
  SCORING_VERSION_V1,
  SCORING_VERSION_V2,
} from "../../scripts/b07-benchmark/scoring/scoring-version";
import type { CaseResult } from "../../scripts/b07-benchmark/run/types";
import type { MessageOutput, ThreadOutput } from "../../scripts/b07-benchmark/schema";
import { DISPOSITIONS, SIGNALS } from "../../scripts/b07-benchmark/taxonomy";

const PRICE: PriceBook = {
  candidate_id: "test",
  input_usd_per_mtok: 2,
  cached_input_usd_per_mtok: 0.2,
  output_usd_per_mtok: 10,
  reasoning_usd_per_mtok: 10,
  reasoning_billed_separately_from_output: true,
  source: "test",
  source_url: "https://example.invalid/pricing",
  accessed_at: "2026-09-12",
  verification: "unverified_not_checked",
};

const TEST_INFERENCE_CONFIG = {
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
const TEST_INFERENCE_CONFIG_DIGEST = "test-config-digest";

function messageCase(
  id: string,
  expected: MessageOutput,
  acceptable?: Record<string, unknown>,
): CorpusCase {
  return {
    case_id: id,
    split: "dev",
    task: "message",
    language: "en",
    subject: "s",
    messages: [{ from: "target", text: "t" }],
    focus_index: 0,
    expected,
    ...(acceptable ? { acceptable } : {}),
    adversarial_tags: [],
    critical_invariants: [],
    gold_rationale: "test",
  } as unknown as CorpusCase;
}

function okResult(
  caseId: string,
  task: "message" | "thread",
  candidateId: string,
  prediction: MessageOutput | ThreadOutput,
  overrides: Partial<CaseResult> = {},
): CaseResult {
  return {
    run_id: "r",
    candidate_id: candidateId,
    provider_id: "openai",
    requested_model: "m",
    inference_config: TEST_INFERENCE_CONFIG,
    inference_config_digest: TEST_INFERENCE_CONFIG_DIGEST,
    endpoint: "https://example.invalid",
    case_id: caseId,
    task,
    split: "dev",
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
        latency_ms: 100,
        usage: {
          input_tokens: 1000,
          output_tokens: 50,
          reasoning_tokens: 10,
          cached_input_tokens: 0,
        },
        returned_model: "m-2026",
      },
    ],
    first_pass_schema_valid: true,
    retry_used: false,
    final_schema_valid: true,
    prediction,
    total_latency_ms: 100,
    usage_totals: {
      input_tokens: 1000,
      output_tokens: 50,
      reasoning_tokens: 10,
      cached_input_tokens: 0,
    },
    evaluated_at: "2026-09-12T00:00:00.000Z",
    ...overrides,
  };
}

function scoreV1(candidateId: string, cases: CorpusCase[], results: CaseResult[]) {
  return scoreCandidate({
    candidateId,
    providerId: "openai",
    requestedModel: "m",
    corpusVersion: "v",
    promptVersion: "p",
    schemaVersion: "s",
    cases,
    results,
    priceBook: PRICE,
  });
}

function scoreV2(candidateId: string, cases: CorpusCase[], results: CaseResult[]) {
  return scoreCandidateV2({
    candidateId,
    providerId: "openai",
    requestedModel: "m",
    corpusVersion: "v",
    promptVersion: "p",
    schemaVersion: "s",
    cases,
    results,
    priceBook: PRICE,
  });
}

// One multi-answer case: primary `ambiguous`, `neutral` also acceptable —
// the exact shape of the external audit's worked example.
const AMBIGUOUS_CASE = messageCase(
  "m-multi",
  { disposition: "ambiguous", signals: [], evidence_strength: "insufficient_evidence" },
  { disposition: ["ambiguous", "neutral"] },
);

describe("PASS A: reproduces the scoring-v1 defect (documented, v1 preserved unchanged)", () => {
  it("the SAME corpus case contributes to a DIFFERENT gold class's support depending on which acceptable answer the candidate predicted", () => {
    const cases = [AMBIGUOUS_CASE];
    const candidateA = scoreV1("candidate-a", cases, [
      okResult("m-multi", "message", "candidate-a", {
        disposition: "ambiguous",
        signals: [],
        evidence_strength: "insufficient_evidence",
      }),
    ]);
    const candidateB = scoreV1("candidate-b", cases, [
      okResult("m-multi", "message", "candidate-b", {
        disposition: "neutral",
        signals: [],
        evidence_strength: "insufficient_evidence",
      }),
    ]);
    // THIS is the defect: identical corpus, identical acceptable set, two
    // different valid predictions -> two different classes receive support.
    expect(candidateA.message_task?.disposition.per_class.ambiguous?.support).toBe(1);
    expect(candidateA.message_task?.disposition.per_class.neutral?.support).toBe(0);
    expect(candidateB.message_task?.disposition.per_class.ambiguous?.support).toBe(0);
    expect(candidateB.message_task?.disposition.per_class.neutral?.support).toBe(1);
    // Both predictions are equally D072-acceptable, yet the gold-class
    // support matrices disagree — the exact non-comparability the audit
    // flagged. v1 is preserved exactly as-is (this is documented history,
    // not something v1 itself is patched to avoid).
    expect(candidateA.scoring_version).toBe(SCORING_VERSION_V1);
  });
});

describe("scoring v2: acceptable-answer accuracy (Family A)", () => {
  it("1. an acceptable-alternative prediction counts as correct, exactly like the primary", () => {
    const cases = [AMBIGUOUS_CASE];
    const a = scoreV2("candidate-a", cases, [
      okResult("m-multi", "message", "candidate-a", {
        disposition: "ambiguous",
        signals: [],
        evidence_strength: "insufficient_evidence",
      }),
    ]);
    const b = scoreV2("candidate-b", cases, [
      okResult("m-multi", "message", "candidate-b", {
        disposition: "neutral",
        signals: [],
        evidence_strength: "insufficient_evidence",
      }),
    ]);
    expect(a.message_task?.disposition.acceptable_answer.correct).toBe(1);
    expect(b.message_task?.disposition.acceptable_answer.correct).toBe(1);
    expect(a.message_task?.disposition.acceptable_answer.accuracy).toBe(1);
    expect(b.message_task?.disposition.acceptable_answer.accuracy).toBe(1);
  });

  it("real failure: a NON-acceptable prediction is still wrong under acceptable-answer accuracy", () => {
    const cases = [AMBIGUOUS_CASE];
    const wrong = scoreV2("candidate-c", cases, [
      okResult("m-multi", "message", "candidate-c", {
        disposition: "positive",
        signals: [],
        evidence_strength: "insufficient_evidence",
      }),
    ]);
    expect(wrong.message_task?.disposition.acceptable_answer.correct).toBe(0);
    expect(wrong.message_task?.disposition.acceptable_answer.accuracy).toBe(0);
  });

  it("5. acceptable-answer accuracy uses ALL cases, including multi-answer ones", () => {
    const cases = [
      AMBIGUOUS_CASE,
      messageCase("m-single", {
        disposition: "positive",
        signals: [],
        evidence_strength: "strong",
      }),
    ];
    const score = scoreV2("c", cases, [
      okResult("m-multi", "message", "c", {
        disposition: "ambiguous",
        signals: [],
        evidence_strength: "insufficient_evidence",
      }),
      okResult("m-single", "message", "c", {
        disposition: "positive",
        signals: [],
        evidence_strength: "strong",
      }),
    ]);
    expect(score.message_task?.disposition.acceptable_answer.n).toBe(2);
    expect(score.message_task?.disposition.acceptable_answer.correct).toBe(2);
  });
});

describe("scoring v2: strict per-class F1 (Family B)", () => {
  it("2 & 3. primary and acceptable-alternative predictions yield IDENTICAL strict support, and it is corpus-derived, never candidate-derived", () => {
    const cases = [
      AMBIGUOUS_CASE,
      messageCase("m-pos-1", { disposition: "positive", signals: [], evidence_strength: "strong" }),
      messageCase("m-pos-2", { disposition: "positive", signals: [], evidence_strength: "strong" }),
      messageCase("m-pos-3", { disposition: "positive", signals: [], evidence_strength: "strong" }),
    ];
    const strictPredictions = [
      okResult("m-pos-1", "message", "x", {
        disposition: "positive",
        signals: [],
        evidence_strength: "strong",
      }),
      okResult("m-pos-2", "message", "x", {
        disposition: "positive",
        signals: [],
        evidence_strength: "strong",
      }),
      okResult("m-pos-3", "message", "x", {
        disposition: "positive",
        signals: [],
        evidence_strength: "strong",
      }),
    ];
    const a = scoreV2("candidate-a", cases, [
      okResult("m-multi", "message", "candidate-a", {
        disposition: "ambiguous",
        signals: [],
        evidence_strength: "insufficient_evidence",
      }),
      ...strictPredictions.map((r) => ({ ...r, candidate_id: "candidate-a" })),
    ]);
    const b = scoreV2("candidate-b", cases, [
      okResult("m-multi", "message", "candidate-b", {
        disposition: "neutral",
        signals: [],
        evidence_strength: "insufficient_evidence",
      }),
      ...strictPredictions.map((r) => ({ ...r, candidate_id: "candidate-b" })),
    ]);
    // The multi-answer case is excluded from strict scoring either way, so
    // its class support is IDENTICAL (zero contribution) regardless of which
    // acceptable alternative the candidate predicted.
    expect(a.message_task?.disposition.strict.per_class).toEqual(
      b.message_task?.disposition.strict.per_class,
    );
    expect(a.message_task?.disposition.strict.per_class.ambiguous?.support).toBe(0);
    expect(a.message_task?.disposition.strict.per_class.neutral?.support).toBe(0);
    expect(a.message_task?.disposition.strict.per_class.positive?.support).toBe(3);
    // Corpus-derived full support (never touches a prediction) is also
    // identical across candidates.
    expect(a.message_task?.disposition_full_support).toEqual(
      b.message_task?.disposition_full_support,
    );
  });

  it("4. strict macro F1 excludes genuinely multi-answer cases, and reports how many", () => {
    const cases = [
      AMBIGUOUS_CASE,
      messageCase("m-pos-1", { disposition: "positive", signals: [], evidence_strength: "strong" }),
    ];
    const score = scoreV2("c", cases, [
      okResult("m-multi", "message", "c", {
        disposition: "ambiguous",
        signals: [],
        evidence_strength: "insufficient_evidence",
      }),
      okResult("m-pos-1", "message", "c", {
        disposition: "positive",
        signals: [],
        evidence_strength: "strong",
      }),
    ]);
    expect(score.message_task?.disposition.strict.n).toBe(1);
    expect(score.message_task?.disposition.strict.excluded_multi_answer_cases).toBe(1);
  });

  it("a redundant acceptable declaration (same value repeated) does NOT exclude a case from strict scoring", () => {
    const cases = [
      messageCase(
        "m-redundant",
        { disposition: "positive", signals: [], evidence_strength: "strong" },
        { disposition: ["positive"] },
      ),
    ];
    const score = scoreV2("c", cases, [
      okResult("m-redundant", "message", "c", {
        disposition: "positive",
        signals: [],
        evidence_strength: "strong",
      }),
    ]);
    expect(score.message_task?.disposition.strict.excluded_multi_answer_cases).toBe(0);
    expect(score.message_task?.disposition.strict.n).toBe(1);
  });
});

describe("scoring v2: signal acceptable-set metrics are equally free of candidate-dependent support (17)", () => {
  const multiSignalCase = messageCase(
    "m-sig-multi",
    { disposition: "positive", signals: ["interest"], evidence_strength: "strong" },
    { signals: [["interest"], ["interest", "offer"]] },
  );
  const strictSignalCase = messageCase("m-sig-strict", {
    disposition: "positive",
    signals: ["interest"],
    evidence_strength: "strong",
  });

  it("two candidates predicting different acceptable signal-set alternatives get identical strict per-label support", () => {
    const cases = [multiSignalCase, strictSignalCase];
    const a = scoreV2("candidate-a", cases, [
      okResult("m-sig-multi", "message", "candidate-a", {
        disposition: "positive",
        signals: ["interest"],
        evidence_strength: "strong",
      }),
      okResult("m-sig-strict", "message", "candidate-a", {
        disposition: "positive",
        signals: ["interest"],
        evidence_strength: "strong",
      }),
    ]);
    const b = scoreV2("candidate-b", cases, [
      okResult("m-sig-multi", "message", "candidate-b", {
        disposition: "positive",
        signals: ["interest", "offer"],
        evidence_strength: "strong",
      }),
      okResult("m-sig-strict", "message", "candidate-b", {
        disposition: "positive",
        signals: ["interest"],
        evidence_strength: "strong",
      }),
    ]);
    expect(a.message_task?.signals.acceptable_set.correct).toBe(2);
    expect(b.message_task?.signals.acceptable_set.correct).toBe(2);
    expect(a.message_task?.signals.strict.per_label).toEqual(
      b.message_task?.signals.strict.per_label,
    );
    // `offer` never appears in the strict subset for either candidate.
    expect(a.message_task?.signals.strict.per_label.offer?.support).toBe(0);
    expect(a.message_task?.signals.strict.excluded_multi_answer_cases).toBe(1);
  });
});

describe("no candidate-specific code (hostile review)", () => {
  it("identical inputs under two different candidate_ids produce identical scoring-v2 output apart from the id itself", () => {
    const cases = [
      messageCase("m1", {
        disposition: "positive",
        signals: ["interest"],
        evidence_strength: "strong",
      }),
    ];
    const prediction: MessageOutput = {
      disposition: "positive",
      signals: ["interest"],
      evidence_strength: "strong",
    };
    const haiku = scoreV2("anthropic-haiku-4-5", cases, [
      okResult("m1", "message", "anthropic-haiku-4-5", prediction),
    ]);
    const sonnet = scoreV2("anthropic-sonnet-5", cases, [
      okResult("m1", "message", "anthropic-sonnet-5", prediction),
    ]);
    const { candidate_id: _h, ...haikuRest } = haiku;
    const { candidate_id: _s, ...sonnetRest } = sonnet;
    expect(haikuRest).toEqual(sonnetRest);
  });
});

// ---------------------------------------------------------------------------
// Quality-target tri-state evaluation and Stage-1 disposition
// ---------------------------------------------------------------------------

function fullDisposition(overrides: Record<string, number> = {}): Record<string, number> {
  const base: Record<string, number> = {
    positive: 0,
    negative: 0,
    neutral: 0,
    mixed: 0,
    ambiguous: 0,
  };
  return { ...base, ...overrides };
}

function perClass(support: number, f1: number) {
  return {
    support,
    predicted: support,
    true_positives: support,
    false_positives: 0,
    false_negatives: 0,
    precision: f1,
    recall: f1,
    f1,
  };
}

/** Hand-built CandidateScoreV2 for isolated target-evaluation tests. */
function buildScoreV2Fixture(overrides: {
  criticalViolations?: number;
  passesCriticalGate?: boolean;
  hasEvidence?: boolean;
  dispositionSupport?: Record<string, number>;
  dispositionFullSupport?: Record<string, number>;
  dispositionMacroF1?: number;
  signalMicroF1?: number;
  signalSupport?: Record<string, number>;
  signalFullSupport?: Record<string, number>;
}): ReturnType<typeof scoreV2> {
  const dispositionSupport = overrides.dispositionSupport ?? {
    positive: 10,
    negative: 10,
    neutral: 10,
    mixed: 10,
    ambiguous: 10,
  };
  const dispositionFullSupport = overrides.dispositionFullSupport ?? dispositionSupport;
  const macroF1 = overrides.dispositionMacroF1 ?? 0.95;
  const perClassRecord = Object.fromEntries(
    DISPOSITIONS.map((cls) => [cls, perClass(dispositionSupport[cls] ?? 0, macroF1)]),
  );
  const signalSupport = overrides.signalSupport ?? Object.fromEntries(SIGNALS.map((s) => [s, 10]));
  const signalFullSupport = overrides.signalFullSupport ?? signalSupport;
  const signalMicroF1 = overrides.signalMicroF1 ?? 0.95;
  const perLabelRecord = Object.fromEntries(
    SIGNALS.map((s) => [s, perClass(signalSupport[s] ?? 0, signalMicroF1)]),
  );

  return {
    scoring_version: SCORING_VERSION_V2,
    candidate_id: "fixture",
    provider_id: "anthropic",
    requested_model: "m",
    corpus_version: "v",
    prompt_version: "p",
    schema_version: "s",
    invalidated_reason: null,
    identity_conflicts: [],
    inference_config: null,
    reliability: {
      cases_selected: 10,
      cases_attempted: overrides.hasEvidence === false ? 0 : 10,
      cases_not_run_missing_key: 0,
      cases_unavailable: 0,
      first_pass_schema_valid: 10,
      first_pass_schema_valid_rate: 1,
      retries_used: 0,
      retry_rate: 0,
      final_schema_valid: 10,
      final_schema_valid_rate: 1,
      provider_errors: 0,
      provider_error_rate: 0,
      timeouts: 0,
      timeout_rate: 0,
      returned_models: ["m"],
    },
    critical_suite: {
      cases: 5,
      cases_evaluated: 5,
      violations: overrides.criticalViolations ?? 0,
      cases_not_evaluated: 0,
      violations_by_invariant: {},
      violation_details: [],
      passes_hard_gate: overrides.passesCriticalGate ?? (overrides.criticalViolations ?? 0) === 0,
    },
    message_task: {
      n: 50,
      disposition: {
        acceptable_answer: { n: 50, correct: 48, accuracy: 0.96 },
        strict: {
          n: 50,
          correct: 48,
          accuracy: 0.96,
          macro_f1: macroF1,
          macro_f1_supported_classes: macroF1,
          per_class: perClassRecord,
          confusion: {},
          excluded_multi_answer_cases: 0,
        },
      },
      disposition_full_support: fullDisposition(dispositionFullSupport),
      signals: {
        acceptable_set: { n: 50, correct: 48, accuracy: 0.96 },
        strict: {
          n: 50,
          exact_set_matches: 48,
          exact_set_accuracy: 0.96,
          empty_set_gold: 0,
          empty_set_correct: 0,
          micro: {
            tp: 48,
            fp: 1,
            fn: 1,
            precision: signalMicroF1,
            recall: signalMicroF1,
            f1: signalMicroF1,
          },
          macro_f1: signalMicroF1,
          macro_f1_supported_classes: signalMicroF1,
          per_label: perLabelRecord,
          over_prediction_rate: 0.02,
          under_prediction_rate: 0.02,
          invalid_predictions: 0,
          excluded_multi_answer_cases: 0,
        },
      },
      signals_full_support: signalFullSupport,
      evidence_strength: {
        acceptable_answer: { n: 50, correct: 45, accuracy: 0.9 },
        strict: {
          n: 50,
          correct: 45,
          accuracy: 0.9,
          macro_f1: 0.9,
          macro_f1_supported_classes: 0.9,
          per_class: {},
          confusion: {},
          excluded_multi_answer_cases: 0,
        },
      },
    },
    thread_task: null,
    latency: { n: 10, median_ms: 100, p95_ms: 200, min_ms: 50, max_ms: 300 },
    latency_excluded_failed_calls: 0,
    economics: {
      pricing_basis: "no_pricing_metadata",
      price_source: null,
      price_source_url: null,
      price_accessed_at: null,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_reasoning_tokens: 0,
      total_cached_input_tokens: 0,
      estimated_total_cost_usd: null,
      estimated_cost_per_case_usd: null,
      estimated_cost_per_1k_messages_usd: null,
      estimated_cost_per_1k_threads_usd: null,
      cases_priced: 0,
    },
  };
}

describe("quality-target tri-state evaluation", () => {
  it("6. a disposition class below MIN_RELIABLE_CLASS_SUPPORT produces insufficient_support, never a hard PASS or FAIL", () => {
    const score = buildScoreV2Fixture({
      dispositionSupport: { positive: 10, negative: 10, neutral: 10, mixed: 10, ambiguous: 1 },
      dispositionMacroF1: 0.95,
    });
    const evaluation = evaluateCandidateV2(score);
    const target = evaluation.targets.find((t) => t.key === "disposition_macro_f1");
    expect(target?.state).toBe("insufficient_support");
    expect(evaluation.status).toBe("stage1_finalist_with_unresolved_quality_target");
    expect(evaluation.isStage1Finalist).toBe(true);
  });

  it("7 & 9. sufficient support + F1 above 0.90 (the UNCHANGED threshold) = an actual PASS", () => {
    const score = buildScoreV2Fixture({ dispositionMacroF1: 0.95 });
    const evaluation = evaluateCandidateV2(score);
    const target = evaluation.targets.find((t) => t.key === "disposition_macro_f1");
    expect(target?.state).toBe("pass");
    expect(target?.threshold).toBe(QUALITY_TARGETS.dispositionMacroF1);
    expect(QUALITY_TARGETS.dispositionMacroF1).toBe(0.9);
    expect(evaluation.status).toBe("stage1_finalist");
  });

  it("7 & 8. sufficient support + F1 below 0.90 = an actual FAIL, not a free pass for statistical caution", () => {
    const score = buildScoreV2Fixture({ dispositionMacroF1: 0.5 });
    const evaluation = evaluateCandidateV2(score);
    const target = evaluation.targets.find((t) => t.key === "disposition_macro_f1");
    expect(target?.state).toBe("fail");
    expect(evaluation.status).toBe("eliminated_quality_target_fail");
  });

  it("10 & 11. insufficient support alone never becomes a plain stage1_finalist, and a real fail always eliminates even alongside an insufficient target", () => {
    const insufficientOnly = evaluateCandidateV2(
      buildScoreV2Fixture({
        dispositionSupport: { positive: 10, negative: 10, neutral: 10, mixed: 10, ambiguous: 1 },
      }),
    );
    expect(insufficientOnly.status).not.toBe("stage1_finalist");
    expect(insufficientOnly.status).toBe("stage1_finalist_with_unresolved_quality_target");

    const failPlusInsufficient = evaluateCandidateV2(
      buildScoreV2Fixture({
        dispositionSupport: { positive: 10, negative: 10, neutral: 10, mixed: 10, ambiguous: 1 },
        signalMicroF1: 0.1,
      }),
    );
    // A real, evaluable failure elsewhere must still eliminate the candidate
    // — an unresolved target never launders an actual fail into a provisional pass.
    expect(failPlusInsufficient.status).toBe("eliminated_quality_target_fail");
  });

  it("12. two critical invariant violations eliminate on safety regardless of every quality target being excellent (Haiku's exact situation)", () => {
    const score = buildScoreV2Fixture({ criticalViolations: 2, passesCriticalGate: false });
    const evaluation: CandidateEvaluationV2 = evaluateCandidateV2(score);
    expect(evaluation.status).toBe("eliminated_critical_safety");
    expect(evaluation.isStage1Finalist).toBe(false);
    expect(evaluation.eliminationReasons.join(" ")).toMatch(/2 critical invariant violation/);
  });

  it("no evidence and invalidated candidates are never a finalist", () => {
    expect(evaluateCandidateV2(buildScoreV2Fixture({ hasEvidence: false })).status).toBe(
      "no_evidence",
    );
    const invalidated = buildScoreV2Fixture({});
    invalidated.invalidated_reason = "refusing to score: identity conflict";
    expect(evaluateCandidateV2(invalidated).status).toBe("eliminated_invalidated");
  });
});

describe("scoring-version identity (13, 14)", () => {
  it("13. v1 and v2 score artifacts are distinguishable by their own scoring_version stamp", () => {
    const cases = [
      messageCase("m1", { disposition: "positive", signals: [], evidence_strength: "strong" }),
    ];
    const prediction: MessageOutput = {
      disposition: "positive",
      signals: [],
      evidence_strength: "strong",
    };
    const results = [okResult("m1", "message", "c", prediction)];
    const v1 = scoreV1("c", cases, results);
    const v2 = scoreV2("c", cases, results);
    expect(v1.scoring_version).toBe(SCORING_VERSION_V1);
    expect(v2.scoring_version).toBe(SCORING_VERSION_V2);
    expect(v1.scoring_version).not.toBe(v2.scoring_version);
  });

  it("14. rescoring under v2 never mutates inference identity (corpus/prompt/schema/model)", () => {
    const cases = [
      messageCase("m1", { disposition: "positive", signals: [], evidence_strength: "strong" }),
    ];
    const prediction: MessageOutput = {
      disposition: "positive",
      signals: [],
      evidence_strength: "strong",
    };
    const results = [okResult("m1", "message", "c", prediction)];
    const v1 = scoreV1("c", cases, results);
    const v2 = scoreV2("c", cases, results);
    expect(v2.corpus_version).toBe(v1.corpus_version);
    expect(v2.prompt_version).toBe(v1.prompt_version);
    expect(v2.schema_version).toBe(v1.schema_version);
    expect(v2.requested_model).toBe(v1.requested_model);
  });
});

// ---------------------------------------------------------------------------
// Stage-2 holdout-support preflight — locked contract, not exercised this round.
// ---------------------------------------------------------------------------

function syntheticHoldoutCases(dispositionCounts: Record<string, number>): CorpusCase[] {
  const cases: CorpusCase[] = [];
  let i = 0;
  for (const [disposition, count] of Object.entries(dispositionCounts)) {
    for (let k = 0; k < count; k += 1) {
      i += 1;
      cases.push(
        messageCase(`h-${i}`, {
          disposition: disposition as MessageOutput["disposition"],
          signals: ["interest"],
          evidence_strength: "moderate",
        }),
      );
    }
  }
  return cases;
}

describe("Stage-2 holdout-support preflight (15, 16)", () => {
  it("15. is a pure function of the corpus alone — it has no parameter through which a provider/model could be invoked, so it performs ZERO provider calls by construction", () => {
    const cases = syntheticHoldoutCases({
      positive: MIN_RELIABLE_CLASS_SUPPORT,
      negative: MIN_RELIABLE_CLASS_SUPPORT,
      neutral: MIN_RELIABLE_CLASS_SUPPORT,
      mixed: MIN_RELIABLE_CLASS_SUPPORT,
      ambiguous: MIN_RELIABLE_CLASS_SUPPORT,
    });
    // `holdoutSupportPreflight` takes exactly one argument: `readonly
    // CorpusCase[]`. There is no candidate/provider/API-key parameter for a
    // call to travel through, and the function is synchronous (no network
    // I/O is even possible inside it without an injected transport it never
    // receives).
    expect(holdoutSupportPreflight.length).toBe(1);
    const report = holdoutSupportPreflight(cases);
    expect(report).not.toBeInstanceOf(Promise);
    expect(report.resolvable.disposition_macro_f1).toBe(true);
  });

  it("16. blocks Stage 2 when a required target's holdout support cannot resolve it, and does not block when it can", () => {
    const insufficientHoldout = syntheticHoldoutCases({
      positive: 10,
      negative: 10,
      neutral: 10,
      mixed: 10,
      ambiguous: 1, // below MIN_RELIABLE_CLASS_SUPPORT
    });
    const report = holdoutSupportPreflight(insufficientHoldout);
    expect(report.resolvable.disposition_macro_f1).toBe(false);
    expect(report.disposition_insufficient_classes).toEqual(["ambiguous"]);

    const blocked = checkHoldoutCanResolve(report, ["disposition_macro_f1"]);
    expect(blocked.canResolve).toBe(false);
    expect(blocked.blockingTargets).toEqual(["disposition_macro_f1"]);

    const sufficientHoldout = syntheticHoldoutCases({
      positive: 10,
      negative: 10,
      neutral: 10,
      mixed: 10,
      ambiguous: MIN_RELIABLE_CLASS_SUPPORT,
    });
    const okReport = holdoutSupportPreflight(sufficientHoldout);
    const notBlocked = checkHoldoutCanResolve(okReport, ["disposition_macro_f1"]);
    expect(notBlocked.canResolve).toBe(true);
    expect(notBlocked.blockingTargets).toEqual([]);
  });

  it("a class the holdout never contains at all does not force insufficient_support (nothing to resolve)", () => {
    // `other_commercial`/`other` style classes: zero full support means the
    // class simply cannot occur in this selection, so it is not counted
    // against sufficiency (mirrors v1's `macro_f1_supported_classes` convention).
    const cases = syntheticHoldoutCases({ positive: 10, negative: 10, neutral: 10, mixed: 10 });
    const report = holdoutSupportPreflight(cases);
    expect(report.disposition_full_support.ambiguous ?? 0).toBe(0);
    expect(report.disposition_insufficient_classes).not.toContain("ambiguous");
    expect(report.resolvable.disposition_macro_f1).toBe(true);
  });
});

describe("cost accounting is unaffected by the scoring change (sanity)", () => {
  it("v2 reuses v1's untouched economics builder", () => {
    const cases = [
      messageCase("m1", { disposition: "positive", signals: [], evidence_strength: "strong" }),
    ];
    const prediction: MessageOutput = {
      disposition: "positive",
      signals: [],
      evidence_strength: "strong",
    };
    const results = [okResult("m1", "message", "c", prediction)];
    const v1 = scoreV1("c", cases, results);
    const v2 = scoreV2("c", cases, results);
    expect(v2.economics).toEqual(v1.economics);
    expect(
      estimateCaseCostUsd(PRICE, {
        inputTokens: 1000,
        outputTokens: 50,
        reasoningTokens: 10,
        cachedInputTokens: 0,
      }),
    ).toBeCloseTo(v2.economics.estimated_total_cost_usd ?? Number.NaN, 12);
  });
});
