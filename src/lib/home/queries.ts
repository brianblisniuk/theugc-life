/**
 * Home next-action reads (D112). The cookie-bound client is the boundary
 * for pipeline and deliverable rows. Gmail suggestions come only from
 * list_own_pending_gmail_collaboration_suggestions, which returns paused
 * and no ids for a Free caller (D107). This module does not write.
 */
import "server-only";

import { getOwnCreditBalance } from "@/lib/credits/queries";
import { isUuid } from "@/lib/hotels/ids";
import { resolveOwnProfile } from "@/lib/onboarding/first-run";
import { PROFILE_COLUMNS } from "@/lib/surfaces/lists";
import { createClient } from "@/lib/supabase/server";

import {
  HOME_DELIVERABLE_READ_LIMIT,
  HOME_PIPELINE_READ_LIMIT,
  blockedNextActionBoard,
  parseOwnGmailSuggestions,
  prioritizeNextActions,
  type CreditSource,
  type NextActionBoard,
  type OwnedDeliverable,
  type OwnedPipelineItem,
} from "./next-actions";

type QueryResult = {
  data: unknown;
  error: { message?: string } | null;
};

export type HomeQueryClient = {
  from: (table: string) => {
    select: (columns: string) => HomeQueryChain;
  };
  rpc: (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message?: string } | null }>;
};

type HomeQueryChain = {
  eq: (column: string, value: string) => HomeQueryChain;
  neq: (column: string, value: string) => HomeQueryChain;
  in: (column: string, values: readonly string[]) => HomeQueryChain;
  not: (column: string, operator: string, value: null) => HomeQueryChain;
  order: (
    column: string,
    options?: { ascending?: boolean; nullsFirst?: boolean },
  ) => HomeQueryChain;
  limit: (count: number) => HomeQueryChain;
  maybeSingle: () => Promise<QueryResult>;
  then: PromiseLike<QueryResult>["then"];
};

export const LIST_OWN_GMAIL_SUGGESTIONS_RPC = "list_own_pending_gmail_collaboration_suggestions";

const PIPELINE_COLUMNS =
  "id, creator_id, status, hotel_id, trip_id, next_followup_at, last_activity_at, hotel:hotels(name)";

const DELIVERABLE_COLUMNS =
  "id, creator_id, status, due_on, pipeline_item:pipeline_items(hotel_id, hotel:hotels(name))";

function asRecords(data: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(data)) return null;
  const rows: Record<string, unknown>[] = [];
  for (const row of data) {
    if (!row || typeof row !== "object") return null;
    rows.push(row as Record<string, unknown>);
  }
  return rows;
}

function oneRecord(value: unknown): Record<string, unknown> | null {
  const row = Array.isArray(value) ? value[0] : value;
  if (!row || typeof row !== "object") return null;
  return row as Record<string, unknown>;
}

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : null;
}

async function clientOr(injected?: HomeQueryClient): Promise<HomeQueryClient> {
  if (injected) return injected;
  return (await createClient()) as unknown as HomeQueryClient;
}

function mapPipeline(data: unknown, profileId: string): OwnedPipelineItem[] | null {
  const rows = asRecords(data);
  if (rows === null) return null;
  const items: OwnedPipelineItem[] = [];
  for (const row of rows) {
    if (typeof row.creator_id !== "string" || typeof row.id !== "string") return null;
    if (row.creator_id !== profileId) continue;
    const hotel = oneRecord(row.hotel);
    const name = hotel && typeof hotel.name === "string" ? hotel.name : "";
    const hotelId = typeof row.hotel_id === "string" ? row.hotel_id : "";
    const status = typeof row.status === "string" ? row.status : "";
    const nextFollowupAt = textOrNull(row.next_followup_at);
    const lastActivityAt = textOrNull(row.last_activity_at);
    const tripId = textOrNull(row.trip_id);
    if (row.next_followup_at != null && nextFollowupAt === null) return null;
    if (row.last_activity_at != null && lastActivityAt === null) return null;
    if (row.trip_id != null && tripId === null) return null;
    items.push({
      id: row.id,
      creatorId: row.creator_id,
      status,
      hotelId,
      hotelName: name,
      nextFollowupAt,
      lastActivityAt,
      tripId: tripId && isUuid(tripId) ? tripId : null,
    });
  }
  return items;
}

