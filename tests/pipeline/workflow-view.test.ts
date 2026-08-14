/**
 * Workflow UI behavior (Sprint 2C — PRD §7.4, EVENTS.md §5).
 *
 * The Hotel Detail workflow surface renders whatever these pure functions
 * decide, so the product rules live here: only legal steps are offered, a
 * failed relationship load offers nothing at all, a retry reads as success,
 * and only a genuine commercial limit may sell an upgrade.
 */
import { describe, expect, it } from "vitest";

import { FREE_LIMITS } from "@/lib/config";
import { ALL_PIPELINE_ACTIONS, parseEventInstant, parseWorkflowForm } from "@/lib/pipeline/input";
import {
  CLOSE_REASONS,
  OFFER_TYPES,
  OUTREACH_CHANNELS,
  PIPELINE_STATUSES,
  REPLY_SENTIMENTS,
  WORKFLOW_ACTIONS,
  channelLabel,
  closeReasonLabel,
  mapTransitionResult,
  offerTypeLabel,
  sentimentLabel,
  transitionResultMessage,
  workflowActionLabel,
  type TransitionResult,
} from "@/lib/pipeline/types";
import {
  activityPanelState,
  availableActions,
  engagedLimitExplanation,
  shouldOfferSave,
  shouldOfferWorkflow,
  shouldOfferWorkflowUpgrade,
  workflowControlState,
} from "@/lib/pipeline/view";

const ITEM = "11111111-1111-1111-1111-111111111111";

function open(status: string) {
  return activityPanelState({ status: "open", relationship: { status } });
}

describe("action availability by status", () => {
  it("offers exactly the steps the workflow allows from each stage", () => {
    expect(availableActions("saved")).toEqual(["plan", "mark_pitched", "close"]);
    expect(availableActions("planned")).toEqual(["mark_pitched", "close"]);
    expect(availableActions("pitched")).toEqual(["mark_followup_sent", "mark_replied", "close"]);
    expect(availableActions("follow_up")).toEqual(["mark_replied", "close"]);
    // The deal path (Sprint 2D) is covered in deal-view.test.ts.
    expect(availableActions("replied")).toEqual(["start_negotiation", "close"]);
  });

  it("offers nothing for stages this slice does not implement", () => {
    // A won cycle is finished here: closing it belongs to the collaboration
    // lifecycle, which is a later sprint.
    expect(availableActions("won")).toEqual([]);
    expect(availableActions("closed")).toEqual([]);
    expect(availableActions(null)).toEqual([]);
    expect(availableActions("nonsense")).toEqual([]);
  });

  it("never offers a control the server has no action for", () => {
    const offered = PIPELINE_STATUSES.flatMap((s) => availableActions(s));
    // Collaboration execution/completion are not implemented anywhere yet.
    expect(offered).not.toContain("collaboration_started");
    expect(offered).not.toContain("collaboration_completed");
    // Every offered action is one of the two RPC families the server accepts.
    for (const action of offered) {
      expect(ALL_PIPELINE_ACTIONS).toContain(action);
    }
  });

  it("close is available from every stage this slice supports", () => {
    for (const status of ["saved", "planned", "pitched", "follow_up", "replied", "negotiating"]) {
      expect(availableActions(status)).toContain("close");
    }
  });
});

describe("workflow is only offered when the relationship is known", () => {
  it("offers controls for a loaded open cycle", () => {
    expect(shouldOfferWorkflow(open("pitched"))).toBe(true);
  });

  it("offers NO workflow control when the relationship failed to load", () => {
    const failed = activityPanelState({ status: "error" });
    expect(failed.kind).toBe("load_error");
    expect(shouldOfferWorkflow(failed)).toBe(false);
    // …and still does not invite a save either (Sprint 2B F1).
    expect(shouldOfferSave(failed)).toBe(false);
  });

  it("offers no workflow control when there is no open cycle", () => {
    expect(shouldOfferWorkflow(activityPanelState({ status: "none" }))).toBe(false);
    expect(shouldOfferWorkflow(open("closed"))).toBe(false);
  });

  it("a closed cycle returns to Save-capable behavior", () => {
    const closed = open("closed");
    expect(closed.kind).toBe("unsaved");
    expect(shouldOfferSave(closed)).toBe(true);
    expect(shouldOfferWorkflow(closed)).toBe(false);
  });
});

describe("transition result state", () => {
  it("a successful transition reports the new status", () => {
    const state = workflowControlState({ result: "applied", status: "pitched" });
    expect(state).toEqual({ kind: "applied", message: "Updated to Pitched.", status: "pitched" });
  });

  it("already_applied reads as success, not failure", () => {
    const state = workflowControlState({ result: "already_applied", status: "follow_up" });
    expect(state.kind).toBe("applied");
    expect(state.kind === "applied" && state.message).toContain("Already Follow-up");
    expect(shouldOfferWorkflowUpgrade(state)).toBe(false);
  });

  it("nothing is shown before the creator acts", () => {
    expect(workflowControlState(null)).toEqual({ kind: "idle" });
  });
});

