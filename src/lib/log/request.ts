import { redactPath } from "@/lib/log/redact";

const REQUEST_ID = /^[A-Za-z0-9_-]{8,80}$/;

export function normalizeRequestId(header: string | null): string {
  if (header && REQUEST_ID.test(header)) return header;
  return crypto.randomUUID();
}

/** One JSON line. The path has no query string and no share token. */
export function requestLogLine(input: { requestId: string; method: string; path: string }): string {
  return JSON.stringify({
    level: "info",
    time: new Date().toISOString(),
    message: "request",
    context: {
      requestId: input.requestId,
      method: input.method,
      path: redactPath(input.path),
    },
  });
}

export function writeRequestLog(input: { requestId: string; method: string; path: string }): void {
  // eslint-disable-next-line no-console
  console.info(requestLogLine(input));
}
