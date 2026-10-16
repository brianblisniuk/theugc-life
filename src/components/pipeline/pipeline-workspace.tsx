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
  duplicateHotelNote,
  followUpPresentation,
  followUpRows,
  laneBadge,
  laneTone,
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
      ? "No conversations are in reply, negotiation, or follow-up."
      : summary.moving === 1
        ? "One conversation is moving."
        : `${summary.moving} conversations are moving.`;
  const stats = [
    ["Tracked opportunities", summary.tracked, "Every stage, including closed"],
    ["Responses reported", summary.replied, "Replied status only"],
    ["Follow-up checks", summary.followUps, "An event count, not a stage"],
    ["Agreements", summary.agreed, "Won status"],
  ] as const;
  return (
    <div className="v12-stack">
      <section className="v12-darkhero" aria-label="Relationship command center">
        <div>
          <p className="v12-eyebrow">Relationship command center</p>
          <h2>{moving}</h2>
          <p>
            Each attempt has its own opportunity id, stage, and history. A hotel&rsquo;s identity
            stays shared. These counts are exact.
          </p>
        </div>
        <Link href="/app/inbox" className="v12-btn v12-btn-primary">
          Open Inbox
        </Link>
      </section>
      <div className="v12-stats">
        {stats.map(([label, value, note], index) => (
          <div key={label} className={index === 2 ? "v12-stat v12-stat-tint" : "v12-stat"}>
            <span className="v12-stat-label">{label}</span>
            <div className="v12-stat-num">{value}</div>
            <div className="v12-stat-note">{note}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function PipelineAttentionList({ board }: { board: AttentionBoard }) {
  return (
    <section className="v12-stack" aria-label="What needs your attention">
      <div className="v12-subhead">
        <div>
          <h2>What needs your attention</h2>
          <p>Priorities before the board.</p>
        </div>
        {board.actions.length > 0 ? (
          <span className="v12-badge v12-badge-green">
            {board.actions.length === 1
              ? "1 next step"
              : `${board.actions.length} next steps`}
          </span>
        ) : null}
      </div>
      {board.notices.map((notice) => (
        <p key={notice} role="status">
          {notice}
        </p>
      ))}
      {board.empty ? <p>{board.empty}</p> : null}
      {board.actions.length > 0 ? (
        <div className="v12-attention">
          {board.actions.map((action) => {
            const body = (
              <>
                <strong>{action.title}</strong>
                <p>{action.detail}</p>
              </>
            );
            return action.href ? (
              <Link key={action.id} href={action.href} className="v12-navtile">
                <span>{body}</span>
              </Link>
            ) : (
              <div key={action.id} className="v12-navtile">
                <span>{body}</span>
              </div>
            );
          })}
        </div>
      ) : null}
      {board.hiddenCount > 0 ? (
        <p>
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
    <div className="v12-subhead">
      <div>
        <h2>Opportunity board</h2>
        <p>Use Board, List, or Timeline to work from the same set of opportunities.</p>
      </div>
      <div className="v12-head-actions" role="group" aria-label="Pipeline view">
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
  const pitch = row.hotelId && row.id ? opportunityPitchHref(row.hotelId, row.id, row.tripId) : null;
  return (
    <article className="v12-deal">
      <h3>{row.hotelName}</h3>
      {context ? <p>{context}</p> : null}
      <p>{step.detail}</p>
      <div className="v12-deal-foot">
        <span>{ref ?? "Opportunity"}</span>
        <span>{step.title}</span>
      </div>
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
  const sameHotel = duplicateHotelNote(rows);
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
      <div className="v12-stage-board">
        {STAGE_COLUMNS.map((column) => {
          const columnRows = rowsForStage(rows, column.status);
          const total =
            counts && typeof counts[column.status] === "number" ? counts[column.status]! : null;
          const badge = laneBadge(total);
          const empty = columnEmptyNote(columnRows.length, total);
          const emptyText = badge === COUNT_UNAVAILABLE ? COUNT_UNAVAILABLE : (empty ?? "—");
          const tone = laneTone(column.status);
          const laneClass = [
            "v12-lane",
            tone === "reply" ? "v12-lane-reply" : "",
            tone === "negotiate" ? "v12-lane-negotiate" : "",
            tone === "agreed" ? "v12-lane-agreed" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <section key={column.status} className={laneClass}>
              <h3 className="v12-lanehead">
                {column.label}
                <span data-testid={`lane-count-${column.status}`}>{badge}</span>
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
      {sameHotel ? (
        <p className="v12-callout">
          <strong>Same hotel, different opportunities: </strong>
          {sameHotel}
        </p>
      ) : null}
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
    hrefFor: (row) => (row.hotelId ? opportunityPitchHref(row.hotelId, row.id, row.tripId) : null),
  });
}
