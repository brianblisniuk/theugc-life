/**
 * Outreach reads and writes (D184, D182).
 *
 * Reads use the cookie-bound client, so RLS is the row boundary. Writes are
 * service-role RPCs. The user id comes from the session, never the form.
 * Adding a hotel does not create an opportunity. Opening one is explicit.
 */
import "server-only";

import { workspaceLimit } from "@/lib/entitlements/inventory";
import { isUuid } from "@/lib/hotels/ids";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isDisplayRef, mapOpenOpportunity, mapOpportunityDates, mapOutreachWrite } from "./types";
import type { OpenOpportunityResult, OpportunityDatesResult, OutreachWriteResult } from "./types";

export interface OutreachCampaign {
  id: string;
  name: string;
  tripId: string | null;
  tripName: string | null;
  tripStart: string | null;
  tripEnd: string | null;
  destinationId: string | null;
  destinationName: string | null;
}

export interface OutreachHotel {
  id: string;
  hotelId: string;
  hotelName: string;
  source: "trip_shortlist" | "imported" | "manual";
  pipelineItemId: string | null;
}

export interface OutreachOpportunity {
  id: string;
  hotelId: string;
  hotelName: string;
  displayRef: string;
  status: string;
  tripId: string | null;
  stayStart: string | null;
  stayEnd: string | null;
  initiativeId: string | null;
}

type QueryClient = Awaited<ReturnType<typeof createClient>>;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function one<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

async function clientOrInjected(injected?: QueryClient): Promise<QueryClient> {
  return injected ?? (await createClient());
}

async function write(rpc: string, args: Record<string, unknown>): Promise<unknown | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc(rpc, args);
  if (error) return null;
  return data;
}

function dayOrNull(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === "string" && DAY.test(value)) return value;
  return undefined;
}

function mapCampaign(row: Record<string, unknown>): OutreachCampaign | null {
  const trip = one(row.trip as { name?: unknown; start_date?: unknown; end_date?: unknown } | null);
  const destination = one(row.destination as { name?: unknown } | null);
  if (typeof row.id !== "string" || typeof row.name !== "string") return null;
  const tripId = row.trip_id === null ? null : row.trip_id;
  const destinationId = row.destination_id === null ? null : row.destination_id;
  if (
    (tripId !== null && typeof tripId !== "string") ||
    (destinationId !== null && typeof destinationId !== "string")
  ) {
    return null;
  }
  const tripStart = trip ? dayOrNull(trip.start_date) : null;
  const tripEnd = trip ? dayOrNull(trip.end_date) : null;
  if (trip && (tripStart === undefined || tripEnd === undefined)) return null;
  return {
    id: row.id,
    name: row.name,
    tripId: typeof tripId === "string" ? tripId : null,
    tripName: trip && typeof trip.name === "string" ? trip.name : null,
    tripStart: tripStart ?? null,
    tripEnd: tripEnd ?? null,
    destinationId: typeof destinationId === "string" ? destinationId : null,
    destinationName: destination && typeof destination.name === "string" ? destination.name : null,
  };
}

const CAMPAIGN_SELECT =
  "id, name, trip_id, destination_id, trip:trips(name, start_date, end_date), destination:destinations(name)";

export const OUTREACH_CAMPAIGN_CAP = 100;

export function campaignRemainderNotice(total: number, shown: number): string | null {
  if (!Number.isInteger(total) || !Number.isInteger(shown) || total < shown || shown < 0)
    return null;
  const rest = total - shown;
  if (rest === 0) return null;
  return rest === 1
    ? "1 more campaign is not on this page."
    : `${rest} more campaigns are not on this page.`;
}

export async function listCampaigns(
  injected?: QueryClient,
): Promise<
  | { status: "ok"; campaigns: OutreachCampaign[]; total: number; truncated: boolean }
  | { status: "error" }
> {
  try {
    const supabase = await clientOrInjected(injected);
    const counted = await supabase
      .from("outreach_initiatives")
      .select("id", { count: "exact", head: true });
    if (
      counted.error ||
      typeof counted.count !== "number" ||
      !Number.isInteger(counted.count) ||
      counted.count < 0
    ) {
      return { status: "error" };
    }
    const { data, error } = await supabase
      .from("outreach_initiatives")
      .select(CAMPAIGN_SELECT)
      .order("updated_at", { ascending: false })
      .order("id", { ascending: true })
      .limit(OUTREACH_CAMPAIGN_CAP);
    if (error) return { status: "error" };
    const campaigns: OutreachCampaign[] = [];
    for (const row of data ?? []) {
      const campaign = mapCampaign(row as Record<string, unknown>);
      if (!campaign) return { status: "error" };
      campaigns.push(campaign);
    }
    if (counted.count < campaigns.length) return { status: "error" };
    return {
      status: "ok",
      campaigns,
      total: counted.count,
      truncated: counted.count > campaigns.length,
    };
  } catch {
    return { status: "error" };
  }
}

