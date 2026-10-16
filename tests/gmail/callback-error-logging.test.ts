import { randomBytes } from "node:crypto";

import { GaxiosError, type GaxiosOptionsPrepared, type GaxiosResponse } from "gaxios";
import { OAuth2Client } from "google-auth-library";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { completeGmailAuthorization, type GmailDeps } from "@/lib/gmail/connection.server";
import { sealSecret, type SealedSecret } from "@/lib/gmail/crypto.server";
import { resetGmailOAuthConfigCache } from "@/lib/gmail/env.server";
import {
  GoogleAdapterError,
  googleOAuthAdapter,
  type GoogleOAuthAdapter,
} from "@/lib/gmail/google.server";

/**
 * A failed callback still answers `invalid_state`. These tests pin the only
 * thing that changed: the server log says which step failed, and the log is
 * a fixed phrase or an OAuth error code — never a credential.
 *
 * Exchange cases drive the real adapter. `getToken` rejects with the Gaxios
 * error the token endpoint actually produces: `response.data.error` is
 * Google's OAuth code, `error.code` is the HTTP status, and the request body
 * still holds the authorization code, verifier and client secret.
 */

const USER_ID = "00000000-0000-4000-8000-000000000001";

const CANARY = {
  authorizationCode: "4/0A-CANARY-AUTH-CODE-do-not-log",
  refreshToken: "1//CANARY-REFRESH-TOKEN-do-not-log",
  accessToken: "ya29.CANARY-ACCESS-TOKEN-do-not-log",
  idToken: "eyJCANARY-ID-TOKEN-do-not-log",
  clientSecret: "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log",
  state: "CANARY-RAW-STATE-do-not-log",
  nonce: "CANARY-RAW-NONCE-do-not-log",
  codeVerifier: "CANARY-PKCE-VERIFIER-do-not-log",
  encryptionKey: randomBytes(32).toString("base64"),
};

const OAUTH_ERROR_CODES = ["invalid_grant", "redirect_uri_mismatch", "invalid_client"] as const;

