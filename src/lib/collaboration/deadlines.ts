/**
 * Deliverable deadline states and in-app reminders (D115).
 *
 * The clock is the UTC calendar day of the read instant, the same comparison
 * D112 uses for a deliverable due date. Pending and rejected rows with a due
 * date are the only rows that have a state. Submitted, approved, and a missing
 * date are not due. No earlier lead is stated, so due soon is that UTC day.
 *
 * This module does not send mail and does not call a model. Home (F04) is a
 * separate read and is not imported here.
 */
import { deliverableTypeLabel } from "@/lib/collaboration/display";
import {
  DELIVERABLE_STATUSES,
  DELIVERABLE_TYPES,
  type DeliverableType,
} from "@/lib/collaboration/contract";
import { isUuid } from "@/lib/hotels/ids";
import { hotelHref } from "@/lib/shell/navigation";

export const DEADLINE_READ_LIMIT = 80;

export const DEADLINE_STATES = ["overdue", "due_soon", "upcoming"] as const;
export type DeadlineState = (typeof DEADLINE_STATES)[number];

const DUE_STATUSES = ["pending", "rejected"] as const;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export const DEADLINE_COPY = {
  overdue: "Overdue",
  due_soon: "Due soon",
  upcoming: "Upcoming",
  title: "Reminders",
  upcomingTitle: "Upcoming deadlines",
  notice: "We couldn't read deliverable deadlines. This is not an empty list.",
  empty: "Nothing is due today or overdue in the dates we could read.",
  capped: "The deliverable list we read has a cap. It is not the whole table.",
  hotelNotice: "We couldn't compare these due dates. This is not a list with nothing due.",
  open: "Open",
} as const;

const STATE_RANK: Record<DeadlineState, number> = {
  overdue: 0,
  due_soon: 1,
  upcoming: 2,
};

export function utcDay(asOf: string): string | null {
  if (typeof asOf !== "string" || asOf.length < 10 || asOf.trim() !== asOf) return null;
  const ms = Date.parse(asOf);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
}

