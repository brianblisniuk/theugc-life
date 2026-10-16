/**
 * Dense pipeline presentation (V2-S3, D182, D187).
 *
 * Counts, next actions, and signals come from rows the caller already read.
 * A failed read is not zero. A missing signal is not a rate. `follow_up` is
 * an event, not a stage column. Two opportunities for one hotel stay apart
 * because the key is the pipeline row id, not the hotel and not the display id.
 */
import { utcDay } from "@/lib/collaboration/deadlines";
import {
  activityLabel,
  intelligencePanelState,
  recencyLabel,
  type IntelligenceResult,
  type IntelligenceSignal,
} from "@/lib/hotels/intelligence";
import {
  PIPELINE_STATUSES,
  pipelineStageLabel,
  pipelineStatusLabel,
  type PipelineStatus,
} from "@/lib/pipeline/types";

export const DISPLAY_REF = /^OP-[1-9][0-9]{3,}$/;

export const ATTENTION_LIMIT = 8;

/** Seven stage columns. `follow_up` is absent on purpose (D187). */
export const STAGE_COLUMNS: readonly { status: PipelineStatus; label: string }[] =
  PIPELINE_STATUSES.filter((status) => pipelineStageLabel(status) !== null).map((status) => ({
    status,
    label: pipelineStageLabel(status) ?? pipelineStatusLabel(status),
  }));

export interface DensityRow {
  id: string;
  status: string;
  displayRef: string | null;
  hotelId: string | null;
  hotelName: string;
  destinationName: string | null;
  stayStart: string | null;
  stayEnd: string | null;
  tripName: string | null;
  nextFollowupAt: string | null;
  lastActivityAt: string | null;
  deadlineLabel: string | null;
  contactEmail: string | null;
  metricRank: number | null;
  metricValue: string | null;
  metricSample: string | null;
}

export interface CardSignal {
  kind: "signal" | "insufficient" | "unavailable";
  text: string;
}

export interface NextStep {
  title: string;
  detail: string;
}

export interface CommandSummary {
  kind: "ok";
  tracked: number;
  replied: number;
  followUps: number;
  agreed: number;
  /** Replied, negotiating, and follow-up events. Not a score. */
  moving: number;
}

export interface AttentionAction {
  id: string;
  pipelineItemId: string;
  title: string;
  detail: string;
  href: string | null;
}

export interface AttentionBoard {
  actions: AttentionAction[];
  hiddenCount: number;
  notices: string[];
  empty: string | null;
}

const STATUS_NEXT: Record<string, string> = {
  saved: "Saved. A pitch has not been prepared on this opportunity.",
  planned: "Pitch ready. Nothing has been sent.",
  pitched: "Sent. No reply is recorded on this opportunity.",
  follow_up: "Follow-up is recorded as an event, not a stage.",
  replied: "A reply is recorded. Choose the next step on this opportunity.",
  negotiating: "Negotiation is open on this opportunity.",
  won: "Agreed. Deliverables on this opportunity are separate.",
  closed: "Closed.",
};

const ATTENTION_RANK: Record<string, number> = {
  overdue: 0,
  due_soon: 1,
  follow_up: 2,
  replied: 3,
  negotiating: 4,
  upcoming: 5,
  planned: 6,
  pitched: 7,
  won: 8,
  saved: 9,
};

export function shownDisplayRef(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !DISPLAY_REF.test(value)) return null;
  return value;
}

export function cardKey(row: { id: string }): string {
  return row.id;
}

