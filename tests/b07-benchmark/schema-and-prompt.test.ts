/**
 * B07 benchmark — machine-output schema and prompt guards.
 *
 * Acceptance tests covered here: 3 (no human outcome enums in machine output),
 * 16 (gold rationale never reaches a request payload), plus the fairness
 * guarantee that every provider receives the same logical schema.
 */
import { describe, expect, it } from "vitest";

import { loadCorpus, getCase, FEW_SHOT_CASE_IDS } from "../../scripts/b07-benchmark/corpus/load";
import {
  PROMPT_VERSION,
  buildSystemPrompt,
  buildUserPrompt,
  fewShotCaseIdsFor,
  toCandidateVisibleCase,
} from "../../scripts/b07-benchmark/prompt/render";
import {
  MESSAGE_JSON_SCHEMA,
  THREAD_JSON_SCHEMA,
  machineOutputEnumValues,
  messageOutputZod,
  threadOutputZod,
} from "../../scripts/b07-benchmark/schema";
import { toGeminiSchema } from "../../scripts/b07-benchmark/providers/google";
import {
  COMPENSATION_STRUCTURES,
  DISPOSITIONS,
  EVIDENCE_STRENGTHS,
  FORBIDDEN_HUMAN_OUTCOME_VALUES,
  SIGNALS,
  THREAD_STATES,
} from "../../scripts/b07-benchmark/taxonomy";

describe("machine-output schema", () => {
  it("3. contains no human business-outcome value anywhere", () => {
    const values = new Set(machineOutputEnumValues());
    for (const forbidden of FORBIDDEN_HUMAN_OUTCOME_VALUES) {
      expect(values.has(forbidden), `machine schema must not offer "${forbidden}"`).toBe(false);
    }
    // `ghosted` specifically: D072 §6 says the machine-output schema should not
    // even contain it.
    expect(JSON.stringify([MESSAGE_JSON_SCHEMA, THREAD_JSON_SCHEMA])).not.toMatch(/ghosted/);
  });

  it("3b. rejects a response carrying a human outcome value", () => {
    expect(
      threadOutputZod.safeParse({
        thread_state: "won",
        compensation_structure: "unknown",
        evidence_strength: "strong",
      }).success,
    ).toBe(false);
    expect(
      messageOutputZod.safeParse({
        disposition: "won",
        signals: [],
        evidence_strength: "strong",
      }).success,
    ).toBe(false);
  });

  it("the JSON Schema literal and the taxonomy cannot drift apart", () => {
    expect(MESSAGE_JSON_SCHEMA.properties.disposition).toEqual({
      type: "string",
      enum: [...DISPOSITIONS],
    });
    expect(MESSAGE_JSON_SCHEMA.properties.signals).toEqual({
      type: "array",
      items: { type: "string", enum: [...SIGNALS] },
    });
    expect(MESSAGE_JSON_SCHEMA.properties.evidence_strength).toEqual({
      type: "string",
      enum: [...EVIDENCE_STRENGTHS],
    });
    expect(THREAD_JSON_SCHEMA.properties.thread_state).toEqual({
      type: "string",
      enum: [...THREAD_STATES],
    });
    expect(THREAD_JSON_SCHEMA.properties.compensation_structure).toEqual({
      type: "string",
      enum: [...COMPENSATION_STRUCTURES],
    });
  });

  it("rejects extra fields, so a model cannot smuggle an outcome claim", () => {
    const parsed = messageOutputZod.safeParse({
      disposition: "positive",
      signals: [],
      evidence_strength: "strong",
      business_outcome: "won",
    });
    expect(parsed.success).toBe(false);
  });

  it("FAIRNESS: the Gemini dialect translation preserves the same enums", () => {
    const gemini = toGeminiSchema(MESSAGE_JSON_SCHEMA);
    expect(gemini.properties.disposition?.enum).toEqual([...DISPOSITIONS]);
    expect(gemini.properties.signals?.items?.enum).toEqual([...SIGNALS]);
    expect(gemini.required).toEqual(MESSAGE_JSON_SCHEMA.required);
    const geminiThread = toGeminiSchema(THREAD_JSON_SCHEMA);
    expect(geminiThread.properties.thread_state?.enum).toEqual([...THREAD_STATES]);
    expect(geminiThread.properties.compensation_structure?.enum).toEqual([
      ...COMPENSATION_STRUCTURES,
    ]);
  });
});

