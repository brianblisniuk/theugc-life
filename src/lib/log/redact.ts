/**
 * Shared redaction for server logs.
 *
 * Keys that name an email, token, message body, or share token are replaced.
 * String values are also scanned so a benign key cannot carry an address, a
 * bearer token, a share-link path, or a 64-character share token.
 */

const REDACT_KEY_PATTERNS = [
  "private_notes",
  "privatenotes",
  "note",
  "password",
  "token",
  "secret",
  "service_role",
  "authorization",
  "cookie",
  "email",
  "phone",
  "linkedin",
  "value_amount",
  "apikey",
  "api_key",
  "access_token",
  "refresh_token",
  "jwt",
  "message_body",
  "messagebody",
  "raw_body",
  "text_body",
  "html_body",
  "mime_body",
  "snippet",
  "prompt",
  "completion",
  "decoded_text",
  "plain_text",
  "share_token",
  "sharetoken",
] as const;

export const REDACTED = "[redacted]";
const MAX_DEPTH = 6;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const BEARER = /Bearer\s+\S+/gi;
const SHARE_PATH = /\/p\/[^/?#\s]+/g;
const SHARE_TOKEN = /\b[a-f0-9]{64}\b/gi;
const GOOGLE_SECRET = /\b(?:GOCSPX-|ya29\.)\S+/g;

export function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return REDACT_KEY_PATTERNS.some((pattern) => normalized.includes(pattern));
}

/** Token counts are numbers. A string under the same name is still a secret. */
function isUsageCount(key: string, value: unknown): boolean {
  const normalized = key.toLowerCase().replace(/_/g, "");
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    (normalized === "inputtokens" ||
      normalized === "outputtokens" ||
      normalized === "cachecreationinputtokens" ||
      normalized === "cachereadinputtokens")
  );
}

export function redactString(value: string): string {
  return value
    .replace(EMAIL, REDACTED)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(SHARE_PATH, "/p/[redacted]")
    .replace(SHARE_TOKEN, REDACTED)
    .replace(GOOGLE_SECRET, REDACTED);
}

/** Drop the share token and any query string before a path is logged. */
export function redactPath(path: string): string {
  const pathname = path.split("?")[0] ?? path;
  return redactString(pathname.replace(/\/p\/[^/]+/g, "/p/[redacted]"));
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : value.stack,
    };
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] =
        shouldRedactKey(key) && !isUsageCount(key, entry) ? REDACTED : redact(entry, depth + 1);
    }
    return out;
  }
  return value;
}
