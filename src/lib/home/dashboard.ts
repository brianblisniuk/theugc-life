/**
 * Home dashboard decisions (V2-S4).
 *
 * Counts and nights come from rows the caller already owns. A failed read is
 * not zero. A creator-recorded count is not a Gmail-verified total. This
 * module does not call a model and does not invent a score.
 */
import type { NextAction, NextActionBoard } from "@/lib/home/next-actions";
import type { PersonalCountsLoad } from "@/lib/profile/contract";
import { civilDate } from "@/lib/time/civil-date";
import { selectFeaturedTrip } from "@/lib/trips/nights";

export interface HomeTrip {
  id: string;
  name: string | null;
  destinationName: string;
  startDate: string;
  endDate: string;
  status: string;
}

export const CONTACTED_STATUSES = [
  "pitched",
  "replied",
  "follow_up",
  "negotiating",
  "won",
] as const;

export const HOME_DASHBOARD_COPY = {
  emptyAttention: "Nothing in the data we could read needs a decision today.",
  oneAttention: "You have one thing to move forward.",
  manyAttention: (count: number) => `You have ${count} things to move forward.`,
  blockedAttention: "We could not review what needs attention. This is not an empty day.",
  attentionUnavailable: "Next actions are unavailable. This is not an empty day.",
  attentionReviewed:
    "Pipeline, deliverables, and Gmail suggestions were reviewed for this account.",
  noTrip: "No upcoming trip is recorded.",
  tripError: "We could not review your trips. This does not mean you have none.",
  nightsError: "We could not count nights. This is not zero.",
  nightsNone: "No night count is stored for this trip. This is not a failed count.",
  sameDay: "This trip starts and ends on the same day, so it has no nights.",
  nightsNote: "Confirmed nights count once. Pending nights are not confirmed.",
  countsError: "We could not read the numbers you recorded. This is not zero.",
  countsNote: "You recorded these. They are not a Gmail-verified total.",
  followUpsError: "We could not review follow-ups. This does not mean none are due.",
  followUpsNote: "Due dates on your pipeline. Silence is not ghosting.",
  outreachError: "We could not review outreach campaigns. This does not mean you have none.",
  outreachEmpty: "No outreach campaign is recorded.",
  outreachTruncated:
    "There are more outreach campaigns than this page lists. Each fraction is the stored total for that campaign, not a sample.",
  outreachHotelsEmpty: "No hotels are on this campaign.",
  network:
    "Anonymous network figures are read on a hotel. This page does not publish a score, a rank, or a response rate.",
  insufficient: "There is not enough evidence on this page to publish a figure. This is not zero.",
  continueEmpty: "There is no saved destination to continue. This is not a recommendation.",
} as const;

export interface HomeTask {
  id: string;
  index: string;
  title: string;
  detail: string;
  href: string | null;
  pill: string;
  source: "gmail" | "manual";
}

export interface HomeStat {
  id: string;
  label: string;
  value: string | null;
  note: string;
  source: "gmail" | "manual" | "insufficient";
}

export interface NightCoverage {
  tripNights: number;
  confirmedNights: number;
  pendingNights: number;
  gapNights: number;
}

export type NightCoverageLoad =
  { status: "ok"; coverage: NightCoverage } | { status: "none" } | { status: "error" };

export interface OutreachHotelRow {
  creatorId: string;
  initiativeId: string;
  hotelId: string;
  pipelineStatus: string | null;
}

export interface OutreachInitiativeRow {
  id: string;
  creatorId: string;
  name: string;
}

export interface OutreachCard {
  id: string;
  name: string;
  hotelCount: number;
  contactedCount: number;
  replyCount: number;
}

export const OUTREACH_LIST_CAP = 8;

const FAILED_ATTENTION_SOURCES = new Set([
  "home",
  "pipeline",
  "follow-ups",
  "deliverables",
  "gmail",
]);

export function attentionSourcesUnavailable(notices: readonly { id: string }[]): boolean {
  return notices.some((notice) => FAILED_ATTENTION_SOURCES.has(notice.id));
}

export function attentionEmptyCopy(unavailable: boolean): string {
  return unavailable
    ? HOME_DASHBOARD_COPY.attentionUnavailable
    : HOME_DASHBOARD_COPY.attentionReviewed;
}

