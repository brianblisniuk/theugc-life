import { createHash } from "node:crypto";

import {
  B03_ALLOWED_MESSAGE_HEADERS,
  B03_ALLOWED_PART_HEADERS,
  B03_TEXT_MIME_TYPES,
  isDraft,
  type OmissionReason,
  type SanitizedMessage,
  type SanitizedPart,
  type SanitizedThread,
} from "@/lib/gmail/import/contract";
import { GmailReadError } from "@/lib/gmail/import/errors";

/**
 * THE ONE PLACE THAT DECIDES WHAT LEAVES GMAIL AND ENTERS STORAGE.
 *
 * B03 needs message text, because B04/B05/B07 will need something to read. It
 * does not need files, and it must not acquire them: attachment bytes are the
 * largest, most sensitive and least necessary thing a mailbox contains, and the
 * cheapest way to guarantee they are never stored is to never fetch them.
 *
 * So this is a whitelist, not a blacklist. A part whose shape this function does
 * not recognise loses its body — the failure mode of a new Gmail MIME variant is
 * "we kept less than we could have", never "we stored something we should not
 * have".
 *
 * Deterministic and pure: same provider response in, same structure out, same
 * digest. No clock, no randomness, no I/O.
 */

interface RawHeader {
  name?: string;
  value?: string;
}

interface RawPart {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: RawHeader[];
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: RawPart[];
}

export interface RawMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: RawPart;
  /** Present in provider responses; never persisted. */
  snippet?: string;
  raw?: string;
}

export interface RawThread {
  id?: string;
  messages?: RawMessage[];
}

const lower = (value: string | undefined): string => (value ?? "").trim().toLowerCase();

/**
 * A `name=` or `filename=` MIME parameter, in any casing, quoted or not.
 *
 * The leading `(?:^|[;\s])` is what keeps `boundary=...` — a normal, useful part
 * of a multipart `Content-Type` — from matching, while `; name=x.txt` and
 * `;filename="x.txt"` both do.
 */
const FILENAME_PARAMETER = /(?:^|[;\s])(?:file)?name\s*=/i;

function pickHeaders(headers: RawHeader[] | undefined, allowed: readonly string[]) {
  const kept: Record<string, string> = {};
  for (const header of headers ?? []) {
    const name = lower(header?.name);
    if (!name || !allowed.includes(name)) continue;
    if (typeof header.value !== "string") continue;
    // A HEADER THAT CARRIES A FILENAME IS DROPPED WHOLE.
    //
    // `Content-Disposition: inline; filename="offer-for-marina.pdf"` and
    // `Content-Type: text/plain; name="notes.txt"` are structural headers that
    // also happen to contain a fact about somebody's life. B03 has no use for a
    // filename, so it does not keep one — not in a field of its own, and not
    // smuggled inside a header it was keeping for another reason.
    if (FILENAME_PARAMETER.test(header.value)) continue;
    // Otherwise the provider's raw VALUE, unparsed. Turning "Alice <a@x>" into a
    // person is B04's decision, and making it here would freeze a guess into the
    // raw layer.
    kept[name] = header.value;
  }
  return kept;
}

function headerValue(headers: RawHeader[] | undefined, name: string): string {
  for (const header of headers ?? []) {
    if (lower(header?.name) === name) return lower(header?.value);
  }
  return "";
}

function rawHeaderValue(headers: RawHeader[] | undefined, name: string): string {
  for (const header of headers ?? []) {
    if (lower(header?.name) === name && typeof header.value === "string") return header.value;
  }
  return "";
}

/**
 * Is this part NAMED — that is, does anything about it say "this is a file"?
 *
 * Gmail is not consistent about where the name appears. `part.filename` is the
 * obvious place and it is frequently empty while a `Content-Disposition` or a
 * `Content-Type` carries the name instead. Trusting only `part.filename` means
 * storing a filename whenever the provider declines to duplicate it, which is
 * the provider's formatting choice deciding our privacy posture.
 */
function partIsNamed(part: RawPart): boolean {
  if ((part.filename ?? "").trim() !== "") return true;
  if (FILENAME_PARAMETER.test(rawHeaderValue(part.headers, "content-disposition"))) return true;
  if (FILENAME_PARAMETER.test(rawHeaderValue(part.headers, "content-type"))) return true;
  return false;
}

/**
 * May this part's BODY DATA be persisted?
 *
 * All four conditions, and each one is load-bearing:
 *
 *   an exact text MIME type   `text/plain` or `text/html`. Not a prefix match:
 *                             `text/calendar` and friends are files with a
 *                             text-ish label
 *   not named                 a named part is a file, whatever its type and
 *                             wherever the provider put the name
 *   no attachmentId           Gmail is telling us the data lives elsewhere
 *   not dispositioned as an   the sender said it is an attachment; believe them
 *   attachment
 */
