/**
 * `b07_benchmark_prompt_v3` — the PROMPT-V3 INSTRUCTION-QUALITY EXPERIMENT
 * prompt (PR #40, posthoc round).
 *
 * PURPOSE (see the round's task spec): determine whether Sonnet 5's frozen
 * `b07_benchmark_prompt_v2` Stage-2 result (`ELIMINATED_CRITICAL_SAFETY` —
 * `m-en-hold-017`, `m-en-hold-027`, `m-es-hold-017`) reflects a MODEL
 * capability limit or an INSTRUCTION/PROMPT limit, by holding model, adaptive
 * thinking, effort, schema, taxonomy, corpus semantics, D072 and scoring-v2
 * methodology constant and changing ONLY the prompt text.
 *
 * CONSTRUCTION: this file never redefines or duplicates v2's prompt text. It
 * calls `buildSystemPrompt` (v2, unmodified, imported from `./render`) and
 * appends ONE new section — RULES E through J plus a final silent checklist —
 * as a strict textual suffix. This makes "prompt v3 preserves all v2 rules"
 * true by construction rather than by promise: v2's exact output is always a
 * byte-for-byte PREFIX of v3's output for the same task.
 *
 * FIXTURE NEUTRALITY (task requirement): every example below is GENERIC and
 * FICTIONAL. None of it may be, and a test in
 * `tests/b07-benchmark/prompt-v3.test.ts` asserts none of it is, drawn from
 * the frozen 120-case holdout, the 6-case supplemental pack, any case id, any
 * gold_rationale, or Sonnet's own prior v2 output. RULES E-J are DELIBERATELY
 * NEW textual content, independent of the v2 RULE A-D wording, so this file
 * never needs to read `gold_rationale` or any holdout content at all.
 *
 * `b07_benchmark_prompt_v2`, its `SHARED_PREAMBLE`, `PROMPT_VERSION`, the
 * frozen 120-case holdout, and the 6-case supplemental pack are NOT modified
 * by this file — see `../corpus/schema.ts` (`CORPUS_VERSION` unchanged) and
 * `./render.ts` (unchanged, still exports `PROMPT_VERSION ===
 * "b07_benchmark_prompt_v2"`).
 */
import { buildSystemPrompt, buildUserPrompt, toCandidateVisibleCase } from "./render";
import type { CandidateVisibleCase, VisibleCaseSource } from "./render";

/**
 * Bump on ANY change to the text below. Recorded in every prompt-v3
 * diagnostic result row's `prompt_version` field — a diagnostic run under
 * this prompt can never be confused with, resumed against, or silently
 * combined with a `b07_benchmark_prompt_v2` row, because every identity key
 * in `run/types.ts` (`resultCompatibilityKey`, `supplementalResultCompatibilityKey`)
 * and every `normaliseResults`/`scoreCandidateV2` version check already binds
 * on `prompt_version` as an ordinary string field.
 */
export const PROMPT_VERSION_V3 = "b07_benchmark_prompt_v3";

