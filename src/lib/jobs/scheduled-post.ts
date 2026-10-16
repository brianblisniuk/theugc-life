/**
 * Gate for a Netlify scheduled function.
 *
 * The function runs the job in this process. It does not POST to the public
 * site: password protection answers that request with 401 before the app
 * route runs, so the job never starts. A missing secret, or a secret shorter
 * than 16 characters, fails closed and does not call the job. The secret is
 * not logged and is not copied into the result.
 *
 * The path constants are the bearer-gated HTTP routes. Those routes stay.
 * The schedule does not call them.
 */

export const INBOX_SYNC_PATH = "/api/internal/gmail-inbox-sync";
export const ACCOUNT_ERASURE_PATH = "/api/internal/account-erasure";
export const CREDIT_PERIOD_PATH = "/api/internal/credit-period-refresh";
export const FOLLOWUP_HOUSEKEEPING_PATH = "/api/internal/gmail-followup-housekeeping";
export const GMAIL_SEND_DISPATCH_PATH = "/api/internal/gmail-send-dispatch";

const MIN_SECRET_LENGTH = 16;

/**
 * A code or name safe to put in a log line and a JSON body.
 * Messages are not included: they can carry tokens, mailbox addresses, or
 * request URLs. Hyphens, dots, and `@` are rejected for the same reason.
 */
const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const SAFE_ERROR_NUMBER = /^\d{1,6}$/;

export function scheduledSecretConfigured(secret: string | null | undefined): secret is string {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}

function safeErrorToken(value: unknown): string | null {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 999999) {
    return String(value);
  }
  if (typeof value !== "string") return null;
  if (SAFE_ERROR_NAME.test(value) || SAFE_ERROR_NUMBER.test(value)) return value;
  return null;
}

function scheduledFailure(error: unknown): { name: string; code: string } {
  const name = error instanceof Error ? (safeErrorToken(error.name) ?? "Error") : "Error";
  const raw =
    error !== null && typeof error === "object" && "code" in error
      ? (error as { code: unknown }).code
      : undefined;
  return { name, code: safeErrorToken(raw) ?? name };
}

export async function runScheduledJob(options: {
  secret: string | null;
  run: () => Promise<object>;
}): Promise<{ statusCode: number; body: string }> {
  if (!scheduledSecretConfigured(options.secret)) {
    return { statusCode: 500, body: JSON.stringify({ result: "not_configured" }) };
  }
  try {
    const summary = await options.run();
    const body =
      summary && typeof summary === "object"
        ? { result: "ok", ...(summary as Record<string, unknown>) }
        : { result: "ok" };
    return { statusCode: 200, body: JSON.stringify(body) };
  } catch (error) {
    const failure = scheduledFailure(error);
    // Name and code only. Never the message, the stack, or the secret.
    console.error("[job] scheduled run failed", failure.name, failure.code);
    return {
      statusCode: 500,
      body: JSON.stringify({ result: "error", code: failure.code }),
    };
  }
}
