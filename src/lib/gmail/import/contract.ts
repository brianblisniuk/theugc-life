/**
 * B03 vocabulary and provider-published constants, in one place both the server
 * and the tests read from.
 *
 * Deliberately free of `server-only` and of any secret: it holds numbers, names
 * and shapes, so the sanitizer tests and the worker tests can import it without
 * pulling in credentials or a database client.
 */

/**
 * WHAT B03 ASKS GOOGLE FOR, and what that costs.
 *
 * Google publishes these per-method quota costs and has changed them before —
 * the values below are the currently published ones, kept together and named so
 * a future correction is one edit rather than a hunt. Everything derived from
 * them is an ESTIMATE of consumption, never a billing statement.
 */
export const MESSAGES_LIST_QUOTA_UNITS = 5;
export const THREADS_GET_QUOTA_UNITS = 40;

/**
 * The per-mailbox budget B03 plans against, deliberately BELOW the published
 * ceiling.
 *
 * Google currently documents 6,000 quota units per minute per user for projects
 * on the current tier (1,200,000 per minute per project). Running at a
 * published ceiling means treating a number that can change, and that other
 * clients of the same user share, as a guarantee. 4,000 leaves room for both.
 *
 * Server-side and typed. A browser cannot choose it; there is no request
 * parameter that reaches it.
 */
export const B03_QUOTA_UNITS_PER_MINUTE_PER_MAILBOX = 4_000;

/** Gmail's documented maximum for `users.messages.list`. */
export const MESSAGES_LIST_MAX_RESULTS = 500;

/**
 * THE ACQUISITION STRATEGY, matching the CHECK in migration 0037.
 *
 * B03 V1 acquires threads rooted in a message the creator SENT inside the
 * window. It is a named value rather than an implicit behaviour so that
 * "import the whole inbox" cannot become true by accident.
 */
export const B03_ACQUISITION_STRATEGY = "sent_rooted_threads_v1";

/** Retry policy. Bounded on purpose: an unbounded loop is not a policy. */
export const B03_MAX_PROVIDER_ATTEMPTS = 5;
export const B03_BACKOFF_BASE_MS = 1_000;
export const B03_BACKOFF_CAP_MS = 32_000;

/**
 * THE HEADERS B03 KEEPS, case-insensitively.
 *
 * Enough for B04 to resolve people, subjects and reply structure later; nothing
 * else. The raw provider VALUE is preserved and NOT parsed here — deciding who
 * an address belongs to is B04's job, and doing it early would bake a guess
 * into the raw layer.
 */
export const B03_ALLOWED_MESSAGE_HEADERS: readonly string[] = [
  "from",
  "sender",
  "reply-to",
  "to",
  "cc",
  "bcc",
  "subject",
  "date",
  "message-id",
  "in-reply-to",
  "references",
];

/**
 * Structural part headers kept so B04 can decode a body it did not fetch.
 * Nothing about the sender, nothing about the content.
 */
export const B03_ALLOWED_PART_HEADERS: readonly string[] = [
  "content-type",
  "content-disposition",
  "content-transfer-encoding",
];

/** The only MIME types whose body data B03 will ever persist. */
export const B03_TEXT_MIME_TYPES: readonly string[] = ["text/plain", "text/html"];

/** Gmail's system label for a message the creator sent. */
export const GMAIL_SENT_LABEL = "SENT";
/** Gmail's system label for a message that was never sent. */
export const GMAIL_DRAFT_LABEL = "DRAFT";

/** Why a part's body was not persisted. Recorded so the gap is measurable. */
export type OmissionReason = "attachment" | "non_text" | "external_body";

export interface SanitizedPart {
  mimeType: string;
  /**
   * The MIME frame of THIS part — charset, transfer encoding, multipart
   * boundary. Never the RFC message headers, and never a filename: a header
   * value carrying a `name=`/`filename=` parameter is dropped whole.
   */
  headers?: Record<string, string>;
  body?: { size: number; data: string };
  /** Present only for parts whose body data was NOT kept. */
  contentOmitted?: true;
  omissionReason?: OmissionReason;
  size?: number;
  parts?: SanitizedPart[];
}

export interface SanitizedMessage {
  providerMessageId: string;
  providerThreadId: string;
  /** Gmail `internalDate`, milliseconds since epoch, as the provider gave it. */
  internalDateMs: number;
  labelIds: string[];
  providerHistoryId: string | null;
  sizeEstimate: number | null;
  /**
   * The RFC MESSAGE headers — From/To/Subject/Date/Message-ID and the rest of
   * the approved set.
   *
   * A separate field from `payload.headers` because for a single-part message
   * Gmail's top-level MessagePart is both the message AND its only MIME part.
   * Sharing one property meant the message headers overwrote the structural ones
   * for the commonest shape of email there is.
   */
  messageHeaders: Record<string, string>;
  payload: SanitizedPart;
}

export interface SanitizeCounters {
  /** Text bodies Gmail stored separately and B03 refused to go and fetch. */
  textPartsOmittedExternal: number;
  /** Attachments and non-text parts whose bytes were never persisted. */
  attachmentOrNonTextPartsOmitted: number;
}

export interface SanitizedThread {
  providerThreadId: string;
  messages: SanitizedMessage[];
  counters: SanitizeCounters;
  /** Messages dropped because they carry Gmail's DRAFT label. */
  draftsDropped: number;
}

/**
 * WHAT A DRAFT IS NOT.
 *
 * A draft inside a thread is not evidence that anything was sent. It is a
 * sentence somebody typed and did not send, and counting it as imported
 * communication would make every later timing and outcome layer wrong in the
 * same direction. Dropped entirely — not stored and not counted.
 */
export function isDraft(labelIds: readonly string[] | undefined): boolean {
  return (labelIds ?? []).includes(GMAIL_DRAFT_LABEL);
}
