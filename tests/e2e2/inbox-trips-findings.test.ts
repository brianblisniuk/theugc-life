/**
 * E2E-2 findings 10–15 and 18–24. Gmail send, sync, and OAuth stay out of this file.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { HOME_DASHBOARD_COPY, upcomingTrip, type HomeTrip } from "@/lib/home/dashboard";
import {
  HOME_NEXT_COPY,
  prioritizeNextActions,
  type NextActionInput,
} from "@/lib/home/next-actions";
import {
  INBOX_COPY,
  buildInboxScreen,
  revokedEmptyInbox,
  type InboxThreadRow,
} from "@/lib/inbox/model";
import { campaignRemainderNotice as outreachRemainder } from "@/lib/outreach/queries";
import { civilDate } from "@/lib/time/civil-date";
import { nightDrawProblem, selectFeaturedTrip } from "@/lib/trips/nights";
import {
  campaignRemainderNotice,
  linkableHotelName,
  mapLinkableRow,
  staySuggestionNotice,
} from "@/lib/trips/queries";

const PROFILE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HOTEL = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ITEM = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BIND = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function thread(overrides: Partial<InboxThreadRow> = {}): InboxThreadRow {
  return {
    bindingId: BIND,
    creatorId: PROFILE,
    pipelineItemId: ITEM,
    hotelId: HOTEL,
    hotelName: "North House",
    displayRef: "OP-1001",
    status: "follow_up",
    updatedAt: "2026-10-16T12:00:00.000Z",
    commercialState: null,
    readingPresent: false,
    stale: false,
    hasHumanReply: false,
    hasRedirect: false,
    ...overrides,
  };
}

function inbox(overrides: Partial<Parameters<typeof buildInboxScreen>[0]> = {}) {
  return buildInboxScreen({
    profileId: PROFILE,
    asOf: "2026-10-16T15:00:00.000Z",
    filter: "all",
    selectedId: null,
    mailbox: { kind: "connected", email: "ada@example.com" },
    threads: [],
    suggestions: [],
    collaborations: [],
    collaborationStatus: "ok",
    dates: [],
    threadsCapped: false,
    datesCapped: false,
    suggestionsCapped: false,
    suggestionsFailed: false,
    datesFailed: false,
    collaborationsFailed: false,
    foreign: false,
    ...overrides,
  });
}

function trip(overrides: Partial<HomeTrip> & Pick<HomeTrip, "id">): HomeTrip {
  return {
    name: null,
    destinationName: "Place",
    startDate: "2026-11-01",
    endDate: "2026-11-20",
    status: "planning",
    ...overrides,
  };
}

describe("inbox review findings", () => {
  it("does not call a truncated Gmail review complete", () => {
    const screen = inbox({
      collaborationsTruncated: true,
      threads: [thread({ status: "replied", hasHumanReply: false })],
    });
    expect(screen.kind).toBe("ready");
    if (screen.kind !== "ready") return;
    expect(screen.heading).toBe(INBOX_COPY.suggestionsCappedHeading);
    expect(screen.heading).not.toBe("Nothing in these conversations needs a reply.");
    expect(screen.notices).toContain(INBOX_COPY.gmailTruncated);
    expect(INBOX_COPY.gmailTruncated).toBe(HOME_NEXT_COPY.gmailTruncated);
  });

  it("says the needs-reply filter excluded linked conversations", () => {
    const screen = inbox({
      filter: "needs_reply",
      threads: [thread({ status: "follow_up" })],
    });
    expect(screen.kind).toBe("ready");
    if (screen.kind !== "ready") return;
    expect(screen.heading).toBe("One follow-up is waiting.");
    expect(screen.counts.followUp).toBe(1);
    expect(screen.threads).toHaveLength(0);
    expect(screen.emptySentence).toBe(INBOX_COPY.emptyNeedsReply);
    expect(screen.emptySentence).not.toBe(INBOX_COPY.emptyConnected);
  });

  it("keeps the empty-list sentence when nothing is linked", () => {
    const screen = inbox({ filter: "needs_reply", threads: [] });
    expect(screen.kind).toBe("ready");
    if (screen.kind !== "ready") return;
    expect(screen.emptySentence).toBe(INBOX_COPY.emptyConnected);
  });

  it("shows a revoked mailbox on every filter and not as an empty list", () => {
    const filtered = inbox({
      filter: "needs_reply",
      mailbox: { kind: "reauth" },
      threads: [],
    });
    expect(filtered.kind).toBe("ready");
    if (filtered.kind !== "ready") return;
    expect(revokedEmptyInbox(filtered)?.title).toBe("Gmail authorization stopped");
    const page = readFileSync(
      path.join(process.cwd(), "src/components/inbox/inbox-screen.tsx"),
      "utf8",
    );
    expect(page).toContain("revoked ? null : model.threads.length === 0");
  });
});

describe("trip and home findings", () => {
  it("uses the same open trip as My Trips and the creator's civil date", () => {
    const trips = [
      trip({ id: "a", name: "Cancelled stay", status: "cancelled", endDate: "2026-11-20" }),
      trip({
        id: "b",
        name: "Planning stay",
        status: "planning",
        startDate: "2026-11-20",
        endDate: "2026-11-27",
      }),
    ];
    expect(upcomingTrip(trips, "2026-11-12T12:00:00.000Z")?.id).toBe("b");
    expect(selectFeaturedTrip(trips, "2026-11-12")?.id).toBe("b");
    expect(upcomingTrip(trips, "2026-11-20T12:00:00.000Z")?.id).toBe("b");

    const lastNight = [
      trip({
        id: "late",
        status: "active",
        startDate: "2026-11-18",
        endDate: "2026-11-21",
      }),
    ];
    expect(upcomingTrip(lastNight, "2026-11-21T01:00:00.000Z", "UTC")).toBeNull();
    expect(upcomingTrip(lastNight, "2026-11-21T01:00:00.000Z", "America/Los_Angeles")?.id).toBe(
      "late",
    );
    expect(civilDate("2026-11-21T01:00:00.000Z", "America/Los_Angeles")).toBe("2026-11-20");
  });

  it("names a missing night count separately from a failed count", () => {
    expect(HOME_DASHBOARD_COPY.nightsNone).not.toBe(HOME_DASHBOARD_COPY.nightsError);
    const page = readFileSync(
      path.join(process.cwd(), "src/components/home/home-screen.tsx"),
      "utf8",
    );
    expect(page).toContain("HOME_DASHBOARD_COPY.nightsNone");
    expect(page).not.toContain(
      'trip.coverage.status === "none" ? (\n                <InsufficientDataState description={HOME_DASHBOARD_COPY.nightsError} />',
    );
  });

  it("splits a failed night read from a calendar mismatch", () => {
    expect(nightDrawProblem({ shortlistOk: false, coverageOk: true, countsMatch: false })).toBe(
      "read",
    );
    expect(nightDrawProblem({ shortlistOk: true, coverageOk: false, countsMatch: false })).toBe(
      "read",
    );
    expect(nightDrawProblem({ shortlistOk: true, coverageOk: true, countsMatch: false })).toBe(
      "mismatch",
    );
    expect(nightDrawProblem({ shortlistOk: true, coverageOk: true, countsMatch: true })).toBe("ok");
  });

  it("does not invent the hotel name Hotel", () => {
    expect(linkableHotelName("  ")).toBeNull();
    expect(linkableHotelName(null)).toBeNull();
    expect(mapLinkableRow({ id: ITEM, status: "saved", hotel: { name: "" } })).toBe("unnamed");
    expect(
      mapLinkableRow({ id: ITEM, status: "saved", hotel: { name: "North House" } }),
    ).toMatchObject({ hotelName: "North House" });
  });

  it("states a remainder when a campaign list is capped", () => {
    expect(outreachRemainder(101, 100)).toBe("1 more campaign is not on this page.");
    expect(campaignRemainderNotice(21, 20)).toBe("1 more campaign is not listed.");
    expect(outreachRemainder(100, 100)).toBeNull();
    expect(staySuggestionNotice(true)).toContain("not a complete list");
    expect(staySuggestionNotice(false)).toBeNull();
  });

  it("labels a follow-up due date in the creator's civil timezone", () => {
    const board = prioritizeNextActions({
      profileId: PROFILE,
      asOf: "2026-10-17T03:00:00.000Z",
      timeZone: "America/Los_Angeles",
      pipeline: {
        status: "ok",
        capped: false,
        items: [
          {
            id: ITEM,
            creatorId: PROFILE,
            status: "follow_up",
            hotelId: HOTEL,
            hotelName: "North House",
            nextFollowupAt: "2026-10-17T02:00:00.000Z",
            lastActivityAt: "2026-10-16T00:00:00.000Z",
          },
        ],
      },
      deliverables: { status: "ok", items: [], capped: false },
      gmail: { status: "paused" },
      credits: { status: "ok", balance: 4 },
    } satisfies NextActionInput);
    const due = board.actions.find((action) => action.kind === "follow_up_due");
    expect(due?.detail).toBe("Due 2026-10-16. Silence is not ghosting.");
    expect(due?.detail).not.toContain("2026-10-17");
  });
});

describe("page copy for failed reads and refused writes", () => {
  it("does not dress a failed opportunity or campaign read as an empty shortlist", () => {
    const page = readFileSync(path.join(process.cwd(), "src/app/(app)/app/trips/page.tsx"), "utf8");
    expect(page).toContain("We couldn’t load opportunities");
    expect(page).toContain("We couldn’t load outreach for this trip");
    expect(page).toContain("Outreach status unavailable");
    expect(page).toContain('opportunities.status !== "ok"');
  });

  it("surfaces a refused remove and a refused unlink", () => {
    const forms = readFileSync(
      path.join(process.cwd(), "src/components/trips/trip-forms.tsx"),
      "utf8",
    );
    expect(forms).toContain("That stay isn’t on your account. Nothing was changed.");
    expect(forms).toContain("That item isn’t on your account. Nothing was changed.");
    expect(forms).toContain("setMessage(shortlistRefusal(result))");
  });

  it("filters stay suggestions in the query and reports truncation", () => {
    const queries = readFileSync(path.join(process.cwd(), "src/lib/trips/queries.ts"), "utf8");
    expect(queries).toContain(".or(scope)");
    expect(queries).toContain("STAY_SUGGESTION_CAP + 1");
    const tripPage = readFileSync(
      path.join(process.cwd(), "src/app/(app)/app/trips/[id]/page.tsx"),
      "utf8",
    );
    const outreachPage = readFileSync(
      path.join(process.cwd(), "src/app/(app)/app/outreach/[id]/page.tsx"),
      "utf8",
    );
    expect(tripPage).toContain("staySuggestionNotice");
    expect(outreachPage).toContain("staySuggestionNotice");
  });
});

describe("scoped Gmail suggestion migration", () => {
  const sql = readFileSync(
    path.join(process.cwd(), "supabase/migrations/0102_inbox_gmail_suggestion_scope.sql"),
    "utf8",
  );

  it("limits the inbox read to the passed pipeline items and still reports the cap", () => {
    expect(sql).toContain("p_pipeline_item_ids uuid[]");
    expect(sql).toContain("s.pipeline_item_id = any (v_ids)");
    expect(sql).toContain("limit 100");
    expect(sql).toContain("'truncated', v_count > 100");
    expect(sql).toContain("grant execute");
    expect(sql.toLowerCase()).not.toContain("create table");
  });
});
