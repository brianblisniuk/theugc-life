/**
 * Pitch Studio facts (V2-S3).
 *
 * The screen may only say what the caller already loaded. A missing stay is
 * not a trip date. A draft is shown only for the opportunity it is bound to.
 */

import { isUuid } from "@/lib/hotels/ids";
import { isOpenCycle } from "@/lib/pipeline/types";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface StudioOpportunity {
  id: string;
  displayRef: string | null;
  status: string | null;
  stayStart: string | null;
  stayEnd: string | null;
  tripId: string | null;
}

export type TravelWindow =
  | { source: "opportunity"; label: string }
  | { source: "trip"; label: string }
  | { source: "unconfirmed"; label: string };

function day(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !DAY.test(value)) return null;
  return value;
}

export function shownDisplayRef(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !/^OP-[1-9][0-9]{3,}$/.test(value)) return null;
  return value;
}

/**
 * Opportunity dates stay on the opportunity (D183). Trip dates are labeled
 * as the trip. Neither source is invented when both are missing.
 */
export function travelWindow(input: {
  stayStart: string | null;
  stayEnd: string | null;
  tripStart: string | null;
  tripEnd: string | null;
}): TravelWindow {
  const stayStart = day(input.stayStart);
  const stayEnd = day(input.stayEnd);
  if (stayStart && stayEnd && stayEnd > stayStart) {
    return { source: "opportunity", label: `${stayStart} – ${stayEnd}` };
  }
  const tripStart = day(input.tripStart);
  const tripEnd = day(input.tripEnd);
  if (tripStart && tripEnd && tripEnd > tripStart) {
    return { source: "trip", label: `${tripStart} – ${tripEnd}` };
  }
  return { source: "unconfirmed", label: "Not confirmed" };
}

export function recipientLine(input: {
  email: string | null;
  locked: boolean;
  unchecked: boolean;
}): string {
  if (input.unchecked) return "The contact couldn’t be checked. No name is inferred.";
  if (input.email && input.email.includes("@")) return input.email;
  if (input.locked) return "Locked. A name is not inferred.";
  return "No unlocked email on this hotel.";
}

export function portfolioLine(title: string | null | undefined): string {
  const name = title?.trim();
  if (!name) return "No portfolio item on this account.";
  return name;
}

export function draftScopeNote(openOpportunities: number): string | null {
  if (openOpportunities > 1) {
    return "This draft is saved on the opportunity you picked. It does not replace another opportunity for this hotel.";
  }
  return null;
}

/** `opportunity` is the pitch-page id. `item` remains readable for older links. */
export function readOpportunityParam(
  opportunity: string | null | undefined,
  legacyItem: string | null | undefined,
): string | null {
  const named = opportunity?.trim() || legacyItem?.trim() || "";
  return named.length > 0 ? named : null;
}

export function assignOpportunity(params: URLSearchParams, opportunityId: string | null): void {
  if (opportunityId) params.set("opportunity", opportunityId);
  else params.delete("opportunity");
  params.delete("item");
}

export interface BoundDraftRef {
  id: string;
  pipelineItemId: string | null;
}

/**
 * The draft for this screen. A named opportunity never receives another
 * opportunity's row, and an unbound hotel draft is not treated as belonging
 * to one of several open opportunities.
 */
export function selectBoundDraft<T extends BoundDraftRef>(
  drafts: readonly T[],
  opportunityId: string | null,
  choice: "none" | "one" | "many" | "selected" | "missing" | "trip_empty",
): T | null {
  if (choice === "many" || choice === "missing" || choice === "trip_empty") return null;
  if (choice === "selected" || choice === "one") {
    if (!opportunityId) return null;
    return drafts.find((draft) => draft.pipelineItemId === opportunityId) ?? null;
  }
  return drafts.find((draft) => draft.pipelineItemId === null) ?? null;
}

export interface ReviewCheck {
  id: string;
  label: string;
  ok: boolean;
}

/** Checks the draft the creator can see. It does not add claims. */
export function reviewChecks(input: {
  hotelName: string;
  subject: string;
  body: string;
}): ReviewCheck[] {
  const hotel = input.hotelName.trim();
  const text = `${input.subject}\n${input.body}`;
  const named = hotel.length >= 2 && text.toLocaleLowerCase().includes(hotel.toLocaleLowerCase());
  const offer = input.body.trim().length >= 40;
  const next = input.body.includes("?");
  const placeholders = /\[(?:your name|portfolio link)\]/i.test(text);
  return [
    { id: "hotel", label: "Hotel name appears in the draft", ok: named },
    { id: "offer", label: "The draft is long enough to state an offer", ok: offer },
    { id: "next", label: "The draft asks for a next step", ok: next },
    {
      id: "placeholders",
      label: "Placeholders for your name or portfolio are still in the draft",
      ok: !placeholders,
    },
  ];
}

/**
 * The trip a draft may name. With no selected opportunity the requested trip
 * stands. With one, only that opportunity's trip stands — including none.
 */
export function opportunityDraftTrip(
  opportunity: { tripId: string | null } | null,
  requestedTripId: string | null,
): string | null {
  if (!opportunity) return requestedTripId;
  return opportunity.tripId;
}

/**
 * Trip written on save. A selected opportunity rejects a posted trip that is
 * not its own, and stores its own trip (or none) rather than the posted one.
 */
