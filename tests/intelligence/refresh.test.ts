/**
 * Best-effort intelligence refresh (Sprint 2E, D008).
 *
 * The asymmetry under test: raw creator events are authoritative and already
 * committed by the time a refresh runs, so a failing aggregate must never turn
 * "your pitch was recorded" into an error — and a failed workflow must never
 * trigger a refresh at all.
 */
import { describe, expect, it } from "vitest";

import { shouldRefreshIntelligence, workflowResultAfterRefresh } from "@/lib/intelligence/refresh";
import { refreshIntelligenceForPipelineItem } from "@/lib/pipeline/queries";
import type { DealResult, TransitionResult } from "@/lib/pipeline/types";

const ITEM = "11111111-1111-1111-1111-111111111111";

/** Stand-in for the service-role client, recording what it was asked to do. */
function fakeAdmin(outcome: { error: unknown } | (() => never)) {
  const calls: { fn: string; args: Record<string, unknown> }[] = [];
  return {
    calls,
    client: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        if (typeof outcome === "function") outcome();
        return outcome as { error: unknown };
      },
    },
  };
}

describe("which outcomes trigger a refresh", () => {
  it("refreshes after an applied workflow mutation", () => {
    for (const result of [
      { result: "applied", status: "pitched" },
      { result: "applied", status: "follow_up" },
      { result: "applied", status: "replied" },
      { result: "applied", status: "closed" },
    ] as TransitionResult[]) {
      expect(shouldRefreshIntelligence(result)).toBe(true);
    }
  });

  it("refreshes after an applied deal step", () => {
    for (const result of [
      { result: "applied", status: "negotiating", collaborationId: null },
      { result: "applied", status: "won", collaborationId: "c1" },
    ] as DealResult[]) {
      expect(shouldRefreshIntelligence(result)).toBe(true);
    }
  });

  it("refreshes on a retry too — recomputation is idempotent and self-healing", () => {
    const retried: TransitionResult = { result: "already_applied", status: "pitched" };
    const retriedDeal: DealResult = {
      result: "already_applied",
      status: "won",
      collaborationId: "c",
    };
    expect(shouldRefreshIntelligence(retried)).toBe(true);
    expect(shouldRefreshIntelligence(retriedDeal)).toBe(true);
  });

  it("does NOT refresh when the workflow failed — nothing was written", () => {
    for (const result of [
      { result: "invalid_transition" },
      { result: "invalid_input" },
      { result: "invalid_event_time" },
      { result: "engaged_limit_reached", limit: 5, engagedCount: 5 },
      { result: "pipeline_item_not_found" },
      { result: "creator_profile_missing" },
      { result: "integrity_error" },
      { result: "error" },
      null,
      undefined,
    ] as (TransitionResult | DealResult | null | undefined)[]) {
      expect(shouldRefreshIntelligence(result)).toBe(false);
    }
  });
});

describe("the refresh cannot change the workflow's answer", () => {
  it("returns the workflow result untouched whatever the refresh did", () => {
    const applied: TransitionResult = { result: "applied", status: "pitched" };
    expect(workflowResultAfterRefresh(applied, true)).toBe(applied);
    expect(workflowResultAfterRefresh(applied, false)).toBe(applied);
  });

  it("a failing RPC is reported as not-refreshed, never thrown", async () => {
    const admin = fakeAdmin({ error: { message: "permission denied for function" } });
    await expect(refreshIntelligenceForPipelineItem(ITEM, admin.client)).resolves.toBe(false);
  });

  it("a throwing client is swallowed", async () => {
    const admin = fakeAdmin(() => {
      throw new Error("connect ECONNREFUSED");
    });
    await expect(refreshIntelligenceForPipelineItem(ITEM, admin.client)).resolves.toBe(false);
  });

  it("a successful refresh reports true", async () => {
    const admin = fakeAdmin({ error: null });
    await expect(refreshIntelligenceForPipelineItem(ITEM, admin.client)).resolves.toBe(true);
  });
});

describe("the refresh never trusts a browser-supplied hotel id", () => {
  it("sends ONLY the pipeline item id, and calls the wrapper RPC", async () => {
    const admin = fakeAdmin({ error: null });
    await refreshIntelligenceForPipelineItem(ITEM, admin.client);

    expect(admin.calls).toHaveLength(1);
    expect(admin.calls[0]!.fn).toBe("recompute_hotel_intelligence_for_pipeline_item");
    expect(admin.calls[0]!.args).toEqual({ p_pipeline_item_id: ITEM });
    // The hotel is resolved in the database, so no hotel id is ever sent.
    expect(Object.keys(admin.calls[0]!.args)).not.toContain("p_hotel_id");
  });

  it("refuses a malformed item id without calling anything", async () => {
    const admin = fakeAdmin({ error: null });
    for (const bad of ["", "not-a-uuid", "../../etc/passwd", "1 OR 1=1"]) {
      await expect(refreshIntelligenceForPipelineItem(bad, admin.client)).resolves.toBe(false);
    }
    expect(admin.calls).toHaveLength(0);
  });

  it("is safe to retry", async () => {
    const admin = fakeAdmin({ error: null });
    await refreshIntelligenceForPipelineItem(ITEM, admin.client);
    await refreshIntelligenceForPipelineItem(ITEM, admin.client);
    await refreshIntelligenceForPipelineItem(ITEM, admin.client);

    expect(admin.calls).toHaveLength(3);
    // Every call is identical: recomputation is a pure function of the ledger.
    expect(new Set(admin.calls.map((c) => JSON.stringify(c)))).toHaveProperty("size", 1);
  });
});
