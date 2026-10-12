/**
 * Server-only trip access (PRD §7.5, PERMISSIONS.md §5).
 *
 * Reads use the cookie-bound client so RLS is the row boundary. Mutations call
 * service-role RPCs. The user id passed to those RPCs comes from the session,
 * never from the form. The Free active-trip allowance comes from FREE_LIMITS.
 */
import "server-only";

import { FREE_LIMITS } from "@/lib/config";
import { isUuid } from "@/lib/hotels/ids";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import {
  mapLinkResult,
  mapShortlistResult,
  mapTripSummary,
  mapTripWriteResult,
  type LinkResult,
  type ShortlistResult,
  type TripStatus,
  type TripSummaryResult,
  type TripWriteResult,
} from "./types";

export interface TripDestination {
  id: string;
  name: string;
  slug: string;
}

export interface TripRecord {
  id: string;
  name: string | null;
  destinationId: string;
  destinationName: string;
  destinationSlug: string;
  startDate: string;
  endDate: string;
  status: TripStatus;
  visibility: "private" | "public";
}

export interface ShortlistHotel {
  id: string;
  name: string;
}

export interface LinkablePipelineItem {
  id: string;
  status: string;
  tripId: string | null;
  hotelName: string;
}

type TripQueryClient = Awaited<ReturnType<typeof createClient>>;

interface RawDestination {
  id?: unknown;
  name?: unknown;
  slug?: unknown;
}

function oneDestination(
  raw: RawDestination | RawDestination[] | null | undefined,
): TripDestination | null {
  const row = Array.isArray(raw) ? raw[0] : raw;
  if (
    !row ||
    typeof row.id !== "string" ||
    typeof row.name !== "string" ||
    typeof row.slug !== "string"
  ) {
    return null;
  }
  return { id: row.id, name: row.name, slug: row.slug };
}

function mapTrip(row: Record<string, unknown>): TripRecord | null {
  const destination = oneDestination(row.destination as RawDestination | RawDestination[] | null);
  if (
    typeof row.id !== "string" ||
    typeof row.destination_id !== "string" ||
    typeof row.start_date !== "string" ||
    typeof row.end_date !== "string" ||
    typeof row.status !== "string" ||
    !destination
  ) {
    return null;
  }
  const visibility = row.visibility === "public" ? "public" : "private";
  return {
    id: row.id,
    name: typeof row.name === "string" ? row.name : null,
    destinationId: row.destination_id,
    destinationName: destination.name,
    destinationSlug: destination.slug,
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status as TripStatus,
    visibility,
  };
}

async function clientOrInjected(injected?: TripQueryClient): Promise<TripQueryClient> {
  return injected ?? (await createClient());
}

export async function listDestinations(
  injected?: TripQueryClient,
): Promise<{ status: "ok"; destinations: TripDestination[] } | { status: "error" }> {
  try {
    const supabase = await clientOrInjected(injected);
    const { data, error } = await supabase
      .from("destinations")
      .select("id, name, slug")
      .order("name", { ascending: true })
      .limit(2000);
    if (error) return { status: "error" };
    const destinations = (data ?? [])
      .map((row) => oneDestination(row as RawDestination))
      .filter((row): row is TripDestination => row !== null);
    return { status: "ok", destinations };
  } catch {
    return { status: "error" };
  }
}

export async function listTrips(
  injected?: TripQueryClient,
): Promise<{ status: "ok"; trips: TripRecord[] } | { status: "error" }> {
  try {
    const supabase = await clientOrInjected(injected);
    const { data, error } = await supabase
      .from("trips")
      .select(
        "id, name, destination_id, start_date, end_date, status, visibility, destination:destinations(id, name, slug)",
      )
      .order("start_date", { ascending: true })
      .order("id", { ascending: true });
    if (error) return { status: "error" };
    const trips = (data ?? [])
      .map((row) => mapTrip(row as Record<string, unknown>))
      .filter((row): row is TripRecord => row !== null);
    return { status: "ok", trips };
  } catch {
    return { status: "error" };
  }
}

export async function getTrip(
  tripId: string,
  injected?: TripQueryClient,
): Promise<{ status: "ok"; trip: TripRecord | null } | { status: "error" }> {
  if (!isUuid(tripId)) return { status: "ok", trip: null };
  try {
    const supabase = await clientOrInjected(injected);
    const { data, error } = await supabase
      .from("trips")
      .select(
        "id, name, destination_id, start_date, end_date, status, visibility, destination:destinations(id, name, slug)",
      )
      .eq("id", tripId)
      .maybeSingle();
    if (error) return { status: "error" };
    if (!data) return { status: "ok", trip: null };
    const trip = mapTrip(data as Record<string, unknown>);
    return trip ? { status: "ok", trip } : { status: "error" };
  } catch {
    return { status: "error" };
  }
}

export async function getTripSummary(
  tripId: string,
  injected?: TripQueryClient,
): Promise<TripSummaryResult> {
  if (!isUuid(tripId)) return { status: "not_found" };
  try {
    const supabase = await clientOrInjected(injected);
    const { data, error } = await supabase.rpc("trip_workspace_summary", { p_trip_id: tripId });
    if (error) return { status: "error" };
    return mapTripSummary(data);
  } catch {
    return { status: "error" };
  }
}

