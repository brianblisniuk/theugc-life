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

import {
  DEAL_ACTIONS,
  WORKFLOW_ACTIONS,
  mapDealResult,
  mapSaveResult,
  mapTransitionResult,
  type PipelineStatus,
  COLLABORATION_ACTIONS,
  mapCollaborationResult,
  type CollaborationAction,
  type CollaborationResult,
  type DealAction,
  type DealResult,
  type SaveResult,
  type TransitionResult,
  type WorkflowAction,
} from "./types";

export type PipelineQueryClient = Awaited<ReturnType<typeof createClient>>;

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
 * Tri-state on purpose: "we could not check" is NOT "there is no relationship".
 * Collapsing the two would let a transport failure invite the creator to save a
 * hotel they have already saved.
 */
export type OpenRelationshipResult =
  { status: "open"; relationship: HotelRelationship } | { status: "none" } | { status: "error" };

/**
 * The current OPEN relationship for this hotel. Reads under the caller's RLS,
 * so it can only ever see the caller's own rows.
 *
 * An invalid id is a genuine "no relationship" (no such hotel row can match);
 * a query/transport failure is reported as `error` and left for the UI to
 * render as a recoverable problem.
 */
export async function getOpenRelationship(
  hotelId: string,
  /** Injectable for tests; production always uses the cookie-bound client. */
  injectedClient?: PipelineQueryClient,
): Promise<OpenRelationshipResult> {
  if (!isUuid(hotelId)) return { status: "none" };
  const supabase = injectedClient ?? (await createClient());
  const { data, error } = await supabase
    .from("pipeline_items")
    .select("id, status")
    .eq("hotel_id", hotelId)
    .neq("status", "closed")
    .maybeSingle();

  if (error) return { status: "error" };
  if (!data) return { status: "none" };

  const row = data as { id: string; status: string };
  return {
    status: "open",
    relationship: { pipelineItemId: row.id, status: row.status as PipelineStatus },
  };
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

/** The user-supplied half of a transition request. Identity is NOT in here. */
export interface TransitionInput {
  pipelineItemId: string;
  action: WorkflowAction;
  eventAt?: string | null;
  channel?: string | null;
  sentiment?: string | null;
  offerType?: string | null;
  closeReason?: string | null;
}

/**
 * Transactionally transition a relationship through the outreach workflow.
 *
 * `userId` MUST come from the server-side session — never from a form field.
 * The Free engaged allowance is passed from typed server config, so the value
 * has a single source of truth and the client cannot influence it.
 *
 * Every validation here is a convenience, not the boundary: the RPC re-derives
 * identity, re-checks the transition, and re-resolves entitlements itself.
 */
export async function transitionPipelineItem(
  userId: string,
  input: TransitionInput,
): Promise<TransitionResult> {
  if (!isUuid(userId) || !isUuid(input.pipelineItemId)) return { result: "invalid_input" };
  if (!(WORKFLOW_ACTIONS as readonly string[]).includes(input.action)) {
    return { result: "invalid_input" };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("transition_pipeline_item", {
    p_user_id: userId,
    p_pipeline_item_id: input.pipelineItemId,
    p_action: input.action,
    p_event_at: input.eventAt ?? null,
    p_channel: input.channel ?? null,
    p_sentiment: input.sentiment ?? null,
    p_offer_type: input.offerType ?? null,
    p_close_reason: input.closeReason ?? null,
    p_free_engaged_limit: FREE_LIMITS.activePipelineItems,
  });

  // Never surface a raw Postgres/PostgREST error to the browser.
  if (error) return { result: "error" };
  return mapTransitionResult(data);
}

/** The creator's collaboration for one relationship cycle. */
export interface CycleCollaboration {
  id: string;
  status: string;
  collaborationType: string | null;
  agreedAt: string | null;
  startDate: string | null;
  endDate: string | null;
}

/**
 * Tri-state, for the same reason `getOpenRelationship` is: "we could not read
 * it" is NOT "there is no collaboration". On a `won` cycle those two answers
 * mean very different things — one is a temporary glitch, the other is a
 * contradiction worth surfacing.
 */
export type CollaborationLoad =
  { status: "found"; collaboration: CycleCollaboration } | { status: "none" } | { status: "error" };

/**
 * The collaboration attached to a relationship cycle. Reads under the caller's
 * RLS (`collaborations_all`), so it can only ever see the caller's own rows.
 * Financial columns are deliberately not selected — Sprint 2D shows none.
 */
export async function getCycleCollaboration(
  pipelineItemId: string,
  /** Injectable for tests; production always uses the cookie-bound client. */
  injectedClient?: PipelineQueryClient,
): Promise<CollaborationLoad> {
  if (!isUuid(pipelineItemId)) return { status: "none" };
  const supabase = injectedClient ?? (await createClient());
  const { data, error } = await supabase
    .from("collaborations")
    // Financial columns are deliberately never selected — Sprint 2F shows none.
    .select("id, status, collaboration_type, agreed_at, start_date, end_date")
    .eq("pipeline_item_id", pipelineItemId)
    .maybeSingle();

  if (error) return { status: "error" };
  if (!data) return { status: "none" };

  const row = data as unknown as Record<string, unknown>;
  return {
    status: "found",
    collaboration: {
      id: String(row.id),
      status: String(row.status),
      collaborationType: (row.collaboration_type as string | null) ?? null,
      agreedAt: (row.agreed_at as string | null) ?? null,
      startDate: (row.start_date as string | null) ?? null,
      endDate: (row.end_date as string | null) ?? null,
    },
  };
}

/** The user-supplied half of a deal request. Identity is NOT in here. */
export interface DealInput {
  pipelineItemId: string;
  action: DealAction;
  agreedAt?: string | null;
  collaborationType?: string | null;
}

/**
 * Progress a relationship along the deal path: replied → negotiating → won.
 *
 * `userId` MUST come from the server-side session. The RPC re-derives the
 * creator, re-checks the transition, and writes the collaboration and its
 * `deal_won` event in the same transaction as the status change.
 */
export async function progressPipelineDeal(userId: string, input: DealInput): Promise<DealResult> {
  if (!isUuid(userId) || !isUuid(input.pipelineItemId)) return { result: "invalid_input" };
  if (!(DEAL_ACTIONS as readonly string[]).includes(input.action)) {
    return { result: "invalid_input" };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("progress_pipeline_deal", {
    p_user_id: userId,
    p_pipeline_item_id: input.pipelineItemId,
    p_action: input.action,
    p_agreed_at: input.agreedAt ?? null,
    p_collaboration_type: input.collaborationType ?? null,
  });

  // Never surface a raw Postgres/PostgREST error to the browser.
  if (error) return { result: "error" };
  return mapDealResult(data);
}

/**
 * Best-effort refresh of the derived intelligence behind a pipeline item.
 *
 * The hotel is resolved INSIDE the database from the item that was just
 * mutated — a browser-supplied hotel id is never used, so a valid workflow
 * action cannot be turned into a request to recompute an arbitrary hotel.
 *
 * This never throws and never reports failure to the caller as an error: raw
 * event truth has already been committed, and a stale aggregate heals on the
 * next successful mutation or a full rebuild.
 */
export async function refreshIntelligenceForPipelineItem(
  pipelineItemId: string,
  /** Injectable for tests; production always uses the service-role client. */
  injectedAdmin?: {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ error: unknown }>;
  },
): Promise<boolean> {
  if (!isUuid(pipelineItemId)) return false;
  try {
    const admin = injectedAdmin ?? createAdminClient();
    const { error } = await admin.rpc("recompute_hotel_intelligence_for_pipeline_item", {
      p_pipeline_item_id: pipelineItemId,
    });
    return !error;
  } catch {
    return false;
  }
}

/** The user-supplied half of a lifecycle request. Identity is NOT in here. */
export interface CollaborationInput {
  pipelineItemId: string;
  action: CollaborationAction;
  eventAt?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  termsMatched?: string | null;
  wouldWorkAgain?: boolean | null;
  cancelReason?: string | null;
}

/**
 * Move a collaboration through its lifecycle (D045).
 *
 * `userId` MUST come from the server-side session. The RPC re-derives the
 * creator, resolves the pipeline item and its collaboration itself, and closes
 * the pipeline cycle in the same transaction when the collaboration reaches a
 * terminal state — no collaboration id or hotel id is ever accepted here.
 */
export async function progressCollaboration(
  userId: string,
  input: CollaborationInput,
): Promise<CollaborationResult> {
  if (!isUuid(userId) || !isUuid(input.pipelineItemId)) return { result: "invalid_input" };
  if (!(COLLABORATION_ACTIONS as readonly string[]).includes(input.action)) {
    return { result: "invalid_input" };
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("progress_collaboration", {
    p_user_id: userId,
    p_pipeline_item_id: input.pipelineItemId,
    p_action: input.action,
    p_event_at: input.eventAt ?? null,
    p_start_date: input.startDate ?? null,
    p_end_date: input.endDate ?? null,
    p_terms_matched: input.termsMatched ?? null,
    p_would_work_again: input.wouldWorkAgain ?? null,
    p_cancel_reason: input.cancelReason ?? null,
  });

  // Never surface a raw Postgres/PostgREST error to the browser.
  if (error) return { result: "error" };
  return mapCollaborationResult(data);
}
