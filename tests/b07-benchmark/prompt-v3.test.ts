/**
 * B07 benchmark — PR #40 prompt-v3 instruction-quality experiment: prompt
 * construction and fixture-neutrality guarantees.
 *
 * Covers the round's own test requirements: prompt v3 fixture-neutrality (no
 * case ids/gold/rationale from the old holdout leak into the new prompt
 * text), and the new prompt version participating in result/replay identity
 * distinctly from v2.
 */
import { describe, expect, it } from "vitest";

import { loadCorpus } from "../../scripts/b07-benchmark/corpus/load";
import { loadSupplementalAmbiguityPack } from "../../scripts/b07-benchmark/corpus/supplemental-ambiguity-pack";
import { loadPromptV3GeneralizationChallenge } from "../../scripts/b07-benchmark/corpus/prompt-v3-generalization-challenge";
import {
  buildSystemPrompt,
  buildUserPrompt,
  PROMPT_VERSION,
  toCandidateVisibleCase,
} from "../../scripts/b07-benchmark/prompt/render";
import {
  PROMPT_VERSION_V3,
  PROMPT_V3_NEW_RULE_MARKERS,
  PROMPT_V3_NEW_SECTION_HEADER,
  PROMPT_V3_FINAL_CHECK_HEADER,
  buildSystemPromptV3,
  buildUserPromptV3,
  toCandidateVisibleCaseV3,
} from "../../scripts/b07-benchmark/prompt/render-v3";
import {
  resultCompatibilityKey,
  supplementalResultCompatibilityKey,
} from "../../scripts/b07-benchmark/run/types";

describe("prompt v3 — construction preserves v2 byte-for-byte", () => {
  it("v2 is unchanged and still version-stamped b07_benchmark_prompt_v2", () => {
    expect(PROMPT_VERSION).toBe("b07_benchmark_prompt_v2");
  });

  it("v3 is a distinct version string from v2", () => {
    expect(PROMPT_VERSION_V3).toBe("b07_benchmark_prompt_v3");
    expect(PROMPT_VERSION_V3).not.toBe(PROMPT_VERSION);
  });

  it("v3's system prompt has v2's OWN system prompt as an exact byte-for-byte prefix, for both tasks", () => {
    for (const task of ["message", "thread"] as const) {
      const v2 = buildSystemPrompt(task);
      const v3 = buildSystemPromptV3(task);
      expect(v3.startsWith(v2)).toBe(true);
      expect(v3.length).toBeGreaterThan(v2.length);
    }
  });

  it("v3 contains all new RULE markers (E-J) and the final silent-check header, for both tasks", () => {
    for (const task of ["message", "thread"] as const) {
      const v3 = buildSystemPromptV3(task);
      expect(v3).toContain(PROMPT_V3_NEW_SECTION_HEADER);
      expect(v3).toContain(PROMPT_V3_FINAL_CHECK_HEADER);
      for (const marker of PROMPT_V3_NEW_RULE_MARKERS) {
        expect(v3, `${task} prompt missing ${marker}`).toContain(marker);
      }
      // v2's RULE A-D markers are still present (inherited via the prefix).
      for (const marker of ["RULE A", "RULE B", "RULE C", "RULE D"]) {
        expect(v3).toContain(marker);
      }
    }
  });

  it("the new section explicitly instructs abstaining rather than fabricating, and asks for no visible chain of thought", () => {
    const v3 = buildSystemPromptV3("message");
    expect(v3).toMatch(/abstain conservatively/i);
    expect(v3).toMatch(/Do not output this checklist or reasoning/i);
    expect(v3).not.toMatch(/step by step/i);
    expect(v3).not.toMatch(/chain of thought/i);
  });

  it("v3's user/evidence prompt is IDENTICAL to v2's — same function, no version-specific text", () => {
    expect(buildUserPromptV3).toBe(buildUserPrompt);
    expect(toCandidateVisibleCaseV3).toBe(toCandidateVisibleCase);
  });

  it("FAIRNESS: v3 prompt-building takes no candidate/provider argument", () => {
    expect(buildSystemPromptV3.length).toBe(1);
  });
});

