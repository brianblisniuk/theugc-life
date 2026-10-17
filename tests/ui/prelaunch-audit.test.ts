import { createElement } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";

import { describe, expect, it } from "vitest";

import { PageHeader } from "@/components/shell/page-header";
import { PipelineDense } from "@/components/pipeline/pipeline-workspace";
import { readTimelinePage } from "@/lib/collaboration/board";
import { campaignOpenTaskCount } from "@/lib/home/dashboard";
import { blockedNextActionBoard } from "@/lib/home/next-actions";
import { inboxWhenLabel } from "@/lib/inbox/model";
import {
  isPitchSendKey,
  readPitchSendKey,
  writePitchSendKey,
  type PitchSendKeyStore,
} from "@/lib/pitch/send-key";
import type { PipelineListItem } from "@/lib/pipeline/queries";
import { nextStep } from "@/lib/screens/next-step";
import {
  nextStepPitchHref,
  relationshipFromSelection,
  selectHotelOpportunity,
  type HotelOpportunity,
} from "@/lib/screens/hotel-opportunities";
import { pipelineHotelHref } from "@/lib/shell/navigation";

const HOTEL = "40000000-0000-4000-8000-000000000001";
const OPEN = "40000000-0000-4000-8000-000000000002";
const CLOSED = "40000000-0000-4000-8000-000000000003";
const OTHER = "40000000-0000-4000-8000-000000000004";
const TRIP = "40000000-0000-4000-8000-000000000005";

function opportunity(id: string, status: string, tripId: string | null): HotelOpportunity {
  return {
    id,
    displayRef: "OP-1001",
    status,
    stayStart: null,
    stayEnd: null,
    tripId,
    tripName: null,
  };
}

function item(
  id: string,
  status: PipelineListItem["status"],
  tripId: string | null,
): PipelineListItem {
  return {
    id,
    status,
    savedAt: null,
    lastActivityAt: "2026-10-16T12:00:00.000Z",
    nextFollowupAt: null,
    displayRef: status === "closed" ? "OP-1002" : "OP-1001",
    stayStart: null,
    stayEnd: null,
    tripName: null,
    tripId,
    hotel: { id: HOTEL, name: "Harbor House", destinationName: null, countryCode: null },
    privateNotes: null,
  };
}

function memoryStore(): PitchSendKeyStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
  };
}

describe("pipeline cards keep the opportunity", () => {
  it("opens the closed row instead of another open row, and pitch follows the named row", () => {
    const closedHref = pipelineHotelHref(HOTEL, CLOSED, TRIP);
    expect(closedHref).toContain(`opportunity=${CLOSED}`);
    expect(closedHref).toContain("from=pipeline");
    expect(closedHref).toContain(`trip=${TRIP}`);
    const requested = new URL(closedHref ?? "/", "http://local").searchParams.get("opportunity");
    const closedSelection = selectHotelOpportunity(
      [opportunity(OPEN, "saved", null), opportunity(CLOSED, "closed", TRIP)],
      requested,
      null,
    );
    expect(relationshipFromSelection(closedSelection)).toEqual({ status: "not_open" });
    const refused = nextStep({
      relationship: { status: "not_open" },
      contact: "ready",
      balance: 5,
      cost: 1,
      pitchHref: nextStepPitchHref(HOTEL, { kind: "pipeline" }, null) ?? "#work",
      plan: "Pro",
    });
    expect(refused.primaryHref).toBe("#work");
    expect(refused.primaryHref).not.toContain(OPEN);

    const openHref = pipelineHotelHref(HOTEL, OPEN, null);
    const named = new URL(openHref ?? "/", "http://local").searchParams.get("opportunity");
    const openSelection = selectHotelOpportunity(
      [opportunity(OPEN, "saved", null), opportunity(OTHER, "planned", TRIP)],
      named,
      null,
    );
    expect(openSelection).toEqual({
      status: "open",
      row: opportunity(OPEN, "saved", null),
    });
    const pitch = nextStepPitchHref(HOTEL, { kind: "pipeline" }, { id: OPEN, tripId: null });
    expect(pitch).toContain(`opportunity=${OPEN}`);
    expect(pitch).not.toContain(OTHER);

    const html = renderToStaticMarkup(
      createElement(PipelineDense, {
        items: [item(CLOSED, "closed", TRIP), item(OPEN, "saved", null)],
        view: "list",
        counts: null,
      }),
    );
    expect(html).toContain(`opportunity=${CLOSED}`);
    expect(html).toContain(`opportunity=${OPEN}`);
    expect(html).toContain(`trip=${TRIP}`);
  });
});

