import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { approvalProgress, deliverablePillClass, inPreparationCount } from "@/lib/collaboration/board";
import { parseContactFlags } from "@/lib/hotels/contact-exists";
import { outreachProgress } from "@/lib/home/dashboard";
import { firstPitchMarks } from "@/lib/onboarding/path";
import { duplicateHotelNote, laneTone } from "@/lib/pipeline/density";
import { profileReadiness } from "@/lib/profile/readiness";

function source(relative: string): string {
  return readFileSync(path.join(process.cwd(), relative), "utf8");
}

describe("V12.2 layout rebuild", () => {
  it("keeps pipeline counts inside the command, lanes, and deal cards", () => {
    const page = source("src/app/(app)/app/pipeline/page.tsx");
    const board = source("src/components/pipeline/pipeline-workspace.tsx");
    expect(page).toContain("v12-pagehead");
    expect(page).toContain("v12-context");
    expect(page).toContain("PipelineStatusFilter");
    expect(board).toContain("v12-darkhero");
    expect(board).toContain("v12-stats");
    expect(board).toContain("v12-attention");
    expect(board).toContain("v12-stage-board");
    expect(board).toContain("v12-deal");
    expect(board).toContain("lane-count-");
    expect(laneTone("replied")).toBe("reply");
    expect(laneTone("negotiating")).toBe("negotiate");
    expect(laneTone("won")).toBe("agreed");
    expect(laneTone("follow_up")).toBe("plain");
    expect(
      duplicateHotelNote([
        { hotelId: "a", hotelName: "North", displayRef: "OP-1042" },
        { hotelId: "a", hotelName: "North", displayRef: "OP-1084" },
        { hotelId: "b", hotelName: "South", displayRef: "OP-1001" },
      ]),
    ).toContain("North");
    expect(
      duplicateHotelNote([{ hotelId: "b", hotelName: "South", displayRef: "OP-1001" }]),
    ).toBeNull();
  });

  it("draws home campaign progress from contacted and shortlist counts", () => {
    const home = source("src/components/home/home-screen.tsx");
    expect(home).toContain("In progress");
    expect(home).toContain("Continue outreach");
    expect(home).toContain("v12-progress");
    const bar = outreachProgress({
      id: "c",
      name: "Bangkok",
      hotelCount: 8,
      contactedCount: 5,
    });
    expect(bar).toEqual({
      kind: "bar",
      label: "5 of 8 hotels contacted",
      percentLabel: "63%",
      width: 62.5,
    });
    expect(outreachProgress({ id: "c", name: "Empty", hotelCount: 0, contactedCount: 0 }).kind).toBe(
      "empty",
    );
  });

  it("places profile editors inside the portfolio layout", () => {
    const page = source("src/app/(app)/app/profile/page.tsx");
    expect(page).toContain("YOUR CREATOR IDENTITY");
    expect(page).toContain("Selected work");
    expect(page).toContain("HOTEL-FACING PREVIEW");
    expect(page).toContain("PROFILE READINESS");
    expect(page).toContain("ProfileEditor");
    expect(page).toContain("ShareLinkPanel");
    expect(page).toContain("/app/account");
    expect(page).not.toContain("GmailConnectionPanel");
    const ready = profileReadiness({
      bio: "Stories",
      formats: "Video",
      languages: "",
      selectedCount: 2,
      shareLinkUsable: true,
    });
    expect(ready.ready).toBe(true);
    expect(
      profileReadiness({
        bio: "",
        formats: "",
        languages: "",
        selectedCount: 0,
        shareLinkUsable: false,
      }).ready,
    ).toBe(false);
  });

  it("renders one collaboration workspace and a picker", () => {
    const page = source("src/app/(app)/app/collaborations/page.tsx");
    const board = source("src/components/collaboration/collaboration-board.tsx");
    expect(page).toContain("selectedId");
    expect(page).not.toMatch(/Contract Review|Lumphini|OP-1038/);
    expect(board).toContain("v12-context");
    expect(board).toContain("v12-stats");
    expect(board).toContain("Activity timeline");
    expect(board).toContain("aria-label=\"Other collaborations\"");
    expect(deliverablePillClass("approved")).toContain("green");
    expect(deliverablePillClass("pending")).not.toContain("lime");
    expect(inPreparationCount([{ status: "pending" }, { status: "approved" }])).toBe(1);
    expect(approvalProgress(0, 4).label).toBe("0 of 4 approved");
    expect(approvalProgress(0, 0).label).toBe("No deliverables recorded");
  });

  it("adds the getting started stepper and timeline", () => {
    const page = source("src/app/(app)/app/onboarding/page.tsx");
    expect(page).toContain("v12-stepper");
    expect(page).toContain("v12-timeline");
    expect(page).toContain("Skip to Discover");
    expect(firstPitchMarks(null)).toEqual(["upcoming", "upcoming", "upcoming", "upcoming"]);
    expect(firstPitchMarks({ destination: true, saved: false, pitch: false })[1]).toBe("current");
    expect(firstPitchMarks({ destination: true, saved: true, pitch: true })[2]).toBe("upcoming");
  });

  it("exposes contact existence as booleans and never an email", () => {
    const sql = source("supabase/migrations/0103_catalog_contact_exists.sql");
    expect(sql).toContain("returns table (hotel_id uuid, contact_exists boolean)");
    expect(sql).not.toMatch(/select[^;]*email/i);
    const id = "11111111-1111-4111-8111-111111111111";
    expect(parseContactFlags([{ hotel_id: id, contact_exists: true }])?.get(id)).toBe(true);
    expect(parseContactFlags([{ hotel_id: id, contact_exists: true, email: "a@b.c" }])).toBeNull();
    expect(parseContactFlags([{ hotel_id: id, contact_exists: "yes" }])).toBeNull();
    const row = source("src/components/hotels/hotel-row.tsx");
    expect(row).toContain("Contact available");
    expect(row).toContain("contactAvailable");
  });

  it("keeps the three hotel cards ahead of a collapsible section", () => {
    const page = source("src/app/(app)/app/hotels/[id]/page.tsx");
    const cards = page.indexOf("CREATOR REPLY RATE");
    const more = page.indexOf('id="more-intelligence"');
    expect(cards).toBeGreaterThan(0);
    expect(more).toBeGreaterThan(cards);
    expect(page.indexOf("<MetricCells")).toBeGreaterThan(more);
    expect(page).toContain("<details");
    const journey = source("e2e/journey.spec.ts");
    expect(journey).toContain("#more-intelligence");
    expect(journey).toContain("Manually recorded");
  });
});
