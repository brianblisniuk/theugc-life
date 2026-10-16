/**
 * Hotel Detail opportunity history (D182, D187).
 * One hotel can hold several opportunities. Each card is its own record.
 * Display ids that fail the OP- shape are omitted. They are not invented.
 */
import { isUuid } from "@/lib/hotels/ids";
import {
  isOpenCycle,
  pipelineStageLabel,
  pipelineStatusLabel,
  type PipelineStatus,
} from "@/lib/pipeline/types";
import { hotelHref, pitchHref, type HotelOrigin } from "@/lib/shell/navigation";

export type OpportunityRelationship =
  | { status: "open"; relationship: { pipelineItemId: string; status: PipelineStatus } }
  | { status: "none" }
  | { status: "error" };

const DISPLAY_REF = /^OP-[1-9][0-9]{3,}$/;

export interface HotelOpportunity {
  id: string;
  displayRef: string | null;
  status: string;
  stayStart: string | null;
  stayEnd: string | null;
  tripId: string | null;
  tripName: string | null;
}

export interface OpportunityCardModel {
  id: string;
  title: string;
  stage: string;
  tone: "green" | "blue" | "amber" | "gray";
  body: string;
  href: string;
  action: string;
}

export function isDisplayRef(value: string | null | undefined): value is string {
  return typeof value === "string" && DISPLAY_REF.test(value);
}

export function opportunityTitle(row: HotelOpportunity): string {
  const parts = [
    isDisplayRef(row.displayRef) ? row.displayRef : null,
    row.tripName?.trim() || (row.tripId ? "Linked trip" : "No trip"),
  ];
  if (row.stayStart && row.stayEnd) parts.push(`${row.stayStart} – ${row.stayEnd}`);
  return parts.filter(Boolean).join(" · ");
}

function toneFor(status: string): OpportunityCardModel["tone"] {
  if (status === "replied" || status === "won") return "green";
  if (status === "planned") return "blue";
  if (status === "negotiating" || status === "follow_up") return "amber";
  return "gray";
}

function withQuery(href: string, params: Record<string, string | null>): string {
  const hashIndex = href.indexOf("#");
  const hash = hashIndex >= 0 ? href.slice(hashIndex) : "";
  const withoutHash = hashIndex >= 0 ? href.slice(0, hashIndex) : href;
  const url = new URL(withoutHash, "http://local");
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  return `${url.pathname}${url.search}${hash}`;
}

export function opportunityCard(
  row: HotelOpportunity,
  hotelId: string,
  back: string | null,
  origin: HotelOrigin = { kind: "discover" },
): OpportunityCardModel | null {
  if (!isUuid(row.id) || !isUuid(hotelId)) return null;
  const stage = pipelineStageLabel(row.status) ?? pipelineStatusLabel(row.status);
  const tripId = origin.kind === "trip" ? origin.tripId : row.tripId;
  const pitch = pitchHref(hotelId, tripId, origin, row.id);
  const inbox = hotelHref(hotelId, { kind: "inbox" }, "inbox");
  const collaboration = hotelHref(hotelId, { kind: "collaboration" }, "collaboration");
  const self = `/app/hotels/${hotelId}`;
  let href = self;
  let action = "Open opportunity";
  if (row.status === "planned" && pitch) {
    href = pitch;
    action = "Review draft";
  } else if ((row.status === "saved" || row.status === "pitched") && pitch) {
    href = pitch;
    action = "Open Pitch Studio";
  } else if (
    (row.status === "replied" || row.status === "negotiating" || row.status === "follow_up") &&
    inbox
  ) {
    href = inbox;
    action = "Continue conversation";
  } else if (row.status === "won" && collaboration) {
    href = collaboration;
    action = "Open collaboration";
  }
  return {
    id: row.id,
    title: opportunityTitle(row),
    stage,
    tone: toneFor(row.status),
    body:
      row.status === "closed"
        ? "This opportunity is closed. It does not change another open opportunity."
        : "This opportunity keeps its own stage. It does not overwrite another one.",
    href: withQuery(href, { opportunity: row.id, back }),
    action,
  };
}

export function opportunityCards(
  rows: readonly HotelOpportunity[],
  hotelId: string,
  back: string | null,
  origin: HotelOrigin = { kind: "discover" },
): OpportunityCardModel[] {
  return rows.flatMap((row) => {
    const card = opportunityCard(row, hotelId, back, origin);
    return card ? [card] : [];
  });
}

export function pickHotelOpportunity(
  rows: readonly HotelOpportunity[],
  requestedId: string | null,
): HotelOpportunity | null {
  if (requestedId && isUuid(requestedId)) {
    const match = rows.find((row) => row.id === requestedId);
    if (match) return match;
  }
  return rows.find((row) => isOpenCycle(row.status)) ?? null;
}

export function relationshipFromOpportunities(
  load: { status: "ok"; opportunities: readonly HotelOpportunity[] } | { status: "error" },
  selected: HotelOpportunity | null,
): OpportunityRelationship {
  if (load.status === "error") return { status: "error" };
  const open = load.opportunities.filter((row) => isOpenCycle(row.status));
  const chosen = selected && isOpenCycle(selected.status) ? selected : (open[0] ?? null);
  if (!chosen) return { status: "none" };
  return {
    status: "open",
    relationship: {
      pipelineItemId: chosen.id,
      status: chosen.status as PipelineStatus,
    },
  };
}