describe("benchmark prompt", () => {
  it("16. no gold rationale, gold label or tag reaches a request payload", () => {
    // The strongest form of this test: build the FULL payload for every case
    // in the corpus and assert none of the audit-only strings appear.
    for (const c of loadCorpus()) {
      const visible = toCandidateVisibleCase(c);
      const payload = `${buildSystemPrompt(c.task)}\n${buildUserPrompt(visible)}`;

      expect(payload, `${c.case_id} leaked its rationale`).not.toContain(c.gold_rationale);
      // Single-word tags (`redirect`, `reopening`, `ambiguous`, ...) collide
      // with ordinary prose and with the published vocabulary, so matching on
      // them produces false positives rather than evidence. Multi-word
      // snake_case tags are unambiguous machine metadata: if one of those ever
      // appears in a payload, something really did leak.
      const vocabulary = new Set<string>([...SIGNALS, ...DISPOSITIONS, ...THREAD_STATES]);
      for (const tag of [...c.adversarial_tags, ...c.critical_invariants]) {
        if (vocabulary.has(tag) || !tag.includes("_")) continue;
        expect(payload, `${c.case_id} leaked tag ${tag}`).not.toContain(tag);
      }
      expect(payload).not.toContain(`"split"`);
      expect(payload).not.toContain("gold_rationale");
      expect(payload).not.toContain("critical_invariants");
      expect(payload).not.toContain("adversarial_tags");
      // The visible projection itself must carry nothing but evidence.
      expect(Object.keys(visible).sort()).toEqual(
        c.task === "message"
          ? ["case_id", "focus_position", "messages", "subject", "task"]
          : ["case_id", "messages", "subject", "task"],
      );
    }
  });

  it("16b. no HOLDOUT evidence ever appears in the shared instructions", () => {
    // The leakage that matters is holdout CONTENT reaching the few-shot block.
    // Label VALUES necessarily coincide across cases (there are only five
    // dispositions), so comparing label JSON would be a false positive; the
    // message text is what identifies a case.
    const holdoutTexts = loadCorpus()
      .filter((c) => c.split === "holdout")
      .flatMap((c) => c.messages.map((m) => m.text));
    for (const task of ["message", "thread"] as const) {
      const system = buildSystemPrompt(task);
      for (const text of holdoutTexts) {
        expect(system, "a holdout message reached the shared prompt").not.toContain(text);
      }
    }
  });

  it("16c. a case's own prompt contains only that case's evidence", () => {
    const corpus = loadCorpus();
    const sample = corpus.filter((c) => c.split === "holdout").slice(0, 12);
    for (const c of sample) {
      const userPrompt = buildUserPrompt(toCandidateVisibleCase(c));
      const ownTexts = new Set(c.messages.map((m) => m.text));
      for (const other of corpus) {
        if (other.case_id === c.case_id) continue;
        for (const message of other.messages) {
          if (ownTexts.has(message.text)) continue;
          expect(userPrompt, `${c.case_id} carried ${other.case_id} evidence`).not.toContain(
            message.text,
          );
        }
      }
    }
  });

  it("few-shot exemplars come only from the dev split", () => {
    for (const task of ["message", "thread"] as const) {
      const ids = fewShotCaseIdsFor(task);
      expect(ids.length).toBeGreaterThanOrEqual(2);
      for (const id of ids) {
        const found = getCase(id);
        expect(found?.split).toBe("dev");
        expect(found?.task).toBe(task);
      }
    }
    expect(fewShotCaseIdsFor("message").length + fewShotCaseIdsFor("thread").length).toBe(
      FEW_SHOT_CASE_IDS.length,
    );
  });

  it("the prompt asks for no chain of thought and states the human/machine boundary", () => {
    for (const task of ["message", "thread"] as const) {
      const system = buildSystemPrompt(task);
      expect(system).toMatch(/Do not explain your reasoning/);
      expect(system).toMatch(/never decide whether the creator won, lost, or was ghosted/);
      expect(system).not.toMatch(/step by step/i);
      expect(system).not.toMatch(/chain of thought/i);
      expect(system).not.toMatch(/think out loud/i);
    }
  });

  it("FAIRNESS: identical prompt bytes for every candidate, keyed only by task and case", () => {
    const c = loadCorpus().find((x) => x.task === "message");
    expect(c).toBeDefined();
    if (!c) return;
    const a = buildUserPrompt(toCandidateVisibleCase(c));
    const b = buildUserPrompt(toCandidateVisibleCase(c));
    expect(a).toBe(b);
    // There is no provider argument anywhere in the prompt API, which is what
    // makes per-provider semantic tuning structurally impossible.
    expect(buildSystemPrompt.length).toBe(1);
    expect(PROMPT_VERSION).toBe("b07_benchmark_prompt_v2");
  });
});

