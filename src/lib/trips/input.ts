/**
 * Zod parsing for trip forms (PRD §7.5).
 *
 * The database re-validates every field and re-derives identity. This layer
 * exists so a bad form becomes a typed rejection, and so user id, creator id,
 * entitlement and the Free limit are not inputs at all.
 */
import { z } from "zod";

import { isUuid } from "@/lib/hotels/ids";

import { TRIP_NAME_MAX, TRIP_STATUSES, type TripStatus } from "./types";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function isRealDay(value: string): boolean {
  if (!DAY.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

const dayField = z.string().refine(isRealDay, "Enter a real date.");

const tripFields = z
  .object({
    destinationId: z.string().refine(isUuid, "Choose a destination."),
    name: z.string().trim().max(TRIP_NAME_MAX).optional().nullable(),
    startDate: dayField,
    endDate: dayField,
    status: z.enum(TRIP_STATUSES),
  })
  .refine((value) => value.endDate >= value.startDate, {
    message: "The end date can’t be before the start date.",
    path: ["endDate"],
  });

export interface ParsedTrip {
  destinationId: string;
  name: string | null;
  startDate: string;
  endDate: string;
  status: TripStatus;
}

export type TripParse = { ok: true; value: ParsedTrip } | { ok: false; message: string };

function cleanName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function parseTripForm(fields: {
  destinationId?: unknown;
  name?: unknown;
  startDate?: unknown;
  endDate?: unknown;
  status?: unknown;
}): TripParse {
  const parsed = tripFields.safeParse({
    destinationId: fields.destinationId,
    name: cleanName(fields.name) ?? "",
    startDate: typeof fields.startDate === "string" ? fields.startDate : "",
    endDate: typeof fields.endDate === "string" ? fields.endDate : "",
    status: fields.status,
  });
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? "Check the trip details." };
  }
  return {
    ok: true,
    value: {
      destinationId: parsed.data.destinationId,
      name: cleanName(parsed.data.name),
      startDate: parsed.data.startDate,
      endDate: parsed.data.endDate,
      status: parsed.data.status,
    },
  };
}

export function parseTripId(value: unknown): string | null {
  return typeof value === "string" && isUuid(value) ? value : null;
}

export type NightStatusInput = "pending" | "confirmed";

/** Both empty clears the stay. One side alone is refused. Checkout is exclusive. */
export function parseStayPair(
  checkIn: unknown,
  checkOut: unknown,
): { ok: true; checkIn: string | null; checkOut: string | null } | { ok: false } {
  const start = typeof checkIn === "string" ? checkIn.trim() : "";
  const end = typeof checkOut === "string" ? checkOut.trim() : "";
  if (!start && !end) return { ok: true, checkIn: null, checkOut: null };
  if (!isRealDay(start) || !isRealDay(end) || end <= start) return { ok: false };
  return { ok: true, checkIn: start, checkOut: end };
}

export function parseNightStatus(value: unknown): NightStatusInput | null {
  if (value === "pending" || value === "confirmed") return value;
  return null;
}
