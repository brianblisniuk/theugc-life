import type { GmailAccountStatus, GmailConnectionState } from "@/lib/gmail/contract";

/**
 * WHICH ACTIONS A MAILBOX MAY BE OFFERED.
 *
 * Pulled out of the panel component so the rules can be tested as rules. The
 * repo's test environment is server/database oriented — there is no jsdom — and
 * these are the decisions worth pinning anyway: rendering assertions would
 * mostly be testing React, whereas each predicate here corresponds to something
 * the database will either accept or refuse.
 */

/**
 * The states `gmail_oauth_begin` accepts as a reconnect target.
 *
 * Offering the action anywhere else offers something the database is certain to
 * refuse: a `connected` mailbox has nothing to reconnect, and the deletion
 * states are terminal or on their way there.
 */
export const RECONNECTABLE_STATES: ReadonlySet<GmailConnectionState> = new Set([
  "pending_authorization",
  "consent_required",
  "reauth_required",
  "disconnected",
]);

export function canReconnect(account: Pick<GmailAccountStatus, "connectionState">): boolean {
  return RECONNECTABLE_STATES.has(account.connectionState);
}

/**
 * WHETHER TO ASK FOR PRIVATE-PROCESSING CONSENT — decided by the STATE, not by
 * the consent projection.
 *
 * `consent_required` means the database has already concluded that no current
 * exact-scope consent exists. A stored consent can be `granted` and still not
 * cover the mailbox in front of us: it may describe a NARROWER scope set from
 * before a reconnect widened the grant, and B01 requires a fresh decision for
 * the new set.
 *
 * The earlier rule hid the prompt whenever the projection said `granted`, which
 * left exactly that case unreachable — "Awaiting your permission" with no way to
 * give it. Asking the state removes the second, weaker interpretation instead of
 * adding a third.
 */
export function needsPrivateProcessingConsent(
  account: Pick<GmailAccountStatus, "connectionState" | "hasCredential">,
): boolean {
  return account.hasCredential && account.connectionState === "consent_required";
}

/**
 * The states a user-facing Disconnect has meaning in.
 *
 * `disconnecting` is included so a retry is possible when the provider side did
 * not resolve. `disconnected` is already there. `deletion_pending` and `deleted`
 * belong to the deletion lifecycle: access has stopped, a specific request may
 * be outstanding, and a Disconnect that moved the state would stop the account
 * surface saying "Deletion in progress" while the request was still running. The
 * database refuses all three; this only keeps the panel from offering them.
 */
const DISCONNECTABLE_STATES: ReadonlySet<GmailConnectionState> = new Set([
  "pending_authorization",
  "consent_required",
  "connected",
  "reauth_required",
  "disconnecting",
]);

export function canDisconnect(account: Pick<GmailAccountStatus, "connectionState">): boolean {
  return DISCONNECTABLE_STATES.has(account.connectionState);
}

/**
 * ONE CREATOR, MANY MAILBOXES.
 *
 * B01 says so explicitly — a personal and a business Gmail are both legitimate —
 * and the backend has always supported it. Rendering Connect only when the list
 * was empty meant that after the first mailbox there was no ordinary way to add
 * a second. This is a generic CONNECT, which is the right flow for an account we
 * have never seen; Reconnect targets a mailbox that already exists here, and
 * using it for a new one would aim at the wrong row.
 */
export function canConnectAnother(configured: boolean, accountCount: number): boolean {
  return configured && accountCount > 0;
}
