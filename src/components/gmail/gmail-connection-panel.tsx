"use client";

import { useActionState } from "react";

import {
  disconnectGmailAction,
  grantGmailConsentAction,
  type GmailActionState,
} from "@/lib/gmail/actions";
import {
  PRIVATE_PROCESSING_CONSENT_TEXT,
  type GmailAccountStatus,
  type GmailConnectionState,
} from "@/lib/gmail/contract";

/**
 * The smallest UI that exercises B02 honestly.
 *
 * Not the eventual inbox product surface — just enough for a creator to connect,
 * consent, reconnect and disconnect, and to see which of those states they are
 * actually in. Raw scope strings sit behind a details element rather than in the
 * main flow: they are technical noise for the person deciding, and hiding them
 * entirely would be the opposite mistake.
 */

const idle: GmailActionState = { status: "idle" };

const STATE_COPY: Record<GmailConnectionState, { label: string; hint: string }> = {
  pending_authorization: {
    label: "Authorization not finished",
    hint: "The Google step was not completed. Nothing is connected and we hold no access.",
  },
  consent_required: {
    label: "Awaiting your permission",
    hint: "Google has authorized access. We have not read anything yet — that needs your explicit permission below.",
  },
  connected: {
    label: "Connected",
    hint: "We can read this mailbox to build your private workspace.",
  },
  reauth_required: {
    label: "Reauthorization required",
    hint: "Google stopped accepting our stored authorization. This is normal — reconnect to continue.",
  },
  disconnected: {
    label: "Disconnected",
    hint: "Access is stopped. Anything already built from this mailbox was kept.",
  },
  deletion_pending: { label: "Deletion in progress", hint: "A deletion request is running." },
  deleted: { label: "Deleted", hint: "This record was retired." },
};

function StatusMessage({ state }: { state: GmailActionState }) {
  if (state.status === "idle" || !state.message) return null;
  return (
    <p
      role="status"
      className={`text-sm ${state.status === "error" ? "text-danger" : "text-muted"}`}
    >
      {state.message}
    </p>
  );
}

function ConsentPrompt({ mailAccountId }: { mailAccountId: string }) {
  const [state, action, pending] = useActionState(grantGmailConsentAction, idle);
  return (
    <form
      action={action}
      className="space-y-3 rounded-[var(--radius-app)] border border-border p-4"
    >
      <input type="hidden" name="mail_account_id" value={mailAccountId} />
      {/* The exact words the server hashes into the consent receipt. What is
          shown and what is recorded must be the same text. */}
      <p className="text-sm text-text">{PRIVATE_PROCESSING_CONSENT_TEXT}</p>
      <button
        type="submit"
        disabled={pending}
        className="rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {pending ? "Saving…" : "Allow private processing"}
      </button>
      <StatusMessage state={state} />
    </form>
  );
}

function DisconnectButton({ mailAccountId }: { mailAccountId: string }) {
  const [state, action, pending] = useActionState(disconnectGmailAction, idle);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="mail_account_id" value={mailAccountId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-[var(--radius-app)] border border-border px-4 py-2 text-sm disabled:opacity-60"
      >
        {pending ? "Disconnecting…" : "Disconnect"}
      </button>
      <StatusMessage state={state} />
    </form>
  );
}

export function GmailConnectionPanel({
  accounts,
  configured,
}: {
  accounts: GmailAccountStatus[];
  configured: boolean;
}) {
  return (
    <section className="space-y-4 rounded-[var(--radius-app)] border border-border bg-surface p-5">
      <div>
        <h2 className="text-lg font-semibold text-text">Gmail</h2>
        <p className="text-sm text-muted">
          Connect a mailbox so TheUGC can organize your travel collaboration conversations. Your
          Gmail data stays in your own workspace.
        </p>
      </div>

      {!configured ? (
        <p className="text-sm text-muted">Gmail is not configured on this deployment.</p>
      ) : accounts.length === 0 ? (
        <div className="space-y-3">
          <p className="text-sm text-muted">Not connected</p>
          <a
            href="/api/integrations/gmail/oauth/start"
            className="inline-block rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-medium text-white"
          >
            Connect Gmail
          </a>
        </div>
      ) : (
        <ul className="space-y-5">
          {accounts.map((account) => {
            const copy = STATE_COPY[account.connectionState];
            const needsConsent =
              account.hasCredential &&
              !account.privateProcessingConsent &&
              account.connectionState !== "connected";
            return (
              <li key={account.mailAccountId} className="space-y-3 border-t border-border pt-4">
                <div>
                  <p className="text-sm font-medium text-text">{account.emailAddress ?? "—"}</p>
                  <p className="text-sm text-muted">{copy.label}</p>
                  <p className="text-sm text-muted">{copy.hint}</p>
                </div>

                {needsConsent ? <ConsentPrompt mailAccountId={account.mailAccountId} /> : null}

                <div className="flex flex-wrap items-start gap-3">
                  {account.connectionState !== "connected" ? (
                    <a
                      href={`/api/integrations/gmail/oauth/start?purpose=reconnect&mail_account_id=${account.mailAccountId}`}
                      className="rounded-[var(--radius-app)] border border-border px-4 py-2 text-sm"
                    >
                      Reconnect Gmail
                    </a>
                  ) : null}
                  {account.connectionState !== "disconnected" ? (
                    <DisconnectButton mailAccountId={account.mailAccountId} />
                  ) : null}
                </div>

                {/* Network contribution is a separate, optional, default-off
                    decision. Shown so its state is never ambiguous, and B02
                    offers no way to turn it on. */}
                <p className="text-xs text-muted">
                  Shared network intelligence:{" "}
                  {account.networkContributionConsent ? "on" : "off — not contributing"}
                </p>

                {account.grantedScopes.length > 0 ? (
                  <details className="text-xs text-muted">
                    <summary className="cursor-pointer">Technical details</summary>
                    <ul className="mt-1 space-y-0.5">
                      {account.grantedScopes.map((scope) => (
                        <li key={scope}>{scope}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
