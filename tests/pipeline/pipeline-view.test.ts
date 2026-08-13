/**
 * Save-to-Pipeline and Pipeline-list view behavior (PRD §7.3/§7.4).
 *
 * The surfaces render whatever these pure functions decide, so the product
 * rules are asserted here rather than through a DOM renderer: Save is only
 * offered when there is no open cycle, a retry looks like success, only a real
 * commercial limit may sell an upgrade, and a technical failure never renders
 * as "your pipeline is empty".
 */
import { describe, expect, it } from "vitest";

import { FREE_LIMITS } from "@/lib/config";
import {
  PIPELINE_STATUSES,
  isSaveSuccessful,
  mapSaveResult,
  pipelineStatusLabel,
  saveResultMessage,
  type SaveResult,
} from "@/lib/pipeline/types";
import {
  PIPELINE_COPY,
  activityPanelState,
  freeLimitExplanation,
  normalizeStatusFilter,
  pipelineListState,
  saveControlState,
  shouldOfferUpgrade,
} from "@/lib/pipeline/view";

const CREATED: SaveResult = {
  result: "created",
  pipelineItemId: "11111111-1111-1111-1111-111111111111",
  status: "saved",
};

describe("Hotel Detail — Save state", () => {
  it("offers Save when the creator has no relationship with the hotel", () => {
    expect(activityPanelState(null)).toEqual({ kind: "unsaved" });
    expect(activityPanelState(undefined)).toEqual({ kind: "unsaved" });
    expect(saveControlState(null)).toEqual({ kind: "prompt" });
  });

  it("offers Save again once the previous cycle is closed (D023)", () => {
    expect(activityPanelState({ status: "closed" })).toEqual({ kind: "unsaved" });
  });
});

describe("Hotel Detail — already-saved state", () => {
  it("shows the human status and never re-offers Save while a cycle is open", () => {
    for (const status of PIPELINE_STATUSES.filter((s) => s !== "closed")) {
      const state = activityPanelState({ status });
      expect(state.kind).toBe("open_cycle");
      if (state.kind !== "open_cycle") throw new Error("unreachable");
      expect(state.statusLabel).toBe(pipelineStatusLabel(status));
      expect(state.statusLabel).not.toMatch(/_/);
    }
  });

  it("labels every status in human words", () => {
    expect(PIPELINE_STATUSES.map(pipelineStatusLabel)).toEqual([
      "Saved",
      "Planned",
      "Pitched",
      "Replied",
      "Follow-up",
      "Negotiating",
      "Won",
      "Closed",
    ]);
  });

  it("treats already_saved as success, exactly like a first save", () => {
    const retry: SaveResult = { result: "already_saved", pipelineItemId: "x", status: "saved" };
    expect(isSaveSuccessful(retry)).toBe(true);
    expect(saveControlState(retry).kind).toBe("saved");
    expect(saveControlState(CREATED).kind).toBe("saved");
    expect(shouldOfferUpgrade(saveControlState(retry))).toBe(false);
  });
});

describe("Hotel Detail — Free limit state", () => {
  const limited: SaveResult = {
    result: "limit_reached",
    limit: FREE_LIMITS.savedHotels,
    openCount: FREE_LIMITS.savedHotels,
  };

  it("uses the exact product copy and the server's limit number", () => {
    const state = saveControlState(limited);
    expect(state.kind).toBe("limit");
    if (state.kind !== "limit") throw new Error("unreachable");
    expect(state.message).toBe("You’ve reached the Free saved-hotel limit.");
    expect(state.message).toBe(PIPELINE_COPY.limitTitle);
    expect(state.explanation).toBe(
      `You can keep up to ${FREE_LIMITS.savedHotels} open hotel relationships on Free.`,
    );
    expect(state.limit).toBe(FREE_LIMITS.savedHotels);
  });

  it("reports whatever limit the server enforced, not a hard-coded 10", () => {
    expect(freeLimitExplanation(3)).toContain("up to 3 open hotel relationships");
  });

  it("offers the upgrade CTA ONLY for a real commercial limit", () => {
    expect(shouldOfferUpgrade(saveControlState(limited))).toBe(true);
    for (const result of [
      { result: "error" },
      { result: "hotel_not_found" },
      { result: "creator_profile_missing" },
      CREATED,
      null,
    ] as (SaveResult | null)[]) {
      expect(shouldOfferUpgrade(saveControlState(result))).toBe(false);
    }
  });
});

