/**
 * `b07_disposition_ambiguity_support_v1` — the FROZEN, blind supplemental
 * disposition-ambiguity support pack.
 *
 * WHY THIS EXISTS (Stage-2 statistical closure round): the original 120-case
 * frozen holdout has zero STRICT `ambiguous` message-disposition cases (every
 * `ambiguous`-gold case there also declares `neutral` — sometimes `mixed` —
 * as a genuinely acceptable alternative, per D072's own conservative
 * definitions), so disposition strict macro F1 can never be hard-evaluated:
 * one required class permanently reads `insufficient_support`. This pack adds
 * exactly 6 independently-authored, genuinely STRICT `ambiguous` cases whose
 * SOLE purpose is completing that one class's strict support to
 * `>= MIN_RELIABLE_CLASS_SUPPORT`. It is intentionally separate from, and
 * never merged into, the frozen 120-case holdout file itself — this file
 * remains byte-for-byte immutable across this round.
 *
 * WHAT THIS PACK IS NOT:
 *  - It is NOT a repair for signal micro-F1 support (see `targets-v2.ts`'s
 *    corrected sufficiency rule for that; this pack is never read for it).
 *  - It is NOT wired into `corpus/load.ts`'s `loadCorpus()`/`selectCases()` —
 *    it is a structurally SEPARATE, self-contained schema/fixture/loader, so
 *    it can never silently enter thread-state accuracy, compensation
 *    accuracy, message acceptable-answer accuracy, reliability, latency or
 *    economics for the main holdout. Consumers that need it (the Stage-2
 *    disposition-macro-F1 gate and the metadata-only preflight) import this
 *    module explicitly.
 *  - It is NOT a Sonnet-specific, or any-candidate-specific, test. Every
 *    future Stage-2 finalist — any provider — is scored against the exact
 *    same 6 frozen cases.
 *
 * FREEZE CONTRACT: `pack_version`, `case_id`s, `expected`, `acceptable` and
 * `gold_rationale` for every case here are FROZEN as of
 * `SUPPLEMENTAL_PACK_CREATED_AT`, `SUPPLEMENTAL_PACK_DECLARATION` below (this
 * pack was authored and committed with ZERO Stage-2 provider calls having
 * been made against it — no model output informed any wording or gold value
 * here). Once any Stage-2 provider call is made against this pack, no
 * wording/gold/acceptable/tag change may occur under this same
 * `pack_version` — a correction would require a NEW pack version and breaks
 * comparability with candidates already scored against this one.
 *
 * STRICTNESS BY CONSTRUCTION: `supplementalAcceptableZod` below has NO
 * `disposition` key at all — there is no schema-legal way for a case in this
 * file to declare an acceptable disposition alternative. Every case here is
 * therefore structurally, not just editorially, STRICT for disposition.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { CORPUS_LANGUAGES, EVIDENCE_STRENGTHS, SIGNALS, type CorpusLanguage } from "../taxonomy";
import { canonicalizeSignals, signalSetKey } from "../taxonomy";
import { corpusMessageZod } from "./schema";
import { digestOf } from "../run/digest";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The pack's own version identifier — distinct from, and never confused with, `CORPUS_VERSION`. */
export const SUPPLEMENTAL_PACK_VERSION = "b07_disposition_ambiguity_support_v1";

export const SUPPLEMENTAL_PACK_FIXTURE = "b07_disposition_ambiguity_support_v1.jsonl";

/** Exactly 6, per the round's locked pack-size decision. Never grown to help any candidate. */
export const SUPPLEMENTAL_PACK_SIZE = 6;

/** Locked language distribution: 3 EN / 2 ES / 1 PT-or-FR. */
export const SUPPLEMENTAL_PACK_LANGUAGE_TARGET: Readonly<Record<CorpusLanguage, number>> = {
  en: 3,
  es: 2,
  pt: 1,
  fr: 0,
};