function bodyIsPersistableText(part: RawPart): boolean {
  if (!B03_TEXT_MIME_TYPES.includes(lower(part.mimeType))) return false;
  if (partIsNamed(part)) return false;
  if (part.body?.attachmentId) return false;
  if (headerValue(part.headers, "content-disposition").startsWith("attachment")) return false;
  return true;
}

function omissionReasonFor(part: RawPart): OmissionReason {
  if (partIsNamed(part)) return "attachment";
  if (headerValue(part.headers, "content-disposition").startsWith("attachment"))
    return "attachment";
  if (B03_TEXT_MIME_TYPES.includes(lower(part.mimeType)) && part.body?.attachmentId) {
    // A TEXT BODY GMAIL STORED SEPARATELY.
    //
    // `attachmentId` does not only mean "a file"; Gmail also uses it for MIME
    // data it did not inline. B03 does not follow it even here, because
    // following it means calling `attachments.get`, and B03 has no such call —
    // by interface, not by discipline. The omission is RECORDED so a later
    // evaluation can measure how much of the historical record was unavailable
    // rather than discovering the hole by its silence.
    return "external_body";
  }
  return "non_text";
}

interface PartResult {
  part: SanitizedPart;
  externalTextOmitted: number;
  attachmentOrNonTextOmitted: number;
}

function sanitizePart(part: RawPart): PartResult {
  const mimeType = lower(part.mimeType) || "application/octet-stream";
  let externalTextOmitted = 0;
  let attachmentOrNonTextOmitted = 0;

  const children: SanitizedPart[] = [];
  for (const child of part.parts ?? []) {
    const result = sanitizePart(child);
    children.push(result.part);
    externalTextOmitted += result.externalTextOmitted;
    attachmentOrNonTextOmitted += result.attachmentOrNonTextOmitted;
  }

  const sanitized: SanitizedPart = { mimeType };
  const hasBodyData = typeof part.body?.data === "string" && part.body.data.length > 0;

  // STRUCTURAL HEADERS, ON EVERY PART.
  //
  // They describe the MIME frame — the charset a body is in, the transfer
  // encoding it needs, the boundary that holds a multipart together — and B04
  // needs them to decode what B03 stored. The reason they were once kept only
  // beside a persisted body was that `Content-Disposition` smuggles filenames;
  // that leak is now closed at the header level by `pickHeaders`, so the
  // structure can be kept without the name.
  const structuralHeaders = pickHeaders(part.headers, B03_ALLOWED_PART_HEADERS);
  if (Object.keys(structuralHeaders).length > 0) sanitized.headers = structuralHeaders;

  if (hasBodyData && bodyIsPersistableText(part)) {
    sanitized.body = { size: part.body?.size ?? 0, data: part.body!.data! };
  } else if (hasBodyData || part.body?.attachmentId) {
    // Structural metadata only. Never `data`, never `attachmentId`, and
    // deliberately never the filename: B03 has no use for it, and a filename is
    // content about a person's life.
    const reason = omissionReasonFor(part);
    sanitized.contentOmitted = true;
    sanitized.omissionReason = reason;
    if (typeof part.body?.size === "number") sanitized.size = part.body.size;
    if (reason === "external_body") externalTextOmitted += 1;
    else attachmentOrNonTextOmitted += 1;
  }

  if (children.length > 0) sanitized.parts = children;

  return { part: sanitized, externalTextOmitted, attachmentOrNonTextOmitted };
}

export function sanitizeMessage(message: RawMessage): {
  message: SanitizedMessage;
  externalTextOmitted: number;
  attachmentOrNonTextOmitted: number;
} | null {
  const providerMessageId = (message.id ?? "").trim();
  const providerThreadId = (message.threadId ?? "").trim();
  const internalDateMs = Number(message.internalDate);

  // A message with no identity or no time is not a message we can store, index
  // or ever delete deliberately. The CALLER decides what that means; returning
  // null here is a statement about this message, not a decision to ignore it.
  if (!providerMessageId || !providerThreadId || !Number.isFinite(internalDateMs)) return null;

  const payload = sanitizePart(message.payload ?? {});

  // TWO HEADER NAMESPACES, NEVER ONE.
  //
  // For a single-part message Gmail's top-level MessagePart is BOTH things at
  // once: the RFC message carrying From/To/Subject, and the MIME part carrying
  // Content-Type and Content-Transfer-Encoding. Writing the message headers into
  // `payload.headers` therefore destroyed the structural ones — the charset and
  // the transfer encoding of the very body being stored — for exactly the
  // commonest shape of email there is. They are separate fields because they are
  // separate facts, and neither may overwrite the other.
  const messageHeaders = pickHeaders(message.payload?.headers, B03_ALLOWED_MESSAGE_HEADERS);

  return {
    message: {
      providerMessageId,
      providerThreadId,
      internalDateMs,
      labelIds: [...(message.labelIds ?? [])].sort(),
      providerHistoryId: message.historyId ?? null,
      sizeEstimate: typeof message.sizeEstimate === "number" ? message.sizeEstimate : null,
      messageHeaders,
      payload: payload.part,
    },
    externalTextOmitted: payload.externalTextOmitted,
    attachmentOrNonTextOmitted: payload.attachmentOrNonTextOmitted,
  };
}

