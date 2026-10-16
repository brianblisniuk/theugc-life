/**
 * Sanitized outreach RPC results (D184, D182).
 *
 * The browser receives a result word and ids it already knew how to ask for.
 * SQL text stays on the server.
 */

const OP_REF = /^OP-[1-9][0-9]{3,}$/;

function rowOf(payload: unknown): Record<string, unknown> | null {
  if (!payload || typeof payload !== "object") return null;
  return payload as Record<string, unknown>;
}

function readId(row: Record<string, unknown>, key: string): string | null {
  return typeof row[key] === "string" ? row[key] : null;
}

function readCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

export function isDisplayRef(value: string | null | undefined): value is string {
  return typeof value === "string" && OP_REF.test(value);
}

export type OutreachWriteResult =
  | { result: "created"; initiativeId: string; hotelCount: number }
  | { result: "imported"; initiativeId: string; hotelCount: number }
  | { result: "added"; initiativeId: string }
  | { result: "already_linked"; initiativeId: string }
  | { result: "deleted"; initiativeId: string }
  | { result: "invalid_input" }
  | { result: "not_found" }
  | { result: "no_trip" }
  | { result: "hotel_not_found" }
  | { result: "destination_not_found" }
  | { result: "creator_profile_missing" }
  | { result: "error" };

export function mapOutreachWrite(payload: unknown): OutreachWriteResult {
  const row = rowOf(payload);
  if (!row) return { result: "error" };
  const initiativeId = readId(row, "initiative_id");
  if (row.result === "created" && initiativeId) {
    const hotelCount = readCount(row.hotel_count);
    if (hotelCount === null) return { result: "error" };
    return { result: "created", initiativeId, hotelCount };
  }
  if (row.result === "imported" && initiativeId) {
    const hotelCount = readCount(row.hotel_count);
    if (hotelCount === null) return { result: "error" };
    return { result: "imported", initiativeId, hotelCount };
  }
  if (row.result === "added" && initiativeId) return { result: "added", initiativeId };
  if (row.result === "already_linked" && initiativeId) {
    return { result: "already_linked", initiativeId };
  }
  if (row.result === "deleted" && initiativeId) return { result: "deleted", initiativeId };
  if (row.result === "invalid_input") return { result: "invalid_input" };
  if (row.result === "not_found") return { result: "not_found" };
  if (row.result === "no_trip") return { result: "no_trip" };
  if (row.result === "hotel_not_found") return { result: "hotel_not_found" };
  if (row.result === "destination_not_found") return { result: "destination_not_found" };
  if (row.result === "creator_profile_missing") return { result: "creator_profile_missing" };
  return { result: "error" };
}

export type OpenOpportunityResult =
  | {
      result: "created";
      pipelineItemId: string;
      displayRef: string;
      status: "saved";
    }
  | { result: "already_open"; pipelineItemId: string; displayRef: string }
  | { result: "overlap"; pipelineItemId: string | null }
  | { result: "limit_reached"; limit: number; openCount: number }
  | { result: "hotel_not_found" }
  | { result: "not_found" }
  | { result: "invalid_input" }
  | { result: "creator_profile_missing" }
  | { result: "error" };

export function mapOpenOpportunity(payload: unknown): OpenOpportunityResult {
  const row = rowOf(payload);
  if (!row) return { result: "error" };
  const pipelineItemId = readId(row, "pipeline_item_id");
  const displayRef = readId(row, "display_ref");
  if (row.result === "created" && pipelineItemId && isDisplayRef(displayRef)) {
    return { result: "created", pipelineItemId, displayRef, status: "saved" };
  }
  if (row.result === "already_open" && pipelineItemId && isDisplayRef(displayRef)) {
    return { result: "already_open", pipelineItemId, displayRef };
  }
  if (row.result === "overlap") {
    return { result: "overlap", pipelineItemId };
  }
  if (row.result === "limit_reached") {
    const limit = readCount(row.limit);
    const openCount = readCount(row.open_count);
    if (limit === null || openCount === null) return { result: "error" };
    return { result: "limit_reached", limit, openCount };
  }
  if (row.result === "hotel_not_found") return { result: "hotel_not_found" };
  if (row.result === "not_found") return { result: "not_found" };
  if (row.result === "invalid_input") return { result: "invalid_input" };
  if (row.result === "creator_profile_missing") return { result: "creator_profile_missing" };
  return { result: "error" };
}

export type OpportunityDatesResult =
  | { result: "updated"; pipelineItemId: string }
  | { result: "overlap" }
  | { result: "not_found" }
  | { result: "invalid_input" }
  | { result: "creator_profile_missing" }
  | { result: "error" };

export function mapOpportunityDates(payload: unknown): OpportunityDatesResult {
  const row = rowOf(payload);
  if (!row) return { result: "error" };
  const pipelineItemId = readId(row, "pipeline_item_id");
  if (row.result === "updated" && pipelineItemId) return { result: "updated", pipelineItemId };
  if (row.result === "overlap") return { result: "overlap" };
  if (row.result === "not_found") return { result: "not_found" };
  if (row.result === "invalid_input") return { result: "invalid_input" };
  if (row.result === "creator_profile_missing") return { result: "creator_profile_missing" };
  return { result: "error" };
}
