/**
 * The critical safety suite.
 *
 * A critical invariant is NOT "the prediction differs from gold". It is a
 * specific, named commercial-meaning collapse that D072 forbids outright. A
 * candidate can be wrong about a case and still not violate an invariant; a
 * candidate that violates one is disqualified as a finalist regardless of its
 * aggregate scores.
 *
 * Each predicate answers one question: "given this prediction, did the
 * candidate commit the forbidden collapse this case was built to detect?"
 */
import type { CorpusCase } from "../corpus/schema";
import { canonicalizeSignals } from "../taxonomy";
import type { MessageOutput, ThreadOutput } from "../schema";

export type Prediction = MessageOutput | ThreadOutput;

function asMessage(prediction: Prediction): MessageOutput | null {
  return "disposition" in prediction ? prediction : null;
}

function asThread(prediction: Prediction): ThreadOutput | null {
  return "thread_state" in prediction ? prediction : null;
}

export interface InvariantDefinition {
  id: string;
  /** D072 clause this invariant enforces. */
  contractRef: string;
  description: string;
  /** True when the prediction VIOLATES the invariant. */
  isViolated: (prediction: Prediction, corpusCase: CorpusCase) => boolean;
}

function predictsAgreement(prediction: Prediction): boolean {
  const message = asMessage(prediction);
  if (message) return canonicalizeSignals(message.signals).includes("agreement");
  const thread = asThread(prediction);
  return thread ? thread.thread_state === "agreement_observed" : false;
}

