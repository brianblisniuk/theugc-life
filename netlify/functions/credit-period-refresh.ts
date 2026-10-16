import { runAnnualCreditRefresh } from "../../src/lib/jobs/maintenance";
import { runScheduledJob } from "../../src/lib/jobs/scheduled-post";
import { createAdminClient } from "../../src/lib/supabase/admin";

/**
 * Netlify schedule. The cron is in netlify.toml. This is not a background function.
 * Credit refresh runs in this process. A missing or short CREDIT_PERIOD_SECRET
 * does not grant. The scheduler sends no bearer, and a published function
 * with `schedule` set does not accept incoming web requests. This file
 * does not import Gmail, Claude, or Rebill.
 */
export const handler = async (): Promise<{ statusCode: number; body: string }> =>
  runScheduledJob({
    secret: process.env.CREDIT_PERIOD_SECRET ?? null,
    run: () => runAnnualCreditRefresh(createAdminClient()),
  });
