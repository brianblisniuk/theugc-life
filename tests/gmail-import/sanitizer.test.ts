import { describe, expect, it } from "vitest";

import {
  B03_QUOTA_UNITS_PER_MINUTE_PER_MAILBOX,
  MESSAGES_LIST_MAX_RESULTS,
  MESSAGES_LIST_QUOTA_UNITS,
  THREADS_GET_QUOTA_UNITS,
} from "@/lib/gmail/import/contract";
import { backoffDelayMs, classifyGmailReadFailure } from "@/lib/gmail/import/errors";
import { buildSentWindowQuery } from "@/lib/gmail/import/read-adapter.server";
import {
  canonicalize,
  sanitizedMessageDigest,
  sanitizeThread,
  toCommitRow,
} from "@/lib/gmail/import/sanitizer";

import {
  draftMessage,
  messageWithAttachment,
  messageWithExternalTextBody,
  messageWithNamedTextPart,
  textMessage,
  thread,
} from "./fake-gmail-read";

/**
 * B03 §31 and §35 — the sanitizer, the request shape and the retry taxonomy.
 *
 * These are pure functions, so they are tested as pure functions: no database,
 * no network, no clock. Everything about WHAT LEAVES GMAIL is decided here, and
 * a whitelist is only worth having if its edges are pinned.
 */

const WINDOW = {
  startMs: Date.parse("2024-01-01T00:00:00Z"),
  endMs: Date.parse("2024-06-01T00:00:00Z"),
};
const inside = Date.parse("2024-03-01T12:00:00Z");

const asJson = (value: unknown) => JSON.stringify(value);

