import type { GmailHistoricalReadAdapter } from "@/lib/gmail/import/read-adapter.server";
import { MESSAGES_LIST_QUOTA_UNITS, THREADS_GET_QUOTA_UNITS } from "@/lib/gmail/import/contract";
import { GmailReadError } from "@/lib/gmail/import/errors";
import type { RawMessage, RawThread } from "@/lib/gmail/import/sanitizer";

/**
 * A DETERMINISTIC STAND-IN FOR GMAIL'S READ SURFACE.
 *
 * Every interesting B03 case is a provider behaviour that cannot be produced on
 * demand against the real service — a vanished thread, a 429, a body Gmail
 * stored separately, a malformed response — so the adapter boundary is where
 * the tests take over and CI never touches Google.
 *
 * ALL FIXTURES ARE SYNTHETIC. No real address, no real subject, no real body.
 *
 * The counters exist so tests can assert the NEGATIVE: that no attachment was
 * ever fetched. `attachmentGetCalls` is permanently zero because the interface
 * has no such method — the counter documents an impossibility rather than
 * measuring restraint.
 */

export interface FakeGmailPage {
  candidates: { messageId: string; threadId: string }[];
  nextPageToken: string | null;
}

export interface FakeGmailOptions {
  pages?: FakeGmailPage[];
  threads?: Record<string, RawThread>;
  /** Thread ids Gmail no longer has. */
  missingThreads?: string[];
  /** Errors to throw, consumed in order, per operation. */
  listErrors?: (GmailReadError | null)[];
  threadErrors?: (GmailReadError | null)[];
  /** Return a thread whose id disagrees with the request. */
  mismatchedThreadId?: string | null;
  /** Called before each provider response is produced. */
  onList?: () => void | Promise<void>;
  onGetThread?: (threadId: string) => void | Promise<void>;
}

export interface FakeGmailRead extends GmailHistoricalReadAdapter {
  calls: {
    listMessagesCalls: number;
    getThreadCalls: number;
    /** Structurally impossible: there is no attachment method to call. */
    attachmentGetCalls: 0;
    quotaUnits: number;
    /** Page tokens the worker presented, for assertions only. Never logged. */
    pageTokens: (string | null)[];
    threadIds: string[];
    windows: { start: number; end: number }[];
    listParams: Record<string, unknown>[];
  };
}

