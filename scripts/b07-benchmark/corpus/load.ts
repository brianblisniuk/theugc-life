/**
 * Gold-corpus loader.
 *
 * Loading is strict on purpose: an invalid case, an unknown invariant id, a
 * duplicate case id, a `focus_index` that does not point at a target reply, or
 * an `expected` value missing from its own acceptable-answer set all throw.
 * A benchmark whose corpus silently degrades is worse than no benchmark.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CRITICAL_INVARIANT_IDS } from "../scoring/invariants";
import { canonicalizeSignals, signalSetKey } from "../taxonomy";
import type { BenchmarkTask, CorpusSplit } from "../taxonomy";
import { CORPUS_VERSION, corpusCaseZod } from "./schema";
import type { CorpusCase, MessageCase, ThreadCase } from "./schema";

const HERE = dirname(fileURLToPath(import.meta.url));

export const FIXTURE_FILES = [
  "b07_gold_corpus_v1_message.jsonl",
  "b07_gold_corpus_v1_thread.jsonl",
] as const;

export function fixtureDir(): string {
  return resolve(HERE, "..", "fixtures");
}

/**
 * Case ids used as few-shot examples in `b07_benchmark_prompt_v1`.
 *
 * These MUST be `dev` cases (asserted at load time and in tests) and they are
 * excluded from every scored set by default — a candidate that was shown the
 * answer must not also be graded on it.
 */
export const FEW_SHOT_CASE_IDS: readonly string[] = [
  "m-en-dev-001",
  "m-en-dev-014",
  "m-es-dev-005",
  "t-en-dev-003",
  "t-en-dev-011",
];

export class CorpusError extends Error {}

function parseJsonl(raw: string, file: string): CorpusCase[] {
  const cases: CorpusCase[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? "").trim();
    if (line === "") continue;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch (error) {
      throw new CorpusError(
        `${file}:${i + 1} is not valid JSON: ${error instanceof Error ? error.message : "unknown"}`,
      );
    }
    const parsed = corpusCaseZod.safeParse(json);
    if (!parsed.success) {
      throw new CorpusError(`${file}:${i + 1} failed schema validation: ${parsed.error.message}`);
    }
    cases.push(parsed.data);
  }
  return cases;
}

function validateSemantics(cases: readonly CorpusCase[]): void {
  const seen = new Set<string>();
  for (const c of cases) {
    if (seen.has(c.case_id)) throw new CorpusError(`duplicate case_id: ${c.case_id}`);
    seen.add(c.case_id);

    for (const id of c.critical_invariants) {
      if (!CRITICAL_INVARIANT_IDS.has(id)) {
        throw new CorpusError(`${c.case_id} references unknown critical invariant "${id}"`);
      }
    }

    if (c.task === "message") {
      const focus = c.messages[c.focus_index];
      if (!focus) throw new CorpusError(`${c.case_id} focus_index is out of range`);
      if (focus.from !== "target") {
        // D072 §16: a creator-SENT message never receives its own disposition.
        throw new CorpusError(`${c.case_id} focus_index points at a creator-SENT message`);
      }
      assertExpectedIsAcceptable(c);
    } else {
      assertExpectedIsAcceptable(c);
    }
  }

  for (const id of FEW_SHOT_CASE_IDS) {
    const found = cases.find((c) => c.case_id === id);
    if (!found) throw new CorpusError(`few-shot case ${id} is not present in the corpus`);
    if (found.split !== "dev") {
      // LEAKAGE GUARD: a holdout item used as a few-shot example would make the
      // final comparison meaningless.
      throw new CorpusError(`few-shot case ${id} is in the ${found.split} split, must be dev`);
    }
  }
}

/**
 * The primary `expected` answer must itself be inside any acceptable-answer set
 * declared for that field. Otherwise the gold set contradicts itself and the
 * per-class metrics would be computed against an answer the case says is wrong.
 */
function assertExpectedIsAcceptable(c: CorpusCase): void {
  const fail = (field: string): never => {
    throw new CorpusError(`${c.case_id}: expected.${field} is not in acceptable.${field}`);
  };
  if (c.task === "message") {
    const a = c.acceptable;
    if (a?.disposition && !a.disposition.includes(c.expected.disposition)) fail("disposition");
    if (a?.evidence_strength && !a.evidence_strength.includes(c.expected.evidence_strength)) {
      fail("evidence_strength");
    }
    if (a?.signals) {
      const goldKey = signalSetKey(c.expected.signals);
      if (!a.signals.some((set) => signalSetKey(set) === goldKey)) fail("signals");
    }
  } else {
    const a = c.acceptable;
    if (a?.thread_state && !a.thread_state.includes(c.expected.thread_state)) fail("thread_state");
    if (
      a?.compensation_structure &&
      !a.compensation_structure.includes(c.expected.compensation_structure)
    ) {
      fail("compensation_structure");
    }
    if (a?.evidence_strength && !a.evidence_strength.includes(c.expected.evidence_strength)) {
      fail("evidence_strength");
    }
  }
}

