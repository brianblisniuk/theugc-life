import "server-only";

import { handleDispatchPost } from "@/lib/gmail/send/dispatch-auth";
import { runAnnualCreditRefresh } from "@/lib/jobs/maintenance";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * Annual plan credit windows (D135). Idempotent. Does not call Rebill.
 * The Netlify schedule runs the same job in-process and does not call this route.
 */
export async function POST(request: Request): Promise<Response> {
  const result = await handleDispatchPost(
    request.headers.get("authorization"),
    process.env.CREDIT_PERIOD_SECRET,
    () => runAnnualCreditRefresh(createAdminClient()),
  );
  return Response.json(result.body, { status: result.status });
}
