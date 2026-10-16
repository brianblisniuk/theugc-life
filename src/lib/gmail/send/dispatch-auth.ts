/**
 * Dispatch authorization. No secrets are imported here. The secret is an
 * argument so a test can pass one without reading the environment.
 *
 * The schedule runs the dispatcher in-process. It does not POST to the
 * public site. The HTTP route and the schedule both require the bearer.
 * The compare hashes both sides before `timingSafeEqual`.
 */

import { bearerMatches, runScheduledJob } from "@/lib/jobs/scheduled-post";

export function authorizeDispatch(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 16) return false;
  return bearerMatches(header, secret);
}

export async function handleDispatchPost(
  authorization: string | null,
  secret: string | undefined,
  run: () => Promise<object>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!authorizeDispatch(authorization, secret)) {
    return { status: 401, body: { result: "forbidden" } };
  }
  const summary = await run();
  return { status: 200, body: { result: "ok", ...(summary as Record<string, unknown>) } };
}

export async function runScheduledDispatch(options: {
  secret: string | null;
  authorization?: string | null;
  run: () => Promise<object>;
}): Promise<{ statusCode: number; body: string }> {
  return runScheduledJob(options);
}
