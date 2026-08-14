/**
 * Collaboration lifecycle UI behavior (Sprint 2F, D045).
 *
 * The rules the panel depends on: controls exist only for a collaboration we
 * actually loaded, only the steps legal from the current status are offered, a
 * retry reads as success, and the two date shapes the database needs are
 * derived from the creator's own calendar day rather than the server's.
 */
import { afterEach, describe, expect, it } from "vitest";

import { localDateToIso, parseCalendarDate, parseCollaborationForm } from "@/lib/pipeline/input";
import {
  CANCELLATION_REASONS,
  COLLABORATION_ACTIONS,
  COLLABORATION_STATUSES,
  TERMS_MATCHED_VALUES,
  cancellationReasonLabel,
  collaborationActionLabel,
  collaborationResultMessage,
  collaborationStatusLabel,
  mapCollaborationResult,
  parseWouldWorkAgain,
  termsMatchedLabel,
  type CollaborationResult,
} from "@/lib/pipeline/types";
import {
  collaborationLifecycleActions,
  collaborationPanelState,
  lifecycleControlState,
  shouldOfferLifecycle,
  type CollaborationLoadState,
} from "@/lib/pipeline/view";
import { shouldRefreshIntelligence } from "@/lib/intelligence/refresh";

const ITEM = "11111111-1111-1111-1111-111111111111";
const ORIGINAL_TZ = process.env.TZ;

afterEach(() => {
  process.env.TZ = ORIGINAL_TZ;
});

function loaded(status: string): CollaborationLoadState {
  return {
    status: "found",
    collaboration: {
      status,
      collaborationType: "stay",
      agreedAt: "2026-08-01T00:00:00.000Z",
      startDate: "2026-08-05",
      endDate: null,
    },
  };
}

describe("controls exist only for a collaboration we actually loaded", () => {
  it("a failed collaboration read shows a recoverable error and NO controls", () => {
    const state = collaborationPanelState({ status: "won", load: { status: "error" } });
    expect(state.kind).toBe("load_error");
    expect(shouldOfferLifecycle(state)).toBe(false);
  });

  it("a won cycle with no collaboration is an integrity problem and NO controls", () => {
    const state = collaborationPanelState({ status: "won", load: { status: "none" } });
    expect(state.kind).toBe("integrity_problem");
    expect(shouldOfferLifecycle(state)).toBe(false);
  });

  it("the error and the missing states remain distinct", () => {
    expect(collaborationPanelState({ status: "won", load: { status: "error" } })).not.toEqual(
      collaborationPanelState({ status: "won", load: { status: "none" } }),
    );
  });

  it("the panel is hidden entirely for a cycle that is not won", () => {
    for (const status of ["saved", "planned", "pitched", "replied", "negotiating", "closed"]) {
      const state = collaborationPanelState({ status, load: loaded("agreed") });
      expect(state.kind).toBe("hidden");
      expect(shouldOfferLifecycle(state)).toBe(false);
    }
  });
});

describe("action availability by collaboration status", () => {
  it("agreed offers schedule, start and cancel", () => {
    expect(collaborationLifecycleActions("agreed")).toEqual(["schedule", "start", "cancel"]);
  });

  it("scheduled offers start and cancel — rescheduling is out of scope", () => {
    expect(collaborationLifecycleActions("scheduled")).toEqual(["start", "cancel"]);
    expect(collaborationLifecycleActions("scheduled")).not.toContain("schedule");
  });

  it("active offers complete and cancel", () => {
    expect(collaborationLifecycleActions("active")).toEqual(["complete", "cancel"]);
  });

  it("terminal states offer nothing", () => {
    expect(collaborationLifecycleActions("completed")).toEqual([]);
    expect(collaborationLifecycleActions("cancelled")).toEqual([]);
    expect(collaborationLifecycleActions(null)).toEqual([]);
    expect(collaborationLifecycleActions("nonsense")).toEqual([]);
  });

  it("every offered action is one the server accepts", () => {
    for (const status of COLLABORATION_STATUSES) {
      for (const action of collaborationLifecycleActions(status)) {
        expect(COLLABORATION_ACTIONS).toContain(action);
      }
    }
  });

  it("the panel surfaces the status, its dates and its actions", () => {
    const state = collaborationPanelState({ status: "won", load: loaded("active") });
    expect(state).toEqual({
      kind: "lifecycle",
      title: "Collaboration active",
      status: "active",
      typeLabel: "Stay",
      agreedAt: "2026-08-01T00:00:00.000Z",
      startDate: "2026-08-05",
      endDate: null,
      actions: ["complete", "cancel"],
    });
    expect(shouldOfferLifecycle(state)).toBe(true);
  });

  it("exposes no financial fields", () => {
    const state = collaborationPanelState({ status: "won", load: loaded("completed") });
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
  });
});