function calendarDay(value: string | null): string | null {
  if (!value) return null;
  const day = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

export function stayWindow(row: Pick<DensityRow, "stayStart" | "stayEnd">): string | null {
  const start = calendarDay(row.stayStart);
  const end = calendarDay(row.stayEnd);
  if (!start || !end || end <= start) return null;
  return `${start} – ${end}`;
}

export function contextLine(
  row: Pick<DensityRow, "tripName" | "stayStart" | "stayEnd" | "destinationName">,
): string | null {
  const parts: string[] = [];
  const trip = row.tripName?.trim();
  if (trip) parts.push(trip);
  const stay = stayWindow(row);
  if (stay) parts.push(stay);
  else if (row.destinationName?.trim()) parts.push(row.destinationName.trim());
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function nextStep(row: DensityRow, asOf: string): NextStep {
  const statusLine = STATUS_NEXT[row.status] ?? "Open this opportunity and choose the next step.";
  const day = utcDay(asOf);
  const follow = calendarDay(row.nextFollowupAt);
  const followDue = Boolean(day && follow && follow <= day);
  const title = row.deadlineLabel?.trim()
    ? row.deadlineLabel.trim()
    : followDue
      ? `Follow-up date ${follow}`
      : pipelineStatusLabel(row.status);
  const detail =
    followDue && !row.deadlineLabel ? `${statusLine} The date is ${follow}.` : statusLine;
  return { title, detail };
}

/**
 * Public intelligence only. A percent, an address, or a failed read never
 * becomes a signal. Absence is "Insufficient data", not zero.
 */
export function cardSignal(result: IntelligenceResult): CardSignal {
  if (result.status === "error") {
    return {
      kind: "unavailable",
      text: "Creator intelligence is temporarily unavailable",
    };
  }
  if (result.status === "none" || intelligencePanelState(result) !== "signal") {
    return { kind: "insufficient", text: "Insufficient data" };
  }
  const text = signalText(result.signal);
  if (!text || text.includes("%") || text.includes("@")) {
    return { kind: "insufficient", text: "Insufficient data" };
  }
  return { kind: "signal", text };
}

function signalText(signal: IntelligenceSignal): string | null {
  const parts: string[] = [];
  const activity = activityLabel(signal.activityLevel);
  const recency = recencyLabel(signal.recencyBand);
  if (activity) parts.push(activity);
  if (recency) parts.push(recency);
  if (signal.hasObservedCollaboration === true) parts.push("Observed collaboration on record");
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function commandSummary(
  counts: Partial<Record<string, number>> | null,
): CommandSummary | { kind: "error"; text: string } {
  if (!counts) {
    return {
      kind: "error",
      text: "We couldn’t count your opportunities. These are not zeros.",
    };
  }
  const values: number[] = [];
  for (const status of PIPELINE_STATUSES) {
    const value = counts[status];
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return {
        kind: "error",
        text: "We couldn’t count your opportunities. These are not zeros.",
      };
    }
    values.push(value);
  }
  const replied = counts.replied ?? 0;
  const followUps = counts.follow_up ?? 0;
  const negotiating = counts.negotiating ?? 0;
  const agreed = counts.won ?? 0;
  return {
    kind: "ok",
    tracked: values.reduce((sum, value) => sum + value, 0),
    replied,
    followUps,
    agreed,
    moving: replied + negotiating + followUps,
  };
}

export function columnEmptyNote(pageCount: number, total: number | null): string | null {
  if (pageCount > 0) return null;
  if (total === null) return null;
  if (total > 0) return "On another page";
  return null;
}

export function rowsForStage(rows: readonly DensityRow[], status: string): DensityRow[] {
  return rows.filter((row) => row.status === status);
}

export function followUpRows(rows: readonly DensityRow[]): DensityRow[] {
  return rows.filter((row) => row.status === "follow_up");
}

export interface DeadlineAttention {
  pipelineItemId: string;
  hotelId: string;
  hotelName: string;
  state: "overdue" | "due_soon" | "upcoming";
  dueOn: string;
  href: string;
}

export function buildAttention(input: {
  rows: readonly DensityRow[];
  rowsFailed: boolean;
  rowsCapped: boolean;
  deadlines: readonly DeadlineAttention[];
  deadlineRead: "ok" | "error";
  asOf: string;
  hrefFor: (row: DensityRow) => string | null;
  limit?: number;
}): AttentionBoard {
  const notices: string[] = [];
  if (input.rowsFailed) {
    notices.push("We couldn’t review your opportunities. This is not an empty list.");
  }
  if (input.rowsCapped) {
    notices.push("The opportunity list we read is capped. It is not the whole pipeline.");
  }
  if (input.deadlineRead === "error") {
    notices.push("We couldn’t review deliverables. This does not mean nothing is due.");
  }

  const limit = input.limit ?? ATTENTION_LIMIT;
  const byItem = new Map<string, { rank: number; action: AttentionAction }>();

  if (!input.rowsFailed) {
    for (const row of input.rows) {
      if (row.status === "closed") continue;
      const step = nextStep(row, input.asOf);
      const ref = shownDisplayRef(row.displayRef);
      const rank = ATTENTION_RANK[row.status] ?? 9;
      byItem.set(row.id, {
        rank,
        action: {
          id: `pipeline:${row.id}`,
          pipelineItemId: row.id,
          title: row.hotelName.trim() || "Hotel",
          detail: `${ref ?? "Opportunity"} · ${step.title}. ${step.detail}`,
          href: input.hrefFor(row),
        },
      });
    }
  }

  if (input.deadlineRead === "ok") {
    for (const deadline of input.deadlines) {
      if (deadline.state === "upcoming") continue;
      const current = byItem.get(deadline.pipelineItemId);
      const rank = ATTENTION_RANK[deadline.state] ?? 5;
      if (current && current.rank <= rank) continue;
      const name = deadline.hotelName.trim() || "Hotel";
      byItem.set(deadline.pipelineItemId, {
        rank,
        action: {
          id: `deadline:${deadline.pipelineItemId}`,
          pipelineItemId: deadline.pipelineItemId,
          title: name,
          detail: `${deadline.state === "overdue" ? "Overdue" : "Due soon"} · ${deadline.dueOn}. This is one deliverable, not the whole opportunity.`,
          href: deadline.href,
        },
      });
    }
  }

  const ordered = [...byItem.values()].sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.action.pipelineItemId < b.action.pipelineItemId ? -1 : 1;
  });
  const actions = ordered.slice(0, limit).map((entry) => entry.action);
  const hiddenCount = Math.max(0, ordered.length - actions.length);
  const empty =
    actions.length === 0 && !input.rowsFailed && input.deadlineRead !== "error"
      ? "No pending action in the opportunities we could read."
      : null;
  return { actions, hiddenCount, notices, empty };
}
