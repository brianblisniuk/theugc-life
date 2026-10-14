/**
 * Client-safe Rebill public key. This module must not read the secret key or
 * the webhook signing secret. The hosted checkout does not need the key in
 * the browser; a server component may pass a boolean instead of the value.
 */
export function rebillPublicKey(): string | undefined {
  const value = process.env.REBILL_PUBLIC_KEY?.trim();
  return value ? value : undefined;
}
