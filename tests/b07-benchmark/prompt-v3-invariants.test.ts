/**
 * B07 benchmark — PR #40 prompt-v3 experiment: the 4 new critical invariants
 * (`forecast_not_decision`, `explicit_uncertainty_not_rejection`,
 * `unresolved_referent_not_guessed`, `unobservable_evidence_not_directional`)
 * added to `scoring/invariants.ts` for RULES F/G/H/I.
 *
 * These are pure unit tests against synthetic predictions — no corpus/fixture
 * dependency beyond a minimal `InvariantEvaluableCase` stub, and no
 * provider/network call.
 */
import { describe, expect, it } from "vitest";

import {
  CRITICAL_INVARIANTS,
  CRITICAL_INVARIANT_IDS,
  evaluateInvariants,
  getInvariant,
  type InvariantEvaluableCase,
} from "../../scripts/b07-benchmark/scoring/invariants";
import type { MessageOutput, ThreadOutput } from "../../scripts/b07-benchmark/schema";

const NEW_INVARIANT_IDS = [
  "forecast_not_decision",
  "explicit_uncertainty_not_rejection",
  "unresolved_referent_not_guessed",
  "unobservable_evidence_not_directional",
] as const;

function stubCase(id: string, invariantIds: readonly string[]): InvariantEvaluableCase {
  return { case_id: id, critical_invariants: invariantIds };
}

function message(overrides: Partial<MessageOutput> = {}): MessageOutput {
  return { disposition: "neutral", signals: [], evidence_strength: "moderate", ...overrides };
}

function thread(overrides: Partial<ThreadOutput> = {}): ThreadOutput {
  return {
    thread_state: "unresolved",
    compensation_structure: "unknown",
    evidence_strength: "moderate",
    ...overrides,
  };
}

describe("prompt-v3 new critical invariants — registration", () => {
  it("all 4 new invariant ids are registered and retrievable", () => {
    for (const id of NEW_INVARIANT_IDS) {
      expect(CRITICAL_INVARIANT_IDS.has(id), `${id} not registered`).toBe(true);
      expect(getInvariant(id)).toBeDefined();
    }
  });

  it("each new invariant has a non-empty description and a contract reference naming prompt-v3", () => {
    for (const id of NEW_INVARIANT_IDS) {
      const inv = getInvariant(id);
      expect(inv?.description.length ?? 0).toBeGreaterThan(10);
      expect(inv?.contractRef).toMatch(/prompt_v3/i);
    }
  });

  it("a case with no critical_invariants tags is never evaluated against the new invariants either", () => {
    const untaggedCase = stubCase("x-untagged", []);
    const violatingPrediction = message({ disposition: "negative", signals: ["rejection"] });
    expect(evaluateInvariants(untaggedCase, violatingPrediction)).toEqual([]);
  });
});

describe("forecast_not_decision (RULE F)", () => {
  const invariant = getInvariant("forecast_not_decision")!;

  it("VIOLATED: a pessimistic forecast read as an outright message-level rejection", () => {
    expect(invariant.isViolated(message({ disposition: "negative" }), stubCase("c", []))).toBe(
      true,
    );
    expect(invariant.isViolated(message({ signals: ["rejection"] }), stubCase("c", []))).toBe(true);
  });

  it("VIOLATED: an optimistic forecast read as agreement (either direction converts probability into fact)", () => {
    expect(invariant.isViolated(message({ signals: ["agreement"] }), stubCase("c", []))).toBe(true);
    expect(
      invariant.isViolated(thread({ thread_state: "agreement_observed" }), stubCase("c", [])),
    ).toBe(true);
  });

  it("VIOLATED: thread-level decline read from a forecast", () => {
    expect(
      invariant.isViolated(thread({ thread_state: "declined_observed" }), stubCase("c", [])),
    ).toBe(true);
  });

  it("NOT VIOLATED: a conservative neutral/redirect reading", () => {
    expect(
      invariant.isViolated(
        message({ disposition: "neutral", signals: ["redirect"] }),
        stubCase("c", []),
      ),
    ).toBe(false);
    expect(invariant.isViolated(thread({ thread_state: "unresolved" }), stubCase("c", []))).toBe(
      false,
    );
  });

  it("end-to-end via evaluateInvariants: only fires when the case is actually tagged", () => {
    const tagged = stubCase("c1", ["forecast_not_decision"]);
    const untagged = stubCase("c2", []);
    const violating = message({ disposition: "negative" });
    expect(evaluateInvariants(tagged, violating)).toHaveLength(1);
    expect(evaluateInvariants(untagged, violating)).toHaveLength(0);
  });
});

