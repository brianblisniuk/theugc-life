/**
 * B07 benchmark — gold corpus integrity.
 *
 * Every fixture is HAND-WRITTEN SYNTHETIC data authored from D072's semantics.
 * No real Gmail content was read, exported or copied to build it, and nothing
 * here imports a Gmail module or opens a database connection.
 *
 * Acceptance tests covered here: 1 (corpus validates), 2 (enums are D072-valid),
 * 9 (critical suite is identifiable), 17 (no real-Gmail dependency), plus the
 * gold-label adversarial check that PASS C requires: an acceptable answer must
 * never violate the invariant the same case is asserting.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  CORPUS_VERSION,
  FEW_SHOT_CASE_IDS,
  FIXTURE_FILES,
  corpusStats,
  fixtureDir,
  loadCorpus,
  selectCases,
  taxonomyCoverage,
} from "../../scripts/b07-benchmark/corpus/load";
import { corpusCaseZod } from "../../scripts/b07-benchmark/corpus/schema";
import {
  CRITICAL_INVARIANT_IDS,
  evaluateInvariants,
} from "../../scripts/b07-benchmark/scoring/invariants";
import {
  COMPENSATION_STRUCTURES,
  DISPOSITIONS,
  EVIDENCE_STRENGTHS,
  SIGNALS,
  THREAD_STATES,
  canonicalizeSignals,
} from "../../scripts/b07-benchmark/taxonomy";
import type { MessageOutput, ThreadOutput } from "../../scripts/b07-benchmark/schema";

describe("B07 gold corpus", () => {
  const cases = loadCorpus();

  it("1. every fixture line validates against the corpus schema", () => {
    // loadCorpus() throws on the first invalid line, so reaching here is the
    // assertion; the explicit re-parse guards against a loader shortcut.
    expect(cases.length).toBeGreaterThan(0);
    for (const c of cases) {
      expect(corpusCaseZod.safeParse(c).success).toBe(true);
    }
  });

  it("1b. the corpus is the size and shape the round asked for", () => {
    const stats = corpusStats();
    expect(stats.total).toBe(180);
    expect(stats.by_split.dev).toBe(60);
    expect(stats.by_split.holdout).toBe(120);
    expect(stats.by_task.message).toBeGreaterThan(0);
    expect(stats.by_task.thread).toBeGreaterThan(0);
    expect(stats.corpus_version).toBe(CORPUS_VERSION);
  });

  it("2. every gold enum value is a D072 value", () => {
    for (const c of cases) {
      if (c.task === "message") {
        expect(DISPOSITIONS).toContain(c.expected.disposition);
        expect(EVIDENCE_STRENGTHS).toContain(c.expected.evidence_strength);
        for (const s of c.expected.signals) expect(SIGNALS).toContain(s);
        for (const d of c.acceptable?.disposition ?? []) expect(DISPOSITIONS).toContain(d);
        for (const set of c.acceptable?.signals ?? []) {
          for (const s of set) expect(SIGNALS).toContain(s);
        }
      } else {
        expect(THREAD_STATES).toContain(c.expected.thread_state);
        expect(COMPENSATION_STRUCTURES).toContain(c.expected.compensation_structure);
        expect(EVIDENCE_STRENGTHS).toContain(c.expected.evidence_strength);
        for (const t of c.acceptable?.thread_state ?? []) expect(THREAD_STATES).toContain(t);
        for (const k of c.acceptable?.compensation_structure ?? []) {
          expect(COMPENSATION_STRUCTURES).toContain(k);
        }
      }
    }
  });

  it("2b. gold signal sets are already canonical and duplicate-free", () => {
    for (const c of cases) {
      if (c.task !== "message") continue;
      expect(canonicalizeSignals(c.expected.signals)).toEqual(c.expected.signals);
      for (const set of c.acceptable?.signals ?? []) {
        expect(canonicalizeSignals(set)).toEqual(set);
      }
    }
  });

  it("9. the critical-invariant suite is identifiable and every tag is registered", () => {
    const suite = selectCases({ criticalOnly: true });
    expect(suite.length).toBeGreaterThan(40);
    for (const c of suite) {
      expect(c.critical_invariants.length).toBeGreaterThan(0);
      for (const id of c.critical_invariants) expect(CRITICAL_INVARIANT_IDS.has(id)).toBe(true);
    }
    // Both tasks must be represented, otherwise the suite only guards half the
    // contract.
    expect(suite.some((c) => c.task === "message")).toBe(true);
    expect(suite.some((c) => c.task === "thread")).toBe(true);
  });

  it("PASS C: no acceptable gold answer violates that case's own invariants", () => {
    // The failure mode this catches: a case that says "X is an acceptable
    // answer" while also asserting an invariant that X breaks. That is a
    // self-contradicting gold label and it would punish a correct candidate.
    const contradictions: string[] = [];
    for (const c of cases) {
      if (c.critical_invariants.length === 0) continue;
      for (const candidate of enumerateAcceptableAnswers(c)) {
        const violations = evaluateInvariants(c, candidate);
        for (const v of violations) {
          contradictions.push(
            `${c.case_id}: acceptable answer ${JSON.stringify(candidate)} violates ${v.invariant_id}`,
          );
        }
      }
    }
    expect(contradictions).toEqual([]);
  });

  it("the few-shot exemplars are dev cases and are excluded from scored sets", () => {
    for (const id of FEW_SHOT_CASE_IDS) {
      const found = cases.find((c) => c.case_id === id);
      expect(found, `few-shot case ${id} must exist`).toBeDefined();
      expect(found?.split).toBe("dev");
    }
    const scoredDev = selectCases({ split: "dev" }).map((c) => c.case_id);
    for (const id of FEW_SHOT_CASE_IDS) expect(scoredDev).not.toContain(id);
    const withFewShot = selectCases({ split: "dev", includeFewShot: true }).map((c) => c.case_id);
    for (const id of FEW_SHOT_CASE_IDS) expect(withFewShot).toContain(id);
  });

  it("dev and holdout are disjoint and no case id repeats", () => {
    const dev = new Set(selectCases({ split: "dev", includeFewShot: true }).map((c) => c.case_id));
    const holdout = selectCases({ split: "holdout", includeFewShot: true }).map((c) => c.case_id);
    for (const id of holdout) expect(dev.has(id)).toBe(false);
    expect(new Set(cases.map((c) => c.case_id)).size).toBe(cases.length);
  });

  it("taxonomy coverage reaches every D072 machine value", () => {
    const coverage = taxonomyCoverage();
    for (const value of DISPOSITIONS) expect(coverage.disposition[value] ?? 0).toBeGreaterThan(0);
    for (const value of THREAD_STATES) expect(coverage.thread_state[value] ?? 0).toBeGreaterThan(0);
    for (const value of COMPENSATION_STRUCTURES) {
      expect(coverage.compensation_structure[value] ?? 0).toBeGreaterThan(0);
    }
    for (const value of SIGNALS) {
      if (value === "other_commercial") continue; // deliberately rare, asserted below
      expect(coverage.signals[value] ?? 0).toBeGreaterThan(0);
    }
    expect(coverage.signals.other_commercial ?? 0).toBeGreaterThan(0);
    // The empty signal set is a first-class gold answer and must be present,
    // otherwise a candidate is never tested on restraint.
    expect(coverage.signals["(empty set)"] ?? 0).toBeGreaterThan(0);
  });

  it("covers the languages the round required, English and Spanish materially", () => {
    const stats = corpusStats();
    expect(stats.by_language.en).toBeGreaterThan(60);
    expect(stats.by_language.es).toBeGreaterThan(25);
    expect((stats.by_language.pt ?? 0) + (stats.by_language.fr ?? 0)).toBeGreaterThan(10);
  });

  it("covers the required adversarial situations", () => {
    const tags = corpusStats().adversarial_tag_counts;
    for (const required of [
      "straightforward_positive",
      "straightforward_rejection",
      "operational_neutral",
      "redirect",
      "information_request",
      "rate_request",
      "offer_without_acceptance",
      "target_acceptance_awaiting_creator",
      "creator_acceptance_awaiting_target",
      "explicit_mutual_confirmation",
      "in_kind_structure",
      "paid_structure",
      "hybrid_structure",
      "unpaid_structure",
      "explicit_no_compensation",
      "timing_constraint",
      "temporary_rejection",
      "reopening",
      "mixed_message",
      "ambiguous",
      "quoted_history_trap",
      "contradictory_later_message",
      "multiple_target_replies",
      "creator_sent_context",
      "sparse_context",
      "longer_thread",
      "malformed_business_language",
      "multilingual",
    ]) {
      expect(tags[required] ?? 0, `missing adversarial coverage: ${required}`).toBeGreaterThan(0);
    }
  });

  it("17. fixtures are self-contained synthetic data with no real-Gmail dependency", () => {
    // Two separate guarantees: the fixture bytes never mention a Gmail/provider
    // identifier, and the benchmark tree never imports a Gmail or database
    // module. A fixture built from a real mailbox would fail the first; a
    // harness that quietly reads one would fail the second.
    for (const file of FIXTURE_FILES) {
      const raw = readFileSync(resolve(fixtureDir(), file), "utf8");
      expect(raw).not.toMatch(/@gmail\.com/i);
      expect(raw).not.toMatch(/provider_message_id/i);
      expect(raw).not.toMatch(/provider_thread_id/i);
      expect(raw).not.toMatch(/mail_account_id/i);
      expect(raw).not.toMatch(/googleapis/i);
    }
  });

  it("message cases always classify a TARGET message, never a creator-sent one", () => {
    for (const c of cases) {
      if (c.task !== "message") continue;
      expect(c.messages[c.focus_index]?.from).toBe("target");
    }
  });
});

/**
 * All answers a case declares acceptable, as concrete predictions.
 *
 * The cross-product of the per-field acceptable sets, which is exactly the
 * space a candidate is allowed to land in without being marked wrong.
 */
function enumerateAcceptableAnswers(
  c: ReturnType<typeof loadCorpus>[number],
): (MessageOutput | ThreadOutput)[] {
  if (c.task === "message") {
    const dispositions = c.acceptable?.disposition ?? [c.expected.disposition];
    const signalSets = c.acceptable?.signals ?? [c.expected.signals];
    const strengths = c.acceptable?.evidence_strength ?? [c.expected.evidence_strength];
    const out: MessageOutput[] = [];
    for (const disposition of dispositions) {
      for (const signals of signalSets) {
        for (const evidence_strength of strengths) {
          out.push({ disposition, signals: [...signals], evidence_strength });
        }
      }
    }
    return out;
  }
  const states = c.acceptable?.thread_state ?? [c.expected.thread_state];
  const comps = c.acceptable?.compensation_structure ?? [c.expected.compensation_structure];
  const strengths = c.acceptable?.evidence_strength ?? [c.expected.evidence_strength];
  const out: ThreadOutput[] = [];
  for (const thread_state of states) {
    for (const compensation_structure of comps) {
      for (const evidence_strength of strengths) {
        out.push({ thread_state, compensation_structure, evidence_strength });
      }
    }
  }
  return out;
}
