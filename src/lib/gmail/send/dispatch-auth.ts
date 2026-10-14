/**
 * Dispatch authorization. No secrets are imported here. The secret is an
 * argument so a test can pass one without reading the environment.
 */

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
  run: () => Promise<{ sent: number; deferred: number; failed: number; paused: number }>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!authorizeDispatch(authorization, secret)) {
    return { status: 401, body: { result: "forbidden" } };
  }
  const summary = await run();
  return { status: 200, body: { result: "ok", ...summary } };
}

export async function runScheduledDispatch(options: {
  fetchImpl: typeof fetch;
  siteUrl: string | null;
  secret: string | null;
}): Promise<{ statusCode: number; body: string }> {
  if (!options.secret || options.secret.length < 16 || !options.siteUrl) {
    return { statusCode: 500, body: JSON.stringify({ result: "not_configured" }) };
  }
  const response = await options.fetchImpl(
    `${options.siteUrl.replace(/\/$/, "")}/api/internal/gmail-send-dispatch`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${options.secret}` },
    },
  );
  return { statusCode: response.status, body: await response.text() };
}