/**
 * Authored and committed before this round made (or will make) any Stage-2
 * provider call. See the FREEZE CONTRACT above.
 */
export const SUPPLEMENTAL_PACK_CREATED_AT = "2026-09-13";
export const SUPPLEMENTAL_PACK_DECLARATION = "CREATED BEFORE ANY STAGE-2 PROVIDER CALL" as const;

const supplementalExpectedZod = z
  .object({
    /**
     * Literal, not `z.enum(DISPOSITIONS)` — this pack exists to add
     * `ambiguous` support and nothing else. A future editor cannot silently
     * repurpose this schema to author a case of a different disposition.
     */
    disposition: z.literal("ambiguous"),
    signals: z.array(z.enum(SIGNALS)),
    evidence_strength: z.enum(EVIDENCE_STRENGTHS),
  })
  .strict();

/**
 * Deliberately has NO `disposition` key. This is the structural enforcement
 * of "NO ACCEPTABLE ALTERNATIVE" — there is no schema-legal way to declare an
 * acceptable disposition alternative for a case in this pack, so every case
 * here is unconditionally strict for disposition, not merely by editorial
 * promise.
 */
const supplementalAcceptableZod = z
  .object({
    signals: z
      .array(z.array(z.enum(SIGNALS)))
      .min(1)
      .optional(),
  })
  .strict();

export const supplementalCaseZod = z
  .object({
    case_id: z.string().regex(/^[a-z0-9-]+$/),
    pack_version: z.literal(SUPPLEMENTAL_PACK_VERSION),
    /** Explicit marker (task requirement), never absent, never false, in this pack. */
    supplemental_blind_support: z.literal(true),
    task: z.literal("message"),
    language: z.enum(CORPUS_LANGUAGES),
    subject: z.string().min(1),
    messages: z.array(corpusMessageZod).min(1),
    /** Index into `messages` of the target reply being classified (D072 §16). */
    focus_index: z.number().int().min(0),
    adversarial_tags: z.array(z.string().regex(/^[a-z0-9_]+$/)),
    critical_invariants: z.array(z.string().regex(/^[a-z0-9_]+$/)),
    /** HUMAN AUDIT ONLY, tied explicitly to D072. Never sent to a candidate model. */
    gold_rationale: z.string().min(1),
    expected: supplementalExpectedZod,
    acceptable: supplementalAcceptableZod.optional(),
  })
  .strict();

export type SupplementalCase = z.infer<typeof supplementalCaseZod>;

export class SupplementalPackError extends Error {}

export function fixtureDir(): string {
  return resolve(HERE, "..", "fixtures");
}

