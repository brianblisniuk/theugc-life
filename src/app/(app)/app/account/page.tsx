import type { Metadata } from "next";
import Link from "next/link";

import { GmailConnectionPanel } from "@/components/gmail/gmail-connection-panel";
import { requireUser } from "@/lib/auth/guards";
import { listGmailAccounts } from "@/lib/gmail/connection.server";
import { isGmailOAuthConfigured } from "@/lib/gmail/env.server";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireUser("/app/account");
  // The OAuth callback redirects back here with its outcome. Only the one
  // outcome the mailbox state cannot express on its own is rendered; see
  // `disconnectNoticeFor`.
  const gmailStatus = (await searchParams).gmail;
  const configured = isGmailOAuthConfigured();
  // Only this user's mailboxes: the RPC filters on the session-derived id, and
  // the page never accepts one from the request.
  const gmailAccounts = configured ? await listGmailAccounts(session.userId) : [];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-text">Account</h1>
      <dl className="grid gap-4 rounded-[var(--radius-app)] border border-border bg-surface p-5 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted">Email</dt>
          <dd className="text-text">{session.email ?? "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">Role</dt>
          <dd className="text-text capitalize">{session.role}</dd>
        </div>
      </dl>

      <GmailConnectionPanel
        accounts={gmailAccounts}
        configured={configured}
        callbackStatus={typeof gmailStatus === "string" ? gmailStatus : null}
      />

      <p className="text-sm text-muted">
        Need to change your password?{" "}
        <Link href="/forgot-password" className="text-accent">
          Reset it
        </Link>
        .
      </p>
    </div>
  );
}
