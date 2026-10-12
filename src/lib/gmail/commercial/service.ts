import type { createAdminClient } from "@/lib/supabase/admin";

import {
  COMMERCIAL_RULE_VERSION,
  COMMERCIAL_SCHEMA_VERSION,
  COMMERCIAL_TRANSFORM_VERSION,
  type CommercialMessageInput,
  type ThreadCommercialMeaning,
} from "@/lib/gmail/commercial/contract";
import { CommercialStructuralError } from "@/lib/gmail/commercial/errors";
import { interpretCommercialThread } from "@/lib/gmail/commercial/rules";
import type { ReplyEvidenceTextPart } from "@/lib/gmail/reply/contract";
import { extractReplyTextForMessage } from "@/lib/gmail/reply/text-transform";

/**
 * B07 operational path. No network, no model. The database owns the digest,
 * the consent fence, and the human-history tables. This module only turns
 * already-stored text into a rules result and asks the database to commit it.
 */
export interface CommercialDeps {
  db: ReturnType<typeof createAdminClient>;
  interpretThread?: typeof interpretCommercialThread;
}

const DEADLOCK = "40P01";

export type CommercialRefusal =
  | "not_found"
  | "account_deleted"
  | "deletion_pending"
  | "consent_missing"
  | "thread_not_found"
  | "not_eligible"
  | "unauthenticated"
  | "anchor_not_found";

interface EvidenceMessage {
  provider_message_id: string;
  provider_sent: boolean;
  internal_date_ms: number;
  eligible: boolean;
}

interface EvidenceTextPart {
  provider_message_id: string;
  mime_type: "text/plain" | "text/html";
  decode_status: string;
  decoded_text: string | null;
}

interface EvidenceOk {
  result: "ok";
  provider_thread_id: string;
  input_digest: string;
  messages: EvidenceMessage[];
  text_parts: EvidenceTextPart[];
}

export async function getThreadEvidence(
  deps: CommercialDeps,
  input: { userId: string; mailAccountId: string; normalizedThreadId: string },
): Promise<{ result: "ok"; evidence: EvidenceOk } | { result: CommercialRefusal }> {
  const { data, error } = await deps.db.rpc("gmail_commercial_get_thread_evidence", {
    p_user_id: input.userId,
    p_mail_account_id: input.mailAccountId,
    p_normalized_thread_id: input.normalizedThreadId,
    p_schema_version: COMMERCIAL_SCHEMA_VERSION,
    p_transform_version: COMMERCIAL_TRANSFORM_VERSION,
    p_rule_version: COMMERCIAL_RULE_VERSION,
  });
  if (error) {
    throw new CommercialStructuralError(
      `gmail_commercial_get_thread_evidence failed: ${error.message}`,
    );
  }
  const body = data as { result: string };
  if (body.result !== "ok") {
    return { result: body.result as CommercialRefusal };
  }
  return { result: "ok", evidence: data as EvidenceOk };
}

export type CommitResult =
  | { result: "ok"; committed: boolean; inputDigest: string }
  | { result: "stale_source"; currentInputDigest: string | null }
  | { result: "commit_conflict_retry" }
  | { result: CommercialRefusal };

export async function commitInterpretation(
  deps: CommercialDeps,
  input: {
    userId: string;
    mailAccountId: string;
    normalizedThreadId: string;
    expectedInputDigest: string;
    meaning: ThreadCommercialMeaning;
  },
): Promise<CommitResult> {
  const { data, error } = await deps.db.rpc("gmail_commercial_commit_interpretation", {
    p_user_id: input.userId,
    p_mail_account_id: input.mailAccountId,
    p_normalized_thread_id: input.normalizedThreadId,
    p_schema_version: COMMERCIAL_SCHEMA_VERSION,
    p_transform_version: COMMERCIAL_TRANSFORM_VERSION,
    p_rule_version: COMMERCIAL_RULE_VERSION,
    p_expected_input_digest: input.expectedInputDigest,
    p_messages: input.meaning.messages.map((message) => ({
      provider_message_id: message.providerMessageId,
      disposition: message.disposition,
      signals: message.signals,
      evidence_strength: message.evidenceStrength,
      explicit_booking_confirmation: message.explicitBookingConfirmation,
    })),
    p_thread: {
      commercial_state: input.meaning.commercialState,
      compensation_structure: input.meaning.compensationStructure,
      evidence_strength: input.meaning.evidenceStrength,
    },
  });

  if (error?.code === DEADLOCK) return { result: "commit_conflict_retry" };
  if (error || !data) {
    throw new CommercialStructuralError(
      `gmail_commercial_commit_interpretation failed: ${error?.message ?? "no data"}`,
    );
  }

  const body = data as {
    result: string;
    input_digest?: string;
    current_input_digest?: string | null;
    committed?: boolean;
  };
  if (body.result === "stale_source") {
    return { result: "stale_source", currentInputDigest: body.current_input_digest ?? null };
  }
  if (body.result === "already_current") {
    return {
      result: "ok",
      committed: false,
      inputDigest: body.input_digest ?? input.expectedInputDigest,
    };
  }
  if (body.result === "ok") {
    return { result: "ok", committed: body.committed ?? true, inputDigest: body.input_digest! };
  }
  if (
    body.result === "not_found" ||
    body.result === "account_deleted" ||
    body.result === "deletion_pending" ||
    body.result === "consent_missing" ||
    body.result === "thread_not_found" ||
    body.result === "not_eligible"
  ) {
    return { result: body.result };
  }
  throw new CommercialStructuralError(
    `gmail_commercial_commit_interpretation returned unknown result: ${body.result}`,
  );
}