/**
 * Sanitize a whole fetched thread, bounded LOCALLY to the run's window.
 *
 * Gmail's search decides which threads are offered; this decides which messages
 * are kept. The window is half-open — `[start, end)` — so two adjacent windows
 * neither overlap nor leave a gap between them.
 */
export function sanitizeThread(
  thread: RawThread,
  window: { startMs: number; endMs: number },
): SanitizedThread {
  const providerThreadId = (thread.id ?? "").trim();
  const messages: SanitizedMessage[] = [];
  let textPartsOmittedExternal = 0;
  let attachmentOrNonTextPartsOmitted = 0;
  let draftsDropped = 0;

  if (!providerThreadId) {
    throw new GmailReadError({
      operation: "threads_get",
      status: null,
      reason: "malformed_response",
      retryable: false,
    });
  }

  for (const raw of thread.messages ?? []) {
    if (isDraft(raw.labelIds)) {
      draftsDropped += 1;
      continue;
    }
    const sanitized = sanitizeMessage(raw);

    // A NON-DRAFT MESSAGE WITH NO IDENTITY OR NO TIME IS A PROVIDER CONTRACT
    // VIOLATION, and it must not be quietly skipped.
    //
    // Skipping it and then marking the thread `complete` would record "this
    // conversation contained these messages" about a conversation we could not
    // fully read — the one failure mode that makes every later layer confidently
    // wrong. Failing the fetch keeps the work item pending, and if it keeps
    // happening the run ends `failed` rather than `completed`.
    if (!sanitized) {
      throw new GmailReadError({
        operation: "threads_get",
        status: null,
        reason: "malformed_response",
        retryable: false,
      });
    }

    const at = sanitized.message.internalDateMs;
    if (at < window.startMs || at >= window.endMs) continue;
    messages.push(sanitized.message);
    textPartsOmittedExternal += sanitized.externalTextOmitted;
    attachmentOrNonTextPartsOmitted += sanitized.attachmentOrNonTextOmitted;
  }

  return {
    providerThreadId,
    messages,
    counters: { textPartsOmittedExternal, attachmentOrNonTextPartsOmitted },
    draftsDropped,
  };
}

/**
 * A CANONICAL FORM, so the same snapshot hashes the same way twice.
 *
 * JSON object key order is an accident of how a response was parsed, not a fact
 * about the message. Sorting keys means a provider that reorders its fields
 * does not look like a changed message — which is the whole point of the digest:
 * to let a replay skip a meaningless write.
 *
 * Nothing volatile goes in. No local timestamps, no run id, no attempt count.
 */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      if (source[key] === undefined) continue;
      out[key] = canonicalize(source[key]);
    }
    return out;
  }
  return value;
}

/**
 * The digest of a sanitized message snapshot.
 *
 * Metadata about content, not content: a hash cannot be read back into a
 * sentence, so it is safe to store beside the row and compare on replay. The
 * plaintext it summarises is never logged.
 */
export function sanitizedMessageDigest(message: SanitizedMessage): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize({
          provider_message_id: message.providerMessageId,
          provider_thread_id: message.providerThreadId,
          internal_date_ms: message.internalDateMs,
          label_ids: [...message.labelIds].sort(),
          provider_history_id: message.providerHistoryId,
          size_estimate: message.sizeEstimate,
          message_headers: message.messageHeaders,
          payload: message.payload,
        }),
      ),
    )
    .digest("hex");
}

/** The row shape `gmail_historical_import_commit_thread` accepts. */
export function toCommitRow(message: SanitizedMessage) {
  return {
    provider_message_id: message.providerMessageId,
    provider_thread_id: message.providerThreadId,
    internal_date: new Date(message.internalDateMs).toISOString(),
    provider_history_id: message.providerHistoryId,
    label_ids: message.labelIds,
    sanitized_payload: canonicalize({
      provider_message_id: message.providerMessageId,
      provider_thread_id: message.providerThreadId,
      internal_date_ms: message.internalDateMs,
      label_ids: message.labelIds,
      provider_history_id: message.providerHistoryId,
      size_estimate: message.sizeEstimate,
      message_headers: message.messageHeaders,
      payload: message.payload,
    }),
    payload_sha256: sanitizedMessageDigest(message),
  };
}
