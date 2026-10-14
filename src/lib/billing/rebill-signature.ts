import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Rebill signs the raw body with HMAC-SHA256 and sends the hex digest in
 * `x-rebill-signature`. There is no timestamp in the header. Callers dedupe
 * `webhook.logId` because a captured body stays valid.
 *
 * https://docs.rebill.com/guides/webhooks
 */
export function rebillSignatureValid(
  rawBody: Uint8Array | string,
  header: string | null,
  secret: string | undefined,
): boolean {
  if (!secret || !header) return false;
  if (!/^[0-9a-fA-F]+$/.test(header) || header.length % 2 !== 0) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(header, "hex");
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
