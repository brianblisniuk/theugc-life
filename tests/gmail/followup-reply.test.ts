/**
 * A stored human reply settles follow-ups. Gmail is not called.
 */
import { describe, expect, it, vi } from "vitest";

import type { createAdminClient } from "@/lib/supabase/admin";
import { interpretOneThread } from "@/lib/gmail/reply/service";
import { CORPUS, toEvidence, type CorpusCase } from "../gmail-reply/evaluation/corpus";

const USER = "d0500000-0000-4000-8000-000000000001";
const MAIL = "d0500000-0000-4000-8000-000000000010";
const THREAD = "d0500000-0000-4000-8000-000000000020";

function corpus(id: string): CorpusCase {
  const found = CORPUS.find((row) => row.id === id);
  if (!found) throw new Error(`missing corpus case ${id}`);
  return found;
}

function evidencePayload(testCase: CorpusCase) {
  const evidence = toEvidence(testCase);
  return {
    result: "ok",
    normalized_thread_id: THREAD,
    provider_thread_id: "gmail-thread-followup",
    mail_account_email: testCase.mailAccountEmail,
    eligibility: "eligible_confirmed",
    observed_through_at:
      testCase.observedThroughAtMs === null
        ? null
        : new Date(testCase.observedThroughAtMs).toISOString(),
    messages: evidence.messages.map((message) => ({
      provider_message_id: message.providerMessageId,
      provider_sent: message.providerSent,
      internal_date_ms: message.internalDateMs,
      source_payload_sha256: message.sourcePayloadSha256,
    })),
    reference_tokens: evidence.referenceTokens.map((token) => ({
      provider_message_id: token.providerMessageId,
      header_role: token.headerRole,
      token_order: token.tokenOrder,
      raw_token: token.rawToken,
      parse_status: token.parseStatus,
    })),
    participants: evidence.participants.map((participant) => ({
      provider_message_id: participant.providerMessageId,
      role: participant.role,
      addr_spec: participant.addrSpec,
      domain_lower: participant.domainLower,
      parse_status: participant.parseStatus,
    })),
    text_parts: evidence.textParts.map((part) => ({
      provider_message_id: part.providerMessageId,
      mime_type: part.mimeType,
      decode_status: part.decodeStatus,
      decoded_text: part.decodedText,
    })),
    subjects: evidence.subjects.map((subject) => ({
      provider_message_id: subject.providerMessageId,
      raw_value: subject.rawValue,
    })),
    evidence_digest: "digest-followup",
    routing_context_digest: "routing-followup",
    current_summary: null,
    current_message_observations: [],
  };
}

function deps(testCase: CorpusCase) {
  const settle = vi.fn(async (_args: Record<string, unknown>) => ({
    data: { result: "ok", stopped: 1 },
    error: null,
  }));
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "gmail_reply_get_thread_evidence") {
        return { data: evidencePayload(testCase), error: null };
      }
      if (fn === "gmail_reply_commit_interpretation") {
        return {
          data: { result: "ok", evidence_digest: "digest-followup", committed: true },
          error: null,
        };
      }
      if (fn === "gmail_followup_settle") return settle(args);
      return { data: { result: "not_found" }, error: null };
    },
  };
  return { db: db as unknown as ReturnType<typeof createAdminClient>, settle };
}

describe("a human reply settles follow-ups", () => {
  it("settles after a qualifying human reply and not after a delivery status", async () => {
    const human = deps(corpus("1-direct-in-reply-to"));
    const humanResult = await interpretOneThread(
      { db: human.db },
      { userId: USER, mailAccountId: MAIL, normalizedThreadId: THREAD },
    );
    expect(humanResult).toEqual({ result: "ok", committed: true });
    expect(human.settle).toHaveBeenCalledTimes(1);
    expect(human.settle).toHaveBeenCalledWith(expect.objectContaining({ p_user_id: USER }));

    const bounce = deps(corpus("7-delivery-failure"));
    const bounceResult = await interpretOneThread(
      { db: bounce.db },
      { userId: USER, mailAccountId: MAIL, normalizedThreadId: THREAD },
    );
    expect(bounceResult).toEqual({ result: "ok", committed: true });
    expect(bounce.settle).not.toHaveBeenCalled();
  });
});
