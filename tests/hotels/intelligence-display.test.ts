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
  canShowReplyRate,
  recencyLabel,
  replyRateLabel,
  shouldShowInsufficientData,
  type IntelligenceSignal,
} from "@/lib/hotels/intelligence";

const empty: IntelligenceSignal = {
  activityLevel: null,
  confidenceLevel: null,
  replyRate: null,
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

describe("reply rate suppression (PRD §12.7)", () => {
  it("hides a precise reply rate below strong confidence", () => {
    expect(canShowReplyRate({ ...empty, confidenceLevel: "moderate", replyRate: 0.63 })).toBe(
      false,
    );
    expect(replyRateLabel({ ...empty, confidenceLevel: "moderate", replyRate: 0.63 })).toBeNull();
  });

  it("shows a precise reply rate only at strong confidence", () => {
    const strong: IntelligenceSignal = { ...empty, confidenceLevel: "strong", replyRate: 0.63 };
    expect(canShowReplyRate(strong)).toBe(true);
    expect(replyRateLabel(strong)).toBe("63%");
  });

  it("never renders a reply rate for a missing signal", () => {
    expect(canShowReplyRate(null)).toBe(false);
    expect(replyRateLabel(null)).toBeNull();
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