export function outreachFractionLabel(card: OutreachCard): string {
  return `${card.contactedCount} of ${card.hotelCount} hotels are sent or further. Saved and pitch-ready hotels are not counted as contacted.`;
}

/** Progress for the home campaign card. A zero hotel list is not a 0% bar. */
export function outreachProgress(
  card: OutreachCard,
): { kind: "empty" } | { kind: "bar"; label: string; percentLabel: string; width: number } {
  if (!Number.isInteger(card.hotelCount) || card.hotelCount <= 0) return { kind: "empty" };
  const contacted =
    Number.isInteger(card.contactedCount) && card.contactedCount > 0 ? card.contactedCount : 0;
  const width = Math.min(100, (contacted / card.hotelCount) * 100);
  return {
    kind: "bar",
    label: `${contacted} of ${card.hotelCount} hotels contacted`,
    percentLabel: `${Math.round(width)}%`,
    width,
  };
}

export type OutreachLoad =
  | { status: "ok"; cards: OutreachCard[]; truncated: boolean }
  | { status: "empty" }
  | { status: "error" };

export interface HomeDashboard {
  heading: string;
  attentionUnavailable: boolean;
  tasks: HomeTask[];
  hiddenCount: number;
  notices: string[];
  stats: HomeStat[];
  trip:
    | { status: "none" }
    | { status: "error" }
    | {
        status: "ok";
        destination: string;
        name: string | null;
        startDate: string;
        endDate: string;
        daysUntil: number | null;
        coverage: NightCoverageLoad;
      };
  outreach: OutreachLoad;
  intelligence: { title: string; lines: string[] };
}

function indexLabel(index: number): string {
  return String(index + 1).padStart(2, "0");
}

function taskSource(action: NextAction): "gmail" | "manual" {
  return action.kind === "gmail_suggestion" ? "gmail" : "manual";
}

function taskPill(action: NextAction): string {
  if (action.kind === "gmail_suggestion") return "Needs reply";
  if (action.kind === "follow_up_due") return "Follow-up";
  if (action.kind === "deliverable_due") return "Due";
  if (action.kind === "credits") return "Credits";
  return "Open";
}

/**
 * The same trip My Trips leads with: planning, upcoming, or active, and a
 * half-open end (`today < endDate`). `asOf` is an instant. The day is the
 * creator's civil date in `timeZone`, not the UTC date.
 */
export function upcomingTrip<T extends HomeTrip>(
  trips: readonly T[],
  asOf: string,
  timeZone: string | null = "UTC",
): T | null {
  const today = civilDate(asOf, timeZone);
  if (!today) return null;
  return selectFeaturedTrip(trips, today);
}

