import Link from "next/link";

import { PrivateNotesEditor } from "@/components/pipeline/private-notes-editor";
import type { PipelineListItem } from "@/lib/pipeline/queries";
import {
  STAGE_COLUMNS,
  buildAttention,
  cardSignal,
  columnEmptyNote,
  commandSummary,
  contactLine,
  contextLine,
  COUNT_UNAVAILABLE,
  followUpPresentation,
  followUpRows,
  laneBadge,
  nextStep,
  rowsForStage,
  shownDisplayRef,
  type AttentionBoard,
  type CardSignal,
  type DeadlineAttention,
  type DensityRow,
} from "@/lib/pipeline/density";
import { pipelinePageHref, type PipelineSurface, type PipelineView } from "@/lib/pipeline/view";
import type { IntelligenceResult } from "@/lib/hotels/intelligence";
import type { MetricId } from "@/lib/metrics/contract";
import { opportunityPitchHref, pipelineRowLinks } from "@/lib/shell/navigation";

export function toDensityRow(item: PipelineListItem): DensityRow {
  return {
    id: item.id,
    status: item.status,
    displayRef: item.displayRef,
    hotelId: item.hotel?.id ?? null,
    hotelName: item.hotel?.name ?? "Unknown hotel",
    destinationName: item.hotel?.destinationName ?? null,
    stayStart: item.stayStart,
    stayEnd: item.stayEnd,
    tripName: item.tripName,
    tripId: item.tripId,
    nextFollowupAt: item.nextFollowupAt,
    lastActivityAt: item.lastActivityAt,
    deadlineLabel: item.deadlineLabel ?? null,
    contactEmail: item.contactEmail ?? null,
    privateNotes: item.privateNotes,
    metricRank: item.metricRank ?? null,
    metricValue: item.metricValue ?? null,
    metricSample: item.metricSample ?? null,
  };
}

function signalFor(
  hotelId: string | null,
  intelligence:
    { status: "error" } | { status: "ok"; byHotel: ReadonlyMap<string, IntelligenceResult> },
): CardSignal {
  if (intelligence.status === "error") return cardSignal({ status: "error" });
  if (!hotelId) return cardSignal({ status: "none" });
  return cardSignal(intelligence.byHotel.get(hotelId) ?? { status: "none" });
}

