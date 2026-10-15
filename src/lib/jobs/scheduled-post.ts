/**
 * Bearer gate for a Netlify scheduled function.
 *
 * The function does not run the job. It POSTs to an internal route, and that
 * route is what the tests mock. A missing site URL, a missing secret, or a
 * secret shorter than 16 characters fails closed and does not call fetch.
 */

export const INBOX_SYNC_PATH = "/api/internal/gmail-inbox-sync";
export const ACCOUNT_ERASURE_PATH = "/api/internal/account-erasure";
export const CREDIT_PERIOD_PATH = "/api/internal/credit-period-refresh";
export const FOLLOWUP_HOUSEKEEPING_PATH = "/api/internal/gmail-followup-housekeeping";
export const GMAIL_SEND_DISPATCH_PATH = "/api/internal/gmail-send-dispatch";

const INTERNAL_PREFIX = "/api/internal/";

export async function runScheduledPost(options: {
  fetchImpl: typeof fetch;
  siteUrl: string | null;
  secret: string | null;
  path: string;
}): Promise<{ statusCode: number; body: string }> {
  if (
    !options.secret ||
    options.secret.length < 16 ||
    !options.siteUrl ||
    !options.path.startsWith(INTERNAL_PREFIX)
  ) {
    return { statusCode: 500, body: JSON.stringify({ result: "not_configured" }) };
  }
  const response = await options.fetchImpl(`${options.siteUrl.replace(/\/$/, "")}${options.path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${options.secret}` },
  });
  return { statusCode: response.status, body: await response.text() };
}