beforeAll(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = CANARY.clientSecret;
  process.env.GOOGLE_OAUTH_REDIRECT_URI =
    "https://example.invalid/api/integrations/gmail/oauth/callback";
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY_V1 = CANARY.encryptionKey;
  resetGmailOAuthConfigCache();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function assertNoCanary(text: string) {
  for (const [name, value] of Object.entries(CANARY)) {
    expect(text, `must not contain ${name}`).not.toContain(value);
  }
}

function encryptionKey(): Buffer {
  return Buffer.from(CANARY.encryptionKey, "base64");
}

function sealedVerifier(): SealedSecret {
  return sealSecret(CANARY.codeVerifier, encryptionKey(), "v1");
}

function consumedTransaction(sealed: SealedSecret) {
  return {
    result: "ok",
    nonce_digest: "not-checked-on-this-path",
    code_verifier_ciphertext: sealed.ciphertext,
    code_verifier_iv: sealed.iv,
    code_verifier_auth_tag: sealed.authTag,
    encryption_key_version: sealed.keyVersion,
    purpose: "connect",
    oauth_intent_seq: 1,
    return_path: "/app/account",
  };
}

function deps(google: GoogleOAuthAdapter, transaction: Record<string, unknown>): GmailDeps {
  return {
    google,
    db: {
      rpc: vi.fn(async (name: string) => {
        expect(name).toBe("gmail_oauth_consume_transaction");
        return { data: transaction, error: null };
      }),
    } as unknown as GmailDeps["db"],
  };
}

function adapter(exchangeCode: GoogleOAuthAdapter["exchangeCode"]): GoogleOAuthAdapter {
  return {
    buildAuthorizationUrl: () => "https://example.invalid/auth",
    exchangeCode,
    verifyIdToken: vi.fn(),
    getProfile: vi.fn(),
    refreshAccessToken: vi.fn(),
    revoke: vi.fn(),
    sendMessage: vi.fn(),
  };
}

function spyWarn() {
  return vi.spyOn(console, "warn").mockImplementation(() => undefined);
}

/**
 * The error `google-auth-library` throws when the token endpoint answers 400.
 * The OAuth code lives on `response.data.error`. `error.code` is the HTTP
 * status, and the request body still contains the secrets that must not be logged.
 */
async function tokenEndpointError(oauthCode: string, description: string): Promise<GaxiosError> {
  const data = {
    error: oauthCode,
    error_description: description,
  };
  const requestData = [
    `code=${CANARY.authorizationCode}`,
    `code_verifier=${CANARY.codeVerifier}`,
    `client_secret=${CANARY.clientSecret}`,
    "grant_type=authorization_code",
  ].join("&");
  const response = new Response(JSON.stringify(data), {
    status: 400,
    statusText: "Bad Request",
    headers: { "content-type": "application/json" },
  });
  // Consuming the body sets `bodyUsed`, which is what makes Gaxios keep
  // `response.data` instead of clearing it.
  await response.json();
  const config: GaxiosOptionsPrepared = {
    headers: new Headers({ "content-type": "application/x-www-form-urlencoded" }),
    url: new URL("https://oauth2.googleapis.com/token"),
    data: requestData,
  };
  const gaxiosResponse = Object.assign(response, { data, config }) as GaxiosResponse;
  return new GaxiosError(oauthCode, config, gaxiosResponse, {
    message: oauthCode,
    code: 400,
    status: "Bad Request",
  });
}

async function rejectTokenExchange(oauthCode: string, description: string) {
  vi.spyOn(OAuth2Client.prototype, "getToken").mockRejectedValue(
    await tokenEndpointError(oauthCode, description),
  );
}

describe("Gmail callback failure logging", () => {
  it("warns when the PKCE verifier cannot be decrypted, and logs nothing else", async () => {
    const warn = spyWarn();
    const sealed = sealedVerifier();
    const exchangeCode = vi.fn();
    const outcome = await completeGmailAuthorization(
      { userId: USER_ID, state: CANARY.state, code: CANARY.authorizationCode, error: null },
      deps(adapter(exchangeCode), {
        ...consumedTransaction(sealed),
        // A tag that does not authenticate. openSecret fails closed.
        code_verifier_auth_tag: randomBytes(16).toString("base64"),
      }),
    );

    expect(outcome).toEqual({ result: "invalid_state" });
    expect(exchangeCode).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[gmail] callback: verifier decrypt failed");
    assertNoCanary(JSON.stringify(warn.mock.calls));
    // The ciphertext itself is a secret at rest. It does not belong in the log.
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sealed.ciphertext);
  });

  it.each(OAUTH_ERROR_CODES)(
    "logs only %s when the real token endpoint rejects the code",
    async (oauthCode) => {
      const warn = spyWarn();
      const description = [
        `code=${CANARY.authorizationCode}`,
        `verifier=${CANARY.codeVerifier}`,
        `refresh_token=${CANARY.refreshToken}`,
        `access_token=${CANARY.accessToken}`,
      ].join(" ");
      await rejectTokenExchange(oauthCode, description);

      const outcome = await completeGmailAuthorization(
        { userId: USER_ID, state: CANARY.state, code: CANARY.authorizationCode, error: null },
        deps(googleOAuthAdapter, consumedTransaction(sealedVerifier())),
      );

      expect(outcome).toEqual({ result: "invalid_state" });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("[gmail] callback: code exchange failed", {
        code: oauthCode,
      });
      const logged = JSON.stringify(warn.mock.calls);
      assertNoCanary(logged);
      // The second argument is the code and nothing else — not the description,
      // the request body, or the Gaxios error that still holds both.
      expect(warn.mock.calls[0]?.[1]).toEqual({ code: oauthCode });
      expect(Object.keys(warn.mock.calls[0]?.[1] as object)).toEqual(["code"]);
    },
  );

  it("logs unknown when the exchange throws something that is not a classified provider error", async () => {
    const warn = spyWarn();
    const leaked = {
      message: CANARY.authorizationCode,
      code: "invalid_grant",
      response: {
        data: {
          error: "invalid_grant",
          error_description: CANARY.refreshToken,
          access_token: CANARY.accessToken,
        },
      },
      config: {
        data: `code=${CANARY.authorizationCode}&code_verifier=${CANARY.codeVerifier}&client_secret=${CANARY.clientSecret}`,
      },
    };
    const google = adapter(async () => {
      throw leaked;
    });
    const outcome = await completeGmailAuthorization(
      { userId: USER_ID, state: CANARY.state, code: CANARY.authorizationCode, error: null },
      deps(google, consumedTransaction(sealedVerifier())),
    );

    expect(outcome).toEqual({ result: "invalid_state" });
    expect(google.verifyIdToken).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[gmail] callback: code exchange failed", {
      code: "unknown",
    });
    assertNoCanary(JSON.stringify(warn.mock.calls));
  });

  it("exposes Google's OAuth error code on GoogleAdapterError and drops the payload", async () => {
    await rejectTokenExchange(
      "redirect_uri_mismatch",
      `rejected ${CANARY.authorizationCode} ${CANARY.codeVerifier}`,
    );

    let caught: unknown;
    try {
      await googleOAuthAdapter.exchangeCode({
        code: CANARY.authorizationCode,
        codeVerifier: CANARY.codeVerifier,
      });
      expect.unreachable("exchange should have failed");
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GoogleAdapterError);
    const classified = caught as GoogleAdapterError;
    expect(classified.code).toBe("redirect_uri_mismatch");
    expect(classified.message).toBe("google_error: redirect_uri_mismatch");
    assertNoCanary(classified.message);
    assertNoCanary(JSON.stringify(classified));
    // A numeric HTTP status is not an OAuth error code and must not replace one.
    expect(classified.code).not.toBe("400");
  });
});
