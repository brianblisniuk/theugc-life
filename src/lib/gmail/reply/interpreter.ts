import { classifyCandidate } from "@/lib/gmail/reply/classifier";
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
      chronologyConflict: relation.chronologyConflict,
    };
  });

  const threadSummary = computeThreadSummary(messageObservations, input.observedThroughAtMs);

  return { messageObservations, threadSummary };
}

function computeThreadSummary(
  observations: readonly MessageObservationInput[],
  observedThroughAtMs: number | null,
): ThreadSummaryInput {
  const creatorSends = observations
    .filter((o) => o.responseClass === "creator_sent_touch")
    .sort(
      (a, b) =>
        a.internalDateMs - b.internalDateMs ||
        a.providerMessageId.localeCompare(b.providerMessageId),
    );

  const firstCreatorSent = creatorSends[0] ?? null;

  const qualifyingReplies = observations
    .filter((o) => o.responseClass === "qualifying_human_reply")
    .sort(
      (a, b) =>
        a.internalDateMs - b.internalDateMs ||
        a.providerMessageId.localeCompare(b.providerMessageId),
    );

  const firstReply = qualifyingReplies[0] ?? null;

  const base = {
    firstCreatorSentProviderMessageId: firstCreatorSent?.providerMessageId ?? null,
    firstCreatorSentAtMs: firstCreatorSent?.internalDateMs ?? null,
  };

  if (!firstReply) {
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
      creatorSentCountBeforeFirstHumanReply: null,
      latestCreatorSentBeforeReplyProviderMessageId: null,
      latencyFromFirstCreatorSentMs: null,
      latencyFromLatestCreatorSentMs: null,
      replyChronologyConflict: false,
      observedThroughAtMs,
    };
  }

  // A chronology conflict on the FIRST qualifying reply itself — or a
  // (defensive) negative computed latency that should be structurally
  // impossible if the conflict flag is honest — means the relation
  // survives but latency must be NULL, never negative (contract §10).
  const latencyFromFirst =
    firstReply.internalDateMs - (firstCreatorSent?.internalDateMs ?? Number.NaN);
  const latencyFromLatest = firstReply.latestPrecedingCreatorSentProviderMessageId
    ? firstReply.internalDateMs -
      creatorSends.find(
        (s) => s.providerMessageId === firstReply.latestPrecedingCreatorSentProviderMessageId,
      )!.internalDateMs
    : Number.NaN;

  const conflicted =
    firstReply.chronologyConflict ||
    !firstCreatorSent ||
    !Number.isFinite(latencyFromFirst) ||
    latencyFromFirst < 0 ||
    (firstReply.latestPrecedingCreatorSentProviderMessageId !== null &&
      (!Number.isFinite(latencyFromLatest) || latencyFromLatest < 0));

  const creatorSentCountBeforeFirstHumanReply = creatorSends.filter(
    (s) => s.internalDateMs < firstReply.internalDateMs,
  ).length;

  return {
    ...base,
    observationState: "qualifying_human_reply_observed",
    firstQualifyingHumanReplyProviderMessageId: firstReply.providerMessageId,
    firstQualifyingHumanReplyAtMs: firstReply.internalDateMs,
    creatorSentCountBeforeFirstHumanReply,
    latestCreatorSentBeforeReplyProviderMessageId: conflicted
      ? null
      : firstReply.latestPrecedingCreatorSentProviderMessageId,
    latencyFromFirstCreatorSentMs: conflicted ? null : latencyFromFirst,
    latencyFromLatestCreatorSentMs:
      conflicted || !firstReply.latestPrecedingCreatorSentProviderMessageId
        ? null
        : latencyFromLatest,
    replyChronologyConflict: conflicted,
    observedThroughAtMs,
  };
}

export { RELATION_RULE_VERSION, CLASSIFICATION_RULE_VERSION, TEXT_TRANSFORM_VERSION };
