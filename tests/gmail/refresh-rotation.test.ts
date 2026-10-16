/**
 * The production refresh adapter must return a rotated refresh token from the
 * token-endpoint body. google-auth-library copies the input token back over
 * that field. This test mocks fetch and does not call Google.
 */
import { randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resetGmailOAuthConfigCache } from "@/lib/gmail/env.server";
import { googleOAuthAdapter } from "@/lib/gmail/google.server";

const INPUT = "input-refresh-token-0001";
const ROTATED = "rotated-refresh-token-0002";

const SAVED = {
  GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID,
  GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  GOOGLE_OAUTH_REDIRECT_URI: process.env.GOOGLE_OAUTH_REDIRECT_URI,
  GMAIL_TOKEN_ENCRYPTION_KEY_V1: process.env.GMAIL_TOKEN_ENCRYPTION_KEY_V1,
};

afterEach(() => {
  process.env.GOOGLE_OAUTH_CLIENT_ID = SAVED.GOOGLE_OAUTH_CLIENT_ID;
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = SAVED.GOOGLE_OAUTH_CLIENT_SECRET;
  process.env.GOOGLE_OAUTH_REDIRECT_URI = SAVED.GOOGLE_OAUTH_REDIRECT_URI;
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY_V1 = SAVED.GMAIL_TOKEN_ENCRYPTION_KEY_V1;
  resetGmailOAuthConfigCache();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function configure(): void {
  process.env.GOOGLE_OAUTH_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
  process.env.GOOGLE_OAUTH_CLIENT_SECRET = "test-client-secret";
  process.env.GOOGLE_OAUTH_REDIRECT_URI =
    "https://example.invalid/api/integrations/gmail/oauth/callback";
  process.env.GMAIL_TOKEN_ENCRYPTION_KEY_V1 = randomBytes(32).toString("base64");
  resetGmailOAuthConfigCache();
}

describe("refresh token rotation", () => {
  it("returns the refresh token from the token endpoint, not the input", async () => {
    configure();
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe("https://oauth2.googleapis.com/token");
      const body = String(init?.body ?? "");
      expect(body).toContain("grant_type=refresh_token");
      expect(body).toContain(encodeURIComponent(INPUT));
      return new Response(
        JSON.stringify({
          access_token: "access-1",
          refresh_token: ROTATED,
          expires_in: 3600,
          scope: "https://www.googleapis.com/auth/gmail.readonly",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const refreshed = await googleOAuthAdapter.refreshAccessToken({ refreshToken: INPUT });
    expect(refreshed.accessToken).toBe("access-1");
    expect(refreshed.refreshToken).toBe(ROTATED);
    expect(refreshed.refreshToken).not.toBe(INPUT);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when the token endpoint does not rotate", async () => {
    configure();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ access_token: "access-2", expires_in: 3600 }), {
            status: 200,
          }),
      ),
    );
    const refreshed = await googleOAuthAdapter.refreshAccessToken({ refreshToken: INPUT });
    expect(refreshed.refreshToken).toBeNull();
    expect(refreshed.accessToken).toBe("access-2");
  });

  it("classifies invalid_grant from the token-endpoint body", async () => {
    configure();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })),
    );
    await expect(
      googleOAuthAdapter.refreshAccessToken({ refreshToken: INPUT }),
    ).rejects.toMatchObject({ code: "invalid_grant", permanent: true });
  });
});
