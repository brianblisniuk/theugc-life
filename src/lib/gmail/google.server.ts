import "server-only";

import { OAuth2Client } from "google-auth-library";

import { gmailOAuthConfig } from "@/lib/gmail/env.server";
import { parseGrantedScopes } from "@/lib/gmail/contract";

/**
 * THE ONE PLACE THAT TALKS TO GOOGLE.
 *
 * Everything network-facing is behind this interface so the rest of B02 can be
 * tested exhaustively without a Google account, and so CI never depends on a
 * third party being up. That is not only convenience: the interesting cases here
 * are the failures — a missing refresh token, a forged ID token, a revoked
 * grant — and none of them can be produced on demand against the real service.
 *
 * The adapter is also where token material stops. It returns tokens to the
 * orchestration layer in memory; nothing below it ever logs or persists one.
 */

export interface GoogleTokenSet {
  accessToken: string;
  /** Absent on re-authorization without a consent prompt. B02 treats that as a failure. */
  refreshToken: string | null;
  /** The ACTUAL granted scopes, canonicalized. Never the requested set. */
  grantedScopes: string[];
  idToken: string | null;
  expiryDate: number | null;
  refreshTokenExpiresAt: Date | null;
}

export interface GoogleIdentity {
  /** The durable Google account identity. B01's `provider_account_subject`. */
  subject: string;
  email: string | null;
  emailVerified: boolean;
  nonce: string | null;
}

export interface GmailProfile {
  emailAddress: string;
}

/** A sanitized provider failure. Carries a code, never a credential. */
export class GoogleAdapterError extends Error {
  readonly code: string;
  /** Transient failures may be retried; permanent ones mean the grant is gone. */
  readonly permanent: boolean;

  constructor(code: string, permanent: boolean, message?: string) {
    super(message ?? `google_error: ${code}`);
    this.name = "GoogleAdapterError";
    this.code = code;
    this.permanent = permanent;
  }
}

export interface GoogleOAuthAdapter {
  buildAuthorizationUrl(input: {
    scopes: readonly string[];
    state: string;
    nonce: string;
    codeChallenge: string;
    loginHint?: string | null;
  }): string;

  exchangeCode(input: { code: string; codeVerifier: string }): Promise<GoogleTokenSet>;

  verifyIdToken(input: { idToken: string }): Promise<GoogleIdentity>;

  /** The single Gmail call B02 makes: does this grant reach a real mailbox? */
  getProfile(input: { accessToken: string }): Promise<GmailProfile>;

  refreshAccessToken(input: { refreshToken: string }): Promise<GoogleTokenSet>;

  /** Best effort. Used both on disconnect and to compensate a failed connect. */
  revoke(input: { token: string }): Promise<void>;
}

/**
 * Google's error vocabulary, reduced to the only distinction that changes what
 * we do: is this grant permanently gone, or was this a bad moment?
 *
 * Getting it wrong in the permanent direction destroys a working credential over
 * a blip. Getting it wrong in the transient direction leaves an account claiming
 * to be connected while every sync fails. So the permanent list is explicit and
 * short, and anything unrecognised is treated as transient.
 */
const PERMANENT_GRANT_ERRORS = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "invalid_request",
]);

/**
 * OAuth error codes are a closed vocabulary of short identifiers. Anything that
 * does not look like one is not a code — it is free text, and free text from a
 * provider can contain anything, including the credential that was rejected.
 */
const OAUTH_ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export function classifyGoogleError(error: unknown): GoogleAdapterError {
  const raw = error as { response?: { data?: { error?: unknown } }; message?: unknown } | null;
  const reported = raw?.response?.data?.error ?? raw?.message;

  // ONLY a well-formed code survives. Truncating a free-text message instead —
  // as an earlier version of this did — keeps whatever happens to sit in the
  // first hundred characters, and a provider that echoes the rejected token
  // early in its message would put it straight into our logs.
  const code =
    typeof reported === "string" && OAUTH_ERROR_CODE.test(reported) ? reported : "unknown_error";

  // `invalid_token` on revocation means the token is already unusable, which is
  // the outcome revocation was trying to produce. §20 treats it as success.
  if (code === "invalid_token") return new GoogleAdapterError("invalid_token", true);
  return new GoogleAdapterError(code, PERMANENT_GRANT_ERRORS.has(code));
}

