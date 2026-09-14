/**
 * B07 benchmark — PR #40 prompt-v3 experiment: the frozen NEW blind
 * generalization-challenge fixture (`b07_prompt_v3_generalization_challenge_v1`).
 *
 * Covers the round's own test requirements: exactly ~36 cases in the
 * specified category proportions, a frozen deterministic digest, and no case
 * is a near-duplicate/translation-clone of another (a simple similarity/
 * exact-text check).
 */
import { describe, expect, it } from "vitest";

import { loadCorpus } from "../../scripts/b07-benchmark/corpus/load";
import { loadSupplementalAmbiguityPack } from "../../scripts/b07-benchmark/corpus/supplemental-ambiguity-pack";
import {
  GENERALIZATION_CATEGORIES,
  GENERALIZATION_CATEGORY_TARGET,
  GENERALIZATION_PACK_CREATED_AT,
  GENERALIZATION_PACK_DECLARATION,
  GENERALIZATION_PACK_SIZE,
  GENERALIZATION_PACK_VERSION,
  generalizationPackManifest,
  loadPromptV3GeneralizationChallenge,
} from "../../scripts/b07-benchmark/corpus/prompt-v3-generalization-challenge";
import { CRITICAL_INVARIANT_IDS } from "../../scripts/b07-benchmark/scoring/invariants";