describe("page header stacks the title and the lede", () => {
  it("keeps the title and description in one column", () => {
    const html = renderToStaticMarkup(
      createElement(PageHeader, {
        title: "Account",
        description: "Mailbox connection and account deletion live on this page.",
        back: { href: "/app/profile", label: "Profile" },
        actions: createElement("button", { type: "button" }, "Save"),
      }),
    );
    const copy = html.slice(html.indexOf("v12-pagehead-copy"), html.indexOf("v12-head-actions"));
    expect(copy).toContain("Account");
    expect(copy).toContain("Mailbox connection and account deletion live on this page.");
    expect(copy).toContain("Back to Profile");
    const css = readFileSync(path.join(process.cwd(), "src/app/midnight.css"), "utf8");
    expect(css).toMatch(/\.v12-pagehead\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toContain("v12-pagehead-copy");
  });
});

describe("staff UI guide", () => {
  it("hides the footer link unless the viewer is staff", () => {
    const shell = readFileSync(
      path.join(process.cwd(), "src/components/shell/app-shell.tsx"),
      "utf8",
    );
    const foot = shell.slice(shell.indexOf("v12-sidebar-foot"));
    expect(foot).toMatch(/\{isStaff \? \([\s\S]*UI Guide/);
  });
});

describe("collaboration timeline window", () => {
  it("does not call exactly 80 events capped, and does call 81 capped", () => {
    const exact = readTimelinePage(
      Array.from({ length: 80 }, (_, index) => index),
      80,
    );
    expect(exact.capped).toBe(false);
    expect(exact.rows).toHaveLength(80);
    const over = readTimelinePage(
      Array.from({ length: 81 }, (_, index) => index),
      80,
    );
    expect(over.capped).toBe(true);
    expect(over.rows).toHaveLength(80);
    expect(over.rows[79]).toBe(79);
    const query = readFileSync(
      path.join(process.cwd(), "src/lib/collaboration/board-queries.ts"),
      "utf8",
    );
    expect(query).toContain("BOARD_READ_LIMIT + 1");
    expect(query).toContain("readTimelinePage");
    expect(query).not.toContain("length >= BOARD_READ_LIMIT");
  });
});

describe("campaign open tasks", () => {
  it("counts next steps on the campaign and keeps the number when deliverables fail", () => {
    const notices = [{ id: "deliverables" }];
    expect(campaignOpenTaskCount([HOTEL, OTHER], [HOTEL, "not-on-campaign", OTHER], notices)).toBe(
      2,
    );
    expect(campaignOpenTaskCount([HOTEL], ["not-on-campaign", "also-not"], notices)).toBe(0);
    expect(campaignOpenTaskCount([HOTEL], [HOTEL], [{ id: "pipeline" }])).toBeNull();
    expect(campaignOpenTaskCount(null, [HOTEL], [])).toBeNull();
    expect(blockedNextActionBoard().taskHotelIds).toEqual([]);
  });
});

describe("inbox civil day", () => {
  const asOf = "2026-10-17T03:00:00.000Z";
  const zone = "America/Los_Angeles";

  it("labels Today and Yesterday in the creator zone", () => {
    expect(inboxWhenLabel("2026-10-17T01:00:00.000Z", asOf, zone)).toBe("Today");
    expect(inboxWhenLabel("2026-10-16T20:00:00.000Z", asOf, zone)).toBe("Today");
    expect(inboxWhenLabel("2026-10-16T02:00:00.000Z", asOf, zone)).toBe("Yesterday");
    expect(inboxWhenLabel("2026-10-16T20:00:00.000Z", asOf)).toBe("Yesterday");
    expect(inboxWhenLabel("2026-10-15T20:00:00.000Z", asOf, zone)).toBe("Yesterday");
    expect(inboxWhenLabel("2026-10-15T20:00:00.000Z", asOf)).toBe("2 days");
    expect(inboxWhenLabel("not-a-date", asOf, zone)).toBe("Date unavailable");
  });
});

describe("gallery cap", () => {
  it("reads one row past 36 so a full page can say more exist", () => {
    const media = readFileSync(path.join(process.cwd(), "src/lib/hotels/media.ts"), "utf8");
    expect(media).toContain("MEDIA_LIMIT + 1");
    const page = readFileSync(
      path.join(process.cwd(), "src/app/(app)/app/hotels/[id]/page.tsx"),
      "utf8",
    );
    expect(page).toContain("hotelPhotoCountNote");
  });
});

describe("pitch send key", () => {
  const draft = "50000000-0000-4000-8000-000000000001";
  const key = "abcdef0123456789abcdef";

  it("keeps a valid key on the bound draft across a reload", () => {
    const store = memoryStore();
    expect(isPitchSendKey(key)).toBe(true);
    expect(isPitchSendKey("short")).toBe(false);
    writePitchSendKey(store, { draftId: draft, opportunityId: OPEN, key });
    expect(readPitchSendKey(store, draft, OPEN)).toBe(key);
    expect(readPitchSendKey(store, null, OPEN)).toBe(key);
    expect(readPitchSendKey(store, "other-draft", null)).toBeNull();
    const replacement = "zzzzzzzzzzzzzzzz";
    writePitchSendKey(store, { draftId: draft, opportunityId: OPEN, key: replacement });
    expect(readPitchSendKey(store, draft, OPEN)).toBe(replacement);
    writePitchSendKey(store, { draftId: draft, opportunityId: OPEN, key: "bad key" });
    expect(readPitchSendKey(store, draft, OPEN)).toBe(replacement);
    const composer = readFileSync(
      path.join(process.cwd(), "src/components/pitch/composer.tsx"),
      "utf8",
    );
    expect(composer).toContain("readPitchSendKey");
    expect(composer).toContain("rememberKey");
    const inbox = readFileSync(
      path.join(process.cwd(), "src/app/(app)/app/inbox/page.tsx"),
      "utf8",
    );
    expect(inbox).toContain("readOwnTimeZone");
  });
});
