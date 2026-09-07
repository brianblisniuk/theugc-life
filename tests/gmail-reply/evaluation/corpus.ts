import type {
  ObservationState,
  RelationStatus,
  ReplyEvidenceMessage,
  ReplyEvidenceParticipant,
  ReplyEvidenceReferenceToken,
  ReplyEvidenceSubject,
  ReplyEvidenceTextPart,
  ResponseClass,
} from "@/lib/gmail/reply/contract";

/**
 * B06 SYNTHETIC EVALUATION CORPUS — hand-labeled, adversarial. Covers
 * docs/B06_GMAIL_REPLY_CHRONOLOGY_CONTRACT.md §17 items 1-17 (items 18-22 are
 * consent/deletion/eligibility/CRM-boundary concerns, proven instead on real
 * Postgres by tests/gmail-reply/db-core.test.ts and concurrency.test.ts —
 * exactly the same split B05's own evaluation harness uses for its
 * real-end-to-end cases). Explicitly NOT a production gold-label table
 * (D071, contract §17) — synthetic metrics are implementation-correctness
 * checks, never a real-world accuracy claim.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;

export interface CorpusMessage {
  id: string;
  sent: boolean;
  atMs: number;
  from?: string;
  /** Closure pass §9: more than one "from" occurrence, e.g. repeated/conflicting evidence. Overrides `from` when set. */
  froms?: readonly string[];
  messageId?: string;
  /** Additional Message-ID declarations from OTHER local messages sharing the same literal token — closure pass §11. */
  extraMessageIdOwners?: readonly { ownerId: string; token: string }[];
  inReplyTo?: string;
  references?: string;
  subject?: string;
  /** Closure pass §10: more than one Subject occurrence. Overrides `subject` when set. */
  subjects?: readonly string[];
  bodyText?: string;
  /** Gold labels — required for every non-SENT message. */
  goldResponseClass?: ResponseClass;
  goldRelationStatus?: RelationStatus;
}

export interface CorpusCase {
  id: string;
  description: string;
  messages: readonly CorpusMessage[];
  mailAccountEmail: string | null;
  observedThroughAtMs: number | null;
  goldObservationState: ObservationState;
  goldLatencyFromFirstCreatorSentMs?: number | null;
  goldLatencyFromLatestCreatorSentMs?: number | null;
  goldCreatorSentCountBeforeFirstHumanReply?: number | null;
}

const CREATOR_EMAIL = "creator@example.com";

