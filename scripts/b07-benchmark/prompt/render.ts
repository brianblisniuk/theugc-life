/**
 * `b07_benchmark_prompt_v1` — the ONE canonical, provider-neutral semantic
 * prompt.
 *
 * Fairness rules enforced here, not by convention:
 *
 * - every candidate receives byte-identical system and user text for a case;
 * - few-shot exemplars are loaded from the corpus by id and asserted to be in
 *   the `dev` split, so a holdout item can never become an exemplar;
 * - the candidate-visible projection is built from an explicit allow-list, so
 *   `gold_rationale`, `expected`, `acceptable`, `adversarial_tags` and
 *   `critical_invariants` are structurally unable to reach a provider.
 *
 * No chain-of-thought is requested. Only structured output is asked for.
 */
import { getCase, FEW_SHOT_CASE_IDS } from "../corpus/load";
import type { CorpusCase, CorpusMessage } from "../corpus/schema";
import {
  COMPENSATION_STRUCTURES,
  DISPOSITIONS,
  EVIDENCE_STRENGTHS,
  SIGNALS,
  THREAD_STATES,
} from "../taxonomy";

/** Bump on ANY change to the text below. Recorded in every result row. */
export const PROMPT_VERSION = "b07_benchmark_prompt_v1";

/**
 * The only shape that may leave this process toward a provider.
 *
 * Note what is absent: gold labels, rationale, tags, split. Building this
 * object is the single chokepoint; `buildUserPrompt` accepts nothing else.
 */
export interface CandidateVisibleCase {
  case_id: string;
  task: "message" | "thread";
  subject: string;
  messages: { from: "creator" | "target"; text: string }[];
  /** Message task only: 1-based position of the reply to classify. */
  focus_position?: number;
}

export function toCandidateVisibleCase(corpusCase: CorpusCase): CandidateVisibleCase {
  const visible: CandidateVisibleCase = {
    case_id: corpusCase.case_id,
    task: corpusCase.task,
    subject: corpusCase.subject,
    messages: corpusCase.messages.map((m: CorpusMessage) => ({ from: m.from, text: m.text })),
  };
  if (corpusCase.task === "message") visible.focus_position = corpusCase.focus_index + 1;
  return visible;
}

const SHARED_PREAMBLE = `You are a conservative commercial-meaning analyst for a travel-creator outreach tool.

You read an email thread between a CREATOR (a travel content creator doing brand/hotel outreach) and a TARGET (the hotel, brand, or agency the creator contacted). You output a structured machine INTERPRETATION of what business meaning the OBSERVED text actually supports.

Hard boundaries:
- You describe only what the observed text SUPPORTS. You never guess what probably happened off-thread.
- You never decide whether the creator won, lost, or was ghosted, and you never decide any CRM state. Those are not your outputs and no such value exists in your schema.
- Absence of a reply is never evidence of an outcome.
- Politeness, warmth, or gratitude is not, by itself, commercial meaning.
- An offer is one party's proposal. It is not a two-sided agreement.
- Interest in learning more is not agreement to terms that have not been discussed.
- Asking about rates opens a negotiation; it does not close one.
- Text that appears only inside QUOTED history (reply chains, forwarded blocks, lines beginning with ">") is context. Classify the CURRENT authored content, not the quotation.
- A creator-SENT message is context only. It never proves what the target agreed to.
- Messages may be in any language. Your output values are always the English enum values below.
- When the evidence does not support a confident answer, say so using the ambiguity and evidence-strength values. Abstaining is a correct answer, not a failure.

Respond ONLY with the structured object. Do not explain your reasoning. Do not add prose, preamble, or commentary.`;

const MESSAGE_TASK_SPEC = `TASK: classify ONE target reply.

disposition — exactly one of: ${DISPOSITIONS.join(" | ")}
- positive: the reply materially advances the possibility of a commercial collaboration.
- negative: the reply explicitly declines or closes that possibility.
- neutral: operational or informational, without materially advancing or declining the opportunity.
- mixed: the same message contains materially conflicting advancing and negative/constraining content.
- ambiguous: the evidence is insufficient to classify honestly.

signals — a SET (zero or more) of: ${SIGNALS.join(" | ")}
- interest: expressed appetite for the collaboration itself.
- request_information: asks the creator for materials, data, or details.
- redirect: routes the creator to a different person, team, or channel.
- terms_discussion: engages with the commercial terms (rates, compensation, deliverables, dates as terms).
- offer: proposes concrete consideration or a concrete arrangement.
- agreement: accepts or confirms a specific proposal that was actually on the table.
- rejection: declines the opportunity.
- timing_constraint: constrains WHEN, without that constraint alone being a rejection.
- other_commercial: a genuinely commercial act that fits none of the above. It is NOT a place to park uncertainty — uncertainty belongs in disposition/evidence_strength.
The set may be empty when no commercial act is present. Do not add a signal to look thorough.

evidence_strength — exactly one of: ${EVIDENCE_STRENGTHS.join(" | ")}
How well the observed text supports your assessment. This is a qualitative machine judgement, not a probability. Use insufficient_evidence when you are effectively abstaining.`;

