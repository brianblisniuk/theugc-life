/**
 * V2-S3 pipeline density.
 *
 * Two opportunities for one hotel stay distinct. A failed count is not zero.
 * A missing signal is not a rate. follow_up is not a stage column.
 */
import { describe, expect, it } from "vitest";

import { PIPELINE_STATUSES, pipelineStageLabel } from "@/lib/pipeline/types";
import {
  STAGE_COLUMNS,
  buildAttention,
  cardKey,
  cardSignal,
  columnEmptyNote,
  commandSummary,
  contactLine,
  COUNT_UNAVAILABLE,
  followUpPresentation,
  laneBadge,
  contextLine,
  followUpRows,
  nextStep,
  rowsForStage,
  shownDisplayRef,
  stayWindow,
  type DensityRow,
} from "@/lib/pipeline/density";

const AS_OF = "2026-10-16T12:00:00.000Z";

function row(patch: Partial<DensityRow> & Pick<DensityRow, "id" | "status">): DensityRow {
  return {
    displayRef: null,
    hotelId: "hotel-1",
    hotelName: "Siam Canopy House",
    destinationName: "Bangkok",
    stayStart: null,
    stayEnd: null,
    tripName: null,
    nextFollowupAt: null,
    lastActivityAt: null,
    deadlineLabel: null,
    contactEmail: null,
    privateNotes: null,
    metricRank: null,
    metricValue: null,
    metricSample: null,
    ...patch,
  };
}

describe("stage columns", () => {
  it("uses the seven stage words and leaves follow-up off the board", () => {
    expect(STAGE_COLUMNS.map((column) => column.label)).toEqual([
      "Saved",
      "Pitch ready",
      "Sent",
      "Replied",
      "Negotiating",
      "Agreed",
      "Closed",
    ]);
    expect(STAGE_COLUMNS.map((column) => column.status)).not.toContain("follow_up");
    expect(pipelineStageLabel("follow_up")).toBeNull();
    expect(
      followUpRows([row({ id: "a", status: "follow_up" }), row({ id: "b", status: "pitched" })]),
    ).toHaveLength(1);
  });
});

describe("two opportunities for one hotel", () => {
  const first = row({
    id: "11111111-1111-4111-8111-111111111111",
    status: "replied",
    displayRef: "OP-1042",
    stayStart: "2026-11-12",
    stayEnd: "2026-11-19",
    tripName: "Bangkok November",
  });
  const second = row({
    id: "22222222-2222-4222-8222-222222222222",
    status: "planned",
    displayRef: "OP-1084",
    tripName: null,
    destinationName: "Bangkok",
  });

  it("keeps separate keys, stages, and next steps", () => {
    expect(cardKey(first)).not.toBe(cardKey(second));
    expect(rowsForStage([first, second], "replied")).toEqual([first]);
    expect(rowsForStage([first, second], "planned")).toEqual([second]);
    expect(nextStep(first, AS_OF).title).toBe("Replied");
    expect(nextStep(second, AS_OF).title).toBe("Pitch ready");
    expect(nextStep(first, AS_OF).detail).not.toContain("OP-1084");
    expect(nextStep(second, AS_OF).detail).not.toContain("portfolio");
    expect(contextLine(first)).toContain("OP-1042".replace("OP-1042", "Bangkok November"));
    expect(contextLine(first)).toContain("2026-11-12");
    expect(contextLine(second)).toBe("Bangkok");
  });

  it("does not render a display id that fails the shape", () => {
    expect(shownDisplayRef("OP-1042")).toBe("OP-1042");
    expect(shownDisplayRef("OP-12")).toBeNull();
    expect(shownDisplayRef("user-b-secret")).toBeNull();
    expect(shownDisplayRef("OP-1042@hotel.test")).toBeNull();
  });
});

describe("counts and empty columns", () => {
  it("refuses to turn a failed count into zeros", () => {
    const failed = commandSummary(null);
    expect(failed.kind).toBe("error");
    if (failed.kind !== "error") throw new Error("unreachable");
    expect(failed.text).toMatch(/not zeros/);
    const partial = commandSummary({ saved: 1 });
    expect(partial.kind).toBe("error");
  });

  it("sums only the stored statuses", () => {
    const counts = Object.fromEntries(PIPELINE_STATUSES.map((status) => [status, 0])) as Record<
      string,
      number
    >;
    counts.saved = 2;
    counts.replied = 1;
    counts.follow_up = 1;
    counts.negotiating = 1;
    counts.won = 1;
    const summary = commandSummary(counts);
    expect(summary).toMatchObject({
      kind: "ok",
      tracked: 6,
      replied: 1,
      followUps: 1,
      agreed: 1,
      moving: 3,
    });
  });

  it("does not call an empty column empty when the total is unknown", () => {
    expect(columnEmptyNote(0, null)).toBeNull();
    expect(columnEmptyNote(0, 3)).toBe("On another page");
    expect(columnEmptyNote(1, 3)).toBeNull();
    expect(columnEmptyNote(0, 0)).toBeNull();
  });

  it("paints the database count, and a failed count is not the page length or zero", () => {
    expect(laneBadge(12)).toBe("12");
    expect(laneBadge(0)).toBe("0");
    expect(laneBadge(null)).toBe(COUNT_UNAVAILABLE);
    expect(laneBadge(undefined)).toBe(COUNT_UNAVAILABLE);
    expect(laneBadge(-1)).toBe(COUNT_UNAVAILABLE);
    expect(laneBadge(1.5)).toBe(COUNT_UNAVAILABLE);
    expect(laneBadge(null)).not.toBe("0");
    expect(laneBadge(null)).not.toBe("3");
  });

  it("keeps the follow-up strip when this page has none but the count does", () => {
    expect(followUpPresentation(0, 4)).toEqual({
      visible: true,
      badge: "4",
      note: "On another page",
    });
    const failed = followUpPresentation(0, null);
    expect(failed.visible).toBe(true);
    if (failed.visible) expect(failed.badge).toBe(COUNT_UNAVAILABLE);
    expect(followUpPresentation(0, 0)).toEqual({ visible: false });
    const shown = followUpPresentation(2, 9);
    if (shown.visible) expect(shown.badge).toBe("9");
  });
});