export function pitchTripToStore(input: {
  opportunity: { tripId: string | null } | null;
  requestedTripId: string | null;
  ownedTripId: string | null;
}): { ok: true; tripId: string | null } | { ok: false; message: string } {
  if (!input.opportunity) {
    if (input.requestedTripId && input.ownedTripId !== input.requestedTripId) {
      return { ok: false, message: "Choose one of your trips." };
    }
    return { ok: true, tripId: input.requestedTripId };
  }
  const ownTrip = opportunityDraftTrip(input.opportunity, null);
  if (input.requestedTripId && input.requestedTripId !== ownTrip) {
    return { ok: false, message: "That trip is not this opportunity's trip." };
  }
  if (input.requestedTripId && input.ownedTripId !== input.requestedTripId) {
    return { ok: false, message: "Choose one of your trips." };
  }
  return { ok: true, tripId: ownTrip && input.ownedTripId === ownTrip ? ownTrip : null };
}

/** Open opportunities loaded for one pitch. One extra row means the list is capped. */
export const PITCH_OPPORTUNITY_CAP = 20;

export function takeOpportunityPage<T>(
  rows: readonly T[],
  cap = PITCH_OPPORTUNITY_CAP,
): { rows: T[]; capped: boolean } {
  return { rows: rows.slice(0, cap), capped: rows.length > cap };
}

/** A named row stays on the page even when it was not in the capped list. */
export function mergeNamedOpportunity<T extends { id: string }>(
  page: readonly T[],
  named: T | null,
): T[] {
  if (!named) return [...page];
  if (page.some((row) => row.id === named.id)) return [...page];
  return [...page, named];
}

/**
 * A draft bound to a closed opportunity is still that draft. An open or
 * missing row is not treated as closed.
 */
export function closedRowDraft<T extends { pipelineItemId: string | null }>(
  draft: T | null,
  itemStatus: string | null,
): T | null {
  if (!draft?.pipelineItemId || itemStatus !== "closed") return null;
  return draft;
}

export type OpportunityDraftWrite =
  | { action: "update"; draftId: string }
  | { action: "insert" }
  | { action: "reject" };

/**
 * One current draft per opportunity. The loaded row bound to that opportunity
 * is updated, including when a fresh start or a template posts no draft id.
 * Insert only when this opportunity has no draft. A posted id for a different
 * row is rejected.
 */
export function resolveOpportunityDraftWrite(input: {
  postedDraftId: string | null | undefined;
  loadedDraftId: string | null | undefined;
  loadedOpportunityId: string | null | undefined;
  boundOpportunityId: string | null;
}): OpportunityDraftWrite {
  const posted =
    typeof input.postedDraftId === "string" && input.postedDraftId.length > 0
      ? input.postedDraftId
      : null;
  const loaded =
    typeof input.loadedDraftId === "string" &&
    input.loadedDraftId.length > 0 &&
    input.boundOpportunityId !== null &&
    input.loadedOpportunityId === input.boundOpportunityId
      ? input.loadedDraftId
      : null;
  if (loaded) {
    if (posted && posted !== loaded) return { action: "reject" };
    return { action: "update", draftId: loaded };
  }
  if (posted) return { action: "update", draftId: posted };
  return { action: "insert" };
}

/** AI drafting has no posted id. It updates the loaded bound draft or inserts. */
export function currentDraftWrite(input: {
  draftId: string | null | undefined;
  draftOpportunityId: string | null | undefined;
  boundOpportunityId: string | null;
}): "update" | "insert" {
  const write = resolveOpportunityDraftWrite({
    postedDraftId: null,
    loadedDraftId: input.draftId,
    loadedOpportunityId: input.draftOpportunityId,
    boundOpportunityId: input.boundOpportunityId,
  });
  return write.action === "update" ? "update" : "insert";
}

/**
 * The composer shows the saved draft unless the creator asked to start over.
 * A trip on the URL is context. It does not hide the draft. A fresh start or
 * a template clears the posted id so the visible text is what gets saved.
 * The server still updates the opportunity's existing draft.
 */

export function visiblePitchDraft(input: {
  draft: { id: string; subject: string; body: string } | null;
  fresh: boolean;
  templateRequested: boolean;
  suggestion: { subject: string; body: string };
}): { subject: string; body: string; draftId: string | null } {
  if (input.draft && !input.fresh && !input.templateRequested) {
    return { subject: input.draft.subject, body: input.draft.body, draftId: input.draft.id };
  }
  return { subject: input.suggestion.subject, body: input.suggestion.body, draftId: null };
}

export function chooseOpportunity(
  opportunities: readonly StudioOpportunity[],
  requestedId: string | null,
  originTripId: string | null = null,
):
  | { choice: "none"; selected: null }
  | { choice: "one"; selected: StudioOpportunity }
  | { choice: "many"; selected: null }
  | { choice: "selected"; selected: StudioOpportunity }
  | { choice: "missing"; selected: null }
  | { choice: "trip_empty"; selected: null } {
  if (requestedId) {
    const match = opportunities.find((row) => row.id === requestedId) ?? null;
    return match ? { choice: "selected", selected: match } : { choice: "missing", selected: null };
  }
  if (originTripId && isUuid(originTripId)) {
    const onTrip = opportunities.filter(
      (row) => isOpenCycle(row.status) && row.tripId === originTripId,
    );
    if (onTrip.length === 1) return { choice: "one", selected: onTrip[0]! };
    return { choice: "trip_empty", selected: null };
  }
  if (opportunities.length === 1) return { choice: "one", selected: opportunities[0]! };
  if (opportunities.length > 1) return { choice: "many", selected: null };
  return { choice: "none", selected: null };
}
