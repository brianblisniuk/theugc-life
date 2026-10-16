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

import { resolveSession, type SessionResolution } from "@/lib/auth/guards";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { isUuid } from "@/lib/hotels/ids";
import { workspaceLimit } from "@/lib/entitlements/inventory";
import type { BillingAccessResult } from "@/lib/billing/queries";
import type { IntelligenceSignal } from "@/lib/hotels/intelligence";
import { rankOwnedHotels } from "@/lib/metrics/pipeline-rank";
import type { MetricId } from "@/lib/metrics/contract";

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
  /** Unlocked contact for this caller. Absent until the pipeline page attaches it. */
  contactEmail?: string | null;
  /** Most urgent deliverable deadline on this cycle. Absent when the read failed or none apply. */
  deadlineLabel?: string | null;
  /** Per-creator display id. Null when the row did not include a well-formed value. */
  displayRef: string | null;
  stayStart: string | null;
  stayEnd: string | null;
  tripName: string | null;
  hotel: {
    id: string;
    name: string;
    destinationName: string | null;
    countryCode: string | null;
  } | null;
  /** Set only on a one-metric order. Absent on the activity order. */
  metricRank?: number;
  metricValue?: string;
  metricSample?: string | null;
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

/** One page of the creator's pipeline. 50 keeps the page useful without paging forever. */
export const PIPELINE_PAGE_SIZE = 50;

export interface PipelinePage {
  items: PipelineListItem[];
  /** Exact number of matching rows in the database, NOT the number on this page. */
  total: number;
  /** 1-based, already clamped to a page that exists. */
  page: number;
  pageSize: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
}

/**
 * Tri-state for the same reason every other read here is: a failed count or a
 * failed page read must never be rendered as "you have no hotels".
 */
export type PipelineListResult =
  | { status: "ok"; page: PipelinePage }
  | { status: "locked"; metric: MetricId }
  | { status: "not_enough_data"; metric: MetricId }
  | { status: "error" };

/** Above this, a metric order fails closed instead of ranking a truncated CRM. */
export const PIPELINE_RANK_CAP = 2000;

export interface PipelineRankAuth {
  session: SessionResolution;
  billing?: BillingAccessResult;
}

const RANK_SELECT =
  "id, status, display_ref, stay_start, stay_end, saved_at, last_activity_at, next_followup_at, trip:trips(name), hotel:hotels(id, name, country_code, destination_id, destination:destinations(id, name))";

const SELECT_COLUMNS =
  "id, status, display_ref, stay_start, stay_end, saved_at, last_activity_at, next_followup_at, trip:trips(name), hotel:hotels(id, name, country_code, destination:destinations(name))";

/**
 * Normalize a `?page=` value. Anything that is not a positive whole number —
 * missing, negative, zero, fractional, alphabetic, absurdly large — means page
 * one. A malformed URL is never an error state and never an empty pipeline.
 */
export function normalizePageParam(raw: string | string[] | undefined | null): number {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return 1;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return 1;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1) return 1;
  return parsed;
}

function oneRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) {
    const first = value[0];
    return first && typeof first === "object" ? (first as Record<string, unknown>) : null;
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function mapPipelineRow(raw: unknown): PipelineListItem & { destinationId: string | null } {
  const row = raw as Record<string, unknown>;
  const hotel = oneRecord(row.hotel);
  const dest = oneRecord(hotel?.destination);
  const trip = oneRecord(row.trip);
  const destinationId =
    typeof hotel?.destination_id === "string"
      ? hotel.destination_id
      : typeof dest?.id === "string"
        ? dest.id
        : null;
  const displayRef = typeof row.display_ref === "string" ? row.display_ref : null;
  return {
    id: String(row.id),
    status: row.status as PipelineStatus,
    displayRef,
    stayStart: typeof row.stay_start === "string" ? row.stay_start : null,
    stayEnd: typeof row.stay_end === "string" ? row.stay_end : null,
    tripName: typeof trip?.name === "string" ? trip.name : null,
    savedAt: (row.saved_at as string | null) ?? null,
    lastActivityAt: (row.last_activity_at as string | null) ?? null,
    nextFollowupAt: (row.next_followup_at as string | null) ?? null,
    destinationId,
    hotel: hotel
      ? {
          id: String(hotel.id),
          name: String(hotel.name),
          destinationName: (dest?.name as string | null) ?? null,
          countryCode: (hotel.country_code as string | null) ?? null,
        }
      : null,
  };
}

async function listRankedPipelineItems(
  supabase: PipelineQueryClient,
  status: string | null | undefined,
  requestedPage: number,
  rank: MetricId,
  rankAuth: PipelineRankAuth | undefined,
): Promise<PipelineListResult> {
  const pageSize = PIPELINE_PAGE_SIZE;
  let countBuilder = supabase.from("pipeline_items").select("id", { count: "exact", head: true });
  if (status) countBuilder = countBuilder.eq("status", status);
  const { count, error: countError } = await countBuilder;
  if (countError || count === null || count === undefined) return { status: "error" };
  if (count === 0) {
    return {
      status: "ok",
      page: {
        items: [],
        total: 0,
        page: 1,
        pageSize,
        totalPages: 1,
        hasPrevious: false,
        hasNext: false,
      },
    };
  }
  if (count > PIPELINE_RANK_CAP) return { status: "error" };

  let builder = supabase.from("pipeline_items").select(RANK_SELECT);
  if (status) builder = builder.eq("status", status);
  const { data, error } = await builder.order("id", { ascending: true }).range(0, count - 1);
  if (error) return { status: "error" };

  const mapped = (data ?? []).map((raw) => mapPipelineRow(raw));
  const auth = rankAuth ?? { session: await resolveSession() };
  const ranked = await rankOwnedHotels(
    supabase as never,
    rank,
    mapped.flatMap((item) =>
      item.hotel ? [{ hotelId: item.hotel.id, destinationId: item.destinationId }] : [],
    ),
    auth,
  );
  if (ranked.status === "locked") return { status: "locked", metric: rank };
  if (ranked.status === "not_enough_data") return { status: "not_enough_data", metric: rank };
  if (ranked.status !== "ok") return { status: "error" };

  const byHotel = new Map(ranked.hotels.map((hotel) => [hotel.hotelId, hotel]));
  const ordered = mapped
    .filter((item) => item.hotel && byHotel.has(item.hotel.id))
    .sort((a, b) => {
      const left = byHotel.get(a.hotel!.id)!;
      const right = byHotel.get(b.hotel!.id)!;
      if (left.rank !== right.rank) return left.rank - right.rank;
      if (a.hotel!.id !== b.hotel!.id) return a.hotel!.id < b.hotel!.id ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })
    .map((item) => {
      const signal = byHotel.get(item.hotel!.id)!;
      const { destinationId: _destinationId, ...rest } = item;
      return {
        ...rest,
        metricRank: signal.rank,
        metricValue: signal.valueLabel,
        metricSample: signal.sampleBasis,
      };
    });

  const total = ordered.length;
  if (total === 0) return { status: "not_enough_data", metric: rank };
  const totalPages = Math.ceil(total / pageSize);
  const page = Math.min(Math.max(1, Math.trunc(requestedPage) || 1), totalPages);
  const from = (page - 1) * pageSize;
  return {
    status: "ok",
    page: {
      items: ordered.slice(from, from + pageSize),
      total,
      page,
      pageSize,
      totalPages,
      hasPrevious: page > 1,
      hasNext: page < totalPages,
    },
  };
}

/**
 * One page of the creator's relationships, most recent activity first.
 *
 * The count is taken from the database rather than from the returned array, so
 * the page can state how many relationships the creator actually has instead of
 * how many happen to be on screen. The previous implementation capped the query
 * at 200 rows with no count and reported `items.length` as the total, which
 * silently understated any pipeline larger than that.
 *
 * Reads stay on the cookie-bound client so `pipeline_items_all` keeps enforcing
 * ownership. Paginating is not a reason to reach for service_role.
 */
export async function listPipelineItems(
  status?: string | null,
  requestedPage = 1,
  /** Injectable for tests; production always uses the cookie-bound client. */
  injectedClient?: PipelineQueryClient,
  rank: MetricId | null = null,
  rankAuth?: PipelineRankAuth,
): Promise<PipelineListResult> {
  const supabase = injectedClient ?? (await createClient());
  const pageSize = PIPELINE_PAGE_SIZE;
  if (rank) {
    return listRankedPipelineItems(supabase, status, requestedPage, rank, rankAuth);
  }

  // Exact count first, so an out-of-range page can be resolved deterministically
  // instead of being guessed from an empty result set.
  let countBuilder = supabase.from("pipeline_items").select("id", { count: "exact", head: true });
  if (status) countBuilder = countBuilder.eq("status", status);
  const { count, error: countError } = await countBuilder;

  // A count we could not take is an error. Reporting it as zero would assert
  // something false about the creator's own data.
  if (countError || count === null || count === undefined) return { status: "error" };

  const total = count;
  const totalPages = total === 0 ? 1 : Math.ceil(total / pageSize);
  // Clamp rather than 404: a stale bookmark past the end lands on the last real
  // page, and is never described as an empty pipeline.
  const page = Math.min(Math.max(1, Math.trunc(requestedPage) || 1), totalPages);
  const from = (page - 1) * pageSize;

  let builder = supabase.from("pipeline_items").select(SELECT_COLUMNS);
  if (status) builder = builder.eq("status", status);

  const { data, error } = await builder
    .order("last_activity_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, from + pageSize - 1);

  if (error) return { status: "error" };

  const items = (data ?? []).map((raw) => {
    const { destinationId: _destinationId, ...item } = mapPipelineRow(raw);
    return item;
  });

  return {
    status: "ok",
    page: {
      items,
      total,
      page,
      pageSize,
      totalPages,
      hasPrevious: page > 1,
      hasNext: page < totalPages,
    },
  };
}

/** Exact per-status counts. A failed count is an error, not a zero. */
export async function countPipelineStatuses(
  injectedClient?: PipelineQueryClient,
): Promise<{ status: "ok"; counts: Record<PipelineStatus, number> } | { status: "error" }> {
  const supabase = injectedClient ?? (await createClient());
  const counts = {} as Record<PipelineStatus, number>;
  for (const status of [
    "saved",
    "planned",
    "pitched",
    "replied",
    "follow_up",
    "negotiating",
    "won",
    "closed",
  ] as const) {
    const { count, error } = await supabase
      .from("pipeline_items")
      .select("id", { count: "exact", head: true })
      .eq("status", status);
    if (error || count === null || count === undefined) return { status: "error" };
    counts[status] = count;
  }
  return { status: "ok", counts };
}

/** Open opportunities for the attention list. One extra row means the read is capped. */
export const PIPELINE_ATTENTION_READ = 80;

export async function listOpenPipelineForAttention(
  injectedClient?: PipelineQueryClient,
): Promise<{ status: "ok"; items: PipelineListItem[]; capped: boolean } | { status: "error" }> {
  const supabase = injectedClient ?? (await createClient());
  const { data, error } = await supabase
    .from("pipeline_items")
    .select(SELECT_COLUMNS)
    .neq("status", "closed")
    .order("last_activity_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(PIPELINE_ATTENTION_READ + 1);
  if (error) return { status: "error" };
  const rows = data ?? [];
  const capped = rows.length > PIPELINE_ATTENTION_READ;
  return {
    status: "ok",
    capped,
    items: rows.slice(0, PIPELINE_ATTENTION_READ).map((raw) => {
      const { destinationId: _destinationId, ...item } = mapPipelineRow(raw);
      return item;
    }),
  };
}

/**
 * Public intelligence for the hotels on this page. One failed query is
 * unavailable for every card, not "insufficient data".
 */
export async function listPublicIntelligence(
  hotelIds: readonly string[],
  injectedClient?: PipelineQueryClient,
): Promise<{ status: "ok"; byHotel: Map<string, IntelligenceSignal> } | { status: "error" }> {
  const ids = [...new Set(hotelIds.filter((id) => isUuid(id)))];
  if (ids.length === 0) return { status: "ok", byHotel: new Map() };
  const supabase = injectedClient ?? (await createClient());
  const { data, error } = await supabase
    .from("hotel_public_intelligence")
    .select("hotel_id, activity_level, confidence_level, has_observed_collaboration, recency_band")
    .in("hotel_id", ids);
  if (error) return { status: "error" };
  const byHotel = new Map<string, IntelligenceSignal>();
  for (const raw of data ?? []) {
    const row = raw as Record<string, unknown>;
    if (typeof row.hotel_id !== "string") continue;
    byHotel.set(row.hotel_id, {
      activityLevel: typeof row.activity_level === "string" ? row.activity_level : null,
      confidenceLevel: typeof row.confidence_level === "string" ? row.confidence_level : null,
      hasObservedCollaboration:
        typeof row.has_observed_collaboration === "boolean" ? row.has_observed_collaboration : null,
      recencyBand: typeof row.recency_band === "string" ? row.recency_band : null,
    });
  }
  return { status: "ok", byHotel };
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
    p_free_saved_limit: workspaceLimit("pipeline.save"),
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
    p_free_engaged_limit: workspaceLimit("pipeline.engage"),
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
