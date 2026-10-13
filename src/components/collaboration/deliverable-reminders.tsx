import Link from "next/link";

import {
  DEADLINE_COPY,
  showEmptyReminders,
  type DeadlineBoard,
  type DeadlineItem,
} from "@/lib/collaboration/deadlines";

function List({ items }: { items: readonly DeadlineItem[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item) => (
        <li
          key={item.id}
          className="flex flex-wrap items-baseline justify-between gap-2 rounded-[var(--radius-app)] border border-border px-3 py-2"
        >
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-medium text-text">{item.title}</p>
            <p className="text-xs text-muted">{item.detail}</p>
          </div>
          <div className="flex items-center gap-3">
            <span
              className="rounded-[var(--radius-app)] border border-border px-2 py-0.5 text-xs font-medium text-text"
              data-testid="reminder-state"
            >
              {DEADLINE_COPY[item.state]}
            </span>
            <Link href={item.href} className="text-sm font-medium text-text underline">
              {DEADLINE_COPY.open}
            </Link>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** In-app reminders. A failed read stays a notice. An empty success is a sentence, not zero. */
export function DeliverableReminders({ board }: { board: DeadlineBoard }) {
  if (board.kind === "error") {
    return (
      <section aria-label={DEADLINE_COPY.title} className="space-y-1">
        <h2 className="text-sm font-semibold text-text">{DEADLINE_COPY.title}</h2>
        <p className="max-w-prose text-sm text-muted" role="status">
          {board.notice}
        </p>
      </section>
    );
  }

  return (
    <section aria-label={DEADLINE_COPY.title} className="space-y-3">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-text">{DEADLINE_COPY.title}</h2>
        <p className="max-w-prose text-xs text-muted">
          In this app only. Nothing here sends an email or a notification.
        </p>
      </div>
      {board.capped ? (
        <p className="max-w-prose text-sm text-muted" role="status">
          {DEADLINE_COPY.capped}
        </p>
      ) : null}
      {showEmptyReminders(board) ? (
        <p className="text-sm text-muted" role="status">
          {DEADLINE_COPY.empty}
        </p>
      ) : null}
      {board.reminders.length > 0 ? <List items={board.reminders} /> : null}
      {board.upcoming.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-text">{DEADLINE_COPY.upcomingTitle}</h3>
          <List items={board.upcoming} />
        </div>
      ) : null}
    </section>
  );
}
