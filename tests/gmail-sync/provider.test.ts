import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyGmailReadFailure, GmailReadError } from "@/lib/gmail/import/errors";
import {
  parseGmailHistoryResponse,
  parseGmailProfileHistoryId,
} from "@/lib/gmail/sync/provider-shape";
import {
  buildHistoryListUrl,
  buildProfileUrl,
  createGmailIncrementalReadAdapter,
} from "@/lib/gmail/sync/read-adapter";

describe("B08 history parsing and request shape", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks history.list only for messages that were added", () => {
    const url = buildHistoryListUrl("42", null);
    expect(url.origin + url.pathname).toBe(
      "https://gmail.googleapis.com/gmail/v1/users/me/history",
    );
    expect(url.searchParams.get("startHistoryId")).toBe("42");
    expect(url.searchParams.get("historyTypes")).toBe("messageAdded");
    expect(url.href).not.toContain("send");
    expect(url.href).not.toContain("watch");
    expect(buildProfileUrl().searchParams.get("fields")).toBe("historyId");
  });

  it("keeps the added message id from a history page", () => {
    const page = parseGmailHistoryResponse({
      historyId: "7",
      history: [
        { messagesAdded: [{ message: { id: "m1", threadId: "t", labelIds: ["SENT"] } }] },
      ],
    });
    expect(page.threads).toEqual([
      {
        providerThreadId: "t",
        messages: [{ providerMessageId: "m1", labelIds: ["SENT"] }],
      },
    ]);
  });

  it("treats a history body with no records as an empty page, not a missing mailbox", () => {
    const page = parseGmailHistoryResponse({ historyId: "7" });
    expect(page).toEqual({ historyId: "7", nextPageToken: null, threads: [] });
  });

  it("refuses a history record whose added message has no labelIds", () => {
    expect(() =>
      parseGmailHistoryResponse({
        historyId: "7",
        history: [{ messagesAdded: [{ message: { id: "m", threadId: "t" } }] }],
      }),
    ).toThrow(GmailReadError);
  });

  it("refuses a profile body with no historyId", () => {
    expect(() => parseGmailProfileHistoryId({})).toThrow(GmailReadError);
  });

  it("classifies history.list 404 as an expired cursor and threads.get 404 as a missing thread", () => {
    const expired = classifyGmailReadFailure("history_list", 404, "notFound");
    expect(expired.reason).toBe("history_id_expired");
    expect(expired.retryable).toBe(false);
    const gone = classifyGmailReadFailure("threads_get", 404, "notFound");
    expect(gone.reason).toBe("thread_not_found");
  });

  it("reads history through the adapter without a live Gmail host", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("historyTypes=messageAdded");
      expect(url).not.toContain("/messages/send");
      return new Response(JSON.stringify({ historyId: "9", history: [] }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const adapter = createGmailIncrementalReadAdapter({
      listSentMessages: async () => {
        throw new Error("sent list was not part of this call");
      },
      getThread: async () => {
        throw new Error("threads.get was not part of this call");
      },
    });
    const page = await adapter.listHistory({
      accessToken: "token",
      startHistoryId: "1",
      pageToken: null,
    });
    expect(page.historyId).toBe("9");
    expect(page.threads).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("turns a history.list HTTP 404 into history_id_expired", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { errors: [{ reason: "notFound" }] } }), {
            status: 404,
          }),
      ),
    );
    const adapter = createGmailIncrementalReadAdapter({
      listSentMessages: async () => {
        throw new Error("unused");
      },
      getThread: async () => {
        throw new Error("unused");
      },
    });
    await expect(
      adapter.listHistory({ accessToken: "token", startHistoryId: "1", pageToken: null }),
    ).rejects.toMatchObject({ reason: "history_id_expired" });
  });
});
