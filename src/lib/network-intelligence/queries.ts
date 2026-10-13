import "server-only";

import { isUuid } from "@/lib/hotels/ids";
import { isPublishedCanonicalHotel } from "@/lib/hotels/publication";
import { createClient } from "@/lib/supabase/server";

import {
  parseGmailPrompt,
  parseNetworkRow,
  parseOwnFacts,
  parsePilotKpis,
  parseProvenance,
  type GmailPromptLoad,
  type NetworkLoad,
  type OwnFactsLoad,
  type PilotLoad,
  type ProvenanceLoad,
  type RankLoad,
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

export async function getGmailNetworkPrompt(pipelineItemId: string): Promise<GmailPromptLoad> {
  if (!isUuid(pipelineItemId)) return { status: "hidden" };
  const data = await userRpc("read_gmail_network_prompt", { p_pipeline_item_id: pipelineItemId });
  if (data === null) return { status: "error" };
  return parseGmailPrompt(data);
}

export async function answerGmailNetworkReading(
  pipelineItemId: string,
  decision: "confirmed" | "dismissed",
): Promise<{ result: string }> {
  if (!isUuid(pipelineItemId)) return { result: "invalid_input" };
  const data = await userRpc("answer_gmail_network_reading", {
    p_pipeline_item_id: pipelineItemId,
    p_decision: decision,
  });
  if (!data || typeof data !== "object") return { result: "error" };
  const result = (data as { result?: unknown }).result;
  return { result: typeof result === "string" ? result : "error" };
}

export async function getOwnNetworkFacts(hotelId: string): Promise<OwnFactsLoad> {
  if (!isUuid(hotelId)) return { status: "hidden" };
  const data = await userRpc("read_own_network_facts", { p_hotel_id: hotelId });
  if (data === null) return { status: "error" };
  return parseOwnFacts(data);
}

export async function getNetworkHotel(hotelId: string): Promise<NetworkLoad> {
  if (!isUuid(hotelId)) return { status: "none" };
  try {
    const supabase = await createClient();
    const { data, error } = await supabase
      .from("network_hotel_public")
      .select(
        "hotel_id, confidence_level, activity_level, has_observed_collaboration, recency_band, freshness_band",
      )
      .eq("hotel_id", hotelId)
      .maybeSingle();
    if (error) return { status: "error" };
    if (!data) return { status: "none" };
    const row = parseNetworkRow(data);
    if (!row) return { status: "error" };
    return { status: "ok", row };
  } catch {
    return { status: "error" };
  }
}

export async function recordNetworkView(hotelId: string): Promise<void> {
  if (!isUuid(hotelId)) return;
  await userRpc("record_network_intelligence_view", { p_hotel_id: hotelId });
}

export async function recordNetworkPriority(hotelId: string): Promise<{ result: string }> {
  if (!isUuid(hotelId)) return { result: "invalid_input" };
  const data = await userRpc("record_network_priority", { p_hotel_id: hotelId });
  if (!data || typeof data !== "object") return { result: "error" };
  const result = (data as { result?: unknown }).result;
  return { result: typeof result === "string" ? result : "error" };
}

export async function getOwnNetworkPriority(hotelId: string): Promise<boolean> {
  if (!isUuid(hotelId)) return false;
  const data = await userRpc("read_own_network_priority", { p_hotel_id: hotelId });
  if (!data || typeof data !== "object") return false;
  return (data as { prioritized?: unknown }).prioritized === true;
}

export async function getDestinationRank(destinationId: string): Promise<RankLoad> {
  if (!isUuid(destinationId)) return { status: "ok", hotels: [] };
  const data = await userRpc("read_network_destination_rank", { p_destination_id: destinationId });
  if (!data || typeof data !== "object") return { status: "error" };
  const row = data as { result?: unknown; hotels?: unknown };
  if (row.result !== "ok" || !Array.isArray(row.hotels)) return { status: "error" };
  const ids: string[] = [];
  const ordered: {
    hotelId: string;
    confidenceLevel: "emerging" | "moderate" | "strong" | null;
    activityLevel: string | null;
    recencyBand: string | null;
  }[] = [];
  for (const item of row.hotels) {
    if (!item || typeof item !== "object") return { status: "error" };
    const hotel = item as Record<string, unknown>;
    if ("evidence_id" in hotel || "owner_user_id" in hotel || "score" in hotel)
      return { status: "error" };
    const hotelId = typeof hotel.hotel_id === "string" ? hotel.hotel_id : "";
    if (!isUuid(hotelId)) return { status: "error" };
    ids.push(hotelId);
    ordered.push({
      hotelId,
      confidenceLevel:
        hotel.confidence_level === "emerging" ||
        hotel.confidence_level === "moderate" ||
        hotel.confidence_level === "strong"
          ? hotel.confidence_level
          : null,
      activityLevel: typeof hotel.activity_level === "string" ? hotel.activity_level : null,
      recencyBand: typeof hotel.recency_band === "string" ? hotel.recency_band : null,
    });
  }
  if (ids.length === 0) return { status: "ok", hotels: [] };
  try {
    const supabase = await createClient();
    const { data: hotels, error } = await supabase
      .from("hotels")
      .select(
        "id, name, destination_id, star_rating, star_rating_source, star_rating_confidence, latitude, longitude, active_status",
      )
      .in("id", ids);
    if (error) return { status: "error" };
    const names = new Map<string, string>();
    for (const hotel of hotels ?? []) {
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
    return {
      status: "ok",
      hotels: ordered
        .filter((hotel) => names.has(hotel.hotelId))
        .map((hotel) => ({ ...hotel, name: names.get(hotel.hotelId)! })),
    };
  } catch {
    return { status: "error" };
  }
}

export async function getAdminPilotKpis(): Promise<PilotLoad> {
  const data = await userRpc("read_admin_pilot_kpis", {});
  if (data === null) return { status: "error" };
  return parsePilotKpis(data);
}

export async function getAdminProvenance(factId: string): Promise<ProvenanceLoad> {
  if (!isUuid(factId)) return { status: "hidden" };
  const data = await userRpc("read_admin_fact_provenance", { p_fact_id: factId });
  if (data === null) return { status: "error" };
  return parseProvenance(data);
}
