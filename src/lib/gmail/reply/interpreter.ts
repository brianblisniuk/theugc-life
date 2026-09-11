import { classifyCandidate, observedCreatorSentFromAddresses } from "@/lib/gmail/reply/classifier";
import {
  CLASSIFICATION_RULE_VERSION,
  RELATION_RULE_VERSION,
  type MessageObservationInput,
  type ObservationState,
  type ReplyEvidenceMessage,
  type ReplyEvidenceParticipant,
  type ReplyEvidenceReferenceToken,
  type ReplyEvidenceSubject,
  type ReplyEvidenceTextPart,
  type ThreadInterpretation,
  type ThreadSummaryInput,
} from "@/lib/gmail/reply/contract";
import { computeRelations } from "@/lib/gmail/reply/relation";
import { TEXT_TRANSFORM_VERSION } from "@/lib/gmail/reply/text-transform";

function sortReadingOrder(messages: readonly ReplyEvidenceMessage[]): ReplyEvidenceMessage[] {
  return [...messages].sort((a, b) =>
    a.internalDateMs !== b.internalDateMs
      ? a.internalDateMs - b.internalDateMs
      : a.providerMessageId < b.providerMessageId
        ? -1
        : a.providerMessageId > b.providerMessageId
          ? 1
          : 0,
  );
}

/**
 * B06's pure, deterministic V1 evaluator (contract §16). Given one thread's
 * complete evidence, computes one `MessageObservationInput` per message
 * (creator-sent touches included) and the resulting `ThreadSummaryInput`.
 * No external model call. No catalog/canonical read. No side effect.
 */
export function interpretThread(input: {
  messages: readonly ReplyEvidenceMessage[];
  referenceTokens: readonly ReplyEvidenceReferenceToken[];
  participants: readonly ReplyEvidenceParticipant[];
  subjects: readonly ReplyEvidenceSubject[];
  textParts: readonly ReplyEvidenceTextPart[];
  mailAccountEmail: string | null;
  observedThroughAtMs: number | null;
}): ThreadInterpretation {
  const ordered = sortReadingOrder(input.messages);
  const relations = computeRelations(input.messages, input.referenceTokens);
  const selfAddresses = observedCreatorSentFromAddresses(input.messages, input.participants);

  const messageObservations: MessageObservationInput[] = ordered.map((message) => {
    if (message.providerSent) {
      return {
        providerMessageId: message.providerMessageId,
        internalDateMs: message.internalDateMs,
        sourcePayloadSha256: message.sourcePayloadSha256,
        responseClass: "creator_sent_touch",
        relationStatus: null,
        referencedCreatorSentProviderMessageId: null,
        latestPrecedingCreatorSentProviderMessageId: null,
        latestPrecedingCreatorSentAtMs: null,
        chronologyConflict: false,
      };
    }

    const relation = relations.get(message.providerMessageId)!;

    // `ambiguous_reference`/`no_preceding_creator_sent` are decided by the
    // relation axis alone — contract §6's `not_reply` and the safe
    // ambiguous default both short-circuit human/automated/delivery
    // evidence entirely (no reliable relationship to evaluate it against).
    const responseClass =
      relation.relationStatus === "no_preceding_creator_sent"
        ? "not_reply"
        : relation.relationStatus === "ambiguous_reference"
          ? "ambiguous_inbound"
          : classifyCandidate({
              providerMessageId: message.providerMessageId,
              chronologyConflict: relation.chronologyConflict,
              mailAccountEmail: input.mailAccountEmail,
              participants: input.participants,
              subjects: input.subjects,
              textParts: input.textParts,
              observedCreatorSentFromAddresses: selfAddresses,
            }).responseClass;

    return {
      providerMessageId: message.providerMessageId,
      internalDateMs: message.internalDateMs,
      sourcePayloadSha256: message.sourcePayloadSha256,
      responseClass,
      relationStatus: relation.relationStatus,
      referencedCreatorSentProviderMessageId: relation.referencedCreatorSentProviderMessageId,
      latestPrecedingCreatorSentProviderMessageId:
        relation.latestPrecedingCreatorSentProviderMessageId,
      latestPrecedingCreatorSentAtMs: relation.latestPrecedingCreatorSentAtMs,
      chronologyConflict: relation.chronologyConflict,
    };
  });

  const threadSummary = computeThreadSummary(messageObservations, input.observedThroughAtMs);

  return { messageObservations, threadSummary };
}

/**
 * TS's own PREDICTION of the thread summary the database will independently
 * derive (closure pass §16) — used by tests/the evaluation harness only; see
 * `ThreadSummaryInput`'s own doc comment. Mirrors the SQL derivation in
 * `gmail_reply_commit_interpretation` exactly, including tie handling
 * (closure pass §17): two or more messages sharing the deciding timestamp
 * null the identity field while keeping the timestamp/latency/count, which
 * depend only on the KNOWN timestamp.
 */