describe("sanitized errors", () => {
  it("maps every unrecognized RPC payload to a neutral error", () => {
    for (const payload of [
      null,
      undefined,
      "",
      42,
      {},
      { result: "boom" },
      { error: 'duplicate key value violates unique constraint "pipeline_items_pkey"' },
      { result: "created" }, // created without an id is not a usable success
    ]) {
      expect(mapSaveResult(payload)).toEqual({ result: "error" });
    }
  });

  it("never renders SQL or internal detail to the creator", () => {
    for (const result of [
      { result: "error" },
      { result: "hotel_not_found" },
      { result: "creator_profile_missing" },
    ] as SaveResult[]) {
      const message = saveResultMessage(result);
      expect(message).not.toMatch(/pg|postgres|constraint|relation|sql|null value/i);
      expect(saveControlState(result).kind).toBe("problem");
    }
  });

  it("a save failure is never presented as a limit", () => {
    expect(saveControlState({ result: "error" }).kind).not.toBe("limit");
  });
});

describe("Pipeline list state", () => {
  const item = { id: "a" };

  it("shows the empty pipeline copy with a Discover CTA", () => {
    const state = pipelineListState({ failed: false, items: [], status: null });
    expect(state).toEqual({
      kind: "empty",
      title: "Your pipeline is empty",
      body: "Save a hotel from Discover to start tracking your outreach.",
    });
    expect(PIPELINE_COPY.emptyCta).toBe("Discover hotels");
  });

  it("distinguishes an empty FILTER from an empty pipeline", () => {
    const filtered = pipelineListState({ failed: false, items: [], status: "pitched" });
    expect(filtered.kind).toBe("empty_filtered");
    expect(filtered).not.toHaveProperty("body", PIPELINE_COPY.emptyBody);
  });

  it("a failed query renders an error, NOT an empty pipeline", () => {
    for (const input of [
      { failed: true, items: [], status: null },
      { failed: false, items: null, status: null },
      { failed: true, items: null, status: "saved" },
    ]) {
      const state = pipelineListState(input);
      expect(state.kind).toBe("error");
      if (state.kind !== "error") throw new Error("unreachable");
      expect(state.title).toBe(PIPELINE_COPY.errorTitle);
      expect(state.title).not.toBe(PIPELINE_COPY.emptyTitle);
    }
  });

  it("summarizes the rows, pluralizing and naming the active filter", () => {
    expect(pipelineListState({ failed: false, items: [item], status: null })).toEqual({
      kind: "items",
      count: 1,
      summary: "1 hotel",
    });
    expect(pipelineListState({ failed: false, items: [item, item], status: null })).toEqual({
      kind: "items",
      count: 2,
      summary: "2 hotels",
    });
    expect(pipelineListState({ failed: false, items: [item], status: "follow_up" })).toMatchObject({
      summary: "1 hotel with status Follow-up",
    });
  });
});

describe("status filter parsing", () => {
  it("accepts known statuses only", () => {
    for (const status of PIPELINE_STATUSES) {
      expect(normalizeStatusFilter(status)).toBe(status);
    }
    expect(normalizeStatusFilter(["won", "saved"])).toBe("won");
  });

  it("treats anything unknown as no filter", () => {
    for (const raw of [undefined, null, "", "SAVED", "drop table", "unknown"]) {
      expect(normalizeStatusFilter(raw)).toBeNull();
    }
  });
});
