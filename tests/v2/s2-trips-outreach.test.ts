/**
 * V2-S2 trips and outreach.
 *
 * Night marks follow D183. Counts are omitted when there is nothing to divide.
 * Screens do not ship the design's sample hotels. Reads stay on the caller
 * client. Claude, Hunter, and Gmail are not called from these modules.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  countOutreach,
  loggedHotelShare,
  nextOutreachMove,
  parseOutreachFocus,
  rowMatchesFocus,
} from "@/lib/outreach/board";
import { isDisplayRef, mapOpenOpportunity, mapOutreachWrite } from "@/lib/outreach/types";
import {
  MOBILE_NAV,
  PRIMARY_NAV,
  activeSidebarHref,
  shellCrumbs,
  shellHeading,
} from "@/lib/shell/navigation";
import { mapNightCoverage, mapSuggestionDecision } from "@/lib/trips/types";
import { coverNights, nightCountsMatch, selectFeaturedTrip } from "@/lib/trips/nights";

function source(path: string): string {
  return readFileSync(path, "utf8");
}

const NOVEMBER = [
  { checkIn: "2026-11-12", checkOut: "2026-11-15", nightStatus: "confirmed" as const },
  { checkIn: "2026-11-14", checkOut: "2026-11-17", nightStatus: "pending" as const },
];

describe("trip nights", () => {
  it("counts 12–14 confirmed, 15–16 pending, and 17–18 as a gap", () => {
    const calendar = coverNights("2026-11-12", "2026-11-19", NOVEMBER);
    expect(calendar).toMatchObject({
      tripNights: 7,
      confirmedNights: 3,
      pendingNights: 2,
      gapNights: 2,
    });
    expect(calendar.nights.map((night) => [night.day, night.mark])).toEqual([
      [12, "confirmed"],
      [13, "confirmed"],
      [14, "confirmed"],
      [15, "pending"],
      [16, "pending"],
      [17, "gap"],
      [18, "gap"],
    ]);
    expect(
      nightCountsMatch(calendar, {
        tripNights: 7,
        confirmedNights: 3,
        pendingNights: 2,
        gapNights: 2,
      }),
    ).toBe(true);
    expect(nightCountsMatch(calendar, { ...calendar, confirmedNights: 4 })).toBe(false);
  });

  it("counts an overlapping night once and does not let pending replace confirmed", () => {
    const calendar = coverNights("2026-11-12", "2026-11-16", [
      { checkIn: "2026-11-12", checkOut: "2026-11-15", nightStatus: "confirmed" },
      { checkIn: "2026-11-14", checkOut: "2026-11-16", nightStatus: "pending" },
      { checkIn: "2026-11-12", checkOut: "2026-11-14", nightStatus: "confirmed" },
    ]);
    expect(calendar.confirmedNights).toBe(3);
    expect(calendar.pendingNights).toBe(1);
    expect(calendar.nights.map((night) => night.mark)).toEqual([
      "confirmed",
      "confirmed",
      "confirmed",
      "pending",
    ]);
  });

  it("ignores a same-day stay, a stay outside the window, and a broken date", () => {
    const calendar = coverNights("2026-11-12", "2026-11-14", [
      { checkIn: "2026-11-12", checkOut: "2026-11-12", nightStatus: "confirmed" },
      { checkIn: "2026-11-20", checkOut: "2026-11-22", nightStatus: "confirmed" },
      { checkIn: "2026-11-31", checkOut: "2026-12-02", nightStatus: "pending" },
      { checkIn: null, checkOut: "2026-11-13", nightStatus: "confirmed" },
    ]);
    expect(calendar.tripNights).toBe(2);
    expect(calendar.confirmedNights).toBe(0);
    expect(calendar.pendingNights).toBe(0);
    expect(calendar.gapNights).toBe(2);
    expect(coverNights("2026-11-12", "2026-11-12", NOVEMBER).tripNights).toBe(0);
  });

  it("leads with the trip in progress, then the soonest future start", () => {
    const trips = [
      { id: "past", startDate: "2026-10-01", endDate: "2026-10-08", status: "completed" },
      { id: "later", startDate: "2026-12-01", endDate: "2026-12-08", status: "upcoming" },
      { id: "soon", startDate: "2026-11-20", endDate: "2026-11-27", status: "planning" },
      { id: "now", startDate: "2026-11-10", endDate: "2026-11-18", status: "active" },
    ];
    expect(selectFeaturedTrip(trips, "2026-11-12")?.id).toBe("now");
    expect(
      selectFeaturedTrip(
        trips.filter((trip) => trip.id !== "now"),
        "2026-11-12",
      )?.id,
    ).toBe("soon");
    expect(selectFeaturedTrip([trips[0]!], "2026-11-12")).toBeNull();
    expect(selectFeaturedTrip(trips, "not-a-day")).toBeNull();
  });

  it("refuses a coverage payload whose parts do not add up", () => {
    expect(
      mapNightCoverage({
        result: "ok",
        trip_nights: 7,
        confirmed_nights: 3,
        pending_nights: 2,
        gap_nights: 1,
      }),
    ).toEqual({ status: "error" });
    expect(mapNightCoverage({ result: "not_found" })).toEqual({ status: "not_found" });
    expect(mapNightCoverage(null)).toEqual({ status: "error" });
    expect(mapSuggestionDecision({ result: "accepted" })).toEqual({ result: "error" });
    expect(
      mapSuggestionDecision({
        result: "accepted",
        suggestion_id: "11111111-1111-4111-8111-111111111111",
        night_status: "pending",
      }).result,
    ).toBe("accepted");
  });
});

describe("outreach board", () => {
  it("omits the share when the campaign has no hotels", () => {
    const empty = countOutreach([], [], new Set());
    expect(empty.selectedHotels).toBe(0);
    expect(loggedHotelShare(empty)).toBeNull();
    const rows = countOutreach(
      [{ hotelId: "a" }, { hotelId: "b" }],
      [
        { hotelId: "a", status: "pitched" },
        { hotelId: "a", status: "replied" },
        { hotelId: "b", status: "saved" },
      ],
      new Set(["b"]),
    );
    expect(rows).toMatchObject({
      selectedHotels: 2,
      draftsPrepared: 1,
      outreachLogged: 2,
      repliesReported: 1,
      hotelsLogged: 1,
    });
    expect(loggedHotelShare(rows)).toBe(50);
  });

  it("names the next real stage and does not invent a hotel request", () => {
    const move = nextOutreachMove([
      {
        hotelId: "a",
        hotelName: "Saved House",
        displayRef: "OP-1002",
        status: "saved",
        pipelineItemId: "1",
      },
      {
        hotelId: "b",
        hotelName: "Reply House",
        displayRef: "OP-1001",
        status: "replied",
        pipelineItemId: "2",
      },
    ]);
    expect(move?.displayRef).toBe("OP-1001");
    expect(move?.sentence).toBe("Open the conversation.");
    expect(move?.sentence).not.toMatch(/portfolio|sample|Lumphini/i);
    expect(nextOutreachMove([])).toBeNull();
    expect(parseOutreachFocus("follow_up")).toBe("follow_up");
    expect(parseOutreachFocus("drop table")).toBe("all");
    expect(rowMatchesFocus({ hotelId: "a", status: null, hasDraft: false }, "pitch")).toBe(true);
    expect(rowMatchesFocus({ hotelId: "a", status: "won", hasDraft: false }, "conversation")).toBe(
      false,
    );
  });

  it("refuses an opportunity id that is not OP-####", () => {
    expect(isDisplayRef("OP-1001")).toBe(true);
    expect(isDisplayRef("OP-0001")).toBe(false);
    expect(isDisplayRef("PIPE-1")).toBe(false);
    expect(
      mapOpenOpportunity({
        result: "created",
        pipeline_item_id: "11111111-1111-4111-8111-111111111111",
        display_ref: "OP-0001",
      }),
    ).toEqual({ result: "error" });
    expect(mapOutreachWrite({ result: "created", initiative_id: "x" })).toEqual({
      result: "error",
    });
    expect(
      mapOutreachWrite({
        result: "created",
        initiative_id: "11111111-1111-4111-8111-111111111111",
        hotel_count: 2,
      }),
    ).toMatchObject({ result: "created", hotelCount: 2 });
  });
});

describe("trips and outreach stay off other screens", () => {
  it("keeps Outreach in the sidebar and out of the five primary items", () => {
    expect(PRIMARY_NAV.map((item) => item.href)).toEqual([
      "/app",
      "/app/discover",
      "/app/pipeline",
      "/app/trips",
      "/app/profile",
    ]);
    expect(MOBILE_NAV.map((item) => item.href)).not.toContain("/app/outreach");
    expect(shellHeading("/app/outreach").title).toBe("Outreach");
    expect(activeSidebarHref("/app/outreach/abc", null)).toBe("/app/outreach");
    expect(shellCrumbs("/app/outreach/abc", null).map((crumb) => crumb.label)).toEqual([
      "Workspace",
      "Outreach",
      "Campaign",
    ]);
    expect(shellCrumbs("/app/trips/abc", null).map((crumb) => crumb.label)).toEqual([
      "Workspace",
      "My Trips",
      "Trip",
    ]);
  });

  it("does not print sample hotels or call Claude, Hunter, or Gmail", () => {
    const files = [
      "src/app/(app)/app/trips/page.tsx",
      "src/app/(app)/app/trips/[id]/page.tsx",
      "src/app/(app)/app/outreach/page.tsx",
      "src/app/(app)/app/outreach/[id]/page.tsx",
      "src/lib/trips/nights.ts",
      "src/lib/outreach/board.ts",
      "src/lib/outreach/queries.ts",
      "src/lib/outreach/actions.ts",
    ];
    for (const file of files) {
      const text = source(file);
      expect(text, file).not.toMatch(/Lumphini|Siam Canopy|SAMPLE WORKSPACE|147 credits/);
      expect(text, file).not.toMatch(/anthropic|hunter\.io|googleapis|gmail\.users/i);
    }
    const queries = source("src/lib/outreach/queries.ts");
    expect(queries).toContain("createClient()");
    expect(queries).toContain("await clientOrInjected");
    const tripQueries = source("src/lib/trips/queries.ts");
    expect(tripQueries).toContain('supabase.rpc("trip_night_coverage"');
  });
});
