/**
 * Server-only pipeline data access (PRD §7.4, PERMISSIONS.md §5).
 *
 * Two different clients are used deliberately:
 *
 *  - READS use the cookie-bound client, so `pipeline_items_all`
 *    (`creator_id = current_creator_id()`) enforces ownership via RLS. A
 *    creator can never read another creator's relationships.
 *
 *  - The SAVE mutation uses the service-role client to call the transactional
 *    RPC, because the operation needs a transaction, a per-creator lock, and
 *    limit enforcement that RLS alone cannot express. Identity is derived from
 *    the authenticated session and passed to the RPC, which resolves the
 *    creator_profile itself — a creator_id is never accepted from a caller.
 */
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/hotels/ids";
import { FREE_LIMITS } from "@/lib/config";

import { mapSaveResult, type PipelineStatus, type SaveResult } from "./types";

/** The creator's relationship with one hotel, as shown on Hotel Detail. */
export interface HotelRelationship {
  pipelineItemId: string;
  status: PipelineStatus;
}

export interface PipelineListItem {
  id: string;
  status: PipelineStatus;
  savedAt: string | null;
  lastActivityAt: string | null;
  nextFollowupAt: string | null;
  hotel: {
    id: string;
    name: string;
    destinationName: string | null;
    countryCode: string | null;
  } | null;
}

/**
 * The current OPEN relationship for this hotel, or null when there is none.
 * Reads under the caller's RLS, so it can only ever see the caller's own rows.
 */
export async function getOpenRelationship(hotelId: string): Promise<HotelRelationship | null> {
  if (!isUuid(hotelId)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("pipeline_items")
    .select("id, status")
    .eq("hotel_id", hotelId)
    .neq("status", "closed")
    .maybeSingle();

  if (error || !data) return null;
  const row = data as { id: string; status: string };
  return { pipelineItemId: row.id, status: row.status as PipelineStatus };
}

/** Creator-owned pipeline items, most recent activity first. */
export async function listPipelineItems(status?: string | null): Promise<PipelineListItem[]> {
  const supabase = await createClient();
  let builder = supabase
    .from("pipeline_items")
    .select(
      "id, status, saved_at, last_activity_at, next_followup_at, hotel:hotels(id, name, country_code, destination:destinations(name))",
    );

  if (status) builder = builder.eq("status", status);

  const { data, error } = await builder
    .order("last_activity_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(200);

  if (error) throw new Error("pipeline_list_failed");

  return (data ?? []).map((raw) => {
    const row = raw as unknown as Record<string, unknown>;
    const hotelRaw = row.hotel as Record<string, unknown> | Record<string, unknown>[] | null;
    const hotel = Array.isArray(hotelRaw) ? hotelRaw[0] : hotelRaw;
    const destRaw = hotel?.destination as
      Record<string, unknown> | Record<string, unknown>[] | null | undefined;
    const dest = Array.isArray(destRaw) ? destRaw[0] : destRaw;

    return {
      id: String(row.id),
      status: row.status as PipelineStatus,
      savedAt: (row.saved_at as string | null) ?? null,
      lastActivityAt: (row.last_activity_at as string | null) ?? null,
      nextFollowupAt: (row.next_followup_at as string | null) ?? null,
      hotel: hotel
        ? {
            id: String(hotel.id),
            name: String(hotel.name),
            destinationName: (dest?.name as string | null) ?? null,
            countryCode: (hotel.country_code as string | null) ?? null,
          }
        : null,
    } satisfies PipelineListItem;
  });
}

/**
 * Transactionally save a hotel to the authenticated creator's pipeline.
 *
 * `userId` MUST come from the server-side session — never from a form field.
 * The Free open-relationship limit is passed from typed server config so the
 * value has a single source of truth.
 */
export async function saveHotelToPipeline(userId: string, hotelId: string): Promise<SaveResult> {
  if (!isUuid(userId) || !isUuid(hotelId)) return { result: "error" };

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("save_hotel_to_pipeline", {
    p_user_id: userId,
    p_hotel_id: hotelId,
    p_free_saved_limit: FREE_LIMITS.savedHotels,
  });

  // Never surface a raw Postgres/PostgREST error to the browser.
  if (error) return { result: "error" };
  return mapSaveResult(data);
}
