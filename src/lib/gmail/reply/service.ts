import type { createAdminClient } from "@/lib/supabase/admin";
import {
  CLASSIFICATION_RULE_VERSION,
  RELATION_RULE_VERSION,
  requirePositiveInteger,
  requireTextTransformVersionShape,
  requireVersionShape,
  type CandidateStaleness,
  type CurrentMessageObservationSnapshot,
  type CurrentThreadSummarySnapshot,
  type Eligibility,
  type MessageObservationInput,
  type ObservationState,
  type ParticipantHeaderRole,
  type ReferenceHeaderRole,
  type ReplyCandidate,
  type ReplyEvidenceMessage,
  type ReplyEvidenceParticipant,
  type ReplyEvidenceReferenceToken,
  type ReplyEvidenceSubject,
  type ReplyEvidenceTextPart,
  type ResponseClass,
  type ThreadEvidence,
} from "@/lib/gmail/reply/contract";
import { ReplyStructuralError } from "@/lib/gmail/reply/errors";
import { interpretThread as interpretThreadDefault } from "@/lib/gmail/reply/interpreter";
import { TEXT_TRANSFORM_VERSION } from "@/lib/gmail/reply/text-transform";

/**
 * B06's OPERATIONAL LOGIC, deliberately WITHOUT `server-only` — see B05's
 * identical `service.ts` for why (`createAdminClient` is a TYPE-ONLY import,
 * erased at compile time, so this module runs under plain `tsx`/Node too).
 */
export interface ReplyDeps {
  db: ReturnType<typeof createAdminClient>;
  interpretThread?: typeof interpretThreadDefault;
}

export { requirePositiveInteger };

// ---------------------------------------------------------------------------
// Thread evidence
// ---------------------------------------------------------------------------

interface RawEvidenceResponse {
  result: string;
  normalized_thread_id?: string;
  provider_thread_id?: string;
  mail_account_email?: string | null;
  eligibility?: Eligibility;
  observed_through_at?: string | null;
  messages?: Array<{
    provider_message_id: string;
    provider_sent: boolean;
    internal_date_ms: number;
    source_payload_sha256: string;
  }>;
  reference_tokens?: Array<{
    provider_message_id: string;
    header_role: ReferenceHeaderRole;
    token_order: number;
    raw_token: string;
    parse_status: "valid_msgid" | "malformed";
  }>;
  participants?: Array<{
    provider_message_id: string;
    role: ParticipantHeaderRole;
    addr_spec: string | null;
    domain_lower: string | null;
    parse_status: "parsed" | "malformed" | "empty_group";
  }>;
  text_parts?: Array<{
    provider_message_id: string;
    mime_type: "text/plain" | "text/html";
    decode_status: string;
    decoded_text: string | null;
  }>;
  subjects?: Array<{ provider_message_id: string; raw_value: string }>;
  evidence_digest?: string;
  current_summary?: {
    eligibility: Eligibility;
    observation_state: ObservationState;
    first_creator_sent_provider_message_id: string | null;
    first_creator_sent_at: string | null;
    first_creator_sent_tied: boolean;
    first_qualifying_human_reply_provider_message_id: string | null;
    first_qualifying_human_reply_at: string | null;
    first_qualifying_human_reply_tied: boolean;
    creator_sent_count_before_first_human_reply: number | null;
    latest_creator_sent_before_reply_provider_message_id: string | null;
    latest_creator_sent_before_reply_tied: boolean;
    latency_from_first_creator_sent_ms: number | null;
    latency_from_latest_creator_sent_ms: number | null;
    reply_chronology_conflict: boolean;
    observed_through_at: string | null;
    evidence_digest: string;
    evidence_message_count: number;
    relation_rule_version: string;
    classification_rule_version: string;
    text_transform_version: string;
    evaluated_at: string;
  } | null;
  current_summary_is_stale?: boolean;
  current_message_observations?: Array<{
    provider_message_id: string;
    response_class: ResponseClass;
    relation_status: string | null;
    is_current_source: boolean;
  }>;
}

export type GetThreadEvidenceResult =
  | { result: "ok"; evidence: ThreadEvidence }
  | { result: "not_found" }
  | { result: "account_deleted" }
  | { result: "deletion_pending" }
  | { result: "consent_missing" };