describe("prompt v3 — fixture neutrality (no old-holdout content leaks into the new prompt text)", () => {
  const holdoutAndSupplemental = [...loadCorpus(), ...loadSupplementalAmbiguityPack()];
  // The five v2 few-shot exemplars are DEV cases deliberately embedded in v2's
  // own prompt (and therefore inherited by v3's byte-identical prefix) — this
  // is the same, already-accepted v2 behaviour, not new leakage. Excluded
  // here exactly like the existing v2 leakage tests exclude them.
  const FEW_SHOT_IDS = new Set([
    "m-en-dev-001",
    "m-en-dev-014",
    "m-es-dev-005",
    "t-en-dev-003",
    "t-en-dev-011",
  ]);

  it("no old holdout/supplemental case id appears in the NEW v3 section", () => {
    for (const task of ["message", "thread"] as const) {
      const v2 = buildSystemPrompt(task);
      const newSection = buildSystemPromptV3(task).slice(v2.length);
      for (const c of holdoutAndSupplemental) {
        expect(newSection, `${c.case_id} id leaked into the new v3 section`).not.toContain(
          c.case_id,
        );
      }
    }
  });

  it("no old holdout/supplemental gold_rationale appears anywhere in v3 (including the inherited v2 prefix)", () => {
    const v3 = buildSystemPromptV3("message") + buildSystemPromptV3("thread");
    for (const c of holdoutAndSupplemental) {
      expect(v3, `${c.case_id} rationale leaked into prompt v3`).not.toContain(c.gold_rationale);
    }
  });

  it("no old HOLDOUT message text appears in the NEW v3 section (dev few-shot exemplars are the only pre-existing exception, and they live in the inherited v2 prefix, not the new section)", () => {
    const holdoutTexts = loadCorpus()
      .filter((c) => c.split === "holdout")
      .flatMap((c) => c.messages.map((m) => m.text));
    const supplementalTexts = loadSupplementalAmbiguityPack().flatMap((c) =>
      c.messages.map((m) => m.text),
    );
    for (const task of ["message", "thread"] as const) {
      const v2 = buildSystemPrompt(task);
      const newSection = buildSystemPromptV3(task).slice(v2.length);
      for (const text of [...holdoutTexts, ...supplementalTexts]) {
        expect(
          newSection,
          "old evidence text leaked into the new v3 RULES E-J section",
        ).not.toContain(text);
      }
    }
  });

  it("no non-few-shot dev message text leaks into the new v3 section either", () => {
    for (const task of ["message", "thread"] as const) {
      const v2 = buildSystemPrompt(task);
      const newSection = buildSystemPromptV3(task).slice(v2.length);
      for (const c of loadCorpus()) {
        if (FEW_SHOT_IDS.has(c.case_id)) continue;
        for (const m of c.messages) {
          expect(
            newSection,
            `${c.case_id} message text leaked into the new v3 section`,
          ).not.toContain(m.text);
        }
      }
    }
  });

  it("the new 36-case generalization fixture never appears in the prompt text (it is user-visible evidence sent per-case, never baked into shared instructions)", () => {
    const gen = loadPromptV3GeneralizationChallenge();
    const v3 = buildSystemPromptV3("message") + buildSystemPromptV3("thread");
    for (const c of gen) {
      expect(v3).not.toContain(c.case_id);
      expect(v3).not.toContain(c.gold_rationale);
      for (const m of c.messages) expect(v3).not.toContain(m.text);
    }
  });
});

describe("prompt v3 — participates in result/replay identity distinctly from v2", () => {
  it("resultCompatibilityKey differs for otherwise-identical rows that differ only in prompt_version", () => {
    const base = {
      candidate_id: "anthropic-sonnet-5",
      provider_id: "anthropic" as const,
      requested_model: "claude-sonnet-5",
      inference_config_digest: "deadbeef00000000",
      case_id: "m-en-hold-001",
      corpus_version: "b07_gold_corpus_v2",
      schema_version: "b07_benchmark_schema_v1",
    };
    const v2Key = resultCompatibilityKey({ ...base, prompt_version: PROMPT_VERSION });
    const v3Key = resultCompatibilityKey({ ...base, prompt_version: PROMPT_VERSION_V3 });
    expect(v2Key).not.toBe(v3Key);
  });

  it("supplementalResultCompatibilityKey differs for otherwise-identical rows that differ only in prompt_version", () => {
    const base = {
      candidate_id: "anthropic-sonnet-5",
      provider_id: "anthropic" as const,
      requested_model: "claude-sonnet-5",
      inference_config_digest: "deadbeef00000000",
      case_id: "m-en-sup-001",
      pack_version: "b07_disposition_ambiguity_support_v1",
      pack_digest: "abc123",
      schema_version: "b07_benchmark_schema_v1",
    };
    const v2Key = supplementalResultCompatibilityKey({ ...base, prompt_version: PROMPT_VERSION });
    const v3Key = supplementalResultCompatibilityKey({
      ...base,
      prompt_version: PROMPT_VERSION_V3,
    });
    expect(v2Key).not.toBe(v3Key);
  });
});
