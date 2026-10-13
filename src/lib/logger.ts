import "server-only";

import { redact, redactString } from "@/lib/log/redact";

/**
 * Minimal server-safe structured logger.
 *
 * Design goals (PRD §25.7, PERMISSIONS.md §6, §16, E05):
 *  - JSON output, one line per event, suitable for platform log ingestion.
 *  - Never leak secrets or sensitive creator data. Emails, tokens, message
 *    bodies, and share tokens are redacted before serialization.
 *  - No heavy dependency and no Node-only APIs, so it is safe on the Edge runtime
 *    (middleware) as well as the Node runtime.
 *
 * This is intentionally small. Observability does not add a vendor.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogContext = Record<string, unknown>;

function write(level: LogLevel, message: string, context?: LogContext): void {
  const entry = {
    level,
    time: new Date().toISOString(),
    message: redactString(message),
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
