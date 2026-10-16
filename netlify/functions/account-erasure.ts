import { runAccountErasure } from "../../src/lib/jobs/maintenance";
import { runScheduledJob } from "../../src/lib/jobs/scheduled-post";
import { createAdminClient } from "../../src/lib/supabase/admin";

/**
 * Netlify schedule. The cron and the background flag are in netlify.toml.
 * Erasure runs in this process. A missing or short ACCOUNT_ERASURE_SECRET
 * does not erase. This file does not import Gmail or Claude.
 */
export const handler = async (_event?: unknown): Promise<{ statusCode: number; body: string }> =>
  runScheduledJob({
    secret: process.env.ACCOUNT_ERASURE_SECRET ?? null,
    run: () => runAccountErasure(createAdminClient()),
  });