describe("engaged-limit state", () => {
  const limited: TransitionResult = {
    result: "engaged_limit_reached",
    limit: FREE_LIMITS.activePipelineItems,
    engagedCount: FREE_LIMITS.activePipelineItems,
  };

  it("uses truthful copy and the server's limit number", () => {
    const state = workflowControlState(limited);
    expect(state.kind).toBe("limit");
    if (state.kind !== "limit") throw new Error("unreachable");
    expect(state.message).toBe("You’ve reached the Free active-pipeline limit.");
    expect(state.explanation).toBe(
      `You can actively work up to ${FREE_LIMITS.activePipelineItems} hotel relationships on Free.`,
    );
    // Saved hotels are not lost, and the copy says so.
    expect(state.note).toBe("Your saved hotels stay saved — only active outreach is limited.");
    expect(state.limit).toBe(FREE_LIMITS.activePipelineItems);
  });

  it("reports whatever limit the server enforced, not a hard-coded 5", () => {
    expect(engagedLimitExplanation(3)).toContain("up to 3 hotel relationships");
  });

  it("the engaged limit is the ONLY workflow state that offers an upgrade", () => {
    expect(shouldOfferWorkflowUpgrade(workflowControlState(limited))).toBe(true);
    for (const result of [
      { result: "error" },
      { result: "invalid_transition" },
      { result: "invalid_input" },
      { result: "invalid_event_time" },
      { result: "pipeline_item_not_found" },
      { result: "creator_profile_missing" },
      { result: "applied", status: "closed" },
      null,
    ] as (TransitionResult | null)[]) {
      expect(shouldOfferWorkflowUpgrade(workflowControlState(result))).toBe(false);
    }
  });
});

describe("sanitized results", () => {
  it("maps every unrecognized RPC payload to a neutral error", () => {
    for (const payload of [
      null,
      undefined,
      "",
      7,
      {},
      { result: "boom" },
      { error: 'null value in column "status" violates not-null constraint' },
      { result: "applied" }, // applied without a status is not usable
    ]) {
      expect(mapTransitionResult(payload)).toEqual({ result: "error" });
    }
  });

  it("maps each real outcome to its typed shape", () => {
    expect(mapTransitionResult({ result: "applied", status: "planned" })).toEqual({
      result: "applied",
      status: "planned",
    });
    expect(
      mapTransitionResult({ result: "engaged_limit_reached", limit: 5, engaged_count: 5 }),
    ).toEqual({ result: "engaged_limit_reached", limit: 5, engagedCount: 5 });
    for (const r of [
      "invalid_transition",
      "invalid_input",
      "invalid_event_time",
      "pipeline_item_not_found",
      "creator_profile_missing",
    ]) {
      expect(mapTransitionResult({ result: r })).toEqual({ result: r });
    }
  });

  it("never renders SQL or internal detail to the creator", () => {
    for (const result of [
      { result: "error" },
      { result: "invalid_transition" },
      { result: "invalid_input" },
      { result: "invalid_event_time" },
      { result: "pipeline_item_not_found" },
      { result: "creator_profile_missing" },
    ] as TransitionResult[]) {
      const message = transitionResultMessage(result);
      expect(message).not.toMatch(
        /\b(pg|postgres|postgrest|constraint|relation|column|sql|permission denied)\b/i,
      );
      expect(workflowControlState(result).kind).toBe("problem");
    }
  });
});

describe("human labels and option vocabularies", () => {
  it("labels every action in plain words", () => {
    expect(WORKFLOW_ACTIONS.map(workflowActionLabel)).toEqual([
      "Plan outreach",
      "Mark as pitched",
      "Mark follow-up sent",
      "Mark replied",
      "Close",
    ]);
  });

  it("uses the canonical channel vocabulary from migration 0006", () => {
    expect(OUTREACH_CHANNELS).toEqual([
      "email",
      "instagram",
      "linkedin",
      "website_form",
      "whatsapp",
      "in_person",
      "other",
    ]);
    expect(OUTREACH_CHANNELS.map(channelLabel)).toEqual([
      "Email",
      "Instagram",
      "LinkedIn",
      "Website form",
      "WhatsApp",
      "In person",
      "Other",
    ]);
  });

  it("uses the canonical sentiment, offer and close vocabularies", () => {
    expect(REPLY_SENTIMENTS.map(sentimentLabel)).toEqual(["Positive", "Negative", "Unclear"]);
    expect(OFFER_TYPES.map(offerTypeLabel)).toEqual([
      "Stay",
      "Product",
      "Paid",
      "Stay + paid",
      "Other",
    ]);
    expect(CLOSE_REASONS.map(closeReasonLabel)).toEqual([
      "No reply",
      "Rejected",
      "Not a fit",
      "Timing",
      "Other",
    ]);
  });

  it("no label leaks a raw enum value", () => {
    for (const label of [
      ...OUTREACH_CHANNELS.map(channelLabel),
      ...OFFER_TYPES.map(offerTypeLabel),
      ...CLOSE_REASONS.map(closeReasonLabel),
    ]) {
      expect(label).not.toMatch(/_/);
    }
  });
});

