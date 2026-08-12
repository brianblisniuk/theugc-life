import "server-only";

/**
 * Minimal server-safe structured logger.
 *
 * Design goals (PRD §25.7, PERMISSIONS.md §6, §16):
 *  - JSON output, one line per event, suitable for platform log ingestion.
 *  - Never leak secrets or sensitive creator data. Keys matching the redaction
 *    list are replaced with "[redacted]" recursively before serialization.
 *  - No heavy dependency and no Node-only APIs, so it is safe on the Edge runtime
 *    (middleware) as well as the Node runtime.
 *
 * This is intentionally small. If structured-logging needs grow (sampling,
 * transports), revisit with an approved dependency rather than expanding this.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Keys whose values must never be logged. Matching is case-insensitive and by
 * substring so that e.g. `private_notes`, `creatorPrivateNotes`, `authToken`
 * are all caught.
 */
const REDACT_KEY_PATTERNS = [
  "private_notes",
  "privatenotes",
  "note", // negotiation/private notes
  "password",
  "token",
  "secret",
  "service_role",
  "authorization",
  "cookie",
  "email",
  "phone",
  "linkedin",
  "value_amount", // private collaboration monetary value
  "apikey",
  "api_key",
  "access_token",
  "refresh_token",
  "jwt",
] as const;

const REDACTED = "[redacted]";
const MAX_DEPTH = 6;

function shouldRedactKey(key: string): boolean {
  const k = key.toLowerCase();
  return REDACT_KEY_PATTERNS.some((p) => k.includes(p));
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[truncated]";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = shouldRedactKey(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export type LogContext = Record<string, unknown>;

function write(level: LogLevel, message: string, context?: LogContext): void {
  const entry = {
    level,
    time: new Date().toISOString(),
    message,
    ...(context ? { context: redact(context) } : {}),
  };
  const line = JSON.stringify(entry);
  // Route through the matching console method so platform log levels are honored.
  switch (level) {
    case "debug":
      // eslint-disable-next-line no-console
      console.debug(line);
      break;
    case "info":
      // eslint-disable-next-line no-console
      console.info(line);
      break;
    case "warn":
      // eslint-disable-next-line no-console
      console.warn(line);
      break;
    case "error":
      // eslint-disable-next-line no-console
      console.error(line);
      break;
  }
}

export const logger = {
  debug: (message: string, context?: LogContext) => write("debug", message, context),
  info: (message: string, context?: LogContext) => write("info", message, context),
  warn: (message: string, context?: LogContext) => write("warn", message, context),
  error: (message: string, context?: LogContext) => write("error", message, context),
  /** Exposed for unit testing of the redaction rules. */
  _redact: redact,
};
