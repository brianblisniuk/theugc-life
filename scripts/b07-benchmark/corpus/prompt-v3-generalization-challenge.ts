/**
 * `b07_prompt_v3_generalization_challenge_v1` — the FROZEN, blind
 * generalization-challenge fixture for the PR #40 prompt-v3 instruction-
 * quality experiment.
 *
 * WHY THIS EXISTS (see the round's task spec, "IMPORTANT METHODOLOGY"): the
 * original 120-case holdout + 6-case supplemental pack have already been
 * opened (Sonnet 5 was run against them under `b07_benchmark_prompt_v2`), so
 * a Prompt-v3 rerun against those same cases is a `POSTHOC_PROMPT_DIAGNOSTIC`
 * (direct v2-vs-v3 A/B comparison on identical evidence), never a new blind
 * qualification test. This fixture is the SEPARATE, genuinely NEW blind test:
 * 36 synthetic cases that exercise the same reasoning principles Prompt v3's
 * new RULES E-J teach (see `../prompt/render-v3.ts`) with NOVEL wording, NOT
 * copied or paraphrased from the frozen holdout or supplemental pack. It
 * tests whether a candidate generalizes the RULES rather than merely
 * succeeding on known examples.
 *
 * FREEZE CONTRACT (mirrors `corpus/supplemental-ambiguity-pack.ts`): every
 * case's content, gold, acceptable set, invariant tags, category and
 * `is_contrast` flag are FROZEN as of `GENERALIZATION_PACK_CREATED_AT` /
 * `GENERALIZATION_PACK_DECLARATION` below — authored and committed with ZERO
 * Prompt-v3 provider calls having been made against it. Once any Prompt-v3
 * provider call is made against this pack, no wording/gold/acceptable/tag/
 * category change may occur under this same `pack_version` — a correction
 * would require a NEW pack version.
 *
 * ANTI-GAMING DESIGN (task requirement): this fixture deliberately contains
 * BOTH (A) cases where a conservative abstention/redirect/ambiguous answer is
 * correct ("conservative" cases, `is_contrast: false`) and (B) contrast cases
 * where a DECISIVE positive/negative/agreement/offer/negotiation
 * classification is correct (`is_contrast: true`). A candidate that answers
 * "ambiguous"/"neutral"/"redirect" to everything fails every contrast case; a
 * candidate that answers decisively to everything violates the new critical
 * invariants (`scoring/invariants.ts`) on every conservative case. Only a
 * genuinely careful conservative reasoner passes both.
 *
 * CATEGORY COVERAGE (exactly 36 cases):
 *  - `authority_redirect` (8): franchise/HQ, agency/property, marketing/
 *    regional office, procurement/brand team, subsidiary/parent — pure
 *    redirects, redirect+pessimistic-forecast, redirect+optimistic-forecast,
 *    plus explicit-rejection-by-the-authorized-party contrast controls.
 *  - `uncertainty_pending` (8): reorganisation, pending budget, committee
 *    undecided, internal review, temporary inability to commit, plus
 *    explicit-true-rejection contrast controls.
 *  - `missing_evidence_reference` (8): ambiguous pronouns, missing
 *    attachments, an unlogged call, an external approval document, an
 *    incomplete previous history, plus clear-reference contrast controls.
 *  - `agreement_offer_negotiation_control` (6): explicit rejection, explicit
 *    agreement, genuine offer, active negotiation — ALL decisive
 *    (`is_contrast: true`), guarding against the fix for one collapse
 *    becoming a new collapse (blanket over-caution).
 *  - `multilingual` (6): Spanish, Portuguese, French — distinct scenarios per
 *    case, never a translation of another case in this fixture (see
 *    `tests/b07-benchmark/prompt-v3-generalization-fixture.test.ts`'s
 *    near-duplicate check).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import {
  CORPUS_LANGUAGES,
  DISPOSITIONS,
  EVIDENCE_STRENGTHS,
  SIGNALS,
  type CorpusLanguage,
} from "../taxonomy";
import { canonicalizeSignals, signalSetKey } from "../taxonomy";
import { corpusMessageZod } from "./schema";
import { CRITICAL_INVARIANT_IDS } from "../scoring/invariants";
import { digestOf } from "../run/digest";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The pack's own version identifier — distinct from, and never confused with, `CORPUS_VERSION` or `SUPPLEMENTAL_PACK_VERSION`. */
export const GENERALIZATION_PACK_VERSION = "b07_prompt_v3_generalization_challenge_v1";

export const GENERALIZATION_PACK_FIXTURE = "b07_prompt_v3_generalization_challenge_v1.jsonl";

