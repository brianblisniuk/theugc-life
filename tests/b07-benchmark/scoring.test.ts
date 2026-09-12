/**
 * B07 benchmark — scoring correctness.
 *
 * Acceptance tests covered here: 4 (canonicalisation is deterministic),
 * 5 (duplicate signals do not affect score), 6 (exact-set scoring),
 * 7 (macro/micro F1 are arithmetically correct), 8 (acceptable-answer sets),
 * 10 (unknown/unpaid confusion counted explicitly), plus the hostile-review
 * metric attacks: empty-set rewards, dominant-class masking, latency and cost
 * accounting.
 */
import { describe, expect, it } from "vitest";

import type { CorpusCase } from "../../scripts/b07-benchmark/corpus/schema";
import { estimateCaseCostUsd, type PriceBook } from "../../scripts/b07-benchmark/config/pricing";
import {
  scoreMultiLabel,
  scoreSingleLabel,
  summariseLatency,
} from "../../scripts/b07-benchmark/scoring/metrics";
import { scoreCandidate } from "../../scripts/b07-benchmark/scoring/score";
import { evaluateQualityTargets, decide } from "../../scripts/b07-benchmark/scoring/targets";
import type { CaseResult } from "../../scripts/b07-benchmark/run/types";
import { canonicalizeSignals, signalSetKey } from "../../scripts/b07-benchmark/taxonomy";
import type { MessageOutput, ThreadOutput } from "../../scripts/b07-benchmark/schema";

const PRICE: PriceBook = {
  candidate_id: "test",
  input_usd_per_mtok: 2,
  output_usd_per_mtok: 10,
  reasoning_usd_per_mtok: 10,
  reasoning_tokens_reported_separately: true,
  source: "test",
  source_url: "https://example.invalid/pricing",
  accessed_at: "2026-09-12",
  verification: "unverified_not_checked",
};

function messageCase(
  id: string,
  expected: MessageOutput,
  acceptable?: CorpusCase extends { task: "message" } ? never : Record<string, unknown>,
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

function threadCase(id: string, expected: ThreadOutput, critical: string[] = []): CorpusCase {
  return {
    case_id: id,
    split: "dev",
    task: "thread",
    language: "en",
    subject: "s",
    messages: [{ from: "target", text: "t" }],
    expected,
    adversarial_tags: [],
    critical_invariants: critical,
    gold_rationale: "test",
  } as unknown as CorpusCase;
}

function okResult(
  caseId: string,
  task: "message" | "thread",
  prediction: MessageOutput | ThreadOutput,
  overrides: Partial<CaseResult> = {},
): CaseResult {
  return {
    run_id: "r",
    candidate_id: "c",
    provider_id: "openai",
    requested_model: "m",
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
        usage: { input_tokens: 1000, output_tokens: 50, reasoning_tokens: 10 },
        returned_model: "m-2026",
      },
    ],
    first_pass_schema_valid: true,
    retry_used: false,
    final_schema_valid: true,
    prediction,
    total_latency_ms: 100,
    usage_totals: { input_tokens: 1000, output_tokens: 50, reasoning_tokens: 10 },
    evaluated_at: "2026-09-12T00:00:00.000Z",
    ...overrides,
  };
}

describe("signal canonicalisation", () => {
  it("4. is deterministic and vocabulary-ordered regardless of input order", () => {
    expect(canonicalizeSignals(["offer", "interest"])).toEqual(["interest", "offer"]);
    expect(canonicalizeSignals(["interest", "offer"])).toEqual(["interest", "offer"]);
    expect(canonicalizeSignals(["rejection", "interest", "redirect"])).toEqual([
      "interest",
      "redirect",
      "rejection",
    ]);
  });

  it("4b. drops values outside the D072 vocabulary rather than inventing a label", () => {
    expect(canonicalizeSignals(["interest", "enthusiasm", "won"])).toEqual(["interest"]);
  });

  it("5. duplicate signals do not change the canonical form or the key", () => {
    expect(canonicalizeSignals(["offer", "offer", "interest", "offer"])).toEqual([
      "interest",
      "offer",
    ]);
    expect(signalSetKey(["offer", "interest", "offer"])).toBe(signalSetKey(["interest", "offer"]));
  });
});