export async function getCampaign(
  initiativeId: string,
  injected?: QueryClient,
): Promise<{ status: "ok"; campaign: OutreachCampaign | null } | { status: "error" }> {
  if (!isUuid(initiativeId)) return { status: "ok", campaign: null };
  try {
    const supabase = await clientOrInjected(injected);
    const { data, error } = await supabase
      .from("outreach_initiatives")
      .select(CAMPAIGN_SELECT)
      .eq("id", initiativeId)
      .maybeSingle();
    if (error) return { status: "error" };
    if (!data) return { status: "ok", campaign: null };
    const campaign = mapCampaign(data as Record<string, unknown>);
    return campaign ? { status: "ok", campaign } : { status: "error" };
  } catch {
    return { status: "error" };
  }
}

export async function listCampaignHotels(
  initiativeId: string,
  injected?: QueryClient,
): Promise<{ status: "ok"; hotels: OutreachHotel[] } | { status: "error" }> {
  if (!isUuid(initiativeId)) return { status: "ok", hotels: [] };
  try {
    const supabase = await clientOrInjected(injected);
    const { data, error } = await supabase
      .from("outreach_initiative_hotels")
      .select("id, hotel_id, source, pipeline_item_id, hotel:hotels(name)")
      .eq("initiative_id", initiativeId)
      .order("created_at", { ascending: true });
    if (error) return { status: "error" };
    const hotels: OutreachHotel[] = [];
    for (const row of data ?? []) {
      const record = row as {
        id?: unknown;
        hotel_id?: unknown;
        source?: unknown;
        pipeline_item_id?: unknown;
        hotel?: { name?: unknown } | { name?: unknown }[];
      };
      const hotel = one(record.hotel);
      const pipelineItemId = record.pipeline_item_id === null ? null : record.pipeline_item_id;
      if (
        typeof record.id !== "string" ||
        typeof record.hotel_id !== "string" ||
        !hotel ||
        typeof hotel.name !== "string" ||
        hotel.name.trim().length === 0 ||
        (record.source !== "trip_shortlist" &&
          record.source !== "imported" &&
          record.source !== "manual") ||
        (pipelineItemId !== null && typeof pipelineItemId !== "string")
      ) {
        return { status: "error" };
      }
      hotels.push({
        id: record.id,
        hotelId: record.hotel_id,
        hotelName: hotel.name,
        source: record.source,
        pipelineItemId: typeof pipelineItemId === "string" ? pipelineItemId : null,
      });
    }
    return { status: "ok", hotels };
  } catch {
    return { status: "error" };
  }
}

export async function listCampaignOpportunities(
  input: { initiativeId: string; hotelIds: string[]; tripId: string | null },
  injected?: QueryClient,
): Promise<{ status: "ok"; opportunities: OutreachOpportunity[] } | { status: "error" }> {
  const hotelIds = input.hotelIds.filter(isUuid);
  if (!isUuid(input.initiativeId) || hotelIds.length === 0) {
    return { status: "ok", opportunities: [] };
  }
  try {
    const supabase = await clientOrInjected(injected);
    const { data, error } = await supabase
      .from("pipeline_items")
      .select(
        "id, hotel_id, display_ref, status, trip_id, stay_start, stay_end, outreach_initiative_id, hotel:hotels(name)",
      )
      .in("hotel_id", hotelIds)
      .order("display_ref", { ascending: true });
    if (error) return { status: "error" };
    const opportunities: OutreachOpportunity[] = [];
    for (const row of data ?? []) {
      const record = row as Record<string, unknown>;
      const hotel = one(record.hotel as { name?: unknown } | { name?: unknown }[] | null);
      const tripId = record.trip_id === null ? null : record.trip_id;
      const initiativeId =
        record.outreach_initiative_id === null ? null : record.outreach_initiative_id;
      const stayStart = dayOrNull(record.stay_start);
      const stayEnd = dayOrNull(record.stay_end);
      const displayRef = record.display_ref;
      if (
        typeof record.id !== "string" ||
        typeof record.hotel_id !== "string" ||
        typeof displayRef !== "string" ||
        !isDisplayRef(displayRef) ||
        typeof record.status !== "string" ||
        (tripId !== null && typeof tripId !== "string") ||
        (initiativeId !== null && typeof initiativeId !== "string") ||
        stayStart === undefined ||
        stayEnd === undefined ||
        !hotel ||
        typeof hotel.name !== "string" ||
        hotel.name.trim().length === 0
      ) {
        return { status: "error" };
      }
      const onCampaign = initiativeId === input.initiativeId;
      const onTrip =
        input.tripId !== null && tripId === input.tripId && hotelIds.includes(record.hotel_id);
      if (!onCampaign && !onTrip) continue;
      opportunities.push({
        id: record.id,
        hotelId: record.hotel_id,
        hotelName: hotel.name,
        displayRef,
        status: record.status,
        tripId: typeof tripId === "string" ? tripId : null,
        stayStart,
        stayEnd,
        initiativeId: typeof initiativeId === "string" ? initiativeId : null,
      });
    }
    return { status: "ok", opportunities };
  } catch {
    return { status: "error" };
  }
}

