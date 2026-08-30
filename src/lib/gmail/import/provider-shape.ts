import { GmailReadError, type GmailReadOperation } from "@/lib/gmail/import/errors";

/**
 * WHAT A REAL GMAIL ANSWER LOOKS LIKE, CHECKED AT RUNTIME.
 *
 * A TypeScript cast over parsed JSON is a note about what we EXPECT, not a fact
 * about what arrived. The gap between the two is where a provider contract
 * violation becomes a statement about somebody's life: an unparsable list
 * response read as "this creator sent nothing", a message with no timestamp
 * silently dated 1970, a thread with no messages marked complete.
 *
 * So every field B03 relies on is validated before its absence is allowed to
 * mean absence. The failure mode is always the same and always loud:
 * `malformed_response`, non-retryable, which fails the page or the thread and
 * keeps the run away from `completed`.
 *
 * Nothing here coerces. `[]`, `{}`, `0` and `null` are never manufactured to
 * paper over a shape we did not get.
 */

function malformed(operation: GmailReadOperation): GmailReadError {
  return new GmailReadError({
    operation,
    status: null,
    reason: "malformed_response",
    retryable: false,
  });
}

/**
 * A JSON object, and specifically NOT an array.
 *
 * `typeof [] === "object"` is the exact hole this closes: a `200 []` passed a
 * `typeof body === "object"` check, then produced `messages: undefined` and
 * `nextPageToken: undefined`, which reads as a successful, final, empty page.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Gmail's `internalDate` is documented as a string of milliseconds since the
 * epoch. `Number.isFinite(Number(x))` is not enough to check that:
 * `Number("")`, `Number("   ")` and `Number(null)` are all `0`, so a message
 * with no date at all was accepted and stored as 1 January 1970 — a fact about
 * a conversation, invented by a coercion rule.
 */
export function parseInternalDateMs(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^-?\d{1,15}$/.test(trimmed)) return null;
  const ms = Number(trimmed);
  return Number.isSafeInteger(ms) ? ms : null;
}

export interface ListCandidate {
  messageId: string;
  threadId: string;
}

/**
 * `users.messages.list`, validated whole.
 *
 * ONE BAD CANDIDATE FAILS THE WHOLE PAGE. Dropping it would shrink the candidate
 * set with nothing downstream able to tell, and a thread that was never
 * enumerated is a thread that will never be imported.
 */
export function parseGmailListResponse(body: unknown): {
  candidates: ListCandidate[];
  nextPageToken: string | null;
} {
  if (!isPlainObject(body)) throw malformed("messages_list");

  // ABSENT is legitimate — Gmail omits `messages` on an empty page. Present and
  // not a list is not.
  if (body.messages !== undefined && !Array.isArray(body.messages)) {
    throw malformed("messages_list");
  }

  const candidates: ListCandidate[] = [];
  for (const entry of (body.messages as unknown[]) ?? []) {
    if (!isPlainObject(entry)) throw malformed("messages_list");
    if (!nonEmptyString(entry.id) || !nonEmptyString(entry.threadId)) {
      throw malformed("messages_list");
    }
    candidates.push({ messageId: entry.id.trim(), threadId: entry.threadId.trim() });
  }

  if (body.nextPageToken !== undefined && !nonEmptyString(body.nextPageToken)) {
    // The cursor is the only thing that decides whether enumeration is over.
    // A malformed one must never be read as "no more pages".
    throw malformed("messages_list");
  }

  return {
    candidates,
    nextPageToken: typeof body.nextPageToken === "string" ? body.nextPageToken : null,
  };
}

export interface ValidHeader {
  name: string;
  value: string;
}

export interface ValidPart {
  mimeType?: string;
  filename?: string;
  headers?: ValidHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: ValidPart[];
}

export interface ValidMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  historyId?: string;
  internalDate: string;
  sizeEstimate?: number;
  payload: ValidPart;
}

export interface ValidThread {
  id: string;
  messages: (ValidMessage | { labelIds: string[] })[];
}