describe("explicit_uncertainty_not_rejection (RULE G)", () => {
  const invariant = getInvariant("explicit_uncertainty_not_rejection")!;

  it("VIOLATED: explicit uncertainty converted into a message-level rejection", () => {
    expect(invariant.isViolated(message({ disposition: "negative" }), stubCase("c", []))).toBe(
      true,
    );
    expect(invariant.isViolated(message({ signals: ["rejection"] }), stubCase("c", []))).toBe(true);
  });

  it("VIOLATED: explicit uncertainty converted into declined_observed at thread level", () => {
    expect(
      invariant.isViolated(thread({ thread_state: "declined_observed" }), stubCase("c", [])),
    ).toBe(true);
  });

  it("NOT VIOLATED: ambiguous/neutral/mixed readings, which are exactly what RULE G asks for", () => {
    for (const disposition of ["ambiguous", "neutral", "mixed"] as const) {
      expect(invariant.isViolated(message({ disposition }), stubCase("c", []))).toBe(false);
    }
  });
});

describe("unresolved_referent_not_guessed (RULE H)", () => {
  const invariant = getInvariant("unresolved_referent_not_guessed")!;

  it("VIOLATED: a decisive positive or negative disposition when the referent should have been left unresolved", () => {
    expect(invariant.isViolated(message({ disposition: "positive" }), stubCase("c", []))).toBe(
      true,
    );
    expect(invariant.isViolated(message({ disposition: "negative" }), stubCase("c", []))).toBe(
      true,
    );
  });

  it("VIOLATED: agreement or rejection signals guessed from an ambiguous referent", () => {
    expect(invariant.isViolated(message({ signals: ["agreement"] }), stubCase("c", []))).toBe(true);
    expect(invariant.isViolated(message({ signals: ["rejection"] }), stubCase("c", []))).toBe(true);
  });

  it("VIOLATED: thread-level agreement_observed/declined_observed guessed from an ambiguous referent", () => {
    expect(
      invariant.isViolated(thread({ thread_state: "agreement_observed" }), stubCase("c", [])),
    ).toBe(true);
    expect(
      invariant.isViolated(thread({ thread_state: "declined_observed" }), stubCase("c", [])),
    ).toBe(true);
  });

  it("NOT VIOLATED: ambiguous disposition with no decisive signals — the honest, correct answer", () => {
    expect(
      invariant.isViolated(message({ disposition: "ambiguous", signals: [] }), stubCase("c", [])),
    ).toBe(false);
  });

  it("NOT VIOLATED: neutral/mixed with only non-decisive signals (e.g. redirect) is not a guessed referent resolution", () => {
    expect(
      invariant.isViolated(
        message({ disposition: "neutral", signals: ["redirect"] }),
        stubCase("c", []),
      ),
    ).toBe(false);
  });
});

describe("unobservable_evidence_not_directional (RULE I)", () => {
  const invariant = getInvariant("unobservable_evidence_not_directional")!;

  it("VIOLATED: a decisive positive/negative direction assigned to an unobservable off-channel decision", () => {
    expect(invariant.isViolated(message({ disposition: "positive" }), stubCase("c", []))).toBe(
      true,
    );
    expect(invariant.isViolated(message({ disposition: "negative" }), stubCase("c", []))).toBe(
      true,
    );
  });

  it("VIOLATED: agreement/rejection signals or thread agreement_observed/declined_observed guessed from unobservable evidence", () => {
    expect(invariant.isViolated(message({ signals: ["agreement"] }), stubCase("c", []))).toBe(true);
    expect(
      invariant.isViolated(thread({ thread_state: "agreement_observed" }), stubCase("c", [])),
    ).toBe(true);
  });

  it("NOT VIOLATED: ambiguous with insufficient_evidence — the honest answer when the decision is unobservable", () => {
    expect(
      invariant.isViolated(
        message({ disposition: "ambiguous", evidence_strength: "insufficient_evidence" }),
        stubCase("c", []),
      ),
    ).toBe(false);
  });
});

describe("prompt-v3 new invariants — additive only, never touch pre-existing invariants", () => {
  it("the pre-existing invariant registry still has exactly its original members plus the 4 new ones", () => {
    const preExisting = [
      "politeness_not_positive",
      "interest_not_agreement",
      "rate_request_not_agreement",
      "offer_not_agreement",
      "enthusiasm_not_agreement",
      "creator_acceptance_alone_not_agreement",
      "unknown_not_unpaid",
      "redirect_not_terminal",
      "temporary_timing_not_permanent_decline",
      "reopening_supersedes_decline",
      "contradicted_agreement_not_clean_agreement",
      "quoted_positive_not_current_positive",
      "no_fabricated_strong_evidence",
      "unsupported_compensation_unknown",
      "no_machine_human_outcome",
    ];
    const allIds = CRITICAL_INVARIANTS.map((i) => i.id);
    for (const id of preExisting) expect(allIds).toContain(id);
    for (const id of NEW_INVARIANT_IDS) expect(allIds).toContain(id);
    expect(allIds.length).toBe(preExisting.length + NEW_INVARIANT_IDS.length);
  });
});