describe("single-label metrics", () => {
  it("7. computes precision, recall and F1 correctly on a worked example", () => {
    // gold: a a a b b | predicted: a a b b b
    const report = scoreSingleLabel(
      ["a", "b"],
      [
        { gold: "a", predicted: "a" },
        { gold: "a", predicted: "a" },
        { gold: "a", predicted: "b" },
        { gold: "b", predicted: "b" },
        { gold: "b", predicted: "b" },
      ],
    );
    expect(report.accuracy).toBe(0.8);
    // class a: tp=2 fp=0 fn=1 -> P=1, R=2/3, F1=0.8
    expect(report.per_class.a?.precision).toBe(1);
    expect(report.per_class.a?.recall).toBeCloseTo(0.6667, 3);
    expect(report.per_class.a?.f1).toBe(0.8);
    // class b: tp=2 fp=1 fn=0 -> P=2/3, R=1, F1=0.8
    expect(report.per_class.b?.precision).toBeCloseTo(0.6667, 3);
    expect(report.per_class.b?.recall).toBe(1);
    expect(report.per_class.b?.f1).toBe(0.8);
    expect(report.macro_f1).toBe(0.8);
  });

  it("7b. macro F1 over ALL classes exposes what supported-only macro F1 hides", () => {
    // A dominant class carried perfectly while a rare class is never predicted.
    const pairs = [
      ...Array.from({ length: 20 }, () => ({ gold: "common", predicted: "common" })),
      { gold: "rare", predicted: "common" },
    ];
    const report = scoreSingleLabel(["common", "rare", "never_seen"], pairs);
    expect(report.accuracy).toBeCloseTo(0.9524, 3);
    // Accuracy looks excellent; macro F1 does not — which is the point.
    expect(report.per_class.rare?.f1).toBe(0);
    expect(report.macro_f1).toBeLessThan(0.35);
    expect(report.macro_f1_supported_classes).toBeLessThan(0.55);
  });

  it("records an unparsable prediction as (invalid), never as a class", () => {
    const report = scoreSingleLabel(["a", "b"], [{ gold: "a", predicted: null }]);
    expect(report.confusion.a?.["(invalid)"]).toBe(1);
    expect(report.per_class.a?.true_positives).toBe(0);
    expect(report.accuracy).toBe(0);
  });
});

describe("multi-label signal metrics", () => {
  it("6. exact-set accuracy requires the whole set to match", () => {
    const report = scoreMultiLabel(
      ["interest", "offer", "redirect"],
      [
        { gold: ["interest", "offer"], predicted: ["interest", "offer"] },
        { gold: ["interest", "offer"], predicted: ["interest"] },
        { gold: ["interest"], predicted: ["interest", "offer"] },
      ],
    );
    expect(report.exact_set_matches).toBe(1);
    expect(report.exact_set_accuracy).toBeCloseTo(0.3333, 3);
  });

  it("6b. the empty gold set is scored, and an empty prediction against a non-empty gold is not rewarded", () => {
    const report = scoreMultiLabel(
      ["interest", "offer"],
      [
        { gold: [], predicted: [] },
        { gold: ["interest"], predicted: [] },
      ],
    );
    expect(report.empty_set_gold).toBe(1);
    expect(report.empty_set_correct).toBe(1);
    expect(report.exact_set_matches).toBe(1);
    expect(report.micro.fn).toBe(1);
    expect(report.under_prediction_rate).toBe(1);
    expect(report.over_prediction_rate).toBe(0);
  });

  it("7c. micro F1 is arithmetically correct", () => {
    const report = scoreMultiLabel(
      ["a", "b", "c"],
      [
        { gold: ["a", "b"], predicted: ["a", "c"] },
        { gold: ["b"], predicted: ["b"] },
      ],
    );
    // tp = a, b -> 2 ; fp = c -> 1 ; fn = b(first case) -> 1
    expect(report.micro.tp).toBe(2);
    expect(report.micro.fp).toBe(1);
    expect(report.micro.fn).toBe(1);
    expect(report.micro.precision).toBeCloseTo(0.6667, 3);
    expect(report.micro.recall).toBeCloseTo(0.6667, 3);
    expect(report.micro.f1).toBeCloseTo(0.6667, 3);
    expect(report.over_prediction_rate).toBeCloseTo(0.3333, 3);
    expect(report.under_prediction_rate).toBeCloseTo(0.3333, 3);
  });

  it("counts an invalid prediction as all false negatives, not as an empty-set success", () => {
    const report = scoreMultiLabel(["a"], [{ gold: ["a"], predicted: null }]);
    expect(report.invalid_predictions).toBe(1);
    expect(report.exact_set_matches).toBe(0);
    expect(report.micro.fn).toBe(1);
  });
});

