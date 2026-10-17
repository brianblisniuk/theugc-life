/**
 * Inbox (V2-S4). Linked Gmail threads, commercial classifications, and
 * date suggestions the creator accepts or rejects. This page does not send
 * mail and does not start a sync.
 */
import type { Metadata } from "next";
import Link from "next/link";

import { InboxScreen } from "@/components/inbox/inbox-screen";
import { ErrorState } from "@/components/ui/states";
import { requireUser } from "@/lib/auth/guards";
import { loadInboxWorkspace } from "@/lib/inbox/queries";
import { readOwnTimeZone } from "@/lib/time/zone.server";

export const metadata: Metadata = { title: "Inbox" };

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireUser("/app/inbox");
  const params = await searchParams;
  const filter = typeof params.filter === "string" ? params.filter : null;
  const thread = typeof params.thread === "string" ? params.thread : null;
  const timeZone = await readOwnTimeZone(session.userId);
  const model = await loadInboxWorkspace(session.userId, { filter, thread }, { timeZone });

  if (model.kind === "error") {
    return (
      <div className="space-y-3">
        <ErrorState title={model.title} description={model.body} />
        <Link href="/app/inbox" className="v12-btn">
          Try again
        </Link>
      </div>
    );
  }
  return <InboxScreen model={model} />;
}