export function PipelineCommand({ counts }: { counts: Parameters<typeof commandSummary>[0] }) {
  const summary = commandSummary(counts);
  if (summary.kind === "error") {
    return (
      <p className="v12-card v12-card-pad text-sm text-text" role="alert">
        {summary.text}
      </p>
    );
  }
  const moving =
    summary.moving === 0
      ? "No replied, negotiating, or follow-up rows."
      : summary.moving === 1
        ? "1 opportunity is in reply, negotiation, or follow-up."
        : `${summary.moving} opportunities are in reply, negotiation, or follow-up.`;
  const stats = [
    ["Tracked opportunities", summary.tracked],
    ["Replies recorded", summary.replied],
    ["Follow-up events", summary.followUps],
    ["Agreed", summary.agreed],
  ] as const;
  return (
    <section className="v12-card v12-card-pad space-y-3" aria-label="Relationship command center">
      <p className="text-sm text-text">{moving}</p>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
            <dd className="text-2xl font-semibold text-text">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export function PipelineAttentionList({ board }: { board: AttentionBoard }) {
  return (
    <section className="space-y-3" aria-label="What needs your attention">
      <h2 className="text-lg font-semibold text-text">What needs your attention</h2>
      {board.notices.map((notice) => (
        <p key={notice} className="text-sm text-text" role="status">
          {notice}
        </p>
      ))}
      {board.empty ? <p className="text-sm text-muted">{board.empty}</p> : null}
      {board.actions.length > 0 ? (
        <ul className="space-y-2">
          {board.actions.map((action) => (
            <li key={action.id} className="v12-card px-4 py-3">
              {action.href ? (
                <Link href={action.href} className="font-semibold text-text hover:underline">
                  {action.title}
                </Link>
              ) : (
                <span className="font-semibold text-text">{action.title}</span>
              )}
              <p className="text-sm text-muted">{action.detail}</p>
            </li>
          ))}
        </ul>
      ) : null}
      {board.hiddenCount > 0 ? (
        <p className="text-sm text-muted">
          {board.hiddenCount === 1
            ? "1 more action is in the rows we read."
            : `${board.hiddenCount} more actions are in the rows we read.`}
        </p>
      ) : null}
    </section>
  );
}

export function PipelineViewSwitch({
  view,
  status,
  surface,
  rank,
}: {
  view: PipelineView;
  status: string | null;
  surface: PipelineSurface;
  rank: MetricId | null;
}) {
  const views: { id: PipelineView; label: string }[] = [
    { id: "board", label: "Board" },
    { id: "list", label: "List" },
    { id: "timeline", label: "Timeline" },
  ];
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-lg font-semibold text-text">Opportunity board</h2>
      <div className="flex gap-2" role="group" aria-label="Pipeline view">
        {views.map((item) => {
          const current = view === item.id;
          return (
            <Link
              key={item.id}
              href={pipelinePageHref(
                status,
                1,
                surface,
                rank,
                item.id === "board" ? null : item.id,
              )}
              aria-current={current ? "page" : undefined}
              className={
                "inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-semibold " +
                (current
                  ? "border-accent bg-accent text-accent-contrast"
                  : "border-border text-text")
              }
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}

function OpportunityCard({
  row,
  surface,
  asOf,
  signal,
  contactRead,
}: {
  row: DensityRow;
  surface: PipelineSurface;
  asOf: string;
  signal: CardSignal;
  contactRead: "ok" | "error";
}) {
  const step = nextStep(row, asOf);
  const ref = shownDisplayRef(row.displayRef);
  const context = contextLine(row);
  const links = pipelineRowLinks(
    {
      status: row.status,
      hotelId: row.hotelId,
      hotelName: row.hotelName,
      id: row.id,
      tripId: row.tripId,
    },
    surface,
  );
  const pitch = row.hotelId && row.id ? opportunityPitchHref(row.hotelId, row.id) : null;
  return (
    <article className="mt-2 rounded-md border border-border bg-surface p-3 text-sm text-text">
      <h3 className="font-semibold">{row.hotelName}</h3>
      {context ? <p className="text-muted">{context}</p> : null}
      <p className="mt-1 text-xs font-semibold text-text">
        {ref ?? "Opportunity"} · {step.title}
      </p>
      <p className="text-xs text-muted">{step.detail}</p>
      <p className="mt-1 text-xs text-text" data-testid="pipeline-signal">
        Hotel signal: {signal.text}
      </p>
      {row.metricValue ? (
        <p className="mt-1 text-xs text-text" data-testid="pipeline-rank">
          {row.metricRank}. {row.metricValue}
          {row.metricSample ? <span className="text-muted"> · {row.metricSample}</span> : null}
        </p>
      ) : null}
      {row.deadlineLabel ? (
        <p className="mt-1 text-xs font-semibold text-text" data-testid="pipeline-deadline">
          {row.deadlineLabel}
        </p>
      ) : null}
      {contactLine({ read: contactRead, email: row.contactEmail }).kind === "email" &&
      row.contactEmail ? (
        <a
          className="mt-1 block break-all text-xs text-text underline"
          href={`mailto:${row.contactEmail}`}
          data-testid="pipeline-contact"
        >
          {row.contactEmail}
        </a>
      ) : contactLine({ read: contactRead, email: row.contactEmail }).kind === "unavailable" ? (
        <p className="mt-1 text-xs text-text" role="status">
          We couldn’t check the unlocked email.
        </p>
      ) : (
        <p className="mt-1 text-xs text-muted">No unlocked email on this card.</p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {links.map((link) => (
          <Link
            key={link.href}
            href={link.href}
            aria-label={link.ariaLabel}
            className="text-xs font-semibold underline"
          >
            {link.label}
          </Link>
        ))}
        {pitch ? (
          <Link href={pitch} className="text-xs font-semibold underline">
            Pitch
          </Link>
        ) : null}
      </div>
      <PrivateNotesEditor pipelineItemId={row.id} initialNotes={row.privateNotes} />
    </article>
  );
}

export function PipelineDense({
  items,
  surface,
  view,
  asOf,
  counts,
  contactRead,
  intelligence,
}: {
  items: readonly PipelineListItem[];
  surface: PipelineSurface;
  view: PipelineView;
  asOf: string;
  counts: Partial<Record<string, number>> | null;
  contactRead: "ok" | "error";
  intelligence:
    { status: "error" } | { status: "ok"; byHotel: ReadonlyMap<string, IntelligenceResult> };
}) {
  const rows = items.map(toDensityRow);
  if (view === "list") {
    return (
      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.id}>
            <OpportunityCard
              row={row}
              surface={surface}
              asOf={asOf}
              signal={signalFor(row.hotelId, intelligence)}
              contactRead={contactRead}
            />
          </li>
        ))}
      </ul>
    );
  }
  if (view === "timeline") {
    const groups = new Map<string, DensityRow[]>();
    for (const row of rows) {
      const day = row.lastActivityAt?.slice(0, 10);
      const key = day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : "No activity date";
      const list = groups.get(key) ?? [];
      list.push(row);
      groups.set(key, list);
    }
    return (
      <div className="space-y-4">
        {[...groups.entries()].map(([day, group]) => (
          <section key={day}>
            <h3 className="text-sm font-semibold text-text">{day}</h3>
            {group.map((row) => (
              <OpportunityCard
                key={row.id}
                row={row}
                surface={surface}
                asOf={asOf}
                signal={signalFor(row.hotelId, intelligence)}
                contactRead={contactRead}
              />
            ))}
          </section>
        ))}
      </div>
    );
  }

  const events = followUpRows(rows);
  const followTotal = counts && typeof counts.follow_up === "number" ? counts.follow_up : null;
  const follow = followUpPresentation(events.length, followTotal);
  return (
    <div className="space-y-4">
      {follow.visible ? (
        <section aria-label="Follow-up events">
          <h3 className="text-sm font-semibold text-text">
            Follow-up events{" "}
            <span className="font-normal text-muted" data-testid="follow-up-count">
              {follow.badge}
            </span>
          </h3>
          <p className="text-xs text-muted">An event, not a stage column.</p>
          {follow.note ? <p className="text-xs text-muted">{follow.note}</p> : null}
          {events.map((row) => (
            <OpportunityCard
              key={row.id}
              row={row}
              surface={surface}
              asOf={asOf}
              signal={signalFor(row.hotelId, intelligence)}
              contactRead={contactRead}
            />
          ))}
        </section>
      ) : null}
      <div className="flex gap-3 overflow-x-auto pb-2">
        {STAGE_COLUMNS.map((column) => {
          const columnRows = rowsForStage(rows, column.status);
          const total =
            counts && typeof counts[column.status] === "number" ? counts[column.status]! : null;
          const badge = laneBadge(total);
          const empty = columnEmptyNote(columnRows.length, total);
          const emptyText = badge === COUNT_UNAVAILABLE ? COUNT_UNAVAILABLE : (empty ?? "—");
          return (
            <section key={column.status} className="w-56 shrink-0">
              <h3 className="flex justify-between border-b border-border py-2 text-xs font-bold uppercase tracking-wider">
                {column.label}
                <span
                  className="font-normal text-muted"
                  data-testid={`lane-count-${column.status}`}
                >
                  {badge}
                </span>
              </h3>
              {columnRows.length === 0 ? (
                <p className="px-1 py-2 text-sm text-muted">{emptyText}</p>
              ) : (
                columnRows.map((row) => (
                  <OpportunityCard
                    key={row.id}
                    row={row}
                    surface={surface}
                    asOf={asOf}
                    signal={signalFor(row.hotelId, intelligence)}
                    contactRead={contactRead}
                  />
                ))
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

export function attentionFromRows(input: {
  rows: readonly PipelineListItem[];
  rowsFailed: boolean;
  rowsCapped: boolean;
  deadlines: readonly DeadlineAttention[];
  deadlineRead: "ok" | "error";
  asOf: string;
}): AttentionBoard {
  return buildAttention({
    rows: input.rows.map(toDensityRow),
    rowsFailed: input.rowsFailed,
    rowsCapped: input.rowsCapped,
    deadlines: input.deadlines,
    deadlineRead: input.deadlineRead,
    asOf: input.asOf,
    hrefFor: (row) => (row.hotelId ? opportunityPitchHref(row.hotelId, row.id) : null),
  });
}