export async function listShortlist(
  tripId: string,
  injected?: TripQueryClient,
): Promise<{ status: "ok"; hotels: ShortlistHotel[] } | { status: "error" }> {
  if (!isUuid(tripId)) return { status: "ok", hotels: [] };
  try {
    const supabase = await clientOrInjected(injected);
    const { data, error } = await supabase
      .from("trip_hotels")
      .select("hotel_id, hotel:hotels(id, name)")
      .eq("trip_id", tripId)
      .order("created_at", { ascending: true });
    if (error) return { status: "error" };
    const hotels: ShortlistHotel[] = [];
    for (const row of data ?? []) {
      const hotel = (
        row as { hotel?: { id?: unknown; name?: unknown } | { id?: unknown; name?: unknown }[] }
      ).hotel;
      const one = Array.isArray(hotel) ? hotel[0] : hotel;
      if (one && typeof one.id === "string" && typeof one.name === "string") {
        hotels.push({ id: one.id, name: one.name });
      }
    }
    return { status: "ok", hotels };
  } catch {
    return { status: "error" };
  }
}

/** Bounded list of the caller's pipeline items, for linking onto this trip. */
export async function listLinkablePipelineItems(
  injected?: TripQueryClient,
): Promise<
  { status: "ok"; items: LinkablePipelineItem[]; truncated: boolean } | { status: "error" }
> {
  const limit = 100;
  try {
    const supabase = await clientOrInjected(injected);
    const { data, error } = await supabase
      .from("pipeline_items")
      .select("id, status, trip_id, hotel:hotels(name)")
      .order("last_activity_at", { ascending: false })
      .limit(limit + 1);
    if (error) return { status: "error" };
    const rows = data ?? [];
    const truncated = rows.length > limit;
    const items: LinkablePipelineItem[] = [];
    for (const row of rows.slice(0, limit)) {
      const record = row as {
        id?: unknown;
        status?: unknown;
        trip_id?: unknown;
        hotel?: { name?: unknown } | { name?: unknown }[];
      };
      const hotel = Array.isArray(record.hotel) ? record.hotel[0] : record.hotel;
      if (typeof record.id !== "string" || typeof record.status !== "string") continue;
      items.push({
        id: record.id,
        status: record.status,
        tripId: typeof record.trip_id === "string" ? record.trip_id : null,
        hotelName: hotel && typeof hotel.name === "string" ? hotel.name : "Hotel",
      });
    }
    return { status: "ok", items, truncated };
  } catch {
    return { status: "error" };
  }
}

async function write(rpc: string, args: Record<string, unknown>): Promise<unknown | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc(rpc, args);
  if (error) return null;
  return data;
}

export async function createTrip(
  userId: string,
  input: {
    destinationId: string;
    name: string | null;
    startDate: string;
    endDate: string;
    status: TripStatus;
  },
): Promise<TripWriteResult> {
  if (!isUuid(userId)) return { result: "error" };
  const data = await write("create_trip", {
    p_user_id: userId,
    p_destination_id: input.destinationId,
    p_name: input.name,
    p_start_date: input.startDate,
    p_end_date: input.endDate,
    p_status: input.status,
    p_free_active_trip_limit: FREE_LIMITS.activeTrips,
  });
  if (data === null) return { result: "error" };
  return mapTripWriteResult(data);
}

export async function updateTrip(
  userId: string,
  tripId: string,
  input: {
    destinationId: string;
    name: string | null;
    startDate: string;
    endDate: string;
    status: TripStatus;
  },
): Promise<TripWriteResult> {
  if (!isUuid(userId) || !isUuid(tripId)) return { result: "error" };
  const data = await write("update_trip", {
    p_user_id: userId,
    p_trip_id: tripId,
    p_destination_id: input.destinationId,
    p_name: input.name,
    p_start_date: input.startDate,
    p_end_date: input.endDate,
    p_status: input.status,
    p_free_active_trip_limit: FREE_LIMITS.activeTrips,
  });
  if (data === null) return { result: "error" };
  return mapTripWriteResult(data);
}

export async function deleteTrip(userId: string, tripId: string): Promise<TripWriteResult> {
  if (!isUuid(userId) || !isUuid(tripId)) return { result: "error" };
  const data = await write("delete_trip", { p_user_id: userId, p_trip_id: tripId });
  if (data === null) return { result: "error" };
  return mapTripWriteResult(data);
}

export async function addTripHotel(
  userId: string,
  tripId: string,
  hotelId: string,
): Promise<ShortlistResult> {
  if (!isUuid(userId) || !isUuid(tripId) || !isUuid(hotelId)) return { result: "invalid_input" };
  const data = await write("add_trip_hotel", {
    p_user_id: userId,
    p_trip_id: tripId,
    p_hotel_id: hotelId,
  });
  if (data === null) return { result: "error" };
  return mapShortlistResult(data);
}

export async function removeTripHotel(
  userId: string,
  tripId: string,
  hotelId: string,
): Promise<ShortlistResult> {
  if (!isUuid(userId) || !isUuid(tripId) || !isUuid(hotelId)) return { result: "invalid_input" };
  const data = await write("remove_trip_hotel", {
    p_user_id: userId,
    p_trip_id: tripId,
    p_hotel_id: hotelId,
  });
  if (data === null) return { result: "error" };
  return mapShortlistResult(data);
}

export async function linkPipelineItem(
  userId: string,
  pipelineItemId: string,
  tripId: string | null,
): Promise<LinkResult> {
  if (!isUuid(userId) || !isUuid(pipelineItemId)) return { result: "invalid_input" };
  if (tripId !== null && !isUuid(tripId)) return { result: "invalid_input" };
  const data = await write("link_pipeline_item_to_trip", {
    p_user_id: userId,
    p_pipeline_item_id: pipelineItemId,
    p_trip_id: tripId,
  });
  if (data === null) return { result: "error" };
  return mapLinkResult(data);
}
