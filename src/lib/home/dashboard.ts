/**
 * Home dashboard decisions (V2-S4).
 *
 * Counts and nights come from rows the caller already owns. A failed read is
 * not zero. A creator-recorded count is not a Gmail-verified total. This
 * module does not call a model and does not invent a score.
 */
import type { NextAction, NextActionBoard } from "@/lib/home/next-actions";
import type { PersonalCountsLoad } from "@/lib/profile/contract";

export interface HomeTrip {
  id: string;
  name: string | null;
  destinationName: string;
  startDate: string;
  endDate: string;
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
  noTrip: "No upcoming trip is recorded.",
  tripError: "We could not review your trips. This does not mean you have none.",
  nightsError: "We could not count nights. This is not zero.",
  sameDay: "This trip starts and ends on the same day, so it has no nights.",
  nightsNote: "Confirmed nights count once. Pending nights are not confirmed.",
  countsError: "We could not read the numbers you recorded. This is not zero.",
  countsNote: "You recorded these. They are not a Gmail-verified total.",
  followUpsError: "We could not review follow-ups. This does not mean none are due.",
  followUpsNote: "Due dates on your pipeline. Silence is not ghosting.",
  outreachError: "We could not review outreach campaigns. This does not mean you have none.",
  outreachEmpty: "No outreach campaign is recorded.",
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
}

export type OutreachLoad =
  { status: "ok"; cards: OutreachCard[] } | { status: "empty" } | { status: "error" };

export interface HomeDashboard {
  heading: string;
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

export function upcomingTrip<T extends HomeTrip>(trips: readonly T[], asOf: string): T | null {
  const today = asOf.slice(0, 10);
  return (
    trips
      .filter((trip) => trip.endDate >= today)
      .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id))[0] ?? null
  );
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
    return {
      id: initiative.id,
      name: initiative.name.trim(),
      hotelCount: rows.length,
      contactedCount,
    };
  });
  if (cards.length === 0) return { status: "empty" };
  return { status: "ok", cards };
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
  gmail:
    | { status: "ok"; count: number; truncated?: boolean }
    | { status: "paused" }
    | { status: "hidden" }
    | { status: "error" };
}): HomeDashboard {
  const blocked = input.actions.notices.some((notice) => notice.id === "home");
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

  const heading = blocked
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
    const next = upcomingTrip(input.trips.trips, input.asOf);
    if (!next) {
      trip = { status: "none" };
    } else {
      trip = {
        status: "ok",
        destination: next.destinationName,
        name: next.name,
        startDate: next.startDate,
        endDate: next.endDate,
        daysUntil: daysUntilTrip(next.startDate, input.asOf),
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
    tasks,
    hiddenCount: input.actions.hiddenCount,
    notices: input.actions.notices.map((notice) => notice.text),
    stats,
    trip,
    outreach: input.outreach,
    intelligence: { title: "What your data supports", lines },
  };
}
