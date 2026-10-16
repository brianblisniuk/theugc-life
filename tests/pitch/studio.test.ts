/**
 * V2-S3 Pitch Studio facts.
 *
 * Dates, recipients, and opportunity choice come from loaded rows. A second
 * opportunity is not absorbed into the first. The draft checklist does not
 * invent a claim the text does not contain.
 */
import { describe, expect, it } from "vitest";

import {
  assignOpportunity,
  chooseOpportunity,
  draftScopeNote,
  portfolioLine,
  opportunityDraftTrip,
  pitchTripToStore,
  readOpportunityParam,
  recipientLine,
  reviewChecks,
  selectBoundDraft,
  travelWindow,
  type StudioOpportunity,
} from "@/lib/pitch/studio";

const FIRST: StudioOpportunity = {
  id: "11111111-1111-4111-8111-111111111111",
  displayRef: "OP-1042",
  status: "replied",
  stayStart: "2026-11-12",
  stayEnd: "2026-11-19",
  tripId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};

const SECOND: StudioOpportunity = {
  id: "22222222-2222-4222-8222-222222222222",
  displayRef: "OP-1084",
  status: "planned",
  stayStart: null,
  stayEnd: null,
  tripId: null,
};

describe("opportunity choice", () => {
  it("does not pick one when two are open and the URL names neither", () => {
    const choice = chooseOpportunity([FIRST, SECOND], null);
    expect(choice.choice).toBe("many");
    expect(choice.selected).toBeNull();
  });

  it("uses the named opportunity and refuses a foreign id", () => {
    expect(chooseOpportunity([FIRST, SECOND], SECOND.id).selected?.displayRef).toBe("OP-1084");
    expect(chooseOpportunity([FIRST], "33333333-3333-4333-8333-333333333333").choice).toBe(
      "missing",
    );
  });

  it("binds the only open opportunity", () => {
    expect(chooseOpportunity([FIRST], null)).toEqual({ choice: "one", selected: FIRST });
    expect(chooseOpportunity([], null).choice).toBe("none");
  });
});

describe("opportunity trip", () => {
  const originTrip = "55555555-5555-4555-8555-555555555555";

  it("keeps opportunity B's trip when the request names trip A", () => {
    expect(opportunityDraftTrip(FIRST, originTrip)).toBe(FIRST.tripId);
    expect(
      pitchTripToStore({
        opportunity: FIRST,
        requestedTripId: originTrip,
        ownedTripId: FIRST.tripId,
      }),
    ).toEqual({
      ok: false,
      message: "That trip is not this opportunity's trip.",
    });
    expect(
      pitchTripToStore({
        opportunity: FIRST,
        requestedTripId: null,
        ownedTripId: FIRST.tripId,
      }),
    ).toEqual({ ok: true, tripId: FIRST.tripId });
  });

  it("does not adopt a requested trip onto an opportunity that has none", () => {
    expect(opportunityDraftTrip(SECOND, originTrip)).toBeNull();
    expect(
      pitchTripToStore({
        opportunity: SECOND,
        requestedTripId: originTrip,
        ownedTripId: originTrip,
      }),
    ).toEqual({
      ok: false,
      message: "That trip is not this opportunity's trip.",
    });
    expect(
      pitchTripToStore({
        opportunity: SECOND,
        requestedTripId: null,
        ownedTripId: null,
      }),
    ).toEqual({ ok: true, tripId: null });
  });

  it("still stores a requested trip when no opportunity is selected", () => {
    expect(opportunityDraftTrip(null, originTrip)).toBe(originTrip);
    expect(
      pitchTripToStore({
        opportunity: null,
        requestedTripId: originTrip,
        ownedTripId: originTrip,
      }),
    ).toEqual({ ok: true, tripId: originTrip });
    expect(
      pitchTripToStore({
        opportunity: null,
        requestedTripId: originTrip,
        ownedTripId: null,
      }),
    ).toEqual({ ok: false, message: "Choose one of your trips." });
  });
});

