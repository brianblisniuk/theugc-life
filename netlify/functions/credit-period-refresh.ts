import { CREDIT_PERIOD_PATH, runScheduledPost } from "../../src/lib/jobs/scheduled-post";

/**
 * Netlify schedule. The cron is declared once, in netlify.toml.
 * This file does not import the Gmail or Claude clients.
 */
export const handler = async (): Promise<{ statusCode: number; body: string }> =>
  runScheduledPost({
    fetchImpl: fetch,
    siteUrl: process.env.URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? null,
    secret: process.env.CREDIT_PERIOD_SECRET ?? null,
    path: CREDIT_PERIOD_PATH,
  });
