import "server-only";

import { handleDispatchPost } from "@/lib/gmail/send/dispatch-auth";
import { runFollowupHousekeeping } from "@/lib/jobs/maintenance";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Stops follow-ups that must not send and enqueues the ones that are due.
 * Does not call Gmail or Claude.
 */
export async function POST(request: Request): Promise<Response> {
  const result = await handleDispatchPost(
    request.headers.get("authorization"),
    process.env.GMAIL_FOLLOWUP_SECRET,
    () => runFollowupHousekeeping(createAdminClient(), new Date()),
  );
  return Response.json(result.body, { status: result.status });
}
