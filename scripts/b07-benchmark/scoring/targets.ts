/**
 * Quality targets and the hard-gate / Pareto decision method.
 *
 * The round is explicit that these are DECISION TARGETS, not a grading curve:
 * a candidate that misses any of them is not a production winner, and "least
 * bad" is not a winner either. `NO PRODUCTION WINNER YET` is a valid outcome
 * and this module can return it.
 */
import type { CandidateScore } from "./score";

export const QUALITY_TARGETS = {
  firstPassSchemaValidRate: 0.99,
  finalSchemaValidRate: 1.0,
  dispositionMacroF1: 0.9,
  signalMicroF1: 0.9,
  threadStateAccuracy: 0.9,
  compensationAccuracy: 0.95,
  criticalViolations: 0,
} as const;

export interface TargetEvaluation {
  candidate_id: string;
  meetsAll: boolean;
  misses: string[];
  /** True only when the candidate was actually called and produced results. */
  hasEvidence: boolean;
}

export function evaluateQualityTargets(score: CandidateScore): TargetEvaluation {
  const misses: string[] = [];
  const r = score.reliability;
  const hasEvidence = r.cases_attempted > 0;

  if (!hasEvidence) {
    return {
      candidate_id: score.candidate_id,
      meetsAll: false,
      misses: ["no cases were attempted — no evidence exists for this candidate"],
      hasEvidence: false,
    };
  }

  if (r.first_pass_schema_valid_rate < QUALITY_TARGETS.firstPassSchemaValidRate) {
    misses.push(
      `first-pass structured output ${(r.first_pass_schema_valid_rate * 100).toFixed(1)}% < ${(QUALITY_TARGETS.firstPassSchemaValidRate * 100).toFixed(0)}%`,
    );
  }
  if (r.final_schema_valid_rate < QUALITY_TARGETS.finalSchemaValidRate) {
    misses.push(`final structured output ${(r.final_schema_valid_rate * 100).toFixed(1)}% < 100%`);
  }
  if (score.critical_suite.violations > QUALITY_TARGETS.criticalViolations) {
    misses.push(`${score.critical_suite.violations} critical invariant violation(s)`);
  }
  if (!score.critical_suite.passes_hard_gate) {
    misses.push("critical invariant hard gate not cleared");
  }
  if (score.message_task) {
    if (score.message_task.disposition.macro_f1 < QUALITY_TARGETS.dispositionMacroF1) {
      misses.push(
        `disposition macro F1 ${score.message_task.disposition.macro_f1} < ${QUALITY_TARGETS.dispositionMacroF1}`,
      );
    }
    if (score.message_task.signals.micro.f1 < QUALITY_TARGETS.signalMicroF1) {
      misses.push(
        `signal micro F1 ${score.message_task.signals.micro.f1} < ${QUALITY_TARGETS.signalMicroF1}`,
      );
    }
  }
  if (score.thread_task) {
    if (score.thread_task.thread_state.accuracy < QUALITY_TARGETS.threadStateAccuracy) {
      misses.push(
        `thread-state accuracy ${score.thread_task.thread_state.accuracy} < ${QUALITY_TARGETS.threadStateAccuracy}`,
      );
    }
    if (score.thread_task.compensation_structure.accuracy < QUALITY_TARGETS.compensationAccuracy) {
      misses.push(
        `compensation accuracy ${score.thread_task.compensation_structure.accuracy} < ${QUALITY_TARGETS.compensationAccuracy}`,
      );
    }
    if (score.thread_task.unknown_predicted_as_unpaid > 0) {
      misses.push(
        `${score.thread_task.unknown_predicted_as_unpaid} unknown->unpaid compensation collapse(s)`,
      );
    }
  }

  return { candidate_id: score.candidate_id, meetsAll: misses.length === 0, misses, hasEvidence };
}

export const DECISION_OUTCOMES = [
  "production_candidate",
  "no_production_winner_yet",
  "external_runs_pending",
] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export interface Decision {
  outcome: DecisionOutcome;
  /** Candidates that cleared every hard gate AND every quality target. */
  qualified: string[];
  /** Candidates that cleared the hard gates but missed a quality target. */
  gate_passed_target_missed: string[];
  reasons: string[];
}

/**
 * Hard gates first, then a Pareto comparison. Deliberately does NOT collapse
 * quality, safety, cost and latency into one weighted number.
 *
 * The BASELINE is excluded from being nominated: it exists as a floor, and
 * the round forbids promoting the benchmark baseline into production.
 */
export function decide(scores: readonly CandidateScore[], baselineCandidateId: string): Decision {
  const reasons: string[] = [];
  const eligible = scores.filter((s) => s.candidate_id !== baselineCandidateId);

  const withEvidence = eligible.filter((s) => s.reliability.cases_attempted > 0);
  if (withEvidence.length === 0) {
    reasons.push(
      "No non-baseline candidate was successfully called, so no provider comparison exists.",
    );
    return {
      outcome: "external_runs_pending",
      qualified: [],
      gate_passed_target_missed: [],
      reasons,
    };
  }

  const gatePassed = withEvidence.filter((s) => s.critical_suite.passes_hard_gate);
  if (gatePassed.length === 0) {
    reasons.push(
      "Every called candidate produced at least one critical invariant violation (or failed to produce a prediction for every critical case). D072 is not relaxed to let a provider pass.",
    );
    return {
      outcome: "no_production_winner_yet",
      qualified: [],
      gate_passed_target_missed: [],
      reasons,
    };
  }

  const qualified = gatePassed.filter((s) => evaluateQualityTargets(s).meetsAll);
  if (qualified.length === 0) {
    reasons.push(
      "Candidates cleared the critical safety gate but none met every quality target. A least-bad candidate is not nominated.",
    );
    return {
      outcome: "no_production_winner_yet",
      qualified: [],
      gate_passed_target_missed: gatePassed.map((s) => s.candidate_id),
      reasons,
    };
  }

  reasons.push(
    `${qualified.length} candidate(s) cleared every hard gate and every quality target; compare them on the Pareto axes (semantic quality, safety, schema reliability, cost, latency, operational complexity, privacy/vendor suitability).`,
  );
  return {
    outcome: "production_candidate",
    qualified: qualified.map((s) => s.candidate_id),
    gate_passed_target_missed: gatePassed
      .filter((s) => !qualified.includes(s))
      .map((s) => s.candidate_id),
    reasons,
  };
}
