import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  B02_REQUESTED_SCOPES,
  PRIVATE_PROCESSING_CONSENT_TEXT,
  PRIVATE_PROCESSING_POLICY_VERSION,
  canonicalScopeSet,
  forbiddenScopes,
  hasReadScope,
  type GmailAccountStatus,
  type GmailConnectionState,
} from "@/lib/gmail/contract";
import { openSecret, sealSecret } from "@/lib/gmail/crypto.server";
import { gmailOAuthConfig } from "@/lib/gmail/env.server";
import {
  GoogleAdapterError,
  googleOAuthAdapter,
  type GoogleOAuthAdapter,
} from "@/lib/gmail/google.server";

/**
 * The B02 orchestration layer: everything between "a creator clicked Connect"
 * and "the database holds a coherent connection".
 *
 * Two rules shape all of it.
 *
 * FIRST, every external check happens BEFORE anything local is written. The code
 * exchange, the ID-token verification, the nonce match and the mailbox health
 * check all have to pass before a single row changes, because the local write is
 * the atomic part and the network calls are not.
 *
 * SECOND, when Google has already issued a credential and the local side then
 * refuses, we go back and revoke it. Leaving a live grant we have decided not to
 * keep would mean a human's mailbox is authorized to an application that has no
 * record of it — invisible to them, and to us.
 */

const STATE_TTL_SECONDS = 600;

/** The adapter is injected so tests can drive every provider outcome. */
export interface GmailDeps {
  google: GoogleOAuthAdapter;
  /** Supabase service-role client. The only role that may call the 0036 RPCs. */
  db: ReturnType<typeof createAdminClient>;
}

