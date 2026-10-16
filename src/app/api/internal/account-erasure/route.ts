import "server-only";

import { handleDispatchPost } from "@/lib/gmail/send/dispatch-auth";
import { runAccountErasure } from "@/lib/jobs/maintenance";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/**
 * D151 daily erasure. Returns a result code and a count. No email, no token.
 * The Netlify schedule runs the same job in-process and does not call this route.
 */
export async function POST(request: Request): Promise<Response> {
  const result = await handleDispatchPost(
    request.headers.get("authorization"),
    process.env.ACCOUNT_ERASURE_SECRET,
    () => runAccountErasure(createAdminClient()),
  );
  return Response.json(result.body, { status: result.status });
}