describe("PASS C: result-stream normalisation", () => {
  const cases = [
    messageCase("m1", { disposition: "positive", signals: [], evidence_strength: "strong" }),
  ];
  const prediction: MessageOutput = {
    disposition: "positive",
    signals: [],
    evidence_strength: "strong",
  };
  const score = (results: CaseResult[]) =>
    scoreCandidate({
      candidateId: "c",
      providerId: "openai",
      requestedModel: "m",
      corpusVersion: "v",
      promptVersion: "p",
      schemaVersion: "s",
      cases,
      results,
      priceBook: PRICE,
    });

  it("14c. a resumed run's duplicate rows are counted once, not twice", () => {
    // A resumed run re-runs non-terminal work and appends it, so results.jsonl
    // can hold two rows for one candidate/case pair. Counting both would
    // double-charge tokens and double-count reliability.
    const failed = okResult("m1", "message", prediction, {
      status: "provider_error",
      first_pass_schema_valid: false,
      final_schema_valid: false,
      prediction: null,
    });
    const settled = okResult("m1", "message", prediction);
    const single = score([settled]);
    const withDuplicate = score([failed, settled]);
    expect(withDuplicate.economics.total_input_tokens).toBe(single.economics.total_input_tokens);
    expect(withDuplicate.reliability.cases_attempted).toBe(1);
    expect(withDuplicate.reliability.provider_errors).toBe(0);
    expect(withDuplicate.latency.n).toBe(1);
  });

  it("15b. a row from a different prompt/schema/corpus version is dropped, never mixed in", () => {
    const stale = okResult("m1", "message", prediction, { prompt_version: "p-OLD" });
    const result = score([stale]);
    expect(result.reliability.cases_attempted).toBe(0);
    expect(result.economics.total_input_tokens).toBe(0);
  });

  it("a row for a case outside the current selection is dropped", () => {
    const other = okResult("m-not-selected", "message", prediction);
    const result = score([other, okResult("m1", "message", prediction)]);
    expect(result.reliability.cases_attempted).toBe(1);
    expect(result.economics.cases_priced).toBe(1);
  });

  it("a row belonging to a different candidate is dropped", () => {
    const foreign = okResult("m1", "message", prediction, { candidate_id: "someone-else" });
    expect(score([foreign]).reliability.cases_attempted).toBe(0);
  });
});

describe("acceptable-answer-set scoring", () => {
  it("8. an answer inside the acceptable set is scored correct, for every field", () => {
    const cases: CorpusCase[] = [
      messageCase("m1", {
        disposition: "mixed",
        signals: ["timing_constraint"],
        evidence_strength: "moderate",
      }),
    ];
    // Declare `neutral` acceptable alongside the primary `mixed`.
    (cases[0] as unknown as { acceptable: unknown }).acceptable = {
      disposition: ["mixed", "neutral"],
      signals: [["timing_constraint"], ["timing_constraint", "interest"]],
    };
    const score = scoreCandidate({
      candidateId: "c",
      providerId: "openai",
      requestedModel: "m",
      corpusVersion: "v",
      promptVersion: "p",
      schemaVersion: "s",
      cases,
      results: [
        okResult("m1", "message", {
          disposition: "neutral",
          signals: ["timing_constraint", "interest"],
          evidence_strength: "moderate",
        }),
      ],
      priceBook: PRICE,
    });
    expect(score.message_task?.disposition.accuracy).toBe(1);
    expect(score.message_task?.signals.exact_set_accuracy).toBe(1);
  });

  it("8b. an answer OUTSIDE the acceptable set is still scored wrong", () => {
    const cases: CorpusCase[] = [
      messageCase("m1", {
        disposition: "mixed",
        signals: ["timing_constraint"],
        evidence_strength: "moderate",
      }),
    ];
    (cases[0] as unknown as { acceptable: unknown }).acceptable = {
      disposition: ["mixed", "neutral"],
    };
    const score = scoreCandidate({
      candidateId: "c",
      providerId: "openai",
      requestedModel: "m",
      corpusVersion: "v",
      promptVersion: "p",
      schemaVersion: "s",
      cases,
      results: [
        okResult("m1", "message", {
          disposition: "positive",
          signals: ["timing_constraint"],
          evidence_strength: "moderate",
        }),
      ],
      priceBook: PRICE,
    });
    expect(score.message_task?.disposition.accuracy).toBe(0);
  });
});