function client(): OAuth2Client {
  const cfg = gmailOAuthConfig();
  return new OAuth2Client({
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    redirectUri: cfg.redirectUri,
  });
}

/** The real adapter. Swapped for a deterministic fake in every test. */
export const googleOAuthAdapter: GoogleOAuthAdapter = {
  buildAuthorizationUrl({ scopes, state, nonce, codeChallenge, loginHint }) {
    return client().generateAuthUrl({
      // B03/B08 sync while the human is asleep, so a usable connection needs a
      // refresh token, so the request must be offline. An access token alone is
      // not a connected state.
      access_type: "offline",
      scope: [...scopes],
      state,
      // Forcing the consent screen is what makes Google return a refresh token
      // on a REPEAT authorization. Without it a reconnect can succeed at Google
      // and leave us with nothing storable — the flow would appear to work and
      // produce a connection that cannot sync.
      prompt: "consent",
      include_granted_scopes: true,
      code_challenge_method: "S256" as never,
      code_challenge: codeChallenge,
      nonce,
      ...(loginHint ? { login_hint: loginHint } : {}),
    });
  },

  async exchangeCode({ code, codeVerifier }) {
    try {
      const { tokens } = await client().getToken({ code, codeVerifier });
      return {
        accessToken: tokens.access_token ?? "",
        refreshToken: tokens.refresh_token ?? null,
        grantedScopes: parseGrantedScopes(tokens.scope),
        idToken: tokens.id_token ?? null,
        expiryDate: tokens.expiry_date ?? null,
        refreshTokenExpiresAt: null,
      };
    } catch (error) {
      throw classifyGoogleError(error);
    }
  },

  async verifyIdToken({ idToken }) {
    const cfg = gmailOAuthConfig();
    try {
      // Full verification: signature against Google's published keys, issuer,
      // audience and expiry. A decoded-but-unverified JWT is attacker-controlled
      // JSON, and this is the step that decides which Google account we are
      // about to bind a mailbox to.
      const ticket = await client().verifyIdToken({ idToken, audience: cfg.clientId });
      const payload = ticket.getPayload();
      if (!payload?.sub) throw new GoogleAdapterError("id_token_missing_subject", true);
      return {
        subject: payload.sub,
        email: payload.email ?? null,
        emailVerified: payload.email_verified === true,
        nonce: payload.nonce ?? null,
      };
    } catch (error) {
      if (error instanceof GoogleAdapterError) throw error;
      throw new GoogleAdapterError("id_token_invalid", true);
    }
  },

  async getProfile({ accessToken }) {
    // Deliberately a raw fetch of ONE endpoint rather than the Gmail SDK: the
    // narrower the surface, the harder it is for a later edit to drift into
    // listing messages. B02 reads no mail.
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      throw new GoogleAdapterError(`gmail_profile_${response.status}`, response.status === 403);
    }
    const body = (await response.json()) as { emailAddress?: unknown };
    if (typeof body.emailAddress !== "string") {
      throw new GoogleAdapterError("gmail_profile_unusable", true);
    }
    // messagesTotal, threadsTotal and historyId are present in the response and
    // deliberately dropped. They are sync state, and B02 does not sync.
    return { emailAddress: body.emailAddress };
  },

  async refreshAccessToken({ refreshToken }) {
    try {
      const c = client();
      c.setCredentials({ refresh_token: refreshToken });
      const { credentials } = await c.refreshAccessToken();
      return {
        accessToken: credentials.access_token ?? "",
        // Google sometimes rotates the refresh token. When it does, the
        // replacement must be stored or the next refresh fails.
        refreshToken: credentials.refresh_token ?? null,
        grantedScopes: parseGrantedScopes(credentials.scope),
        idToken: credentials.id_token ?? null,
        expiryDate: credentials.expiry_date ?? null,
        refreshTokenExpiresAt: null,
      };
    } catch (error) {
      throw classifyGoogleError(error);
    }
  },

  async revoke({ token }) {
    try {
      await client().revokeToken(token);
    } catch (error) {
      const classified = classifyGoogleError(error);
      // Already unusable is the goal, not a failure.
      if (classified.code === "invalid_token") return;
      throw classified;
    }
  },
};
