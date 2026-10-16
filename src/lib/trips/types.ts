/**
 * Trip vocabulary and sanitized RPC results (PRD §7.5, §9.13).
 *
 * Framework-free. Identity, entitlement and the Free allowance are not types
 * a caller can supply — they are not fields here.
 */

/** `trips.status` (migration 0005). */
export const TRIP_STATUSES = ["planning", "upcoming", "active", "completed", "cancelled"] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

/**
 * Statuses that consume FREE_LIMITS.activeTrips. Terminal statuses are history
 * (the trip-status reading of D023). Enforced in migration 0046, not here.
 */
export const COUNTING_TRIP_STATUSES = ["planning", "upcoming", "active"] as const;

const STATUS_LABEL: Record<TripStatus, string> = {
  planning: "Planning",
  upcoming: "Upcoming",
  active: "Active",
  completed: "Completed",
  cancelled: "Cancelled",
};

export function tripStatusLabel(status: string | null): string {
  if (status && status in STATUS_LABEL) return STATUS_LABEL[status as TripStatus];
  return "Planning";
}

/** Technical bound shared with the SQL RPCs. Not a commercial limit. */
export const TRIP_NAME_MAX = 120;

export type TripWriteResult =
  | { result: "created"; tripId: string }
  | { result: "updated"; tripId: string }
  | { result: "deleted" }
  | { result: "limit_reached"; limit: number; activeCount: number }
  | { result: "invalid_input" }
  | { result: "destination_not_found" }
  | { result: "creator_profile_missing" }
  | { result: "not_found" }
  | { result: "error" };

export type ShortlistResult =
  | { result: "added"; tripId: string }
  | { result: "already_shortlisted"; tripId: string }
  | { result: "removed"; tripId: string }
  | { result: "hotel_not_found" }
  | { result: "not_found" }
  | { result: "invalid_input" }
  | { result: "creator_profile_missing" }
  | { result: "error" };

export type LinkResult =
  | { result: "linked"; pipelineItemId: string; tripId: string }
  | { result: "unlinked"; pipelineItemId: string }
  | { result: "not_found" }
  | { result: "invalid_input" }
  | { result: "creator_profile_missing" }
  | { result: "error" };

/**
 * One workspace figure. `null` is unknown — the trip has no linked pipeline
 * rows — and must not be rendered as zero.
 */
export interface TripMetrics {
  targetHotels: number | null;
  pitched: number | null;
  replies: number | null;
  negotiations: number | null;
  confirmedCollaborations: number | null;
  followupsDue: number | null;
}

export type TripSummaryResult =
  { status: "ok"; metrics: TripMetrics } | { status: "not_found" } | { status: "error" };

function isTripStatus(value: string): value is TripStatus {
  return (TRIP_STATUSES as readonly string[]).includes(value);
}

function readId(row: Record<string, unknown>, key: string): string | null {
  return typeof row[key] === "string" ? row[key] : null;
}

function readCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

export function mapTripWriteResult(payload: unknown): TripWriteResult {
  if (!payload || typeof payload !== "object") return { result: "error" };
  const row = payload as Record<string, unknown>;
  const result = row.result;
  const tripId = readId(row, "trip_id");

  if (result === "created" && tripId) return { result: "created", tripId };
  if (result === "updated" && tripId) return { result: "updated", tripId };
  if (result === "deleted") return { result: "deleted" };
  if (result === "limit_reached") {
    const limit = readCount(row.limit);
    const activeCount = readCount(row.active_count);
    if (limit === null || activeCount === null) return { result: "error" };
    return { result: "limit_reached", limit, activeCount };
  }
  if (result === "invalid_input") return { result: "invalid_input" };
  if (result === "destination_not_found") return { result: "destination_not_found" };
  if (result === "creator_profile_missing") return { result: "creator_profile_missing" };
  if (result === "not_found") return { result: "not_found" };
  return { result: "error" };
}

export function mapShortlistResult(payload: unknown): ShortlistResult {
  if (!payload || typeof payload !== "object") return { result: "error" };
  const row = payload as Record<string, unknown>;
  const tripId = readId(row, "trip_id");
  switch (row.result) {
    case "added":
      return tripId ? { result: "added", tripId } : { result: "error" };
    case "already_shortlisted":
      return tripId ? { result: "already_shortlisted", tripId } : { result: "error" };
    case "removed":
      return tripId ? { result: "removed", tripId } : { result: "error" };
    case "hotel_not_found":
      return { result: "hotel_not_found" };
    case "not_found":
      return { result: "not_found" };
    case "invalid_input":
      return { result: "invalid_input" };
    case "creator_profile_missing":
      return { result: "creator_profile_missing" };
    default:
      return { result: "error" };
  }
}