describe("B03 sanitizer — what may be persisted", () => {
  it("38-39. messages outside the half-open window are dropped", async () => {
    const before = Date.parse("2023-12-31T23:59:59Z");
    const atEnd = WINDOW.endMs; // exclusive
    const sanitized = sanitizeThread(
      thread("t1", [
        textMessage({ id: "before", threadId: "t1", internalDateMs: before }),
        textMessage({ id: "atStart", threadId: "t1", internalDateMs: WINDOW.startMs }),
        textMessage({ id: "inside", threadId: "t1", internalDateMs: inside }),
        textMessage({ id: "atEnd", threadId: "t1", internalDateMs: atEnd }),
      ]),
      WINDOW,
    );
    // Half-open: the start instant is kept, the end instant is not, so two
    // adjacent windows neither overlap nor leave a gap.
    expect(sanitized.messages.map((m) => m.providerMessageId)).toEqual(["atStart", "inside"]);
  });

  it("40. DRAFT messages are dropped entirely and counted as drafts, not imports", async () => {
    const sanitized = sanitizeThread(
      thread("t2", [
        draftMessage({ id: "d1", threadId: "t2", internalDateMs: inside }),
        textMessage({ id: "s1", threadId: "t2", internalDateMs: inside }),
      ]),
      WINDOW,
    );
    // A draft is a sentence somebody typed and did not send. Counting it as
    // imported communication would bias every later timing layer the same way.
    expect(sanitized.messages.map((m) => m.providerMessageId)).toEqual(["s1"]);
    expect(sanitized.draftsDropped).toBe(1);
  });

  it("41-43. a sent message, a reply and a spam/trash reply are all retained", async () => {
    const sanitized = sanitizeThread(
      thread("t3", [
        textMessage({ id: "sent", threadId: "t3", internalDateMs: inside, labelIds: ["SENT"] }),
        textMessage({ id: "reply", threadId: "t3", internalDateMs: inside, labelIds: ["INBOX"] }),
        textMessage({ id: "spam", threadId: "t3", internalDateMs: inside, labelIds: ["SPAM"] }),
        textMessage({ id: "trash", threadId: "t3", internalDateMs: inside, labelIds: ["TRASH"] }),
      ]),
      WINDOW,
    );
    // The thread earned its place because the creator sent into it; the replies
    // are the evidence a later layer will actually reason about, wherever Gmail
    // has since filed them.
    expect(sanitized.messages.map((m) => m.providerMessageId)).toEqual([
      "sent",
      "reply",
      "spam",
      "trash",
    ]);
  });

  it("44-45. inline text/plain and text/html bodies are kept", async () => {
    const sanitized = sanitizeThread(
      thread("t4", [
        textMessage({ id: "plain", threadId: "t4", internalDateMs: inside }),
        textMessage({ id: "html", threadId: "t4", internalDateMs: inside, html: true }),
      ]),
      WINDOW,
    );
    for (const message of sanitized.messages) {
      expect(message.payload.body?.data).toBe("U1lOVEhFVElDIEJPRFk");
    }
  });

  it("46. a text part carrying a filename is a file, and its body is omitted", async () => {
    const sanitized = sanitizeThread(
      thread("t5", [
        messageWithNamedTextPart({ id: "named", threadId: "t5", internalDateMs: inside }),
      ]),
      WINDOW,
    );
    const part = sanitized.messages[0]!.payload.parts![0]!;
    expect(part.body).toBeUndefined();
    expect(part.contentOmitted).toBe(true);
    expect(part.omissionReason).toBe("attachment");
    expect(asJson(sanitized)).not.toContain("RklMRSBDT05URU5U");
  });

  it("47. a TEXT body Gmail stored separately is omitted, not fetched", async () => {
    const sanitized = sanitizeThread(
      thread("t6", [
        messageWithExternalTextBody({ id: "ext", threadId: "t6", internalDateMs: inside }),
      ]),
      WINDOW,
    );
    const payload = sanitized.messages[0]!.payload;
    expect(payload.contentOmitted).toBe(true);
    expect(payload.omissionReason).toBe("external_body");
    // The gap is MEASURED. A silent omission and a captured body look identical
    // afterwards unless the difference is counted at the time.
    expect(sanitized.counters.textPartsOmittedExternal).toBe(1);
    expect(asJson(sanitized)).not.toContain("EXTERNAL-BODY-ID");
  });

  it("48-50. attachment bytes and attachment ids never appear in the payload", async () => {
    for (const mimeType of ["image/png", "application/pdf", "audio/mpeg", "video/mp4"]) {
      const sanitized = sanitizeThread(
        thread("t7", [
          messageWithAttachment({
            id: `a-${mimeType}`,
            threadId: "t7",
            internalDateMs: inside,
            mimeType,
          }),
        ]),
        WINDOW,
      );
      const json = asJson(sanitized);
      expect(json).not.toContain("attachmentId");
      expect(json).not.toContain("ATTACHMENT-ID-MUST-NEVER-BE-PERSISTED");
      expect(json).not.toContain("rate-card.png");
      expect(sanitized.counters.attachmentOrNonTextPartsOmitted).toBe(1);
      // The inline text beside it survives: B03 wants the message, not the file.
      const text = sanitized.messages[0]!.payload.parts![0]!;
      expect(text.body?.data).toBe("SU5MSU5FIFRFWFQ");
    }
  });

  it("51-52. `snippet` and `raw` are never carried through", async () => {
    const sanitized = sanitizeThread(
      thread("t8", [textMessage({ id: "s", threadId: "t8", internalDateMs: inside })]),
      WINDOW,
    );
    const json = asJson(toCommitRow(sanitized.messages[0]!));
    expect(json).not.toContain("snippet");
    expect(json).not.toContain("SYNTHETIC SNIPPET");
    expect(json).not.toContain('"raw"');
  });

  it("53-54. approved headers survive and everything else is dropped", async () => {
    const sanitized = sanitizeThread(
      thread("t9", [textMessage({ id: "h", threadId: "t9", internalDateMs: inside })]),
      WINDOW,
    );
    const headers = sanitized.messages[0]!.messageHeaders;
    expect(headers.map((h) => h.name).sort()).toEqual([
      "date",
      "from",
      "message-id",
      "subject",
      "to",
    ]);
    // The provider's RAW value, unparsed: turning an address into a person is
    // B04's decision, and guessing it here would freeze the guess into the raw
    // layer.
    expect(headers.find((h) => h.name === "from")!.value).toBe("Creator <creator@example.invalid>");
    const json = asJson(sanitized);
    expect(json).not.toContain("X-Internal-Routing");
    expect(json).not.toContain("SHOULD BE DROPPED");
  });

  it("55. the digest is deterministic and independent of provider field order", async () => {
    const base = textMessage({ id: "det", threadId: "tA", internalDateMs: inside });
    // JSON KEY order is an accident of parsing, not a fact about the message.
    const reordered = {
      internalDate: base.internalDate,
      threadId: base.threadId,
      payload: {
        body: base.payload!.body,
        headers: base.payload!.headers,
        filename: base.payload!.filename,
        mimeType: base.payload!.mimeType,
      },
      labelIds: base.labelIds,
      sizeEstimate: base.sizeEstimate,
      historyId: base.historyId,
      id: base.id,
    };

    const a = sanitizeThread(thread("tA", [base]), WINDOW).messages[0]!;
    const b = sanitizeThread(thread("tA", [reordered]), WINDOW).messages[0]!;
    expect(sanitizedMessageDigest(a)).toBe(sanitizedMessageDigest(b));

    // HEADER OCCURRENCE ORDER IS NOT AN ACCIDENT, and since headers are stored
    // losslessly as a list it is part of the snapshot. With a repeated field —
    // two `To:` lines — order is the only thing distinguishing one arrangement
    // from the other, and B03 has no business declaring them equivalent.
    const headerOrderChanged = sanitizeThread(
      thread("tA", [
        { ...base, payload: { ...base.payload!, headers: [...base.payload!.headers!].reverse() } },
      ]),
      WINDOW,
    ).messages[0]!;
    expect(sanitizedMessageDigest(headerOrderChanged)).not.toBe(sanitizedMessageDigest(a));

    // A CHANGED SNAPSHOT IS A DIFFERENT DIGEST. Labels are the common case: a
    // message that moved to TRASH is the same message with a new provider state.
    const relabelled = sanitizeThread(
      thread("tA", [{ ...base, labelIds: ["SENT", "TRASH"] }]),
      WINDOW,
    ).messages[0]!;
    expect(sanitizedMessageDigest(relabelled)).not.toBe(sanitizedMessageDigest(a));
  });

  it("nothing volatile enters the digest", async () => {
    // Canonicalization sorts keys and drops undefined; it has no access to a
    // clock, a run id or an attempt count, so two imports of one snapshot agree.
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 }, u: undefined })).toEqual({
      a: { c: 3, d: 2 },
      b: 1,
    });
    expect(JSON.stringify(canonicalize({ b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
  });
});

