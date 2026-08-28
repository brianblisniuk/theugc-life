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
/**
 * GOOGLE'S REVOCATION DOMAIN, MODELLED.
 *
 * Counting `revoke()` calls tests that we called it. It does not test what
 * calling it DOES, and what it does is the whole problem: Google documents a
 * programmatic revocation as removing every OAuth 2.0 scope previously granted
 * to the PROJECT for that user, invalidating the issued access and refresh
 * tokens for all clients registered under that project.
 *
 * So revocation is not "hand back the token we just received". It is an
 * operation on the (user, project) grant, and a fake that cannot express that
 * cannot catch a compensating revoke destroying a connection somebody else was
 * relying on. This is that fake: tokens belong to a subject, and revoking any
 * one of a subject's tokens invalidates all of them.
 */
export interface FakeGoogleProject {
  /** Mint a refresh token for this Google subject inside this project. */
  issueRefreshToken(subject: string): string;
  /** Project-wide: invalidates EVERY token for the subject that owns this one. */
  revokeToken(token: string): void;
  isTokenValid(token: string): boolean;
  subjectOf(token: string): string | null;
  /** Subjects whose whole project grant has been revoked. */
  revokedSubjects(): string[];
}

export function createFakeGoogleProject(): FakeGoogleProject {
  const owner = new Map<string, string>();
  const revoked = new Set<string>();
  let counter = 0;

  return {
    issueRefreshToken(subject) {
      counter += 1;
      const token = `refresh-${subject}-${counter}-${randomBytes(4).toString("hex")}`;
      owner.set(token, subject);
      // Re-authorizing after a revocation restores the grant, exactly as it does
      // at Google: the human went through the consent screen again.
      revoked.delete(subject);
      return token;
    },
    revokeToken(token) {
      const subject = owner.get(token);
      // An unknown token is not a no-op at Google either, but we can only model
      // what we can attribute; an attributable token revokes its whole grant.
      if (subject) revoked.add(subject);
    },
    isTokenValid(token) {
      const subject = owner.get(token);
      // A token this project never issued is outside the domain we model, so we
      // say nothing about it rather than declaring it dead. Only an
      // attributable, revoked grant produces `invalid_grant` — which keeps the
      // signal meaningful: when a test sees one, a revocation really did reach
      // that subject.
      if (!subject) return true;
      return !revoked.has(subject);
    },
    subjectOf: (token) => owner.get(token) ?? null,
    revokedSubjects: () => [...revoked],
  };
}

export interface FakeGoogleOptions {
  /**
   * The shared authorization domain. Supply the SAME project to two fakes to
   * model two authorizations of the same Google account by one Cloud project —
   * which is where the interesting damage lives.
   */
  project?: FakeGoogleProject;
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
  // Its own project unless a test shares one, so an isolated fake behaves as
  // its own authorization domain and cannot disturb another test's grant.
  const project = options.project ?? createFakeGoogleProject();
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
        // Issued BY the project, so the token carries a real identity that a
        // later revocation can be attributed to.
        refreshToken:
          options.refreshToken === undefined
            ? project.issueRefreshToken(subject)
            : options.refreshToken,
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

    async refreshAccessToken({ refreshToken }): Promise<GoogleTokenSet> {
      calls.refreshes += 1;
      if (options.refreshError) throw options.refreshError;
      // A token whose grant was revoked is dead, and Google says so with
      // `invalid_grant`. This is what makes a project-wide revocation VISIBLE to
      // a test: the damage shows up as the next refresh of an unrelated,
      // still-`connected` mailbox failing.
      if (!project.isTokenValid(refreshToken)) {
        throw new GoogleAdapterError("invalid_grant", true);
      }
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
      // PROJECT-WIDE. Not "destroy this one token".
      project.revokeToken(token);
    },
  };

  return fake;
}

export const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex");
