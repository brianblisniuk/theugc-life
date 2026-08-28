import { createHash, randomBytes } from "node:crypto";

import {
  GoogleAdapterError,
  type GmailProfile,
  type GoogleIdentity,
  type GoogleOAuthAdapter,
  type GoogleTokenSet,
} from "@/lib/gmail/google.server";
import { B02_REQUESTED_SCOPES } from "@/lib/gmail/contract";

/**
 * A deterministic stand-in for Google.
 *
 * Every interesting B02 case is a provider FAILURE — a missing refresh token, a
 * forged ID token, a revoked grant, a mailbox that is not really a mailbox — and
 * none of those can be produced on demand against the real service. So the
 * adapter boundary is where tests take over, and CI never depends on Google
 * being up or on anybody's credentials.
 *
 * The fake records what it was asked, so tests can also assert the negative:
 * that no message-listing endpoint was ever called.
 */
export interface FakeGoogleOptions {
  subject?: string;
  email?: string;
  grantedScopes?: string[];
  refreshToken?: string | null;
  idToken?: string | null;
  /** Overrides the nonce echoed in the ID token, for replay/mix-up tests. */
  nonceOverride?: string | null;
  idTokenError?: string | null;
  profileError?: string | null;
  exchangeError?: string | null;
  refreshError?: GoogleAdapterError | null;
  rotatedRefreshToken?: string | null;
  revokeError?: GoogleAdapterError | null;
}

export interface FakeGoogle extends GoogleOAuthAdapter {
  calls: {
    authorizationUrls: { state: string; nonce: string; codeChallenge: string; scopes: string[] }[];
    exchanges: { code: string; codeVerifier: string }[];
    profiles: number;
    refreshes: number;
    revocations: string[];
    /** Must stay empty: B02 reads no mail. */
    messageListings: number;
  };
  options: FakeGoogleOptions;
}

export function createFakeGoogle(options: FakeGoogleOptions = {}): FakeGoogle {
  // A DISTINCT Google account per fake unless a test names one. Sharing a
  // default subject across tests would make B01's cross-owner refusal fire on
  // unrelated cases — correct behaviour, wrong reason.
  const subject = options.subject ?? `google-sub-${randomBytes(8).toString("hex")}`;
  const calls: FakeGoogle["calls"] = {
    authorizationUrls: [],
    exchanges: [],
    profiles: 0,
    refreshes: 0,
    revocations: [],
    messageListings: 0,
  };

  // The nonce the fake will echo back inside the ID token. Real Google returns
  // the nonce it was given; a mix-up test overrides it.
  let lastNonce = "";

  const fake: FakeGoogle = {
    calls,
    options,

    buildAuthorizationUrl({ scopes, state, nonce, codeChallenge }) {
      lastNonce = nonce;
      calls.authorizationUrls.push({ state, nonce, codeChallenge, scopes: [...scopes] });
      const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", state);
      url.searchParams.set("nonce", nonce);
      url.searchParams.set("code_challenge", codeChallenge);
      url.searchParams.set("code_challenge_method", "S256");
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      return url.toString();
    },

    async exchangeCode({ code, codeVerifier }): Promise<GoogleTokenSet> {
      calls.exchanges.push({ code, codeVerifier });
      if (options.exchangeError) {
        throw new GoogleAdapterError(options.exchangeError, true);
      }
      return {
        accessToken: "fake-access-token",
        refreshToken:
          options.refreshToken === undefined ? "fake-refresh-token" : options.refreshToken,
        grantedScopes: options.grantedScopes ?? [...B02_REQUESTED_SCOPES],
        idToken: options.idToken === undefined ? "fake-id-token" : options.idToken,
        expiryDate: Date.now() + 3_600_000,
        refreshTokenExpiresAt: null,
      };
    },

    async verifyIdToken(): Promise<GoogleIdentity> {
      if (options.idTokenError) {
        throw new GoogleAdapterError(options.idTokenError, true);
      }
      return {
        subject,
        email: options.email ?? "creator@example.invalid",
        emailVerified: true,
        nonce: options.nonceOverride === undefined ? lastNonce : options.nonceOverride,
      };
    },

    async getProfile(): Promise<GmailProfile> {
      calls.profiles += 1;
      if (options.profileError) {
        throw new GoogleAdapterError(options.profileError, true);
      }
      return { emailAddress: options.email ?? "creator@example.invalid" };
    },

    async refreshAccessToken(): Promise<GoogleTokenSet> {
      calls.refreshes += 1;
      if (options.refreshError) throw options.refreshError;
      return {
        accessToken: "fresh-access-token",
        refreshToken: options.rotatedRefreshToken ?? null,
        grantedScopes: options.grantedScopes ?? [...B02_REQUESTED_SCOPES],
        idToken: null,
        expiryDate: Date.now() + 3_600_000,
        refreshTokenExpiresAt: null,
      };
    },

    async revoke({ token }) {
      calls.revocations.push(token);
      if (options.revokeError) throw options.revokeError;
    },
  };

  return fake;
}

export const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
