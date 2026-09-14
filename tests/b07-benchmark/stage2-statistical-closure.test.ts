/**
 * B07 benchmark — Stage-2 statistical closure round.
 *
 * Covers this round's two deliverables and its explicit attack list:
 *  (a) the corrected signal micro-F1 sufficiency rule (macro-vs-micro
 *      confusion the external audit flagged is fixed in `targets-v2.ts`);
 *  (b) the frozen `b07_disposition_ambiguity_support_v1` supplemental blind
 *      ambiguity support pack, its freeze/versioning, and the Stage-2
 *      preflight v2 that combines it with the immutable 120-case holdout.
 *
 * Numbers in test names/comments below refer to the round's own numbered
 * acceptance-test list (1-20). No provider/model is called anywhere in this
 * file — every test either uses only pure corpus/pack arithmetic, or stubs
 * `fetch` to throw so an accidental provider call fails loudly.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  FIXTURE_FILES,
  fixtureDir,
  loadCorpus,
  selectCases,
} from "../../scripts/b07-benchmark/corpus/load";
import { CORPUS_VERSION } from "../../scripts/b07-benchmark/corpus/schema";
import {
  loadSupplementalAmbiguityPack,
  SUPPLEMENTAL_PACK_CREATED_AT,
  SUPPLEMENTAL_PACK_DECLARATION,
  SUPPLEMENTAL_PACK_LANGUAGE_TARGET,
  SUPPLEMENTAL_PACK_SIZE,
  SUPPLEMENTAL_PACK_VERSION,
  supplementalPackManifest,
} from "../../scripts/b07-benchmark/corpus/supplemental-ambiguity-pack";
import { PROMPT_VERSION } from "../../scripts/b07-benchmark/prompt/render";
import {
  combineConfusionRecords,
  MIN_RELIABLE_CLASS_SUPPORT,
} from "../../scripts/b07-benchmark/scoring/metrics";
import { scoreCandidateV2 } from "../../scripts/b07-benchmark/scoring/score-v2";
import { QUALITY_TARGETS } from "../../scripts/b07-benchmark/scoring/targets";
import {
  checkHoldoutCanResolve,
  evaluateCandidateV2,
  evaluateStage2DispositionMacroF1Target,
  holdoutSupportPreflight,
} from "../../scripts/b07-benchmark/scoring/targets-v2";
import type { CaseResult } from "../../scripts/b07-benchmark/run/types";
import { DISPOSITIONS, SIGNALS } from "../../scripts/b07-benchmark/taxonomy";

/** A fetch stub that fails the test if a real provider call were ever attempted. */
function fetchMustNotBeCalled() {
  return vi.fn().mockImplementation(() => {
    throw new Error("TEST FAILURE: a provider fetch call was made when none should have happened");
  });
}

// ---------------------------------------------------------------------------
// PASS A pre-mortem, reproduced as tests: the exact holdout numbers this
// round's correction and pack are built against.
// ---------------------------------------------------------------------------