describe("unlocked email", () => {
  it("does not describe a failed read as no email", () => {
    expect(contactLine({ read: "error", email: null }).kind).toBe("unavailable");
    expect(contactLine({ read: "error", email: "ada@hotel.test" }).kind).toBe("unavailable");
    expect(contactLine({ read: "ok", email: null })).toEqual({ kind: "none" });
    expect(contactLine({ read: "ok", email: "ada@hotel.test" })).toEqual({
      kind: "email",
      email: "ada@hotel.test",
    });
  });
});

describe("signals", () => {
  it("shows a public signal and never a rate", () => {
    const signal = cardSignal({
      status: "ok",
      signal: {
        activityLevel: "high",
        confidenceLevel: "moderate",
        hasObservedCollaboration: true,
        recencyBand: "past_month",
      },
    });
    expect(signal.kind).toBe("signal");
    expect(signal.text).not.toMatch(/%|@/);
    expect(signal.text).toContain("High creator activity");
  });

  it("keeps a failed read distinct from insufficient data", () => {
    expect(cardSignal({ status: "error" }).kind).toBe("unavailable");
    expect(cardSignal({ status: "none" })).toEqual({
      kind: "insufficient",
      text: "Insufficient data",
    });
    expect(
      cardSignal({
        status: "ok",
        signal: {
          activityLevel: "high",
          confidenceLevel: "insufficient",
          hasObservedCollaboration: true,
          recencyBand: "past_month",
        },
      }).kind,
    ).toBe("insufficient");
  });
});

describe("attention", () => {
  it("puts an overdue deliverable ahead of a saved hotel and does not merge opportunities", () => {
    const saved = row({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      status: "saved",
      displayRef: "OP-1001",
    });
    const replied = row({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      status: "replied",
      displayRef: "OP-1042",
      hotelId: saved.hotelId,
    });
    const board = buildAttention({
      rows: [saved, replied],
      rowsFailed: false,
      rowsCapped: false,
      deadlineRead: "ok",
      asOf: AS_OF,
      hrefFor: (item) => `/app/hotels/${item.hotelId}/pitch?item=${item.id}`,
      deadlines: [
        {
          pipelineItemId: saved.id,
          hotelId: saved.hotelId ?? "",
          hotelName: saved.hotelName,
          state: "overdue",
          dueOn: "2026-10-01",
          href: "/app/hotels/hotel-1#collaboration",
        },
      ],
    });
    expect(board.actions.map((action) => action.pipelineItemId)).toEqual([saved.id, replied.id]);
    expect(board.actions[0]?.detail).toContain("Overdue");
    expect(board.actions[0]?.detail).not.toContain("OP-1042");
    expect(board.actions[1]?.href).toContain(replied.id);
    expect(board.actions[1]?.href).not.toContain(saved.id);
    expect(board.empty).toBeNull();
  });

  it("does not describe a failed read as an empty list", () => {
    const board = buildAttention({
      rows: [],
      rowsFailed: true,
      rowsCapped: false,
      deadlineRead: "error",
      asOf: AS_OF,
      hrefFor: () => null,
      deadlines: [],
    });
    expect(board.empty).toBeNull();
    expect(board.notices.join(" ")).toMatch(/not an empty list/);
    expect(board.notices.join(" ")).toMatch(/does not mean nothing is due/);
  });
});

describe("stay window", () => {
  it("requires a real pair and does not invent dates", () => {
    expect(stayWindow({ stayStart: "2026-11-12", stayEnd: "2026-11-19" })).toBe(
      "2026-11-12 – 2026-11-19",
    );
    expect(stayWindow({ stayStart: "2026-11-12", stayEnd: null })).toBeNull();
    expect(stayWindow({ stayStart: null, stayEnd: null })).toBeNull();
  });
});

describe("next step", () => {
  it("uses a recorded follow-up date and does not invent a reason", () => {
    const step = nextStep(
      row({
        id: "c",
        status: "pitched",
        nextFollowupAt: "2026-10-10",
        displayRef: "OP-1054",
      }),
      AS_OF,
    );
    expect(step.title).toBe("Follow-up date 2026-10-10");
    expect(step.detail).not.toMatch(/portfolio|sample|strength|score/i);
  });
});
