import { runFollowupHousekeeping } from "../../src/lib/jobs/maintenance";
import { authorizationFromEvent, runScheduledJob } from "../../src/lib/jobs/scheduled-post";
import { createAdminClient } from "../../src/lib/supabase/admin";

/**
 * Netlify schedule. The cron is in netlify.toml. This is not a background function.
 * Housekeeping runs in this process. It does not call Gmail. A missing or
 * short GMAIL_FOLLOWUP_SECRET does not stop or enqueue follow-ups. A caller
 * without the bearer does not stop or enqueue follow-ups.
 */
export const handler = async (event?: {
  headers?: Record<string, string | undefined> | null;
}): Promise<{ statusCode: number; body: string }> =>
  runScheduledJob({
    secret: process.env.GMAIL_FOLLOWUP_SECRET ?? null,
    authorization: authorizationFromEvent(event),
    run: () => runFollowupHousekeeping(createAdminClient(), new Date()),
  });
