/**
 * Deal-path UI behavior (Sprint 2D — PRD §7.4, EVENTS.md §5).
 *
 * The product rules the surface depends on: only legal steps are offered, a
 * won cycle offers nothing, a retry reads as success, no deal outcome sells an
 * upgrade, and — on a won cycle — "we couldn't load the collaboration" and
 * "there isn't one" are two different states, neither of them a blank panel.
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  actionFamily,
  localDateToIso,
  parseDealForm,
  parseWorkflowForm,
} from "@/lib/pipeline/input";
import {
  COLLABORATION_TYPES,
  DEAL_ACTIONS,
  PIPELINE_STATUSES,
  collaborationTypeLabel,
  dealResultMessage,
  isDealAction,
  mapDealResult,
  pipelineActionLabel,
  type DealResult,
} from "@/lib/pipeline/types";
import {
  COLLABORATION_COPY,
  availableActions,
  collaborationPanelState,
  dealControlState,
  shouldOfferDealUpgrade,
  type CollaborationLoadState,
} from "@/lib/pipeline/view";

const ITEM = "11111111-1111-1111-1111-111111111111";
const ORIGINAL_TZ = process.env.TZ;

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

describe("available actions along the deal path", () => {
  it("replied offers start negotiation and close", () => {
    expect(availableActions("replied")).toEqual(["start_negotiation", "close"]);
  });

  it("negotiating offers mark won and close", () => {
    expect(availableActions("negotiating")).toEqual(["mark_won", "close"]);
  });

  it("won offers nothing — closing it belongs to the collaboration lifecycle", () => {
    expect(availableActions("won")).toEqual([]);
    expect(availableActions("won")).not.toContain("close");
  });

  it("the deal actions appear only where the database accepts them", () => {
    const startable = PIPELINE_STATUSES.filter((s) =>
      availableActions(s).includes("start_negotiation"),
    );
    const winnable = PIPELINE_STATUSES.filter((s) => availableActions(s).includes("mark_won"));
    expect(startable).toEqual(["replied"]);
    expect(winnable).toEqual(["negotiating"]);
  });

  it("the earlier workflow stages are untouched by Sprint 2D", () => {
    expect(availableActions("saved")).toEqual(["plan", "mark_pitched", "close"]);
    expect(availableActions("planned")).toEqual(["mark_pitched", "close"]);
    expect(availableActions("pitched")).toEqual(["mark_followup_sent", "mark_replied", "close"]);
    expect(availableActions("follow_up")).toEqual(["mark_replied", "close"]);
    expect(availableActions("closed")).toEqual([]);
  });

  it("routes each offered action to the right RPC family", () => {
    for (const status of PIPELINE_STATUSES) {
      for (const action of availableActions(status)) {
        expect(actionFamily(action)).toBe(isDealAction(action) ? "deal" : "workflow");
      }
    }
    expect(actionFamily("collaboration_started")).toBeNull();
  });

  it("labels the deal actions in plain words", () => {
    expect(DEAL_ACTIONS.map(pipelineActionLabel)).toEqual(["Start negotiation", "Mark as won"]);
  });
});

describe("deal result state", () => {
  it("a successful transition reports the new status", () => {
    expect(
      dealControlState({ result: "applied", status: "negotiating", collaborationId: null }),
    ).toEqual({ kind: "applied", message: "Updated to Negotiating.", status: "negotiating" });
  });

  it("winning announces the collaboration rather than a status change", () => {
    const state = dealControlState({ result: "applied", status: "won", collaborationId: "c1" });
    expect(state).toEqual({ kind: "applied", message: "Collaboration agreed.", status: "won" });
  });

  it("already_applied reads as success, not failure", () => {
    const state = dealControlState({
      result: "already_applied",
      status: "won",
      collaborationId: "c1",
    });
    expect(state.kind).toBe("applied");
    expect(state.kind === "applied" && state.message).toContain("already recorded");
  });

  it("nothing is shown before the creator acts", () => {
    expect(dealControlState(null)).toEqual({ kind: "idle" });
  });

  it("NO deal outcome ever offers an upgrade — none of them is a limit", () => {
    for (const result of [
      { result: "applied", status: "won", collaborationId: "c1" },
      { result: "invalid_transition" },
      { result: "invalid_input" },
      { result: "invalid_event_time" },
      { result: "integrity_error" },
      { result: "error" },
      null,
    ] as (DealResult | null)[]) {
      expect(shouldOfferDealUpgrade(dealControlState(result))).toBe(false);
    }
  });

  it("a technical failure is a neutral problem, never a commercial wall", () => {
    for (const result of [
      { result: "error" },
      { result: "invalid_transition" },
      { result: "pipeline_item_not_found" },
      { result: "creator_profile_missing" },
      { result: "integrity_error" },
    ] as DealResult[]) {
      const state = dealControlState(result);
      expect(state.kind).toBe("problem");
      expect(shouldOfferDealUpgrade(state)).toBe(false);
    }
  });

  it("a future agreed date reads as a date problem, not a generic failure", () => {
    const state = dealControlState({ result: "invalid_event_time" });
    expect(state.kind).toBe("problem");
    expect(state.kind === "problem" && state.message).toBe(
      "That agreed date can’t be in the future.",
    );
  });

  it("never renders SQL or internal detail", () => {
    for (const result of [
      { result: "error" },
      { result: "integrity_error" },
      { result: "invalid_input" },
      { result: "invalid_transition" },
    ] as DealResult[]) {
      expect(dealResultMessage(result)).not.toMatch(
        /\b(pg|postgres|postgrest|constraint|relation|column|sql|permission denied)\b/i,
      );
    }
  });
});

describe("sanitized deal mapping", () => {
  it("maps every unrecognized payload to a neutral error", () => {
    for (const payload of [
      null,
      undefined,
      "",
      9,
      {},
      { result: "boom" },
      {
        error: 'duplicate key value violates unique constraint "collaborations_one_per_cycle_uidx"',
      },
      { result: "applied" }, // applied without a status is not usable
    ]) {
      expect(mapDealResult(payload)).toEqual({ result: "error" });
    }
  });

  it("carries the collaboration id through when the server supplies one", () => {
    expect(mapDealResult({ result: "applied", status: "won", collaboration_id: "c-1" })).toEqual({
      result: "applied",
      status: "won",
      collaborationId: "c-1",
    });
    expect(mapDealResult({ result: "applied", status: "negotiating" })).toEqual({
      result: "applied",
      status: "negotiating",
      collaborationId: null,
    });
  });

  it("maps each real failure to its typed shape", () => {
    for (const r of [
      "invalid_transition",
      "invalid_input",
      "invalid_event_time",
      "pipeline_item_not_found",
      "creator_profile_missing",
      "integrity_error",
    ]) {
      expect(mapDealResult({ result: r })).toEqual({ result: r });
    }
  });
});

describe("mark won form validation", () => {
  const base = { pipelineItemId: ITEM };

  it("start negotiation asks nothing and forwards nothing", () => {
    const parsed = parseDealForm({
      ...base,
      action: "start_negotiation",
      collaborationType: "stay",
      eventAt: "2026-08-01T00:00:00.000Z",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.value).toEqual({
      pipelineItemId: ITEM,
      action: "start_negotiation",
      agreedAt: null,
      collaborationType: null,
    });
  });

  it("mark won requires an agreed instant AND a known collaboration type", () => {
    expect(
      parseDealForm({ ...base, action: "mark_won", eventAt: "2026-08-01T00:00:00.000Z" }).ok,
    ).toBe(false);
    expect(parseDealForm({ ...base, action: "mark_won", collaborationType: "stay" }).ok).toBe(
      false,
    );
    expect(
      parseDealForm({
        ...base,
        action: "mark_won",
        eventAt: "2026-08-01T00:00:00.000Z",
        collaborationType: "crypto",
      }).ok,
    ).toBe(false);

    for (const type of COLLABORATION_TYPES) {
      const parsed = parseDealForm({
        ...base,
        action: "mark_won",
        eventAt: "2026-08-01T00:00:00.000Z",
        collaborationType: type,
      });
      expect(parsed.ok).toBe(true);
      expect(parsed.ok && parsed.value.collaborationType).toBe(type);
    }
  });

  it("rejects a bad item id, a workflow action, and an unknown action", () => {
    expect(parseDealForm({ pipelineItemId: "nope", action: "mark_won" }).ok).toBe(false);
    // A workflow action must not be smuggled through the deal parser.
    expect(parseDealForm({ ...base, action: "close", closeReason: "timing" }).ok).toBe(false);
    expect(parseDealForm({ ...base, action: "deal_won" }).ok).toBe(false);
    // …and vice versa.
    expect(parseWorkflowForm({ ...base, action: "mark_won" }).ok).toBe(false);
  });

  it("a bare calendar day is rejected rather than read as UTC midnight", () => {
    expect(
      parseDealForm({
        ...base,
        action: "mark_won",
        eventAt: "2026-08-01",
        collaborationType: "stay",
      }).ok,
    ).toBe(false);
  });

  it("never forwards identity or collaboration id even when posted", () => {
    const parsed = parseDealForm({
      ...base,
      action: "mark_won",
      eventAt: "2026-08-01T00:00:00.000Z",
      collaborationType: "stay",
      ...({ userId: "x", creatorId: "y", collaborationId: "z", currentStatus: "won" } as Record<
        string,
        string
      >),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(Object.keys(parsed.value).sort()).toEqual([
      "action",
      "agreedAt",
      "collaborationType",
      "pipelineItemId",
    ]);
  });
});

describe("the agreed date uses the creator's own timezone", () => {
  it("a far-eastern creator's local today is not a future instant", () => {
    process.env.TZ = "Pacific/Kiritimati"; // UTC+14
    const now = new Date();
    const today = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
    const iso = localDateToIso(today)!;

    const parsed = parseDealForm({
      pipelineItemId: ITEM,
      action: "mark_won",
      eventAt: iso,
      collaborationType: "stay",
    });
    expect(parsed.ok).toBe(true);
    // The DB's future guard would accept this; UTC midnight of the same day
    // could not be relied on to.
    expect(new Date(iso).getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
  });

  it("still converts historical dates with the offset in force that day", () => {
    process.env.TZ = "Europe/Madrid";
    expect(localDateToIso("2024-01-15")).toBe("2024-01-14T23:00:00.000Z");
    expect(localDateToIso("2024-07-15")).toBe("2024-07-14T22:00:00.000Z");
  });
});

describe("collaboration panel", () => {
  const found: CollaborationLoadState = {
    status: "found",
    collaboration: { collaborationType: "stay_plus_paid", agreedAt: "2026-08-01T00:00:00.000Z" },
  };

  it("is hidden for every status except won", () => {
    for (const status of PIPELINE_STATUSES.filter((s) => s !== "won")) {
      expect(collaborationPanelState({ status, load: found }).kind).toBe("hidden");
    }
  });

  it("shows the agreed collaboration on a won cycle", () => {
    const state = collaborationPanelState({ status: "won", load: found });
    // Sprint 2F widened this panel into the lifecycle surface; an agreed
    // collaboration is its first state.
    expect(state).toMatchObject({
      kind: "lifecycle",
      status: "agreed",
      title: "Collaboration agreed",
      typeLabel: "Stay + paid",
      agreedAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("a failed lookup is a recoverable error, NOT a missing collaboration", () => {
    const state = collaborationPanelState({ status: "won", load: { status: "error" } });
    expect(state.kind).toBe("load_error");
    if (state.kind !== "load_error") throw new Error("unreachable");
    expect(state.title).toBe(COLLABORATION_COPY.errorTitle);
    expect(state.body).toContain("not a missing collaboration");
    expect(state.kind).not.toBe("integrity_problem");
  });

  it("won with genuinely no collaboration is an integrity problem, not an empty state", () => {
    const state = collaborationPanelState({ status: "won", load: { status: "none" } });
    expect(state.kind).toBe("integrity_problem");
    if (state.kind !== "integrity_problem") throw new Error("unreachable");
    expect(state.title).toBe(COLLABORATION_COPY.integrityTitle);
    expect(state.body).toContain("Nothing was changed");
    // Never the reassuring "no collaboration yet" blank.
    expect(state.kind).not.toBe("agreed");
  });

  it("the error and the missing states are never the same message", () => {
    const error = collaborationPanelState({ status: "won", load: { status: "error" } });
    const missing = collaborationPanelState({ status: "won", load: { status: "none" } });
    expect(error).not.toEqual(missing);
  });

  it("shows no financial detail", () => {
    const state = collaborationPanelState({ status: "won", load: found });
    expect(Object.keys(state).sort()).toEqual([
      "actions",
      "agreedAt",
      "endDate",
      "kind",
      "startDate",
      "status",
      "title",
      "typeLabel",
    ]);
    for (const key of Object.keys(state)) {
      expect(key).not.toMatch(/value|amount|currency/i);
    }
  });

  it("labels every collaboration type in plain words", () => {
    expect(COLLABORATION_TYPES.map(collaborationTypeLabel)).toEqual([
      "Stay",
      "Product",
      "Paid",
      "Stay + paid",
      "Other",
    ]);
    for (const label of COLLABORATION_TYPES.map(collaborationTypeLabel)) {
      expect(label).not.toMatch(/_/);
    }
  });
});