function toRuleInput(evidence: EvidenceOk): CommercialMessageInput[] {
  return evidence.messages.map((message) => {
    const parts: ReplyEvidenceTextPart[] = evidence.text_parts
      .filter(
        (part) =>
          part.provider_message_id === message.provider_message_id &&
          (part.mime_type === "text/plain" || part.mime_type === "text/html"),
      )
      .map((part) => ({
        providerMessageId: part.provider_message_id,
        mimeType: part.mime_type,
        decodeStatus: part.decode_status,
        decodedText: part.decoded_text,
      }));
    return {
      providerMessageId: message.provider_message_id,
      providerSent: message.provider_sent,
      internalDateMs: Number(message.internal_date_ms),
      cleanText: extractReplyTextForMessage(parts).cleanText,
      eligible: message.eligible,
    };
  });
}

export type InterpretOneThreadResult =
  | { result: "ok"; committed: boolean }
  | { result: CommercialRefusal }
  | { result: "stale_source_retry" };

export async function interpretOneThread(
  deps: CommercialDeps,
  input: { userId: string; mailAccountId: string; normalizedThreadId: string },
): Promise<InterpretOneThreadResult> {
  const interpret = deps.interpretThread ?? interpretCommercialThread;

  const runOnce = async (): Promise<
    { result: "ok"; committed: boolean } | { result: CommercialRefusal } | { result: "retry" }
  > => {
    const evidence = await getThreadEvidence(deps, input);
    if (evidence.result === "not_eligible") {
      // Commit is what marks an existing projection stale. Evidence itself
      // does not write. The digest is unused: not_eligible returns first.
      await commitInterpretation(deps, {
        userId: input.userId,
        mailAccountId: input.mailAccountId,
        normalizedThreadId: input.normalizedThreadId,
        expectedInputDigest: "0".repeat(64),
        meaning: {
          commercialState: null,
          compensationStructure: "unknown",
          evidenceStrength: "insufficient_evidence",
          messages: [],
        },
      });
      return { result: "not_eligible" };
    }
    if (evidence.result !== "ok") return { result: evidence.result };
    const meaning = interpret(toRuleInput(evidence.evidence));
    const committed = await commitInterpretation(deps, {
      userId: input.userId,
      mailAccountId: input.mailAccountId,
      normalizedThreadId: input.normalizedThreadId,
      expectedInputDigest: evidence.evidence.input_digest,
      meaning,
    });
    if (committed.result === "stale_source" || committed.result === "commit_conflict_retry") {
      return { result: "retry" };
    }
    if (committed.result === "ok") return { result: "ok", committed: committed.committed };
    return { result: committed.result };
  };

  const first = await runOnce();
  if (first.result !== "retry") return first;
  const second = await runOnce();
  if (second.result === "retry") return { result: "stale_source_retry" };
  return second;
}

export async function purgeForDeletion(
  deps: CommercialDeps,
  input: { userId: string; mailAccountId: string; deletionRequestId: string },
): Promise<{ result: string }> {
  const { data, error } = await deps.db.rpc("gmail_commercial_purge_for_deletion", {
    p_user_id: input.userId,
    p_mail_account_id: input.mailAccountId,
    p_deletion_request_id: input.deletionRequestId,
  });
  if (error || !data) {
    throw new CommercialStructuralError(
      `gmail_commercial_purge_for_deletion failed: ${error?.message ?? "no data"}`,
    );
  }
  return data as { result: string };
}
