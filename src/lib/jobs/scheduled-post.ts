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

export function scheduledSecretConfigured(secret: string | null | undefined): secret is string {
  return typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH;
}

export async function runScheduledJob(options: {
  secret: string | null;
  run: () => Promise<object>;
}): Promise<{ statusCode: number; body: string }> {
  if (!scheduledSecretConfigured(options.secret)) {
    return { statusCode: 500, body: JSON.stringify({ result: "not_configured" }) };
  }
  const summary = await options.run();
  const body =
    summary && typeof summary === "object"
      ? { result: "ok", ...(summary as Record<string, unknown>) }
      : { result: "ok" };
  return { statusCode: 200, body: JSON.stringify(body) };
}
