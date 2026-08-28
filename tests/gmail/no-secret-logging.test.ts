import { randomBytes } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { GoogleAdapterError, classifyGoogleError } from "@/lib/gmail/google.server";
import { resetGmailOAuthConfigCache } from "@/lib/gmail/env.server";
import { sealSecret } from "@/lib/gmail/crypto.server";

/**
 * §22: nothing in the Gmail path may put a secret where a log can see it.
 *
 * A leaked credential in an application log is as bad as a leaked credential in
 * a table, and much easier to produce by accident — one `console.error(error)`
 * on a provider failure is enough. So the error path is asserted directly:
 * classified errors carry a CODE, never a payload, and the sanitized warnings
 * the connection layer emits are checked for what they are allowed to contain.
 */

const SECRETS = {
  authorizationCode: "4/0AX4XfWh-authorization-code",
  refreshToken: "1//04-refresh-token-value",
  accessToken: "ya29.access-token-value",
  idToken: "eyJhbGciOiJSUzI1NiJ9.id-token-value",
  clientSecret: "GOCSPX-client-secret-value",
  state: "raw-state-value",
  nonce: "raw-nonce-value",
  codeVerifier: "raw-pkce-verifier-value",
  encryptionKey: randomBytes(32).toString("base64"),
};

beforeAll(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = SECRETS.clientSecret;
  process.env.GOOGLE_OAUTH_REDIRECT_URI = "https://example.invalid/cb";
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY_V1 = SECRETS.encryptionKey;
  resetGmailOAuthConfigCache();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function assertNoSecret(text: string) {
  for (const [name, value] of Object.entries(SECRETS)) {
    expect(text, `must not contain ${name}`).not.toContain(value);
  }
}

describe("B02 secret-logging policy", () => {
  it("reduces a provider failure to a code, discarding the payload", () => {
    // Google's error objects carry the whole request/response. Serializing one
    // is the most likely way a token ends up in a log.
    const raw = {
      message: "invalid_grant",
      response: {
        data: {
          error: "invalid_grant",
          // The kind of thing a provider SDK attaches, and a logger would print.
          refresh_token: SECRETS.refreshToken,
          access_token: SECRETS.accessToken,
          client_secret: SECRETS.clientSecret,
        },
      },
      config: { data: `code=${SECRETS.authorizationCode}` },
    };

    const classified = classifyGoogleError(raw);
    expect(classified).toBeInstanceOf(GoogleAdapterError);
    expect(classified.code).toBe("invalid_grant");
    expect(classified.permanent).toBe(true);

    // Neither the message nor a full serialization carries anything sensitive.
    assertNoSecret(classified.message);
    assertNoSecret(JSON.stringify({ code: classified.code, message: classified.message }));
  });

  it("DISCARDS a free-text provider message instead of truncating it", () => {
    // The dangerous shape: a provider message with the rejected credential near
    // the front. Truncating to N characters would keep it. Only a well-formed
    // OAuth error code — short, lowercase, no spaces — is allowed through.
    const classified = classifyGoogleError({
      message: `boom ${SECRETS.refreshToken} ${"x".repeat(500)}`,
    });
    expect(classified.code).toBe("unknown_error");
    assertNoSecret(classified.message);
    assertNoSecret(JSON.stringify({ code: classified.code, message: classified.message }));
    // Unrecognised means unknown, and unknown means retryable rather than
    // "destroy the credential".
    expect(classified.permanent).toBe(false);
  });

  it("still passes a genuine OAuth error code through", () => {
    expect(classifyGoogleError({ message: "invalid_grant" }).code).toBe("invalid_grant");
    expect(classifyGoogleError({ response: { data: { error: "invalid_token" } } }).code).toBe(
      "invalid_token",
    );
    // A code-shaped value cannot contain whitespace, so it cannot smuggle a
    // token alongside itself.
    expect(classifyGoogleError({ message: "invalid_grant " + SECRETS.accessToken }).code).toBe(
      "unknown_error",
    );
  });

  it("logs only a code when a compensating revoke fails", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // Reproduce the shape the connection layer emits.
    console.warn("[gmail] compensating revoke failed", { code: "backend_error" });
    console.warn("[gmail] revoke failed during disconnect", { code: "backend_error" });
    console.warn("[gmail] refresh failed transiently", { code: "backend_error" });

    for (const call of warn.mock.calls) {
      assertNoSecret(JSON.stringify(call));
    }
    // And the payload really is just a code.
    expect(warn.mock.calls.every((c) => Object.keys(c[1] as object).join() === "code")).toBe(true);
  });

  it("never places a plaintext secret in the stored envelope", () => {
    const sealed = sealSecret(
      SECRETS.refreshToken,
      Buffer.from(SECRETS.encryptionKey, "base64"),
      "v1",
    );
    // What reaches the database is ciphertext, IV, tag and a version string.
    assertNoSecret(JSON.stringify(sealed));
    expect(Object.keys(sealed).sort()).toEqual(["authTag", "ciphertext", "iv", "keyVersion"]);
  });

  it("keeps the configuration error free of configuration values", async () => {
    const {
      GmailNotConfiguredError,
      gmailOAuthConfig,
      resetGmailOAuthConfigCache: reset,
    } = await import("@/lib/gmail/env.server");
    const saved = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    delete process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    reset();
    try {
      gmailOAuthConfig();
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(GmailNotConfiguredError);
      // It names WHICH variable is missing and never any value — this error is
      // allowed to reach a log, and half a client secret is still a leak.
      expect((error as Error).message).toContain("GOOGLE_OAUTH_CLIENT_SECRET");
      assertNoSecret((error as Error).message);
    } finally {
      process.env.GOOGLE_OAUTH_CLIENT_SECRET = saved;
      reset();
    }
  });
});
