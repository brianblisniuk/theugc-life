/**
 * A delivery-status classification on a synced thread records a bounce.
 * Gmail is not called. The database pause is covered in send-db.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

import type { createAdminClient } from "@/lib/supabase/admin";
import { interpretOneThread } from "@/lib/gmail/reply/service";
import { CORPUS, toEvidence, type CorpusCase } from "../gmail-reply/evaluation/corpus";

const USER = "d04b0000-0000-4000-8000-000000000001";
const MAIL = "d04b0000-0000-4000-8000-000000000010";
const THREAD = "d04b0000-0000-4000-8000-000000000020";

function corpus(id: string): CorpusCase {
  const found = CORPUS.find((row) => row.id === id);
  if (!found) throw new Error(`missing corpus case ${id}`);
  return found;
}

function evidencePayload(testCase: CorpusCase, providerThreadId: string) {
  const evidence = toEvidence(testCase);
  return {
    result: "ok",
    normalized_thread_id: THREAD,
    provider_thread_id: providerThreadId,
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
    evidence_digest: "digest-bounce",
    routing_context_digest: "routing-bounce",
    current_summary: null,
    current_message_observations: [],
  };
}

function deps(testCase: CorpusCase, providerThreadId: string) {
  const bounces = vi.fn(async (_args: Record<string, unknown>) => ({
    data: { result: "recorded", recorded: 1 },
    error: null,
  }));
  const classes: string[] = [];
  const db = {
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "gmail_reply_get_thread_evidence") {
        return { data: evidencePayload(testCase, providerThreadId), error: null };
      }
      if (fn === "gmail_reply_commit_interpretation") {
        const observations = args.p_message_observations as { response_class: string }[];
        classes.push(...observations.map((row) => row.response_class));
        return {
          data: { result: "ok", evidence_digest: "digest-bounce", committed: true },
          error: null,
        };
      }
      if (fn === "gmail_send_record_thread_bounces") return bounces(args);
      return { data: { result: "not_found" }, error: null };
    },
  };
  return { db: db as unknown as ReturnType<typeof createAdminClient>, bounces, classes };
}

describe("delivery status records a bounce", () => {
  it("calls the bounce recorder for a delivery_status message on a sent thread", async () => {
    const harness = deps(corpus("7-delivery-failure"), "gmail-thread-bounced");
    const result = await interpretOneThread(
      { db: harness.db },
      { userId: USER, mailAccountId: MAIL, normalizedThreadId: THREAD },
    );
    expect(result).toEqual({ result: "ok", committed: true });
    expect(harness.classes).toContain("delivery_status");
    expect(harness.bounces).toHaveBeenCalledTimes(1);
    expect(harness.bounces).toHaveBeenCalledWith({
      p_user_id: USER,
      p_mail_account_id: MAIL,
      p_provider_thread_id: "gmail-thread-bounced",
    });
  });

  it("does not record a bounce for a human reply", async () => {
    const harness = deps(corpus("8-noreply-human-text"), "gmail-thread-human");
    const result = await interpretOneThread(
      { db: harness.db },
      { userId: USER, mailAccountId: MAIL, normalizedThreadId: THREAD },
    );
    expect(result).toEqual({ result: "ok", committed: true });
    expect(harness.classes).not.toContain("delivery_status");
    expect(harness.bounces).not.toHaveBeenCalled();
  });
});