describe("prompt v2 — provider-neutral conservative clarifications", () => {
  it("contains all four rules, identically for message and thread tasks (byte-identical shared preamble)", () => {
    const messageSystem = buildSystemPrompt("message");
    const threadSystem = buildSystemPrompt("thread");
    for (const marker of ["RULE A", "RULE B", "RULE C", "RULE D"]) {
      expect(messageSystem).toContain(marker);
      expect(threadSystem).toContain(marker);
    }
    // The rules text itself (everything up to "Four conservative rules"
    // through RULE D) must be byte-identical between tasks — provider/task
    // neutrality is a shared preamble property, not duplicated/diverged text.
    const extractRules = (s: string): string => {
      const start = s.indexOf("Four conservative rules");
      const end = s.indexOf("Respond ONLY with the structured object");
      expect(start).toBeGreaterThan(-1);
      expect(end).toBeGreaterThan(start);
      return s.slice(start, end);
    };
    expect(extractRules(messageSystem)).toBe(extractRules(threadSystem));
  });

  it("does not quote any scored case id or gold_rationale text in the rule prose", () => {
    const system = buildSystemPrompt("message") + buildSystemPrompt("thread");
    for (const c of loadCorpus()) {
      expect(system, `${c.case_id} id leaked into shared prompt`).not.toContain(c.case_id);
      expect(system, `${c.case_id} rationale leaked into shared prompt`).not.toContain(
        c.gold_rationale,
      );
    }
  });

  it("the RULE A/B fictional examples are not verbatim corpus message text (no case-content leakage)", () => {
    // The five few-shot exemplars are DELIBERATELY embedded in the shared
    // prompt (that is the whole point of a worked example) — excluded here,
    // same discipline as test 16b's holdout-only check. Every OTHER case's
    // message text (dev and holdout alike) must not appear, which is exactly
    // what would happen if a RULE's "fictional" example were secretly copied
    // from a real scored case.
    const system = buildSystemPrompt("message") + buildSystemPrompt("thread");
    for (const c of loadCorpus()) {
      if (FEW_SHOT_CASE_IDS.includes(c.case_id)) continue;
      for (const m of c.messages) {
        expect(
          system,
          `${c.case_id} message text leaked into shared prompt: ${m.text}`,
        ).not.toContain(m.text);
      }
    }
  });

  it("prompt version is bumped from v1 and only one v2 revision exists (no v3 constant defined)", () => {
    expect(PROMPT_VERSION).not.toBe("b07_benchmark_prompt_v1");
    expect(PROMPT_VERSION).toBe("b07_benchmark_prompt_v2");
  });
});