let cached: CorpusCase[] | null = null;

/** Load, validate and cache the whole corpus (both fixture files). */
export function loadCorpus(): CorpusCase[] {
  if (cached) return cached;
  const all: CorpusCase[] = [];
  for (const file of FIXTURE_FILES) {
    const path = resolve(fixtureDir(), file);
    all.push(...parseJsonl(readFileSync(path, "utf8"), file));
  }
  validateSemantics(all);
  // Deterministic order regardless of filesystem or fixture ordering.
  all.sort((a, b) => a.case_id.localeCompare(b.case_id));
  cached = all;
  return all;
}

export interface CaseSelection {
  split?: CorpusSplit;
  task?: BenchmarkTask;
  /** Default false: few-shot exemplars are excluded from scored sets. */
  includeFewShot?: boolean;
  /** Restrict to the critical-invariant suite. */
  criticalOnly?: boolean;
}

export function selectCases(selection: CaseSelection = {}): CorpusCase[] {
  const { split, task, includeFewShot = false, criticalOnly = false } = selection;
  return loadCorpus().filter((c) => {
    if (split && c.split !== split) return false;
    if (task && c.task !== task) return false;
    if (!includeFewShot && FEW_SHOT_CASE_IDS.includes(c.case_id)) return false;
    if (criticalOnly && c.critical_invariants.length === 0) return false;
    return true;
  });
}

export function getCase(caseId: string): CorpusCase | undefined {
  return loadCorpus().find((c) => c.case_id === caseId);
}

export function isMessageCase(c: CorpusCase): c is MessageCase {
  return c.task === "message";
}

export function isThreadCase(c: CorpusCase): c is ThreadCase {
  return c.task === "thread";
}

export interface CorpusStats {
  corpus_version: string;
  total: number;
  by_split: Record<string, number>;
  by_task: Record<string, number>;
  by_language: Record<string, number>;
  critical_suite_total: number;
  critical_suite_by_split: Record<string, number>;
  adversarial_tag_counts: Record<string, number>;
  invariant_tag_counts: Record<string, number>;
  few_shot_case_ids: readonly string[];
}

export function corpusStats(): CorpusStats {
  const all = loadCorpus();
  const bump = (target: Record<string, number>, key: string): void => {
    target[key] = (target[key] ?? 0) + 1;
  };
  const stats: CorpusStats = {
    corpus_version: CORPUS_VERSION,
    total: all.length,
    by_split: {},
    by_task: {},
    by_language: {},
    critical_suite_total: 0,
    critical_suite_by_split: {},
    adversarial_tag_counts: {},
    invariant_tag_counts: {},
    few_shot_case_ids: FEW_SHOT_CASE_IDS,
  };
  for (const c of all) {
    bump(stats.by_split, c.split);
    bump(stats.by_task, c.task);
    bump(stats.by_language, c.language);
    for (const tag of c.adversarial_tags) bump(stats.adversarial_tag_counts, tag);
    if (c.critical_invariants.length > 0) {
      stats.critical_suite_total += 1;
      bump(stats.critical_suite_by_split, c.split);
      for (const id of c.critical_invariants) bump(stats.invariant_tag_counts, id);
    }
  }
  return stats;
}

export interface TaxonomyCoverage {
  disposition: Record<string, number>;
  /** Includes the synthetic key `(empty set)` for gold empty signal sets. */
  signals: Record<string, number>;
  message_evidence_strength: Record<string, number>;
  thread_state: Record<string, number>;
  compensation_structure: Record<string, number>;
  thread_evidence_strength: Record<string, number>;
}

/** Taxonomy coverage: which gold values actually appear, and how often. */
export function taxonomyCoverage(): TaxonomyCoverage {
  const coverage: TaxonomyCoverage = {
    disposition: {},
    signals: {},
    message_evidence_strength: {},
    thread_state: {},
    compensation_structure: {},
    thread_evidence_strength: {},
  };
  const bump = (group: keyof TaxonomyCoverage, key: string): void => {
    const bucket = coverage[group];
    bucket[key] = (bucket[key] ?? 0) + 1;
  };
  for (const c of loadCorpus()) {
    if (c.task === "message") {
      bump("disposition", c.expected.disposition);
      bump("message_evidence_strength", c.expected.evidence_strength);
      for (const s of canonicalizeSignals(c.expected.signals)) bump("signals", s);
      if (c.expected.signals.length === 0) bump("signals", "(empty set)");
    } else {
      bump("thread_state", c.expected.thread_state);
      bump("compensation_structure", c.expected.compensation_structure);
      bump("thread_evidence_strength", c.expected.evidence_strength);
    }
  }
  return coverage;
}

export { CORPUS_VERSION };
export type { CorpusCase, MessageCase, ThreadCase };
