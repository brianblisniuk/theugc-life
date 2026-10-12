/**
 * Inbox links the creator has attached to a pipeline hotel (D080, D082).
 *
 * This is not a mailbox browser and it does not send mail. Rows are the
 * caller's `pipeline_inbox_bindings` only. The page is not in the primary
 * navigation; E02 owns that shell.
 */
import Link from "next/link";
import type { Metadata } from "next";

import { EmptyState } from "@/components/empty-state";
import { requireUser } from "@/lib/auth/guards";
import { loadInboxList } from "@/lib/surfaces/queries";

export const metadata: Metadata = { title: "Inbox" };

const ctaClass =
  "inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast";

export default async function InboxPage() {
  const session = await requireUser("/app/inbox");
  const state = await loadInboxList(session.userId);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-text">Inbox</h1>
        <p className="max-w-prose text-sm text-muted">
          Threads you have linked to a pipeline hotel. Only you can see this. Nothing here sends
          mail.
        </p>
      </header>

      {state.kind === "error" ? (
        <EmptyState title={state.title} description={state.body}>
          <Link href="/app/inbox" className={ctaClass}>
            Try again
          </Link>
        </EmptyState>
      ) : state.kind === "empty" ? (
        <EmptyState title={state.title} description={state.body}>
          {state.cta ? (
            <Link href={state.cta.href} className={ctaClass}>
              {state.cta.label}
            </Link>
          ) : null}
        </EmptyState>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted" role="status" aria-live="polite">
            {state.summary}
          </p>
          <ul className="space-y-3">
            {state.items.map((item) => (
              <li
                key={item.id}
                className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius-app)] border border-border bg-surface p-4"
              >
                <div className="space-y-1">
                  <h2 className="text-base font-semibold text-text">{item.hotelName}</h2>
                  {item.email ? <p className="text-sm text-muted">{item.email}</p> : null}
                </div>
                {item.hotelId ? (
                  <Link
                    href={`/app/hotels/${item.hotelId}`}
                    className="inline-flex rounded-[var(--radius-app)] border border-border px-3 py-1.5 text-sm font-medium text-text hover:bg-background"
                  >
                    Open hotel
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
