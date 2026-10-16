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
import { hotelHref, pitchHref, withOpportunityQuery, type HotelOrigin } from "@/lib/shell/navigation";

export type OpportunityRelationship =
  | { status: "open"; relationship: { pipelineItemId: string; status: PipelineStatus } }
  | { status: "none" }
  | { status: "not_open" }
  | { status: "error" };

export type HotelOpportunitySelection =
  | { status: "open"; row: HotelOpportunity }
  | { status: "not_open" }
  | { status: "none" };

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

/**
 * A trip origin is how the creator arrived. pitchHref writes that origin's id
 * into `trip` and ignores a separate trip argument, so a row must not reuse
 * the page trip. The row's own trip becomes the origin, or discover when the
 * row has none.
 */
function rowPitchOrigin(origin: HotelOrigin, tripId: string | null): HotelOrigin {
  if (origin.kind !== "trip") return origin;
  return tripId ? { kind: "trip", tripId } : { kind: "discover" };
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
  const tripId = row.tripId && isUuid(row.tripId) ? row.tripId : null;
  const pitch = pitchHref(hotelId, tripId, rowPitchOrigin(origin, tripId), row.id);
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

/**
 * Next-step pitch for the open opportunity. The trip is that row's trip, or
 * absent when the row has none. The page origin never supplies it.
 */
export function nextStepPitchHref(
  hotelId: string,
  origin: HotelOrigin,
  openRow: { id: string; tripId: string | null } | null,
): string | null {
  if (!openRow) {
    return pitchHref(hotelId, origin.kind === "trip" ? origin.tripId : null, origin, null);
  }
  const tripId = openRow.tripId && isUuid(openRow.tripId) ? openRow.tripId : null;
  return pitchHref(hotelId, tripId, rowPitchOrigin(origin, tripId), openRow.id);
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

/**
 * The URL's opportunity is that row, or not open. Another row is not a
 * substitute. A trip origin with no named row uses the open row on that trip.
 * Several matches, or none while another row is open, leave the workflow empty.
 */
export function selectHotelOpportunity(
  rows: readonly HotelOpportunity[],
  requestedId: string | null | undefined,
  originTripId: string | null,
): HotelOpportunitySelection {
  const named = typeof requestedId === "string" ? requestedId.trim() : "";
  if (named) {
    if (!isUuid(named)) return { status: "not_open" };
    const match = rows.find((row) => row.id === named) ?? null;
    if (!match || !isOpenCycle(match.status)) return { status: "not_open" };
    return { status: "open", row: match };
  }
  const open = rows.filter((row) => isOpenCycle(row.status));
  if (originTripId && isUuid(originTripId)) {
    const matches = open.filter((row) => row.tripId === originTripId);
    if (matches.length === 1) return { status: "open", row: matches[0]! };
    if (open.length === 0) return { status: "none" };
    return { status: "not_open" };
  }
  const first = open[0] ?? null;
  return first ? { status: "open", row: first } : { status: "none" };
}

export function relationshipFromSelection(
  selection: HotelOpportunitySelection,
): OpportunityRelationship {
  if (selection.status === "open") {
    return {
      status: "open",
      relationship: {
        pipelineItemId: selection.row.id,
        status: selection.row.status as PipelineStatus,
      },
    };
  }
  if (selection.status === "not_open") return { status: "not_open" };
  return { status: "none" };
}

export function relationshipFromOpportunities(
  load: { status: "ok"; opportunities: readonly HotelOpportunity[] } | { status: "error" },
  selected: HotelOpportunity | null,
): OpportunityRelationship {
  if (load.status === "error") return { status: "error" };
  if (selected && !isOpenCycle(selected.status)) return { status: "not_open" };
  if (selected) {
    return {
      status: "open",
      relationship: {
        pipelineItemId: selected.id,
        status: selected.status as PipelineStatus,
      },
    };
  }
  return relationshipFromSelection(selectHotelOpportunity(load.opportunities, null, null));
}

/** Trip shortlist Pitch. The link names the row and that row's trip. */
export function shortlistPitchHref(
  hotelId: string,
  tripId: string,
  rows: readonly { id: string; status: string; tripId: string | null }[],
): string | null {
  if (!isUuid(hotelId) || !isUuid(tripId)) return null;
  const open = rows.filter((row) => isOpenCycle(row.status) && isUuid(row.id));
  const onTrip = open.filter((row) => row.tripId === tripId);
  const target = onTrip.length === 1 ? onTrip[0]! : open.length === 1 ? open[0]! : null;
  if (!target) return pitchHref(hotelId, tripId, { kind: "trip", tripId }, null);
  const rowTrip = target.tripId && isUuid(target.tripId) ? target.tripId : null;
  const origin: HotelOrigin = rowTrip ? { kind: "trip", tripId: rowTrip } : { kind: "discover" };
  return pitchHref(hotelId, rowTrip, origin, target.id);
}

/** Outreach Prepare. A campaign trip is not substituted for the row's trip. */
export function outreachPrepareHref(
  hotelId: string,
  status: string,
  pipelineItemId: string | null,
  tripId: string | null,
): string | null {
  const rowId = pipelineItemId && isUuid(pipelineItemId) ? pipelineItemId : null;
  const rowTrip = tripId && isUuid(tripId) ? tripId : null;
  if (status === "replied" || status === "negotiating") {
    const href = hotelHref(hotelId, { kind: "inbox" }, "inbox");
    return href ? withOpportunityQuery(href, rowId, rowTrip) : null;
  }
  if (status === "won") {
    const href = hotelHref(hotelId, { kind: "collaboration" }, "collaboration");
    return href ? withOpportunityQuery(href, rowId, rowTrip) : null;
  }
  if (status === "saved" || status === "planned" || !status) {
    const origin: HotelOrigin = rowTrip
      ? { kind: "trip", tripId: rowTrip }
      : rowId
        ? { kind: "pipeline" }
        : { kind: "discover" };
    return pitchHref(hotelId, rowTrip, origin, rowId);
  }
  const href = hotelHref(hotelId, { kind: "pipeline" }, "work");
  return href ? withOpportunityQuery(href, rowId, rowTrip) : null;
}
