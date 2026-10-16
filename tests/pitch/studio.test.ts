/**
 * V2-S3 Pitch Studio facts.
 *
 * Dates, recipients, and opportunity choice come from loaded rows. A second
 * opportunity is not absorbed into the first. The draft checklist does not
 * invent a claim the text does not contain.
 */
import { describe, expect, it } from "vitest";

import {
  chooseOpportunity,
  draftScopeNote,
  portfolioLine,
  recipientLine,
  reviewChecks,
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
  it("says a hotel draft is not an opportunity draft when two are open", () => {
    expect(draftScopeNote(2)).toMatch(/not stored on one opportunity/);
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