describe("form input validation", () => {
  const base = { pipelineItemId: ITEM };

  it("rejects a missing or malformed item id and an unknown action", () => {
    expect(parseWorkflowForm({ pipelineItemId: "nope", action: "plan" }).ok).toBe(false);
    expect(parseWorkflowForm({ ...base, action: "mark_won" }).ok).toBe(false);
    expect(parseWorkflowForm({ ...base, action: "" }).ok).toBe(false);
    expect(parseWorkflowForm({ ...base }).ok).toBe(false);
  });

  it("plan needs nothing else and forwards nothing else", () => {
    const parsed = parseWorkflowForm({ ...base, action: "plan", channel: "email" });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.value).toEqual({
      pipelineItemId: ITEM,
      action: "plan",
      eventAt: null,
      channel: null,
      sentiment: null,
      offerType: null,
      closeReason: null,
    });
  });

  it("mark_pitched requires an instant AND a known channel", () => {
    expect(
      parseWorkflowForm({ ...base, action: "mark_pitched", eventAt: "2026-08-01T00:00:00.000Z" })
        .ok,
    ).toBe(false);
    expect(parseWorkflowForm({ ...base, action: "mark_pitched", channel: "email" }).ok).toBe(false);
    expect(
      parseWorkflowForm({
        ...base,
        action: "mark_pitched",
        eventAt: "2026-08-01T00:00:00.000Z",
        channel: "carrier_pigeon",
      }).ok,
    ).toBe(false);

    const parsed = parseWorkflowForm({
      ...base,
      action: "mark_pitched",
      eventAt: "2026-08-01T00:00:00.000Z",
      channel: "email",
    });
    expect(parsed.ok && parsed.value.eventAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("mark_followup_sent requires an instant; the channel is optional", () => {
    expect(parseWorkflowForm({ ...base, action: "mark_followup_sent" }).ok).toBe(false);
    const parsed = parseWorkflowForm({
      ...base,
      action: "mark_followup_sent",
      eventAt: "2026-08-02T07:00:00.000Z",
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.channel).toBeNull();
  });

  it("mark_replied requires an instant and a known sentiment; the offer is optional", () => {
    expect(
      parseWorkflowForm({ ...base, action: "mark_replied", eventAt: "2026-08-02T07:00:00.000Z" })
        .ok,
    ).toBe(false);
    expect(
      parseWorkflowForm({
        ...base,
        action: "mark_replied",
        eventAt: "2026-08-02T07:00:00.000Z",
        sentiment: "delighted",
      }).ok,
    ).toBe(false);

    // "None yet" in the form is an absence, not an offer.
    const none = parseWorkflowForm({
      ...base,
      action: "mark_replied",
      eventAt: "2026-08-02T07:00:00.000Z",
      sentiment: "positive",
      offerType: "none",
    });
    expect(none.ok && none.value.offerType).toBeNull();

    const offered = parseWorkflowForm({
      ...base,
      action: "mark_replied",
      eventAt: "2026-08-02T07:00:00.000Z",
      sentiment: "positive",
      offerType: "stay_plus_paid",
    });
    expect(offered.ok && offered.value.offerType).toBe("stay_plus_paid");

    expect(
      parseWorkflowForm({
        ...base,
        action: "mark_replied",
        eventAt: "2026-08-02T07:00:00.000Z",
        sentiment: "positive",
        offerType: "equity",
      }).ok,
    ).toBe(false);
  });

  it("close requires a known reason", () => {
    expect(parseWorkflowForm({ ...base, action: "close" }).ok).toBe(false);
    expect(parseWorkflowForm({ ...base, action: "close", closeReason: "bored" }).ok).toBe(false);
    for (const reason of CLOSE_REASONS) {
      expect(parseWorkflowForm({ ...base, action: "close", closeReason: reason }).ok).toBe(true);
    }
  });

  it("accepts only a real instant, never a bare calendar date", () => {
    expect(parseEventInstant("2026-08-13T09:30:00.000Z")).toBe("2026-08-13T09:30:00.000Z");
    expect(parseEventInstant("2026-08-13T00:00:00+12:00")).toBe("2026-08-12T12:00:00.000Z");
    for (const bad of [
      null,
      "",
      // A bare day would be read as UTC midnight — the ambiguity this avoids.
      "2026-08-13",
      "13/08/2026",
      "2026-02-31T00:00:00.000Z",
      "yesterday",
    ]) {
      expect(parseEventInstant(bad)).toBeNull();
    }
  });

  it("never forwards identity, plan or limit fields even when posted", () => {
    const parsed = parseWorkflowForm({
      ...base,
      action: "plan",
      // Extra keys a hostile client might add are simply not in the contract.
      ...({ userId: "x", creatorId: "y", isPro: "true", limit: "999" } as Record<string, string>),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(Object.keys(parsed.value).sort()).toEqual([
      "action",
      "channel",
      "closeReason",
      "eventAt",
      "offerType",
      "pipelineItemId",
      "sentiment",
    ]);
  });
});
