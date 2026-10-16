/**
 * Pitch Studio facts (V2-S3).
 *
 * The screen may only say what the caller already loaded. A missing stay is
 * not a trip date. A draft is shown only for the opportunity it is bound to.
 */

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
  choice: "none" | "one" | "many" | "selected" | "missing",
): T | null {
  if (choice === "many" || choice === "missing") return null;
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

export function chooseOpportunity(
  opportunities: readonly StudioOpportunity[],
  requestedId: string | null,
):
  | { choice: "none"; selected: null }
  | { choice: "one"; selected: StudioOpportunity }
  | { choice: "many"; selected: null }
  | { choice: "selected"; selected: StudioOpportunity }
  | { choice: "missing"; selected: null } {
  if (requestedId) {
    const match = opportunities.find((row) => row.id === requestedId) ?? null;
    return match ? { choice: "selected", selected: match } : { choice: "missing", selected: null };
  }
  if (opportunities.length === 1) return { choice: "one", selected: opportunities[0]! };
  if (opportunities.length > 1) return { choice: "many", selected: null };
  return { choice: "none", selected: null };
}
