import "server-only";

import { isUuid } from "@/lib/hotels/ids";
import { isPublishedCanonicalHotel } from "@/lib/hotels/publication";
import { createClient } from "@/lib/supabase/server";

import {
  DATA_STRENGTH_NOTICE,
  FIT_NOTICE,
  NETWORK_AGGREGATE_NOTICE,
  PERSONAL_NOTICE,
  parseCreatorFit,
  parseFitDecision,
  parseMetricConfidence,
  parseNetworkAggregate,
  parsePersonalAggregate,
  type FitDecision,
  type FitDecisionLoad,
  type FitLoad,
  type NetworkAggregateLoad,
  type PersonalLoad,
  type StrengthLoad,
} from "./contract";

async function userRpc(name: string, args: Record<string, unknown>): Promise<unknown | null> {
  try {
    const supabase = await createClient();
    const { data, error } = await supabase.rpc(name, args);
    if (error) return null;
    return data;
  } catch {
    return null;
  }
}

export async function getHotelMetricConfidence(hotelId: string): Promise<StrengthLoad> {
  if (!isUuid(hotelId)) return { status: "error", notice: DATA_STRENGTH_NOTICE };
  const data = await userRpc("read_hotel_metric_confidence", { p_hotel_id: hotelId });
  if (data === null) return { status: "error", notice: DATA_STRENGTH_NOTICE };
  return parseMetricConfidence(data);
}

export async function getOwnPersonalAggregate(hotelId: string): Promise<PersonalLoad> {
  if (!isUuid(hotelId)) return { status: "hidden" };
  const data = await userRpc("read_own_personal_aggregate", { p_hotel_id: hotelId });
  if (data === null) return { status: "error", notice: PERSONAL_NOTICE };
  return parsePersonalAggregate(data);
}

export async function getNetworkAggregate(hotelId: string): Promise<NetworkAggregateLoad> {
  if (!isUuid(hotelId)) return { status: "error", notice: NETWORK_AGGREGATE_NOTICE };
  const data = await userRpc("read_network_aggregate", { p_hotel_id: hotelId });
  if (data === null) return { status: "error", notice: NETWORK_AGGREGATE_NOTICE };
  return parseNetworkAggregate(data);
}

export async function getCreatorFit(destinationId: string): Promise<FitLoad> {
  if (!isUuid(destinationId)) return { status: "hidden" };
  const data = await userRpc("read_creator_fit", { p_destination_id: destinationId });
  if (data === null) return { status: "error", notice: FIT_NOTICE };
  const parsed = parseCreatorFit(data);
  if (parsed.status !== "ok" || parsed.hotels.length === 0) return parsed;
  try {
    const supabase = await createClient();
    const { data: rows, error } = await supabase
      .from("hotels")
      .select(
        "id, name, destination_id, star_rating, star_rating_source, star_rating_confidence, latitude, longitude, active_status",
      )
      .in(
        "id",
        parsed.hotels.map((hotel) => hotel.hotelId),
      );
    if (error || !rows) return { status: "error", notice: FIT_NOTICE };
    const names = new Map<string, string>();
    for (const hotel of rows) {
      const row = hotel as {
        id: string;
        name: string;
        destination_id: string | null;
        star_rating: number | null;
        star_rating_source: string | null;
        star_rating_confidence: string | null;
        latitude: number | null;
        longitude: number | null;
        active_status: string | null;
      };
      if (
        !isPublishedCanonicalHotel({
          destinationId: row.destination_id,
          starRating: row.star_rating,
          latitude: row.latitude,
          longitude: row.longitude,
          activeStatus: row.active_status,
          starRatingSource: row.star_rating_source,
          starRatingConfidence: row.star_rating_confidence,
        })
      ) {
        return { status: "error", notice: FIT_NOTICE };
      }
      names.set(row.id, row.name);
    }
    if (names.size !== parsed.hotels.length) return { status: "error", notice: FIT_NOTICE };
    return {
      status: "ok",
      detailed: parsed.detailed,
      hotels: parsed.hotels.map((hotel) => ({ ...hotel, name: names.get(hotel.hotelId) ?? "" })),
    };
  } catch {
    return { status: "error", notice: FIT_NOTICE };
  }
}

export async function getOwnFitDecision(hotelId: string): Promise<FitDecisionLoad> {
  if (!isUuid(hotelId)) return { status: "hidden" };
  const data = await userRpc("read_own_fit_decision", { p_hotel_id: hotelId });
  if (data === null) return { status: "error", notice: FIT_NOTICE };
  return parseFitDecision(data);
}

export async function recordCreatorFitDecision(
  hotelId: string,
  decision: FitDecision,
): Promise<{ result: string }> {
  if (!isUuid(hotelId)) return { result: "not_found" };
  const data = await userRpc("record_creator_fit_decision", {
    p_hotel_id: hotelId,
    p_decision: decision,
  });
  if (!data || typeof data !== "object") return { result: "error" };
  const result = (data as { result?: unknown }).result;
  return { result: typeof result === "string" ? result : "error" };
}
