import "server-only";

import { dispatchDueGmailSends } from "@/lib/gmail/send/dispatch";
import { handleDispatchPost } from "@/lib/gmail/send/dispatch-auth";
import { productionSendDeps } from "@/lib/gmail/send/dispatch.server";

export const dynamic = "force-dynamic";

/**
 * Scheduled send dispatcher (D168). The bearer secret is required. Claude
 * is not called. Gmail is called only for a claimed row, and the test
 * adapter throws before any network call.
 */
export async function POST(request: Request): Promise<Response> {
  const result = await handleDispatchPost(
    request.headers.get("authorization"),
    process.env.GMAIL_DISPATCH_SECRET,
    () => dispatchDueGmailSends(productionSendDeps(), { now: new Date() }),
  );
  return Response.json(result.body, { status: result.status });
}