describe("lifecycle result state", () => {
  it("reports the new collaboration state on success", () => {
    expect(
      lifecycleControlState({
        result: "applied",
        collaborationStatus: "completed",
        pipelineStatus: "closed",
      }),
    ).toEqual({ kind: "applied", message: "Collaboration completed." });
  });

  it("already_applied reads as success, not failure", () => {
    const state = lifecycleControlState({
      result: "already_applied",
      collaborationStatus: "active",
      pipelineStatus: "won",
    });
    expect(state.kind).toBe("applied");
  });

  it("nothing is shown before the creator acts", () => {
    expect(lifecycleControlState(null)).toEqual({ kind: "idle" });
  });

  it("a technical failure is a neutral problem and never leaks internals", () => {
    for (const result of [
      { result: "error" },
      { result: "invalid_transition" },
      { result: "invalid_input" },
      { result: "invalid_event_time" },
      { result: "pipeline_item_not_found" },
      { result: "creator_profile_missing" },
      { result: "collaboration_not_found" },
      { result: "integrity_error" },
    ] as CollaborationResult[]) {
      const state = lifecycleControlState(result);
      expect(state.kind).toBe("problem");
      expect(collaborationResultMessage(result)).not.toMatch(
        /\b(pg|postgres|postgrest|constraint|relation|column|sql|permission denied)\b/i,
      );
    }
  });

  it("maps unrecognized payloads to a neutral error", () => {
    for (const payload of [
      null,
      undefined,
      "",
      3,
      {},
      { result: "boom" },
      { result: "applied" }, // no statuses is not a usable success
      { result: "applied", collaboration_status: "completed" }, // missing pipeline status
    ]) {
      expect(mapCollaborationResult(payload)).toEqual({ result: "error" });
    }
  });

  it("maps each real outcome to its typed shape", () => {
    expect(
      mapCollaborationResult({
        result: "applied",
        collaboration_status: "cancelled",
        pipeline_status: "closed",
      }),
    ).toEqual({ result: "applied", collaborationStatus: "cancelled", pipelineStatus: "closed" });
    for (const r of [
      "invalid_transition",
      "invalid_input",
      "invalid_event_time",
      "pipeline_item_not_found",
      "creator_profile_missing",
      "collaboration_not_found",
      "integrity_error",
    ]) {
      expect(mapCollaborationResult({ result: r })).toEqual({ result: r });
    }
  });
});

