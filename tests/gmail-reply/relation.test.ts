import { describe, expect, it } from "vitest";

import { computeRelations } from "@/lib/gmail/reply/relation";
import type { ReplyEvidenceMessage, ReplyEvidenceReferenceToken } from "@/lib/gmail/reply/contract";

function msg(id: string, sent: boolean, ms: number): ReplyEvidenceMessage {
  return {
    providerMessageId: id,
    providerSent: sent,
    internalDateMs: ms,
    sourcePayloadSha256: "x".repeat(64),
  };
}

function ref(
  id: string,
  role: ReplyEvidenceReferenceToken["headerRole"],
  token: string,
  order = 0,
): ReplyEvidenceReferenceToken {
  return {
    providerMessageId: id,
    headerRole: role,
    tokenOrder: order,
    rawToken: token,
    parseStatus: "valid_msgid",
  };
}

describe("B06 relation.ts: reply-relationship evidence (contract §7)", () => {
  it("direct_in_reply_to: an unambiguous In-Reply-To token maps to one creator-sent message", () => {
    const messages = [msg("sent-1", true, 1000), msg("reply-1", false, 2000)];
    const tokens = [ref("sent-1", "message-id", "<a@x>"), ref("reply-1", "in-reply-to", "<a@x>")];
    const result = computeRelations(messages, tokens);
    expect(result.get("reply-1")).toMatchObject({
      relationStatus: "direct_in_reply_to",
      referencedCreatorSentProviderMessageId: "sent-1",
      chronologyConflict: false,
    });
  });

  it("references_chain: no direct parent, but References contains an unambiguous creator-sent token", () => {
    const messages = [msg("sent-1", true, 1000), msg("reply-1", false, 2000)];
    const tokens = [
      ref("sent-1", "message-id", "<a@x>"),
      ref("reply-1", "in-reply-to", "<nomatch@x>"),
      ref("reply-1", "references", "<a@x>"),
    ];
    const result = computeRelations(messages, tokens);
    expect(result.get("reply-1")).toMatchObject({
      relationStatus: "references_chain",
      referencedCreatorSentProviderMessageId: "sent-1",
    });
  });

  it("thread_sequence_only: same thread, strictly later internal_date, no contradictory reference evidence", () => {
    const messages = [msg("sent-1", true, 1000), msg("reply-1", false, 2000)];
    const result = computeRelations(messages, []);
    expect(result.get("reply-1")).toMatchObject({
      relationStatus: "thread_sequence_only",
      referencedCreatorSentProviderMessageId: null,
      latestPrecedingCreatorSentProviderMessageId: "sent-1",
    });
  });

  it("no_preceding_creator_sent: inbound message precedes every creator-sent touch", () => {
    const messages = [msg("inbound-1", false, 500), msg("sent-1", true, 1000)];
    const result = computeRelations(messages, []);
    expect(result.get("inbound-1")).toMatchObject({
      relationStatus: "no_preceding_creator_sent",
      referencedCreatorSentProviderMessageId: null,
      latestPrecedingCreatorSentProviderMessageId: null,
    });
  });

  it("ambiguous_reference: a duplicate Message-ID across two creator-sent messages prevents one honest match", () => {
    const messages = [
      msg("sent-1", true, 1000),
      msg("sent-2", true, 1500),
      msg("reply-1", false, 2000),
    ];
    const tokens = [
      ref("sent-1", "message-id", "<dup@x>"),
      ref("sent-2", "message-id", "<dup@x>"),
      ref("reply-1", "in-reply-to", "<dup@x>"),
    ];
    const result = computeRelations(messages, tokens);
    expect(result.get("reply-1")).toMatchObject({
      relationStatus: "ambiguous_reference",
      referencedCreatorSentProviderMessageId: null,
    });
  });

  it("ambiguous_reference: In-Reply-To resolves to two DIFFERENT creator-sent messages via separate tokens", () => {
    const messages = [
      msg("sent-1", true, 1000),
      msg("sent-2", true, 1500),
      msg("reply-1", false, 2000),
    ];
    const tokens = [
      ref("sent-1", "message-id", "<a@x>"),
      ref("sent-2", "message-id", "<b@x>"),
      ref("reply-1", "in-reply-to", "<a@x>", 0),
      ref("reply-1", "in-reply-to", "<b@x>", 1),
    ];
    const result = computeRelations(messages, tokens);
    expect(result.get("reply-1")!.relationStatus).toBe("ambiguous_reference");
  });

  it("chronology conflict: reference evidence says reply, but internal_date places it before its referenced send", () => {
    const messages = [msg("sent-1", true, 5000), msg("reply-1", false, 1000)];
    const tokens = [ref("sent-1", "message-id", "<a@x>"), ref("reply-1", "in-reply-to", "<a@x>")];
    const result = computeRelations(messages, tokens);
    expect(result.get("reply-1")).toMatchObject({
      relationStatus: "direct_in_reply_to",
      referencedCreatorSentProviderMessageId: "sent-1",
      chronologyConflict: true,
    });
  });

  it("equal timestamp: does not treat a tie as a preceding creator send (no invented elapsed order)", () => {
    const messages = [msg("sent-1", true, 1000), msg("reply-1", false, 1000)];
    const result = computeRelations(messages, []);
    expect(result.get("reply-1")).toMatchObject({
      relationStatus: "no_preceding_creator_sent",
      latestPrecedingCreatorSentProviderMessageId: null,
    });
  });

  it("two creator sends then a reply: latest-preceding is the LATER of the two, not the first", () => {
    const messages = [
      msg("sent-1", true, 1000),
      msg("sent-2", true, 5000),
      msg("reply-1", false, 9000),
    ];
    const result = computeRelations(messages, []);
    expect(result.get("reply-1")).toMatchObject({
      relationStatus: "thread_sequence_only",
      latestPrecedingCreatorSentProviderMessageId: "sent-2",
    });
  });
});
