import type {
  ParticipantHeaderRole,
  ReplyEvidenceParticipant,
  ReplyEvidenceSubject,
  ReplyEvidenceTextPart,
  ResponseClass,
} from "@/lib/gmail/reply/contract";
import { extractReplyTextForMessage } from "@/lib/gmail/reply/text-transform";

/**
 * Strong, MECHANICAL delivery-failure evidence (contract §8.3/§12): a
 * mechanical delivery-sender pattern AND explicit undeliverable/bounce/
 * delivery-failure language, together. One weak phrase alone never
 * classifies a human response as `delivery_status`.
 */
const MECHANICAL_DELIVERY_SENDER_PATTERN = /^(mailer-daemon|postmaster|mail delivery subsystem)/i;
const DELIVERY_FAILURE_LANGUAGE_PATTERN =
  /(undeliverable|delivery (?:has |status )?(?:failed|failure)|delivery status notification|returned mail|message not delivered|failure notice|permanent error|address not found)/i;

/**
 * Explicit, bounded, deterministic automated-response language (contract
 * §8.2). Tested ONLY against `cleanText` (post quote/signature strip) and
 * the subject — never quoted history, and never sender-morphology alone
 * (`noreply@` is never sufficient by itself).
 */
const AUTOMATED_RESPONSE_LANGUAGE_PATTERN =
  /(automatic reply|auto-reply|out of office|away from (?:the )?office|on vacation|vacation response(?:der)?|automatic acknowledge?ment)/i;

export interface ClassificationResult {
  responseClass: ResponseClass;
}

function findParticipant(
  participants: readonly ReplyEvidenceParticipant[],
  providerMessageId: string,
  role: ParticipantHeaderRole,
): ReplyEvidenceParticipant | undefined {
  return participants.find((p) => p.providerMessageId === providerMessageId && p.role === role);
}

/**
 * V1 human/automated/delivery classification for one non-SENT candidate that
 * already has a plausible relationship to creator activity (`direct_in_reply_to`,
 * `references_chain` or a non-contradictory `thread_sequence_only`) — see
 * `interpretThread` for the callers that short-circuit `ambiguous_reference`
 * and `no_preceding_creator_sent` before this function is ever called.
 */
export function classifyCandidate(input: {
  providerMessageId: string;
  chronologyConflict: boolean;
  mailAccountEmail: string | null;
  participants: readonly ReplyEvidenceParticipant[];
  subjects: readonly ReplyEvidenceSubject[];
  textParts: readonly ReplyEvidenceTextPart[];
}): ClassificationResult {
  // An established relation whose own timestamps contradict it is not a safe
  // basis for ANY positive classification (contract §8.1 requirement 6).
  if (input.chronologyConflict) {
    return { responseClass: "ambiguous_inbound" };
  }

  const subject =
    input.subjects.find((s) => s.providerMessageId === input.providerMessageId)?.rawValue ?? "";
  const ownTextParts = input.textParts.filter(
    (tp) => tp.providerMessageId === input.providerMessageId,
  );
  const { cleanText } = extractReplyTextForMessage(ownTextParts);

  const fromParticipant = findParticipant(input.participants, input.providerMessageId, "from");

  // DELIVERY STATUS: mechanical sender pattern AND explicit failure language.
  const mechanicalSender =
    fromParticipant?.parseStatus === "parsed" &&
    !!fromParticipant.addrSpec &&
    MECHANICAL_DELIVERY_SENDER_PATTERN.test(fromParticipant.addrSpec);
  const deliveryLanguage =
    DELIVERY_FAILURE_LANGUAGE_PATTERN.test(subject) ||
    DELIVERY_FAILURE_LANGUAGE_PATTERN.test(cleanText ?? "");
  if (mechanicalSender && deliveryLanguage) {
    return { responseClass: "delivery_status" };
  }

  // AUTOMATED RESPONSE: explicit language in the subject or the CONFIDENT-
  // AUTHORSHIP text only (quote/signature already stripped upstream) —
  // never sender morphology alone, never quoted history.
  if (
    AUTOMATED_RESPONSE_LANGUAGE_PATTERN.test(subject) ||
    AUTOMATED_RESPONSE_LANGUAGE_PATTERN.test(cleanText ?? "")
  ) {
    return { responseClass: "automated_response" };
  }

  // EXTERNAL-PARTICIPANT REQUIREMENT (contract §8.1 requirement 3): the
  // sender must be a parsed address, and it must not be the connected
  // mailbox's own current routing address. A missing/malformed From, or a
  // send that is (oddly, for a non-SENT message) from the mailbox itself,
  // cannot safely be called a human reply from someone else.
  const isExternalParticipant =
    fromParticipant?.parseStatus === "parsed" &&
    !!fromParticipant.addrSpec &&
    (!input.mailAccountEmail ||
      fromParticipant.addrSpec.toLowerCase() !== input.mailAccountEmail.toLowerCase());
  if (!isExternalParticipant) {
    return { responseClass: "ambiguous_inbound" };
  }

  // NEWLY-AUTHORED TEXTUAL EVIDENCE (contract §8.1 requirement 4): non-empty
  // after conservative quote/signature handling.
  if (!cleanText || cleanText.trim() === "") {
    return { responseClass: "ambiguous_inbound" };
  }

  return { responseClass: "qualifying_human_reply" };
}