export function mapLinkResult(payload: unknown): LinkResult {
  if (!payload || typeof payload !== "object") return { result: "error" };
  const row = payload as Record<string, unknown>;
  const pipelineItemId = readId(row, "pipeline_item_id");
  const tripId = readId(row, "trip_id");
  if (row.result === "linked" && pipelineItemId && tripId) {
    return { result: "linked", pipelineItemId, tripId };
  }
  if (row.result === "unlinked" && pipelineItemId) {
    return { result: "unlinked", pipelineItemId };
  }
  if (row.result === "not_found") return { result: "not_found" };
  if (row.result === "invalid_input") return { result: "invalid_input" };
  if (row.result === "creator_profile_missing") return { result: "creator_profile_missing" };
  return { result: "error" };
}

/**
 * Map the summary RPC. A missing metric, or a metric that is not an integer
 * and not null, is an error — never coerced to zero.
 */
export function mapTripSummary(payload: unknown): TripSummaryResult {
  if (!payload || typeof payload !== "object") return { status: "error" };
  const row = payload as Record<string, unknown>;
  if (row.result === "not_found") return { status: "not_found" };
  if (row.result !== "ok") return { status: "error" };

  const keys = [
    "target_hotels",
    "pitched",
    "replies",
    "negotiations",
    "confirmed_collaborations",
    "followups_due",
  ] as const;

  const metrics: Array<number | null> = [];
  for (const key of keys) {
    const value = row[key];
    if (value === null) {
      metrics.push(null);
      continue;
    }
    const count = readCount(value);
    if (count === null) return { status: "error" };
    metrics.push(count);
  }

  return {
    status: "ok",
    metrics: {
      targetHotels: metrics[0]!,
      pitched: metrics[1]!,
      replies: metrics[2]!,
      negotiations: metrics[3]!,
      confirmedCollaborations: metrics[4]!,
      followupsDue: metrics[5]!,
    },
  };
}

export type NightCoverageRead =
  | {
      status: "ok";
      tripNights: number;
      confirmedNights: number;
      pendingNights: number;
      gapNights: number;
    }
  | { status: "not_found" }
  | { status: "error" };

export function mapNightCoverage(payload: unknown): NightCoverageRead {
  if (!payload || typeof payload !== "object") return { status: "error" };
  const row = payload as Record<string, unknown>;
  if (row.result === "not_found") return { status: "not_found" };
  if (row.result !== "ok") return { status: "error" };
  const tripNights = readCount(row.trip_nights);
  const confirmedNights = readCount(row.confirmed_nights);
  const pendingNights = readCount(row.pending_nights);
  const gapNights = readCount(row.gap_nights);
  if (
    tripNights === null ||
    confirmedNights === null ||
    pendingNights === null ||
    gapNights === null
  ) {
    return { status: "error" };
  }
  if (confirmedNights + pendingNights + gapNights !== tripNights) return { status: "error" };
  return { status: "ok", tripNights, confirmedNights, pendingNights, gapNights };
}

export type StayWriteResult =
  | { result: "updated"; tripHotelId: string; nightStatus: "pending" | "confirmed" }
  | { result: "invalid_input" }
  | { result: "not_found" }
  | { result: "creator_profile_missing" }
  | { result: "error" };

export function mapStayWriteResult(payload: unknown): StayWriteResult {
  if (!payload || typeof payload !== "object") return { result: "error" };
  const row = payload as Record<string, unknown>;
  if (row.result === "updated") {
    const tripHotelId = readId(row, "trip_hotel_id");
    const nightStatus = row.night_status === "confirmed" ? "confirmed" : null;
    const pending = row.night_status === "pending" ? "pending" : nightStatus;
    if (!tripHotelId || !pending) return { result: "error" };
    return { result: "updated", tripHotelId, nightStatus: pending };
  }
  if (row.result === "invalid_input") return { result: "invalid_input" };
  if (row.result === "not_found") return { result: "not_found" };
  if (row.result === "creator_profile_missing") return { result: "creator_profile_missing" };
  return { result: "error" };
}

export type SuggestionDecision =
  | { result: "accepted"; suggestionId: string; nightStatus: "pending" | "confirmed" | null }
  | { result: "rejected"; suggestionId: string }
  | { result: "overlap" }
  | { result: "not_pending" }
  | { result: "not_found" }
  | { result: "invalid_input" }
  | { result: "creator_profile_missing" }
  | { result: "error" };

export function mapSuggestionDecision(payload: unknown): SuggestionDecision {
  if (!payload || typeof payload !== "object") return { result: "error" };
  const row = payload as Record<string, unknown>;
  const suggestionId = readId(row, "suggestion_id");
  if (row.result === "accepted" && suggestionId) {
    const nightStatus =
      row.night_status === "pending" || row.night_status === "confirmed" ? row.night_status : null;
    return { result: "accepted", suggestionId, nightStatus };
  }
  if (row.result === "rejected" && suggestionId) return { result: "rejected", suggestionId };
  if (row.result === "overlap") return { result: "overlap" };
  if (row.result === "not_pending") return { result: "not_pending" };
  if (row.result === "not_found") return { result: "not_found" };
  if (row.result === "invalid_input") return { result: "invalid_input" };
  if (row.result === "creator_profile_missing") return { result: "creator_profile_missing" };
  return { result: "error" };
}

export function isTripStatusValue(value: string): value is TripStatus {
  return isTripStatus(value);
}