export function defaultDeps(): GmailDeps {
  return { google: googleOAuthAdapter, db: createAdminClient() };
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** URL-safe, no padding — what PKCE and OAuth state both want. */
function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function codeChallengeFor(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/**
 * Same-origin relative paths only.
 *
 * `//evil.example` is protocol-relative and a browser treats it as absolute, so
 * checking only for a leading `/` is the classic open-redirect hole. A backslash
 * is rejected too: some browsers normalize `/\` to `//`.
 */
export function safeReturnPath(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  if (!candidate.startsWith("/")) return null;
  if (candidate.startsWith("//") || candidate.startsWith("/\\")) return null;
  return candidate;
}

export type StartResult =
  | { result: "ok"; authorizationUrl: string }
  | { result: "not_configured" }
  | { result: "invalid_target" };

/**
 * CONNECT / RECONNECT, step one: record the in-flight authorization and send the
 * browser to Google.
 *
 * The three secrets are generated here and leave in different forms — state and
 * nonce as digests we can recognise but not forge back, the PKCE verifier
 * encrypted because the exchange needs it in plaintext later.
 */
export async function startGmailAuthorization(
  input: {
    userId: string;
    purpose: "connect" | "reconnect";
    targetMailAccountId?: string | null;
    returnPath?: string | null;
    loginHint?: string | null;
  },
  deps: GmailDeps = defaultDeps(),
): Promise<StartResult> {
  let cfg;
  try {
    cfg = gmailOAuthConfig();
  } catch {
    // Fail closed and say so plainly. A half-configured deployment must not
    // present a Connect button that produces a confusing Google error.
    return { result: "not_configured" };
  }

  if (input.purpose === "reconnect" && !input.targetMailAccountId) {
    return { result: "invalid_target" };
  }

  const state = randomToken();
  const nonce = randomToken();
  const codeVerifier = randomToken(64);
  const sealedVerifier = sealSecret(codeVerifier, cfg.encryptionKey, cfg.encryptionKeyVersion);

  const { error } = await deps.db.rpc("gmail_oauth_begin", {
    p_user_id: input.userId,
    p_state_digest: sha256(state),
    p_nonce_digest: sha256(nonce),
    p_verifier_ciphertext: sealedVerifier.ciphertext,
    p_verifier_iv: sealedVerifier.iv,
    p_verifier_auth_tag: sealedVerifier.authTag,
    p_key_version: sealedVerifier.keyVersion,
    p_purpose: input.purpose,
    p_target_mail_account_id: input.targetMailAccountId ?? null,
    p_requested_scopes: [...B02_REQUESTED_SCOPES],
    p_return_path: safeReturnPath(input.returnPath),
    p_ttl_seconds: STATE_TTL_SECONDS,
  });

  if (error) {
    // The composite FK in 0036 rejects a target that is not this user's mailbox,
    // so a caller-supplied account id cannot aim the flow at somebody else.
    return { result: "invalid_target" };
  }

  return {
    result: "ok",
    authorizationUrl: deps.google.buildAuthorizationUrl({
      scopes: B02_REQUESTED_SCOPES,
      state,
      nonce,
      codeChallenge: codeChallengeFor(codeVerifier),
      loginHint: input.loginHint ?? null,
    }),
  };
}

export type CallbackOutcome =
  | { result: "connected"; mailAccountId: string; returnPath: string | null }
  | { result: "consent_required"; mailAccountId: string; returnPath: string | null }
  | { result: "already_connected"; mailAccountId: string; returnPath: string | null }
  | { result: "access_denied" }
  | { result: "invalid_state" }
  | { result: "missing_refresh_token" }
  | { result: "scope_refused"; detail: "missing_read" | "forbidden_scope" }
  | { result: "identity_unverified" }
  | { result: "mailbox_unusable" }
  | { result: "owned_by_other_user" }
  | { result: "not_configured" }
  | { result: "persist_failed" };

interface TransactionRow {
  result: string;
  nonce_digest?: string;
  code_verifier_ciphertext?: string;
  code_verifier_iv?: string;
  code_verifier_auth_tag?: string;
  encryption_key_version?: string;
  purpose?: string;
  target_mail_account_id?: string | null;
  return_path?: string | null;
}

/**
 * CONNECT / RECONNECT, step two: everything Google tells us, checked in order,
 * then one atomic local write.
 *
 * The ordering is the security property. Each step can only run because the
 * previous one passed, and the credential reaches the database last.
 */
export async function completeGmailAuthorization(
  input: {
    userId: string;
    state: string | null;
    code: string | null;
    error: string | null;
  },
  deps: GmailDeps = defaultDeps(),
): Promise<CallbackOutcome> {
  let cfg;
  try {
    cfg = gmailOAuthConfig();
  } catch {
    return { result: "not_configured" };
  }

  // The human declined at Google. Nothing was issued; nothing to clean up.
  if (input.error) return { result: "access_denied" };
  if (!input.state || !input.code) return { result: "invalid_state" };

  // CONSUME ONCE. `delete ... returning`, scoped to this user, so a replay finds
  // nothing and user B cannot finish a flow user A started.
  const { data, error } = await deps.db.rpc("gmail_oauth_consume_transaction", {
    p_user_id: input.userId,
    p_state_digest: sha256(input.state),
  });
  const tx = (data ?? { result: "not_found" }) as TransactionRow;
  if (error || tx.result !== "ok") return { result: "invalid_state" };

  let codeVerifier: string;
  try {
    codeVerifier = openSecret(
      {
        ciphertext: tx.code_verifier_ciphertext!,
        iv: tx.code_verifier_iv!,
        authTag: tx.code_verifier_auth_tag!,
        keyVersion: tx.encryption_key_version!,
      },
      cfg.encryptionKey,
    );
  } catch {
    return { result: "invalid_state" };
  }

  const returnPath = safeReturnPath(tx.return_path);

  let tokens;
  try {
    tokens = await deps.google.exchangeCode({ code: input.code, codeVerifier });
  } catch {
    // A PKCE mismatch, a reused code and an expired code all land here, and all
    // mean the same thing to the human: start again.
    return { result: "invalid_state" };
  }

  /** Give back a grant we are not going to keep. Never logs the token. */
  const compensate = async () => {
    const token = tokens.refreshToken ?? tokens.accessToken;
    if (!token) return;
    try {
      await deps.google.revoke({ token });
    } catch (revokeError) {
      // Sanitized security event: a code, never the credential.
      console.warn("[gmail] compensating revoke failed", {
        code: revokeError instanceof GoogleAdapterError ? revokeError.code : "unknown",
      });
    }
  };

  // OFFLINE ACCESS OR NOTHING. B03 syncs while the human is away, so a
  // connection without a refresh token is not a connection — it is an access
  // token that expires in an hour and a promise we cannot keep.
  if (!tokens.refreshToken) {
    await compensate();
    return { result: "missing_refresh_token" };
  }

  // THE GRANTED SET IS AUTHORITATIVE. Google may return less than we asked for,
  // and may return previously-approved scopes we did not ask for at all. We
  // never infer the granted set from the requested one.
  const granted = canonicalScopeSet(tokens.grantedScopes);
  if (forbiddenScopes(granted).length > 0) {
    await compensate();
    return { result: "scope_refused", detail: "forbidden_scope" };
  }
  if (!hasReadScope(granted)) {
    await compensate();
    return { result: "scope_refused", detail: "missing_read" };
  }

  if (!tokens.idToken) {
    await compensate();
    return { result: "identity_unverified" };
  }

  let identity;
  try {
    identity = await deps.google.verifyIdToken({ idToken: tokens.idToken });
  } catch {
    await compensate();
    return { result: "identity_unverified" };
  }

  // The nonce ties this ID token to the authorization WE started. Without it,
  // state alone leaves the door open to token substitution.
  if (!identity.nonce || sha256(identity.nonce) !== tx.nonce_digest) {
    await compensate();
    return { result: "identity_unverified" };
  }

  // The health check: can this grant actually reach a mailbox? A Google account
  // with no Gmail would otherwise become a "connected" mailbox that never syncs.
  let profile;
  try {
    profile = await deps.google.getProfile({ accessToken: tokens.accessToken });
  } catch {
    await compensate();
    return { result: "mailbox_unusable" };
  }

  const sealed = sealSecret(tokens.refreshToken, cfg.encryptionKey, cfg.encryptionKeyVersion);

  const { data: persisted, error: persistError } = await deps.db.rpc("gmail_connection_persist", {
    p_user_id: input.userId,
    // The VERIFIED subject, never the email address. B01's durable identity.
    p_provider_account_subject: identity.subject,
    p_email_address: profile.emailAddress,
    p_granted_scopes: granted,
    p_refresh_ciphertext: sealed.ciphertext,
    p_refresh_iv: sealed.iv,
    p_refresh_auth_tag: sealed.authTag,
    p_key_version: sealed.keyVersion,
    p_provider_refresh_expires_at: tokens.refreshTokenExpiresAt?.toISOString() ?? null,
    p_expected_mail_account_id: tx.target_mail_account_id ?? null,
    p_consent_policy_version: PRIVATE_PROCESSING_POLICY_VERSION,
  });

  if (persistError) {
    await compensate();
    return { result: "persist_failed" };
  }

  const outcome = (persisted ?? {}) as { result?: string; mail_account_id?: string };

  switch (outcome.result) {
    case "connected":
      return { result: "connected", mailAccountId: outcome.mail_account_id!, returnPath };
    case "consent_required":
      return { result: "consent_required", mailAccountId: outcome.mail_account_id!, returnPath };
    case "already_connected":
      // Not an error, and not a reason to swap the credential of a working
      // connection. The one we just obtained is given back.
      await compensate();
      return { result: "already_connected", mailAccountId: outcome.mail_account_id!, returnPath };
    case "owned_by_other_user":
      // Refused, and the answer says nothing about who owns it.
      await compensate();
      return { result: "owned_by_other_user" };
    default:
      await compensate();
      return { result: "persist_failed" };
  }
}

/**
 * The product consent, granted explicitly and separately.
 *
 * The text and version come from the server constant; the digest is computed
 * from that text. The browser contributes the decision and nothing else, which
 * is what keeps the receipt evidence rather than an assertion.
 */
export async function grantPrivateProcessingConsent(
  input: { userId: string; mailAccountId: string },
  deps: GmailDeps = defaultDeps(),
): Promise<{ result: string }> {
  const consentTextDigest = sha256(PRIVATE_PROCESSING_CONSENT_TEXT);
  const receiptDigest = sha256(
    [
      input.mailAccountId,
      input.userId,
      "private_gmail_processing",
      "granted",
      PRIVATE_PROCESSING_POLICY_VERSION,
      consentTextDigest,
      new Date().toISOString(),
    ].join("|"),
  );

  const { data, error } = await deps.db.rpc("gmail_grant_private_processing_consent", {
    p_user_id: input.userId,
    p_mail_account_id: input.mailAccountId,
    p_policy_version: PRIVATE_PROCESSING_POLICY_VERSION,
    p_consent_text_digest: consentTextDigest,
    p_receipt_digest: receiptDigest,
  });

  if (error) return { result: "failed" };
  return { result: ((data ?? {}) as { result?: string }).result ?? "failed" };
}

export type DisconnectOutcome =
  | { result: "disconnected" }
  | { result: "not_found" }
  | { result: "provider_unavailable" }
  | { result: "not_configured" };

/**
 * DISCONNECT — revoke at Google FIRST, finalize locally SECOND.
 *
 * The ordering is deliberate and documented in §20 of the contract. If Google
 * succeeds and the local write fails, running disconnect again completes the
 * job: Google reports the token already invalid, and finalization proceeds. If
 * we cleared local state first and revocation then failed, we would have
 * destroyed the only credential capable of revoking an access that Google still
 * honours — the user would be told they had disconnected while the application
 * remained authorized.
 *
 * Disconnect is not delete. The mailbox row, consent history, ownership
 * reservation and any derived workspace data all remain.
 */
export async function disconnectGmailAccount(
  input: { userId: string; mailAccountId: string },
  deps: GmailDeps = defaultDeps(),
): Promise<DisconnectOutcome> {
  let cfg;
  try {
    cfg = gmailOAuthConfig();
  } catch {
    return { result: "not_configured" };
  }

  const { data, error } = await deps.db.rpc("gmail_credential_load", {
    p_mail_account_id: input.mailAccountId,
  });
  if (error) return { result: "provider_unavailable" };

  const loaded = (data ?? {}) as {
    result?: string;
    user_id?: string;
    refresh_token_ciphertext?: string;
    refresh_token_iv?: string;
    refresh_token_auth_tag?: string;
    encryption_key_version?: string;
  };

  // Ownership is verified against the stored row, never against a client claim.
  if (loaded.result === "ok" && loaded.user_id !== input.userId) {
    return { result: "not_found" };
  }

  if (loaded.result === "ok") {
    let refreshToken: string;
    try {
      refreshToken = openSecret(
        {
          ciphertext: loaded.refresh_token_ciphertext!,
          iv: loaded.refresh_token_iv!,
          authTag: loaded.refresh_token_auth_tag!,
          keyVersion: loaded.encryption_key_version!,
        },
        cfg.encryptionKey,
      );
    } catch {
      return { result: "provider_unavailable" };
    }

    try {
      await deps.google.revoke({ token: refreshToken });
    } catch (revokeError) {
      const code = revokeError instanceof GoogleAdapterError ? revokeError.code : "unknown";
      // `invalid_token` means Google no longer recognises the token — which is
      // exactly the state revocation was trying to reach, so it is success.
      // Asserted HERE rather than only inside the adapter: the guarantee must
      // not depend on which adapter implementation is wired in.
      if (code !== "invalid_token") {
        // Any other failure means we do NOT know the token is dead, so we must
        // not tell the human it is.
        console.warn("[gmail] revoke failed during disconnect", { code });
        return { result: "provider_unavailable" };
      }
    }
  }

  // Reached when revocation succeeded, when the token was already invalid, and
  // when a previous attempt already removed the credential. All three mean the
  // same thing locally, which is what makes this idempotent.
  const { data: finalized, error: finalizeError } = await deps.db.rpc("gmail_disconnect_finalize", {
    p_user_id: input.userId,
    p_mail_account_id: input.mailAccountId,
  });
  if (finalizeError) return { result: "provider_unavailable" };

  const outcome = (finalized ?? {}) as { result?: string };
  if (outcome.result === "not_found") return { result: "not_found" };
  if (outcome.result !== "ok") return { result: "provider_unavailable" };
  return { result: "disconnected" };
}

export type AccessTokenOutcome =
  | { result: "ok"; accessToken: string }
  | { result: "not_connected"; connectionState?: GmailConnectionState }
  | { result: "consent_missing" }
  | { result: "reauth_required" }
  | { result: "provider_unavailable" }
  | { result: "not_configured" };

/**
 * THE PRIMITIVE B03 WILL BUILD ON: a short-lived access token, in memory.
 *
 * It is never persisted, never logged and never returned to a browser. The
 * function re-checks the connection state and the current consent every call, so
 * a withdrawal takes effect at the one place every future caller passes through
 * rather than depending on each of them remembering to look.
 */
export async function getFreshGmailAccessToken(
  input: { mailAccountId: string },
  deps: GmailDeps = defaultDeps(),
): Promise<AccessTokenOutcome> {
  let cfg;
  try {
    cfg = gmailOAuthConfig();
  } catch {
    return { result: "not_configured" };
  }

  const { data, error } = await deps.db.rpc("gmail_credential_load", {
    p_mail_account_id: input.mailAccountId,
  });
  if (error) return { result: "provider_unavailable" };

  const loaded = (data ?? {}) as {
    result?: string;
    connection_state?: GmailConnectionState;
    refresh_token_ciphertext?: string;
    refresh_token_iv?: string;
    refresh_token_auth_tag?: string;
    encryption_key_version?: string;
  };

  if (loaded.result === "consent_missing") return { result: "consent_missing" };
  if (loaded.result === "not_connected") {
    return { result: "not_connected", connectionState: loaded.connection_state };
  }
  if (loaded.result !== "ok") return { result: "not_connected" };

  let refreshToken: string;
  try {
    refreshToken = openSecret(
      {
        ciphertext: loaded.refresh_token_ciphertext!,
        iv: loaded.refresh_token_iv!,
        authTag: loaded.refresh_token_auth_tag!,
        keyVersion: loaded.encryption_key_version!,
      },
      cfg.encryptionKey,
    );
  } catch {
    return { result: "provider_unavailable" };
  }

  let refreshed;
  try {
    refreshed = await deps.google.refreshAccessToken({ refreshToken });
  } catch (refreshError) {
    const classified =
      refreshError instanceof GoogleAdapterError
        ? refreshError
        : new GoogleAdapterError("unknown_error", false);

    // PERMANENT: the human revoked at Google, changed their password, or a
    // Testing-mode grant lapsed after its ~7 days. Normal lifecycle. The
    // credential goes because it cannot be used; consent history and the
    // ownership reservation stay, because neither stopped being true.
    if (classified.permanent) {
      await deps.db.rpc("gmail_mark_reauth_required", {
        p_mail_account_id: input.mailAccountId,
      });
      return { result: "reauth_required" };
    }

    // TRANSIENT: a blip. Destroying a working credential over one would turn a
    // retry into a re-authorization the human has to perform by hand.
    console.warn("[gmail] refresh failed transiently", { code: classified.code });
    return { result: "provider_unavailable" };
  }

  // Google occasionally rotates the refresh token. Storing the replacement is
  // not optional: the old one stops working.
  if (refreshed.refreshToken && refreshed.refreshToken !== refreshToken) {
    const rotated = sealSecret(refreshed.refreshToken, cfg.encryptionKey, cfg.encryptionKeyVersion);
    await deps.db.rpc("gmail_credential_replace", {
      p_mail_account_id: input.mailAccountId,
      p_refresh_ciphertext: rotated.ciphertext,
      p_refresh_iv: rotated.iv,
      p_refresh_auth_tag: rotated.authTag,
      p_key_version: rotated.keyVersion,
      p_provider_refresh_expires_at: refreshed.refreshTokenExpiresAt?.toISOString() ?? null,
    });
  }

  if (!refreshed.accessToken) return { result: "provider_unavailable" };
  return { result: "ok", accessToken: refreshed.accessToken };
}

/** What the account surface may show its owner. Never mentions token material. */
export async function listGmailAccounts(
  userId: string,
  deps: GmailDeps = defaultDeps(),
): Promise<GmailAccountStatus[]> {
  const { data, error } = await deps.db.rpc("gmail_connection_status", { p_user_id: userId });
  if (error || !Array.isArray(data)) return [];
  return (data as Record<string, unknown>[]).map((row) => ({
    mailAccountId: String(row.mail_account_id),
    emailAddress: (row.email_address as string | null) ?? null,
    connectionState: row.connection_state as GmailConnectionState,
    grantedScopes: Array.isArray(row.granted_scopes) ? (row.granted_scopes as string[]) : [],
    connectedAt: (row.connected_at as string | null) ?? null,
    hasCredential: row.has_credential === true,
    privateProcessingConsent: row.private_processing_consent === true,
    networkContributionConsent: row.network_contribution_consent === true,
  }));
}