describe("thread scoring and the unknown/unpaid boundary", () => {
  it("10. unknown predicted as unpaid is counted explicitly and separately", () => {
    const cases = [
      threadCase(
        "t1",
        {
          thread_state: "engaged",
          compensation_structure: "unknown",
          evidence_strength: "moderate",
        },
        ["unknown_not_unpaid"],
      ),
      threadCase("t2", {
        thread_state: "engaged",
        compensation_structure: "unpaid",
        evidence_strength: "strong",
      }),
    ];
    const score = scoreCandidate({
      candidateId: "c",
      providerId: "openai",
      requestedModel: "m",
      corpusVersion: "v",
      promptVersion: "p",
      schemaVersion: "s",
      cases,
      results: [
        okResult("t1", "thread", {
          thread_state: "engaged",
          compensation_structure: "unpaid",
          evidence_strength: "moderate",
        }),
        okResult("t2", "thread", {
          thread_state: "engaged",
          compensation_structure: "unknown",
          evidence_strength: "strong",
        }),
      ],
      priceBook: PRICE,
    });
    expect(score.thread_task?.unknown_predicted_as_unpaid).toBe(1);
    expect(score.thread_task?.unpaid_predicted_as_unknown).toBe(1);
    // And the collapse is a HARD GATE failure, not just a metric.
    expect(score.critical_suite.violations).toBe(1);
    expect(score.critical_suite.passes_hard_gate).toBe(false);
    expect(evaluateQualityTargets(score).meetsAll).toBe(false);
  });

  it("9b. silence is not safety: a candidate that produced no prediction cannot clear the gate", () => {
    const cases = [
      threadCase(
        "t1",
        {
          thread_state: "engaged",
          compensation_structure: "unknown",
          evidence_strength: "moderate",
        },
        ["unknown_not_unpaid"],
      ),
    ];
    const score = scoreCandidate({
      candidateId: "c",
      providerId: "openai",
      requestedModel: "m",
      corpusVersion: "v",
      promptVersion: "p",
      schemaVersion: "s",
      cases,
      results: [
        okResult(
          "t1",
          "thread",
          {
            thread_state: "engaged",
            compensation_structure: "unknown",
            evidence_strength: "moderate",
          },
          {
            status: "provider_error",
            final_schema_valid: false,
            first_pass_schema_valid: false,
            prediction: null,
          },
        ),
      ],
      priceBook: PRICE,
    });
    expect(score.critical_suite.violations).toBe(0);
    expect(score.critical_suite.cases_not_evaluated).toBe(1);
    expect(score.critical_suite.passes_hard_gate).toBe(false);
  });
});

describe("latency and cost accounting", () => {
  it("latency covers successful calls only and states how many that was", () => {
    const summary = summariseLatency([100, 200, 300, 400, 5000]);
    expect(summary.n).toBe(5);
    expect(summary.median_ms).toBe(300);
    expect(summary.p95_ms).toBe(5000);
    expect(summariseLatency([]).median_ms).toBeNull();
  });

  it("cost includes failed attempts and retries, and reasoning tokens are never dropped", () => {
    const cases = [
      messageCase("m1", { disposition: "positive", signals: [], evidence_strength: "strong" }),
    ];
    const twoAttempts = okResult("m1", "message", {
      disposition: "positive",
      signals: [],
      evidence_strength: "strong",
    });
    twoAttempts.attempts = [
      {
        index: 1,
        kind: "initial",
        outcome: "schema_invalid",
        http_status: 200,
        error_summary: "bad",
        latency_ms: 120,
        usage: { input_tokens: 1000, output_tokens: 40, reasoning_tokens: 500 },
        returned_model: "m-2026",
      },
      {
        index: 2,
        kind: "schema_retry",
        outcome: "schema_valid",
        http_status: 200,
        error_summary: null,
        latency_ms: 130,
        usage: { input_tokens: 1100, output_tokens: 30, reasoning_tokens: 200 },
        returned_model: "m-2026",
      },
    ];
    twoAttempts.retry_used = true;
    twoAttempts.first_pass_schema_valid = false;

    const score = scoreCandidate({
      candidateId: "c",
      providerId: "openai",
      requestedModel: "m",
      corpusVersion: "v",
      promptVersion: "p",
      schemaVersion: "s",
      cases,
      results: [twoAttempts],
      priceBook: PRICE,
    });
    expect(score.economics.total_input_tokens).toBe(2100);
    expect(score.economics.total_output_tokens).toBe(70);
    expect(score.economics.total_reasoning_tokens).toBe(700);
    expect(score.economics.estimated_total_cost_usd).toBeCloseTo(
      estimateCaseCostUsd(PRICE, { inputTokens: 2100, outputTokens: 70, reasoningTokens: 700 }),
      12,
    );
    expect(score.economics.pricing_basis).toBe("estimated_from_published_prices");
    expect(score.economics.price_accessed_at).toBe("2026-09-12");
    expect(score.reliability.first_pass_schema_valid_rate).toBe(0);
    expect(score.reliability.retry_rate).toBe(1);
    expect(score.reliability.final_schema_valid_rate).toBe(1);
  });

  it("does not charge reasoning tokens twice when the provider folds them into output", () => {
    const folded: PriceBook = { ...PRICE, reasoning_tokens_reported_separately: false };
    expect(
      estimateCaseCostUsd(folded, { inputTokens: 0, outputTokens: 100, reasoningTokens: 900 }),
    ).toBeCloseTo(
      estimateCaseCostUsd(folded, { inputTokens: 0, outputTokens: 100, reasoningTokens: 0 }),
      12,
    );
  });

  it("reports no cost at all rather than a fabricated one when pricing is absent", () => {
    const cases = [
      messageCase("m1", { disposition: "positive", signals: [], evidence_strength: "strong" }),
    ];
    const score = scoreCandidate({
      candidateId: "c",
      providerId: "openai",
      requestedModel: "m",
      corpusVersion: "v",
      promptVersion: "p",
      schemaVersion: "s",
      cases,
      results: [
        okResult("m1", "message", {
          disposition: "positive",
          signals: [],
          evidence_strength: "strong",
        }),
      ],
      priceBook: null,
    });
    expect(score.economics.pricing_basis).toBe("no_pricing_metadata");
    expect(score.economics.estimated_total_cost_usd).toBeNull();
  });
});

