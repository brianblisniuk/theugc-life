import "server-only";

import { handleDispatchPost } from "@/lib/gmail/send/dispatch-auth";
import { runProductionInboxSync } from "@/lib/gmail/sync/scheduled.server";

export const dynamic = "force-dynamic";

/**
 * B08 inbox sync. The bearer secret is required. Tests mock Gmail at the
 * worker boundary. This route does not construct a Claude client.
 */
export async function POST(request: Request): Promise<Response> {
  const result = await handleDispatchPost(
    request.headers.get("authorization"),
    process.env.GMAIL_SYNC_SECRET,
    async () => {
      const summary = await runProductionInboxSync();
      return { accounts: summary.accounts, results: summary.results };
    },
  );
  return Response.json(result.body, { status: result.status });
}
