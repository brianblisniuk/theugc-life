import { runAnnualCreditRefresh } from "../../src/lib/jobs/maintenance";
import { runScheduledJob } from "../../src/lib/jobs/scheduled-post";
import { createAdminClient } from "../../src/lib/supabase/admin";

/**
 * Netlify schedule. The cron and the background flag are in netlify.toml.
 * Credit refresh runs in this process. A missing or short CREDIT_PERIOD_SECRET
 * does not grant. This file does not import Gmail, Claude, or Rebill.
 */
export const handler = async (_event?: unknown): Promise<{ statusCode: number; body: string }> =>
  runScheduledJob({
    secret: process.env.CREDIT_PERIOD_SECRET ?? null,
    run: () => runAnnualCreditRefresh(createAdminClient()),
  });