const RULES_E_TO_J = `NEW CONSERVATIVE REASONING RULES (added this round — RULES E through J extend, and never replace, RULES A through D above).

RULE E — AUTHORITY / ESCALATION IS NOT REJECTION
First determine WHO currently has decision authority. If the current target says "I can't approve this." / "This needs head-office approval." / "Our regional team decides." / "Please speak with our agency." / "I forwarded this to the person who handles partnerships." — this is routing / escalation. Use redirect when appropriate. Do not infer rejection merely because the current sender lacks authority. A message can remain neutral or occasionally mixed depending on other authored content.

RULE F — A FORECAST ABOUT ANOTHER DECISION-MAKER IS NOT A DECISION
Distinguish WHAT SOMEONE PREDICTS from WHAT THE AUTHORIZED DECISION-MAKER ACTUALLY DECIDED. Fictional example: "I can't approve this. Corporate decides, and corporate has been saying no to most proposals recently." This does NOT mean "Your proposal was rejected." The current observable facts are: this sender cannot decide; another authority must decide; the sender gives a pessimistic forecast. Unless the text explicitly states that the authorized authority HAS decided this specific opportunity: do not emit rejection. Never convert probability, pessimism, historical behavior, or expectation into a current commercial decision. This runs both directions: an OPTIMISTIC forecast about what another authority tends to approve is likewise not evidence that this specific opportunity was agreed to.

RULE G — EXPLICIT UNCERTAINTY MUST REMAIN UNCERTAINTY
Phrases such as "I don't know yet." / "We can't tell yet." / "I'm not sure whether we'll be able to." / "It's still undecided." / "I can't promise anything." / "We're reorganising and I don't yet know." are NOT rejections merely because they sound discouraging. If the sender explicitly states that the outcome remains unknown: prefer ambiguous, or, where genuinely informational, neutral or mixed depending on the rest of the visible message. Do not emit rejection or disposition negative unless the authored text actually closes/declines the opportunity.

RULE H — DO NOT RESOLVE AN AMBIGUOUS REFERENT BY GUESSING
Words such as "that"/"this"/"it"/"the same"/"eso"/"esto"/"lo mismo" may refer to earlier content. Before interpreting them, check whether there is ONE clear antecedent. If TWO OR MORE plausible antecedents exist and selecting between them changes the commercial meaning: do not choose one. Use ambiguous and reduce evidence strength appropriately. Fictional example: a conversation contains (1) a collaboration proposal, (2) an unrelated operational request. Target says "That doesn't work for us." If the text provides no reliable clue which one "that" refers to, do not invent the referent.

RULE I — UNOBSERVABLE EVIDENCE CANNOT SUPPORT A CONCRETE DISPOSITION
Sometimes text says the substantive decision exists somewhere the model cannot observe: attachment; phone call; video call; missing previous conversation; document shared through another channel. Fictional example: "We decided everything on yesterday's call. That's where we stand." If the visible email does not reveal WHAT was decided: do not guess positive, negative, neutral or mixed direction. Use ambiguous with insufficient_evidence when appropriate. The existence of a decision is not evidence of its direction.

RULE J — STRONG EVIDENCE REQUIRES DIRECT OBSERVABLE SUPPORT
evidence_strength = strong requires visible authored evidence that directly establishes the classification. Do NOT use strong when your conclusion requires: guessing an unresolved pronoun; reconstructing missing conversation; inferring what happened in a call; assuming what an attachment contains; predicting what another authority will decide; converting probability into fact. When those limitations materially determine the answer: use weak or insufficient_evidence as appropriate.

FINAL SILENT CHECK BEFORE OUTPUT
Before producing the structured object, silently check:
1. WHO actually has authority to make the relevant decision?
2. Did that authorized party actually make a decision about THIS opportunity, or did someone merely predict what may happen?
3. Does the text explicitly close the opportunity, or is it merely uncertain, delayed, routed, or pending?
4. Am I resolving any pronoun/reference that has more than one plausible antecedent?
5. Am I relying on information from an attachment/call/document/history I cannot observe?
6. Would my classification assert more certainty than the visible text supports?
If any answer reveals uncertainty: abstain conservatively rather than fabricate business meaning. Do not output this checklist or reasoning. Return only the structured schema.`;

/**
 * v3 system prompt = v2's own `buildSystemPrompt(task)` output, byte-for-byte,
 * with `RULES_E_TO_J` appended as a new final section. No v2 text is
 * paraphrased, reordered or removed.
 */
export function buildSystemPromptV3(task: "message" | "thread"): string {
  return `${buildSystemPrompt(task)}\n\n${RULES_E_TO_J}`;
}

/**
 * The user/evidence prompt is IDENTICAL for v2 and v3 — it renders case
 * evidence only and carries no rule text or version marker, so there is
 * nothing for a "v3 revision" to change here. Re-exported under a v3-specific
 * name purely so diagnostic tooling never has to import from `./render`
 * directly and risk looking like it is mixing versions.
 */
export const buildUserPromptV3 = buildUserPrompt;
export const toCandidateVisibleCaseV3 = toCandidateVisibleCase;
export type { CandidateVisibleCase, VisibleCaseSource };

/** Exposed for tests that need to assert the new section's presence/markers without re-deriving it. */
export const PROMPT_V3_NEW_RULE_MARKERS = [
  "RULE E",
  "RULE F",
  "RULE G",
  "RULE H",
  "RULE I",
  "RULE J",
] as const;
export const PROMPT_V3_NEW_SECTION_HEADER = "NEW CONSERVATIVE REASONING RULES";
export const PROMPT_V3_FINAL_CHECK_HEADER = "FINAL SILENT CHECK BEFORE OUTPUT";