export function daysUntilTrip(start: string, asOf: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}/.test(asOf)) return null;
  const startMs = Date.parse(`${start}T00:00:00.000Z`);
  const today = asOf.slice(0, 10);
  const todayMs = Date.parse(`${today}T00:00:00.000Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(todayMs)) return null;
  return Math.round((startMs - todayMs) / 86_400_000);
}

export function parseNightCoverage(payload: unknown): NightCoverageLoad {
  if (!payload || typeof payload !== "object") return { status: "error" };
  const row = payload as Record<string, unknown>;
  if (row.result === "not_found") return { status: "none" };
  if (row.result !== "ok") return { status: "error" };
  const tripNights = row.trip_nights;
  const confirmedNights = row.confirmed_nights;
  const pendingNights = row.pending_nights;
  const gapNights = row.gap_nights;
  if (
    typeof tripNights !== "number" ||
    typeof confirmedNights !== "number" ||
    typeof pendingNights !== "number" ||
    typeof gapNights !== "number" ||
    !Number.isInteger(tripNights) ||
    !Number.isInteger(confirmedNights) ||
    !Number.isInteger(pendingNights) ||
    !Number.isInteger(gapNights) ||
    tripNights < 0 ||
    confirmedNights < 0 ||
    pendingNights < 0 ||
    gapNights < 0
  ) {
    return { status: "error" };
  }
  if (confirmedNights + pendingNights + gapNights !== tripNights) return { status: "error" };
  return {
    status: "ok",
    coverage: { tripNights, confirmedNights, pendingNights, gapNights },
  };
}

export function outreachCards(
  profileId: string,
  initiatives: readonly OutreachInitiativeRow[],
  hotels: readonly OutreachHotelRow[],
): OutreachLoad | "foreign" {
  if (initiatives.length === 0 && hotels.length === 0) return { status: "empty" };
  for (const row of initiatives) {
    if (row.creatorId !== profileId || !row.name.trim()) return "foreign";
  }
  for (const row of hotels) {
    if (row.creatorId !== profileId) return "foreign";
  }
  const cards: OutreachCard[] = initiatives.map((initiative) => {
    const rows = hotels.filter((hotel) => hotel.initiativeId === initiative.id);
    const contactedCount = rows.filter(
      (hotel) =>
        hotel.pipelineStatus !== null &&
        (CONTACTED_STATUSES as readonly string[]).includes(hotel.pipelineStatus),
    ).length;
    const replyCount = rows.filter((hotel) => hotel.pipelineStatus === "replied").length;
    return {
      id: initiative.id,
      name: initiative.name.trim(),
      hotelCount: rows.length,
      contactedCount,
      replyCount,
    };
  });
  if (cards.length === 0) return { status: "empty" };
  return { status: "ok", cards, truncated: false };
}

export interface OutreachCount {
  initiativeId: string;
  hotelCount: number;
  contactedCount: number;
  replyCount: number;
}

/**
 * Fractions come from exact counts. `initiativeTotal` is the stored campaign
 * count. A longer total truncates the list and must be shown as truncation.
 */
export function outreachFromCounts(
  profileId: string,
  initiatives: readonly OutreachInitiativeRow[],
  totals: readonly OutreachCount[],
  initiativeTotal: number,
): OutreachLoad | "foreign" {
  if (!Number.isInteger(initiativeTotal) || initiativeTotal < 0) return { status: "error" };
  if (initiatives.length === 0 && initiativeTotal === 0 && totals.length === 0) {
    return { status: "empty" };
  }
  if (initiativeTotal < initiatives.length) return { status: "error" };
  for (const row of initiatives) {
    if (row.creatorId !== profileId || !row.name.trim()) return "foreign";
  }
  const byId = new Map<string, OutreachCount>();
  for (const total of totals) {
    if (
      !Number.isInteger(total.hotelCount) ||
      !Number.isInteger(total.contactedCount) ||
      !Number.isInteger(total.replyCount) ||
      total.hotelCount < 0 ||
      total.contactedCount < 0 ||
      total.replyCount < 0 ||
      total.contactedCount > total.hotelCount ||
      total.replyCount > total.hotelCount ||
      byId.has(total.initiativeId)
    ) {
      return { status: "error" };
    }
    byId.set(total.initiativeId, total);
  }
  const cards: OutreachCard[] = [];
  for (const initiative of initiatives) {
    const total = byId.get(initiative.id);
    if (!total) return { status: "error" };
    cards.push({
      id: initiative.id,
      name: initiative.name.trim(),
      hotelCount: total.hotelCount,
      contactedCount: total.contactedCount,
      replyCount: total.replyCount,
    });
  }
  if (cards.length === 0) return { status: "error" };
  return { status: "ok", cards, truncated: initiativeTotal > initiatives.length };
}

function statFromCount(
  id: string,
  label: string,
  counts: PersonalCountsLoad,
  pick: (value: PersonalCountsLoad & { status: "ok" }) => number,
): HomeStat {
  if (counts.status !== "ok") {
    return {
      id,
      label,
      value: null,
      note: HOME_DASHBOARD_COPY.countsError,
      source: "insufficient",
    };
  }
  return {
    id,
    label,
    value: String(pick(counts)),
    note: HOME_DASHBOARD_COPY.countsNote,
    source: "manual",
  };
}

export function buildHomeDashboard(input: {
  actions: NextActionBoard;
  counts: PersonalCountsLoad;
  trips: { status: "ok"; trips: HomeTrip[] } | { status: "error" };
  coverage: NightCoverageLoad;
  outreach: OutreachLoad;
  asOf: string;
  /** IANA zone for the creator's civil date. Blank means UTC. */
  timeZone?: string | null;
  gmail:
    | { status: "ok"; count: number; truncated?: boolean }
    | { status: "paused" }
    | { status: "hidden" }
    | { status: "error" };
}): HomeDashboard {
  const attentionUnavailable = attentionSourcesUnavailable(input.actions.notices);
  const operational = input.actions.actions.filter((action) => action.kind !== "credits");
  const tasks: HomeTask[] = operational.map((action, index) => ({
    id: action.id,
    index: indexLabel(index),
    title: action.title,
    detail: action.detail,
    href: action.href,
    pill: taskPill(action),
    source: taskSource(action),
  }));

  const heading =
    attentionUnavailable && operational.length === 0
      ? HOME_DASHBOARD_COPY.blockedAttention
      : operational.length === 0
        ? HOME_DASHBOARD_COPY.emptyAttention
        : operational.length === 1
          ? HOME_DASHBOARD_COPY.oneAttention
          : HOME_DASHBOARD_COPY.manyAttention(operational.length);

  const followUps: HomeStat =
    input.actions.followUpsDue === null
      ? {
          id: "follow-ups",
          label: "Follow-ups due",
          value: null,
          note: HOME_DASHBOARD_COPY.followUpsError,
          source: "insufficient",
        }
      : {
          id: "follow-ups",
          label: "Follow-ups due",
          value: String(input.actions.followUpsDue),
          note: HOME_DASHBOARD_COPY.followUpsNote,
          source: "manual",
        };

  const stats: HomeStat[] = [
    statFromCount("pitches", "Pitches logged", input.counts, (row) => row.counts.outreach),
    statFromCount("replies", "Replies recorded", input.counts, (row) => row.counts.replies),
    statFromCount(
      "agreements",
      "Agreements recorded",
      input.counts,
      (row) => row.counts.agreements,
    ),
    followUps,
  ];

  let trip: HomeDashboard["trip"];
  if (input.trips.status === "error") {
    trip = { status: "error" };
  } else {
    const today = civilDate(input.asOf, input.timeZone ?? "UTC");
    const next = today ? selectFeaturedTrip(input.trips.trips, today) : null;
    if (!next) {
      trip = { status: "none" };
    } else {
      trip = {
        status: "ok",
        destination: next.destinationName,
        name: next.name,
        startDate: next.startDate,
        endDate: next.endDate,
        daysUntil: today ? daysUntilTrip(next.startDate, today) : null,
        coverage: input.coverage,
      };
    }
  }

  const lines: string[] = [HOME_DASHBOARD_COPY.network];
  if (input.gmail.status === "paused")
    lines.push("Gmail detection is paused. No suggestion id is listed.");
  if (input.gmail.status === "error") {
    lines.push("We could not review Gmail suggestions. This does not mean there are none.");
  }
  if (input.gmail.status === "ok") {
    lines.push(
      input.gmail.count === 0
        ? "No pending Gmail suggestion."
        : input.gmail.count === 1
          ? "1 Gmail suggestion is waiting for your decision."
          : `${input.gmail.count} Gmail suggestions are waiting for your decision.`,
    );
    if (input.gmail.truncated) {
      lines.push(
        "There are more Gmail suggestions than this page lists. It does not say how many.",
      );
    }
  }
  if (trip.status === "ok" && trip.coverage.status === "ok") {
    const nights = trip.coverage.coverage;
    lines.push(
      `${nights.confirmedNights} confirmed nights, ${nights.pendingNights} pending, ${nights.gapNights} uncovered. Pending is not confirmed.`,
    );
  }
  if (trip.status === "ok" && trip.coverage.status === "error")
    lines.push(HOME_DASHBOARD_COPY.nightsError);
  if (input.counts.status !== "ok") lines.push(HOME_DASHBOARD_COPY.countsError);

  return {
    heading,
    attentionUnavailable,
    tasks,
    hiddenCount: input.actions.hiddenCount,
    notices: input.actions.notices.map((notice) => notice.text),
    stats,
    trip,
    outreach: input.outreach,
    intelligence: { title: "What your data supports", lines },
  };
}
