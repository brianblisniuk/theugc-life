/**
 * Home checklist reads (D095). The cookie-bound client is the boundary.
 * A row whose owner is not the session does not complete a step, and a
 * failed read is not "not done".
 */
import "server-only";

import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/hotels/ids";

import {
  ownedExistence,
  resolveOwnProfile,
  type FirstRunFacts,
  type Probe,
} from "./first-run";
import { PROFILE_COLUMNS } from "@/lib/surfaces/lists";

type QueryResult = {
  data: unknown;
  error: { message?: string } | null;
  count?: number | null;
};

export type OwnedQueryClient = {
  from: (table: string) => {
    select: (columns: string, options?: { count?: "exact"; head?: boolean }) => QueryChain;
  };
};

type QueryChain = {
  eq: (column: string, value: string) => QueryChain;
  not: (column: string, operator: string, value: null) => QueryChain;
  order: (column: string, options: { ascending: boolean }) => QueryChain;
  limit: (count: number) => QueryChain;
  maybeSingle: () => Promise<QueryResult>;
  then: PromiseLike<QueryResult>["then"];
};

export type FollowUpHotel = { name: string; hotelId: string };

export type HomeProgress = {
  displayName: string | null;
  destinationName: string | null;
  destinationSlug: string | null;
  facts: FirstRunFacts;
  followUpHotel: FollowUpHotel | null;
};

function asRecords(data: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(data)) return null;
  const rows: Record<string, unknown>[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") return null;
    rows.push(row as Record<string, unknown>);
  }
  return rows;
}

function mapOwners(result: QueryResult, profileId: string): Probe {
  const rows = asRecords(result.data);
  if (result.error !== null || rows === null) return ownedExistence(null, true, profileId);
  const mapped = [];
  for (const row of rows) {
    if (typeof row.creator_id !== "string") return ownedExistence(null, true, profileId);
    mapped.push({ creatorId: row.creator_id });
  }
  return ownedExistence(mapped, false, profileId);
}

function blocked(displayName: string | null = null): HomeProgress {
  return {
    displayName,
    destinationName: null,
    destinationSlug: null,
    followUpHotel: null,
    facts: {
      destination: "error",
      saved: "error",
      pitch: "error",
      followUp: "error",
      dismissed: false,
    },
  };
}

function destinationFields(row: Record<string, unknown>): { name: string | null; slug: string | null } {
  const nested = row.destination;
  if (!nested || typeof nested !== "object") return { name: null, slug: null };
  const record = nested as { name?: unknown; slug?: unknown };
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : null;
  const slug = typeof record.slug === "string" && record.slug.trim() ? record.slug.trim() : null;
  return { name, slug };
}

function mapDestination(
  result: QueryResult,
  profileId: string,
): { probe: Probe; dismissed: boolean; name: string | null; slug: string | null } {
  const rows = asRecords(result.data);
  if (result.error !== null || rows === null) {
    return { probe: "error", dismissed: false, name: null, slug: null };
  }
  const own = rows.filter((row) => row.creator_id === profileId);
  if (own.length === 0) return { probe: "no", dismissed: false, name: null, slug: null };
  const row = own[0]!;
  if (!("destination_id" in row) || !("checklist_dismissed_at" in row)) {
    return { probe: "error", dismissed: false, name: null, slug: null };
  }
  const dismissed = row.checklist_dismissed_at != null;
  const destinationId = row.destination_id;
  const fields = destinationFields(row);
  if (destinationId == null) return { probe: "no", dismissed, name: null, slug: null };
  if (typeof destinationId !== "string" || !isUuid(destinationId)) {
    return { probe: "error", dismissed: false, name: null, slug: null };
  }
  return { probe: "yes", dismissed, name: fields.name, slug: fields.slug };
}

