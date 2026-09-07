import { describe, expect, it } from "vitest";

import { interpretThread } from "@/lib/gmail/reply/interpreter";
import type { ReplyEvidenceMessage } from "@/lib/gmail/reply/contract";

const DAY = 86_400_000;
const HOUR = 3_600_000;

function msg(id: string, sent: boolean, ms: number): ReplyEvidenceMessage {
  return {
    providerMessageId: id,
    providerSent: sent,
    internalDateMs: ms,
    sourcePayloadSha256: "x".repeat(64),
  };
}

describe("B06 interpreter.ts: thread-level chronology (contract §10/§16)", () => {
  it("exact contract example: Mon 10:00 send, Thu 10:00 send, Thu 14:00 reply -> 76h / 4h / count 2", () => {
    const mondaySend = 0;
    const thursdaySend = mondaySend + 3 * DAY;
    const reply = thursdaySend + 4 * HOUR;

    const result = interpretThread({
      messages: [
        msg("sent-mon", true, mondaySend),
        msg("sent-thu", true, thursdaySend),
        msg("reply", false, reply),
      ],
      referenceTokens: [
        {
          providerMessageId: "sent-thu",
          headerRole: "message-id",
          tokenOrder: 0,
          rawToken: "<t@x>",
          parseStatus: "valid_msgid",
        },
        {
          providerMessageId: "reply",
          headerRole: "in-reply-to",
          tokenOrder: 0,
          rawToken: "<t@x>",
          parseStatus: "valid_msgid",
        },
      ],
      participants: [
        {
          providerMessageId: "reply",
          role: "from",
          addrSpec: "hotel@example.com",
          domainLower: "example.com",
          parseStatus: "parsed",
        },
      ],
      subjects: [],
      textParts: [
        {
          providerMessageId: "reply",
          mimeType: "text/plain",
          decodeStatus: "decoded",
          decodedText: "Sounds great!",
        },
      ],
      mailAccountEmail: "creator@example.com",
      observedThroughAtMs: reply + DAY,
    });

    expect(result.threadSummary).toMatchObject({
      observationState: "qualifying_human_reply_observed",
      firstCreatorSentProviderMessageId: "sent-mon",
      firstQualifyingHumanReplyProviderMessageId: "reply",
      creatorSentCountBeforeFirstHumanReply: 2,
      latencyFromFirstCreatorSentMs: 76 * HOUR,
      latencyFromLatestCreatorSentMs: 4 * HOUR,
      replyChronologyConflict: false,
    });
  });

  it("an automated reply between two sends does not become the first human reply timing", () => {
    const send1 = 0;
    const autoReply = send1 + HOUR;
    const send2 = send1 + 2 * HOUR;
    const humanReply = send2 + HOUR;

    const result = interpretThread({
      messages: [
        msg("send-1", true, send1),
        msg("auto", false, autoReply),
        msg("send-2", true, send2),
        msg("human", false, humanReply),
      ],
      referenceTokens: [],
      participants: [
        {
          providerMessageId: "auto",
          role: "from",
          addrSpec: "auto@hotel.example",
          domainLower: "hotel.example",
          parseStatus: "parsed",
        },
        {
          providerMessageId: "human",
          role: "from",
          addrSpec: "person@hotel.example",
          domainLower: "hotel.example",
          parseStatus: "parsed",
        },
      ],
      subjects: [{ providerMessageId: "auto", rawValue: "Automatic reply" }],
      textParts: [
        {
          providerMessageId: "human",
          mimeType: "text/plain",
          decodeStatus: "decoded",
          decodedText: "Happy to help!",
        },
      ],
      mailAccountEmail: "creator@example.com",
      observedThroughAtMs: humanReply + DAY,
    });

    const autoObs = result.messageObservations.find((o) => o.providerMessageId === "auto")!;
    const humanObs = result.messageObservations.find((o) => o.providerMessageId === "human")!;
    expect(autoObs.responseClass).toBe("automated_response");
    expect(humanObs.responseClass).toBe("qualifying_human_reply");
    expect(result.threadSummary.firstQualifyingHumanReplyProviderMessageId).toBe("human");
    expect(result.threadSummary.creatorSentCountBeforeFirstHumanReply).toBe(2);
  });

  it("no response candidates + known horizon -> no_qualifying_response_observed_in_window, never ghosted", () => {
    const result = interpretThread({
      messages: [msg("sent-1", true, 0)],
      referenceTokens: [],
      participants: [],
      subjects: [],
      textParts: [],
      mailAccountEmail: "creator@example.com",
      observedThroughAtMs: 10 * DAY,
    });
    expect(result.threadSummary.observationState).toBe("no_qualifying_response_observed_in_window");
  });

  it("no response candidates + unknown horizon -> observation_horizon_unknown", () => {
    const result = interpretThread({
      messages: [msg("sent-1", true, 0)],
      referenceTokens: [],
      participants: [],
      subjects: [],
      textParts: [],
      mailAccountEmail: "creator@example.com",
      observedThroughAtMs: null,
    });
    expect(result.threadSummary.observationState).toBe("observation_horizon_unknown");
  });

  it("an ambiguous_inbound candidate (no reply yet) reports ambiguous_response_observed, regardless of horizon", () => {
    const result = interpretThread({
      messages: [msg("sent-1", true, 0), msg("inbound-1", false, HOUR)],
      referenceTokens: [],
      participants: [
        {
          providerMessageId: "inbound-1",
          role: "from",
          addrSpec: null,
          domainLower: null,
          parseStatus: "malformed",
        },
      ],
      subjects: [],
      textParts: [],
      mailAccountEmail: "creator@example.com",
      observedThroughAtMs: 10 * DAY,
    });
    expect(result.threadSummary.observationState).toBe("ambiguous_response_observed");
  });

  it("negative latency is never stored: a chronology-conflicted first reply nulls both clocks", () => {
    const result = interpretThread({
      messages: [msg("sent-1", true, 5000), msg("reply-1", false, 1000)],
      referenceTokens: [
        {
          providerMessageId: "sent-1",
          headerRole: "message-id",
          tokenOrder: 0,
          rawToken: "<a@x>",
          parseStatus: "valid_msgid",
        },
        {
          providerMessageId: "reply-1",
          headerRole: "in-reply-to",
          tokenOrder: 0,
          rawToken: "<a@x>",
          parseStatus: "valid_msgid",
        },
      ],
      participants: [
        {
          providerMessageId: "reply-1",
          role: "from",
          addrSpec: "hotel@example.com",
          domainLower: "example.com",
          parseStatus: "parsed",
        },
      ],
      subjects: [],
      textParts: [
        {
          providerMessageId: "reply-1",
          mimeType: "text/plain",
          decodeStatus: "decoded",
          decodedText: "hi",
        },
      ],
      mailAccountEmail: "creator@example.com",
      observedThroughAtMs: 10_000,
    });
    // chronologyConflict on the message forces ambiguous_inbound at the
    // classifier level, so no qualifying reply exists at all here — this is
    // itself the proof that a conflicted candidate can never become the
    // "first qualifying human reply" with fabricated latency.
    expect(result.threadSummary.observationState).not.toBe("qualifying_human_reply_observed");
    expect(result.threadSummary.latencyFromFirstCreatorSentMs).toBeNull();
    expect(result.threadSummary.latencyFromLatestCreatorSentMs).toBeNull();
  });
});
