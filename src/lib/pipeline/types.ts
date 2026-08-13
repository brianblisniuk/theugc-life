/**
 * Pipeline domain types + pure display helpers (PRD §7.4, DECISIONS D023/D042).
 *
 * Framework-free so status labelling and result mapping are unit-testable
 * without a database or a React renderer.
 */

/** `pipeline_items.status` vocabulary (migration 0005 CHECK constraint). */
export const PIPELINE_STATUSES = [
  "saved",
  "planned",
  "pitched",
  "replied",
  "follow_up",
  "negotiating",
  "won",
  "closed",
] as const;
export type PipelineStatus = (typeof PIPELINE_STATUSES)[number];

/**
 * Statuses that count as an ENGAGED CRM relationship (D042). `saved` is a
 * passive relationship and is deliberately excluded. Sprint 2B does not yet
 * enforce the engaged limit — transitions land in a later sprint.
 */
export const ENGAGED_STATUSES = [
  "planned",
  "pitched",
  "replied",
  "follow_up",
  "negotiating",
  "won",
] as const;

/** Human-readable labels (DESIGN_SYSTEM.md §5). */
const STATUS_LABEL: Record<string, string> = {
  saved: "Saved",
  planned: "Planned",
  pitched: "Pitched",
  replied: "Replied",
  follow_up: "Follow-up",
  negotiating: "Negotiating",
  won: "Won",
  closed: "Closed",
};

export function pipelineStatusLabel(status: string | null): string {
  if (!status) return "Saved";
  return STATUS_LABEL[status] ?? status.replace(/_/g, " ");
}

/** A cycle is open (D023) in every status except `closed`. */
export function isOpenCycle(status: string | null): boolean {
  return status !== null && status !== "closed";
}

/** Sanitized outcomes of a save attempt — never a raw Postgres error. */
export type SaveResult =
  | { result: "created"; pipelineItemId: string; status: PipelineStatus }
  | { result: "already_saved"; pipelineItemId: string; status: PipelineStatus }
  | { result: "limit_reached"; limit: number; openCount: number }
  | { result: "hotel_not_found" }
  | { result: "creator_profile_missing" }
  | { result: "error" };

/** True when the attempt left the hotel in the creator's pipeline. */
export function isSaveSuccessful(result: SaveResult): boolean {
  return result.result === "created" || result.result === "already_saved";
}

/**
 * Map the RPC's JSON payload to a typed, sanitized result. Anything
 * unrecognized becomes `error` — the browser never receives SQL detail.
 */
export function mapSaveResult(payload: unknown): SaveResult {
  if (!payload || typeof payload !== "object") return { result: "error" };
  const row = payload as Record<string, unknown>;
  const id = typeof row.pipeline_item_id === "string" ? row.pipeline_item_id : null;
  const status = typeof row.status === "string" ? (row.status as PipelineStatus) : "saved";

  switch (row.result) {
    case "created":
      return id ? { result: "created", pipelineItemId: id, status } : { result: "error" };
    case "already_saved":
      return id ? { result: "already_saved", pipelineItemId: id, status } : { result: "error" };
    case "limit_reached":
      return {
        result: "limit_reached",
        limit: Number(row.limit ?? 0),
        openCount: Number(row.open_count ?? 0),
      };
    case "hotel_not_found":
      return { result: "hotel_not_found" };
    case "creator_profile_missing":
      return { result: "creator_profile_missing" };
    default:
      return { result: "error" };
  }
}

/** User-facing message for a save outcome. Never leaks internal detail. */
export function saveResultMessage(result: SaveResult): string {
  switch (result.result) {
    case "created":
      return "Saved to your pipeline.";
    case "already_saved":
      return "This hotel is already in your pipeline.";
    case "limit_reached":
      return "You’ve reached the Free saved-hotel limit.";
    case "hotel_not_found":
      return "That hotel is no longer available.";
    case "creator_profile_missing":
      return "We couldn’t find your creator profile. Please reload and try again.";
    default:
      return "We couldn’t save this hotel just now. Please try again.";
  }
}
