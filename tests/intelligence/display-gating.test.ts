/**
 * What each confidence band actually renders (Sprint 2E, PRD §12.7, D044).
 *
 * The projection already suppresses values upstream; these pin what the panel
 * does with what survives — in particular that a withheld metric never becomes
 * a claim ("0%", "No collaboration"), and that a failed query never becomes
 * "not enough creator data".
 */
import { describe, expect, it } from "vitest";

import {
  INSUFFICIENT_INTELLIGENCE_COPY,
  INTELLIGENCE_ERROR_COPY,
  activityLabel,
  canShowReplyRate,
  intelligencePanelState,
  recencyLabel,
  replyRateLabel,
  type IntelligenceSignal,
} from "@/lib/hotels/intelligence";

/** What the view returns at each band, per D044's disclosure table. */
const AT_INSUFFICIENT: IntelligenceSignal = {
  activityLevel: null,
  confidenceLevel: "insufficient",
  replyRate: null,
  hasConfirmedCollaboration: null,
  recencyBand: null,
};
const AT_EMERGING: IntelligenceSignal = {
  activityLevel: "low",
  confidenceLevel: "emerging",
  replyRate: null,
  hasConfirmedCollaboration: true,
  recencyBand: null,
};
const AT_MODERATE: IntelligenceSignal = {
  activityLevel: "medium",
  confidenceLevel: "moderate",
  replyRate: null,
  hasConfirmedCollaboration: false,
  recencyBand: "past_month",
};
const AT_STRONG: IntelligenceSignal = {
  activityLevel: "high",
  confidenceLevel: "strong",
  replyRate: 0.42,
  hasConfirmedCollaboration: true,
  recencyBand: "past_quarter",
};

describe("insufficient renders an absence, never a zero", () => {
  it("shows the insufficient-data state", () => {
    expect(intelligencePanelState({ status: "ok", signal: AT_INSUFFICIENT })).toBe("insufficient");
    expect(INSUFFICIENT_INTELLIGENCE_COPY.title).toBe("Not enough creator data yet");
  });

  it("renders no reply rate — not '0%'", () => {
    expect(replyRateLabel(AT_INSUFFICIENT)).toBeNull();
    expect(canShowReplyRate(AT_INSUFFICIENT)).toBe(false);
    // Even if a rate somehow arrived, the band forbids showing it.
    expect(replyRateLabel({ ...AT_INSUFFICIENT, replyRate: 0 })).toBeNull();
  });

  it("renders no activity label — not 'Low'", () => {
    expect(activityLabel(AT_INSUFFICIENT.activityLevel)).toBeNull();
  });

  it("a suppressed collaboration is NULL, and NULL renders nothing", () => {
    expect(AT_INSUFFICIENT.hasConfirmedCollaboration).toBeNull();
    // The panel renders the collaboration row only for `true`, so both NULL and
    // false render nothing at all — it never states "No collaboration".
    expect(Boolean(AT_INSUFFICIENT.hasConfirmedCollaboration)).toBe(false);
    expect(AT_INSUFFICIENT.hasConfirmedCollaboration).not.toBe(false);
  });
});

describe("emerging shows coarse activity and a confirmed collaboration", () => {
  it("renders a signal, not an absence", () => {
    expect(intelligencePanelState({ status: "ok", signal: AT_EMERGING })).toBe("signal");
    expect(activityLabel(AT_EMERGING.activityLevel)).toBe("Creator activity detected");
  });

  it("still hides the reply rate and the recency band", () => {
    expect(replyRateLabel(AT_EMERGING)).toBeNull();
    expect(recencyLabel(AT_EMERGING.recencyBand)).toBeNull();
  });

  it("a confirmed collaboration is stated without any count of people", () => {
    expect(AT_EMERGING.hasConfirmedCollaboration).toBe(true);
    // Cycles are not creators; no label may imply a headcount.
    for (const label of [
      activityLabel(AT_EMERGING.activityLevel),
      "Creator collaboration confirmed",
    ]) {
      expect(label).not.toMatch(/\d/);
    }
  });
});

describe("moderate adds coarse recency", () => {
  it("renders the band in words, never a timestamp", () => {
    expect(intelligencePanelState({ status: "ok", signal: AT_MODERATE })).toBe("signal");
    expect(recencyLabel(AT_MODERATE.recencyBand)).toBe("Creator activity in the past month");
    expect(recencyLabel(AT_MODERATE.recencyBand)).not.toMatch(/\d{4}-\d{2}-\d{2}|T\d{2}:/);
  });

  it("still hides the reply rate", () => {
    expect(replyRateLabel(AT_MODERATE)).toBeNull();
  });

  it("a genuine `false` collaboration answer still renders nothing", () => {
    expect(AT_MODERATE.hasConfirmedCollaboration).toBe(false);
    expect(Boolean(AT_MODERATE.hasConfirmedCollaboration)).toBe(false);
  });
});

describe("strong is the only band that shows a reply rate", () => {
  it("renders the rate as a coarse percentage", () => {
    expect(canShowReplyRate(AT_STRONG)).toBe(true);
    expect(replyRateLabel(AT_STRONG)).toBe("42%");
  });

  it("no lower band ever does", () => {
    for (const signal of [AT_INSUFFICIENT, AT_EMERGING, AT_MODERATE]) {
      expect(canShowReplyRate({ ...signal, replyRate: 0.42 })).toBe(false);
    }
  });

  it("shows every other permitted signal too", () => {
    expect(activityLabel(AT_STRONG.activityLevel)).toBe("High creator activity");
    expect(recencyLabel(AT_STRONG.recencyBand)).toBe("Creator activity in the past quarter");
  });
});

describe("activity labels stay coarse and never imply a headcount", () => {
  it("no label quantifies anything", () => {
    for (const level of ["emerging", "low", "medium", "high"]) {
      const label = activityLabel(level)!;
      expect(label).not.toMatch(/\d/);
      expect(label).not.toMatch(/creators\b/i);
    }
  });

  it("an unknown level degrades to a safe phrase rather than leaking the raw value", () => {
    expect(activityLabel("wildly_popular")).toBe("Creator activity detected");
  });
});

describe("a technical error is still not a domain fact", () => {
  it("a failed load renders the error state, never the insufficient one", () => {
    expect(intelligencePanelState({ status: "error" })).toBe("error");
    expect(INTELLIGENCE_ERROR_COPY.title).toBe("Creator intelligence is temporarily unavailable");
    expect(INTELLIGENCE_ERROR_COPY.title).not.toBe(INSUFFICIENT_INTELLIGENCE_COPY.title);
  });

  it("a genuinely absent row remains the insufficient state", () => {
    expect(intelligencePanelState({ status: "none" })).toBe("insufficient");
  });

  it("the two states are never interchangeable", () => {
    expect(intelligencePanelState({ status: "error" })).not.toBe(
      intelligencePanelState({ status: "none" }),
    );
  });
});
