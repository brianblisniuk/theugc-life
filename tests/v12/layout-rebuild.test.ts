import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  activityTimelineClaim,
  approvalProgress,
  deliverablePillClass,
  inPreparationCount,
  mapOutreachActivity,
} from "@/lib/collaboration/board";
import { contactAvailability, parseContactFlags } from "@/lib/hotels/contact-exists";
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
    expect(page).not.toContain("PipelineStatusFilter");
    expect(page).not.toContain("PipelineSurfaceNav");
    expect(board).toContain("v12-darkhero");
    expect(board).toContain("v12-stats");
    expect(board).toContain("v12-attention");
    expect(board).toContain("v12-stage-board");
    expect(board).toContain("v12-deal");
    expect(board).toContain("<Chip");
    expect(source("src/app/midnight.css")).toContain('.v12-chip[aria-current="page"]');
    expect(board).not.toContain("PrivateNotesEditor");
    expect(board).not.toContain("mailto:");
    expect(board).not.toContain("pipeline-contact");
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
    expect(home).toContain("Shortlist");
    expect(home).toContain("Replies");
    expect(home).toContain("Open tasks");
    expect(home).toContain("attentionUnavailable");
    expect(home).toContain("hiddenCount");
    expect(home).not.toContain("hotelCount - card.contactedCount");
    expect(home).not.toContain("Not contacted");
    expect(home).toContain("v12-progress");
    const bar = outreachProgress({
      id: "c",
      name: "Bangkok",
      hotelCount: 8,
      contactedCount: 5,
      replyCount: 2,
    });
    expect(bar).toEqual({
      kind: "bar",
      label: "5 of 8 hotels contacted",
      percentLabel: "63%",
      width: 62.5,
    });
    expect(
      outreachProgress({ id: "c", name: "Empty", hotelCount: 0, contactedCount: 0, replyCount: 0 })
        .kind,
    ).toBe("empty");
  });

  it("places profile editors inside the portfolio layout", () => {
    const page = source("src/app/(app)/app/profile/page.tsx");
    expect(page).toContain("YOUR CREATOR IDENTITY");
    expect(page).toContain("Selected work");
    expect(page).toContain("HOTEL-FACING PREVIEW");
    expect(page).toContain("PROFILE READINESS");
    expect(page).toContain('href="/app/profile/edit"');
    expect(page).not.toContain("ProfileEditor");
    const journey = source("e2e/journey.spec.ts");
    const editClick = journey.indexOf('name: "Edit profile"');
    const bioFill = journey.indexOf('name: "Bio"');
    expect(editClick).toBeGreaterThan(0);
    expect(bioFill).toBeGreaterThan(editClick);
    expect(journey).toContain('"/app/profile/edit"');
    const edit = source("src/app/(app)/app/profile/edit/page.tsx");
    expect(edit).toContain("ProfileEditor");
    expect(edit).toContain("ShareLinkPanel");
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
    const queries = source("src/lib/collaboration/board-queries.ts");
    expect(queries).toContain('.eq("pipeline_item_id", pipelineItemId)');
    expect(queries).not.toContain('.in("pipeline_item_id"');
    expect(board).toContain("v12-list-item");
    expect(board).toContain("Update this collaboration");
    expect(board).not.toContain("No activity timeline is stored");
    expect(board).toContain('aria-label="Other collaborations"');
    const creator = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const pipe = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    expect(
      mapOutreachActivity(
        [
          {
            creator_id: creator,
            pipeline_item_id: pipe,
            event_type: "pitch_sent",
            event_at: "2026-10-16T12:00:00.000Z",
          },
          {
            creator_id: creator,
            pipeline_item_id: pipe,
            event_type: "custom_note",
            event_at: "2026-10-17T12:00:00.000Z",
          },
        ],
        creator,
      ),
    ).toEqual({
      kind: "ok",
      capped: false,
      events: [
        { pipelineItemId: pipe, label: "Pitch recorded", day: "2026-10-16" },
        { pipelineItemId: pipe, label: "custom_note", day: "2026-10-17" },
      ],
    });
    expect(
      mapOutreachActivity(
        [
          {
            creator_id: creator,
            pipeline_item_id: pipe,
            event_type: "pitch_sent",
            event_at: "2026-10-16T12:00:00.000Z",
            metadata: { email: "a@b.c" },
          },
        ],
        creator,
      ).kind,
    ).toBe("error");
    expect(deliverablePillClass("approved")).toContain("green");
    expect(deliverablePillClass("pending")).not.toContain("lime");
    expect(inPreparationCount([{ status: "pending" }, { status: "approved" }])).toBe(1);
    expect(approvalProgress(0, 4).label).toBe("0 of 4 approved");
    expect(approvalProgress(0, 0).label).toBe("No deliverables recorded");
  });

  it("adds the getting started stepper and timeline", () => {
    const page = source("src/app/(app)/app/onboarding/page.tsx");
    expect(page).toContain("v12-stepper");
    expect(page).toContain('aria-current={mark === "current" ? "step" : undefined}');
    expect(page).not.toContain('aria-hidden="true"');
    expect(page).not.toContain("s6-steps");
    expect(page).toContain("v12-timeline");
    expect(page).toContain("Skip to Discover");
    expect(firstPitchMarks(null)).toEqual(["upcoming", "upcoming", "upcoming", "upcoming"]);
    expect(
      firstPitchMarks({ destination: true, saved: false, pitch: false, contact: false })[1],
    ).toBe("current");
    expect(firstPitchMarks({ destination: true, saved: true, pitch: true, contact: true })[2]).toBe(
      "done",
    );
    expect(
      firstPitchMarks({ destination: true, saved: true, pitch: false, contact: "unknown" })[2],
    ).toBe("upcoming");
    const pipe = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    expect(activityTimelineClaim({ kind: "ok", events: [], capped: true }, pipe)).toBe("events");
    expect(activityTimelineClaim({ kind: "ok", events: [], capped: false }, pipe)).toBe("empty");
  });

  it("exposes contact existence as booleans and never an email", () => {
    const sql = source("supabase/migrations/0104_catalog_contact_exists.sql");
    expect(sql).toContain("returns table (hotel_id uuid, contact_exists boolean)");
    expect(sql).not.toMatch(/select[^;]*email/i);
    const id = "11111111-1111-4111-8111-111111111111";
    expect(parseContactFlags([{ hotel_id: id, contact_exists: true }])?.get(id)).toBe(true);
    expect(parseContactFlags([{ hotel_id: id, contact_exists: true, email: "a@b.c" }])).toBeNull();
    expect(parseContactFlags([{ hotel_id: id, contact_exists: true, name: "Ada" }])).toBeNull();
    expect(parseContactFlags([{ hotel_id: id, contact_exists: "yes" }])).toBeNull();
    expect(contactAvailability(new Map([[id, true]]), id)).toBe("available");
    expect(contactAvailability(new Map([[id, false]]), id)).toBe("absent");
    expect(contactAvailability(new Map(), id)).toBe("unknown");
    const row = source("src/components/hotels/hotel-row.tsx");
    expect(row).toContain("Contact available");
    expect(row).toContain("Contact check incomplete");
    expect(row).toContain("contactAvailable");
  });

  it("restyles Pitch Studio without changing draft or send actions", () => {
    const page = source("src/app/(app)/app/hotels/[id]/pitch/page.tsx");
    const composer = source("src/components/pitch/composer.tsx");
    expect(page).toContain("v12-pitch");
    expect(page).toContain("WHAT WE KNOW");
    expect(page).toContain("EMAIL COMPOSER");
    expect(page).toContain("visiblePitchDraft");
    expect(page).toContain("pipelineItemId={context.selectedOpportunity?.id ?? null}");
    expect(composer).toContain("v12-btn-dark");
    expect(composer).toContain("Copy email");
    expect(composer).toContain("savePitchDraftAction");
    expect(composer).toContain("sendPitchFromGmailAction");
    expect(composer).not.toContain("bg-accent");
    expect(source("supabase/migrations/0102_inbox_gmail_suggestion_scope.sql")).toContain(
      "list_own_pending_gmail_collaboration_suggestions",
    );
  });

  it("keeps the three hotel cards ahead of a collapsible section", () => {
    const page = source("src/app/(app)/app/hotels/[id]/page.tsx");
    const cards = page.indexOf("CREATOR REPLY RATE");
    const more = page.indexOf('id="more-intelligence"');
    expect(cards).toBeGreaterThan(0);
    expect(more).toBeGreaterThan(cards);
    expect(page.indexOf("<MetricCells")).toBeGreaterThan(more);
    expect(page).toContain(
      "Aggregates must be backed by eligible sample sizes in the real product.",
    );
    expect(page).toContain("<details");
    expect(source("src/app/(auth)/login/page.tsx")).toContain("v12-pagehead");
    expect(source("src/app/(auth)/login/page.tsx")).not.toContain("text-lg");
    expect(source("src/app/(app)/app/onboarding/hotels/page.tsx")).toContain("v12-pagehead");
    expect(source("src/app/(app)/app/onboarding/hotels/page.tsx")).not.toContain("s6-page");
    const journey = source("e2e/journey.spec.ts");
    expect(journey).toContain("#more-intelligence");
    expect(journey).toContain("Manually recorded");
    expect(journey).toContain('name: "No network fact yet"');
  });
});
