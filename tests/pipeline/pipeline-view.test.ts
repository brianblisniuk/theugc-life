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
import { contactSectionState } from "@/lib/hotels/access";
import { intelligencePanelState } from "@/lib/hotels/intelligence";
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
  pipelinePageHref,
  saveControlState,
  shouldOfferSave,
  shouldOfferUpgrade,
  type PipelinePageInput,
} from "@/lib/pipeline/view";

const CREATED: SaveResult = {
  result: "created",
  pipelineItemId: "11111111-1111-1111-1111-111111111111",
  status: "saved",
};

describe("Hotel Detail — Save state", () => {
  it("offers Save when the lookup succeeded and found no relationship", () => {
    const state = activityPanelState({ status: "none" });
    expect(state.kind).toBe("unsaved");
    expect(shouldOfferSave(state)).toBe(true);
    expect(saveControlState(null)).toEqual({ kind: "prompt" });
  });

  it("offers Save again once the previous cycle is closed (D023)", () => {
    const state = activityPanelState({ status: "open", relationship: { status: "closed" } });
    expect(state.kind).toBe("unsaved");
    expect(shouldOfferSave(state)).toBe(true);
  });
});

describe("Hotel Detail — a failed relationship lookup is not a domain fact (F1)", () => {
  const failed = activityPanelState({ status: "error" });

  it("renders a neutral recoverable notice, never 'Not saved yet'", () => {
    expect(failed.kind).toBe("load_error");
    if (failed.kind !== "load_error") throw new Error("unreachable");
    expect(failed.title).toBe("We couldn’t load your activity");
    expect(failed.body).toBe(
      "We couldn’t check whether this hotel is already in your pipeline. Reload the page to try again.",
    );
    expect(failed.title).not.toBe(PIPELINE_COPY.unsavedTitle);
    expect(failed).not.toHaveProperty("title", "Not saved yet");
  });

  it("does NOT offer Save, and infers no relationship status", () => {
    expect(shouldOfferSave(failed)).toBe(false);
    expect(failed.kind).not.toBe("unsaved");
    expect(failed.kind).not.toBe("open_cycle");
    expect(failed).not.toHaveProperty("status");
    expect(failed).not.toHaveProperty("statusLabel");
  });

  it("does NOT offer an upgrade — the save control is untouched by a load failure", () => {
    expect(saveControlState(null)).toEqual({ kind: "prompt" });
    expect(shouldOfferUpgrade(saveControlState(null))).toBe(false);
  });

  it("only an errored lookup produces the error state", () => {
    expect(activityPanelState({ status: "none" }).kind).toBe("unsaved");
    expect(activityPanelState({ status: "open", relationship: { status: "saved" } }).kind).toBe(
      "open_cycle",
    );
  });

  it("leaves the contact and intelligence sections untouched", () => {
    // The three sections are loaded independently; the relationship result is
    // not an input to either of the others.
    expect(
      contactSectionState({ access: { status: "allowed" }, contacts: [{}], failed: false }),
    ).toBe("contacts");
    expect(contactSectionState({ access: { status: "denied" }, contacts: [], failed: false })).toBe(
      "locked",
    );
    expect(intelligencePanelState({ status: "error" })).toBe("error");
    expect(intelligencePanelState({ status: "none" })).toBe("insufficient");
  });
});