function mapPitch(notes: QueryResult, events: QueryResult, profileId: string): Probe {
  const noteRows = asRecords(notes.data);
  const eventRows = asRecords(events.data);
  if (notes.error !== null || events.error !== null || noteRows === null || eventRows === null) {
    return "error";
  }
  for (const row of noteRows) {
    if (typeof row.creator_id !== "string") return "error";
    if (row.creator_id !== profileId) continue;
    if (typeof row.private_notes === "string" && row.private_notes.trim().length > 0) return "yes";
  }
  for (const row of eventRows) {
    if (typeof row.creator_id !== "string") return "error";
    if (row.creator_id === profileId && row.event_type === "pitch_sent" && row.source === "manual_creator") {
      return "yes";
    }
  }
  return "no";
}

function mapFollowUp(
  result: QueryResult,
  profileId: string,
): { probe: Probe; hotel: FollowUpHotel | null } {
  const rows = asRecords(result.data);
  if (result.error !== null || rows === null) return { probe: "error", hotel: null };
  for (const row of rows) {
    if (typeof row.creator_id !== "string" || typeof row.hotel_id !== "string") {
      return { probe: "error", hotel: null };
    }
    if (row.creator_id !== profileId || !isUuid(row.hotel_id)) continue;
    const nested = row.hotel;
    const name =
      nested && typeof nested === "object" && typeof (nested as { name?: unknown }).name === "string"
        ? (nested as { name: string }).name.trim()
        : "";
    if (!name) return { probe: "error", hotel: null };
    return { probe: "yes", hotel: { name, hotelId: row.hotel_id } };
  }
  return { probe: "no", hotel: null };
}

async function clientOr(injected?: OwnedQueryClient): Promise<OwnedQueryClient> {
  if (injected) return injected;
  return (await createClient()) as unknown as OwnedQueryClient;
}

export async function loadHomeProgress(
  authUserId: string,
  injected?: { client?: OwnedQueryClient },
): Promise<HomeProgress> {
  if (!isUuid(authUserId)) return blocked();
  try {
    const supabase = await clientOr(injected?.client);
    const profileResult = await supabase
      .from("creator_profiles")
      .select(PROFILE_COLUMNS)
      .eq("user_id", authUserId)
      .maybeSingle();
    const profile = resolveOwnProfile(profileResult.data, profileResult.error !== null, authUserId);
    if (profile.status !== "ok") return blocked();

    const [destination, saved, notes, events, followUps] = await Promise.all([
      supabase
        .from("creator_onboarding_state")
        .select(
          "creator_id, destination_id, checklist_dismissed_at, destination:destinations(name, slug)",
        )
        .eq("creator_id", profile.profileId)
        .limit(1),
      supabase
        .from("pipeline_items")
        .select("id, creator_id")
        .eq("creator_id", profile.profileId)
        .limit(1),
      supabase
        .from("pipeline_items")
        .select("id, creator_id, private_notes")
        .eq("creator_id", profile.profileId)
        .limit(20),
      supabase
        .from("outreach_events")
        .select("id, creator_id, event_type, source")
        .eq("creator_id", profile.profileId)
        .eq("event_type", "pitch_sent")
        .limit(5),
      supabase
        .from("pipeline_items")
        .select("id, creator_id, hotel_id, next_followup_at, hotel:hotels(name)")
        .eq("creator_id", profile.profileId)
        .not("next_followup_at", "is", null)
        .limit(1),
    ]);

    const destinationState = mapDestination(destination, profile.profileId);
    const followUp = mapFollowUp(followUps, profile.profileId);
    return {
      displayName: profile.displayName,
      destinationName: destinationState.name,
      destinationSlug: destinationState.slug,
      followUpHotel: followUp.hotel,
      facts: {
        destination: destinationState.probe,
        saved: mapOwners(saved, profile.profileId),
        pitch: mapPitch(notes, events, profile.profileId),
        followUp: followUp.probe,
        dismissed: destinationState.dismissed,
      },
    };
  } catch {
    return blocked();
  }
}
