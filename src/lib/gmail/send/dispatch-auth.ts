/**
 * Dispatch authorization. No secrets are imported here. The secret is an
 * argument so a test can pass one without reading the environment.
 */

import { GMAIL_SEND_DISPATCH_PATH, runScheduledPost } from "@/lib/jobs/scheduled-post";

export function authorizeDispatch(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 16) return false;
  const expected = `Bearer ${secret}`;
  if (!header || header.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) {
    mismatch |= header.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
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
  fetchImpl: typeof fetch;
  siteUrl: string | null;
  secret: string | null;
}): Promise<{ statusCode: number; body: string }> {
  return runScheduledPost({ ...options, path: GMAIL_SEND_DISPATCH_PATH });
}
