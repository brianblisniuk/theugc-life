/**
 * Hotelbeds / HBX request signing.
 *
 * Official contract (developer.hotelbeds.com, externally verified 2026-08-15):
 * every request carries
 *
 *   Api-key:     <API key>
 *   X-Signature: SHA256(apiKey + secret + unixTimestampSeconds), lowercase hex
 *
 * The secret never leaves this module's arguments — it is not stored on the
 * descriptor, not returned, and not logged. `buildAuthHeaders` is pure and takes
 * an explicit timestamp so it can be tested deterministically without a clock.
 */
import { createHash } from "node:crypto";

export interface HotelbedsCredentials {
  apiKey: string;
  secret: string;
}

/** Lowercase hex SHA256 of apiKey + secret + unix seconds. */
export function signRequest(apiKey: string, secret: string, unixTimestampSeconds: number): string {
  return createHash("sha256")
    .update(`${apiKey}${secret}${Math.floor(unixTimestampSeconds)}`)
    .digest("hex");
}

/**
 * Build the authentication headers for one request.
 *
 * Returns a fresh object each call: the signature is timestamp-bound and reusing
 * a stale one produces an authentication failure that looks like a bad key.
 */
export function buildAuthHeaders(
  credentials: HotelbedsCredentials,
  unixTimestampSeconds: number,
): Record<string, string> {
  return {
    "Api-key": credentials.apiKey,
    "X-Signature": signRequest(credentials.apiKey, credentials.secret, unixTimestampSeconds),
    Accept: "application/json",
  };
}

/** Header names whose values must never appear in logs or artifacts. */
export const SENSITIVE_HEADER_NAMES = ["api-key", "x-signature", "authorization"] as const;

/**
 * Redact a header map for diagnostics.
 *
 * Shape is preserved so a reviewer can see WHICH headers were sent without ever
 * seeing a key or a signature. A signature is as good as a credential for the
 * few seconds it is valid, so it is redacted just as aggressively.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = SENSITIVE_HEADER_NAMES.includes(
      name.toLowerCase() as (typeof SENSITIVE_HEADER_NAMES)[number],
    )
      ? "[REDACTED]"
      : value;
  }
  return out;
}