export function createFakeGmailRead(options: FakeGmailOptions = {}): FakeGmailRead {
  const pages = options.pages ?? [{ candidates: [], nextPageToken: null }];
  const threads = options.threads ?? {};
  const missing = new Set(options.missingThreads ?? []);
  const listErrors = [...(options.listErrors ?? [])];
  const threadErrors = [...(options.threadErrors ?? [])];

  const calls: FakeGmailRead["calls"] = {
    listMessagesCalls: 0,
    getThreadCalls: 0,
    attachmentGetCalls: 0,
    quotaUnits: 0,
    pageTokens: [],
    threadIds: [],
    windows: [],
    listParams: [],
  };

  return {
    calls,

    async listSentMessages({ pageToken, windowStartEpochSeconds, windowEndEpochSeconds }) {
      calls.listMessagesCalls += 1;
      calls.pageTokens.push(pageToken);
      calls.windows.push({ start: windowStartEpochSeconds, end: windowEndEpochSeconds });
      // What the production adapter would put on the wire, recorded so tests can
      // assert the request SHAPE without a live call.
      calls.listParams.push({
        userId: "me",
        labelIds: "SENT",
        maxResults: 500,
        includeSpamTrash: true,
        q: `after:${Math.max(windowStartEpochSeconds - 1, 0)} before:${windowEndEpochSeconds}`,
      });
      calls.quotaUnits += MESSAGES_LIST_QUOTA_UNITS;

      await options.onList?.();

      const failure = listErrors.shift();
      if (failure) throw failure;

      const index = calls.pageTokens.length - 1;
      const page =
        pageToken === null
          ? pages[0]
          : (pages.find((_, i) => pages[i - 1]?.nextPageToken === pageToken) ?? pages[index]);

      return {
        candidates: page?.candidates ?? [],
        nextPageToken: page?.nextPageToken ?? null,
        quotaUnits: MESSAGES_LIST_QUOTA_UNITS,
      };
    },

    async getThread({ threadId }) {
      calls.getThreadCalls += 1;
      calls.threadIds.push(threadId);
      calls.quotaUnits += THREADS_GET_QUOTA_UNITS;

      await options.onGetThread?.(threadId);

      const failure = threadErrors.shift();
      if (failure) throw failure;

      if (missing.has(threadId)) {
        throw new GmailReadError({
          operation: "threads_get",
          status: 404,
          reason: "thread_not_found",
          retryable: false,
        });
      }

      const thread = threads[threadId];
      if (!thread) {
        throw new GmailReadError({
          operation: "threads_get",
          status: null,
          reason: "malformed_response",
          retryable: false,
        });
      }

      return {
        thread: options.mismatchedThreadId ? { ...thread, id: options.mismatchedThreadId } : thread,
        quotaUnits: THREADS_GET_QUOTA_UNITS,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// SYNTHETIC FIXTURES
// ---------------------------------------------------------------------------

const header = (name: string, value: string) => ({ name, value });

export function textMessage(init: {
  id: string;
  threadId: string;
  internalDateMs: number;
  labelIds?: string[];
  historyId?: string;
  html?: boolean;
}): RawMessage {
  return {
    id: init.id,
    threadId: init.threadId,
    labelIds: init.labelIds ?? ["SENT"],
    historyId: init.historyId ?? "9001",
    internalDate: String(init.internalDateMs),
    sizeEstimate: 2048,
    snippet: "SYNTHETIC SNIPPET THAT MUST NEVER BE PERSISTED",
    payload: {
      mimeType: init.html ? "text/html" : "text/plain",
      filename: "",
      headers: [
        header("From", "Creator <creator@example.invalid>"),
        header("To", "Front Desk <desk@example.invalid>"),
        header("Subject", "Synthetic subject"),
        header("Date", new Date(init.internalDateMs).toUTCString()),
        header("Message-ID", `<${init.id}@example.invalid>`),
        header("X-Internal-Routing", "SHOULD BE DROPPED"),
        header("X-Spam-Score", "SHOULD BE DROPPED"),
      ],
      body: { size: 24, data: "U1lOVEhFVElDIEJPRFk" },
    },
  };
}

/** A message with an attachment beside its text body. */
export function messageWithAttachment(init: {
  id: string;
  threadId: string;
  internalDateMs: number;
  mimeType?: string;
}): RawMessage {
  return {
    id: init.id,
    threadId: init.threadId,
    labelIds: ["SENT"],
    historyId: "9002",
    internalDate: String(init.internalDateMs),
    sizeEstimate: 90210,
    payload: {
      mimeType: "multipart/mixed",
      filename: "",
      headers: [header("Subject", "Synthetic with file"), header("From", "c@example.invalid")],
      parts: [
        {
          mimeType: "text/plain",
          filename: "",
          headers: [header("Content-Type", "text/plain; charset=UTF-8")],
          body: { size: 12, data: "SU5MSU5FIFRFWFQ" },
        },
        {
          mimeType: init.mimeType ?? "image/png",
          filename: "rate-card.png",
          headers: [header("Content-Disposition", 'attachment; filename="rate-card.png"')],
          body: { attachmentId: "ATTACHMENT-ID-MUST-NEVER-BE-PERSISTED", size: 88888 },
        },
      ],
    },
  };
}

/** A TEXT body Gmail stored separately rather than inlining. */
export function messageWithExternalTextBody(init: {
  id: string;
  threadId: string;
  internalDateMs: number;
}): RawMessage {
  return {
    id: init.id,
    threadId: init.threadId,
    labelIds: ["INBOX"],
    historyId: "9003",
    internalDate: String(init.internalDateMs),
    sizeEstimate: 400000,
    payload: {
      mimeType: "text/plain",
      filename: "",
      headers: [header("Subject", "Synthetic long body")],
      body: { attachmentId: "EXTERNAL-BODY-ID", size: 400000 },
    },
  };
}

/** A text part that carries a filename — a file wearing a text label. */
export function messageWithNamedTextPart(init: {
  id: string;
  threadId: string;
  internalDateMs: number;
}): RawMessage {
  return {
    id: init.id,
    threadId: init.threadId,
    labelIds: ["SENT"],
    internalDate: String(init.internalDateMs),
    payload: {
      mimeType: "multipart/mixed",
      filename: "",
      parts: [
        {
          mimeType: "text/plain",
          filename: "contract-terms.txt",
          body: { size: 40, data: "RklMRSBDT05URU5U" },
        },
      ],
    },
  };
}

export function draftMessage(init: {
  id: string;
  threadId: string;
  internalDateMs: number;
}): RawMessage {
  return {
    ...textMessage(init),
    labelIds: ["DRAFT"],
  };
}

export function thread(id: string, messages: RawMessage[]): RawThread {
  return { id, messages };
}
