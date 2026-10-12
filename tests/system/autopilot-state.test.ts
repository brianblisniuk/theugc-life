import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { validateAutopilotState } from "../../scripts/validate-autopilot-state";

const current = JSON.parse(readFileSync(".grok/autopilot-state.json", "utf8"));

describe(".grok/autopilot-state.json", () => {
  it("the committed file is valid", () => {
    const res = validateAutopilotState(current);
    expect(res.success, JSON.stringify(res.error?.issues)).toBe(true);
  });

  it("rejects a short SHA, an unknown state, a non-frontier human action and extra keys", () => {
    expect(validateAutopilotState({ ...current, last_recorded_main: "f48a113" }).success).toBe(
      false,
    );
    expect(validateAutopilotState({ ...current, state: "DONE" }).success).toBe(false);
    expect(
      validateAutopilotState({ ...current, required_human_action: "please look" }).success,
    ).toBe(false);
    expect(validateAutopilotState({ ...current, extra: 1 }).success).toBe(false);
  });

  it("enforces cross-field invariants", () => {
    const awaiting = {
      ...current,
      state: "AWAITING_MERGE_DECISION",
      pr: null,
      expected_head: null,
    };
    expect(validateAutopilotState(awaiting).success).toBe(false);
    expect(
      validateAutopilotState({ ...current, state: "HUMAN_FRONTIER", required_human_action: null })
        .success,
    ).toBe(false);
    const blocking = {
      ...current,
      state: "AWAITING_MERGE_DECISION",
      pr: 1,
      expected_head: "a".repeat(40),
      required_human_action: "MERGE DECISION REQUIRED — PR #1",
      unresolved_findings: [{ id: "X", severity: "BLOCKING", summary: "s", ref: "r" }],
    };
    expect(validateAutopilotState(blocking).success).toBe(false);
  });
});
