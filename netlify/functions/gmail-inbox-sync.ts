import { runProductionInboxSync } from "../../src/lib/gmail/sync/scheduled.server";
import { runScheduledJob } from "../../src/lib/jobs/scheduled-post";

/**
 * Netlify schedule. The cron and the background flag are in netlify.toml.
 * The sync runs in this process. It does not POST to the public site and it
 * does not construct a Claude client. A missing or short GMAIL_SYNC_SECRET
 * does not sync. A caller-supplied Authorization header is ignored.
 */
export const handler = async (_event?: unknown): Promise<{ statusCode: number; body: string }> =>
  runScheduledJob({
    secret: process.env.GMAIL_SYNC_SECRET ?? null,
    run: async () => {
      const summary = await runProductionInboxSync();
      return { accounts: summary.accounts, results: summary.results };
    },
  });