function validatePart(value: unknown): ValidPart {
  if (!isPlainObject(value)) throw malformed("threads_get");

  const part: ValidPart = {};

  if (value.mimeType !== undefined) {
    if (typeof value.mimeType !== "string") throw malformed("threads_get");
    part.mimeType = value.mimeType;
  }
  if (value.filename !== undefined) {
    if (typeof value.filename !== "string") throw malformed("threads_get");
    part.filename = value.filename;
  }

  if (value.headers !== undefined) {
    if (!Array.isArray(value.headers)) throw malformed("threads_get");
    part.headers = value.headers.map((header) => {
      if (!isPlainObject(header)) throw malformed("threads_get");
      if (typeof header.name !== "string" || typeof header.value !== "string") {
        // A header whose name or value is not a string is not a header. Coercing
        // it would invent a header value nobody wrote.
        throw malformed("threads_get");
      }
      return { name: header.name, value: header.value };
    });
  }

  if (value.body !== undefined) {
    if (!isPlainObject(value.body)) throw malformed("threads_get");
    const body: ValidPart["body"] = {};
    if (value.body.attachmentId !== undefined) {
      if (typeof value.body.attachmentId !== "string") throw malformed("threads_get");
      body.attachmentId = value.body.attachmentId;
    }
    if (value.body.size !== undefined) {
      if (typeof value.body.size !== "number" || !Number.isFinite(value.body.size)) {
        throw malformed("threads_get");
      }
      body.size = value.body.size;
    }
    if (value.body.data !== undefined) {
      if (typeof value.body.data !== "string") throw malformed("threads_get");
      body.data = value.body.data;
    }
    part.body = body;
  }

  if (value.parts !== undefined) {
    if (!Array.isArray(value.parts)) throw malformed("threads_get");
    part.parts = value.parts.map(validatePart);
  }

  return part;
}

/** Gmail's system label for a message that was never sent. */
const DRAFT = "DRAFT";

function validateLabelIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw malformed("threads_get");
  for (const label of value) {
    if (typeof label !== "string") throw malformed("threads_get");
  }
  return value as string[];
}

/**
 * `users.threads.get`, validated whole.
 *
 * A DRAFT is established from its labels and dropped BEFORE its content is
 * validated: nothing about a draft is stored, so nothing about it can be
 * malformed. Everything else must be a message B03 can identify, place in time,
 * and later delete deliberately — or the fetch fails and the thread stays
 * pending.
 */
export function parseGmailThreadResponse(body: unknown): ValidThread {
  if (!isPlainObject(body)) throw malformed("threads_get");
  if (!nonEmptyString(body.id)) throw malformed("threads_get");
  // A FETCHED THREAD HAS A MESSAGE LIST. An absent one is not "a conversation
  // with nothing in it" — it is a response we did not understand, and treating
  // it as empty would let the work item complete over content we never saw.
  if (!Array.isArray(body.messages)) throw malformed("threads_get");

  const threadId = body.id.trim();
  const messages: ValidThread["messages"] = [];

  for (const entry of body.messages) {
    if (!isPlainObject(entry)) throw malformed("threads_get");

    const labelIds = validateLabelIds(entry.labelIds);
    if ((labelIds ?? []).includes(DRAFT)) {
      messages.push({ labelIds: labelIds ?? [] });
      continue;
    }

    if (!nonEmptyString(entry.id)) throw malformed("threads_get");
    if (!nonEmptyString(entry.threadId)) throw malformed("threads_get");
    // A message that says it belongs to a different conversation is a provider
    // or caller integrity error, and the raw layer keys on the pair.
    if (entry.threadId.trim() !== threadId) throw malformed("threads_get");

    const internalDateMs = parseInternalDateMs(entry.internalDate);
    if (internalDateMs === null) throw malformed("threads_get");

    if (entry.historyId !== undefined && typeof entry.historyId !== "string") {
      throw malformed("threads_get");
    }
    if (
      entry.sizeEstimate !== undefined &&
      (typeof entry.sizeEstimate !== "number" || !Number.isFinite(entry.sizeEstimate))
    ) {
      throw malformed("threads_get");
    }

    messages.push({
      id: entry.id.trim(),
      threadId,
      labelIds,
      historyId: entry.historyId as string | undefined,
      internalDate: String(internalDateMs),
      sizeEstimate: entry.sizeEstimate as number | undefined,
      payload: validatePart(entry.payload),
    });
  }

  return { id: threadId, messages };
}
