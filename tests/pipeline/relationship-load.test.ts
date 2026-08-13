/**
 * F1 — an open-relationship query error is not "unsaved".
 *
 * `getOpenRelationship` used to answer `null` for both "there is genuinely no
 * relationship" and "the query failed", which made Hotel Detail invite the
 * creator to save a hotel that may already be in their pipeline.
 *
 * These drive the real query function with an injected stand-in client, so the
 * shipped code path is what gets verified.
 */
import { describe, expect, it } from "vitest";

import { getOpenRelationship, type PipelineQueryClient } from "@/lib/pipeline/queries";
import { activityPanelState, shouldOfferSave } from "@/lib/pipeline/view";

type Outcome = { data: unknown; error: unknown };

/** Minimal chainable PostgREST stand-in; awaiting/maybeSingle resolves it. */
function fakeClient(outcome: Outcome): PipelineQueryClient {
  const chain: Record<string, unknown> = {
    select: () => chain,
    eq: () => chain,
    neq: () => chain,
    maybeSingle: () => Promise.resolve(outcome),
  };
  return { from: () => chain } as unknown as PipelineQueryClient;
}

const HOTEL = "aa000000-0000-0000-0000-000000000001";

describe("getOpenRelationship is tri-state", () => {
  it("an open row → open, carrying the row's id and status", async () => {
    const result = await getOpenRelationship(
      HOTEL,
      fakeClient({ data: { id: "p1", status: "pitched" }, error: null }),
    );
    expect(result).toEqual({
      status: "open",
      relationship: { pipelineItemId: "p1", status: "pitched" },
    });
    const state = activityPanelState(result);
    expect(state.kind).toBe("open_cycle");
    expect(shouldOfferSave(state)).toBe(false);
  });

  it("a successful query with no row → none, and Save is offered", async () => {
    const result = await getOpenRelationship(HOTEL, fakeClient({ data: null, error: null }));
    expect(result).toEqual({ status: "none" });
    expect(shouldOfferSave(activityPanelState(result))).toBe(true);
  });

  it("a query/transport failure → error, NEVER none", async () => {
    for (const error of [
      { code: "57014", message: "canceling statement due to statement timeout" },
      { message: "TypeError: fetch failed" },
      { code: "PGRST301", message: "JWT expired" },
    ]) {
      const result = await getOpenRelationship(HOTEL, fakeClient({ data: null, error }));
      expect(result).toEqual({ status: "error" });
      expect(result.status).not.toBe("none");

      const state = activityPanelState(result);
      expect(state.kind).toBe("load_error");
      expect(shouldOfferSave(state)).toBe(false);
      expect(state).not.toHaveProperty("title", "Not saved yet");
    }
  });

  it("an error alongside a row is still an error, not a relationship", async () => {
    const result = await getOpenRelationship(
      HOTEL,
      fakeClient({ data: { id: "p1", status: "saved" }, error: { message: "boom" } }),
    );
    expect(result).toEqual({ status: "error" });
  });

  it("an id that cannot match any row is a genuine none, not an error", async () => {
    const result = await getOpenRelationship("not-a-uuid", fakeClient({ data: null, error: null }));
    expect(result).toEqual({ status: "none" });
  });
});
