/**
 * Premium intelligence display decisions (PRD §12.8, D050, D058).
 *
 * Pure state and label logic. The database is the authority on WHICH values a
 * caller receives; this file pins what the product does with them — above all
 * that `locked`, `building` and `error` never blur into one another, and that a
 * suppressed metric never becomes a claim.
 */
import { describe, expect, it } from "vitest";

import type { ContactAccessResult } from "@/lib/hotels/access";
import {
  BUILDING_INTELLIGENCE_COPY,
  LOCKED_INTELLIGENCE_COPY,
  PREMIUM_INTELLIGENCE_ERROR_COPY,
  collaborationTypeLabels,
  contributorSampleLabel,
  hasPremiumSignal,
  premiumIntelligenceState,
  premiumReplyRateLabel,
  recentActivityBandLabel,
  replyTimeBandLabel,
  type PremiumIntelligenceResult,
  type PremiumIntelligenceSignal,
} from "@/lib/hotels/intelligence";

const ALLOWED: ContactAccessResult = { status: "allowed" };
const DENIED: ContactAccessResult = { status: "denied" };
const ACCESS_ERROR: ContactAccessResult = { status: "error" };

/** Everything suppressed — what an entitled viewer sees on a quiet hotel. */
const EMPTY: PremiumIntelligenceSignal = {
  confidenceLevel: "emerging",
  replyRate: null,
  replyTimeBand: null,
  recentActivityBand: null,
  collaborationTypes: null,
  contributorCount: null,
};

const RICH: PremiumIntelligenceSignal = {
  confidenceLevel: "strong",
  replyRate: 0.62,
  replyTimeBand: "3_7_days",
  recentActivityBand: "within_30_days",
  collaborationTypes: ["paid", "stay"],
  contributorCount: 12,
};

const ok = (signal: PremiumIntelligenceSignal): PremiumIntelligenceResult => ({
  status: "ok",
  signal,
});

describe("locked, building and error are three different answers", () => {
  it("an explicit denial is locked", () => {
    expect(premiumIntelligenceState({ access: DENIED, result: null })).toBe("locked");
  });

  it("a failed entitlement check is an error — never locked", () => {
    const state = premiumIntelligenceState({ access: ACCESS_ERROR, result: null });
    expect(state).toBe("error");
    expect(state).not.toBe("locked");
    expect(state).not.toBe("building");
  });

  it("a failed premium query for an ENTITLED viewer is an error, not building", () => {
    const state = premiumIntelligenceState({ access: ALLOWED, result: { status: "error" } });
    expect(state).toBe("error");
    expect(state).not.toBe("building");
    expect(state).not.toBe("locked");
  });

  it("entitled with no row is building — the hotel is not being judged", () => {
    expect(premiumIntelligenceState({ access: ALLOWED, result: { status: "none" } })).toBe(
      "building",
    );
  });

  it("entitled with a row whose every metric was suppressed is still building", () => {
    expect(premiumIntelligenceState({ access: ALLOWED, result: ok(EMPTY) })).toBe("building");
  });

  it("entitled with at least one surviving metric is available", () => {
    expect(premiumIntelligenceState({ access: ALLOWED, result: ok(RICH) })).toBe("available");
  });

  it("any single surviving metric is enough", () => {
    const singles: Partial<PremiumIntelligenceSignal>[] = [
      { replyRate: 0.4 },
      { replyTimeBand: "under_24h" },
      { recentActivityBand: "within_7_days" },
      { collaborationTypes: ["stay"] },
      { contributorCount: 7 },
    ];
    for (const patch of singles) {
      expect(hasPremiumSignal({ ...EMPTY, ...patch })).toBe(true);
      expect(
        premiumIntelligenceState({ access: ALLOWED, result: ok({ ...EMPTY, ...patch }) }),
      ).toBe("available");
    }
  });

  it("an empty collaboration-type array is not a signal", () => {
    expect(hasPremiumSignal({ ...EMPTY, collaborationTypes: [] })).toBe(false);
  });

  it("a reply rate of exactly 0 IS a signal — measured and unanswered is a finding", () => {
    expect(hasPremiumSignal({ ...EMPTY, replyRate: 0 })).toBe(true);
  });
});

