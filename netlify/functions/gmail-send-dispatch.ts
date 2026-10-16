import { runScheduledDispatch } from "../../src/lib/gmail/send/dispatch-auth";
import { dispatchDueGmailSends } from "../../src/lib/gmail/send/dispatch";
import { productionSendDeps } from "../../src/lib/gmail/send/dispatch.server";

/**
 * Netlify schedule. The cron is in netlify.toml. This is not a background function.
 * Dispatch runs in this process. A missing or short GMAIL_DISPATCH_SECRET
 * does not claim or send. The scheduler sends no bearer, and a published
 * function with `schedule` set does not accept incoming web requests.
 * Claude is not imported. Sends still pass the existing guard, and
 * NODE_ENV=test throws before any Gmail send request.
 */
export const handler = async (): Promise<{ statusCode: number; body: string }> =>
  runScheduledDispatch({
    secret: process.env.GMAIL_DISPATCH_SECRET ?? null,
    run: () => dispatchDueGmailSends(productionSendDeps(), { now: new Date() }),
  });
