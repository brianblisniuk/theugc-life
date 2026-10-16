import { runProductionInboxSync } from "../../src/lib/gmail/sync/scheduled.server";
import { runScheduledJob } from "../../src/lib/jobs/scheduled-post";

/**
 * Netlify schedule. The cron is in netlify.toml. This is not a background function.
 * The sync runs in this process. It does not POST to the public site and it
 * does not construct a Claude client. A missing or short GMAIL_SYNC_SECRET
 * does not sync. The scheduler sends no bearer, and a published function
 * with `schedule` set does not accept incoming web requests.
 */
export const handler = async (): Promise<{ statusCode: number; body: string }> =>
  runScheduledJob({
    secret: process.env.GMAIL_SYNC_SECRET ?? null,
    run: async () => {
      const summary = await runProductionInboxSync();
      return { accounts: summary.accounts, results: summary.results };
    },
  });
