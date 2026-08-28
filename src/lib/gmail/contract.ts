/**
 * The B02 vocabulary that both server code and tests read from one place.
 *
 * Deliberately free of `server-only` and of any secret, so tests and the small
 * account UI can import the scope names and the consent copy without pulling in
 * credentials. Nothing here is a capability; it is the shape of the request.
 */

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";
export const OPENID_SCOPE = "openid";
export const USERINFO_EMAIL_SCOPE = "https://www.googleapis.com/auth/userinfo.email";
export const USERINFO_PROFILE_SCOPE = "https://www.googleapis.com/auth/userinfo.profile";

/**
 * WHAT B02 ASKS GOOGLE FOR, and nothing else.
 *
 * `gmail.readonly` is the restricted scope the whole private-intelligence
 * premise rests on: historical analysis needs message bodies, and `gmail.metadata`
 * returns none and cannot be searched with `q`, so it is a different and
 * insufficient capability rather than a lighter-touch one.
 *
 * `openid` plus the email claim are identity, not mailbox access — they are how
 * we learn WHICH Google account this is, which B01 requires to be the verified
 * `sub` rather than an address.
 *
 * `gmail.send` is ABSENT ON PURPOSE. It is sensitive, nothing in B02 sends mail,
 * and asking for a permission before there is a feature that uses it is how a
 * consent screen becomes something people click past. It arrives later through
 * incremental authorization, and — per B01 — widening the scope set requires a
 * renewed private-processing consent, not just a second Google prompt.
 */
export const B02_REQUESTED_SCOPES: readonly string[] = [
  OPENID_SCOPE,
  USERINFO_EMAIL_SCOPE,
  GMAIL_READONLY_SCOPE,
];

/** Scopes 0035 permits at all. Google must never hand back anything outside it. */
export const APPROVED_SCOPES: readonly string[] = [
  GMAIL_READONLY_SCOPE,
  GMAIL_SEND_SCOPE,
  OPENID_SCOPE,
  USERINFO_EMAIL_SCOPE,
  USERINFO_PROFILE_SCOPE,
];

/**
 * Sorted-distinct, mirroring `public.canonical_scope_set()` exactly.
 *
 * Google returns scopes as a space-delimited string in whatever order it likes,
 * and B01 compares scope sets with `=`. Both sides therefore have to agree on
 * what "the same set" means, and they do it the same way.
 */
export function canonicalScopeSet(scopes: readonly string[]): string[] {
  return [...new Set(scopes.map((s) => s.trim()).filter((s) => s.length > 0))].sort();
}

/** Google sends `scope` as one space-delimited string. */
export function parseGrantedScopes(scope: string | null | undefined): string[] {
  if (!scope) return [];
  return canonicalScopeSet(scope.split(/\s+/));
}

export function hasReadScope(scopes: readonly string[]): boolean {
  return scopes.includes(GMAIL_READONLY_SCOPE);
}

/** Any scope outside the approved set, for a refusal that can name what it saw. */
export function forbiddenScopes(scopes: readonly string[]): string[] {
  return scopes.filter((s) => !APPROVED_SCOPES.includes(s));
}

/**
 * THE CONSENT THE PRODUCT ASKS FOR — owned by the server, versioned, and never
 * accepted from the browser.
 *
 * A client that could supply its own policy version or digest could manufacture
 * a receipt saying the human agreed to something they never saw, which would
 * make the whole append-only consent record worthless. So the exact words live
 * here, the digest is computed from them, and the browser's only input is "yes".
 *
 * It describes private processing and ONLY private processing. Network
 * contribution is a separate, optional, default-off decision, and B02 neither
 * mentions it as implied nor grants it.
 */
export const PRIVATE_PROCESSING_POLICY_VERSION = "gmail-private-processing/2026-08-27";

export const PRIVATE_PROCESSING_CONSENT_TEXT =
  "Allow TheUGC to securely process this Gmail account to find and organize your " +
  "travel collaboration conversations and build your private creator intelligence. " +
  "This applies to your own workspace only. Your Gmail data is not shared with " +
  "other creators and does not contribute to any shared or network intelligence. " +
  "You can withdraw this permission, disconnect the mailbox, or request deletion " +
  "of the data derived from it at any time.";

/** The states the account surface can render, straight from B01's state machine. */
export type GmailConnectionState =
  | "pending_authorization"
  | "connected"
  | "reauth_required"
  | "disconnected"
  | "deletion_pending"
  | "deleted";

export interface GmailAccountStatus {
  mailAccountId: string;
  emailAddress: string | null;
  connectionState: GmailConnectionState;
  grantedScopes: string[];
  connectedAt: string | null;
  hasCredential: boolean;
  privateProcessingConsent: boolean;
  networkContributionConsent: boolean;
}
