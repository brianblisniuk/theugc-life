import { runFollowupHousekeeping } from "../../src/lib/jobs/maintenance";
import { runScheduledJob } from "../../src/lib/jobs/scheduled-post";
import { createAdminClient } from "../../src/lib/supabase/admin";

/**
 * Netlify schedule. The cron is in netlify.toml. This is not a background function.
 * Housekeeping runs in this process. It does not call Gmail. A missing or
 * short GMAIL_FOLLOWUP_SECRET does not stop or enqueue follow-ups. The
 * scheduler sends no bearer, and a published function with `schedule` set
 * does not accept incoming web requests.
 */
export const handler = async (): Promise<{ statusCode: number; body: string }> =>
  runScheduledJob({
    secret: process.env.GMAIL_FOLLOWUP_SECRET ?? null,
    run: () => runFollowupHousekeeping(createAdminClient(), new Date()),
  });
