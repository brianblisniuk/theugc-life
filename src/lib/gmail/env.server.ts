import "server-only";

import { z } from "zod";

import { decodeKey } from "@/lib/gmail/crypto.server";

/**
 * SERVER-only Gmail OAuth configuration.
 *
 * Deliberately NOT part of `serverEnv()`. Those variables are required for the
 * application to run at all; these are required only to connect a mailbox, and
 * folding them in would mean the whole app — build, tests, every unrelated page —
 * refuses to start on a deployment that has not set up Google yet.
 *
 * So the split is: absent configuration is fine everywhere except the Gmail
 * endpoints, and those FAIL CLOSED with a controlled error rather than
 * half-working. There is no development fallback, no default client id and no
 * "skip verification in dev" branch: a connection either meets the contract or
 * does not happen.
 *
 * None of these may ever become `NEXT_PUBLIC_*`. The client secret and the
 * encryption key would be in the browser bundle, and the redirect URI has to be
 * fixed server-side precisely so a caller cannot choose it.
 */

const gmailOAuthSchema = z.object({
  GOOGLE_OAUTH_CLIENT_ID: z.string().min(1),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().min(1),
  // Exact and absolute. Google matches it character for character against the
  // registered value, and keeping it out of the request path is what stops a
  // caller aiming the authorization code somewhere else.
  GOOGLE_OAUTH_REDIRECT_URI: z.string().url(),
  GMAIL_TOKEN_ENCRYPTION_KEY_V1: z.string().min(1),
});

export interface GmailOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  encryptionKey: Buffer;
  encryptionKeyVersion: string;
}

/** Thrown when Gmail is not configured. Carries no value from the environment. */
export class GmailNotConfiguredError extends Error {
  constructor(detail: string) {
    super(`gmail_oauth_not_configured: ${detail}`);
    this.name = "GmailNotConfiguredError";
  }
}

export const GMAIL_ENCRYPTION_KEY_VERSION = "v1";

let cached: GmailOAuthConfig | undefined;

/**
 * Resolve and validate the Gmail OAuth configuration, or throw.
 *
 * The failure message names which variables are missing and never their values —
 * this error is allowed to reach a log, and half a client secret in a log is
 * still a leak.
 */
export function gmailOAuthConfig(): GmailOAuthConfig {
  if (cached) return cached;

  const parsed = gmailOAuthSchema.safeParse({
    GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
    GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    GOOGLE_OAUTH_REDIRECT_URI: process.env.GOOGLE_OAUTH_REDIRECT_URI,
    GMAIL_TOKEN_ENCRYPTION_KEY_V1: process.env.GMAIL_TOKEN_ENCRYPTION_KEY_V1,
  });

  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".") || "(root)").join(", ");
    throw new GmailNotConfiguredError(`missing or invalid: ${missing}`);
  }

  // Validated here rather than at first use: a 31-byte key should stop a
  // deployment at its first Gmail request, not corrupt one credential later.
  const encryptionKey = decodeKey(parsed.data.GMAIL_TOKEN_ENCRYPTION_KEY_V1);

  cached = {
    clientId: parsed.data.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: parsed.data.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: parsed.data.GOOGLE_OAUTH_REDIRECT_URI,
    encryptionKey,
    encryptionKeyVersion: GMAIL_ENCRYPTION_KEY_VERSION,
  };
  return cached;
}

/** Whether a Gmail connection is offerable at all — used to render the UI honestly. */
export function isGmailOAuthConfigured(): boolean {
  try {
    gmailOAuthConfig();
    return true;
  } catch {
    return false;
  }
}

/** Test-only: drop the memoized config after mutating `process.env`. */
export function resetGmailOAuthConfigCache(): void {
  cached = undefined;
}
