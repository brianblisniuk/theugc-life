/**
 * Trip-night calendar (D183).
 *
 * The window is half-open: [start, end). 12 November through 19 November is
 * 7 nights. A confirmed stay counts once. A pending stay does not count as
 * confirmed, and a night that is already confirmed is not counted again as
 * pending. Checkout is exclusive. This is the same rule as
 * `trip_night_coverage`. The screen shows the function's counts only when
 * they match that read.
 */

export type NightMark = "confirmed" | "pending" | "gap";

export interface StaySlice {
  checkIn: string | null;
  checkOut: string | null;
  nightStatus: "pending" | "confirmed";
}

export interface NightCell {
  date: string;
  day: number;
  mark: NightMark;
}

export interface NightCalendar {
  tripNights: number;
  confirmedNights: number;
  pendingNights: number;
  gapNights: number;
  nights: NightCell[];
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDay(value: string): boolean {
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

function utcDay(value: string): number | null {
  if (!isIsoDay(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year!, month! - 1, day!);
}

function isoFromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;

/**
 * Nights inside the trip window. Invalid stays are ignored, so a broken row
 * cannot add a night. A stay that only touches the window contributes the
 * overlapping nights.
 */
export function coverNights(
  start: string,
  end: string,
  stays: readonly StaySlice[],
): NightCalendar {
  const startMs = utcDay(start);
  const endMs = utcDay(end);
  if (startMs === null || endMs === null || endMs <= startMs) {
    return { tripNights: 0, confirmedNights: 0, pendingNights: 0, gapNights: 0, nights: [] };
  }

  const confirmed = new Set<number>();
  const pending = new Set<number>();
  for (const stay of stays) {
    if (!stay.checkIn || !stay.checkOut) continue;
    const from = utcDay(stay.checkIn);
    const to = utcDay(stay.checkOut);
    if (from === null || to === null || to <= from) continue;
    const mark = stay.nightStatus === "confirmed" ? confirmed : pending;
    for (let night = Math.max(from, startMs); night < Math.min(to, endMs); night += DAY_MS) {
      mark.add(night);
    }
  }

  const nights: NightCell[] = [];
  let confirmedNights = 0;
  let pendingNights = 0;
  let gapNights = 0;
  for (let night = startMs; night < endMs; night += DAY_MS) {
    let mark: NightMark = "gap";
    if (confirmed.has(night)) {
      mark = "confirmed";
      confirmedNights += 1;
    } else if (pending.has(night)) {
      mark = "pending";
      pendingNights += 1;
    } else {
      gapNights += 1;
    }
    const date = isoFromUtc(night);
    nights.push({ date, day: Number(date.slice(8, 10)), mark });
  }

  return {
    tripNights: nights.length,
    confirmedNights,
    pendingNights,
    gapNights,
    nights,
  };
}

export function nightCountsMatch(
  calendar: NightCalendar,
  read: {
    tripNights: number;
    confirmedNights: number;
    pendingNights: number;
    gapNights: number;
  },
): boolean {
  return (
    calendar.tripNights === read.tripNights &&
    calendar.confirmedNights === read.confirmedNights &&
    calendar.pendingNights === read.pendingNights &&
    calendar.gapNights === read.gapNights
  );
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

export function monthName(iso: string): string | null {
  const ms = utcDay(iso);
  if (ms === null) return null;
  return MONTHS[new Date(ms).getUTCMonth()] ?? null;
}

export function formatStay(checkIn: string, checkOut: string): string | null {
  if (!isIsoDay(checkIn) || !isIsoDay(checkOut) || checkOut <= checkIn) return null;
  const startMonth = monthName(checkIn);
  const endMonth = monthName(checkOut);
  if (!startMonth || !endMonth) return null;
  const startDay = Number(checkIn.slice(8, 10));
  const endDay = Number(checkOut.slice(8, 10));
  if (startMonth === endMonth) return `${startMonth.slice(0, 3)} ${startDay}–${endDay}`;
  return `${startMonth.slice(0, 3)} ${startDay} – ${endMonth.slice(0, 3)} ${endDay}`;
}

export interface FeaturedTrip {
  id: string;
  startDate: string;
  endDate: string;
  status: string;
}

const FEATURED_STATUSES = new Set(["planning", "upcoming", "active"]);

/**
 * The trip the list leads with. In-progress wins, then the soonest future
 * start. A finished trip is not presented as upcoming.
 */
export function selectFeaturedTrip<T extends FeaturedTrip>(
  trips: readonly T[],
  today: string,
): T | null {
  if (!isIsoDay(today)) return null;
  const open = trips.filter(
    (trip) =>
      FEATURED_STATUSES.has(trip.status) && isIsoDay(trip.startDate) && isIsoDay(trip.endDate),
  );
  const current = open
    .filter((trip) => trip.startDate <= today && today < trip.endDate)
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));
  if (current[0]) return current[0];
  const upcoming = open
    .filter((trip) => trip.startDate >= today && trip.endDate > trip.startDate)
    .sort((a, b) => a.startDate.localeCompare(b.startDate) || a.id.localeCompare(b.id));
  return upcoming[0] ?? null;
}

/**
 * A thrown shortlist or coverage read is a failed read. Both reads succeeding
 * with different counts is a mismatch. They are not the same sentence.
 */
export function nightDrawProblem(input: {
  shortlistOk: boolean;
  coverageOk: boolean;
  countsMatch: boolean;
}): "ok" | "read" | "mismatch" {
  if (!input.shortlistOk || !input.coverageOk) return "read";
  if (!input.countsMatch) return "mismatch";
  return "ok";
}

export function hotelMark(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => /[A-Za-z0-9]/.test(word));
  if (words.length === 0) return "·";
  const first = words[0]!.replace(/[^A-Za-z0-9]/g, "");
  const second = words[1]?.replace(/[^A-Za-z0-9]/g, "") ?? "";
  if (second) return `${first[0] ?? ""}${second[0] ?? ""}`.toUpperCase();
  return first.slice(0, 2).toUpperCase() || "·";
}
