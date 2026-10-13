/**
 * Collaborations the creator already recorded (D045, D082).
 *
 * The list is the caller's `collaborations` rows. Agreed compensation stays on
 * the hotel workspace and is not selected here. The page is not in the primary
 * navigation; E02 owns that shell.
 */
import Link from "next/link";
import type { Metadata } from "next";

import { DeliverableReminders } from "@/components/collaboration/deliverable-reminders";
import { EmptyState } from "@/components/empty-state";
import { requireUser } from "@/lib/auth/guards";
import { loadDeliverableDeadlineBoard } from "@/lib/collaboration/deadline-queries";
import { loadCollaborationList } from "@/lib/surfaces/queries";

export const metadata: Metadata = { title: "Collaborations" };

const ctaClass =
  "inline-flex rounded-[var(--radius-app)] bg-accent px-4 py-2 text-sm font-semibold text-accent-contrast";

export default async function CollaborationsPage() {
  const session = await requireUser("/app/collaborations");
  const [state, deadlines] = await Promise.all([
    loadCollaborationList(session.userId),
    loadDeliverableDeadlineBoard(session.userId, new Date().toISOString()),
  ]);

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold text-text">Collaborations</h1>
        <p className="max-w-prose text-sm text-muted">
          Stays and deals you have marked won. Only you can see this.
        </p>
      </header>

      <DeliverableReminders board={deadlines} />

      {state.kind === "error" ? (
        <EmptyState title={state.title} description={state.body}>
          <Link href="/app/collaborations" className={ctaClass}>
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
                  <p className="text-sm text-muted">
                    <span className="rounded-[var(--radius-app)] border border-border px-2 py-0.5 font-medium text-text">
                      {item.statusLabel}
                    </span>
                    {item.typeLabel ? <span className="ml-2">{item.typeLabel}</span> : null}
                  </p>
                  {item.when ? <p className="text-xs text-muted">{item.when}</p> : null}
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