/** Locked size — never grown or shrunk to help any candidate. */
export const GENERALIZATION_PACK_SIZE = 36;

export const GENERALIZATION_CATEGORIES = [
  "authority_redirect",
  "uncertainty_pending",
  "missing_evidence_reference",
  "agreement_offer_negotiation_control",
  "multilingual",
] as const;
export type GeneralizationCategory = (typeof GENERALIZATION_CATEGORIES)[number];

/** Locked category distribution (task's own coverage breakdown), summing to 36. */
export const GENERALIZATION_CATEGORY_TARGET: Readonly<Record<GeneralizationCategory, number>> = {
  authority_redirect: 8,
  uncertainty_pending: 8,
  missing_evidence_reference: 8,
  agreement_offer_negotiation_control: 6,
  multilingual: 6,
};

/**
 * Authored and committed before this round made (or will make) any Prompt-v3
 * provider call. See the FREEZE CONTRACT above — this is the exact
 * declaration the task requires: "CREATED BEFORE ANY PROMPT-V3 PROVIDER CALL".
 */
export const GENERALIZATION_PACK_CREATED_AT = "2026-09-14";
export const GENERALIZATION_PACK_DECLARATION =
  "CREATED BEFORE ANY PROMPT-V3 PROVIDER CALL" as const;

const generalizationExpectedZod = z
  .object({
    disposition: z.enum(DISPOSITIONS),
    signals: z.array(z.enum(SIGNALS)),
    evidence_strength: z.enum(EVIDENCE_STRENGTHS),
  })
  .strict();

const generalizationAcceptableZod = z
  .object({
    disposition: z.array(z.enum(DISPOSITIONS)).min(1).optional(),
    signals: z
      .array(z.array(z.enum(SIGNALS)))
      .min(1)
      .optional(),
    evidence_strength: z.array(z.enum(EVIDENCE_STRENGTHS)).min(1).optional(),
  })
  .strict();

export const generalizationCaseZod = z
  .object({
    case_id: z.string().regex(/^[a-z0-9-]+$/),
    pack_version: z.literal(GENERALIZATION_PACK_VERSION),
    task: z.literal("message"),
    language: z.enum(CORPUS_LANGUAGES),
    category: z.enum(GENERALIZATION_CATEGORIES),
    /**
     * True for a case where a DECISIVE classification is correct (explicit
     * rejection/agreement/offer/negotiation, or an explicit decision by the
     * actual authority). False for a case where conservative abstention/
     * redirect/ambiguous is the honest answer. See ANTI-GAMING DESIGN above.
     */
    is_contrast: z.boolean(),
    subject: z.string().min(1),
    messages: z.array(corpusMessageZod).min(1),
    /** Index into `messages` of the target reply being classified (D072 §16). */
    focus_index: z.number().int().min(0),
    adversarial_tags: z.array(z.string().regex(/^[a-z0-9_]+$/)),
    /** Ids from `scoring/invariants.ts`. Validated against that registry on load. Empty for `is_contrast: true` cases — see semantic validation below. */
    critical_invariants: z.array(z.string().regex(/^[a-z0-9_]+$/)),
    /** HUMAN AUDIT ONLY, tied explicitly to D072 / prompt-v3 RULES E-J. Never sent to a candidate model. */
    gold_rationale: z.string().min(1),
    expected: generalizationExpectedZod,
    acceptable: generalizationAcceptableZod.optional(),
  })
  .strict();

export type GeneralizationCase = z.infer<typeof generalizationCaseZod>;

export class GeneralizationPackError extends Error {}

export function fixtureDir(): string {
  return resolve(HERE, "..", "fixtures");
}

