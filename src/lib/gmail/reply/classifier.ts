import type {
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

/**
 * CLOSURE PASS §9: resolves ALL "from" occurrences for one message, never
 * just the first. B04 preserves repeated/conflicting header occurrences on
 * purpose; a decisive external-sender judgement must not be first-row-wins.
 * Identical parsed addresses collapse safely (repetition, not conflict).
 * Anything else — zero occurrences, any malformed/empty_group occurrence, or
 * two or more DIFFERENT parsed addresses — cannot safely resolve to a single
 * sender identity.
 */
function resolveFromAddress(
  participants: readonly ReplyEvidenceParticipant[],
  providerMessageId: string,
): string | null {
  const occurrences = participants.filter(
    (p) => p.providerMessageId === providerMessageId && p.role === "from",
  );
  if (occurrences.length === 0) return null;
  if (occurrences.some((p) => p.parseStatus !== "parsed" || !p.addrSpec)) return null;

  const distinctAddresses = new Set(occurrences.map((p) => p.addrSpec!.toLowerCase()));
  return distinctAddresses.size === 1 ? [...distinctAddresses][0]! : null;
}

/**
 * CLOSURE PASS §8: addresses literally observed as the FROM sender of a
 * creator-SENT message in this thread — used exclusively as NEGATIVE
 * evidence against externality (never invented Gmail alias/dot/plus
 * semantics, never a positive substitute for a known routing address).
 */
export function observedCreatorSentFromAddresses(
  messages: readonly { providerMessageId: string; providerSent: boolean }[],
  participants: readonly ReplyEvidenceParticipant[],
): ReadonlySet<string> {
  const addresses = new Set<string>();
  for (const message of messages) {
    if (!message.providerSent) continue;
    const address = resolveFromAddress(participants, message.providerMessageId);
    if (address) addresses.add(address);
  }
  return addresses;
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
  /** Closure pass §8: addresses directly observed sending a creator-SENT message in this thread. */
  observedCreatorSentFromAddresses?: ReadonlySet<string>;
}): ClassificationResult {
  // An established relation whose own timestamps contradict it is not a safe
  // basis for ANY positive classification (contract §8.1 requirement 6).
  if (input.chronologyConflict) {
    return { responseClass: "ambiguous_inbound" };
  }

  // CLOSURE PASS §10: every Subject occurrence for this message, never just
  // the first — identical repeats collapse trivially (testing the same
  // string twice changes nothing); a conflicting repeat gets no special
  // treatment either way, since ANY occurrence carrying the explicit
  // language is honored (`.some`), and NONE carrying it leaves the result
  // unchanged — a materially different repeat can never suppress evidence a
  // single occurrence already provided, nor manufacture evidence alone.
  const subjects = input.subjects
    .filter((s) => s.providerMessageId === input.providerMessageId)
    .map((s) => s.rawValue);
  const ownTextParts = input.textParts.filter(
    (tp) => tp.providerMessageId === input.providerMessageId,
  );
  const { cleanText } = extractReplyTextForMessage(ownTextParts);

  const fromAddress = resolveFromAddress(input.participants, input.providerMessageId);

  // DELIVERY STATUS: mechanical sender pattern AND explicit failure language.
  const mechanicalSender = !!fromAddress && MECHANICAL_DELIVERY_SENDER_PATTERN.test(fromAddress);
  const deliveryLanguage =
    subjects.some((s) => DELIVERY_FAILURE_LANGUAGE_PATTERN.test(s)) ||
    DELIVERY_FAILURE_LANGUAGE_PATTERN.test(cleanText ?? "");
  if (mechanicalSender && deliveryLanguage) {
    return { responseClass: "delivery_status" };
  }

  // AUTOMATED RESPONSE: explicit language in any Subject occurrence or the
  // CONFIDENT-AUTHORSHIP text only (quote/signature already stripped
  // upstream) — never sender morphology alone, never quoted history.
  if (
    subjects.some((s) => AUTOMATED_RESPONSE_LANGUAGE_PATTERN.test(s)) ||
    AUTOMATED_RESPONSE_LANGUAGE_PATTERN.test(cleanText ?? "")
  ) {
    return { responseClass: "automated_response" };
  }

  // EXTERNAL-PARTICIPANT REQUIREMENT (contract §8.1 requirement 3, hardened
  // by closure pass §7/§8): a single, cleanly-resolved sender address is
  // required (see `resolveFromAddress` — repeated/conflicting/malformed From
  // evidence already resolves to null above). Externality can be
  // ESTABLISHED only by a KNOWN mailbox routing address the sender
  // provably differs from — a null routing address never becomes positive
  // "this is external" evidence merely by its own absence (closure pass
  // §7). A sender address that matches one directly observed on a
  // creator-SENT message in this exact thread is NEGATIVE evidence against
  // externality regardless of the routing address (closure pass §8) — it
  // overrides what would otherwise be a positive routing-based match, but
  // is never itself a substitute source of positive externality.
  const matchesObservedCreatorSelf = !!(
    fromAddress && input.observedCreatorSentFromAddresses?.has(fromAddress)
  );
  const isExternalParticipant =
    !!fromAddress &&
    !!input.mailAccountEmail &&
    fromAddress !== input.mailAccountEmail.toLowerCase() &&
    !matchesObservedCreatorSelf;
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
