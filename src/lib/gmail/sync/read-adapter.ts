import { HISTORY_LIST_QUOTA_UNITS, PROFILE_GET_QUOTA_UNITS } from "@/lib/gmail/sync/contract";
import {
  parseGmailHistoryResponse,
  parseGmailProfileHistoryId,
  type HistoryPage,
} from "@/lib/gmail/sync/provider-shape";
import { classifyGmailReadFailure } from "@/lib/gmail/import/errors";
import type { GmailHistoricalReadAdapter } from "@/lib/gmail/import/read-adapter.server";

/**
 * B08's read surface. No send, no modify, no watch, no attachment method.
 * The production wiring lives in `read-adapter.server.ts` so this file can
 * run under the operator CLI and under Vitest.
 */
export interface GmailIncrementalReadAdapter {
  listHistory(input: {
    accessToken: string;
    startHistoryId: string;
    pageToken: string | null;
  }): Promise<HistoryPage & { quotaUnits: number }>;

  listSentMessages: GmailHistoricalReadAdapter["listSentMessages"];
  getThread: GmailHistoricalReadAdapter["getThread"];

  getProfileHistoryId(input: {
    accessToken: string;
  }): Promise<{ historyId: string; quotaUnits: number }>;
}

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

export function buildHistoryListUrl(startHistoryId: string, pageToken: string | null): URL {
  const url = new URL(`${GMAIL_API}/history`);
  url.searchParams.set("startHistoryId", startHistoryId);
  url.searchParams.set("historyTypes", "messageAdded");
  url.searchParams.set(
    "fields",
    "historyId,nextPageToken,history(messagesAdded(message(id,threadId,labelIds)))",
  );
  if (pageToken) url.searchParams.set("pageToken", pageToken);
  return url;
}

export function buildProfileUrl(): URL {
  const url = new URL(`${GMAIL_API}/profile`);
  url.searchParams.set("fields", "historyId");
  return url;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function providerReason(body: unknown): unknown {
  const error = (body as { error?: { errors?: { reason?: unknown }[]; status?: unknown } })?.error;
  return error?.errors?.[0]?.reason ?? error?.status;
}

export function createGmailIncrementalReadAdapter(
  historical: GmailHistoricalReadAdapter,
): GmailIncrementalReadAdapter {
  return {
    listSentMessages: (input) => historical.listSentMessages(input),
    getThread: (input) => historical.getThread(input),

    async listHistory({ accessToken, startHistoryId, pageToken }) {
      const response = await fetch(buildHistoryListUrl(startHistoryId, pageToken), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        throw classifyGmailReadFailure(
          "history_list",
          response.status,
          providerReason(await readJson(response)),
        );
      }
      const page = parseGmailHistoryResponse(await readJson(response));
      return { ...page, quotaUnits: HISTORY_LIST_QUOTA_UNITS };
    },

    async getProfileHistoryId({ accessToken }) {
      const response = await fetch(buildProfileUrl(), {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) {
        throw classifyGmailReadFailure(
          "profile_get",
          response.status,
          providerReason(await readJson(response)),
        );
      }
      return {
        historyId: parseGmailProfileHistoryId(await readJson(response)),
        quotaUnits: PROFILE_GET_QUOTA_UNITS,
      };
    },
  };
}