describe("prompt-v3 generalization challenge — freeze declaration", () => {
  it("declares CREATED BEFORE ANY PROMPT-V3 PROVIDER CALL", () => {
    expect(GENERALIZATION_PACK_DECLARATION).toBe("CREATED BEFORE ANY PROMPT-V3 PROVIDER CALL");
    expect(GENERALIZATION_PACK_CREATED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("pack version is distinct from the corpus version and the supplemental pack version", () => {
    expect(GENERALIZATION_PACK_VERSION).toBe("b07_prompt_v3_generalization_challenge_v1");
    expect(GENERALIZATION_PACK_VERSION).not.toBe("b07_gold_corpus_v2");
    expect(GENERALIZATION_PACK_VERSION).not.toBe("b07_disposition_ambiguity_support_v1");
  });

  it("the manifest exposes a deterministic digest, stable across repeated loads", () => {
    const a = generalizationPackManifest();
    const b = generalizationPackManifest();
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("prompt-v3 generalization challenge — size and category proportions", () => {
  const cases = loadPromptV3GeneralizationChallenge();

  it(`is exactly ${GENERALIZATION_PACK_SIZE} cases`, () => {
    expect(cases.length).toBe(36);
    expect(GENERALIZATION_PACK_SIZE).toBe(36);
  });

  it("matches the locked category distribution exactly (8/8/8/6/6)", () => {
    const counts: Record<string, number> = {};
    for (const c of cases) counts[c.category] = (counts[c.category] ?? 0) + 1;
    expect(counts).toEqual({
      authority_redirect: 8,
      uncertainty_pending: 8,
      missing_evidence_reference: 8,
      agreement_offer_negotiation_control: 6,
      multilingual: 6,
    });
    expect(GENERALIZATION_CATEGORY_TARGET).toEqual(counts);
    expect(GENERALIZATION_CATEGORIES.length).toBe(5);
  });

  it("has unique case ids", () => {
    const ids = new Set(cases.map((c) => c.case_id));
    expect(ids.size).toBe(cases.length);
  });

  it("covers Spanish, Portuguese and French, plus English", () => {
    const languages = new Set(cases.map((c) => c.language));
    expect(languages.has("en")).toBe(true);
    expect(languages.has("es")).toBe(true);
    expect(languages.has("pt")).toBe(true);
    expect(languages.has("fr")).toBe(true);
  });
});

describe("prompt-v3 generalization challenge — anti-gaming design", () => {
  const cases = loadPromptV3GeneralizationChallenge();

  it("contains BOTH conservative-answer cases and decisive contrast cases", () => {
    const contrast = cases.filter((c) => c.is_contrast);
    const conservative = cases.filter((c) => !c.is_contrast);
    expect(contrast.length).toBeGreaterThan(0);
    expect(conservative.length).toBeGreaterThan(0);
    expect(contrast.length + conservative.length).toBe(cases.length);
  });

  it("the agreement_offer_negotiation_control bucket is entirely decisive and covers all four named subtypes", () => {
    const bucket = cases.filter((c) => c.category === "agreement_offer_negotiation_control");
    expect(bucket.length).toBe(6);
    expect(bucket.every((c) => c.is_contrast)).toBe(true);
    const hasSignal = (label: string) =>
      bucket.some((c) => c.expected.signals.includes(label as never));
    expect(hasSignal("rejection")).toBe(true);
    expect(hasSignal("agreement")).toBe(true);
    expect(
      bucket.some(
        (c) => c.expected.signals.includes("offer") && !c.expected.signals.includes("agreement"),
      ),
    ).toBe(true);
    expect(
      bucket.some(
        (c) =>
          c.expected.signals.includes("terms_discussion") &&
          !c.expected.signals.includes("agreement") &&
          !c.expected.signals.includes("offer"),
      ),
    ).toBe(true);
  });

  it("every conservative-answer case carries at least one critical invariant tag; every contrast case carries none", () => {
    for (const c of cases) {
      if (c.is_contrast) {
        expect(
          c.critical_invariants,
          `${c.case_id} is a contrast case but carries invariant tags`,
        ).toEqual([]);
      } else {
        expect(
          c.critical_invariants.length,
          `${c.case_id} is a conservative-answer case but carries no invariant tags`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("every referenced critical invariant id is a real, registered invariant", () => {
    for (const c of cases) {
      for (const id of c.critical_invariants) {
        expect(
          CRITICAL_INVARIANT_IDS.has(id),
          `${c.case_id} references unknown invariant "${id}"`,
        ).toBe(true);
      }
    }
  });

  it("each of authority_redirect/uncertainty_pending/missing_evidence_reference has at least one contrast AND one conservative case", () => {
    for (const category of [
      "authority_redirect",
      "uncertainty_pending",
      "missing_evidence_reference",
    ] as const) {
      const bucket = cases.filter((c) => c.category === category);
      expect(
        bucket.some((c) => c.is_contrast),
        `${category} missing a contrast control`,
      ).toBe(true);
      expect(
        bucket.some((c) => !c.is_contrast),
        `${category} missing a conservative case`,
      ).toBe(true);
    }
  });

  it("focus_index always points at a target-authored message (never a creator-sent one)", () => {
    for (const c of cases) {
      expect(c.messages[c.focus_index]?.from).toBe("target");
    }
  });

  it("expected values are always inside their own declared acceptable set when one is declared", () => {
    for (const c of cases) {
      if (c.acceptable?.disposition) {
        expect(c.acceptable.disposition).toContain(c.expected.disposition);
      }
      if (c.acceptable?.evidence_strength) {
        expect(c.acceptable.evidence_strength).toContain(c.expected.evidence_strength);
      }
    }
  });
});

describe("prompt-v3 generalization challenge — no near-duplicate / translation-clone cases", () => {
  const cases = loadPromptV3GeneralizationChallenge();

  function normalizedWordSet(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^\p{L}\p{N}\s]/gu, "")
        .split(/\s+/)
        .filter(Boolean),
    );
  }

  function jaccard(a: Set<string>, b: Set<string>): number {
    const intersection = [...a].filter((x) => b.has(x)).length;
    const union = new Set([...a, ...b]).size;
    return union === 0 ? 0 : intersection / union;
  }

  it("no two cases share byte-identical message text", () => {
    const seen = new Map<string, string>();
    for (const c of cases) {
      const blob = c.messages.map((m) => `${m.from}:${m.text}`).join("|");
      const prior = seen.get(blob);
      expect(prior, `${c.case_id} has identical text to ${prior}`).toBeUndefined();
      seen.set(blob, c.case_id);
    }
  });

  it("no two SAME-LANGUAGE cases have suspiciously high word-set similarity (>= 0.6) — guards against translation-clone-style near duplicates", () => {
    const withWords = cases.map((c) => ({
      id: c.case_id,
      lang: c.language,
      words: normalizedWordSet(c.messages.map((m) => m.text).join(" ")),
    }));
    const offenders: string[] = [];
    for (let i = 0; i < withWords.length; i += 1) {
      for (let j = i + 1; j < withWords.length; j += 1) {
        const a = withWords[i];
        const b = withWords[j];
        if (!a || !b || a.lang !== b.lang) continue;
        const sim = jaccard(a.words, b.words);
        if (sim >= 0.6) offenders.push(`${a.id} <-> ${b.id} (${sim.toFixed(2)})`);
      }
    }
    expect(offenders, `near-duplicate pairs found: ${offenders.join(", ")}`).toEqual([]);
  });

  it("no generalization-fixture message text matches any frozen holdout or supplemental-pack message text", () => {
    const holdoutTexts = new Set(loadCorpus().flatMap((c) => c.messages.map((m) => m.text)));
    const supplementalTexts = new Set(
      loadSupplementalAmbiguityPack().flatMap((c) => c.messages.map((m) => m.text)),
    );
    for (const c of cases) {
      for (const m of c.messages) {
        expect(holdoutTexts.has(m.text), `${c.case_id} reuses holdout text`).toBe(false);
        expect(supplementalTexts.has(m.text), `${c.case_id} reuses supplemental text`).toBe(false);
      }
    }
  });

  it("no generalization-fixture case id collides with a holdout or supplemental-pack case id", () => {
    const holdoutIds = new Set(loadCorpus().map((c) => c.case_id));
    const supplementalIds = new Set(loadSupplementalAmbiguityPack().map((c) => c.case_id));
    for (const c of cases) {
      expect(holdoutIds.has(c.case_id)).toBe(false);
      expect(supplementalIds.has(c.case_id)).toBe(false);
    }
  });
});
