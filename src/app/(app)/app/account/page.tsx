import type { Metadata } from "next";
import Link from "next/link";

import { DeleteAccountPanel } from "@/components/account/delete-account-panel";
import { GmailConnectionPanel } from "@/components/gmail/gmail-connection-panel";
import { PageHeader } from "@/components/shell/page-header";
import { getOwnAccountDeletion } from "@/lib/account/deletion";
import { listCrumbs } from "@/lib/shell/navigation";
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
  const deletion = session.role === "creator" ? await getOwnAccountDeletion() : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Account"
        description="Mailbox connection and account deletion live on this page."
        crumbs={listCrumbs("Account")}
      />
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

      {deletion?.status === "error" ? (
        <p className="text-sm text-danger">We couldn’t load the deletion status. Try again.</p>
      ) : null}
      {deletion && deletion.status !== "error" ? (
        <DeleteAccountPanel
          schedule={
            deletion.status === "scheduled"
              ? {
                  deletionRequestedAt: deletion.deletionRequestedAt,
                  deleteAfter: deletion.deleteAfter,
                }
              : null
          }
        />
      ) : null}
    </div>
  );
}