describe("opportunity query", () => {
  it("honors opportunity and still reads the older item param", () => {
    expect(readOpportunityParam(SECOND.id, FIRST.id)).toBe(SECOND.id);
    expect(readOpportunityParam(null, FIRST.id)).toBe(FIRST.id);
    expect(readOpportunityParam("  ", null)).toBeNull();
    const params = new URLSearchParams("item=old&from=pipeline");
    assignOpportunity(params, SECOND.id);
    expect(params.get("opportunity")).toBe(SECOND.id);
    expect(params.get("item")).toBeNull();
    expect(params.get("from")).toBe("pipeline");
  });
});

describe("draft binding", () => {
  const draftA = { id: "draft-a", pipelineItemId: FIRST.id, body: "A text" };
  const draftB = { id: "draft-b", pipelineItemId: SECOND.id, body: "B text" };
  const unbound = { id: "draft-old", pipelineItemId: null, body: "hotel text" };

  it("never shows or selects another opportunity's draft", () => {
    expect(selectBoundDraft([draftB, draftA, unbound], SECOND.id, "selected")).toEqual(draftB);
    expect(selectBoundDraft([draftA, unbound], SECOND.id, "selected")).toBeNull();
    expect(selectBoundDraft([draftA, draftB, unbound], null, "many")).toBeNull();
    expect(selectBoundDraft([unbound, draftA], null, "none")).toEqual(unbound);
    expect(selectBoundDraft([draftA], FIRST.id, "one")).toEqual(draftA);
    expect(selectBoundDraft([draftB], FIRST.id, "one")).toBeNull();
  });
});

describe("travel window", () => {
  it("keeps opportunity dates off the trip and does not invent either", () => {
    expect(
      travelWindow({
        stayStart: "2026-11-12",
        stayEnd: "2026-11-19",
        tripStart: "2026-12-01",
        tripEnd: "2026-12-08",
      }),
    ).toEqual({ source: "opportunity", label: "2026-11-12 – 2026-11-19" });
    expect(
      travelWindow({
        stayStart: null,
        stayEnd: null,
        tripStart: "2026-12-01",
        tripEnd: "2026-12-08",
      }),
    ).toEqual({ source: "trip", label: "2026-12-01 – 2026-12-08" });
    expect(
      travelWindow({ stayStart: null, stayEnd: null, tripStart: null, tripEnd: null }),
    ).toEqual({ source: "unconfirmed", label: "Not confirmed" });
  });
});

describe("recipient and portfolio", () => {
  it("does not invent a decision maker", () => {
    expect(recipientLine({ email: null, locked: true, unchecked: false })).toBe(
      "Locked. A name is not inferred.",
    );
    expect(recipientLine({ email: null, locked: false, unchecked: true })).toBe(
      "The contact couldn’t be checked. No name is inferred.",
    );
    expect(recipientLine({ email: "ada@hotel.test", locked: false, unchecked: false })).toBe(
      "ada@hotel.test",
    );
    expect(portfolioLine(null)).toBe("No portfolio item on this account.");
    expect(portfolioLine("  ")).toBe("No portfolio item on this account.");
    expect(portfolioLine("River film")).toBe("River film");
  });
});

describe("draft scope and review", () => {
  it("says a picked opportunity keeps its own draft", () => {
    expect(draftScopeNote(2)).toMatch(/does not replace another opportunity/);
    expect(draftScopeNote(1)).toBeNull();
  });

  it("checks the text that is actually there", () => {
    const checks = reviewChecks({
      hotelName: "Siam Canopy House",
      subject: "Hello",
      body: "A short note.",
    });
    expect(checks.find((check) => check.id === "hotel")?.ok).toBe(false);
    expect(checks.find((check) => check.id === "next")?.ok).toBe(false);
    const ready = reviewChecks({
      hotelName: "Siam Canopy House",
      subject: "Siam Canopy House",
      body: "I can share a short film for Siam Canopy House. Would your partnerships team review it? [Your name]",
    });
    expect(ready.find((check) => check.id === "hotel")?.ok).toBe(true);
    expect(ready.find((check) => check.id === "next")?.ok).toBe(true);
    expect(ready.find((check) => check.id === "placeholders")?.ok).toBe(false);
  });
});