function computeThreadSummary(
  observations: readonly MessageObservationInput[],
  observedThroughAtMs: number | null,
): ThreadSummaryInput {
  const creatorSends = observations.filter((o) => o.responseClass === "creator_sent_touch");
  const firstCreatorSentAtMs =
    creatorSends.length > 0 ? Math.min(...creatorSends.map((o) => o.internalDateMs)) : null;
  const firstCreatorSentRows = creatorSends.filter(
    (o) => o.internalDateMs === firstCreatorSentAtMs,
  );
  const firstCreatorSentTied = firstCreatorSentRows.length > 1;
  const firstCreatorSentProviderMessageId = firstCreatorSentTied
    ? null
    : (firstCreatorSentRows[0]?.providerMessageId ?? null);

  const qualifyingReplies = observations.filter(
    (o) => o.responseClass === "qualifying_human_reply",
  );
  const firstReplyAtMs =
    qualifyingReplies.length > 0
      ? Math.min(...qualifyingReplies.map((o) => o.internalDateMs))
      : null;
  const firstReplyRows = qualifyingReplies.filter((o) => o.internalDateMs === firstReplyAtMs);
  const firstReplyTied = firstReplyRows.length > 1;
  // Every tied first-reply row shares the identical internalDateMs, so "which
  // creator sends precede it" is the same question for all of them — they
  // cannot legitimately disagree on latest-preceding identity/timestamp or
  // on their own chronology_conflict; reading the first is exact.
  const firstReplyRow = firstReplyRows[0] ?? null;

  const base = {
    firstCreatorSentProviderMessageId,
    firstCreatorSentAtMs,
    firstCreatorSentTied,
  };

  if (!firstReplyRow) {
    const hasAmbiguous = observations.some((o) => o.responseClass === "ambiguous_inbound");
    const hasAutomatedOrDelivery = observations.some(
      (o) => o.responseClass === "automated_response" || o.responseClass === "delivery_status",
    );

    let observationState: ObservationState;
    if (hasAmbiguous) {
      observationState = "ambiguous_response_observed";
    } else if (hasAutomatedOrDelivery) {
      observationState = "only_automated_or_delivery_observed";
    } else if (observedThroughAtMs !== null) {
      observationState = "no_qualifying_response_observed_in_window";
    } else {
      observationState = "observation_horizon_unknown";
    }

    return {
      ...base,
      observationState,
      firstQualifyingHumanReplyProviderMessageId: null,
      firstQualifyingHumanReplyAtMs: null,
      firstQualifyingHumanReplyTied: false,
      creatorSentCountBeforeFirstHumanReply: null,
      latestCreatorSentBeforeReplyProviderMessageId: null,
      latestCreatorSentBeforeReplyTied: false,
      latencyFromFirstCreatorSentMs: null,
      latencyFromLatestCreatorSentMs: null,
      replyChronologyConflict: false,
      observedThroughAtMs,
    };
  }

  const latencyFromFirst =
    firstCreatorSentAtMs !== null ? firstReplyAtMs! - firstCreatorSentAtMs : Number.NaN;

  const conflicted =
    firstReplyRow.chronologyConflict || firstCreatorSentAtMs === null || latencyFromFirst < 0;

  const creatorSentCountBeforeFirstHumanReply = creatorSends.filter(
    (s) => s.internalDateMs < firstReplyAtMs!,
  ).length;

  // `latestPrecedingCreatorSentAtMs`/`...ProviderMessageId` come straight
  // from `computeRelations` (relation.ts), which already nulls the id alone
  // on a per-message tie — never destroying the known timestamp.
  const latestPrecedingAtMs = firstReplyRow.latestPrecedingCreatorSentAtMs;
  const latestPrecedingId = firstReplyRow.latestPrecedingCreatorSentProviderMessageId;
  const latestCreatorSentBeforeReplyTied =
    !conflicted && latestPrecedingAtMs !== null && latestPrecedingId === null;

  return {
    ...base,
    observationState: "qualifying_human_reply_observed",
    firstQualifyingHumanReplyProviderMessageId: firstReplyTied
      ? null
      : firstReplyRow.providerMessageId,
    firstQualifyingHumanReplyAtMs: firstReplyAtMs,
    firstQualifyingHumanReplyTied: firstReplyTied,
    creatorSentCountBeforeFirstHumanReply,
    latestCreatorSentBeforeReplyProviderMessageId: conflicted ? null : latestPrecedingId,
    latestCreatorSentBeforeReplyTied,
    latencyFromFirstCreatorSentMs: conflicted ? null : latencyFromFirst,
    latencyFromLatestCreatorSentMs:
      conflicted || latestPrecedingAtMs === null ? null : firstReplyAtMs! - latestPrecedingAtMs,
    replyChronologyConflict: conflicted,
    observedThroughAtMs,
  };
}

export { RELATION_RULE_VERSION, CLASSIFICATION_RULE_VERSION, TEXT_TRANSFORM_VERSION };
