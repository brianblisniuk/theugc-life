/**
 * Dispatch authorization. No secrets are imported here. The secret is an
 * argument so a test can pass one without reading the environment.
 *
 * The schedule runs the dispatcher in-process. It does not POST to the
 * public site. The HTTP route still requires the bearer.
 */

import { jobFailure, runScheduledJob } from "@/lib/jobs/scheduled-post";

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
  try {
    const summary = await run();
    return { status: 200, body: { result: "ok", ...(summary as Record<string, unknown>) } };
  } catch (error) {
    const failure = jobFailure(error);
    console.error("[job] dispatch failed", failure.name, failure.code);
    return { status: 500, body: { result: "error", code: failure.code } };
  }
}

export async function runScheduledDispatch(options: {
  secret: string | null;
  run: () => Promise<object>;
}): Promise<{ statusCode: number; body: string }> {
  return runScheduledJob(options);
}