const THREAD_TASK_SPEC = `TASK: summarise the CURRENT machine-supported state of the whole thread.

thread_state — exactly one of: ${THREAD_STATES.join(" | ")}
- unresolved: a human commercial reply exists but nothing stronger is supported.
- engaged: commercial human engagement exists, but no supported negotiation or terminal meaning.
- negotiating: terms or offer discussion is supported, but no explicit agreement is established.
- agreement_observed: explicit evidence supports a two-sided agreement/confirmation of something that was actually proposed.
- declined_observed: an explicit decline is what the thread CURRENTLY supports. This is a current summary, not a permanent verdict; a later reopening supersedes it.
- ambiguous: conflicting or insufficient evidence prevents a safe current summary.
An offer alone, however enthusiastic, never reaches agreement_observed. A one-sided "yes" still awaiting the other side is closer to negotiating. Agreement followed by materially contradictory or cancellation language is ambiguous, not a clean agreement.

compensation_structure — exactly one of: ${COMPENSATION_STRUCTURES.join(" | ")}
- paid: cash compensation is part of the supported terms.
- in_kind: non-cash consideration (hosted stay, product, service) is the supported consideration.
- hybrid: cash plus in-kind.
- unpaid: the evidence POSITIVELY establishes that no compensation applies.
- other: a supported structure fitting none of the above.
- unknown: compensation structure is not established by the evidence.
unknown and unpaid are opposite epistemic states. Silence, vagueness, or a compensation discussion that never concluded is unknown. Never unpaid.

evidence_strength — exactly one of: ${EVIDENCE_STRENGTHS.join(" | ")}
How well the observed thread supports your summary. Qualitative, not a probability.`;

export function buildSystemPrompt(task: "message" | "thread"): string {
  const spec = task === "message" ? MESSAGE_TASK_SPEC : THREAD_TASK_SPEC;
  const examples = renderFewShotBlock(task);
  return `${SHARED_PREAMBLE}\n\n${spec}\n\n${examples}`;
}

function renderEvidence(visible: CandidateVisibleCase): string {
  const lines = [`SUBJECT: ${visible.subject}`, ""];
  visible.messages.forEach((m, index) => {
    const marker =
      visible.task === "message" && visible.focus_position === index + 1
        ? " <-- CLASSIFY THIS MESSAGE"
        : "";
    const who = m.from === "creator" ? "CREATOR (sent)" : "TARGET (received)";
    lines.push(`[${index + 1}] ${who}${marker}`, m.text, "");
  });
  return lines.join("\n").trimEnd();
}

export function buildUserPrompt(visible: CandidateVisibleCase): string {
  return `${renderEvidence(visible)}\n\nReturn the structured object for this ${
    visible.task === "message" ? "message" : "thread"
  }.`;
}

/**
 * Few-shot exemplars, resolved from the corpus by id at build time.
 *
 * Drawn only from `dev`. `getCase` returns the full case; the ANSWER shown is
 * the gold label, but the rationale is deliberately not included — a candidate
 * must not be handed the reasoning the human auditor uses.
 */
export function fewShotCaseIdsFor(task: "message" | "thread"): string[] {
  return FEW_SHOT_CASE_IDS.filter((id) => getCase(id)?.task === task);
}

function renderFewShotBlock(task: "message" | "thread"): string {
  const ids = fewShotCaseIdsFor(task);
  const blocks = ids.map((id) => {
    const corpusCase = getCase(id);
    if (!corpusCase) throw new Error(`few-shot case ${id} missing from corpus`);
    if (corpusCase.split !== "dev") {
      throw new Error(`few-shot case ${id} is not a dev case — holdout leakage refused`);
    }
    const visible = toCandidateVisibleCase(corpusCase);
    const answer =
      corpusCase.task === "message"
        ? {
            disposition: corpusCase.expected.disposition,
            signals: corpusCase.expected.signals,
            evidence_strength: corpusCase.expected.evidence_strength,
          }
        : {
            thread_state: corpusCase.expected.thread_state,
            compensation_structure: corpusCase.expected.compensation_structure,
            evidence_strength: corpusCase.expected.evidence_strength,
          };
    return `EXAMPLE INPUT\n${renderEvidence(visible)}\n\nEXAMPLE OUTPUT\n${JSON.stringify(answer)}`;
  });
  return `WORKED EXAMPLES\n\n${blocks.join("\n\n---\n\n")}`;
}
