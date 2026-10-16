/**
 * Home next actions are a fixed order over owned rows.
 * A foreign row is not an action. A failed read is not an empty list.
 * A paused Gmail payload keeps no suggestion id.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { OUT_OF_CREDITS_COPY, creditsLeftLabel } from "@/lib/credits/config";
import {
  HOME_GMAIL_READ_LIMIT,
  HOME_NEXT_ACTION_CAP,
  HOME_NEXT_COPY,
  parseOwnGmailSuggestions,
  prioritizeNextActions,
  recommendationDestination,
  type NextActionInput,
  type OwnedDeliverable,
  type OwnedGmailSuggestion,
  type OwnedPipelineItem,
} from "@/lib/home/next-actions";

const PROFILE = "99999999-9999-4999-8999-999999999999";
const OTHER = "88888888-8888-4888-8888-888888888888";
const AS_OF = "2026-10-13T12:00:00.000Z";

const HOTEL_A = "40000000-0000-4000-8000-000000000001";
const HOTEL_B = "40000000-0000-4000-8000-000000000002";
const HOTEL_C = "40000000-0000-4000-8000-000000000003";
const HOTEL_D = "40000000-0000-4000-8000-000000000004";
const ITEM_A = "51000000-0000-4000-8000-000000000001";
const ITEM_B = "51000000-0000-4000-8000-000000000002";
const ITEM_C = "51000000-0000-4000-8000-000000000003";
const ITEM_D = "51000000-0000-4000-8000-000000000004";
const SUGGEST_REPLY = "62000000-0000-4000-8000-000000000001";
const SUGGEST_PITCH = "62000000-0000-4000-8000-000000000002";
const SUGGEST_DEAL = "62000000-0000-4000-8000-000000000003";
const SUGGEST_B = "62000000-0000-4000-8000-000000000099";
const DELIVERABLE_A = "73000000-0000-4000-8000-000000000001";

function pipeline(overrides: Partial<OwnedPipelineItem> = {}): OwnedPipelineItem {
  return {
    id: ITEM_A,
    creatorId: PROFILE,
    status: "saved",
    hotelId: HOTEL_A,
    hotelName: "Ada House",
    nextFollowupAt: null,
    lastActivityAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function deliverable(overrides: Partial<OwnedDeliverable> = {}): OwnedDeliverable {
  return {
    id: DELIVERABLE_A,
    creatorId: PROFILE,
    status: "pending",
    hotelId: HOTEL_C,
    hotelName: "Ada Delivery",
    dueOn: "2026-10-10",
    ...overrides,
  };
}

function suggestion(overrides: Partial<OwnedGmailSuggestion> = {}): OwnedGmailSuggestion {
  return {
    id: SUGGEST_PITCH,
    creatorId: PROFILE,
    kind: "pitch_sent",
    pipelineItemId: ITEM_A,
    hotelId: HOTEL_A,
    hotelName: "Ada House",
    ...overrides,
  };
}

function input(overrides: Partial<NextActionInput> = {}): NextActionInput {
  return {
    profileId: PROFILE,
    asOf: AS_OF,
    pipeline: { status: "ok", items: [], capped: false },
    deliverables: { status: "ok", items: [], capped: false },
    gmail: { status: "paused" },
    credits: { status: "ok", balance: 12 },
    ...overrides,
  };
}

describe("prioritizeNextActions", () => {
  it("orders a due follow-up, a due deliverable, a Gmail reply, then a saved hotel", () => {
    const board = prioritizeNextActions(
      input({
        pipeline: {
          status: "ok",
          capped: false,
          items: [
            pipeline({
              id: ITEM_B,
              hotelId: HOTEL_B,
              hotelName: "Ada Later",
              status: "saved",
              lastActivityAt: "2026-10-11T00:00:00.000Z",
            }),
            pipeline({
              nextFollowupAt: "2026-10-01T00:00:00.000Z",
              status: "pitched",
              hotelName: "Ada Due",
            }),
          ],
        },
        deliverables: { status: "ok", capped: false, items: [deliverable()] },
        gmail: {
          status: "ok",
          truncated: false,
          suggestions: [
            suggestion({ id: SUGGEST_DEAL, kind: "collaboration", hotelName: "Ada Deal" }),
            suggestion({ id: SUGGEST_REPLY, kind: "human_reply", hotelName: "Ada Reply" }),
            suggestion(),
          ],
        },
      }),
    );

    expect(board.actions.map((action) => action.kind)).toEqual([
      "follow_up_due",
      "deliverable_due",
      "gmail_suggestion",
      "gmail_suggestion",
      "gmail_suggestion",
      "pipeline",
    ]);
    expect(board.actions.map((action) => action.title)).toEqual([
      "Follow up with Ada Due",
      "Deliverable due at Ada Delivery",
      "Human reply from Ada Reply",
      "Pitch detected to Ada House",
      "Collaboration suggestion with Ada Deal",
      "Saved hotel: Ada Later",
    ]);
    expect(board.followUpsDue).toBe(1);
    expect(board.actions[0]?.href).toBe(`/app/hotels/${HOTEL_A}?from=pipeline`);
    expect(board.actions[2]?.href).toBe(`/app/hotels/${HOTEL_A}?from=inbox#activity`);
    expect(board.actions[1]?.href).toBe(`/app/hotels/${HOTEL_C}?from=collaboration#collaboration`);
    expect(board.actions.some((action) => action.id === `pipeline:${ITEM_A}`)).toBe(false);
    expect(JSON.stringify(board)).not.toContain("/billing");
    expect(JSON.stringify(board)).not.toContain("mailto:");
  });

  it("does not treat a future follow-up, a closed cycle, or a blank date as due", () => {
    const board = prioritizeNextActions(
      input({
        pipeline: {
          status: "ok",
          capped: false,
          items: [
            pipeline({
              id: ITEM_B,
              hotelId: HOTEL_B,
              hotelName: "Ada Future",
              nextFollowupAt: "2026-10-20T00:00:00.000Z",
              status: "follow_up",
            }),
            pipeline({
              id: ITEM_C,
              hotelId: HOTEL_C,
              hotelName: "Ada Closed",
              status: "closed",
              nextFollowupAt: "2026-10-01T00:00:00.000Z",
            }),
            pipeline({ hotelName: "Ada Open", nextFollowupAt: null, status: "negotiating" }),
          ],
        },
      }),
    );

    expect(board.followUpsDue).toBe(0);
    expect(board.actions.map((action) => action.title)).toEqual([
      "Open negotiation with Ada Open",
      "Ada Future is in follow-up",
    ]);
    expect(JSON.stringify(board)).not.toContain("Ada Closed");
  });

  it("drops User B and does not render a malformed own follow-up as zero", () => {
    const board = prioritizeNextActions(
      input({
        pipeline: {
          status: "ok",
          capped: false,
          items: [
            pipeline({
              id: ITEM_B,
              creatorId: OTHER,
              hotelId: HOTEL_B,
              hotelName: "Bee Hotel",
              nextFollowupAt: "2026-09-01T00:00:00.000Z",
            }),
            pipeline({ hotelName: "Ada Tower", nextFollowupAt: "not-a-date" }),
          ],
        },
        deliverables: {
          status: "ok",
          capped: false,
          items: [deliverable({ creatorId: OTHER, hotelName: "Bee Delivery" })],
        },
        gmail: {
          status: "ok",
          truncated: false,
          suggestions: [suggestion({ id: SUGGEST_B, creatorId: OTHER, hotelName: "Bee Mail" })],
        },
      }),
    );

    const body = JSON.stringify(board);
    expect(body).not.toContain("Bee");
    expect(body).not.toContain(SUGGEST_B);
    expect(body).not.toContain("Ada Tower");
    expect(board.followUpsDue).toBeNull();
    expect(board.empty).toBeNull();
    expect(board.notices.map((notice) => notice.id)).toContain("follow-ups");
    expect(board.notices.map((notice) => notice.id)).toContain("pipeline");
  });

  it("keeps a paused Gmail payload from contributing ids, including a poisoned array", () => {
    const secret = "62000000-0000-4000-8000-000000000077";
    const parsed = parseOwnGmailSuggestions(
      {
        result: "paused",
        suggestions: [
          {
            id: secret,
            kind: "human_reply",
            pipeline_item_id: ITEM_A,
            hotel_id: HOTEL_A,
            hotel_name: "Hidden Bee",
          },
        ],
        truncated: true,
      },
      PROFILE,
    );
    expect(parsed).toEqual({ status: "paused" });
    expect(JSON.stringify(parsed)).not.toContain(secret);
    expect(JSON.stringify(parsed)).not.toContain("Hidden Bee");

    const board = prioritizeNextActions(input({ gmail: parsed }));
    expect(JSON.stringify(board)).not.toContain(secret);
    expect(board.notices.map((notice) => notice.id)).not.toContain("gmail");
    expect(board.empty).toBe(HOME_NEXT_COPY.empty);
  });

  it("hides another creator and a bad row instead of listing a partial Gmail set", () => {
    const parsed = parseOwnGmailSuggestions(
      {
        result: "ok",
        truncated: false,
        suggestions: [
          {
            id: SUGGEST_PITCH,
            kind: "pitch_sent",
            pipeline_item_id: ITEM_A,
            hotel_id: HOTEL_A,
            hotel_name: "Ada House",
          },
          {
            id: SUGGEST_PITCH,
            kind: "pitch_sent",
            pipeline_item_id: ITEM_B,
            hotel_id: HOTEL_B,
            hotel_name: "Ada Duplicate",
          },
        ],
      },
      PROFILE,
    );
    expect(parsed.status).toBe("error");
    const board = prioritizeNextActions(input({ gmail: parsed }));
    expect(JSON.stringify(board)).not.toContain(SUGGEST_PITCH);
    expect(JSON.stringify(board)).not.toContain("Ada Duplicate");
    expect(board.notices.map((notice) => notice.id)).toContain("gmail");
  });

  it("does not count a submitted or undated deliverable, and does count a rejected one", () => {
    const board = prioritizeNextActions(
      input({
        deliverables: {
          status: "ok",
          capped: false,
          items: [
            deliverable({
              id: ITEM_B,
              status: "submitted",
              hotelName: "Ada Sent",
              dueOn: "2026-10-01",
            }),
            deliverable({
              id: ITEM_C,
              status: "approved",
              hotelName: "Ada Done",
              dueOn: "2026-10-01",
            }),
            deliverable({ id: ITEM_D, status: "pending", hotelName: "Ada Undated", dueOn: null }),
            deliverable({
              id: DELIVERABLE_A,
              status: "rejected",
              hotelName: "Ada Rejected",
              dueOn: "2026-10-13",
            }),
            deliverable({
              id: "73000000-0000-4000-8000-000000000005",
              status: "pending",
              hotelName: "Ada Tomorrow",
              hotelId: HOTEL_D,
              dueOn: "2026-10-14",
            }),
          ],
        },
      }),
    );

    expect(board.actions.map((action) => action.title)).toEqual([
      "Deliverable due at Ada Rejected",
    ]);
    expect(JSON.stringify(board)).not.toContain("Ada Sent");
    expect(JSON.stringify(board)).not.toContain("Ada Tomorrow");
  });

  it("says credits are unavailable instead of zero, and does not link an empty balance to billing", () => {
    const missing = prioritizeNextActions(input({ credits: { status: "error" } }));
    expect(JSON.stringify(missing)).not.toContain("0 credits");
    expect(missing.credits).toBeNull();
    expect(missing.notices.map((notice) => notice.text)).toContain(HOME_NEXT_COPY.credits);

    const empty = prioritizeNextActions(input({ credits: { status: "ok", balance: 0 } }));
    expect(empty.credits).toMatchObject({
      title: creditsLeftLabel(0),
      detail: OUT_OF_CREDITS_COPY,
      href: null,
    });
    const enough = prioritizeNextActions(input({ credits: { status: "ok", balance: 1 } }));
    expect(enough.credits?.title).toBe(creditsLeftLabel(1));
    expect(enough.credits?.detail).toBe(HOME_NEXT_COPY.creditAvailable(1));
  });

  it("caps lower-priority rows and still reports every due follow-up", () => {
    const items = Array.from({ length: HOME_NEXT_ACTION_CAP + 1 }, (_, index) =>
      pipeline({
        id: `51000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        hotelId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
        hotelName: `Ada ${index}`,
        status: "pitched",
        nextFollowupAt: `2026-10-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
    const board = prioritizeNextActions(
      input({
        pipeline: { status: "ok", capped: false, items },
        gmail: { status: "ok", truncated: false, suggestions: [suggestion()] },
      }),
    );
    expect(board.followUpsDue).toBe(HOME_NEXT_ACTION_CAP + 1);
    expect(board.actions).toHaveLength(HOME_NEXT_ACTION_CAP);
    expect(board.actions.every((action) => action.kind === "follow_up_due")).toBe(true);
    expect(board.hiddenCount).toBe(2);
    expect(board.actions[0]?.title).toBe("Follow up with Ada 0");
    expect(JSON.stringify(board.actions)).not.toContain(SUGGEST_PITCH);
  });

  it("puts the stalest open cycle first inside one status and leaves an unknown status unread", () => {
    const ordered = prioritizeNextActions(
      input({
        pipeline: {
          status: "ok",
          capped: false,
          items: [
            pipeline({
              id: ITEM_B,
              hotelId: HOTEL_B,
              hotelName: "Ada New",
              lastActivityAt: "2026-10-10T00:00:00.000Z",
            }),
            pipeline({
              id: ITEM_C,
              hotelId: HOTEL_C,
              hotelName: "Ada Old",
              lastActivityAt: "2026-09-01T00:00:00.000Z",
            }),
            pipeline({
              id: ITEM_D,
              hotelId: HOTEL_D,
              hotelName: "Ada Undated",
              lastActivityAt: null,
            }),
          ],
        },
      }),
    );
    expect(ordered.actions.map((action) => action.title)).toEqual([
      "Saved hotel: Ada Old",
      "Saved hotel: Ada New",
      "Saved hotel: Ada Undated",
    ]);

    const unknown = prioritizeNextActions(
      input({
        pipeline: {
          status: "ok",
          capped: false,
          items: [pipeline({ status: "warm", hotelName: "Ada Invented" })],
        },
      }),
    );
    expect(JSON.stringify(unknown)).not.toContain("Ada Invented");
    expect(unknown.followUpsDue).toBeNull();
  });

  it("says a capped read is not the whole table", () => {
    const board = prioritizeNextActions(
      input({
        pipeline: { status: "ok", capped: true, items: [] },
        deliverables: { status: "ok", capped: true, items: [] },
        gmail: { status: "ok", truncated: true, suggestions: [] },
      }),
    );
    expect(board.followUpsDue).toBe(0);
    expect(board.empty).toBeNull();
    expect(board.notices.map((notice) => notice.id)).toEqual([
      "pipeline-capped",
      "deliverables-capped",
      "gmail-truncated",
    ]);
  });

  it("does not call a failed pipeline or a failed clock an empty day", () => {
    const failed = prioritizeNextActions(input({ pipeline: { status: "error" } }));
    expect(failed.followUpsDue).toBeNull();
    expect(failed.empty).toBeNull();
    expect(failed.actions).toEqual([]);

    const badClock = prioritizeNextActions(input({ asOf: "yesterday" }));
    expect(badClock.followUpsDue).toBeNull();
    expect(badClock.empty).toBeNull();
  });
});

describe("recommendationDestination", () => {
  it("prefers the upcoming trip and does not invent a destination", () => {
    expect(recommendationDestination("bali", "rome")).toEqual({ slug: "bali", source: "trip" });
    expect(recommendationDestination("  ", "rome")).toEqual({ slug: "rome", source: "onboarding" });
    expect(recommendationDestination(null, "  ")).toEqual({ slug: null, source: "none" });
  });
});

describe("home Gmail list migration", () => {
  const sql = readFileSync(
    path.join(process.cwd(), "supabase/migrations/0066_home_next_actions.sql"),
    "utf8",
  );

  it("adds no table and no write, and caps the paid list", () => {
    expect(sql.toLowerCase()).not.toContain("create table");
    expect(sql.toLowerCase()).not.toMatch(/\b(insert|update|delete)\b/);
    expect(sql).toContain(`limit ${HOME_GMAIL_READ_LIMIT}`);
    expect(sql).toContain(`v_count > ${HOME_GMAIL_READ_LIMIT}`);
    expect(sql).toContain("result', 'paused'");
    expect(sql).not.toContain("0061_gmail_collaboration_detection.sql");
  });
});
