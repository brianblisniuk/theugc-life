import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { GMAIL_NORMALIZER_VERSION, type NormalizeCandidate } from "@/lib/gmail/normalize/contract";
import { computeNormalization } from "@/lib/gmail/normalize/normalizer";
import { NormalizationStructuralError } from "@/lib/gmail/normalize/errors";

/**
 * B04's OPERATIONAL ENTRYPOINT.
 *
 * Purely local: every candidate already lives in `private.gmail_raw_messages`,
 * written by B03. This module makes ZERO Google calls, ZERO OAuth changes and
 * consumes ZERO Gmail quota — there is no lease, no authorization-revision
 * fence and no quota pacer here, because there is no network gap for one to
 * close. The only race this layer has to close is two LOCAL processes
 * computing a projection for the same raw row, or one computing while another
 * commits a new raw snapshot underneath it — and that is closed entirely
 * inside `gmail_normalize_commit_message`'s own short row lock (see 0038 §9b).
 */

export interface NormalizeDeps {
  db: ReturnType<typeof createAdminClient>;
}

export function defaultNormalizeDeps(): NormalizeDeps {
  return { db: createAdminClient() };
}

export type NormalizeMessageOutcome =
  | { result: "ok"; normalizedMessageId: string; normalizedThreadId: string }
  | { result: "already_current"; normalizedMessageId: string }
  | { result: "stale_source"; currentPayloadSha256: string }
  | { result: "source_not_found" }
  | { result: "account_deleted" }
  | { result: "not_found" }
  | { result: "structural_error"; message: string };

interface CommitResponse {
  result: string;
  normalized_message_id?: string;
  normalized_thread_id?: string;
  current_payload_sha256?: string;
}

/** Normalize and commit exactly ONE candidate row. */
export async function normalizeOneCandidate(
  deps: NormalizeDeps,
  userId: string,
  candidate: NormalizeCandidate,
): Promise<NormalizeMessageOutcome> {
  let computed;
  try {
    computed = computeNormalization(candidate.sanitized_payload);
  } catch (error) {
    if (error instanceof NormalizationStructuralError) {
      return { result: "structural_error", message: error.message };
    }
    throw error;
  }

  const { data: rawData, error } = await deps.db.rpc("gmail_normalize_commit_message", {
    p_user_id: userId,
    p_mail_account_id: candidate.mail_account_id,
    p_provider_message_id: candidate.provider_message_id,
    p_expected_source_payload_sha256: candidate.payload_sha256,
    p_normalizer_version: GMAIL_NORMALIZER_VERSION,
    p_headers: computed.headers,
    p_participants: computed.participants,
    p_reference_tokens: computed.referenceTokens,
    p_text_parts: computed.textParts,
  });

  if (error || !rawData) {
    throw new Error(`gmail_normalize_commit_message failed: ${error?.message ?? "no data"}`);
  }

  const data = rawData as CommitResponse;

  switch (data.result) {
    case "ok":
      return {
        result: "ok",
        normalizedMessageId: data.normalized_message_id!,
        normalizedThreadId: data.normalized_thread_id!,
      };
    case "already_current":
      return { result: "already_current", normalizedMessageId: data.normalized_message_id! };
    case "stale_source":
      return { result: "stale_source", currentPayloadSha256: data.current_payload_sha256! };
    case "source_not_found":
      return { result: "source_not_found" };
    case "account_deleted":
      return { result: "account_deleted" };
    case "not_found":
      return { result: "not_found" };
    default:
      throw new Error(`gmail_normalize_commit_message returned unknown result: ${data.result}`);
  }
}

interface CandidatesResponse {
  result: string;
  candidates: NormalizeCandidate[];
}

export interface NormalizeBatchSummary {
  candidatesFound: number;
  committed: number;
  alreadyCurrent: number;
  staleSource: number;
  structuralErrors: number;
  other: number;
}

/**
 * Normalize a BOUNDED BATCH of candidates for one mailbox. A candidate is a
 * raw message whose projection is absent, out of date (a different digest) or
 * stale by version — see 0038's `gmail_normalize_list_candidates`.
 */
export async function normalizeBatch(
  deps: NormalizeDeps,
  input: { userId: string; mailAccountId: string; limit: number; providerMessageId?: string },
): Promise<NormalizeBatchSummary> {
  const { data: rawData, error } = await deps.db.rpc("gmail_normalize_list_candidates", {
    p_user_id: input.userId,
    p_mail_account_id: input.mailAccountId,
    p_normalizer_version: GMAIL_NORMALIZER_VERSION,
    p_limit: input.limit,
    p_provider_message_id: input.providerMessageId ?? null,
  });

  if (error || !rawData) {
    throw new Error(`gmail_normalize_list_candidates failed: ${error?.message ?? "no data"}`);
  }

  const data = rawData as CandidatesResponse;

  const summary: NormalizeBatchSummary = {
    candidatesFound: data.candidates.length,
    committed: 0,
    alreadyCurrent: 0,
    staleSource: 0,
    structuralErrors: 0,
    other: 0,
  };

  for (const candidate of data.candidates) {
    const outcome = await normalizeOneCandidate(deps, input.userId, candidate);
    switch (outcome.result) {
      case "ok":
        summary.committed += 1;
        break;
      case "already_current":
        summary.alreadyCurrent += 1;
        break;
      case "stale_source":
        summary.staleSource += 1;
        break;
      case "structural_error":
        summary.structuralErrors += 1;
        break;
      default:
        summary.other += 1;
    }
  }

  return summary;
}

/** Normalize ALL currently stale/missing projections for a mailbox, in controlled batches. */
export async function normalizeMailboxUntilIdle(
  deps: NormalizeDeps,
  input: { userId: string; mailAccountId: string; batchSize: number },
): Promise<NormalizeBatchSummary> {
  const total: NormalizeBatchSummary = {
    candidatesFound: 0,
    committed: 0,
    alreadyCurrent: 0,
    staleSource: 0,
    structuralErrors: 0,
    other: 0,
  };

  for (;;) {
    const batch = await normalizeBatch(deps, {
      userId: input.userId,
      mailAccountId: input.mailAccountId,
      limit: input.batchSize,
    });
    total.candidatesFound += batch.candidatesFound;
    total.committed += batch.committed;
    total.alreadyCurrent += batch.alreadyCurrent;
    total.staleSource += batch.staleSource;
    total.structuralErrors += batch.structuralErrors;
    total.other += batch.other;

    if (batch.candidatesFound < input.batchSize) break;
  }

  return total;
}
