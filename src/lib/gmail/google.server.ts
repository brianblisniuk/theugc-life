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
  /**
   * Transient failures may be retried; permanent ones mean the GRANT is gone.
   *
   * Never read this to decide whether to delete a credential — use
   * `refreshTokenIsPermanentlyDead` for that. A `GoogleAdapterError` can be
   * constructed by any caller, including the profile check, with whatever
   * permanence it judged; only the refresh path's own taxonomy is allowed to be
   * destructive.
   */
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

  /**
   * Send one RFC822 message through the creator's own mailbox (D04).
   *
   * `raw` is base64url. `threadId` is set only when that thread is already
   * stored for this mailbox. The real adapter refuses before any network call
   * when `NODE_ENV` is `test`.
   */
  sendMessage(input: {
    accessToken: string;
    raw: string;
    threadId?: string | null;
  }): Promise<{ id: string; threadId: string }>;
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
const PERMANENT_GRANT_ERRORS = new Set(["invalid_grant"]);

/**
 * OUR FAULT, NOT THE CREATOR'S.
 *
 * These three are the errors Google documents against the CLIENT and the
 * REQUEST, not against the grant. `invalid_client` means our client id or secret
 * is wrong. `unauthorized_client` means our client is not permitted to make this
 * kind of request. `invalid_request` means the request itself was malformed or
 * missing a parameter. Every one of them is satisfied by a deployment with a
 * mistyped secret or a programming error on our side, and none of them is
 * evidence that a creator's refresh token stopped working.
 *
 * An earlier version treated all three as permanent, which meant a single wrong
 * environment variable would delete every refresh token it touched and demand
 * that each creator reconnect by hand — the exact outcome the permanent/transient
 * distinction exists to prevent, inflicted on people who did nothing.
 *
 * `invalid_grant` is the one Google documents as the token having expired or
 * been revoked, so it is the one — and, until another is documented as proving
 * the same thing, the only one — that is allowed to destroy a credential.
 */
const CLIENT_CONFIGURATION_ERRORS = new Set([
  "invalid_client",
  "unauthorized_client",
  "invalid_request",
]);

/**
 * THE ONLY QUESTION THAT MAY DESTROY A CREDENTIAL: has Google told us that THIS
 * REFRESH TOKEN is finished? Not "did the call fail", not "was it a 4xx".
 */
export function refreshTokenIsPermanentlyDead(code: string): boolean {
  return code === "invalid_grant";
}

/** True when the failure points at our own configuration or request, not the grant. */
export function isClientConfigurationError(code: string): boolean {
  return CLIENT_CONFIGURATION_ERRORS.has(code);
}

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
    // The token endpoint body is read directly. OAuth2Client.refreshAccessToken
    // copies the input refresh token back over a rotated one, so a replacement
    // would never be stored.
    const cfg = gmailOAuthConfig();
    let response: Response;
    try {
      response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: cfg.clientId,
          client_secret: cfg.clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      });
    } catch (error) {
      throw classifyGoogleError(error);
    }
    const body = (await response.json().catch(() => ({}))) as {
      access_token?: unknown;
      refresh_token?: unknown;
      scope?: unknown;
      id_token?: unknown;
      expires_in?: unknown;
      error?: unknown;
    };
    if (!response.ok || typeof body.error === "string") {
      const reported = typeof body.error === "string" ? body.error : "unknown_error";
      throw classifyGoogleError({ response: { data: { error: reported } }, message: reported });
    }
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : null;
    return {
      accessToken: typeof body.access_token === "string" ? body.access_token : "",
      refreshToken:
        typeof body.refresh_token === "string" && body.refresh_token.length > 0
          ? body.refresh_token
          : null,
      grantedScopes: parseGrantedScopes(typeof body.scope === "string" ? body.scope : null),
      idToken: typeof body.id_token === "string" ? body.id_token : null,
      expiryDate: expiresIn === null ? null : Date.now() + expiresIn * 1000,
      refreshTokenExpiresAt: null,
    };
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

  async sendMessage({ accessToken, raw, threadId }) {
    // Tests and CI never reach Gmail. The throw is before fetch, so a missing
    // mock cannot become a real send.
    if (process.env.NODE_ENV === "test") {
      throw new GoogleAdapterError("gmail_send_blocked_in_test", true);
    }
    let response: Response;
    try {
      response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          raw,
          ...(threadId ? { threadId } : {}),
        }),
      });
    } catch {
      // The request left the process. Whether Gmail accepted it is unknown.
      throw new GoogleAdapterError("gmail_send_transport", false);
    }
    if (!response.ok) {
      throw await classifySendResponse(response);
    }
    const body = (await response.json()) as { id?: unknown; threadId?: unknown };
    if (typeof body.id !== "string" || typeof body.threadId !== "string") {
      throw new GoogleAdapterError("gmail_send_transport", false);
    }
    return { id: body.id, threadId: body.threadId };
  },
};

async function classifySendResponse(response: Response): Promise<GoogleAdapterError> {
  let reason = "";
  try {
    const body = (await response.json()) as {
      error?: { status?: unknown; errors?: { reason?: unknown }[] };
    };
    const fromErrors = body.error?.errors?.[0]?.reason;
    const fromStatus = body.error?.status;
    reason = typeof fromErrors === "string" ? fromErrors : typeof fromStatus === "string" ? fromStatus : "";
  } catch {
    reason = "";
  }
  if (response.status === 401) return new GoogleAdapterError("token_revoked", true);
  if (response.status === 429) return new GoogleAdapterError("quota", false);
  if (response.status === 403) {
    if (/rate|quota|limit/i.test(reason) && !/scope|insufficient|forbidden/i.test(reason)) {
      return new GoogleAdapterError("quota", false);
    }
    if (/scope|insufficient|forbidden/i.test(reason)) {
      return new GoogleAdapterError("scope_missing", true);
    }
    return new GoogleAdapterError("provider_error", false);
  }
  return new GoogleAdapterError("provider_error", false);
}
