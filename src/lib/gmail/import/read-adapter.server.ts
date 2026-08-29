import "server-only";

import {
  MESSAGES_LIST_MAX_RESULTS,
  MESSAGES_LIST_QUOTA_UNITS,
  THREADS_GET_QUOTA_UNITS,
} from "@/lib/gmail/import/contract";
import { classifyGmailReadFailure, GmailReadError } from "@/lib/gmail/import/errors";
import type { RawThread } from "@/lib/gmail/import/sanitizer";

/**
 * THE NARROW GMAIL READ SURFACE B03 IS ALLOWED.
 *
 * Deliberately not an extension of `GoogleOAuthAdapter`, and deliberately not a
 * general Gmail client. Two methods, both read-only, both about historical
 * acquisition.
 *
 * THERE IS NO ATTACHMENT METHOD. Not a disabled one, not a guarded one — the
 * interface has no way to express `users.messages.attachments.get`, so "B03
 * never fetches attachments" is a fact about the type rather than a promise
 * about the implementation. A future writer who wanted one would have to widen
 * this interface, which is a review, not an accident.
 *
 * There is also no send, no modify, no label and no history method, for the same
 * reason.
 */
export interface GmailHistoricalReadAdapter {
  listSentMessages(input: {
    accessToken: string;
    windowStartEpochSeconds: number;
    windowEndEpochSeconds: number;
    pageToken: string | null;
  }): Promise<{
    candidates: { messageId: string; threadId: string }[];
    nextPageToken: string | null;
    quotaUnits: number;
  }>;

  getThread(input: {
    accessToken: string;
    threadId: string;
  }): Promise<{ thread: RawThread; quotaUnits: number }>;
}

const GMAIL_API = "https://gmail.googleapis.com/gmail/v1/users/me";

/**
 * The bounded date expression, and the ONLY thing that varies in the query.
 *
 * EPOCH SECONDS, not `YYYY/MM/DD`. Gmail interprets date strings at midnight
 * Pacific, which silently shifts a window by up to a day depending on the
 * server's idea of the calendar. Epoch seconds have no timezone to be wrong
 * about.
 *
 * `after:` is exclusive, so it is nudged one second earlier to make the range
 * inclusive of the window's first second. This only decides what Gmail OFFERS;
 * the local `internalDate` filter decides what is kept, and it is authoritative.
 *
 * NOTHING ELSE REACHES `q`. Not a browser string, not a CLI free-text argument,
 * not a database column. A Gmail search query is a capability — it can ask for
 * anything in the mailbox — and B03 constructs the whole of it.
 */
export function buildSentWindowQuery(
  windowStartEpochSeconds: number,
  windowEndEpochSeconds: number,
): string {
  const after = Math.max(Math.floor(windowStartEpochSeconds) - 1, 0);
  const before = Math.floor(windowEndEpochSeconds);
  return `after:${after} before:${before}`;
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

/**
 * The production adapter: raw `fetch`, continuing B02's choice not to take on a
 * broad Gmail SDK for a surface this small.
 *
 * The access token travels in the Authorization header and nowhere else — never
 * a query parameter, never a log line, never an error, never a row.
 */
export const gmailHistoricalReadAdapter: GmailHistoricalReadAdapter = {
  async listSentMessages({
    accessToken,
    windowStartEpochSeconds,
    windowEndEpochSeconds,
    pageToken,
  }) {
    const url = new URL(`${GMAIL_API}/messages`);
    // SENT-ROOTED. The label is what makes this an outreach-shaped acquisition
    // rather than an inbox crawl.
    url.searchParams.set("labelIds", "SENT");
    url.searchParams.set("maxResults", String(MESSAGES_LIST_MAX_RESULTS));
    url.searchParams.set("includeSpamTrash", "true");
    url.searchParams.set("q", buildSentWindowQuery(windowStartEpochSeconds, windowEndEpochSeconds));
    // Ask for only what B03 uses. `resultSizeEstimate` is deliberately absent:
    // it is an estimate, and the absence of `nextPageToken` is the only
    // completion signal this pipeline trusts.
    url.searchParams.set("fields", "messages(id,threadId),nextPageToken");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw classifyGmailReadFailure(
        "messages_list",
        response.status,
        providerReason(await readJson(response)),
      );
    }

    const body = (await readJson(response)) as {
      messages?: { id?: string; threadId?: string }[];
      nextPageToken?: string;
    } | null;

    const candidates = (body?.messages ?? [])
      .map((m) => ({ messageId: (m.id ?? "").trim(), threadId: (m.threadId ?? "").trim() }))
      .filter((m) => m.messageId !== "" && m.threadId !== "");

    return {
      candidates,
      nextPageToken: body?.nextPageToken ?? null,
      quotaUnits: MESSAGES_LIST_QUOTA_UNITS,
    };
  },

  async getThread({ accessToken, threadId }) {
    const url = new URL(`${GMAIL_API}/threads/${encodeURIComponent(threadId)}`);
    // `full`, never `raw`. A raw response is the whole RFC822 message including
    // attachment bytes, so asking for it would import files B03 has no business
    // holding — and would do so before any sanitizer could intervene.
    url.searchParams.set("format", "full");
    // Partial response: the approved structure, and no `snippet`.
    url.searchParams.set(
      "fields",
      "id,messages(id,threadId,labelIds,historyId,internalDate,sizeEstimate,payload)",
    );

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw classifyGmailReadFailure(
        "threads_get",
        response.status,
        providerReason(await readJson(response)),
      );
    }

    const thread = (await readJson(response)) as RawThread | null;
    if (!thread || typeof thread.id !== "string" || thread.id.trim() === "") {
      throw new GmailReadError({
        operation: "threads_get",
        status: response.status,
        reason: "malformed_response",
        retryable: false,
      });
    }

    return { thread, quotaUnits: THREADS_GET_QUOTA_UNITS };
  },
};