describe("form validation", () => {
  const base = { pipelineItemId: ITEM };

  it("schedule needs a start date and no event instant", () => {
    expect(parseCollaborationForm({ ...base, action: "schedule" }).ok).toBe(false);

    const parsed = parseCollaborationForm({
      ...base,
      action: "schedule",
      startDate: "2026-09-01",
      endDate: "2026-09-10",
      eventAt: "2026-09-01T00:00:00.000Z",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    // Planning emits no event, so no instant is forwarded.
    expect(parsed.value.eventAt).toBeNull();
    expect(parsed.value.startDate).toBe("2026-09-01");
    expect(parsed.value.endDate).toBe("2026-09-10");
  });

  it("schedule rejects an end date before the start", () => {
    expect(
      parseCollaborationForm({
        ...base,
        action: "schedule",
        startDate: "2026-09-10",
        endDate: "2026-09-01",
      }).ok,
    ).toBe(false);
  });

  it("start needs both the instant and the calendar day", () => {
    expect(parseCollaborationForm({ ...base, action: "start", startDate: "2026-09-01" }).ok).toBe(
      false,
    );
    expect(
      parseCollaborationForm({ ...base, action: "start", eventAt: "2026-09-01T00:00:00.000Z" }).ok,
    ).toBe(false);
    expect(
      parseCollaborationForm({
        ...base,
        action: "start",
        eventAt: "2026-09-01T00:00:00.000Z",
        startDate: "2026-09-01",
      }).ok,
    ).toBe(true);
  });

  it("complete needs an instant, an end date and a known terms answer", () => {
    const complete = (fields: Record<string, string>) =>
      parseCollaborationForm({ ...base, action: "complete", ...fields }).ok;

    expect(complete({ eventAt: "2026-09-05T00:00:00.000Z", endDate: "2026-09-05" })).toBe(false);
    expect(complete({ endDate: "2026-09-05", termsMatched: "yes" })).toBe(false);
    expect(complete({ eventAt: "2026-09-05T00:00:00.000Z", termsMatched: "yes" })).toBe(false);
    expect(
      complete({
        eventAt: "2026-09-05T00:00:00.000Z",
        endDate: "2026-09-05",
        termsMatched: "sortof",
      }),
    ).toBe(false);

    for (const terms of TERMS_MATCHED_VALUES) {
      expect(
        complete({
          eventAt: "2026-09-05T00:00:00.000Z",
          endDate: "2026-09-05",
          termsMatched: terms,
        }),
      ).toBe(true);
    }
  });

  it("cancel needs an instant and a known reason", () => {
    expect(parseCollaborationForm({ ...base, action: "cancel" }).ok).toBe(false);
    expect(
      parseCollaborationForm({
        ...base,
        action: "cancel",
        eventAt: "2026-09-05T00:00:00.000Z",
        cancelReason: "bored",
      }).ok,
    ).toBe(false);
    for (const reason of CANCELLATION_REASONS) {
      expect(
        parseCollaborationForm({
          ...base,
          action: "cancel",
          eventAt: "2026-09-05T00:00:00.000Z",
          cancelReason: reason,
        }).ok,
      ).toBe(true);
    }
  });

  it("refuses a bare calendar day where an instant is required", () => {
    expect(
      parseCollaborationForm({
        ...base,
        action: "start",
        eventAt: "2026-09-01",
        startDate: "2026-09-01",
      }).ok,
    ).toBe(false);
  });

  it("refuses an instant where a plain calendar day is required", () => {
    expect(parseCalendarDate("2026-09-01T00:00:00.000Z")).toBeNull();
    expect(parseCalendarDate("2026-09-01")).toBe("2026-09-01");
    for (const bad of [null, "", "2026-02-31", "01/09/2026", "tomorrow"]) {
      expect(parseCalendarDate(bad)).toBeNull();
    }
  });

  it("rejects a bad item id and an unknown action", () => {
    expect(parseCollaborationForm({ pipelineItemId: "nope", action: "start" }).ok).toBe(false);
    expect(parseCollaborationForm({ ...base, action: "reschedule" }).ok).toBe(false);
    // A workflow action must not be smuggled through this parser.
    expect(parseCollaborationForm({ ...base, action: "close", closeReason: "timing" }).ok).toBe(
      false,
    );
  });

  it("forwards only the declared lifecycle fields", () => {
    const parsed = parseCollaborationForm({
      ...base,
      action: "cancel",
      eventAt: "2026-09-05T00:00:00.000Z",
      cancelReason: "mutual",
      ...({ userId: "x", creatorId: "y", collaborationId: "z" } as Record<string, string>),
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(Object.keys(parsed.value).sort()).toEqual([
      "action",
      "cancelReason",
      "endDate",
      "eventAt",
      "pipelineItemId",
      "startDate",
      "termsMatched",
      "wouldWorkAgain",
    ]);
  });
});

describe("would_work_again has three answers", () => {
  it("maps yes/no/not-sure without inventing a negative", () => {
    expect(parseWouldWorkAgain("yes")).toBe(true);
    expect(parseWouldWorkAgain("no")).toBe(false);
    for (const unsure of ["unknown", "", null, undefined, "maybe"]) {
      expect(parseWouldWorkAgain(unsure)).toBeNull();
    }
    // "Not sure" must never become "no".
    expect(parseWouldWorkAgain("unknown")).not.toBe(false);
  });

  it("carries the three-valued answer through the form", () => {
    const parse = (value: string) =>
      parseCollaborationForm({
        pipelineItemId: ITEM,
        action: "complete",
        eventAt: "2026-09-05T00:00:00.000Z",
        endDate: "2026-09-05",
        termsMatched: "yes",
        wouldWorkAgain: value,
      });
    expect(parse("yes").ok && parse("yes").ok).toBe(true);
    const yes = parse("yes");
    const no = parse("no");
    const unsure = parse("unknown");
    expect(yes.ok && yes.value.wouldWorkAgain).toBe(true);
    expect(no.ok && no.value.wouldWorkAgain).toBe(false);
    expect(unsure.ok && unsure.value.wouldWorkAgain).toBeNull();
  });
});

describe("dates come from the creator's own calendar day", () => {
  it("a far-eastern creator's today is not a future instant", () => {
    process.env.TZ = "Pacific/Kiritimati"; // UTC+14
    const now = new Date();
    const today = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("-");
    const iso = localDateToIso(today)!;

    for (const action of ["start", "complete", "cancel"]) {
      const parsed = parseCollaborationForm({
        pipelineItemId: ITEM,
        action,
        eventAt: iso,
        startDate: today,
        endDate: today,
        termsMatched: "yes",
        cancelReason: "mutual",
      });
      expect(parsed.ok).toBe(true);
    }
    expect(new Date(iso).getTime()).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
  });

  it("still converts a historical day with that day's own offset", () => {
    process.env.TZ = "Europe/Madrid";
    expect(localDateToIso("2024-01-15")).toBe("2024-01-14T23:00:00.000Z");
    expect(localDateToIso("2024-07-15")).toBe("2024-07-14T22:00:00.000Z");
  });
});

describe("intelligence refresh policy for lifecycle outcomes", () => {
  it("refreshes after an applied or retried lifecycle move", () => {
    for (const result of [
      { result: "applied", collaborationStatus: "active", pipelineStatus: "won" },
      { result: "applied", collaborationStatus: "completed", pipelineStatus: "closed" },
      { result: "already_applied", collaborationStatus: "cancelled", pipelineStatus: "closed" },
    ] as CollaborationResult[]) {
      expect(shouldRefreshIntelligence(result)).toBe(true);
    }
  });

  it("does NOT refresh when the lifecycle move failed", () => {
    for (const result of [
      { result: "invalid_transition" },
      { result: "invalid_input" },
      { result: "invalid_event_time" },
      { result: "integrity_error" },
      { result: "collaboration_not_found" },
      { result: "error" },
    ] as CollaborationResult[]) {
      expect(shouldRefreshIntelligence(result)).toBe(false);
    }
  });
});

describe("labels", () => {
  it("names every status and action in plain words", () => {
    expect(COLLABORATION_STATUSES.map(collaborationStatusLabel)).toEqual([
      "Collaboration agreed",
      "Collaboration scheduled",
      "Collaboration active",
      "Collaboration completed",
      "Collaboration cancelled",
    ]);
    expect(COLLABORATION_ACTIONS.map(collaborationActionLabel)).toEqual([
      "Schedule",
      "Start collaboration",
      "Complete collaboration",
      "Cancel collaboration",
    ]);
  });

  it("names the terms and cancellation vocabularies", () => {
    expect(TERMS_MATCHED_VALUES.map(termsMatchedLabel)).toEqual([
      "Yes",
      "Partially",
      "No",
      "Not sure",
    ]);
    expect(CANCELLATION_REASONS.map(cancellationReasonLabel)).toEqual([
      "I cancelled",
      "The hotel cancelled",
      "Mutual",
      "Other",
    ]);
  });

  it("no label leaks a raw enum value", () => {
    for (const label of [
      ...COLLABORATION_STATUSES.map(collaborationStatusLabel),
      ...CANCELLATION_REASONS.map(cancellationReasonLabel),
    ]) {
      expect(label).not.toMatch(/_/);
    }
  });
});