describe("Hotel Detail — already-saved state", () => {
  it("shows the human status and never re-offers Save while a cycle is open", () => {
    for (const status of PIPELINE_STATUSES.filter((s) => s !== "closed")) {
      const state = activityPanelState({ status: "open", relationship: { status } });
      expect(state.kind).toBe("open_cycle");
      if (state.kind !== "open_cycle") throw new Error("unreachable");
      expect(state.statusLabel).toBe(pipelineStatusLabel(status));
      expect(state.statusLabel).not.toMatch(/_/);
      expect(shouldOfferSave(state)).toBe(false);
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

  /** One page of results, with sane defaults for the paging metadata. */
  function page(overrides: Partial<PipelinePageInput> & { items: readonly unknown[] }) {
    const items = overrides.items;
    const total = overrides.total ?? items.length;
    const pageSize = overrides.pageSize ?? 50;
    const totalPages = overrides.totalPages ?? (total === 0 ? 1 : Math.ceil(total / pageSize));
    const current = overrides.page ?? 1;
    return {
      items,
      total,
      pageSize,
      totalPages,
      page: current,
      hasPrevious: overrides.hasPrevious ?? current > 1,
      hasNext: overrides.hasNext ?? current < totalPages,
    } satisfies PipelinePageInput;
  }

  it("shows the empty pipeline copy with a Discover CTA", () => {
    const state = pipelineListState({ failed: false, page: page({ items: [] }), status: null });
    expect(state).toEqual({
      kind: "empty",
      title: "Your pipeline is empty",
      body: "Save a hotel from Discover to start tracking your outreach.",
    });
    expect(PIPELINE_COPY.emptyCta).toBe("Discover hotels");
  });

  it("distinguishes an empty FILTER from an empty pipeline", () => {
    const filtered = pipelineListState({
      failed: false,
      page: page({ items: [] }),
      status: "pitched",
    });
    expect(filtered.kind).toBe("empty_filtered");
    expect(filtered).not.toHaveProperty("body", PIPELINE_COPY.emptyBody);
  });

  it("a failed query renders an error, NOT an empty pipeline", () => {
    for (const input of [
      { failed: true, page: page({ items: [] }), status: null },
      { failed: false, page: null, status: null },
      { failed: true, page: null, status: "saved" },
    ]) {
      const state = pipelineListState(input);
      expect(state.kind).toBe("error");
      if (state.kind !== "error") throw new Error("unreachable");
      expect(state.title).toBe(PIPELINE_COPY.errorTitle);
      expect(state.title).not.toBe(PIPELINE_COPY.emptyTitle);
    }
  });

  it("summarizes the rows, pluralizing and naming the active filter", () => {
    expect(
      pipelineListState({ failed: false, page: page({ items: [item] }), status: null }),
    ).toMatchObject({ kind: "items", visible: 1, total: 1, summary: "1 hotel" });
    expect(
      pipelineListState({ failed: false, page: page({ items: [item, item] }), status: null }),
    ).toMatchObject({ kind: "items", visible: 2, total: 2, summary: "2 hotels" });
    expect(
      pipelineListState({ failed: false, page: page({ items: [item] }), status: "follow_up" }),
    ).toMatchObject({ summary: "1 hotel with status Follow-up" });
  });

  it("a single page needs no range line and no pagination controls", () => {
    const state = pipelineListState({
      failed: false,
      page: page({ items: Array.from({ length: 12 }, () => item) }),
      status: null,
    });
    expect(state).toMatchObject({ kind: "items", range: null, pagination: null });
  });

  it("states the WHOLE pipeline, not the page — 243 hotels showing 1-50", () => {
    const state = pipelineListState({
      failed: false,
      page: page({ items: Array.from({ length: 50 }, () => item), total: 243 }),
      status: null,
    });
    if (state.kind !== "items") throw new Error("unreachable");
    expect(state.summary).toBe("243 hotels");
    expect(state.summary).not.toBe("50 hotels");
    expect(state.visible).toBe(50);
    expect(state.total).toBe(243);
    expect(state.range).toBe("Showing 1\u201350");
  });

  it("computes the visible range from the page number", () => {
    const state = pipelineListState({
      failed: false,
      page: page({ items: Array.from({ length: 50 }, () => item), total: 243, page: 3 }),
      status: null,
    });
    if (state.kind !== "items") throw new Error("unreachable");
    expect(state.range).toBe("Showing 101\u2013150");
    expect(state.pagination).toMatchObject({
      page: 3,
      totalPages: 5,
      hasPrevious: true,
      hasNext: true,
      previousHref: "/app/pipeline?page=2",
      nextHref: "/app/pipeline?page=4",
      label: "Page 3 of 5",
    });
  });

  it("offers no Previous on the first page and no Next on the last", () => {
    const first = pipelineListState({
      failed: false,
      page: page({ items: Array.from({ length: 50 }, () => item), total: 243, page: 1 }),
      status: null,
    });
    const last = pipelineListState({
      failed: false,
      page: page({ items: Array.from({ length: 43 }, () => item), total: 243, page: 5 }),
      status: null,
    });
    if (first.kind !== "items" || last.kind !== "items") throw new Error("unreachable");
    expect(first.pagination).toMatchObject({ hasPrevious: false, previousHref: null });
    expect(last.pagination).toMatchObject({ hasNext: false, nextHref: null });
    expect(last.range).toBe("Showing 201\u2013243");
  });

  it("keeps the status filter in the paging links", () => {
    const state = pipelineListState({
      failed: false,
      page: page({ items: Array.from({ length: 50 }, () => item), total: 120, page: 2 }),
      status: "pitched",
    });
    if (state.kind !== "items") throw new Error("unreachable");
    expect(state.summary).toBe("120 hotels with status Pitched");
    expect(state.pagination?.previousHref).toBe("/app/pipeline?status=pitched");
    expect(state.pagination?.nextHref).toBe("/app/pipeline?status=pitched&page=3");
  });

  it("page 1 has exactly one URL spelling", () => {
    expect(pipelinePageHref(null, 1)).toBe("/app/pipeline");
    expect(pipelinePageHref("won", 1)).toBe("/app/pipeline?status=won");
    expect(pipelinePageHref("won", 4)).toBe("/app/pipeline?status=won&page=4");
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
