import { runAccountErasure } from "../../src/lib/jobs/maintenance";
import { authorizationFromEvent, runScheduledJob } from "../../src/lib/jobs/scheduled-post";
import { createAdminClient } from "../../src/lib/supabase/admin";

/**
 * Netlify schedule. The cron is in netlify.toml. This is not a background function.
 * Erasure runs in this process. A missing or short ACCOUNT_ERASURE_SECRET
 * does not erase. A caller without the bearer does not erase. This file
 * does not import Gmail or Claude.
 */
export const handler = async (event?: {
  headers?: Record<string, string | undefined> | null;
}): Promise<{ statusCode: number; body: string }> =>
  runScheduledJob({
    secret: process.env.ACCOUNT_ERASURE_SECRET ?? null,
    authorization: authorizationFromEvent(event),
    run: () => runAccountErasure(createAdminClient()),
  });
