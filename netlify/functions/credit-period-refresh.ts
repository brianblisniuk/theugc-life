import { runAnnualCreditRefresh } from "../../src/lib/jobs/maintenance";
import { authorizationFromEvent, runScheduledJob } from "../../src/lib/jobs/scheduled-post";
import { createAdminClient } from "../../src/lib/supabase/admin";

/**
 * Netlify schedule. The cron is in netlify.toml. This is not a background function.
 * Credit refresh runs in this process. A missing or short CREDIT_PERIOD_SECRET
 * does not grant. A caller without the bearer does not grant. This file
 * does not import Gmail, Claude, or Rebill.
 */
export const handler = async (event?: {
  headers?: Record<string, string | undefined> | null;
}): Promise<{ statusCode: number; body: string }> =>
  runScheduledJob({
    secret: process.env.CREDIT_PERIOD_SECRET ?? null,
    authorization: authorizationFromEvent(event),
    run: () => runAnnualCreditRefresh(createAdminClient()),
  });
