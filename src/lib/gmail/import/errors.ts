import {
  B03_BACKOFF_BASE_MS,
  B03_BACKOFF_CAP_MS,
  B03_MAX_PROVIDER_ATTEMPTS,
} from "@/lib/gmail/import/contract";

/**
 * WHAT B03 IS ALLOWED TO KNOW ABOUT A FAILED GMAIL CALL.
 *
 * A provider error body can contain anything — a subject line, an address, the
 * token that was rejected. B02 learned this the expensive way when a truncated
 * provider message could carry a credential into the logs, and the fix there is
 * the rule here: free text is DISCARDED, not shortened. What survives is a
 * status, an allow-listed reason, and a boolean.
 */

export type GmailReadOperation = "messages_list" | "threads_get";

/** The only reason codes B03 will ever persist or log. */
const ALLOWED_REASONS = new Set([
  "rate_limit_exceeded",
  "user_rate_limit_exceeded",
  "backend_error",
  "service_unavailable",
  "gateway_timeout",
  "internal_error",
  "thread_not_found",
  "forbidden",
  "bad_request",
  "malformed_response",
  "unknown",
]);

export class GmailReadError extends Error {
  readonly operation: GmailReadOperation;
  readonly status: number | null;
  readonly reason: string;
  readonly retryable: boolean;

  constructor(init: {
    operation: GmailReadOperation;
    status: number | null;
    reason: string;
    retryable: boolean;
  }) {
    // The MESSAGE is the sanitized code, so even an accidental `String(error)`
    // in some future call site cannot leak a provider body.
    super(init.reason);
    this.name = "GmailReadError";
    this.operation = init.operation;
    this.status = init.status;
    this.reason = ALLOWED_REASONS.has(init.reason) ? init.reason : "unknown";
    this.retryable = init.retryable;
  }
}

/**
 * Classify an HTTP status and a provider reason string.
 *
 * The reason is matched against a fixed vocabulary and otherwise thrown away.
 * `notFound` on a thread is deliberately NOT an error the run fails on — see
 * `thread_not_found`.
 */
export function classifyGmailReadFailure(
  operation: GmailReadOperation,
  status: number | null,
  rawReason: unknown,
): GmailReadError {
  const reason =
    typeof rawReason === "string" && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(rawReason)
      ? rawReason.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase()
      : null;

  // TIME-BASED QUOTA ERRORS. Google documents truncated exponential backoff for
  // exactly these, and they are the ones a historical import is most likely to
  // meet: it is, by design, a burst of reads against one mailbox.
  if (status === 429 || reason === "rate_limit_exceeded" || reason === "user_rate_limit_exceeded") {
    return new GmailReadError({
      operation,
      status,
      reason:
        reason === "user_rate_limit_exceeded" ? "user_rate_limit_exceeded" : "rate_limit_exceeded",
      retryable: true,
    });
  }

  if (status !== null && status >= 500 && status <= 599) {
    const byStatus =
      status === 502
        ? "backend_error"
        : status === 503
          ? "service_unavailable"
          : status === 504
            ? "gateway_timeout"
            : "internal_error";
    return new GmailReadError({ operation, status, reason: byStatus, retryable: true });
  }

  // A THREAD THAT IS NO LONGER THERE. Terminal for one work item, and not a
  // failure of the import: B03 is a snapshot of what Gmail exposes at import
  // time, and a human deleting their own conversation is not an error.
  if (status === 404) {
    return new GmailReadError({ operation, status, reason: "thread_not_found", retryable: false });
  }

  // A 403 IS NOT PROOF THAT A REFRESH TOKEN DIED.
  //
  // It can be a project-level quota decision, a scope problem, or a policy
  // block. B02 owns the question of whether we may still read this mailbox, and
  // it answers it from the database rather than from a provider status. B03
  // reinterpreting a 403 as a dead credential would delete a working
  // authorization to explain a rate limit — the same category of mistake
  // amendment #1 removed from the refresh path.
  if (status === 403) {
    return new GmailReadError({ operation, status, reason: "forbidden", retryable: false });
  }

  if (status !== null && status >= 400 && status <= 499) {
    return new GmailReadError({ operation, status, reason: "bad_request", retryable: false });
  }

  return new GmailReadError({ operation, status, reason: "unknown", retryable: false });
}

/**
 * Truncated exponential backoff with jitter.
 *
 * Truncated because an unbounded delay is a hang with better manners; jittered
 * because synchronised retries are how a transient failure becomes a sustained
 * one. `random` is injected so a test asserts the policy rather than waiting
 * for it.
 */
export function backoffDelayMs(attempt: number, random: () => number = Math.random): number {
  const exponential = Math.min(
    B03_BACKOFF_BASE_MS * 2 ** Math.max(attempt - 1, 0),
    B03_BACKOFF_CAP_MS,
  );
  const jitter = Math.floor(random() * 1_000);
  return Math.min(exponential + jitter, B03_BACKOFF_CAP_MS);
}

export function attemptsExhausted(attemptCount: number): boolean {
  return attemptCount >= B03_MAX_PROVIDER_ATTEMPTS;
}
