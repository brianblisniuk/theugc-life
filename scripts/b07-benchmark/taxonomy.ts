/**
 * B07 benchmark taxonomy — the exact D072 machine vocabularies.
 *
 * This file is the single source of truth for every enum the benchmark uses.
 * It mirrors `docs/B07_GMAIL_COMMERCIAL_MEANING_CONTRACT.md` §3, §4, §5, §8 and
 * §15 and MUST NOT drift from it.
 *
 * Scope discipline (task: "DO NOT IMPLEMENT B07 PRODUCTION"): nothing in
 * `scripts/b07-benchmark/**` is production B07. It reads no database, performs
 * no Gmail API call, and is never imported by `src/`. A test asserts that.
 */

/** D072 §3 — message-level commercial disposition. MACHINE axis. */
export const DISPOSITIONS = ["positive", "negative", "neutral", "mixed", "ambiguous"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

/** D072 §4 — message-level commercial signal vocabulary. MACHINE axis, a SET. */
export const SIGNALS = [
  "interest",
  "request_information",
  "redirect",
  "terms_discussion",
  "offer",
  "agreement",
  "rejection",
  "timing_constraint",
  "other_commercial",
] as const;
export type Signal = (typeof SIGNALS)[number];

/** D072 §15 — qualitative machine evidence strength. Never a numeric probability. */
export const EVIDENCE_STRENGTHS = ["strong", "moderate", "weak", "insufficient_evidence"] as const;
export type EvidenceStrength = (typeof EVIDENCE_STRENGTHS)[number];

/** D072 §5 — thread-level MACHINE advisory state. Never CRM state. */
export const THREAD_STATES = [
  "unresolved",
  "engaged",
  "negotiating",
  "agreement_observed",
  "declined_observed",
  "ambiguous",
] as const;
export type ThreadState = (typeof THREAD_STATES)[number];

/** D072 §8 — compensation structure. `unknown` MUST NEVER mean `unpaid`. */
export const COMPENSATION_STRUCTURES = [
  "paid",
  "in_kind",
  "hybrid",
  "unpaid",
  "other",
  "unknown",
] as const;
export type CompensationStructure = (typeof COMPENSATION_STRUCTURES)[number];

/**
 * D072 §6 / §7 — HUMAN axis values (creator-confirmed business outcome and lost
 * reason). These are NOT machine targets. The benchmark must never ask a model
 * to produce any of them, and no machine-output schema may contain them.
 *
 * `no_reply` is included because it is D043's absence-derived lost reason and
 * D072 §7 deliberately excludes it even from the human vocabulary — a machine
 * emitting it would be the worst version of the same collapse.
 */
export const FORBIDDEN_HUMAN_OUTCOME_VALUES = [
  "open",
  "won",
  "lost",
  "ghosted",
  "uncertain",
  "no_reply",
  "not_a_fit",
  "creator_closed_pipeline",
  "deal_won",
  "deal_lost",
] as const;
export type ForbiddenHumanOutcomeValue = (typeof FORBIDDEN_HUMAN_OUTCOME_VALUES)[number];

/** Source-language tags present in the corpus. Taxonomy values stay English. */
export const CORPUS_LANGUAGES = ["en", "es", "pt", "fr"] as const;
export type CorpusLanguage = (typeof CORPUS_LANGUAGES)[number];

export const BENCHMARK_TASKS = ["message", "thread"] as const;
export type BenchmarkTask = (typeof BENCHMARK_TASKS)[number];

export const CORPUS_SPLITS = ["dev", "holdout"] as const;
export type CorpusSplit = (typeof CORPUS_SPLITS)[number];

export function isDisposition(value: unknown): value is Disposition {
  return typeof value === "string" && (DISPOSITIONS as readonly string[]).includes(value);
}

export function isSignal(value: unknown): value is Signal {
  return typeof value === "string" && (SIGNALS as readonly string[]).includes(value);
}

/**
 * Canonical signal-set form: de-duplicated and ordered by the D072 vocabulary
 * order (NOT alphabetically — vocabulary order is the contract's own order and
 * is stable across future additions at the end of the list).
 *
 * Every comparison, every metric and every artifact writes this form, so a
 * model that returns `["offer","interest","offer"]` scores identically to one
 * that returns `["interest","offer"]`.
 */
export function canonicalizeSignals(signals: readonly string[]): Signal[] {
  const seen = new Set<Signal>();
  for (const raw of signals) {
    if (isSignal(raw)) seen.add(raw);
  }
  return SIGNALS.filter((s) => seen.has(s));
}

/** Stable string key for a canonical signal set, for exact-set comparison. */
export function signalSetKey(signals: readonly string[]): string {
  return canonicalizeSignals(signals).join("|");
}