function mapBounded<T>(
  result: QueryResult,
  limit: number,
  mapRows: (rows: Record<string, unknown>[]) => T[] | null,
): { status: "ok"; items: T[]; capped: boolean } | { status: "error" } {
  if (result.error) return { status: "error" };
  const rows = asRecords(result.data);
  if (rows === null) return { status: "error" };
  const capped = rows.length > limit;
  const items = mapRows(rows.slice(0, limit));
  if (items === null) return { status: "error" };
  return { status: "ok", items, capped };
}

function mapDeliverables(data: unknown, profileId: string): OwnedDeliverable[] | null {
  const rows = asRecords(data);
  if (rows === null) return null;
  const items: OwnedDeliverable[] = [];
  for (const row of rows) {
    if (typeof row.creator_id !== "string" || typeof row.id !== "string") return null;
    if (row.creator_id !== profileId) continue;
    const pipeline = oneRecord(row.pipeline_item);
    const hotel = pipeline ? oneRecord(pipeline.hotel) : null;
    const hotelId = pipeline && typeof pipeline.hotel_id === "string" ? pipeline.hotel_id : "";
    const name = hotel && typeof hotel.name === "string" ? hotel.name : "";
    const status = typeof row.status === "string" ? row.status : "";
    const dueOn = textOrNull(row.due_on);
    if (row.due_on != null && dueOn === null) return null;
    items.push({
      id: row.id,
      creatorId: row.creator_id,
      status,
      hotelId,
      hotelName: name,
      dueOn,
    });
  }
  return items;
}

export async function loadHomeNextActions(
  authUserId: string,
  injected?: { client?: HomeQueryClient; credits?: CreditSource; now?: Date },
): Promise<NextActionBoard> {
  if (!isUuid(authUserId)) return blockedNextActionBoard();
  try {
    const supabase = await clientOr(injected?.client);
    const profileResult = await supabase
      .from("creator_profiles")
      .select(PROFILE_COLUMNS)
      .eq("user_id", authUserId)
      .maybeSingle();
    const profile = resolveOwnProfile(profileResult.data, profileResult.error !== null, authUserId);
    if (profile.status !== "ok") return blockedNextActionBoard();

    const [pipelineResult, deliverableResult, gmailResult, credits] = await Promise.all([
      supabase
        .from("pipeline_items")
        .select(PIPELINE_COLUMNS)
        .eq("creator_id", profile.profileId)
        .neq("status", "closed")
        .order("next_followup_at", { ascending: true, nullsFirst: false })
        .limit(HOME_PIPELINE_READ_LIMIT + 1),
      supabase
        .from("collaboration_deliverables")
        .select(DELIVERABLE_COLUMNS)
        .eq("creator_id", profile.profileId)
        .in("status", ["pending", "rejected"])
        .order("due_on", { ascending: true, nullsFirst: false })
        .limit(HOME_DELIVERABLE_READ_LIMIT + 1),
      supabase.rpc(LIST_OWN_GMAIL_SUGGESTIONS_RPC),
      injected?.credits ? Promise.resolve(injected.credits) : getOwnCreditBalance(),
    ]);

    const pipelineMapped = mapBounded(pipelineResult, HOME_PIPELINE_READ_LIMIT, (rows) =>
      mapPipeline(rows, profile.profileId),
    );
    const deliverableMapped = mapBounded(deliverableResult, HOME_DELIVERABLE_READ_LIMIT, (rows) =>
      mapDeliverables(rows, profile.profileId),
    );
    const gmail = gmailResult.error
      ? { status: "error" as const }
      : parseOwnGmailSuggestions(gmailResult.data, profile.profileId);

    return prioritizeNextActions({
      profileId: profile.profileId,
      asOf: (injected?.now ?? new Date()).toISOString(),
      pipeline: pipelineMapped,
      deliverables: deliverableMapped,
      gmail,
      credits,
    });
  } catch {
    return blockedNextActionBoard();
  }
}