export async function listDraftHotelIds(
  hotelIds: string[],
  injected?: QueryClient,
): Promise<{ status: "ok"; hotelIds: string[] } | { status: "error" }> {
  const ids = hotelIds.filter(isUuid);
  if (ids.length === 0) return { status: "ok", hotelIds: [] };
  try {
    const supabase = await clientOrInjected(injected);
    const { data, error } = await supabase
      .from("pitch_drafts")
      .select("hotel_id")
      .in("hotel_id", ids);
    if (error) return { status: "error" };
    const found = new Set<string>();
    for (const row of data ?? []) {
      const hotelId = (row as { hotel_id?: unknown }).hotel_id;
      if (typeof hotelId !== "string") return { status: "error" };
      found.add(hotelId);
    }
    return { status: "ok", hotelIds: [...found] };
  } catch {
    return { status: "error" };
  }
}

export async function listTripHotelIds(
  tripId: string,
  injected?: QueryClient,
): Promise<{ status: "ok"; hotelIds: string[] } | { status: "error" }> {
  if (!isUuid(tripId)) return { status: "ok", hotelIds: [] };
  try {
    const supabase = await clientOrInjected(injected);
    const { data, error } = await supabase
      .from("trip_hotels")
      .select("hotel_id")
      .eq("trip_id", tripId);
    if (error) return { status: "error" };
    const hotelIds: string[] = [];
    for (const row of data ?? []) {
      const hotelId = (row as { hotel_id?: unknown }).hotel_id;
      if (typeof hotelId !== "string") return { status: "error" };
      hotelIds.push(hotelId);
    }
    return { status: "ok", hotelIds };
  } catch {
    return { status: "error" };
  }
}

export async function createCampaign(
  userId: string,
  input: { name: string; tripId: string | null; destinationId: string | null },
): Promise<OutreachWriteResult> {
  if (!isUuid(userId)) return { result: "error" };
  if (input.tripId !== null && !isUuid(input.tripId)) return { result: "invalid_input" };
  if (input.destinationId !== null && !isUuid(input.destinationId))
    return { result: "invalid_input" };
  const data = await write("create_outreach_initiative", {
    p_user_id: userId,
    p_name: input.name,
    p_trip_id: input.tripId,
    p_destination_id: input.tripId ? null : input.destinationId,
  });
  if (data === null) return { result: "error" };
  return mapOutreachWrite(data);
}

export async function importShortlist(
  userId: string,
  initiativeId: string,
): Promise<OutreachWriteResult> {
  if (!isUuid(userId) || !isUuid(initiativeId)) return { result: "invalid_input" };
  const data = await write("import_outreach_shortlist", {
    p_user_id: userId,
    p_initiative_id: initiativeId,
  });
  if (data === null) return { result: "error" };
  return mapOutreachWrite(data);
}

export async function addCampaignHotel(
  userId: string,
  initiativeId: string,
  hotelId: string,
): Promise<OutreachWriteResult> {
  if (!isUuid(userId) || !isUuid(initiativeId) || !isUuid(hotelId))
    return { result: "invalid_input" };
  const data = await write("add_outreach_hotel", {
    p_user_id: userId,
    p_initiative_id: initiativeId,
    p_hotel_id: hotelId,
  });
  if (data === null) return { result: "error" };
  return mapOutreachWrite(data);
}

export async function deleteCampaign(
  userId: string,
  initiativeId: string,
): Promise<OutreachWriteResult> {
  if (!isUuid(userId) || !isUuid(initiativeId)) return { result: "invalid_input" };
  const data = await write("delete_outreach_initiative", {
    p_user_id: userId,
    p_initiative_id: initiativeId,
  });
  if (data === null) return { result: "error" };
  return mapOutreachWrite(data);
}

export async function openOpportunity(
  userId: string,
  input: {
    hotelId: string;
    tripId: string | null;
    initiativeId: string | null;
    stayStart: string | null;
    stayEnd: string | null;
  },
): Promise<OpenOpportunityResult> {
  if (!isUuid(userId) || !isUuid(input.hotelId)) return { result: "invalid_input" };
  if (input.tripId !== null && !isUuid(input.tripId)) return { result: "invalid_input" };
  if (input.initiativeId !== null && !isUuid(input.initiativeId))
    return { result: "invalid_input" };
  const data = await write("open_pipeline_opportunity", {
    p_user_id: userId,
    p_hotel_id: input.hotelId,
    p_trip_id: input.tripId,
    p_stay_start: input.stayStart,
    p_stay_end: input.stayEnd,
    p_outreach_initiative_id: input.initiativeId,
    p_free_saved_limit: workspaceLimit("pipeline.save"),
  });
  if (data === null) return { result: "error" };
  return mapOpenOpportunity(data);
}

export async function setOpportunityDates(
  userId: string,
  pipelineItemId: string,
  stayStart: string | null,
  stayEnd: string | null,
): Promise<OpportunityDatesResult> {
  if (!isUuid(userId) || !isUuid(pipelineItemId)) return { result: "invalid_input" };
  const data = await write("set_pipeline_opportunity_dates", {
    p_user_id: userId,
    p_pipeline_item_id: pipelineItemId,
    p_stay_start: stayStart,
    p_stay_end: stayEnd,
  });
  if (data === null) return { result: "error" };
  return mapOpportunityDates(data);
}
