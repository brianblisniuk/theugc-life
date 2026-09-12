/**
 * B07 benchmark — effective inference-configuration versioning (external
 * audit finding 13) and the corpus low-support coverage flag (external audit
 * corpus-coverage finding: `other_commercial` has a single primary gold
 * case).
 */
import { describe, expect, it } from "vitest";

import {
  INFERENCE_POLICY_VERSION,
  effectiveInferenceConfig,
  inferenceConfigDigest,
} from "../../scripts/b07-benchmark/config/inference-config";
import { taxonomyCoverage } from "../../scripts/b07-benchmark/corpus/load";
import {
  MIN_RELIABLE_CLASS_SUPPORT,
  scoreSingleLabel,
} from "../../scripts/b07-benchmark/scoring/metrics";
import { renderReport } from "../../scripts/b07-benchmark/report/render";
import type { CorpusStats } from "../../scripts/b07-benchmark/corpus/load";
import type { CandidateScore } from "../../scripts/b07-benchmark/scoring/score";

describe("effective inference configuration (finding 13)", () => {
  it("states an explicit, non-'not_supported' effort for every real provider, and 'not_supported' for local", () => {
    expect(effectiveInferenceConfig({ providerId: "openai" }, 512).reasoning_effort).toBe("medium");
    expect(effectiveInferenceConfig({ providerId: "anthropic" }, 512).reasoning_effort).toBe(
      "high",
    );
    expect(effectiveInferenceConfig({ providerId: "google" }, 512).reasoning_effort).toBe("medium");
    expect(effectiveInferenceConfig({ providerId: "local" }, 512).reasoning_effort).toBe(
      "not_supported",
    );
  });

  it("is versioned, and the version is stable across calls for the same provider", () => {
    const a = effectiveInferenceConfig({ providerId: "openai" }, 512);
    const b = effectiveInferenceConfig({ providerId: "openai" }, 512);
    expect(a.policy_version).toBe(INFERENCE_POLICY_VERSION);
    expect(a).toEqual(b);
    expect(inferenceConfigDigest(a)).toBe(inferenceConfigDigest(b));
  });

  it("digest differs across providers and across maxOutputTokens (a materially different setting)", () => {
    const openaiCfg = effectiveInferenceConfig({ providerId: "openai" }, 512);
    const anthropicCfg = effectiveInferenceConfig({ providerId: "anthropic" }, 512);
    expect(inferenceConfigDigest(openaiCfg)).not.toBe(inferenceConfigDigest(anthropicCfg));

    const smallerBudget = effectiveInferenceConfig({ providerId: "openai" }, 256);
    expect(inferenceConfigDigest(openaiCfg)).not.toBe(inferenceConfigDigest(smallerBudget));
  });
});

describe("corpus coverage audit: low-support classes are flagged, never manufactured away", () => {
  it("other_commercial has exactly the documented low support (single-digit)", () => {
    const coverage = taxonomyCoverage();
    expect(coverage.signals.other_commercial ?? 0).toBeLessThan(MIN_RELIABLE_CLASS_SUPPORT);
    expect(coverage.signals.other_commercial ?? 0).toBeGreaterThan(0);
  });

  it("the rendered report visibly flags a low-support per-class row rather than presenting it as reliable", () => {
    const stats: CorpusStats = {
      corpus_version: "v",
      total: 1,
      by_split: {},
      by_task: {},
      by_language: {},
      critical_suite_total: 0,
      critical_suite_by_split: {},
      adversarial_tag_counts: {},
      invariant_tag_counts: {},
      few_shot_case_ids: [],
    };
    const disposition = scoreSingleLabel(
      ["positive", "negative"],
      [
        { gold: "positive", predicted: "positive" },
        { gold: "negative", predicted: "positive" },
      ],
    );
    // `negative` has support 1 — below MIN_RELIABLE_CLASS_SUPPORT.
    expect(disposition.per_class.negative?.support).toBeLessThan(MIN_RELIABLE_CLASS_SUPPORT);

    const score: CandidateScore = {
      candidate_id: "c",
      provider_id: "openai",
      requested_model: "m",
      corpus_version: "v",
      prompt_version: "p",
      schema_version: "s",
      invalidated_reason: null,
      identity_conflicts: [],
      inference_config: null,
      reliability: {
        cases_selected: 2,
        cases_attempted: 2,
        cases_not_run_missing_key: 0,
        cases_unavailable: 0,
        first_pass_schema_valid: 2,
        first_pass_schema_valid_rate: 1,
        retries_used: 0,
        retry_rate: 0,
        final_schema_valid: 2,
        final_schema_valid_rate: 1,
        provider_errors: 0,
        provider_error_rate: 0,
        timeouts: 0,
        timeout_rate: 0,
        returned_models: ["m"],
      },
      critical_suite: {
        cases: 0,
        cases_evaluated: 0,
        cases_not_evaluated: 0,
        violations: 0,
        violations_by_invariant: {},
        violation_details: [],
        passes_hard_gate: false,
      },
      message_task: {
        n: 2,
        disposition,
        signals: {
          n: 0,
          exact_set_matches: 0,
          exact_set_accuracy: 0,
          empty_set_gold: 0,
          empty_set_correct: 0,
          micro: { tp: 0, fp: 0, fn: 0, precision: 0, recall: 0, f1: 0 },
          macro_f1: 0,
          macro_f1_supported_classes: 0,
          per_label: {},
          over_prediction_rate: 0,
          under_prediction_rate: 0,
          invalid_predictions: 0,
        },
        evidence_strength: disposition,
      },
      thread_task: null,
      latency: { n: 0, median_ms: null, p95_ms: null, min_ms: null, max_ms: null },
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

    const markdown = renderReport({
      runId: "r",
      stage: "screen",
      generatedAt: new Date().toISOString(),
      corpus: stats,
      scores: [score],
      absences: [],
    });
    expect(markdown).toContain("low support");
    expect(markdown).toMatch(/negative ⚠ low support/);
  });
});
