import { runScheduledDispatch } from "../../src/lib/gmail/send/dispatch-auth";
import { dispatchDueGmailSends } from "../../src/lib/gmail/send/dispatch";
import { productionSendDeps } from "../../src/lib/gmail/send/dispatch.server";
import { authorizationFromEvent } from "../../src/lib/jobs/scheduled-post";

/**
 * Netlify schedule. The cron is in netlify.toml. This is not a background function.
 * Dispatch runs in this process. A missing or short GMAIL_DISPATCH_SECRET
 * does not claim or send. A caller without the bearer does not claim or send.
 * Claude is not imported. Sends still pass the existing guard, and
 * NODE_ENV=test throws before any Gmail send request.
 */
export const handler = async (event?: {
  headers?: Record<string, string | undefined> | null;
}): Promise<{ statusCode: number; body: string }> =>
  runScheduledDispatch({
    secret: process.env.GMAIL_DISPATCH_SECRET ?? null,
    authorization: authorizationFromEvent(event),
    run: () => dispatchDueGmailSends(productionSendDeps(), { now: new Date() }),
  });
