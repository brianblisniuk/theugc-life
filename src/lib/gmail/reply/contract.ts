/**
 * B06 shared types and version constants. See
 * docs/B06_GMAIL_REPLY_CHRONOLOGY_CONTRACT.md for the full contract these
 * types implement.
 */
import { CLASSIFIER_INPUT_TRANSFORM_VERSION as UPSTREAM_TEXT_TRANSFORM_VERSION } from "@/lib/gmail/outreach/text-transform";

/** V1 deterministic relationship classifier. No external model call. */
export const RELATION_RULE_VERSION = "gmail_reply_relation_rules_v1";
/**
 * V2 deterministic human/automated/delivery classifier. No external model
 * call. Bumped from v1 (FINAL AUDIT CORRECTION, FINDING 2): v1 compared the
 * mailbox routing address with `.toLowerCase()` alone, never trimmed,
 * while the DB's own `routing_context_digest` fingerprint already trimmed
 * it — so a routing address with incidental leading/trailing spaces could
 * report the SAME digest (no staleness) while the classifier's self/
 * external decision changed underneath it. `normalizeRoutingEmail` below is
 * now the ONE normalization both sides use, so this is a genuine,
 * reachable-input behavior change and must bump the version honestly.
 */
export const CLASSIFICATION_RULE_VERSION = "gmail_reply_classification_rules_v2";

/**
 * FINAL AUDIT CORRECTION, FINDING 2: the ONE routing-address normalization
 * B06 uses anywhere a routing address participates in classification or in
 * currentness — literally: trim only ASCII space characters from both ends
 * (never JS's broader `.trim()`, which also strips tabs/newlines/other
 * Unicode whitespace `btrim` does not), then lowercase. No Gmail dot-
 * normalization, no plus-tag stripping, no alias inference. This is the
 * EXACT TS-side mirror of the DB's `lower(btrim(email_address))` in
 * `private.gmail_reply_routing_context_digest` (Postgres `btrim` with no
 * second argument trims plain spaces only) — the two must never
 * independently define "the same routing identity" differently again.
 */
export function normalizeRoutingEmail(value: string): string {
  return value.replace(/^ +| +$/g, "").toLowerCase();
}
/**
 * V1 versioned inbound quote/signature text transform. CLOSURE PASS §20:
 * B06 reuses B05's `buildClassifierInputForMessage` transform UNCHANGED, so
 * this version string HONESTLY embeds the upstream version it depends on —
 * a future bump to `CLASSIFIER_INPUT_TRANSFORM_VERSION` changes THIS string
 * automatically, which is what makes it participate in B06's own staleness
 * checks (list_candidates/commit already compare it against what a stored
 * summary last saw). Never hand-edit the reply-specific half without also
 * considering whether the underlying B05 transform actually changed.
 */
export const TEXT_TRANSFORM_VERSION = `gmail_reply_text_transform_v1+${UPSTREAM_TEXT_TRANSFORM_VERSION}`;

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
/** Wider shape for TEXT_TRANSFORM_VERSION alone — see its own doc comment for why. */
const TEXT_TRANSFORM_VERSION_SHAPE = /^[a-z][a-z0-9_.+]{0,127}$/;

