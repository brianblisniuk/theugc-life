import { runProductionInboxSync } from "../../src/lib/gmail/sync/scheduled.server";
import { authorizationFromEvent, runScheduledJob } from "../../src/lib/jobs/scheduled-post";

/**
 * Netlify schedule. The cron is in netlify.toml. This is not a background function.
 * The sync runs in this process. It does not POST to the public site and it
 * does not construct a Claude client. A missing or short GMAIL_SYNC_SECRET
 * does not sync. A caller without the bearer does not sync.
 */
export const handler = async (event?: {
  headers?: Record<string, string | undefined> | null;
}): Promise<{ statusCode: number; body: string }> =>
  runScheduledJob({
    secret: process.env.GMAIL_SYNC_SECRET ?? null,
    authorization: authorizationFromEvent(event),
    run: async () => {
      const summary = await runProductionInboxSync();
      return { accounts: summary.accounts, results: summary.results };
    },
  });