export const CORPUS: readonly CorpusCase[] = [
  {
    id: "1-direct-in-reply-to",
    description: "direct human reply using In-Reply-To",
    messages: [
      { id: "s1", sent: true, atMs: 0, messageId: "<s1@creator.example>", subject: "Collab?" },
      {
        id: "r1",
        sent: false,
        atMs: 2 * HOUR,
        from: "manager@hotel.example",
        inReplyTo: "<s1@creator.example>",
        subject: "Re: Collab?",
        bodyText: "Yes, let's talk!",
        goldResponseClass: "qualifying_human_reply",
        goldRelationStatus: "direct_in_reply_to",
      },
    ],
    mailAccountEmail: CREATOR_EMAIL,
    observedThroughAtMs: 5 * DAY,
    goldObservationState: "qualifying_human_reply_observed",
    goldLatencyFromFirstCreatorSentMs: 2 * HOUR,
    goldLatencyFromLatestCreatorSentMs: 2 * HOUR,
    goldCreatorSentCountBeforeFirstHumanReply: 1,
  },
  {
    id: "2-references-only",
    description: "human reply with only References (no direct In-Reply-To match)",
    messages: [
      { id: "s1", sent: true, atMs: 0, messageId: "<s1@creator.example>", subject: "Collab?" },
      {
        id: "r1",
        sent: false,
        atMs: 3 * HOUR,
        from: "manager@hotel.example",
        inReplyTo: "<unrelated@somewhere.example>",
        references: "<s1@creator.example>",
        subject: "Re: Collab?",
        bodyText: "Sounds interesting.",
        goldResponseClass: "qualifying_human_reply",
        goldRelationStatus: "references_chain",
      },
    ],
    mailAccountEmail: CREATOR_EMAIL,
    observedThroughAtMs: 5 * DAY,
    goldObservationState: "qualifying_human_reply_observed",
    goldLatencyFromFirstCreatorSentMs: 3 * HOUR,
    goldLatencyFromLatestCreatorSentMs: 3 * HOUR,
    goldCreatorSentCountBeforeFirstHumanReply: 1,
  },
  {
    id: "3-thread-sequence-missing-references",
    description: "human reply in same thread with missing reference headers",
    messages: [
      { id: "s1", sent: true, atMs: 0, subject: "Collab?" },
      {
        id: "r1",
        sent: false,
        atMs: HOUR,
        from: "manager@hotel.example",
        subject: "Re: Collab?",
        bodyText: "Happy to chat.",
        goldResponseClass: "qualifying_human_reply",
        goldRelationStatus: "thread_sequence_only",
      },
    ],
    mailAccountEmail: CREATOR_EMAIL,
    observedThroughAtMs: 5 * DAY,
    goldObservationState: "qualifying_human_reply_observed",
    goldLatencyFromFirstCreatorSentMs: HOUR,
    goldLatencyFromLatestCreatorSentMs: HOUR,
    goldCreatorSentCountBeforeFirstHumanReply: 1,
  },
  {
    id: "4-inbound-before-any-send",
    description: "inbound message before any creator send -> not_reply",
    messages: [
      {
        id: "r1",
        sent: false,
        atMs: 0,
        from: "someone@hotel.example",
        subject: "Hello",
        bodyText: "hi there",
        goldResponseClass: "not_reply",
        goldRelationStatus: "no_preceding_creator_sent",
      },
      { id: "s1", sent: true, atMs: HOUR, subject: "Collab?" },
    ],
    mailAccountEmail: CREATOR_EMAIL,
    observedThroughAtMs: 5 * DAY,
    goldObservationState: "no_qualifying_response_observed_in_window",
  },
  {
    id: "5-explicit-ooo",
    description: "explicit out-of-office -> automated_response",
    messages: [
      { id: "s1", sent: true, atMs: 0, subject: "Collab?" },
      {
        id: "r1",
        sent: false,
        atMs: HOUR,
        from: "person@hotel.example",
        subject: "Automatic Reply: Out of Office",
        bodyText: "I am out of office until Monday.",
        goldResponseClass: "automated_response",
        goldRelationStatus: "thread_sequence_only",
      },
    ],
    mailAccountEmail: CREATOR_EMAIL,
    observedThroughAtMs: 5 * DAY,
    goldObservationState: "only_automated_or_delivery_observed",
  },
  {
    id: "6-automatic-acknowledgement",
    description: "automatic acknowledgement -> automated_response (explicit evidence)",
    messages: [
      { id: "s1", sent: true, atMs: 0, subject: "Collab?" },
      {
        id: "r1",
        sent: false,
        atMs: HOUR,
        from: "noreply@hotel.example",
        subject: "Automatic acknowledgement of your message",
        bodyText: "This is an automatic acknowledgement.",
        goldResponseClass: "automated_response",
        goldRelationStatus: "thread_sequence_only",
      },
    ],
    mailAccountEmail: CREATOR_EMAIL,
    observedThroughAtMs: 5 * DAY,
    goldObservationState: "only_automated_or_delivery_observed",
  },
  {
    id: "7-delivery-failure",
    description: "delivery failure / bounce -> delivery_status",
    messages: [
      { id: "s1", sent: true, atMs: 0, subject: "Collab?" },
      {
        id: "r1",
        sent: false,
        atMs: 10 * 60_000,
        from: "mailer-daemon@hotel.example",
        subject: "Undeliverable: Collab?",
        bodyText: "Delivery has failed for the following recipients.",
        goldResponseClass: "delivery_status",
        goldRelationStatus: "thread_sequence_only",
      },
    ],
    mailAccountEmail: CREATOR_EMAIL,
    observedThroughAtMs: 5 * DAY,
    goldObservationState: "only_automated_or_delivery_observed",
  },
  {
    id: "8-noreply-human-text",
    description: "noreply@ with otherwise human-looking text -> not automatically automated",
    messages: [
      { id: "s1", sent: true, atMs: 0, subject: "Collab?" },
      {
        id: "r1",
        sent: false,
        atMs: HOUR,
        from: "noreply@hotel.example",
        subject: "Re: Collab?",
        bodyText: "Thanks for reaching out, I would love to collaborate on this!",
        goldResponseClass: "qualifying_human_reply",
        goldRelationStatus: "thread_sequence_only",
      },
    ],
    mailAccountEmail: CREATOR_EMAIL,
    observedThroughAtMs: 5 * DAY,
    goldObservationState: "qualifying_human_reply_observed",
    goldLatencyFromFirstCreatorSentMs: HOUR,
    goldLatencyFromLatestCreatorSentMs: HOUR,
    goldCreatorSentCountBeforeFirstHumanReply: 1,
  },
  {
    id: "9-quoted-automatic-reply-text",
    description:
      "quoted 'automatic reply' text inside a real human reply -> quote cannot trigger automation",
    messages: [
      { id: "s1", sent: true, atMs: 0, subject: "Collab?" },
      {
        id: "r1",
        sent: false,
        atMs: HOUR,
        from: "person@hotel.example",
        subject: "Re: Collab?",
        bodyText: "Sounds great, let's do it!\n\nOn Mon wrote:\n> this is an automatic reply",
        goldResponseClass: "qualifying_human_reply",
        goldRelationStatus: "thread_sequence_only",
      },
    ],
    mailAccountEmail: CREATOR_EMAIL,
    observedThroughAtMs: 5 * DAY,
    goldObservationState: "qualifying_human_reply_observed",
    goldLatencyFromFirstCreatorSentMs: HOUR,
    goldLatencyFromLatestCreatorSentMs: HOUR,
    goldCreatorSentCountBeforeFirstHumanReply: 1,
  },
  {
    id: "10-malformed-from",
    description: "malformed/missing From -> ambiguous_inbound",
    messages: [
      { id: "s1", sent: true, atMs: 0, subject: "Collab?" },
      {
        id: "r1",
        sent: false,
        atMs: HOUR,
        subject: "Re: Collab?",
        bodyText: "hello",
        goldResponseClass: "ambiguous_inbound",
        goldRelationStatus: "thread_sequence_only",
      },
    ],
    mailAccountEmail: CREATOR_EMAIL,
    observedThroughAtMs: 5 * DAY,
    goldObservationState: "ambiguous_response_observed",
  },
  {
    id: "11-two-sends-then-reply",
    description: "creator sends twice, then human replies -> exact two clocks + creator-sent count",
    messages: [
      { id: "s1", sent: true, atMs: 0, subject: "Collab?" },
      {
        id: "s2",
        sent: true,
        atMs: 3 * DAY,
        messageId: "<s2@creator.example>",
        subject: "Following up",
      },
      {
        id: "r1",
        sent: false,
        atMs: 3 * DAY + 4 * HOUR,
        from: "person@hotel.example",
        inReplyTo: "<s2@creator.example>",
        subject: "Re: Following up",
        bodyText: "Sounds great!",
        goldResponseClass: "qualifying_human_reply",
        goldRelationStatus: "direct_in_reply_to",
      },
    ],
    mailAccountEmail: CREATOR_EMAIL,
    observedThroughAtMs: 10 * DAY,
    goldObservationState: "qualifying_human_reply_observed",
    goldLatencyFromFirstCreatorSentMs: 3 * DAY + 4 * HOUR,
    goldLatencyFromLatestCreatorSentMs: 4 * HOUR,
    goldCreatorSentCountBeforeFirstHumanReply: 2,
  },
  {
    id: "12-auto-reply-between-sends",
    description:
      "creator sends, automated reply arrives, creator sends again, human replies -> first human timing only",
    messages: [
      { id: "s1", sent: true, atMs: 0, subject: "Collab?" },
      {
        id: "auto1",
        sent: false,
        atMs: HOUR,
        from: "auto@hotel.example",
        subject: "Automatic reply",
        bodyText: "This is an automatic reply, out of office.",
        goldResponseClass: "automated_response",
        goldRelationStatus: "thread_sequence_only",
      },
      { id: "s2", sent: true, atMs: 2 * HOUR, subject: "Following up" },
      {
        id: "r1",
        sent: false,
        atMs: 5 * HOUR,
        from: "person@hotel.example",
        subject: "Re: Following up",
        bodyText: "Happy to help!",
        goldResponseClass: "qualifying_human_reply",
        goldRelationStatus: "thread_sequence_only",
      },
    ],
    mailAccountEmail: CREATOR_EMAIL,
    observedThroughAtMs: 10 * DAY,
    goldObservationState: "qualifying_human_reply_observed",
    goldLatencyFromFirstCreatorSentMs: 5 * HOUR,
    goldLatencyFromLatestCreatorSentMs: 3 * HOUR,
    goldCreatorSentCountBeforeFirstHumanReply: 2,
  },
  {
    id: "13-duplicate-message-id",
    description: "duplicate/repeated Message-ID evidence -> no silent parent selection",
    messages: [
      { id: "s1", sent: true, atMs: 0, messageId: "<dup@creator.example>", subject: "Collab?" },
      {
        id: "s2",
        sent: true,
        atMs: HOUR,
        messageId: "<dup@creator.example>",
        subject: "Collab? (2)",
      },
      {
        id: "r1",
        sent: false,
        atMs: 2 * HOUR,
        from: "person@hotel.example",
        inReplyTo: "<dup@creator.example>",
        subject: "Re: Collab?",
        bodyText: "Sure!",
        goldResponseClass: "ambiguous_inbound",
        goldRelationStatus: "ambiguous_reference",
      },
    ],
    mailAccountEmail: CREATOR_EMAIL,
    observedThroughAtMs: 5 * DAY,
    goldObservationState: "ambiguous_response_observed",
  },
  {
    id: "14-reference-timestamp-contradiction",
    description: "reference/timestamp contradiction -> relation survives, latency conflicted",
    messages: [
      { id: "s1", sent: true, atMs: 5000, messageId: "<s1@creator.example>", subject: "Collab?" },
      {
        id: "r1",
        sent: false,
        atMs: 1000,
        from: "person@hotel.example",
        inReplyTo: "<s1@creator.example>",
        subject: "Re: Collab?",
        bodyText: "Sure!",
        goldResponseClass: "ambiguous_inbound",
        goldRelationStatus: "direct_in_reply_to",
      },
    ],
    mailAccountEmail: CREATOR_EMAIL,
    observedThroughAtMs: 5 * DAY,
    goldObservationState: "ambiguous_response_observed",
  },
  {
    id: "15-equal-timestamp-tie",
    description: "equal timestamp tie -> no invented elapsed ordering",
    messages: [
      { id: "s1", sent: true, atMs: 1000, subject: "Collab?" },
      {
        id: "r1",
        sent: false,
        atMs: 1000,
        from: "person@hotel.example",
        subject: "Re: Collab?",
        bodyText: "Sure!",
        goldResponseClass: "not_reply",
        goldRelationStatus: "no_preceding_creator_sent",
      },
    ],
    mailAccountEmail: CREATOR_EMAIL,
    observedThroughAtMs: 5 * DAY,
    goldObservationState: "no_qualifying_response_observed_in_window",
  },
  {
    id: "16-no-reply-known-horizon",
    description: "no human reply inside a proven B03 horizon -> window-bounded absence only",
    messages: [{ id: "s1", sent: true, atMs: 0, subject: "Collab?" }],
    mailAccountEmail: CREATOR_EMAIL,
    observedThroughAtMs: 10 * DAY,
    goldObservationState: "no_qualifying_response_observed_in_window",
  },
  {
    id: "17-no-proven-horizon",
    description: "no proven horizon -> observation_horizon_unknown",
    messages: [{ id: "s1", sent: true, atMs: 0, subject: "Collab?" }],
    mailAccountEmail: CREATOR_EMAIL,
    observedThroughAtMs: null,
    goldObservationState: "observation_horizon_unknown",
  },
  {
    id: "18-null-routing-email",
    description:
      "closure pass §7: null mailbox routing address + clean external-looking sender + human text -> ambiguous, never qualifying",
    messages: [
      { id: "s1", sent: true, atMs: 0, subject: "Collab?" },
      {
        id: "r1",
        sent: false,
        atMs: HOUR,
        from: "person@hotel.example",
        subject: "Re: Collab?",
        bodyText: "Thanks so much, I would love to collaborate on this!",
        goldResponseClass: "ambiguous_inbound",
        goldRelationStatus: "thread_sequence_only",
      },
    ],
    mailAccountEmail: null,
    observedThroughAtMs: 5 * DAY,
    goldObservationState: "ambiguous_response_observed",
  },
  {
    id: "19-repeated-conflicting-from",
    description:
      "closure pass §9: two DIFFERENT parsed From addresses on the same message cannot safely resolve to one sender",
    messages: [
      { id: "s1", sent: true, atMs: 0, subject: "Collab?" },
      {
        id: "r1",
        sent: false,
        atMs: HOUR,
        froms: ["person@hotel.example", "other@hotel.example"],
        subject: "Re: Collab?",
        bodyText: "Sure, let's talk.",
        goldResponseClass: "ambiguous_inbound",
        goldRelationStatus: "thread_sequence_only",
      },
    ],
    mailAccountEmail: CREATOR_EMAIL,
    observedThroughAtMs: 5 * DAY,
    goldObservationState: "ambiguous_response_observed",
  },
  {
    id: "20-repeated-subject-automation-in-second",
    description:
      "closure pass §10: automation language present only in a SECOND Subject occurrence is still honored",
    messages: [
      { id: "s1", sent: true, atMs: 0, subject: "Collab?" },
      {
        id: "r1",
        sent: false,
        atMs: HOUR,
        from: "person@hotel.example",
        subjects: ["Re: Collab?", "Automatic reply"],
        bodyText: "n/a",
        goldResponseClass: "automated_response",
        goldRelationStatus: "thread_sequence_only",
      },
    ],
    mailAccountEmail: CREATOR_EMAIL,
    observedThroughAtMs: 5 * DAY,
    goldObservationState: "only_automated_or_delivery_observed",
  },
  {
    id: "21-duplicate-message-id-creator-and-nonsent",
    description:
      "closure pass §11: a Message-ID token shared by a creator-SENT message AND a non-SENT local message is ambiguous, never silently resolved to the creator-sent one",
    messages: [
      { id: "s1", sent: true, atMs: 0, messageId: "<dup@x.example>", subject: "Collab?" },
      {
        id: "other-inbound",
        // Strictly BEFORE s1 — genuinely no preceding creator send of its
        // own, so it stays a clean not_reply and never competes to become
        // the thread's first qualifying reply. Its only role here is to
        // OWN the duplicate Message-ID token.
        sent: false,
        atMs: -HOUR,
        from: "unrelated@example.com",
        extraMessageIdOwners: [{ ownerId: "other-inbound", token: "<dup@x.example>" }],
        subject: "Unrelated",
        bodyText: "unrelated message that happens to share the literal Message-ID",
        goldResponseClass: "not_reply",
        goldRelationStatus: "no_preceding_creator_sent",
      },
      {
        id: "r1",
        sent: false,
        atMs: HOUR,
        from: "person@hotel.example",
        inReplyTo: "<dup@x.example>",
        subject: "Re: Collab?",
        bodyText: "Sure!",
        goldResponseClass: "ambiguous_inbound",
        goldRelationStatus: "ambiguous_reference",
      },
    ],
    mailAccountEmail: CREATOR_EMAIL,
    observedThroughAtMs: 5 * DAY,
    goldObservationState: "ambiguous_response_observed",
  },
  {
    id: "22-tied-first-creator-send",
    description:
      "closure pass §17: two creator sends tied for earliest -> known timestamp, ambiguous singular identity, latency still computed",
    messages: [
      { id: "s1", sent: true, atMs: 0, subject: "Collab?" },
      { id: "s2", sent: true, atMs: 0, subject: "Collab? (cc)" },
      {
        id: "r1",
        sent: false,
        atMs: 2 * HOUR,
        from: "person@hotel.example",
        subject: "Re: Collab?",
        bodyText: "Sounds great!",
        goldResponseClass: "qualifying_human_reply",
        goldRelationStatus: "thread_sequence_only",
      },
    ],
    mailAccountEmail: CREATOR_EMAIL,
    observedThroughAtMs: 5 * DAY,
    goldObservationState: "qualifying_human_reply_observed",
    goldLatencyFromFirstCreatorSentMs: 2 * HOUR,
    goldLatencyFromLatestCreatorSentMs: 2 * HOUR,
    goldCreatorSentCountBeforeFirstHumanReply: 2,
  },
];