export function requireTextTransformVersionShape(value: string, name: string): string {
  if (!TEXT_TRANSFORM_VERSION_SHAPE.test(value)) {
    throw new RangeError(
      `${name} must match ${TEXT_TRANSFORM_VERSION_SHAPE}, got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

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
  /** Closure pass §17: known timestamp, ambiguous singular identity — see `ThreadSummaryInput`. */
  firstCreatorSentTied: boolean;
  firstQualifyingHumanReplyProviderMessageId: string | null;
  firstQualifyingHumanReplyAt: string | null;
  firstQualifyingHumanReplyTied: boolean;
  creatorSentCountBeforeFirstHumanReply: number | null;
  latestCreatorSentBeforeReplyProviderMessageId: string | null;
  latestCreatorSentBeforeReplyTied: boolean;
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
  /**
   * FINAL CLOSURE, BLOCKER A: sha256 fingerprint of the mailbox's own routing
   * address (lowercased/trimmed, or an explicit null sentinel) AT READ TIME.
   * The exact value `commitInterpretation` must echo back as
   * `expectedRoutingContextDigest` so the commit RPC can refuse as stale if
   * the routing address changed underneath this evaluation.
   */
  routingContextDigest: string;
  currentSummary: CurrentThreadSummarySnapshot | null;
  /** Closure pass §18/§19: true iff `currentSummary` no longer describes the CURRENT source/horizon/eligibility. */
  currentSummaryIsStale: boolean;
  currentMessageObservations: readonly CurrentMessageObservationSnapshot[];
}

export interface CandidateStaleness {
  sourceStale: boolean;
  rulesStale: boolean;
  /** Closure pass §5: the DB-authoritative observation horizon moved since the stored summary last saw it. */
  horizonStale: boolean;
  /** FINAL CLOSURE, BLOCKER A: the mailbox's own routing address changed since the stored summary last saw it. */
  routingStale: boolean;
}

export interface ReplyCandidate {
  normalizedThreadId: string;
  providerThreadId: string;
  eligibility: Eligibility;
  staleness: CandidateStaleness;
}

/**
 * One message's computed relationship/classification result. `providerSent`,
 * `internalDateMs` and `sourcePayloadSha256` are the ONLY reason `messages`
 * is threaded back through here for tests/evaluation — the commit RPC never
 * trusts a caller's copy of these (closure pass §14): it derives them itself
 * from the locked, current row. `latestPrecedingCreatorSentProviderMessageId`
 * is likewise a hint the RPC independently re-derives and does not trust;
 * kept here because it is genuinely useful stored evidence and TS's own
 * predicted `ThreadSummaryInput` (used by tests/the evaluation harness, never
 * sent to the RPC) is built from it.
 */
export interface MessageObservationInput {
  providerMessageId: string;
  internalDateMs: number;
  sourcePayloadSha256: string;
  responseClass: ResponseClass;
  relationStatus: RelationStatus | null;
  referencedCreatorSentProviderMessageId: string | null;
  /** Closure pass §17: null when there is no preceding creator send, OR when two or more tie for the latest one. */
  latestPrecedingCreatorSentProviderMessageId: string | null;
  /** The tied/unambiguous timestamp itself — populated whenever a preceding creator send exists, tied or not. */
  latestPrecedingCreatorSentAtMs: number | null;
  chronologyConflict: boolean;
}

/**
 * The PREDICTED thread-level summary — used by tests and the evaluation
 * harness to check TS's own arithmetic against gold values, and by nothing
 * else: `commitInterpretation` no longer sends this to the database. The
 * DATABASE derives and persists the actual current summary itself, from the
 * just-validated observation rows (closure pass §16) — this type exists so
 * the same, provably-matching arithmetic can be exercised and asserted on
 * without a database round-trip.
 */
export interface ThreadSummaryInput {
  observationState: ObservationState;
  firstCreatorSentProviderMessageId: string | null;
  firstCreatorSentAtMs: number | null;
  firstCreatorSentTied: boolean;
  firstQualifyingHumanReplyProviderMessageId: string | null;
  firstQualifyingHumanReplyAtMs: number | null;
  firstQualifyingHumanReplyTied: boolean;
  creatorSentCountBeforeFirstHumanReply: number | null;
  latestCreatorSentBeforeReplyProviderMessageId: string | null;
  latestCreatorSentBeforeReplyTied: boolean;
  latencyFromFirstCreatorSentMs: number | null;
  latencyFromLatestCreatorSentMs: number | null;
  replyChronologyConflict: boolean;
  observedThroughAtMs: number | null;
}

export interface ThreadInterpretation {
  messageObservations: readonly MessageObservationInput[];
  threadSummary: ThreadSummaryInput;
}