export async function getThreadEvidence(
  deps: ReplyDeps,
  input: { userId: string; mailAccountId: string; normalizedThreadId: string },
): Promise<GetThreadEvidenceResult> {
  const { data: rawData, error } = await deps.db.rpc("gmail_reply_get_thread_evidence", {
    p_user_id: input.userId,
    p_mail_account_id: input.mailAccountId,
    p_normalized_thread_id: input.normalizedThreadId,
  });

  if (error || !rawData) {
    throw new Error(`gmail_reply_get_thread_evidence failed: ${error?.message ?? "no data"}`);
  }

  const data = rawData as RawEvidenceResponse;
  if (
    data.result === "not_found" ||
    data.result === "account_deleted" ||
    data.result === "deletion_pending" ||
    data.result === "consent_missing"
  ) {
    return { result: data.result };
  }
  if (data.result !== "ok") {
    throw new ReplyStructuralError(
      `gmail_reply_get_thread_evidence returned unknown result: ${data.result}`,
    );
  }

  const messages: ReplyEvidenceMessage[] = (data.messages ?? []).map((m) => ({
    providerMessageId: m.provider_message_id,
    providerSent: m.provider_sent,
    internalDateMs: m.internal_date_ms,
    sourcePayloadSha256: m.source_payload_sha256,
  }));

  const referenceTokens: ReplyEvidenceReferenceToken[] = (data.reference_tokens ?? []).map((t) => ({
    providerMessageId: t.provider_message_id,
    headerRole: t.header_role,
    tokenOrder: t.token_order,
    rawToken: t.raw_token,
    parseStatus: t.parse_status,
  }));

  const participants: ReplyEvidenceParticipant[] = (data.participants ?? []).map((p) => ({
    providerMessageId: p.provider_message_id,
    role: p.role,
    addrSpec: p.addr_spec,
    domainLower: p.domain_lower,
    parseStatus: p.parse_status,
  }));

  const textParts: ReplyEvidenceTextPart[] = (data.text_parts ?? []).map((tp) => ({
    providerMessageId: tp.provider_message_id,
    mimeType: tp.mime_type,
    decodeStatus: tp.decode_status,
    decodedText: tp.decoded_text,
  }));

  const subjects: ReplyEvidenceSubject[] = (data.subjects ?? []).map((s) => ({
    providerMessageId: s.provider_message_id,
    rawValue: s.raw_value,
  }));

  const currentSummary: CurrentThreadSummarySnapshot | null = data.current_summary
    ? {
        eligibility: data.current_summary.eligibility,
        observationState: data.current_summary.observation_state,
        firstCreatorSentProviderMessageId:
          data.current_summary.first_creator_sent_provider_message_id,
        firstCreatorSentAt: data.current_summary.first_creator_sent_at,
        firstCreatorSentTied: data.current_summary.first_creator_sent_tied,
        firstQualifyingHumanReplyProviderMessageId:
          data.current_summary.first_qualifying_human_reply_provider_message_id,
        firstQualifyingHumanReplyAt: data.current_summary.first_qualifying_human_reply_at,
        firstQualifyingHumanReplyTied: data.current_summary.first_qualifying_human_reply_tied,
        creatorSentCountBeforeFirstHumanReply:
          data.current_summary.creator_sent_count_before_first_human_reply,
        latestCreatorSentBeforeReplyProviderMessageId:
          data.current_summary.latest_creator_sent_before_reply_provider_message_id,
        latestCreatorSentBeforeReplyTied:
          data.current_summary.latest_creator_sent_before_reply_tied,
        latencyFromFirstCreatorSentMs: data.current_summary.latency_from_first_creator_sent_ms,
        latencyFromLatestCreatorSentMs: data.current_summary.latency_from_latest_creator_sent_ms,
        replyChronologyConflict: data.current_summary.reply_chronology_conflict,
        observedThroughAt: data.current_summary.observed_through_at,
        evidenceDigest: data.current_summary.evidence_digest,
        evidenceMessageCount: data.current_summary.evidence_message_count,
        relationRuleVersion: data.current_summary.relation_rule_version,
        classificationRuleVersion: data.current_summary.classification_rule_version,
        textTransformVersion: data.current_summary.text_transform_version,
        evaluatedAt: data.current_summary.evaluated_at,
      }
    : null;

  const currentMessageObservations: CurrentMessageObservationSnapshot[] = (
    data.current_message_observations ?? []
  ).map((o) => ({
    providerMessageId: o.provider_message_id,
    responseClass: o.response_class,
    relationStatus: o.relation_status as CurrentMessageObservationSnapshot["relationStatus"],
    isCurrentSource: o.is_current_source,
  }));

  return {
    result: "ok",
    evidence: {
      normalizedThreadId: data.normalized_thread_id!,
      providerThreadId: data.provider_thread_id!,
      mailAccountEmail: data.mail_account_email ?? null,
      eligibility: data.eligibility!,
      observedThroughAt: data.observed_through_at ?? null,
      messages,
      referenceTokens,
      participants,
      textParts,
      subjects,
      evidenceDigest: data.evidence_digest!,
      currentSummary,
      currentSummaryIsStale: data.current_summary_is_stale ?? false,
      currentMessageObservations,
    },
  };
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

/** The Postgres SQLSTATE for `deadlock_detected` — see the migration's own commit-function header comment. */
const DEADLOCK_DETECTED_SQLSTATE = "40P01";

export type CommitInterpretationResult =
  | { result: "ok"; evidenceDigest: string }
  | { result: "not_found" }
  | { result: "account_deleted" }
  | { result: "deletion_pending" }
  | { result: "consent_missing" }
  | { result: "thread_not_found" }
  | { result: "not_eligible" }
  | { result: "stale_source"; currentEvidenceDigest: string | null }
  | { result: "commit_conflict_retry" };

export async function commitInterpretation(
  deps: ReplyDeps,
  input: {
    userId: string;
    mailAccountId: string;
    normalizedThreadId: string;
    expectedEvidenceDigest: string;
    messageObservations: readonly MessageObservationInput[];
  },
): Promise<CommitInterpretationResult> {
  requireVersionShape(RELATION_RULE_VERSION, "RELATION_RULE_VERSION");
  requireVersionShape(CLASSIFICATION_RULE_VERSION, "CLASSIFICATION_RULE_VERSION");
  requireTextTransformVersionShape(TEXT_TRANSFORM_VERSION, "TEXT_TRANSFORM_VERSION");

  const { data: rawData, error } = await deps.db.rpc("gmail_reply_commit_interpretation", {
    p_user_id: input.userId,
    p_mail_account_id: input.mailAccountId,
    p_normalized_thread_id: input.normalizedThreadId,
    p_relation_version: RELATION_RULE_VERSION,
    p_classification_version: CLASSIFICATION_RULE_VERSION,
    p_text_transform_version: TEXT_TRANSFORM_VERSION,
    p_expected_evidence_digest: input.expectedEvidenceDigest,
    // CLOSURE PASS §14: only genuinely TS-owned SEMANTIC interpretation is
    // sent. `internal_date_ms`, `source_payload_sha256`,
    // `latest_preceding_creator_sent_*` and `chronology_conflict` are all
    // DB-DERIVED from the locked, current message row now — sending a
    // caller copy of them would only invite a caller to lie about a literal
    // fact the database already knows, so they are not part of this payload
    // at all any more.
    p_message_observations: input.messageObservations.map((o) => ({
      provider_message_id: o.providerMessageId,
      response_class: o.responseClass,
      relation_status: o.relationStatus,
      referenced_creator_sent_provider_message_id: o.referencedCreatorSentProviderMessageId,
    })),
  });

  // CLOSURE PASS §6: two concurrent commits on the SAME mail account can hit
  // the one live self-deadlock the new `for update` fence creates (see the
  // migration's own header comment on this function) — Postgres aborts one
  // side with `40P01`. Treated exactly like `stale_source`: the caller
  // re-reads fresh evidence and retries the whole cycle.
  if (error?.code === DEADLOCK_DETECTED_SQLSTATE) {
    return { result: "commit_conflict_retry" };
  }

  if (error || !rawData) {
    throw new Error(`gmail_reply_commit_interpretation failed: ${error?.message ?? "no data"}`);
  }

  const data = rawData as {
    result: string;
    evidence_digest?: string;
    current_evidence_digest?: string | null;
  };

  if (
    data.result === "not_found" ||
    data.result === "account_deleted" ||
    data.result === "deletion_pending" ||
    data.result === "consent_missing" ||
    data.result === "thread_not_found" ||
    data.result === "not_eligible"
  ) {
    return { result: data.result };
  }
  if (data.result === "stale_source") {
    return { result: "stale_source", currentEvidenceDigest: data.current_evidence_digest ?? null };
  }
  if (data.result !== "ok") {
    throw new ReplyStructuralError(
      `gmail_reply_commit_interpretation returned unknown result: ${data.result}`,
    );
  }

  return { result: "ok", evidenceDigest: data.evidence_digest! };
}

// ---------------------------------------------------------------------------
// interpretOneThread — the whole read -> evaluate -> commit cycle for one thread
// ---------------------------------------------------------------------------

export type InterpretOneThreadResult =
  | { result: "ok"; committed: boolean }
  | { result: "not_found" }
  | { result: "account_deleted" }
  | { result: "deletion_pending" }
  | { result: "consent_missing" }
  | { result: "not_eligible" }
  | { result: "thread_not_found" }
  | { result: "stale_source_retry" };

export async function interpretOneThread(
  deps: ReplyDeps,
  input: { userId: string; mailAccountId: string; normalizedThreadId: string },
): Promise<InterpretOneThreadResult> {
  const evidenceResult = await getThreadEvidence(deps, input);
  if (evidenceResult.result !== "ok") {
    return { result: evidenceResult.result };
  }
  const { evidence } = evidenceResult;

  if (evidence.eligibility === "not_eligible") {
    return { result: "not_eligible" };
  }

  const interpretThreadFn = deps.interpretThread ?? interpretThreadDefault;
  const interpretation = interpretThreadFn({
    messages: evidence.messages,
    referenceTokens: evidence.referenceTokens,
    participants: evidence.participants,
    subjects: evidence.subjects,
    textParts: evidence.textParts,
    mailAccountEmail: evidence.mailAccountEmail,
    observedThroughAtMs: evidence.observedThroughAt ? Date.parse(evidence.observedThroughAt) : null,
  });

  const commitResult = await commitInterpretation(deps, {
    userId: input.userId,
    mailAccountId: input.mailAccountId,
    normalizedThreadId: input.normalizedThreadId,
    expectedEvidenceDigest: evidence.evidenceDigest,
    messageObservations: interpretation.messageObservations,
  });

  if (commitResult.result === "stale_source" || commitResult.result === "commit_conflict_retry") {
    return { result: "stale_source_retry" };
  }
  if (commitResult.result === "ok") {
    return { result: "ok", committed: true };
  }
  return { result: commitResult.result };
}

// ---------------------------------------------------------------------------
// List candidates + bounded worker
// ---------------------------------------------------------------------------

export async function listCandidates(
  deps: ReplyDeps,
  input: {
    userId: string;
    mailAccountId: string;
    limit: number;
    excludeNormalizedThreadIds?: readonly string[];
  },
): Promise<{ result: string; candidates: readonly ReplyCandidate[] }> {
  const limit = requirePositiveInteger(input.limit, "limit");

  const { data: rawData, error } = await deps.db.rpc("gmail_reply_list_candidates", {
    p_user_id: input.userId,
    p_mail_account_id: input.mailAccountId,
    p_relation_version: RELATION_RULE_VERSION,
    p_classification_version: CLASSIFICATION_RULE_VERSION,
    p_text_transform_version: TEXT_TRANSFORM_VERSION,
    p_limit: limit,
    p_exclude_normalized_thread_ids: input.excludeNormalizedThreadIds ?? [],
  });

  if (error || !rawData) {
    throw new Error(`gmail_reply_list_candidates failed: ${error?.message ?? "no data"}`);
  }

  const data = rawData as {
    result: string;
    candidates?: Array<{
      normalized_thread_id: string;
      provider_thread_id: string;
      eligibility: Eligibility;
      source_stale: boolean;
      rules_stale: boolean;
      horizon_stale: boolean;
    }>;
  };

  const candidates: ReplyCandidate[] = (data.candidates ?? []).map((c) => ({
    normalizedThreadId: c.normalized_thread_id,
    providerThreadId: c.provider_thread_id,
    eligibility: c.eligibility,
    staleness: {
      sourceStale: c.source_stale,
      rulesStale: c.rules_stale,
      horizonStale: c.horizon_stale,
    } satisfies CandidateStaleness,
  }));

  return { result: data.result, candidates };
}

export interface InterpretBatchSummary {
  attempted: number;
  committed: number;
  retried: number;
  notEligible: number;
  otherResults: number;
}

/** Bounded local runner (contract §24) — no Gmail network I/O, idempotent. */
export async function interpretUntilIdle(
  deps: ReplyDeps,
  input: { userId: string; mailAccountId: string; maxThreads: number },
): Promise<InterpretBatchSummary> {
  const maxThreads = requirePositiveInteger(input.maxThreads, "maxThreads");
  const summary: InterpretBatchSummary = {
    attempted: 0,
    committed: 0,
    retried: 0,
    notEligible: 0,
    otherResults: 0,
  };

  const excluded: string[] = [];

  for (let i = 0; i < maxThreads; i++) {
    const { candidates } = await listCandidates(deps, {
      userId: input.userId,
      mailAccountId: input.mailAccountId,
      limit: 1,
      excludeNormalizedThreadIds: excluded,
    });
    const candidate = candidates[0];
    if (!candidate) break;

    summary.attempted += 1;
    const outcome = await interpretOneThread(deps, {
      userId: input.userId,
      mailAccountId: input.mailAccountId,
      normalizedThreadId: candidate.normalizedThreadId,
    });

    if (outcome.result === "ok") {
      summary.committed += 1;
    } else if (outcome.result === "stale_source_retry") {
      summary.retried += 1;
      // Retry immediately without excluding — the next list_candidates call
      // will re-offer it with fresh evidence.
      continue;
    } else if (outcome.result === "not_eligible") {
      summary.notEligible += 1;
    } else {
      summary.otherResults += 1;
    }

    excluded.push(candidate.normalizedThreadId);
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Status + deletion purge
// ---------------------------------------------------------------------------

export interface ReplyStatusCounts {
  messageObservations: number;
  threadSummaries: number;
  qualifyingHumanReplyObserved: number;
  ambiguousResponseObserved: number;
  onlyAutomatedOrDeliveryObserved: number;
  noQualifyingResponseObservedInWindow: number;
  observationHorizonUnknown: number;
  /** Closure pass §18/§19: retained summaries whose source/horizon/eligibility has since moved. */
  staleThreadSummaries: number;
}

export async function getStatus(
  deps: ReplyDeps,
  input: { userId: string; mailAccountId: string },
): Promise<ReplyStatusCounts> {
  const { data: rawData, error } = await deps.db.rpc("gmail_reply_status", {
    p_user_id: input.userId,
    p_mail_account_id: input.mailAccountId,
  });

  if (error || !rawData) {
    throw new Error(`gmail_reply_status failed: ${error?.message ?? "no data"}`);
  }

  const data = rawData as {
    message_observations: number;
    thread_summaries: number;
    qualifying_human_reply_observed: number;
    ambiguous_response_observed: number;
    only_automated_or_delivery_observed: number;
    no_qualifying_response_observed_in_window: number;
    observation_horizon_unknown: number;
    stale_thread_summaries: number;
  };

  return {
    messageObservations: data.message_observations,
    threadSummaries: data.thread_summaries,
    qualifyingHumanReplyObserved: data.qualifying_human_reply_observed,
    ambiguousResponseObserved: data.ambiguous_response_observed,
    onlyAutomatedOrDeliveryObserved: data.only_automated_or_delivery_observed,
    noQualifyingResponseObservedInWindow: data.no_qualifying_response_observed_in_window,
    observationHorizonUnknown: data.observation_horizon_unknown,
    staleThreadSummaries: data.stale_thread_summaries,
  };
}

export async function purgeForDeletion(
  deps: ReplyDeps,
  input: { userId: string; mailAccountId: string; deletionRequestId: string },
): Promise<{
  result: string;
  messageObservationsRemoved?: number;
  threadSummariesRemoved?: number;
}> {
  const { data: rawData, error } = await deps.db.rpc("gmail_reply_purge_for_deletion", {
    p_user_id: input.userId,
    p_mail_account_id: input.mailAccountId,
    p_deletion_request_id: input.deletionRequestId,
  });

  if (error || !rawData) {
    throw new Error(`gmail_reply_purge_for_deletion failed: ${error?.message ?? "no data"}`);
  }

  const data = rawData as {
    result: string;
    message_observations_removed?: number;
    thread_summaries_removed?: number;
  };

  return {
    result: data.result,
    messageObservationsRemoved: data.message_observations_removed,
    threadSummariesRemoved: data.thread_summaries_removed,
  };
}