export function toEvidence(testCase: CorpusCase): {
  messages: ReplyEvidenceMessage[];
  referenceTokens: ReplyEvidenceReferenceToken[];
  participants: ReplyEvidenceParticipant[];
  subjects: ReplyEvidenceSubject[];
  textParts: ReplyEvidenceTextPart[];
} {
  const messages: ReplyEvidenceMessage[] = [];
  const referenceTokens: ReplyEvidenceReferenceToken[] = [];
  const participants: ReplyEvidenceParticipant[] = [];
  const subjects: ReplyEvidenceSubject[] = [];
  const textParts: ReplyEvidenceTextPart[] = [];

  for (const m of testCase.messages) {
    messages.push({
      providerMessageId: m.id,
      providerSent: m.sent,
      internalDateMs: m.atMs,
      sourcePayloadSha256: "0".repeat(64),
    });

    if (m.messageId) {
      referenceTokens.push({
        providerMessageId: m.id,
        headerRole: "message-id",
        tokenOrder: 0,
        rawToken: m.messageId,
        parseStatus: "valid_msgid",
      });
    }
    for (const extra of m.extraMessageIdOwners ?? []) {
      referenceTokens.push({
        providerMessageId: extra.ownerId,
        headerRole: "message-id",
        tokenOrder: 0,
        rawToken: extra.token,
        parseStatus: "valid_msgid",
      });
    }
    if (m.inReplyTo) {
      referenceTokens.push({
        providerMessageId: m.id,
        headerRole: "in-reply-to",
        tokenOrder: 0,
        rawToken: m.inReplyTo,
        parseStatus: "valid_msgid",
      });
    }
    if (m.references) {
      referenceTokens.push({
        providerMessageId: m.id,
        headerRole: "references",
        tokenOrder: 0,
        rawToken: m.references,
        parseStatus: "valid_msgid",
      });
    }

    if (m.froms !== undefined) {
      for (const addr of m.froms) {
        participants.push({
          providerMessageId: m.id,
          role: "from",
          addrSpec: addr,
          domainLower: addr.split("@")[1] ?? null,
          parseStatus: "parsed",
        });
      }
    } else if (m.from !== undefined) {
      participants.push({
        providerMessageId: m.id,
        role: "from",
        addrSpec: m.from,
        domainLower: m.from.split("@")[1] ?? null,
        parseStatus: "parsed",
      });
    } else if (!m.sent) {
      participants.push({
        providerMessageId: m.id,
        role: "from",
        addrSpec: null,
        domainLower: null,
        parseStatus: "malformed",
      });
    }

    if (m.subjects !== undefined) {
      for (const value of m.subjects) subjects.push({ providerMessageId: m.id, rawValue: value });
    } else if (m.subject !== undefined) {
      subjects.push({ providerMessageId: m.id, rawValue: m.subject });
    }
    if (m.bodyText !== undefined) {
      textParts.push({
        providerMessageId: m.id,
        mimeType: "text/plain",
        decodeStatus: "decoded",
        decodedText: m.bodyText,
      });
    }
  }

  return { messages, referenceTokens, participants, subjects, textParts };
}
