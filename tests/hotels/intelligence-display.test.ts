/**
 * Creator intelligence display rules (PRD §12.6/§12.7, DESIGN_SYSTEM.md §5).
 *
 * The canonical dataset currently has ZERO intelligence rows. These tests pin
 * the product rule that this renders an insufficient-data state — never a
 * fabricated zero metric such as "0% reply rate" or "Low activity".
 */
import { describe, expect, it } from "vitest";

import {
  INSUFFICIENT_INTELLIGENCE_COPY,
  activityLabel,
  recencyLabel,
  shouldShowInsufficientData,
  type IntelligenceSignal,
} from "@/lib/hotels/intelligence";

const empty: IntelligenceSignal = {
  activityLevel: null,
  confidenceLevel: null,
  hasConfirmedCollaboration: null,
  recencyBand: null,
};

describe("shouldShowInsufficientData", () => {
  it("is true when the hotel has no intelligence row at all", () => {
    // This is today's real state for all 30 canonical hotels.
    expect(shouldShowInsufficientData(null)).toBe(true);
  });

  it("is true for an explicitly insufficient confidence level", () => {
    expect(shouldShowInsufficientData({ ...empty, confidenceLevel: "insufficient" })).toBe(true);
  });

  it("is true when confidence gates leave nothing displayable", () => {
    expect(shouldShowInsufficientData({ ...empty, confidenceLevel: "emerging" })).toBe(true);
  });

  it("is false once a real signal survives the gates", () => {
    expect(
      shouldShowInsufficientData({ ...empty, confidenceLevel: "emerging", activityLevel: "low" }),
    ).toBe(false);
    expect(
      shouldShowInsufficientData({
        ...empty,
        confidenceLevel: "moderate",
        recencyBand: "past_month",
      }),
    ).toBe(false);
    expect(
      shouldShowInsufficientData({
        ...empty,
        confidenceLevel: "moderate",
        hasConfirmedCollaboration: true,
      }),
    ).toBe(false);
  });

  it("uses the approved insufficient-data copy, not a zero metric", () => {
    expect(INSUFFICIENT_INTELLIGENCE_COPY.title).toBe("Not enough creator data yet");
    expect(INSUFFICIENT_INTELLIGENCE_COPY.title).not.toMatch(/0%|\bLow\b|no creators/i);
    expect(INSUFFICIENT_INTELLIGENCE_COPY.description).not.toMatch(/0%|never|no creators/i);
  });
});

describe("the public layer carries no reply rate at all (D050)", () => {
  it("the public signal shape has no reply-rate field", () => {
    // 0026 moved reply rate to the premium projection. It is not suppressed
    // here — it is absent, which is a stronger guarantee than a UI gate.
    expect(empty).not.toHaveProperty("replyRate");
    expect(Object.keys(empty).sort()).toEqual([
      "activityLevel",
      "confidenceLevel",
      "hasConfirmedCollaboration",
      "recencyBand",
    ]);
  });

  it("no public copy mentions a rate the layer cannot produce", () => {
    expect(INSUFFICIENT_INTELLIGENCE_COPY.title).not.toMatch(/reply rate/i);
    expect(JSON.stringify(INSUFFICIENT_INTELLIGENCE_COPY)).not.toMatch(/%/);
  });
});

describe("coarse labels", () => {
  it("maps activity levels to non-quantitative language", () => {
    expect(activityLabel("high")).toBe("High creator activity");
    expect(activityLabel("low")).toBe("Creator activity detected");
    expect(activityLabel(null)).toBeNull();
  });

  it("maps recency bands and hides unknown bands", () => {
    expect(recencyLabel("past_month")).toBe("Creator activity in the past month");
    expect(recencyLabel(null)).toBeNull();
    expect(recencyLabel("someday")).toBeNull();
  });
});
