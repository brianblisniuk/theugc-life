/**
 * D115 deadline states. The UTC day is the whole window. A failed read is not
 * an empty reminder list. Another creator's row fails the read.
 */
import { describe, expect, it } from "vitest";

import {
  buildDeadlineBoard,
  classifyDeadline,
  errorDeadlineBoard,
  parseDeadlinePayload,
  showEmptyReminders,
  utcDay,
  workspaceDeadlines,
  type DeadlineRow,
} from "@/lib/collaboration/deadlines";

const PROFILE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOTEL = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ITEM = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CLOCK = "2026-10-13T15:00:00.000Z";

function row(overrides: Partial<DeadlineRow> = {}): DeadlineRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    creatorId: PROFILE,
    pipelineItemId: ITEM,
    hotelId: HOTEL,
    hotelName: "Casa Luz",
    deliverableType: "reel",
    quantity: 1,
    platform: null,
    dueOn: "2026-10-13",
    status: "pending",
    ...overrides,
  };
}

function payload(deliverables: unknown[], truncated = false) {
  return { result: "ok", truncated, deliverables };
}

describe("deliverable deadline states", () => {
  it("uses the UTC day, including an offset that crosses midnight", () => {
    expect(utcDay("2026-10-13T23:30:00.000Z")).toBe("2026-10-13");
    expect(utcDay("2026-10-14T00:00:00.000Z")).toBe("2026-10-14");
    expect(utcDay("2026-10-13T23:30:00-05:00")).toBe("2026-10-14");
    expect(utcDay(" 2026-10-13T00:00:00.000Z")).toBeNull();
    expect(utcDay("not-a-clock")).toBeNull();
  });

  it("splits overdue, due soon, and upcoming on that UTC day", () => {
    expect(classifyDeadline("pending", "2026-10-12", CLOCK)).toBe("overdue");
    expect(classifyDeadline("rejected", "2026-10-12", CLOCK)).toBe("overdue");
    expect(classifyDeadline("pending", "2026-10-13", CLOCK)).toBe("due_soon");
    expect(classifyDeadline("pending", "2026-10-14", "2026-10-13T23:59:59.999Z")).toBe("upcoming");
    expect(classifyDeadline("pending", "2026-10-13", "2026-10-14T00:00:00.000Z")).toBe("overdue");
    expect(classifyDeadline("pending", "2024-02-29", "2024-03-01T00:00:00.000Z")).toBe("overdue");
  });

  it("does not treat submitted, approved, or a missing date as due", () => {
    expect(classifyDeadline("submitted", "2026-10-01", CLOCK)).toBe("none");
    expect(classifyDeadline("approved", "2026-10-13", CLOCK)).toBe("none");
    expect(classifyDeadline("pending", null, CLOCK)).toBe("none");
    expect(classifyDeadline("rejected", null, CLOCK)).toBe("none");
  });

  it("refuses a date or a status it cannot classify", () => {
    expect(classifyDeadline("pending", "2026-02-31", CLOCK)).toBe("invalid");
    expect(classifyDeadline("pending", "2023-02-29", CLOCK)).toBe("invalid");
    expect(classifyDeadline("pending", "2026-10-13T00:00:00.000Z", CLOCK)).toBe("invalid");
    expect(classifyDeadline("paid", "2026-10-13", CLOCK)).toBe("invalid");
    expect(classifyDeadline("pending", "2026-10-13", "yesterday")).toBe("invalid");
  });

  it("keeps reminders to overdue and due soon, and prefers the more urgent indicator", () => {
    const source = parseDeadlinePayload(
      payload([
        {
          id: "22222222-2222-4222-8222-222222222222",
          creator_id: PROFILE,
          pipeline_item_id: ITEM,
          hotel_id: HOTEL,
          hotel_name: "Casa Luz",
          deliverable_type: "story",
          quantity: 2,
          platform: "Instagram",
          due_on: "2026-10-20",
          status: "pending",
        },
        {
          id: "11111111-1111-4111-8111-111111111111",
          creator_id: PROFILE,
          pipeline_item_id: ITEM,
          hotel_id: HOTEL,
          hotel_name: "Casa Luz",
          deliverable_type: "reel",
          quantity: 1,
          platform: null,
          due_on: "2026-10-01",
          status: "rejected",
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          creator_id: PROFILE,
          pipeline_item_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
          hotel_id: HOTEL,
          hotel_name: "Casa Luz",
          deliverable_type: "post",
          quantity: 1,
          platform: null,
          due_on: "2026-10-13",
          status: "pending",
        },
      ]),
      PROFILE,
    );
    const board = buildDeadlineBoard({ asOf: CLOCK, profileId: PROFILE, source });
    expect(board.kind).toBe("ok");
    if (board.kind !== "ok") return;
    expect(board.reminders.map((item) => item.state)).toEqual(["overdue", "due_soon"]);
    expect(board.reminders.map((item) => item.dueOn)).toEqual(["2026-10-01", "2026-10-13"]);
    expect(board.reminders[0]!.detail).toBe("1 × Reel · due 2026-10-01");
    expect(board.upcoming.map((item) => item.detail)).toEqual([
      "2 × Story · Instagram · due 2026-10-20",
    ]);
    expect(board.indicators[ITEM]).toBe("overdue");
    expect(board.indicators["eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"]).toBe("due_soon");
    expect(showEmptyReminders(board)).toBe(false);
    expect(board.reminders[0]!.href).toBe(`/app/hotels/${HOTEL}?from=collaboration#collaboration`);
  });

  it("sorts the same day by id and does not call a capped empty set 'nothing due'", () => {
    const later = "22222222-2222-4222-8222-222222222222";
    const earlier = "11111111-1111-4111-8111-111111111111";
    const board = buildDeadlineBoard({
      asOf: CLOCK,
      profileId: PROFILE,
      source: {
        status: "ok",
        truncated: true,
        rows: [row({ id: later, dueOn: "2026-11-01" }), row({ id: earlier, dueOn: "2026-11-01" })],
      },
    });
    expect(board.kind).toBe("ok");
    if (board.kind !== "ok") return;
    expect(board.reminders).toEqual([]);
    expect(board.upcoming.map((item) => item.id)).toEqual([earlier, later]);
    expect(board.capped).toBe(true);
    expect(showEmptyReminders(board)).toBe(false);
  });

  it("says the successful empty set is empty, and a bad clock is not", () => {
    const empty = buildDeadlineBoard({
      asOf: CLOCK,
      profileId: PROFILE,
      source: { status: "ok", rows: [], truncated: false },
    });
    expect(showEmptyReminders(empty)).toBe(true);
    const badClock = buildDeadlineBoard({
      asOf: "nope",
      profileId: PROFILE,
      source: { status: "ok", rows: [], truncated: false },
    });
    expect(badClock).toEqual(errorDeadlineBoard());
    expect(showEmptyReminders(badClock)).toBe(false);
    expect(
      showEmptyReminders(
        buildDeadlineBoard({
          asOf: CLOCK,
          profileId: PROFILE,
          source: { status: "error" },
        }),
      ),
    ).toBe(false);
  });

  it("fails the read when a payload contains another creator, a duplicate, or a bad value", () => {
    const own = {
      id: "11111111-1111-4111-8111-111111111111",
      creator_id: PROFILE,
      pipeline_item_id: ITEM,
      hotel_id: HOTEL,
      hotel_name: "Casa Luz",
      deliverable_type: "reel",
      quantity: 1,
      platform: null,
      due_on: "2026-10-01",
      status: "pending",
    };
    expect(
      parseDeadlinePayload(
        payload([{ ...own, id: "22222222-2222-4222-8222-222222222222", creator_id: OTHER }, own]),
        PROFILE,
      ).status,
    ).toBe("error");
    expect(parseDeadlinePayload(payload([own, own]), PROFILE).status).toBe("error");
    expect(parseDeadlinePayload(payload([{ ...own, quantity: 1.5 }]), PROFILE).status).toBe(
      "error",
    );
    expect(parseDeadlinePayload(payload([{ ...own, hotel_name: " Casa" }]), PROFILE).status).toBe(
      "error",
    );
    expect(parseDeadlinePayload(payload([{ ...own, status: "submitted" }]), PROFILE).status).toBe(
      "error",
    );
    expect(parseDeadlinePayload(payload([{ ...own, due_on: "2026-02-31" }]), PROFILE).status).toBe(
      "error",
    );
    expect(parseDeadlinePayload({ result: "not_found" }, PROFILE).status).toBe("error");
    expect(parseDeadlinePayload(payload([own], "yes" as unknown as boolean), PROFILE).status).toBe(
      "error",
    );
    const leaked = buildDeadlineBoard({
      asOf: CLOCK,
      profileId: PROFILE,
      source: parseDeadlinePayload(payload([{ ...own, creator_id: OTHER }]), PROFILE),
    });
    expect(leaked.kind).toBe("error");
    if (leaked.kind === "error") expect(leaked.notice).not.toMatch(/0/);
  });

  it("does not badge a submitted row, and a bad date fails the hotel comparison", () => {
    const view = workspaceDeadlines(
      [
        { id: "11111111-1111-4111-8111-111111111111", status: "submitted", dueOn: "2026-10-01" },
        { id: "22222222-2222-4222-8222-222222222222", status: "pending", dueOn: "2026-10-12" },
        { id: "33333333-3333-4333-8333-333333333333", status: "approved", dueOn: "2026-10-13" },
        { id: "44444444-4444-4444-8444-444444444444", status: "pending", dueOn: null },
        { id: "55555555-5555-4555-8555-555555555555", status: "pending", dueOn: "2026-10-13" },
      ],
      CLOCK,
    );
    expect(view.kind).toBe("ok");
    if (view.kind !== "ok") return;
    expect(view.reminders.map((item) => item.state)).toEqual(["overdue", "due_soon"]);
    expect(view.byId["33333333-3333-4333-8333-333333333333"]).toBeUndefined();
    expect(
      workspaceDeadlines(
        [{ id: "11111111-1111-4111-8111-111111111111", status: "pending", dueOn: "2026-02-31" }],
        CLOCK,
      ).kind,
    ).toBe("invalid");
  });
});
