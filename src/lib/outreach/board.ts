/**
 * Outreach board rules (D184, D187, D182).
 *
 * Counts come from rows the caller already loaded. A missing campaign is not
 * zero hotels. A campaign with hotels and no recorded pitch is a real zero.
 * The share of hotels with a recorded pitch is omitted when there are no
 * hotels, so the screen does not print 0% in place of an empty campaign.
 */

import { pipelineStageLabel, pipelineStatusLabel } from "@/lib/pipeline/types";

export const OUTREACH_FOCUSES = ["all", "pitch", "follow_up", "conversation"] as const;
export type OutreachFocus = (typeof OUTREACH_FOCUSES)[number];

export function parseOutreachFocus(value: string | null | undefined): OutreachFocus {
  if (value === "pitch" || value === "follow_up" || value === "conversation") return value;
  return "all";
}

const LOGGED = new Set(["pitched", "follow_up", "replied", "negotiating", "won"]);
const REPLIED = new Set(["replied", "negotiating", "won"]);

export function isLoggedOutreach(status: string | null): boolean {
  return status !== null && LOGGED.has(status);
}

export function isReportedReply(status: string | null): boolean {
  return status !== null && REPLIED.has(status);
}

export interface BoardRow {
  hotelId: string;
  status: string | null;
  hasDraft: boolean;
}

export function rowMatchesFocus(row: BoardRow, focus: OutreachFocus): boolean {
  if (focus === "all") return true;
  if (focus === "pitch") {
    return row.status === null || row.status === "saved" || row.status === "planned";
  }
  if (focus === "follow_up") return row.status === "pitched" || row.status === "follow_up";
  return row.status === "replied" || row.status === "negotiating";
}

export interface OutreachCounts {
  selectedHotels: number;
  draftsPrepared: number;
  outreachLogged: number;
  repliesReported: number;
  /** Hotels with at least one recorded pitch, reply, or agreement. */
  hotelsLogged: number;
}

export function countOutreach(
  hotels: readonly { hotelId: string }[],
  opportunities: readonly { hotelId: string; status: string }[],
  draftHotelIds: ReadonlySet<string>,
): OutreachCounts {
  const selected = new Set(hotels.map((hotel) => hotel.hotelId));
  let draftsPrepared = 0;
  for (const hotelId of selected) {
    if (draftHotelIds.has(hotelId)) draftsPrepared += 1;
  }
  const loggedHotels = new Set<string>();
  let outreachLogged = 0;
  let repliesReported = 0;
  for (const opportunity of opportunities) {
    if (!selected.has(opportunity.hotelId)) continue;
    if (isLoggedOutreach(opportunity.status)) {
      outreachLogged += 1;
      loggedHotels.add(opportunity.hotelId);
    }
    if (isReportedReply(opportunity.status)) repliesReported += 1;
  }
  return {
    selectedHotels: selected.size,
    draftsPrepared,
    outreachLogged,
    repliesReported,
    hotelsLogged: loggedHotels.size,
  };
}

/** Null when there is no hotel to divide by. Never a stand-in zero. */
export function loggedHotelShare(counts: OutreachCounts): number | null {
  if (counts.selectedHotels <= 0) return null;
  return Math.round((counts.hotelsLogged / counts.selectedHotels) * 1000) / 10;
}

export function formatShare(share: number): string {
  return Number.isInteger(share) ? String(share) : share.toFixed(1);
}

const NEXT_RANK = ["replied", "negotiating", "follow_up", "pitched", "planned", "saved", "won"];

export interface NextMoveInput {
  hotelId: string;
  hotelName: string;
  displayRef: string | null;
  status: string;
  pipelineItemId: string;
}

export interface NextMove {
  hotelId: string;
  hotelName: string;
  displayRef: string | null;
  status: string;
  pipelineItemId: string;
  sentence: string;
}

const NEXT_SENTENCE: Record<string, string> = {
  replied: "Open the conversation.",
  negotiating: "Continue the negotiation.",
  follow_up: "Review the follow-up.",
  pitched: "Review the follow-up.",
  planned: "Review the pitch.",
  saved: "Write the first pitch.",
  won: "Open the collaboration.",
};

/**
 * One real opportunity, in a fixed order. The sentence names the stage.
 * It does not invent a request the hotel did not record.
 */
export function nextOutreachMove(rows: readonly NextMoveInput[]): NextMove | null {
  const ranked = rows
    .filter((row) => NEXT_RANK.includes(row.status))
    .map((row) => ({ row, rank: NEXT_RANK.indexOf(row.status) }))
    .sort(
      (a, b) => a.rank - b.rank || a.row.displayRef?.localeCompare(b.row.displayRef ?? "") || 0,
    );
  const chosen = ranked[0]?.row;
  if (!chosen) return null;
  return {
    ...chosen,
    sentence: NEXT_SENTENCE[chosen.status] ?? "Open the opportunity.",
  };
}

export function stageWord(status: string | null): string {
  if (!status) return "Not opened";
  return pipelineStageLabel(status) ?? pipelineStatusLabel(status);
}

export function nextActionLabel(status: string | null, hasDraft: boolean): string {
  if (!status) return "Open an opportunity";
  if (status === "saved" && hasDraft) return "Review the saved pitch";
  if (status === "saved") return "Write the first pitch";
  if (status === "planned") return "Review the pitch";
  if (status === "pitched" || status === "follow_up") return "Review the follow-up";
  if (status === "replied") return "Open the conversation";
  if (status === "negotiating") return "Continue the negotiation";
  if (status === "won") return "Open the collaboration";
  if (status === "closed") return "Closed";
  return "Open the opportunity";
}

export type StageTone = "green" | "amber" | "blue" | "gray" | "lime";

export function stageTone(status: string | null): StageTone {
  if (status === "replied" || status === "won") return "green";
  if (status === "negotiating" || status === "follow_up") return "amber";
  if (status === "pitched") return "blue";
  if (status === "planned") return "blue";
  return "gray";
}
