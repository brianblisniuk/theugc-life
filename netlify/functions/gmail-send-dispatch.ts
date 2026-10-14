import { runScheduledDispatch } from "../../src/lib/gmail/send/dispatch-auth";

/**
 * Netlify schedule. This file does not import the Gmail or Claude clients.
 * It asks the app route to dispatch, and that route is what the tests mock.
 */
export const handler = async (): Promise<{ statusCode: number; body: string }> =>
  runScheduledDispatch({
    fetchImpl: fetch,
    siteUrl: process.env.URL ?? process.env.NEXT_PUBLIC_SITE_URL ?? null,
    secret: process.env.GMAIL_DISPATCH_SECRET ?? null,
  });

export const config = {
  schedule: "* * * * *",
};
