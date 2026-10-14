import "server-only";

import { isUuid } from "@/lib/hotels/ids";
import { isPublishedCanonicalHotel } from "@/lib/hotels/publication";
import { createClient } from "@/lib/supabase/server";

import {
  METRIC_READ_NOTICE,
  parseHotelSignals,
  parseRanking,
  type HotelSignalsLoad,
  type MetricId,
  type RankingLoad,
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

export async function getHotelMetricSignals(hotelId: string): Promise<HotelSignalsLoad> {
  if (!isUuid(hotelId)) return { status: "error", notice: METRIC_READ_NOTICE };
  const data = await userRpc("read_hotel_metric_signals", { p_hotel_id: hotelId });
  if (data === null) return { status: "error", notice: METRIC_READ_NOTICE };
  return parseHotelSignals(data);
}

async function rankingWithoutNames(destinationId: string, metric: MetricId): Promise<RankingLoad> {
  const data = await userRpc("read_destination_metric_ranking", {
    p_destination_id: destinationId,
    p_metric: metric,
  });
  if (data === null) return { status: "error", notice: METRIC_READ_NOTICE };
  return parseRanking(data, metric);
}

async function attachNames(ranking: RankingLoad): Promise<RankingLoad> {
  if (ranking.status !== "ok" || ranking.hotels.length === 0) return ranking;
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("hotels")
      .select(
        "id, name, destination_id, star_rating, star_rating_source, star_rating_confidence, latitude, longitude, active_status",
      )
      .in(
        "id",
        ranking.hotels.map((hotel) => hotel.hotelId),
      );
    if (error || !data) return { status: "error", notice: METRIC_READ_NOTICE };
    const names = new Map<string, string>();
    for (const hotel of data) {
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
        continue;
      }
      names.set(row.id, row.name);
    }
    if (names.size !== ranking.hotels.length)
      return { status: "error", notice: METRIC_READ_NOTICE };
    return {
      ...ranking,
      hotels: ranking.hotels.map((hotel) => ({ ...hotel, name: names.get(hotel.hotelId)! })),
    };
  } catch {
    return { status: "error", notice: METRIC_READ_NOTICE };
  }
}

export async function getDestinationMetricRanking(
  destinationId: string,
  metric: MetricId,
): Promise<RankingLoad> {
  if (!isUuid(destinationId)) return { status: "error", notice: METRIC_READ_NOTICE };
  return attachNames(await rankingWithoutNames(destinationId, metric));
}

export async function getDestinationMetricRankings(
  destinationId: string,
): Promise<Record<MetricId, RankingLoad>> {
  const [responseRate, responseTime, creatorActivity] = await Promise.all([
    getDestinationMetricRanking(destinationId, "response_rate"),
    getDestinationMetricRanking(destinationId, "response_time"),
    getDestinationMetricRanking(destinationId, "creator_activity"),
  ]);
  return {
    response_rate: responseRate,
    response_time: responseTime,
    creator_activity: creatorActivity,
  };
}