describe("B03 request shape and provider constants", () => {
  it("21-27. the enumeration request is server-built, sent-rooted and epoch-bounded", async () => {
    // The only thing that varies in `q` is the window. A Gmail search string is
    // a capability to ask for anything in the mailbox, so none of it comes from
    // a browser, a CLI argument or a database column.
    // Milliseconds in, epoch seconds out. Both bounds round OUTWARD so the
    // provider query is a superset of the exact local window.
    const q = buildSentWindowQuery(1_700_000_000_000, 1_700_003_600_000);
    expect(q).toBe("after:1699999999 before:1700003600");
    // Epoch seconds, not YYYY/MM/DD: Gmail reads date strings at midnight
    // Pacific, which silently shifts a window by up to a day.
    expect(q).not.toMatch(/\d{4}\/\d{2}\/\d{2}/);
    expect(MESSAGES_LIST_MAX_RESULTS).toBe(500);
  });

  it("94-96. the published per-method costs, and a budget below the ceiling", async () => {
    expect(MESSAGES_LIST_QUOTA_UNITS).toBe(5);
    expect(THREADS_GET_QUOTA_UNITS).toBe(40);
    // Google currently publishes 6,000 units/minute/user on the current tier.
    // B03 plans against less, because a published ceiling is shared with every
    // other client of that user and can change.
    expect(B03_QUOTA_UNITS_PER_MINUTE_PER_MAILBOX).toBeLessThan(6_000);
    expect(B03_QUOTA_UNITS_PER_MINUTE_PER_MAILBOX).toBe(4_000);
  });
});

describe("B03 provider error taxonomy", () => {
  it("97-103. rate and 5xx failures are retryable; nothing else is guessed", async () => {
    for (const [status, reason, expected] of [
      [429, null, "rate_limit_exceeded"],
      [403, "rateLimitExceeded", "rate_limit_exceeded"],
      [403, "userRateLimitExceeded", "user_rate_limit_exceeded"],
      [500, null, "internal_error"],
      [502, null, "backend_error"],
      [503, null, "service_unavailable"],
      [504, null, "gateway_timeout"],
    ] as const) {
      const error = classifyGmailReadFailure("threads_get", status, reason);
      expect([status, reason, error.reason, error.retryable]).toEqual([
        status,
        reason,
        expected,
        true,
      ]);
    }
  });

  it("106. a 403 is not proof that a refresh token died", async () => {
    // B02 owns "may we still read this mailbox", and answers it from the
    // database. Reinterpreting a provider status here would delete a working
    // authorization to explain a quota decision.
    const error = classifyGmailReadFailure("threads_get", 403, "forbidden");
    expect([error.reason, error.retryable]).toEqual(["forbidden", false]);
  });

  it("56. a 404 on a thread is terminal for that work item, not retryable", async () => {
    const error = classifyGmailReadFailure("threads_get", 404, "notFound");
    expect([error.reason, error.retryable]).toEqual(["thread_not_found", false]);
  });

  it("provider free text never survives classification", async () => {
    const error = classifyGmailReadFailure(
      "threads_get",
      400,
      "Invalid query: subject:(confidential merger) from:ceo@example.invalid",
    );
    expect(error.reason).toBe("bad_request");
    expect(error.message).toBe("bad_request");
    expect(JSON.stringify(error)).not.toContain("ceo@example.invalid");
  });

  it("104-105. backoff is truncated, jittered and deterministic under injection", async () => {
    const noJitter = () => 0;
    expect(backoffDelayMs(1, noJitter)).toBe(1_000);
    expect(backoffDelayMs(2, noJitter)).toBe(2_000);
    expect(backoffDelayMs(6, noJitter)).toBe(32_000);
    // Truncated: an unbounded delay is a hang with better manners.
    expect(backoffDelayMs(50, noJitter)).toBe(32_000);
    // Jittered: synchronised retries turn a transient failure into a sustained
    // one. Injected so CI asserts the policy instead of waiting for it.
    expect(backoffDelayMs(1, () => 0.5)).toBe(1_500);
  });
});
