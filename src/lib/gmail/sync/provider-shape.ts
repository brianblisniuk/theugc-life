import { GmailReadError } from "@/lib/gmail/import/errors";

/**
 * history.list and users.getProfile, validated before a missing field can
 * mean "nothing changed". A broken body is malformed_response, never an
 * empty mailbox.
 */

function malformed(operation: "history_list" | "profile_get"): GmailReadError {
  return new GmailReadError({
    operation,
    status: null,
    reason: "malformed_response",
    retryable: false,
  });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface HistoryThreadNotice {
  providerThreadId: string;
  messages: { providerMessageId: string | null; labelIds: string[] }[];
}

export interface HistoryPage {
  threads: HistoryThreadNotice[];
  nextPageToken: string | null;
  historyId: string;
}

export function parseGmailHistoryResponse(body: unknown): HistoryPage {
  if (!isPlainObject(body)) throw malformed("history_list");
  if (typeof body.historyId !== "string" || body.historyId.trim() === "") {
    throw malformed("history_list");
  }
  if (body.nextPageToken !== undefined && typeof body.nextPageToken !== "string") {
    throw malformed("history_list");
  }
  if (body.history !== undefined && !Array.isArray(body.history)) {
    throw malformed("history_list");
  }

  const byThread = new Map<string, { providerMessageId: string | null; labelIds: string[] }[]>();
  for (const record of body.history ?? []) {
    if (!isPlainObject(record)) throw malformed("history_list");
    if (record.messagesAdded === undefined) continue;
    if (!Array.isArray(record.messagesAdded)) throw malformed("history_list");
    for (const added of record.messagesAdded) {
      if (!isPlainObject(added) || !isPlainObject(added.message)) throw malformed("history_list");
      const message = added.message;
      const threadId = message.threadId;
      if (typeof threadId !== "string" || threadId.trim() === "") throw malformed("history_list");
      if (
        !Array.isArray(message.labelIds) ||
        message.labelIds.some((id) => typeof id !== "string")
      ) {
        throw malformed("history_list");
      }
      const labels = message.labelIds as string[];
      let providerMessageId: string | null = null;
      if (message.id !== undefined) {
        if (typeof message.id !== "string" || message.id.trim() === "") {
          throw malformed("history_list");
        }
        providerMessageId = message.id.trim();
      }
      const existing = byThread.get(threadId) ?? [];
      existing.push({ providerMessageId, labelIds: labels });
      byThread.set(threadId, existing);
    }
  }

  return {
    historyId: body.historyId,
    nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : null,
    threads: [...byThread.entries()].map(([providerThreadId, messages]) => ({
      providerThreadId,
      messages,
    })),
  };
}

export function parseGmailProfileHistoryId(body: unknown): string {
  if (!isPlainObject(body)) throw malformed("profile_get");
  if (typeof body.historyId !== "string" || body.historyId.trim() === "") {
    throw malformed("profile_get");
  }
  return body.historyId;
}