export function isCalendarDay(value: string): boolean {
  const match = DAY.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/**
 * `none` is a known status with no deadline (submitted, approved, or no date).
 * `invalid` is a clock or a value this module will not treat as "not due".
 */
export function classifyDeadline(
  status: string,
  dueOn: string | null,
  asOf: string,
): DeadlineState | "none" | "invalid" {
  const day = utcDay(asOf);
  if (!day) return "invalid";
  if (!(DELIVERABLE_STATUSES as readonly string[]).includes(status)) return "invalid";
  if (dueOn === null) {
    return "none";
  }
  if (!isCalendarDay(dueOn)) return "invalid";
  if (!(DUE_STATUSES as readonly string[]).includes(status)) return "none";
  if (dueOn < day) return "overdue";
  if (dueOn === day) return "due_soon";
  return "upcoming";
}

export interface DeadlineRow {
  id: string;
  creatorId: string;
  pipelineItemId: string;
  hotelId: string;
  hotelName: string;
  deliverableType: DeliverableType;
  quantity: number;
  platform: string | null;
  dueOn: string;
  status: "pending" | "rejected";
}

export interface DeadlineItem {
  id: string;
  pipelineItemId: string;
  hotelId: string;
  hotelName: string;
  title: string;
  detail: string;
  dueOn: string;
  state: DeadlineState;
  href: string;
}

export type DeadlineBoard =
  | {
      kind: "ok";
      reminders: DeadlineItem[];
      upcoming: DeadlineItem[];
      capped: boolean;
      indicators: Record<string, DeadlineState>;
    }
  | { kind: "error"; notice: string };

export function errorDeadlineBoard(): DeadlineBoard {
  return { kind: "error", notice: DEADLINE_COPY.notice };
}

/** A capped read must not say that nothing is due. */
export function showEmptyReminders(board: DeadlineBoard): boolean {
  return board.kind === "ok" && board.reminders.length === 0 && !board.capped;
}

function cleanName(value: string): string | null {
  if (value !== value.trim() || value.length === 0) return null;
  return value;
}

function byDue(a: DeadlineItem, b: DeadlineItem): number {
  if (a.dueOn !== b.dueOn) return a.dueOn < b.dueOn ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function parseDeadlinePayload(
  data: unknown,
  profileId: string,
): { status: "ok"; rows: DeadlineRow[]; truncated: boolean } | { status: "error" } {
  if (!isUuid(profileId) || !data || typeof data !== "object") return { status: "error" };
  const record = data as Record<string, unknown>;
  if (record.result !== "ok") return { status: "error" };
  if (typeof record.truncated !== "boolean" || !Array.isArray(record.deliverables)) {
    return { status: "error" };
  }
  if (record.deliverables.length > DEADLINE_READ_LIMIT) return { status: "error" };
  const rows: DeadlineRow[] = [];
  const seen = new Set<string>();
  for (const raw of record.deliverables) {
    if (!raw || typeof raw !== "object") return { status: "error" };
    const row = raw as Record<string, unknown>;
    const id = row.id;
    const creatorId = row.creator_id;
    const pipelineItemId = row.pipeline_item_id;
    const hotelId = row.hotel_id;
    const hotelName = row.hotel_name;
    const deliverableType = row.deliverable_type;
    const quantity = row.quantity;
    const platform = row.platform;
    const dueOn = row.due_on;
    const status = row.status;
    if (
      typeof id !== "string" ||
      !isUuid(id) ||
      typeof creatorId !== "string" ||
      !isUuid(creatorId) ||
      creatorId !== profileId ||
      typeof pipelineItemId !== "string" ||
      !isUuid(pipelineItemId) ||
      typeof hotelId !== "string" ||
      !isUuid(hotelId) ||
      typeof hotelName !== "string" ||
      !cleanName(hotelName) ||
      typeof deliverableType !== "string" ||
      !(DELIVERABLE_TYPES as readonly string[]).includes(deliverableType) ||
      typeof quantity !== "number" ||
      !Number.isInteger(quantity) ||
      quantity < 1 ||
      quantity > 10000 ||
      !(
        platform === null ||
        (typeof platform === "string" && platform.length > 0 && platform.length <= 80)
      ) ||
      typeof dueOn !== "string" ||
      !isCalendarDay(dueOn) ||
      (status !== "pending" && status !== "rejected")
    ) {
      return { status: "error" };
    }
    if (seen.has(id)) return { status: "error" };
    seen.add(id);
    rows.push({
      id,
      creatorId,
      pipelineItemId,
      hotelId,
      hotelName: cleanName(hotelName)!,
      deliverableType: deliverableType as DeliverableType,
      quantity,
      platform,
      dueOn,
      status,
    });
  }
  return { status: "ok", rows, truncated: record.truncated };
}

export function buildDeadlineBoard(input: {
  asOf: string;
  profileId: string;
  source: { status: "ok"; rows: DeadlineRow[]; truncated: boolean } | { status: "error" };
}): DeadlineBoard {
  if (!isUuid(input.profileId) || utcDay(input.asOf) === null || input.source.status === "error") {
    return errorDeadlineBoard();
  }
  const items: DeadlineItem[] = [];
  const seen = new Set<string>();
  for (const row of input.source.rows) {
    if (row.creatorId !== input.profileId || seen.has(row.id)) return errorDeadlineBoard();
    seen.add(row.id);
    const state = classifyDeadline(row.status, row.dueOn, input.asOf);
    if (state === "invalid" || state === "none") return errorDeadlineBoard();
    const href = hotelHref(row.hotelId, { kind: "collaboration" }, "collaboration");
    if (!href) return errorDeadlineBoard();
    const platform = row.platform ? ` · ${row.platform}` : "";
    items.push({
      id: row.id,
      pipelineItemId: row.pipelineItemId,
      hotelId: row.hotelId,
      hotelName: row.hotelName,
      title: row.hotelName,
      detail: `${row.quantity} × ${deliverableTypeLabel(row.deliverableType)}${platform} · due ${row.dueOn}`,
      dueOn: row.dueOn,
      state,
      href,
    });
  }
  const reminders = items.filter((item) => item.state === "overdue" || item.state === "due_soon");
  reminders.sort(byDue);
  const upcoming = items.filter((item) => item.state === "upcoming");
  upcoming.sort(byDue);
  const indicators: Record<string, DeadlineState> = {};
  for (const item of items) {
    const current = indicators[item.pipelineItemId];
    if (!current || STATE_RANK[item.state] < STATE_RANK[current]) {
      indicators[item.pipelineItemId] = item.state;
    }
  }
  return {
    kind: "ok",
    reminders,
    upcoming,
    capped: input.source.truncated,
    indicators,
  };
}

export interface WorkspaceDeadlineRow {
  id: string;
  status: string;
  dueOn: string | null;
}

export interface WorkspaceReminder {
  id: string;
  state: "overdue" | "due_soon";
  dueOn: string;
  label: string;
}

export type WorkspaceDeadlineView =
  | { kind: "ok"; reminders: WorkspaceReminder[]; byId: Record<string, DeadlineState> }
  | { kind: "invalid" };

/** States for one collaboration's checklist. A bad date fails the comparison. */
export function workspaceDeadlines(
  rows: readonly WorkspaceDeadlineRow[],
  asOf: string,
): WorkspaceDeadlineView {
  if (utcDay(asOf) === null) return { kind: "invalid" };
  const reminders: WorkspaceReminder[] = [];
  const byId: Record<string, DeadlineState> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    if (!isUuid(row.id) || seen.has(row.id)) return { kind: "invalid" };
    seen.add(row.id);
    const state = classifyDeadline(row.status, row.dueOn, asOf);
    if (state === "invalid") return { kind: "invalid" };
    if (state === "none") continue;
    byId[row.id] = state;
    if (state === "overdue" || state === "due_soon") {
      reminders.push({
        id: row.id,
        state,
        dueOn: row.dueOn!,
        label: DEADLINE_COPY[state],
      });
    }
  }
  reminders.sort((a, b) => {
    if (a.dueOn !== b.dueOn) return a.dueOn < b.dueOn ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });
  return { kind: "ok", reminders, byId };
}