describe("copy never invents a negative fact", () => {
  it("the building state asks for participation, it does not judge the hotel", () => {
    expect(BUILDING_INTELLIGENCE_COPY.title).toBe("Creator intelligence is building");
    expect(BUILDING_INTELLIGENCE_COPY.description).toBe(
      "Track your outreach here and help make this hotel's insights more useful for the creator community.",
    );
    const all = JSON.stringify(BUILDING_INTELLIGENCE_COPY);
    expect(all).not.toMatch(/0%|never|no replies|unresponsive|poor|bad/i);
  });

  it("the building copy offers no submit-data mechanic and no reward", () => {
    const all = JSON.stringify(BUILDING_INTELLIGENCE_COPY);
    expect(all).not.toMatch(/submit|report data|points|credits|reward|earn|xp|coins/i);
  });

  it("the locked state names the metrics but discloses no value", () => {
    const all = JSON.stringify(LOCKED_INTELLIGENCE_COPY);
    expect(all).toMatch(/reply rate/i);
    // No number, no percentage, no band value.
    expect(all).not.toMatch(/\d/);
  });

  it("the error state claims nothing about entitlement or data", () => {
    const all = JSON.stringify(PREMIUM_INTELLIGENCE_ERROR_COPY);
    expect(all).not.toMatch(/upgrade|not enough|no data|building|locked/i);
  });
});

describe("labels", () => {
  it("reply rate is a whole percent, never a raw fraction", () => {
    expect(premiumReplyRateLabel(RICH)).toBe("62%");
    expect(premiumReplyRateLabel({ ...EMPTY, replyRate: 0 })).toBe("0%");
    expect(premiumReplyRateLabel(EMPTY)).toBeNull();
    expect(premiumReplyRateLabel(null)).toBeNull();
  });

  it("reply time is a band, never an hour count", () => {
    expect(replyTimeBandLabel("under_24h")).toBe("Under 24h");
    expect(replyTimeBandLabel("1_3_days")).toBe("1–3 days");
    expect(replyTimeBandLabel("3_7_days")).toBe("3–7 days");
    expect(replyTimeBandLabel("1_2_weeks")).toBe("1–2 weeks");
    expect(replyTimeBandLabel("2_plus_weeks")).toBe("2+ weeks");
    expect(replyTimeBandLabel(null)).toBeNull();
    expect(replyTimeBandLabel("83.6_hours")).toBeNull();

    for (const band of ["under_24h", "1_3_days", "3_7_days", "1_2_weeks", "2_plus_weeks"]) {
      expect(replyTimeBandLabel(band)).not.toMatch(/hours?\b/i);
    }
  });

  it("recent activity is a band, never a date", () => {
    expect(recentActivityBandLabel("within_7_days")).toBe("Within 7 days");
    expect(recentActivityBandLabel("within_30_days")).toBe("Within 30 days");
    expect(recentActivityBandLabel("within_90_days")).toBe("Within 90 days");
    expect(recentActivityBandLabel(null)).toBeNull();
    expect(recentActivityBandLabel("yesterday")).toBeNull();
  });

  it("collaboration types are human labels, and unknown codes are dropped", () => {
    expect(collaborationTypeLabels(["paid", "stay"])).toEqual(["Paid", "Stay"]);
    expect(collaborationTypeLabels(["stay_plus_paid"])).toEqual(["Stay + paid"]);
    expect(collaborationTypeLabels(["nonsense"])).toEqual([]);
    expect(collaborationTypeLabels(null)).toEqual([]);
  });

  it("the sample label counts CREATORS, never pitches or replies", () => {
    expect(contributorSampleLabel(RICH)).toBe("Based on activity from 12 creators");
    expect(contributorSampleLabel({ ...EMPTY, contributorCount: 1 })).toBe(
      "Based on activity from 1 creator",
    );
    expect(contributorSampleLabel(EMPTY)).toBeNull();
    expect(contributorSampleLabel(null)).toBeNull();
    expect(contributorSampleLabel(RICH)).not.toMatch(/pitch|reply|replies|cycle/i);
  });
});

describe("the premium shape carries no raw counts", () => {
  it("no field can express a pitch count, a reply count or a timestamp", () => {
    const keys = Object.keys(RICH);
    for (const forbidden of [
      "pitchCount",
      "replyCount",
      "pitchedCycles",
      "repliedCycles",
      "medianReplyHours",
      "lastCreatorActivityAt",
      "creatorId",
      "pipelineItemId",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    expect(keys.sort()).toEqual([
      "collaborationTypes",
      "confidenceLevel",
      "contributorCount",
      "recentActivityBand",
      "replyRate",
      "replyTimeBand",
    ]);
  });

  it("nothing rendered from it can identify a creator", () => {
    const rendered = [
      premiumReplyRateLabel(RICH),
      replyTimeBandLabel(RICH.replyTimeBand),
      recentActivityBandLabel(RICH.recentActivityBand),
      ...collaborationTypeLabels(RICH.collaborationTypes),
      contributorSampleLabel(RICH),
    ].join(" ");
    expect(rendered).not.toMatch(/@|uuid|[0-9a-f]{8}-[0-9a-f]{4}/i);
  });
});