describe("PASS A pre-mortem: reproduces the exact holdout numbers this round is built against", () => {
  it("main holdout strict disposition support: positive/negative/neutral/mixed >= 3, ambiguous == 0", () => {
    const preflight = holdoutSupportPreflight(selectCases({ split: "holdout" }), []);
    expect(preflight.disposition_strict_support.positive ?? 0).toBeGreaterThanOrEqual(3);
    expect(preflight.disposition_strict_support.negative ?? 0).toBeGreaterThanOrEqual(3);
    expect(preflight.disposition_strict_support.neutral ?? 0).toBeGreaterThanOrEqual(3);
    expect(preflight.disposition_strict_support.mixed ?? 0).toBeGreaterThanOrEqual(3);
    expect(preflight.disposition_strict_support.ambiguous ?? 0).toBe(0);
    // Which is exactly why, main-holdout-only, disposition macro F1 is unresolvable.
    expect(preflight.disposition_insufficient_classes).toEqual(["ambiguous"]);
    expect(preflight.resolvable.disposition_macro_f1).toBe(false);
  });

  it("main holdout has signal labels with full support but zero strict support (the OLD rule's false block)", () => {
    const preflight = holdoutSupportPreflight(selectCases({ split: "holdout" }), []);
    expect(preflight.signals_zero_strict_support_labels.length).toBeGreaterThan(0);
    for (const label of preflight.signals_zero_strict_support_labels) {
      expect(preflight.signals_full_support[label] ?? 0).toBeGreaterThan(0);
      expect(preflight.signals_strict_support[label] ?? 0).toBe(0);
    }
    // Yet the corrected rule finds this holdout resolvable: an evaluable
    // strict set with real label decisions exists regardless.
    expect(preflight.signals_strict_n).toBeGreaterThan(0);
    expect(preflight.signals_strict_label_decisions).toBeGreaterThan(0);
    expect(preflight.resolvable.signal_micro_f1).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1-6: macro vs micro sufficiency, thresholds, and the empty/rare-label
// attack cases.
// ---------------------------------------------------------------------------

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

function perfectResultFor(
  c: ReturnType<typeof selectCases>[number],
  candidateId: string,
  overridePrediction?: Partial<{ signals: string[] }>,
): CaseResult {
  const base =
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
  const prediction =
    c.task === "message" && overridePrediction?.signals
      ? { ...base, signals: overridePrediction.signals }
      : base;
  return {
    run_id: "r",
    candidate_id: candidateId,
    provider_id: "openai",
    requested_model: "m",
    inference_config: TEST_INFERENCE_CONFIG,
    inference_config_digest: "test-config-digest",
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
        latency_ms: 50,
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
    prediction: prediction as CaseResult["prediction"],
    total_latency_ms: 50,
    usage_totals: {
      input_tokens: 100,
      output_tokens: 20,
      reasoning_tokens: 0,
      cached_input_tokens: 0,
    },
    evaluated_at: "2026-09-13T00:00:00.000Z",
  };
}

describe("1-6: corrected signal micro-F1 sufficiency vs. unchanged disposition macro-F1 sufficiency", () => {
  it("1. disposition macro F1 STILL requires per-class minimum strict support (unaffected by this round's correction)", () => {
    const cases = selectCases({ split: "holdout" });
    const results = cases.map((c) => perfectResultFor(c, "x"));
    const score = scoreCandidateV2({
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
    const evaluation = evaluateCandidateV2(score);
    const target = evaluation.targets.find((t) => t.key === "disposition_macro_f1");
    // Perfect predictions everywhere, yet the target is STILL not a hard
    // PASS: main-holdout-alone strict `ambiguous` support is 0.
    expect(target?.state).toBe("insufficient_support");
  });

  it("2. signal micro F1 does NOT require every label to individually clear MIN_RELIABLE_CLASS_SUPPORT", () => {
    const cases = selectCases({ split: "holdout" });
    const results = cases.map((c) => perfectResultFor(c, "x"));
    const score = scoreCandidateV2({
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
    // Real holdout has labels at strict support 0 despite full-corpus support > 0.
    const zeroSupportLabels = SIGNALS.filter(
      (l) =>
        (score.message_task?.signals_full_support[l] ?? 0) > 0 &&
        (score.message_task?.signals.strict.per_label[l]?.support ?? 0) === 0,
    );
    expect(zeroSupportLabels.length).toBeGreaterThan(0);

    const evaluation = evaluateCandidateV2(score);
    const target = evaluation.targets.find((t) => t.key === "signal_micro_f1");
    // Perfect predictions -> micro F1 == 1.0 -> PASS, not insufficient_support,
    // DESPITE the zero-strict-support labels above.
    expect(target?.state).toBe("pass");
    expect(target?.value).toBe(1);
  });

  it("3. signal micro F1 threshold is exactly 0.90, unchanged", () => {
    expect(QUALITY_TARGETS.signalMicroF1).toBe(0.9);
  });

  it("4. disposition macro F1 threshold is exactly 0.90, unchanged", () => {
    expect(QUALITY_TARGETS.dispositionMacroF1).toBe(0.9);
  });

  it("4b. MIN_RELIABLE_CLASS_SUPPORT (per-class/per-label floor for macro-style interpretation) is unchanged at 3", () => {
    expect(MIN_RELIABLE_CLASS_SUPPORT).toBe(3);
  });

  it("5. an empty strict signal-evaluation set cannot PASS — it is insufficient_support, never a fabricated pass", () => {
    // Two cases, BOTH declared multi-answer for signals -> strict n == 0.
    const cases: Parameters<typeof scoreCandidateV2>[0]["cases"] = [
      {
        case_id: "m-empty-strict-1",
        split: "dev",
        task: "message",
        language: "en",
        subject: "s",
        messages: [{ from: "target", text: "t" }],
        focus_index: 0,
        expected: { disposition: "positive", signals: ["interest"], evidence_strength: "strong" },
        acceptable: { signals: [["interest"], ["interest", "offer"]] },
        adversarial_tags: [],
        critical_invariants: [],
        gold_rationale: "test",
      },
      {
        case_id: "m-empty-strict-2",
        split: "dev",
        task: "message",
        language: "en",
        subject: "s",
        messages: [{ from: "target", text: "t" }],
        focus_index: 0,
        expected: { disposition: "negative", signals: ["rejection"], evidence_strength: "strong" },
        acceptable: { signals: [["rejection"], []] },
        adversarial_tags: [],
        critical_invariants: [],
        gold_rationale: "test",
      },
      // A third, critical-invariant-tagged case with a perfect (non-violating)
      // prediction — otherwise `buildCriticalSuite`'s hard gate requires
      // `suite.length > 0` and this synthetic corpus would fail it for
      // reasons unrelated to what this test is actually checking.
      {
        case_id: "m-critical-neutral",
        split: "dev",
        task: "message",
        language: "en",
        subject: "s",
        messages: [{ from: "target", text: "t" }],
        focus_index: 0,
        expected: { disposition: "neutral", signals: [], evidence_strength: "weak" },
        acceptable: { signals: [[], ["request_information"]] },
        adversarial_tags: [],
        critical_invariants: ["politeness_not_positive"],
        gold_rationale: "test",
      },
    ];
    const results = cases.map((c) => perfectResultFor(c, "x"));
    const score = scoreCandidateV2({
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
    expect(score.message_task?.signals.strict.n).toBe(0);
    const evaluation = evaluateCandidateV2(score);
    const target = evaluation.targets.find((t) => t.key === "signal_micro_f1");
    expect(target?.state).toBe("insufficient_support");
  });

  it("6. a populated strict signal set with a rare/zero-support label can still PASS or FAIL purely on the global micro F1 value", () => {
    const cases = selectCases({ split: "holdout" });
    const perfect = cases.map((c) => perfectResultFor(c, "x"));
    const passScore = scoreCandidateV2({
      candidateId: "x",
      providerId: "openai",
      requestedModel: "m",
      corpusVersion: "v",
      promptVersion: "p",
      schemaVersion: "s",
      cases,
      results: perfect,
      priceBook: null,
    });
    const passTarget = evaluateCandidateV2(passScore).targets.find(
      (t) => t.key === "signal_micro_f1",
    );
    expect(passTarget?.state).toBe("pass");

    // Always predict an EMPTY signal set (never over-claims, so no critical
    // invariant fires) while keeping disposition/evidence_strength correct —
    // this drives recall, and therefore micro F1, toward 0 on any case with
    // non-empty gold signals, without touching disposition sufficiency.
    const degraded = cases.map((c) => perfectResultFor(c, "x", { signals: [] }));
    const failScore = scoreCandidateV2({
      candidateId: "x",
      providerId: "openai",
      requestedModel: "m",
      corpusVersion: "v",
      promptVersion: "p",
      schemaVersion: "s",
      cases,
      results: degraded,
      priceBook: null,
    });
    const failEvaluation = evaluateCandidateV2(failScore);
    const failTarget = failEvaluation.targets.find((t) => t.key === "signal_micro_f1");
    // The SAME rare/zero-support-label situation is present in both scores
    // (it's corpus-derived, identical either way) — only the global F1 value
    // decided the verdict, never an individual label's thin support.
    expect(failTarget?.state).toBe("fail");
    expect(failTarget?.value ?? 1).toBeLessThan(0.9);
  });
});

// ---------------------------------------------------------------------------
// 7-10: the six supplemental cases themselves.
// ---------------------------------------------------------------------------

describe("7-10: the six b07_disposition_ambiguity_support_v1 cases", () => {
  const pack = loadSupplementalAmbiguityPack();

  it(`pack has exactly ${SUPPLEMENTAL_PACK_SIZE} cases`, () => {
    expect(pack.length).toBe(SUPPLEMENTAL_PACK_SIZE);
  });

  it("7. every case is strict ambiguous (expected.disposition === 'ambiguous', literal at the type level)", () => {
    for (const c of pack) {
      expect(c.expected.disposition).toBe("ambiguous");
    }
  });

  it("8. none has an alternative disposition — structurally impossible, not just editorially avoided", () => {
    for (const c of pack) {
      // `supplementalAcceptableZod` has NO `disposition` key at all, so this
      // is not merely "the field happens to be absent" — the schema forbids
      // it from ever validly appearing.
      expect(c.acceptable === undefined || !("disposition" in c.acceptable)).toBe(true);
    }
  });

  it("9. language distribution is exactly 3 EN / 2 ES / 1 PT-or-FR", () => {
    const byLanguage: Record<string, number> = {};
    for (const c of pack) byLanguage[c.language] = (byLanguage[c.language] ?? 0) + 1;
    expect(byLanguage.en ?? 0).toBe(3);
    expect(byLanguage.es ?? 0).toBe(2);
    expect((byLanguage.pt ?? 0) + (byLanguage.fr ?? 0)).toBe(1);
    expect(SUPPLEMENTAL_PACK_LANGUAGE_TARGET).toEqual({ en: 3, es: 2, pt: 1, fr: 0 });
  });

  it("10. the six cases are semantically/materially distinct, not translation clones", () => {
    const focusTexts = pack.map((c) => c.messages[c.focus_index]?.text ?? "");
    expect(new Set(focusTexts).size).toBe(pack.length);
    const subjects = pack.map((c) => c.subject);
    expect(new Set(subjects).size).toBe(pack.length);
    // No two cases share an identical adversarial-tag set (a crude but
    // effective proxy for "different evidentiary mechanism").
    const tagSets = pack.map((c) => [...c.adversarial_tags].sort().join("|"));
    expect(new Set(tagSets).size).toBe(pack.length);
  });

  it("each case carries the explicit supplemental_blind_support marker and a D072-tied rationale", () => {
    for (const c of pack) {
      expect(c.supplemental_blind_support).toBe(true);
      expect(c.pack_version).toBe(SUPPLEMENTAL_PACK_VERSION);
      expect(c.gold_rationale.length).toBeGreaterThan(0);
      expect(c.gold_rationale).toMatch(/D072/);
    }
  });
});

// ---------------------------------------------------------------------------
// 11: original holdout immutability (byte-identical, hash-pinned).
// ---------------------------------------------------------------------------

describe("11. original 120-case frozen holdout fixtures are byte-identical to the pre-round content", () => {
  // Hashes computed from the fixture files as they stood at the START of
  // this round (before ANY edit in this round), and hardcoded here as a
  // durable regression guard: this test fails the instant either v2 fixture
  // file changes by even one byte, in any future round.
  const EXPECTED_SHA256: Record<string, string> = {
    "b07_gold_corpus_v2_message.jsonl":
      "c7149ce55a24e40ce51367196135bccf44dbb5ac3a876aae3fd5f4bd235f42b0",
    "b07_gold_corpus_v2_thread.jsonl":
      "97c731f35a329ddeab2bc7a553962ffd15266b6fb08437d746a027e799721800",
  };

  it("FIXTURE_FILES still names exactly the two v2 files this round must not touch", () => {
    expect([...FIXTURE_FILES]).toEqual([
      "b07_gold_corpus_v2_message.jsonl",
      "b07_gold_corpus_v2_thread.jsonl",
    ]);
  });

  for (const file of FIXTURE_FILES) {
    it(`${file} sha256 is unchanged`, () => {
      const buf = readFileSync(resolve(fixtureDir(), file));
      const hash = createHash("sha256").update(buf).digest("hex");
      expect(hash).toBe(EXPECTED_SHA256[file]);
    });
  }

  it("the main corpus loader still reports exactly 180 cases / 120 holdout (72 message + 48 thread)", () => {
    const all = loadCorpus();
    expect(all.length).toBe(180);
    expect(all.filter((c) => c.split === "holdout").length).toBe(120);
    expect(all.filter((c) => c.split === "holdout" && c.task === "message").length).toBe(72);
    expect(all.filter((c) => c.split === "holdout" && c.task === "thread").length).toBe(48);
  });
});

// ---------------------------------------------------------------------------
// 12-13: pack version/digest, and Stage-2 report identity binding.
// ---------------------------------------------------------------------------

describe("12-13. pack freeze/versioning and Stage-2 report-identity binding", () => {
  it("12. the pack has its own version and a deterministic digest, distinct from CORPUS_VERSION", () => {
    const manifest = supplementalPackManifest();
    expect(manifest.pack_version).toBe(SUPPLEMENTAL_PACK_VERSION);
    expect(manifest.pack_version).not.toBe(CORPUS_VERSION);
    expect(manifest.digest).toEqual(expect.any(String));
    expect(manifest.digest.length).toBeGreaterThan(0);
    expect(manifest.created_at).toBe(SUPPLEMENTAL_PACK_CREATED_AT);
    expect(manifest.declaration).toBe(SUPPLEMENTAL_PACK_DECLARATION);
    // Determinism: two independent computations over the same frozen file
    // produce the identical digest.
    expect(supplementalPackManifest().digest).toBe(manifest.digest);
  });

  it("13. the Stage-2 preflight report binds the pack's version AND digest, not just a name", () => {
    const preflight = holdoutSupportPreflight(selectCases({ split: "holdout" }));
    const manifest = supplementalPackManifest();
    expect(preflight.supplemental_pack.pack_version).toBe(manifest.pack_version);
    expect(preflight.supplemental_pack.digest).toBe(manifest.digest);
    expect(preflight.supplemental_pack.case_ids).toEqual(manifest.case_ids);
  });
});

// ---------------------------------------------------------------------------
// 14-15: holdout+pack preflight arithmetic, and zero-provider-call proof.
// ---------------------------------------------------------------------------

describe("14-15. holdout + pack preflight", () => {
  it("14. holdout+pack preflight yields ambiguous strict support >= 3, and every disposition class is sufficient", () => {
    const preflight = holdoutSupportPreflight(selectCases({ split: "holdout" }));
    for (const cls of DISPOSITIONS) {
      expect(preflight.disposition_support_completed[cls] ?? 0).toBeGreaterThanOrEqual(
        MIN_RELIABLE_CLASS_SUPPORT,
      );
    }
    expect(preflight.disposition_insufficient_classes).toEqual([]);
    expect(preflight.resolvable.disposition_macro_f1).toBe(true);
  });

  it("15. the preflight is a pure function of corpus+pack metadata alone — zero provider calls by construction", () => {
    // `holdoutSupportPreflight`'s only REQUIRED parameter is `cases`; the
    // second is a metadata array with a synchronous, file-read-only default.
    expect(holdoutSupportPreflight.length).toBe(1);
    vi.stubGlobal("fetch", fetchMustNotBeCalled());
    try {
      const report = holdoutSupportPreflight(selectCases({ split: "holdout" }));
      expect(report).not.toBeInstanceOf(Promise);
      loadSupplementalAmbiguityPack();
      supplementalPackManifest();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ---------------------------------------------------------------------------
// 16-17: the pack can never silently enter thread/compensation/main-accuracy
// metrics.
// ---------------------------------------------------------------------------

describe("16-17. the supplemental pack cannot silently enter any main-holdout metric", () => {
  it("16. every supplemental case is task 'message' — structurally impossible for one to enter thread-state/compensation scoring", () => {
    for (const c of loadSupplementalAmbiguityPack()) {
      expect(c.task).toBe("message");
    }
  });

  it("17. no supplemental case id appears anywhere in the main corpus loader's output (never enters main-holdout acceptable-answer accuracy)", () => {
    const mainIds = new Set(selectCases({}).map((c) => c.case_id));
    const packIds = loadSupplementalAmbiguityPack().map((c) => c.case_id);
    for (const id of packIds) expect(mainIds.has(id)).toBe(false);
    // And the reverse: the main loader's own fixture list is untouched.
    expect([...FIXTURE_FILES]).not.toContain("b07_disposition_ambiguity_support_v1.jsonl");
  });

  it("distribution contamination: adding the supplemental pack to the preflight call changes ONLY disposition_support_completed, never signals or n_message/n_thread", () => {
    const cases = selectCases({ split: "holdout" });
    const withoutPack = holdoutSupportPreflight(cases, []);
    const withPack = holdoutSupportPreflight(cases);
    expect(withPack.n_message).toBe(withoutPack.n_message);
    expect(withPack.n_thread).toBe(withoutPack.n_thread);
    expect(withPack.disposition_full_support).toEqual(withoutPack.disposition_full_support);
    expect(withPack.disposition_strict_support).toEqual(withoutPack.disposition_strict_support);
    expect(withPack.signals_full_support).toEqual(withoutPack.signals_full_support);
    expect(withPack.signals_strict_support).toEqual(withoutPack.signals_strict_support);
    expect(withPack.signals_strict_n).toBe(withoutPack.signals_strict_n);
    expect(withPack.resolvable.signal_micro_f1).toBe(withoutPack.resolvable.signal_micro_f1);
    // Only disposition support-completed / resolvability may differ.
    expect(withPack.disposition_support_completed).not.toEqual(
      withoutPack.disposition_support_completed,
    );
  });
});

// ---------------------------------------------------------------------------
// 18-20: cross-provider fairness, and "no other change occurred" proofs.
// ---------------------------------------------------------------------------

describe("18-20. cross-provider fairness and scope discipline", () => {
  it("18. the pack loader takes no candidate/provider parameter — every future finalist necessarily gets the identical frozen cases", () => {
    expect(loadSupplementalAmbiguityPack.length).toBe(0);
    const first = loadSupplementalAmbiguityPack();
    const second = loadSupplementalAmbiguityPack();
    expect(first).toEqual(second);
  });

  it("provider neutrality: no Anthropic/Sonnet/candidate identifier appears anywhere in the pack's own content", () => {
    const raw = readFileSync(
      resolve(fixtureDir(), "b07_disposition_ambiguity_support_v1.jsonl"),
      "utf8",
    ).toLowerCase();
    for (const forbidden of [
      "anthropic",
      "sonnet",
      "haiku",
      "claude",
      "openai",
      "gpt",
      "gemini",
      "google",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("19. prompt/corpus-v2 version identifiers are unchanged this round", () => {
    expect(PROMPT_VERSION).toBe("b07_benchmark_prompt_v2");
    expect(CORPUS_VERSION).toBe("b07_gold_corpus_v2");
  });

  it("20. every function this round added/changed is synchronous and makes zero provider calls", () => {
    vi.stubGlobal("fetch", fetchMustNotBeCalled());
    try {
      const cases = selectCases({ split: "holdout" });
      const preflight = holdoutSupportPreflight(cases);
      const check = checkHoldoutCanResolve(preflight, ["disposition_macro_f1", "signal_micro_f1"]);
      expect(check.canResolve).toBe(true);
      // The locked Stage-2 merge primitive is likewise pure arithmetic over
      // already-computed confusion matrices — no candidate/provider param.
      const mainConfusion = { ambiguous: { ambiguous: 0, "(invalid)": 0 } };
      for (const cls of DISPOSITIONS) {
        (mainConfusion as Record<string, Record<string, number>>)[cls] ??= {
          ...Object.fromEntries([...DISPOSITIONS, "(invalid)"].map((c) => [c, 0])),
        };
      }
      const supplementalConfusion: Record<string, Record<string, number>> = {
        ambiguous: { ambiguous: 6, "(invalid)": 0 },
      };
      const merged = combineConfusionRecords(DISPOSITIONS, [mainConfusion, supplementalConfusion]);
      expect(merged.per_class.ambiguous?.support).toBe(6);
      const target = evaluateStage2DispositionMacroF1Target(
        { confusion: mainConfusion, n: 0, excluded_multi_answer_cases: 0 },
        {},
        { confusion: supplementalConfusion, n: 6 },
      );
      expect(target.value).toBeGreaterThanOrEqual(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