export const CRITICAL_INVARIANTS: readonly InvariantDefinition[] = [
  {
    id: "politeness_not_positive",
    contractRef: "D072 §3, §27",
    description: "Courteous acknowledgement alone must not be classified `positive`.",
    isViolated: (p) => asMessage(p)?.disposition === "positive",
  },
  {
    id: "interest_not_agreement",
    contractRef: "D072 §5, §27",
    description:
      "Expressed interest must not be promoted to an agreement signal or to a negotiating/agreement thread state.",
    isViolated: (p) =>
      predictsAgreement(p) ||
      asThread(p)?.thread_state === "negotiating" ||
      asThread(p)?.thread_state === "agreement_observed",
  },
  {
    id: "rate_request_not_agreement",
    contractRef: "D072 §27",
    description: "Asking for rates opens a negotiation; it never closes one.",
    isViolated: (p) => predictsAgreement(p),
  },
  {
    id: "offer_not_agreement",
    contractRef: "D072 §5, §17, §27",
    description: "An offer that has not been accepted must not become `agreement_observed`.",
    isViolated: (p) => predictsAgreement(p),
  },
  {
    id: "enthusiasm_not_agreement",
    contractRef: "D072 §5",
    description: "Target enthusiasm alone must not be read as agreement.",
    isViolated: (p) => predictsAgreement(p),
  },
  {
    id: "creator_acceptance_alone_not_agreement",
    contractRef: "D072 §16, §27",
    description:
      "A creator-SENT acceptance is context, not proof the target agreed; thread state must not be `agreement_observed`.",
    isViolated: (p) => asThread(p)?.thread_state === "agreement_observed",
  },
  {
    id: "unknown_not_unpaid",
    contractRef: "D072 §8",
    description: "Unestablished compensation must stay `unknown`; it must never become `unpaid`.",
    isViolated: (p) => asThread(p)?.compensation_structure === "unpaid",
  },
  {
    id: "redirect_not_terminal",
    contractRef: "D072 §27",
    description: "A routing instruction is neither winning nor losing the opportunity.",
    isViolated: (p) => {
      const thread = asThread(p);
      if (thread)
        return (
          thread.thread_state === "agreement_observed" ||
          thread.thread_state === "declined_observed"
        );
      const message = asMessage(p);
      if (!message) return false;
      const signals = canonicalizeSignals(message.signals);
      return signals.includes("agreement") || signals.includes("rejection");
    },
  },
  {
    id: "temporary_timing_not_permanent_decline",
    contractRef: "D072 §17, §27",
    description:
      "A dated availability constraint with an explicit invitation to retry must not become a permanent decline.",
    isViolated: (p) => {
      const thread = asThread(p);
      if (thread) return thread.thread_state === "declined_observed";
      const message = asMessage(p);
      if (!message) return false;
      // Message level: reading a timing qualifier as an outright decline is the
      // same collapse one rung down. Without this branch the invariant would be
      // a silent no-op on every message case tagged with it.
      return (
        message.disposition === "negative" ||
        canonicalizeSignals(message.signals).includes("rejection")
      );
    },
  },
  {
    id: "reopening_supersedes_decline",
    contractRef: "D072 §5, §17",
    description:
      "A later reopening must be able to supersede a current `declined_observed` summary.",
    isViolated: (p) => asThread(p)?.thread_state === "declined_observed",
  },
  {
    id: "contradicted_agreement_not_clean_agreement",
    contractRef: "D072 §17, §27",
    description:
      "Agreement followed by materially contradictory or cancellation language must not be forced into a clean `agreement_observed`.",
    isViolated: (p) => asThread(p)?.thread_state === "agreement_observed",
  },
  {
    id: "quoted_positive_not_current_positive",
    contractRef: "D072 §16, §27",
    description:
      "Enthusiasm surviving only in quoted history must not override the current authored rejection.",
    isViolated: (p) => asMessage(p)?.disposition === "positive",
  },
  {
    id: "no_fabricated_strong_evidence",
    contractRef: "D072 §15, §26 COMPLETENESS",
    description:
      "Sparse or self-contradicting evidence must not yield a `strong` machine evidence assessment.",
    isViolated: (p) => p.evidence_strength === "strong",
  },
  {
    id: "unsupported_compensation_unknown",
    contractRef: "D072 §8, §28",
    description:
      "Compensation details that the thread never establishes must remain `unknown` (not `paid`/`in_kind`/`hybrid`/`unpaid`/`other`).",
    isViolated: (p) => {
      const thread = asThread(p);
      return thread ? thread.compensation_structure !== "unknown" : false;
    },
  },
  {
    id: "no_machine_human_outcome",
    contractRef: "D072 §6",
    description:
      "Machine output must never carry a human business-outcome value (`open`/`won`/`lost`/`ghosted`/`uncertain`). Structurally enforced by the output schema; re-checked here per case.",
    isViolated: (p) => {
      const forbidden = new Set(["open", "won", "lost", "ghosted", "uncertain", "no_reply"]);
      return Object.values(p as Record<string, unknown>).some((value) =>
        Array.isArray(value)
          ? value.some((v) => typeof v === "string" && forbidden.has(v))
          : typeof value === "string" && forbidden.has(value),
      );
    },
  },
] as const;

export const CRITICAL_INVARIANT_IDS: ReadonlySet<string> = new Set(
  CRITICAL_INVARIANTS.map((i) => i.id),
);

const BY_ID = new Map(CRITICAL_INVARIANTS.map((i) => [i.id, i]));

export function getInvariant(id: string): InvariantDefinition | undefined {
  return BY_ID.get(id);
}

export interface InvariantViolation {
  case_id: string;
  invariant_id: string;
  contract_ref: string;
  description: string;
}

/**
 * Evaluate every invariant tagged on a case against one prediction.
 *
 * A case with no `critical_invariants` tags is not part of the critical suite
 * and can never contribute a violation, however wrong its prediction is.
 */
export function evaluateInvariants(
  corpusCase: CorpusCase,
  prediction: Prediction,
): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  for (const id of corpusCase.critical_invariants) {
    const invariant = BY_ID.get(id);
    if (!invariant) continue; // unknown ids are rejected at corpus load time
    if (invariant.isViolated(prediction, corpusCase)) {
      violations.push({
        case_id: corpusCase.case_id,
        invariant_id: invariant.id,
        contract_ref: invariant.contractRef,
        description: invariant.description,
      });
    }
  }
  return violations;
}