function parseJsonl(raw: string): SupplementalCase[] {
  const cases: SupplementalCase[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (error) {
      throw new SupplementalPackError(
        `${SUPPLEMENTAL_PACK_FIXTURE}:${i + 1} is not valid JSON: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
    const parsed = supplementalCaseZod.safeParse(json);
    if (!parsed.success) {
      throw new SupplementalPackError(
        `${SUPPLEMENTAL_PACK_FIXTURE}:${i + 1} failed schema validation: ${parsed.error.message}`,
      );
    }
    cases.push(parsed.data);
  }
  return cases;
}

function validateSemantics(cases: readonly SupplementalCase[]): void {
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.case_id)) {
      throw new SupplementalPackError(`duplicate supplemental case_id: ${c.case_id}`);
    }
    seen.add(c.case_id);

    const focus = c.messages[c.focus_index];
    if (!focus) throw new SupplementalPackError(`${c.case_id}: focus_index is out of range`);
    if (focus.from !== "target") {
      // D072 §16: a creator-SENT message never receives its own disposition.
      throw new SupplementalPackError(`${c.case_id}: focus_index points at a creator-SENT message`);
    }

    // Belt-and-suspenders alongside the schema-level structural enforcement:
    // the primary gold, if `acceptable.signals` is declared, must itself be
    // a member of the declared acceptable set (mirrors `corpus/load.ts`'s
    // `assertExpectedIsAcceptable`).
    if (c.acceptable?.signals) {
      const goldKey = signalSetKey(c.expected.signals);
      const found = c.acceptable.signals.some((set) => signalSetKey(set) === goldKey);
      if (!found) {
        throw new SupplementalPackError(
          `${c.case_id}: expected.signals is not in acceptable.signals`,
        );
      }
    }
  }

  if (cases.length !== SUPPLEMENTAL_PACK_SIZE) {
    throw new SupplementalPackError(
      `expected exactly ${SUPPLEMENTAL_PACK_SIZE} supplemental cases, found ${cases.length}`,
    );
  }

  const byLanguage: Record<string, number> = {};
  for (const c of cases) byLanguage[c.language] = (byLanguage[c.language] ?? 0) + 1;
  for (const lang of CORPUS_LANGUAGES) {
    const expected = SUPPLEMENTAL_PACK_LANGUAGE_TARGET[lang];
    const actual = byLanguage[lang] ?? 0;
    if (actual !== expected) {
      throw new SupplementalPackError(
        `supplemental pack language distribution mismatch: expected ${expected} "${lang}" case(s), found ${actual} (locked distribution: ${JSON.stringify(SUPPLEMENTAL_PACK_LANGUAGE_TARGET)})`,
      );
    }
  }
}

let cached: SupplementalCase[] | null = null;

/**
 * Load, validate and cache the frozen supplemental pack. Deliberately mirrors
 * `corpus/load.ts`'s strictness posture: any malformed or size/language-drift
 * case throws rather than silently degrading — a support pack that can drift
 * unnoticed is worse than no support pack.
 */
export function loadSupplementalAmbiguityPack(): SupplementalCase[] {
  if (cached) return cached;
  const path = resolve(fixtureDir(), SUPPLEMENTAL_PACK_FIXTURE);
  const cases = parseJsonl(readFileSync(path, "utf8"));
  validateSemantics(cases);
  // Deterministic order, exactly like the main corpus loader.
  cases.sort((a, b) => a.case_id.localeCompare(b.case_id));
  cached = cases;
  return cases;
}

/** Canonicalised primary signal set for a supplemental case (never rewritten to match a prediction). */
export function supplementalPrimarySignals(c: SupplementalCase): string[] {
  return canonicalizeSignals(c.expected.signals);
}

export interface SupplementalPackManifest {
  pack_version: string;
  fixture_file: string;
  created_at: string;
  declaration: string;
  size: number;
  case_ids: string[];
  language_distribution: Record<string, number>;
  /**
   * Deterministic content digest — the SAME hashing primitive
   * (`run/digest.ts`'s `digestOf`) used for run-selection identity elsewhere
   * in this benchmark. Changes if, and only if, any case's content changes;
   * a Stage-2 report binds this digest so a later silent edit to this file
   * is immediately detectable by comparing it against a report already on
   * file (acceptance test: "pack digest participates in future Stage-2
   * report identity").
   */
  digest: string;
}

/** Immutable manifest over the frozen pack — computed fresh each call, but the input never changes. */
export function supplementalPackManifest(): SupplementalPackManifest {
  const cases = loadSupplementalAmbiguityPack();
  const languageDistribution: Record<string, number> = {};
  for (const c of cases)
    languageDistribution[c.language] = (languageDistribution[c.language] ?? 0) + 1;
  return {
    pack_version: SUPPLEMENTAL_PACK_VERSION,
    fixture_file: SUPPLEMENTAL_PACK_FIXTURE,
    created_at: SUPPLEMENTAL_PACK_CREATED_AT,
    declaration: SUPPLEMENTAL_PACK_DECLARATION,
    size: cases.length,
    case_ids: cases.map((c) => c.case_id),
    language_distribution: languageDistribution,
    digest: digestOf(cases),
  };
}
