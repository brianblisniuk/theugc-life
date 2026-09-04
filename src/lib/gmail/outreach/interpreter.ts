import { OUTREACH_DETECTOR_VERSION } from "@/lib/gmail/outreach/contract";
import type {
  EvidenceMessage,
  EvidenceSubject,
  EvidenceTextPart,
  OutreachStatus,
} from "@/lib/gmail/outreach/contract";
import { buildClassifierInputForMessage } from "@/lib/gmail/outreach/text-transform";

export { OUTREACH_DETECTOR_VERSION };

export interface OutreachClassification {
  status: OutreachStatus;
  reasonCodes: readonly string[];
}

/**
 * `gmail_outreach_rules_v1` — the V1 deterministic baseline (MASTER_PLAN
 * §4.7: provider abstraction, structured output, never silently turn model
 * inference into verified fact). No provider/model call. Conservative:
 * abstains (`needs_review`/`insufficient_evidence`) rather than risk a false
 * positive commercial-outreach claim, per D070/the B05 contract's explicit
 * instruction.
 *
 * Reads ONLY creator-SENT evidence for the positive claim (D068/D069's rule,
 * unmodified): a message with `providerSent === false` never contributes text
 * here, regardless of what it says.
 */
export function classifyOutreach(input: {
  messages: readonly EvidenceMessage[];
  sentTextParts: readonly EvidenceTextPart[];
  subjects: readonly EvidenceSubject[];
}): OutreachClassification {
  const sentMessageIds = new Set(
    input.messages.filter((m) => m.providerSent).map((m) => m.normalizedMessageId),
  );

  const cleanTexts: string[] = [];
  const uncertainTexts: string[] = [];
  for (const messageId of sentMessageIds) {
    const parts = input.sentTextParts.filter((p) => p.normalizedMessageId === messageId);
    const { cleanText, uncertainAuthorshipText } = buildClassifierInputForMessage(parts);
    if (cleanText !== null) cleanTexts.push(cleanText);
    if (uncertainAuthorshipText !== null) uncertainTexts.push(uncertainAuthorshipText);
  }

  const subjectTexts = input.subjects
    .filter((s) => sentMessageIds.has(s.normalizedMessageId))
    .map((s) => s.rawValue);

  if (sentMessageIds.size === 0) {
    // Should not happen — B05 only classifies threads with at least one
    // provider_sent message — but fail closed rather than assume anything.
    return { status: "insufficient_evidence", reasonCodes: ["no_sent_message"] };
  }

  if (cleanTexts.length === 0 && uncertainTexts.length === 0 && subjectTexts.length === 0) {
    return { status: "insufficient_evidence", reasonCodes: ["no_usable_sent_text"] };
  }

  // EXTERNAL AUDIT AMENDMENT #2, Finding 7: the confident-authorship
  // haystack (subjects + clean body text) is what may prove `qualified_
  // outreach`. The uncertain-authorship haystack (a non-RFC signature/
  // closing tail `stripQuotedHistoryAndSignature` could not safely remove
  // outright) is read for EXCLUSION language only, and to detect the one
  // adversarial case this finding names directly: positive vocabulary that
  // appears ONLY inside that uncertain tail (e.g. a "UGC Creator / Travel
  // Influencer" signature under an otherwise ordinary message) — that is
  // never allowed to manufacture `qualified_outreach` on its own.
  const cleanHaystack = [...cleanTexts, ...subjectTexts].join(" \n ").toLowerCase();
  const uncertainHaystack = uncertainTexts.join(" \n ").toLowerCase();
  const fullHaystack = [cleanHaystack, uncertainHaystack].filter((h) => h !== "").join(" \n ");

  const exclusionMatched = EXCLUSION_PATTERNS.some((p) => p.test(fullHaystack));
  const positiveMatchedClean = POSITIVE_PATTERNS.some((p) => p.test(cleanHaystack));
  const positiveMatchedUncertainOnly =
    !positiveMatchedClean && POSITIVE_PATTERNS.some((p) => p.test(uncertainHaystack));

  if (positiveMatchedUncertainOnly && !exclusionMatched) {
    return {
      status: "needs_review",
      reasonCodes: ["positive_language_uncertain_authorship_only"],
    };
  }

  const positiveMatched = positiveMatchedClean;

  if (positiveMatched && !exclusionMatched) {
    return {
      status: "qualified_outreach",
      reasonCodes: ["sent_evidence_present", "collaboration_language_detected"],
    };
  }
  if (exclusionMatched && !positiveMatched) {
    return { status: "not_outreach", reasonCodes: ["exclusion_language_detected"] };
  }
  if (positiveMatched && exclusionMatched) {
    return { status: "needs_review", reasonCodes: ["conflicting_language_detected"] };
  }
  return { status: "insufficient_evidence", reasonCodes: ["no_conclusive_language"] };
}

const POSITIVE_PATTERNS: readonly RegExp[] = [
  /\bcollaborat(e|ion|ing)\b/,
  /\bpartnership\b/,
  /\bsponsor(ed|ship)?\b/,
  /\bugc\b/,
  /\buser[- ]generated content\b/,
  /\bcontent creation\b/,
  /\bpaid partnership\b/,
  /\bhosted stay\b/,
  /\bcomplimentary stay\b/,
  /\bpress trip\b/,
  /\binfluencer\b/,
  /\bbarter\b/,
  /\bfeature your (hotel|property|brand)\b/,
  /\bmedia kit\b/,
  /\brate card\b/,
  /\bcreator collaboration\b/,
  /\bpitch(ing)? (a |the )?(collaboration|partnership|content)\b/,
];

const EXCLUSION_PATTERNS: readonly RegExp[] = [
  /\breservation for\b/,
  /\bbook(ing)? a room\b/,
  /\bcheck-?in\b.*\bcheck-?out\b/,
  /\brefund\b/,
  /\bcomplaint\b/,
  /\bunacceptable\b/,
  /\bdisappointed with (our|my) stay\b/,
  /\bjob application\b/,
  /\bresume attached\b/,
  /\bcover letter\b/,
  /\bapply for the position\b/,
  /\bfamily vacation\b/,
  /\bhoneymoon\b/,
  /\bunsubscribe\b/,
  /\bview this email in your browser\b/,
  /\bfree trial\b/,
  /\bpricing plans\b/,
  /\bbook a demo\b/,
];
