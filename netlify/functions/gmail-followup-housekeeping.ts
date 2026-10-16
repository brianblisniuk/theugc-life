import { runFollowupHousekeeping } from "../../src/lib/jobs/maintenance";
import { runScheduledJob } from "../../src/lib/jobs/scheduled-post";
import { createAdminClient } from "../../src/lib/supabase/admin";

/**
 * Netlify schedule. The cron and the background flag are in netlify.toml.
 * Housekeeping runs in this process. It does not call Gmail. A missing or
 * short GMAIL_FOLLOWUP_SECRET does not stop or enqueue follow-ups.
 */
export const handler = async (_event?: unknown): Promise<{ statusCode: number; body: string }> =>
  runScheduledJob({
    secret: process.env.GMAIL_FOLLOWUP_SECRET ?? null,
    run: () => runFollowupHousekeeping(createAdminClient(), new Date()),
  });