describe("decision method", () => {
  const perfectCases = [
    threadCase(
      "t1",
      {
        thread_state: "engaged",
        compensation_structure: "unknown",
        evidence_strength: "moderate",
      },
      ["unknown_not_unpaid"],
    ),
  ];
  const perfectResults = [
    okResult("t1", "thread", {
      thread_state: "engaged",
      compensation_structure: "unknown",
      evidence_strength: "moderate",
    }),
  ];
  const score = (candidateId: string) =>
    scoreCandidate({
      candidateId,
      providerId: "openai",
      requestedModel: "m",
      corpusVersion: "v",
      promptVersion: "p",
      schemaVersion: "s",
      cases: perfectCases,
      results: perfectResults.map((r) => ({ ...r, candidate_id: candidateId })),
      priceBook: PRICE,
    });

  it("never nominates the benchmark baseline", () => {
    const decision = decide([score("benchmark-rules-baseline")], "benchmark-rules-baseline");
    expect(decision.outcome).toBe("external_runs_pending");
    expect(decision.qualified).toEqual([]);
  });

  it("returns no_production_winner_yet rather than a least-bad nomination", () => {
    const failing = scoreCandidate({
      candidateId: "weak",
      providerId: "openai",
      requestedModel: "m",
      corpusVersion: "v",
      promptVersion: "p",
      schemaVersion: "s",
      cases: perfectCases,
      results: [
        okResult(
          "t1",
          "thread",
          {
            thread_state: "engaged",
            compensation_structure: "unpaid",
            evidence_strength: "moderate",
          },
          { candidate_id: "weak" },
        ),
      ],
      priceBook: PRICE,
    });
    const decision = decide([failing], "benchmark-rules-baseline");
    expect(decision.outcome).toBe("no_production_winner_yet");
    expect(decision.qualified).toEqual([]);
  });

  it("reports external_runs_pending when nothing was actually called", () => {
    const notRun = scoreCandidate({
      candidateId: "openai-x",
      providerId: "openai",
      requestedModel: "m",
      corpusVersion: "v",
      promptVersion: "p",
      schemaVersion: "s",
      cases: perfectCases,
      results: [
        okResult(
          "t1",
          "thread",
          {
            thread_state: "engaged",
            compensation_structure: "unknown",
            evidence_strength: "moderate",
          },
          {
            candidate_id: "openai-x",
            status: "not_run_missing_key",
            attempts: [],
            prediction: null,
            final_schema_valid: false,
            first_pass_schema_valid: false,
          },
        ),
      ],
      priceBook: PRICE,
    });
    expect(notRun.reliability.cases_attempted).toBe(0);
    expect(notRun.reliability.cases_not_run_missing_key).toBe(1);
    expect(evaluateQualityTargets(notRun).hasEvidence).toBe(false);
    expect(decide([notRun], "benchmark-rules-baseline").outcome).toBe("external_runs_pending");
  });
});
