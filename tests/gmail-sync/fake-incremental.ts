import { MESSAGES_LIST_QUOTA_UNITS, THREADS_GET_QUOTA_UNITS } from "@/lib/gmail/import/contract";
import { GmailReadError } from "@/lib/gmail/import/errors";
import { buildSentWindowQuery } from "@/lib/gmail/import/read-adapter.server";
import type { RawThread } from "@/lib/gmail/import/sanitizer";
import { HISTORY_LIST_QUOTA_UNITS, PROFILE_GET_QUOTA_UNITS } from "@/lib/gmail/sync/contract";
import type { GmailIncrementalReadAdapter } from "@/lib/gmail/sync/read-adapter";

/**
 * Deterministic stand-in for history.list, the SENT re-scan, threads.get and
 * users.getProfile. No socket is opened. Fixtures are synthetic.
 */

export interface FakeHistoryPage {
  historyId: string;
  nextPageToken: string | null;
  threads: { providerThreadId: string; labelIds: string[]; messageIds?: string[] }[];
}

export interface FakeIncrementalCalls {
  historyStarts: string[];
  historyPageTokens: (string | null)[];
  sentCalls: number;
  threadIds: string[];
  profileCalls: number;
  /** Provider calls in the order they actually happened. */
  order: string[];
}

export interface FakeIncremental extends GmailIncrementalReadAdapter {
  calls: FakeIncrementalCalls;
}

export function createFakeIncremental(
  options: {
    historyPages?: FakeHistoryPage[];
    historyErrors?: (GmailReadError | null)[];
    sentThreadIds?: string[];
    threads?: Record<string, RawThread>;
    missingThreads?: string[];
    profileHistoryId?: string;
    /**
     * Returned only when getProfile runs after a SENT search or threads.get.
     * A pre-scan profile call still returns profileHistoryId. Tests use this
     * to tell a post-fetch historyId from the one captured before the re-scan.
     */
    profileHistoryIdAfterScan?: string;
    historyByStart?: Record<string, FakeHistoryPage>;
    beforeGetThread?: (threadId: string) => Promise<void>;
    beforeListHistory?: () => Promise<void>;
    beforeGetProfile?: () => Promise<void>;
    beforeListSent?: (window: { windowStartMs: number; windowEndMs: number }) => Promise<void>;
    profileError?: GmailReadError | null;
  } = {},
): FakeIncremental {
  const historyPages = options.historyPages ?? [
    { historyId: "200", nextPageToken: null, threads: [] },
  ];
  const historyErrors = [...(options.historyErrors ?? [])];
  const threads = options.threads ?? {};
  const missing = new Set(options.missingThreads ?? []);
  const calls: FakeIncrementalCalls = {
    historyStarts: [],
    historyPageTokens: [],
    sentCalls: 0,
    threadIds: [],
    profileCalls: 0,
    order: [],
  };

  return {
    calls,

    async listHistory({ startHistoryId, pageToken }) {
      calls.order.push("history");
      if (options.beforeListHistory) await options.beforeListHistory();
      calls.historyStarts.push(startHistoryId);
      calls.historyPageTokens.push(pageToken);
      const failure = historyErrors.shift();
      if (failure) throw failure;
      const index = calls.historyPageTokens.length - 1;
      const mapped = options.historyByStart?.[startHistoryId];
      const page = options.historyByStart
        ? (mapped ?? {
            historyId: startHistoryId,
            nextPageToken: null,
            threads: [],
          })
        : pageToken === null
          ? historyPages[0]
          : (historyPages.find((_, i) => historyPages[i - 1]?.nextPageToken === pageToken) ??
            historyPages[index]);
      return {
        historyId: page?.historyId ?? "200",
        nextPageToken: page?.nextPageToken ?? null,
        threads: (page?.threads ?? []).map((thread) => ({
          providerThreadId: thread.providerThreadId,
          messages:
            thread.messageIds && thread.messageIds.length > 0
              ? thread.messageIds.map((id) => ({
                  providerMessageId: id,
                  labelIds: thread.labelIds,
                }))
              : [{ providerMessageId: null, labelIds: thread.labelIds }],
        })),
        quotaUnits: HISTORY_LIST_QUOTA_UNITS,
      };
    },

    async listSentMessages({ windowStartMs, windowEndMs, omitUpperBound }) {
      calls.order.push("sent");
      calls.sentCalls += 1;
      if (options.beforeListSent) await options.beforeListSent({ windowStartMs, windowEndMs });
      const query = buildSentWindowQuery(windowStartMs, windowEndMs, { omitUpperBound });
      const after = Number(/after:(\d+)/.exec(query)?.[1]);
      const beforeMatch = /before:(\d+)/.exec(query);
      const before = beforeMatch ? Number(beforeMatch[1]) : null;
      const candidates = (options.sentThreadIds ?? []).flatMap((threadId, index) => {
        const messages = threads[threadId]?.messages ?? [];
        if (messages.length === 0) {
          return [{ messageId: `sent-${index}`, threadId }];
        }
        const matches = messages.some((message) => {
          const labels = message.labelIds ?? [];
          if (!labels.includes("SENT") || labels.includes("DRAFT")) return false;
          const ms = Number(message.internalDate);
          if (!Number.isFinite(ms)) return false;
          const second = Math.floor(ms / 1000);
          if (!(second > after)) return false;
          if (before !== null && !(second < before)) return false;
          return true;
        });
        return matches ? [{ messageId: `sent-${index}`, threadId }] : [];
      });
      return {
        candidates,
        nextPageToken: null,
        quotaUnits: MESSAGES_LIST_QUOTA_UNITS,
      };
    },

    async getThread({ threadId }) {
      calls.order.push("thread");
      if (options.beforeGetThread) await options.beforeGetThread(threadId);
      calls.threadIds.push(threadId);
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
      return { thread, quotaUnits: THREADS_GET_QUOTA_UNITS };
    },

    async getProfileHistoryId() {
      calls.order.push("profile");
      if (options.beforeGetProfile) await options.beforeGetProfile();
      calls.profileCalls += 1;
      if (options.profileError) throw options.profileError;
      const scanStarted = calls.sentCalls > 0 || calls.threadIds.length > 0;
      return {
        historyId:
          scanStarted && options.profileHistoryIdAfterScan
            ? options.profileHistoryIdAfterScan
            : (options.profileHistoryId ?? "900"),
        quotaUnits: PROFILE_GET_QUOTA_UNITS,
      };
    },
  };
}
