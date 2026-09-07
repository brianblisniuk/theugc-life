/**
 * B06 shared types and version constants. See
 * docs/B06_GMAIL_REPLY_CHRONOLOGY_CONTRACT.md for the full contract these
 * types implement.
 */

/** V1 deterministic relationship classifier. No external model call. */
export const RELATION_RULE_VERSION = "gmail_reply_relation_rules_v1";
/** V1 deterministic human/automated/delivery classifier. No external model call. */
export const CLASSIFICATION_RULE_VERSION = "gmail_reply_classification_rules_v1";
/** V1 versioned inbound quote/signature text transform (reuses B05's primitive). */
export const TEXT_TRANSFORM_VERSION = "gmail_reply_text_transform_v1";

export type ResponseClass =
  | "creator_sent_touch"
  | "qualifying_human_reply"
  | "automated_response"
  | "delivery_status"
  | "ambiguous_inbound"
  | "not_reply";

export type RelationStatus =
  | "direct_in_reply_to"
  | "references_chain"
  | "thread_sequence_only"
  | "ambiguous_reference"
  | "no_preceding_creator_sent";

export type ObservationState =
  | "qualifying_human_reply_observed"
  | "ambiguous_response_observed"
  | "only_automated_or_delivery_observed"
  | "no_qualifying_response_observed_in_window"
  | "observation_horizon_unknown";

export type Eligibility =
  | "eligible_confirmed"
  | "eligible_qualified_machine"
  | "eligible_needs_review_advisory"
  | "not_eligible";

export type ReferenceHeaderRole = "message-id" | "in-reply-to" | "references";

export type ParticipantHeaderRole = "from" | "sender" | "reply-to";

const VERSION_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;

export function requireVersionShape(value: string, name: string): string {
  if (!VERSION_SHAPE.test(value)) {
    throw new RangeError(`${name} must match ${VERSION_SHAPE}, got ${JSON.stringify(value)}`);
  }
  return value;
}

export function requirePositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive integer, got ${value}`);
  }
  return value;
}

/** One message's identity/provenance evidence, as returned by `gmail_reply_get_thread_evidence`. */
export interface ReplyEvidenceMessage {
  providerMessageId: string;
  providerSent: boolean;
  internalDateMs: number;
  sourcePayloadSha256: string;
}

export interface ReplyEvidenceReferenceToken {
  providerMessageId: string;
  headerRole: ReferenceHeaderRole;
  tokenOrder: number;
  rawToken: string;
  parseStatus: "valid_msgid" | "malformed";
}

export interface ReplyEvidenceParticipant {
  providerMessageId: string;
  role: ParticipantHeaderRole;
  addrSpec: string | null;
  domainLower: string | null;
  parseStatus: "parsed" | "malformed" | "empty_group";
}

export interface ReplyEvidenceTextPart {
  providerMessageId: string;
  mimeType: "text/plain" | "text/html";
  decodeStatus: string;
  decodedText: string | null;
}

export interface ReplyEvidenceSubject {
  providerMessageId: string;
  rawValue: string;
}

/** Currently-stored per-message observation, as returned for staleness/reuse decisions. */
export interface CurrentMessageObservationSnapshot {
  providerMessageId: string;
  responseClass: ResponseClass;
  relationStatus: RelationStatus | null;
  isCurrentSource: boolean;
}

/** Currently-stored thread summary, as returned by `gmail_reply_get_thread_evidence`. Null means never evaluated. */
export interface CurrentThreadSummarySnapshot {
  eligibility: Eligibility;
  observationState: ObservationState;
  firstCreatorSentProviderMessageId: string | null;
  firstCreatorSentAt: string | null;
  firstQualifyingHumanReplyProviderMessageId: string | null;
  firstQualifyingHumanReplyAt: string | null;
  creatorSentCountBeforeFirstHumanReply: number | null;
  latestCreatorSentBeforeReplyProviderMessageId: string | null;
  latencyFromFirstCreatorSentMs: number | null;
  latencyFromLatestCreatorSentMs: number | null;
  replyChronologyConflict: boolean;
  observedThroughAt: string | null;
  evidenceDigest: string;
  evidenceMessageCount: number;
  relationRuleVersion: string;
  classificationRuleVersion: string;
  textTransformVersion: string;
  evaluatedAt: string;
}

export interface ThreadEvidence {
  normalizedThreadId: string;
  providerThreadId: string;
  mailAccountEmail: string | null;
  eligibility: Eligibility;
  observedThroughAt: string | null;
  messages: readonly ReplyEvidenceMessage[];
  referenceTokens: readonly ReplyEvidenceReferenceToken[];
  participants: readonly ReplyEvidenceParticipant[];
  textParts: readonly ReplyEvidenceTextPart[];
  subjects: readonly ReplyEvidenceSubject[];
  evidenceDigest: string;
  currentSummary: CurrentThreadSummarySnapshot | null;
  currentMessageObservations: readonly CurrentMessageObservationSnapshot[];
}

export interface CandidateStaleness {
  sourceStale: boolean;
  rulesStale: boolean;
}

export interface ReplyCandidate {
  normalizedThreadId: string;
  providerThreadId: string;
  eligibility: Eligibility;
  staleness: CandidateStaleness;
}

/** One message's computed relationship/classification result, ready to commit. */
export interface MessageObservationInput {
  providerMessageId: string;
  internalDateMs: number;
  sourcePayloadSha256: string;
  responseClass: ResponseClass;
  relationStatus: RelationStatus | null;
  referencedCreatorSentProviderMessageId: string | null;
  latestPrecedingCreatorSentProviderMessageId: string | null;
  chronologyConflict: boolean;
}

/** The computed thread-level summary, ready to commit. */
export interface ThreadSummaryInput {
  observationState: ObservationState;
  firstCreatorSentProviderMessageId: string | null;
  firstCreatorSentAtMs: number | null;
  firstQualifyingHumanReplyProviderMessageId: string | null;
  firstQualifyingHumanReplyAtMs: number | null;
  creatorSentCountBeforeFirstHumanReply: number | null;
  latestCreatorSentBeforeReplyProviderMessageId: string | null;
  latencyFromFirstCreatorSentMs: number | null;
  latencyFromLatestCreatorSentMs: number | null;
  replyChronologyConflict: boolean;
  observedThroughAtMs: number | null;
}

export interface ThreadInterpretation {
  messageObservations: readonly MessageObservationInput[];
  threadSummary: ThreadSummaryInput;
}