function parseJsonl(raw: string): GeneralizationCase[] {
  const cases: GeneralizationCase[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (error) {
      throw new GeneralizationPackError(
        `${GENERALIZATION_PACK_FIXTURE}:${i + 1} is not valid JSON: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
    const parsed = generalizationCaseZod.safeParse(json);
    if (!parsed.success) {
      throw new GeneralizationPackError(
        `${GENERALIZATION_PACK_FIXTURE}:${i + 1} failed schema validation: ${parsed.error.message}`,
      );
    }
    cases.push(parsed.data);
  }
  return cases;
}

function assertExpectedIsAcceptable(c: GeneralizationCase): void {
  const a = c.acceptable;
  if (a?.disposition && !a.disposition.includes(c.expected.disposition)) {
    throw new GeneralizationPackError(
      `${c.case_id}: expected.disposition is not in acceptable.disposition`,
    );
  }
  if (a?.evidence_strength && !a.evidence_strength.includes(c.expected.evidence_strength)) {
    throw new GeneralizationPackError(
      `${c.case_id}: expected.evidence_strength is not in acceptable.evidence_strength`,
    );
  }
  if (a?.signals) {
    const goldKey = signalSetKey(c.expected.signals);
    if (!a.signals.some((set) => signalSetKey(set) === goldKey)) {
      throw new GeneralizationPackError(
        `${c.case_id}: expected.signals is not in acceptable.signals`,
      );
    }
  }
}

function validateSemantics(cases: readonly GeneralizationCase[]): void {
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.case_id)) {
      throw new GeneralizationPackError(`duplicate generalization case_id: ${c.case_id}`);
    }
    seen.add(c.case_id);

    for (const id of c.critical_invariants) {
      if (!CRITICAL_INVARIANT_IDS.has(id)) {
        throw new GeneralizationPackError(
          `${c.case_id} references unknown critical invariant "${id}"`,
        );
      }
    }

    const focus = c.messages[c.focus_index];
    if (!focus) throw new GeneralizationPackError(`${c.case_id}: focus_index is out of range`);
    if (focus.from !== "target") {
      // D072 §16: a creator-SENT message never receives its own disposition.
      throw new GeneralizationPackError(
        `${c.case_id}: focus_index points at a creator-SENT message`,
      );
    }

    assertExpectedIsAcceptable(c);
  }

  if (cases.length !== GENERALIZATION_PACK_SIZE) {
    throw new GeneralizationPackError(
      `expected exactly ${GENERALIZATION_PACK_SIZE} generalization cases, found ${cases.length}`,
    );
  }

  const byCategory: Record<string, GeneralizationCase[]> = {};
  for (const c of cases) {
    (byCategory[c.category] ??= []).push(c);
  }
  for (const category of GENERALIZATION_CATEGORIES) {
    const expected = GENERALIZATION_CATEGORY_TARGET[category];
    const actual = byCategory[category]?.length ?? 0;
    if (actual !== expected) {
      throw new GeneralizationPackError(
        `generalization pack category distribution mismatch: expected ${expected} "${category}" case(s), found ${actual} (locked distribution: ${JSON.stringify(GENERALIZATION_CATEGORY_TARGET)})`,
      );
    }
  }

  // ANTI-GAMING STRUCTURAL CHECKS (task requirement: "hostile-review each one
  // yourself ... for every contrast case ... for every abstention-type
  // case"). These throw at LOAD TIME, not merely in a test, so the fixture
  // can never silently regress toward "always ambiguous" or "always
  // decisive" even via a future hand-edit under a NEW pack version.
  for (const c of cases) {
    if (c.is_contrast) {
      if (c.critical_invariants.length > 0) {
        throw new GeneralizationPackError(
          `${c.case_id}: is_contrast cases must carry NO critical_invariants (a decisive gold answer would otherwise be flagged as a critical-safety violation)`,
        );
      }
    } else if (c.critical_invariants.length === 0) {
      throw new GeneralizationPackError(
        `${c.case_id}: a non-contrast (conservative-answer) case must carry at least one critical invariant tag`,
      );
    }
  }

  const controlBucket = byCategory.agreement_offer_negotiation_control ?? [];
  if (!controlBucket.every((c) => c.is_contrast)) {
    throw new GeneralizationPackError(
      "agreement_offer_negotiation_control bucket must be entirely decisive (is_contrast: true) — it exists specifically to guard against blanket over-caution",
    );
  }
  const controlHas = (pred: (c: GeneralizationCase) => boolean): boolean =>
    controlBucket.some(pred);
  const signalsOf = (c: GeneralizationCase): string[] => canonicalizeSignals(c.expected.signals);
  if (!controlHas((c) => signalsOf(c).includes("rejection"))) {
    throw new GeneralizationPackError(
      "agreement_offer_negotiation_control bucket is missing an explicit-rejection case",
    );
  }
  if (!controlHas((c) => signalsOf(c).includes("agreement"))) {
    throw new GeneralizationPackError(
      "agreement_offer_negotiation_control bucket is missing an explicit-agreement case",
    );
  }
  if (!controlHas((c) => signalsOf(c).includes("offer") && !signalsOf(c).includes("agreement"))) {
    throw new GeneralizationPackError(
      "agreement_offer_negotiation_control bucket is missing a genuine-offer (not yet accepted) case",
    );
  }
  if (
    !controlHas(
      (c) =>
        signalsOf(c).includes("terms_discussion") &&
        !signalsOf(c).includes("agreement") &&
        !signalsOf(c).includes("offer"),
    )
  ) {
    throw new GeneralizationPackError(
      "agreement_offer_negotiation_control bucket is missing an active-negotiation case",
    );
  }

  for (const category of [
    "authority_redirect",
    "uncertainty_pending",
    "missing_evidence_reference",
  ] as const) {
    const bucket = byCategory[category] ?? [];
    if (!bucket.some((c) => c.is_contrast)) {
      throw new GeneralizationPackError(
        `${category} bucket is missing at least one decisive contrast control (per the task's own anti-gaming requirement)`,
      );
    }
    if (!bucket.some((c) => !c.is_contrast)) {
      throw new GeneralizationPackError(`${category} bucket is missing a conservative-answer case`);
    }
  }

  const multilingual = byCategory.multilingual ?? [];
  const multilingualLanguages = new Set(multilingual.map((c) => c.language));
  for (const lang of ["es", "pt", "fr"] as const) {
    if (!multilingualLanguages.has(lang)) {
      throw new GeneralizationPackError(
        `multilingual bucket must include at least one "${lang}" case (Spanish, Portuguese and French are all required)`,
      );
    }
  }
  if (multilingual.some((c) => c.language === "en")) {
    throw new GeneralizationPackError(
      "multilingual bucket must not contain English cases (English coverage lives in the other four buckets)",
    );
  }

  // EXACT-DUPLICATE TEXT GUARD — cheap, deterministic, load-time. The fuller
  // near-duplicate/translation-clone SIMILARITY check (fuzzy, threshold-
  // based) lives in
  // `tests/b07-benchmark/prompt-v3-generalization-fixture.test.ts`, per the
  // task's own "a simple similarity/exact-text check is fine" instruction —
  // this loader guard only refuses a literal byte-for-byte repeat.
  const seenBlobs = new Map<string, string>();
  for (const c of cases) {
    const blob = c.messages.map((m) => `${m.from}:${m.text}`).join("|");
    const prior = seenBlobs.get(blob);
    if (prior) {
      throw new GeneralizationPackError(`${c.case_id} has byte-identical message text to ${prior}`);
    }
    seenBlobs.set(blob, c.case_id);
  }
}

let cached: GeneralizationCase[] | null = null;

/**
 * Load, validate and cache the frozen generalization-challenge fixture.
 * Strict on purpose, mirroring `corpus/load.ts` and
 * `corpus/supplemental-ambiguity-pack.ts`: any malformed case, wrong count,
 * wrong category distribution, or violation of the anti-gaming structural
 * requirements throws rather than silently degrading.
 */
export function loadPromptV3GeneralizationChallenge(): GeneralizationCase[] {
  if (cached) return cached;
  const path = resolve(fixtureDir(), GENERALIZATION_PACK_FIXTURE);
  const cases = parseJsonl(readFileSync(path, "utf8"));
  validateSemantics(cases);
  cases.sort((a, b) => a.case_id.localeCompare(b.case_id));
  cached = cases;
  return cases;
}

export function getGeneralizationCase(caseId: string): GeneralizationCase | undefined {
  return loadPromptV3GeneralizationChallenge().find((c) => c.case_id === caseId);
}

export interface GeneralizationPackManifest {
  pack_version: string;
  fixture_file: string;
  created_at: string;
  declaration: string;
  size: number;
  case_ids: string[];
  category_distribution: Record<string, number>;
  language_distribution: Record<string, number>;
  contrast_case_count: number;
  conservative_case_count: number;
  /** Deterministic content digest (`run/digest.ts`'s `digestOf`) — same primitive used for the supplemental pack and run/case-set identity elsewhere in this benchmark. */
  digest: string;
}

/** Immutable manifest over the frozen pack — computed fresh each call, but the input never changes. */
export function generalizationPackManifest(): GeneralizationPackManifest {
  const cases = loadPromptV3GeneralizationChallenge();
  const categoryDistribution: Record<string, number> = {};
  const languageDistribution: Record<string, number> = {};
  let contrast = 0;
  for (const c of cases) {
    categoryDistribution[c.category] = (categoryDistribution[c.category] ?? 0) + 1;
    languageDistribution[c.language] = (languageDistribution[c.language] ?? 0) + 1;
    if (c.is_contrast) contrast += 1;
  }
  return {
    pack_version: GENERALIZATION_PACK_VERSION,
    fixture_file: GENERALIZATION_PACK_FIXTURE,
    created_at: GENERALIZATION_PACK_CREATED_AT,
    declaration: GENERALIZATION_PACK_DECLARATION,
    size: cases.length,
    case_ids: cases.map((c) => c.case_id),
    category_distribution: categoryDistribution,
    language_distribution: languageDistribution,
    contrast_case_count: contrast,
    conservative_case_count: cases.length - contrast,
    digest: digestOf(cases),
  };
}

export type { CorpusLanguage };
