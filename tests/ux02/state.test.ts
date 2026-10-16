/**
 * UX02 state rules for Discover and Hotel Detail.
 *
 * A failed read is not a plan, a lock, an empty catalog, or a zero balance.
 * A keyword is one chip. It is not parsed into a destination or a star rating.
 */
import { describe, expect, it } from "vitest";

import type { Entitlement } from "@/lib/billing/queries";
import { CREDITS_CONFIG } from "@/lib/credits/config";
import { DISCOVER_PAGE_SIZE, type DiscoverQuery } from "@/lib/hotels/filters";
import type { StrengthLoad } from "@/lib/intelligence/contract";
import {
  METRIC_IDS,
  METRIC_LAYERS,
  METRIC_TITLES,
  NOT_ENOUGH_DATA_LABEL,
  THRESHOLD_RULES,
  type HotelSignalsLoad,
  type MetricId,
  type MetricSignal,
  type RankingLoad,
} from "@/lib/metrics/contract";
import { discoverFilterChips } from "@/lib/screens/discover-chips";
import { discoverSortGate, sortOptionLabel } from "@/lib/screens/discover-sort";
import { initialsFromName } from "@/lib/screens/initials";
import { mapPresence } from "@/lib/screens/map-presence";
import { metricCells, rankingPanel } from "@/lib/screens/metric-state";
import { creditsAvailableLabel, nextStep, pipelineChipLabel } from "@/lib/screens/next-step";
import {
  planChipFromAccess,
  planChipFromBillingState,
  planChipFromEntitlements,
} from "@/lib/screens/plan-chip";

const NOW = new Date("2026-10-15T12:00:00.000Z");

function query(patch: Partial<DiscoverQuery> = {}): DiscoverQuery {
  return {
    q: null,
    type: null,
    minStars: null,
    verification: null,
    country: null,
    destination: null,
    activity: null,
    collaboration: null,
    rank: null,
    page: 1,
    pageSize: DISCOVER_PAGE_SIZE,
    ...patch,
  };
}

function signal(
  metric: MetricId,
  state: MetricSignal["state"],
  valueLabel: string | null,
): MetricSignal {
  return {
    metric,
    title: METRIC_TITLES[metric],
    layer: METRIC_LAYERS[metric],
    state,
    valueLabel,
    sampleBasis: state === "available" ? "Based on activity from 6 creators" : null,
    thresholdRule: THRESHOLD_RULES[metric],
  };
}

function signals(rows: MetricSignal[]): HotelSignalsLoad {
  return { status: "ok", metrics: rows };
}

function entitlement(accessType: string, patch: Partial<Entitlement> = {}): Entitlement {
  return {
    accessType,
    status: "active",
    startsAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    ...patch,
  };
}

describe("initials stand in for a missing photograph", () => {
  it("uses two significant words and skips particles after the first word", () => {
    expect(initialsFromName("Hotel del Mar")).toBe("HM");
    expect(initialsFromName("Casa de la Paz")).toBe("CP");
    expect(initialsFromName("The Grand")).toBe("TG");
    expect(initialsFromName("Casa")).toBe("CA");
    expect(initialsFromName("  ")).toBe("·");
    expect(initialsFromName("Hôtel")).toBe("HÔ");
  });
});

describe("plan chip", () => {
  it("does not turn a failed entitlement read into Free", () => {
    expect(planChipFromAccess({ status: "error" }, NOW)).toBeNull();
    expect(
      planChipFromBillingState({
        kind: "error",
        title: "We couldn’t load your billing & access information.",
        body: "Something went wrong on our side. Reload the page to try again.",
      }),
    ).toBeNull();
  });

  it("lets Max win, then Pro, then a Destination Pass, then Free", () => {
    expect(
      planChipFromEntitlements(
        [entitlement("pro"), entitlement("max"), entitlement("destination")],
        NOW,
      ),
    ).toBe("Max");
    expect(planChipFromEntitlements([entitlement("pro"), entitlement("destination")], NOW)).toBe(
      "Pro",
    );
    expect(planChipFromEntitlements([entitlement("destination")], NOW)).toBe("Pass");
    expect(planChipFromEntitlements([], NOW)).toBe("Free");
    expect(
      planChipFromEntitlements(
        [
          entitlement("max", { status: "revoked" }),
          entitlement("destination", { expiresAt: "2020-01-01T00:00:00.000Z" }),
        ],
        NOW,
      ),
    ).toBe("Free");
    expect(planChipFromAccess({ status: "ok", entitlements: [entitlement("pro")] }, NOW)).toBe(
      "Pro",
    );
  });
});

describe("discover chips", () => {
  it("keeps a keyword as one chip and does not invent a destination or a star filter", () => {
    const chips = discoverFilterChips(
      query({ q: "5 star boutique in lisbon", page: 4, rank: "response_rate" }),
      { destinationName: null, countryName: null },
    );
    expect(chips).toEqual([
      {
        key: "q",
        label: "5 star boutique in lisbon",
        removeHref: "/app/discover?rank=response_rate",
      },
    ]);
    expect(chips.some((chip) => chip.key === "rank")).toBe(false);
  });

  it("removes one filter at a time and resets the page", () => {
    const current = query({
      q: "harbor",
      destination: "lisbon",
      type: "boutique_hotel",
      country: "PT",
      minStars: 5,
      verification: "verified",
      activity: "high",
      collaboration: "observed",
      page: 3,
    });
    const chips = discoverFilterChips(current, {
      destinationName: "Lisbon",
      countryName: "Portugal",
    });
    expect(chips.map((chip) => chip.label)).toEqual([
      "harbor",
      "Lisbon",
      "Boutique hotel",
      "Portugal",
      "5-star",
      "Editorially verified",
      "High creator activity",
      "Creator collaboration observed",
    ]);
    const destination = chips.find((chip) => chip.key === "destination");
    expect(destination?.removeHref).toContain("q=harbor");
    expect(destination?.removeHref).not.toContain("destination=");
    expect(destination?.removeHref).not.toContain("page=");
  });
});

describe("discover sort gate", () => {
  it("keeps a lock, a floor, a ranking, and a failure apart", () => {
    expect(discoverSortGate({ rank: null, rankedKind: null, failed: false })).toBe("catalog");
    expect(discoverSortGate({ rank: "creator_activity", rankedKind: "list", failed: false })).toBe(
      "ranked",
    );
    expect(discoverSortGate({ rank: "response_rate", rankedKind: "locked", failed: false })).toBe(
      "locked",
    );
    expect(
      discoverSortGate({ rank: "response_time", rankedKind: "below_floor", failed: false }),
    ).toBe("below_floor");
    expect(discoverSortGate({ rank: "response_rate", rankedKind: "locked", failed: true })).toBe(
      "error",
    );
    expect(
      discoverSortGate({ rank: "response_time", rankedKind: "below_floor", failed: true }),
    ).toBe("error");
    expect(discoverSortGate({ rank: null, rankedKind: null, failed: true })).toBe("error");
    expect(sortOptionLabel("response_rate", "Most responsive", true)).toBe("Most responsive (Pro)");
    expect(sortOptionLabel("creator_activity", "Most active with creators", false)).toBe(
      "Most active with creators",
    );
  });
});

describe("map presence", () => {
  it("does not call a list failure a map failure, or an empty page a missing key", () => {
    expect(
      mapPresence({ listFailed: true, pinCount: 3, apiKeyPresent: false, scriptFailed: true }),
    ).toBe("waiting");
    expect(
      mapPresence({ listFailed: false, pinCount: 0, apiKeyPresent: true, scriptFailed: false }),
    ).toBe("empty");
    expect(
      mapPresence({ listFailed: false, pinCount: 2, apiKeyPresent: false, scriptFailed: false }),
    ).toBe("unavailable");
    expect(
      mapPresence({ listFailed: false, pinCount: 2, apiKeyPresent: true, scriptFailed: true }),
    ).toBe("unavailable");
    expect(
      mapPresence({ listFailed: false, pinCount: 24, apiKeyPresent: true, scriptFailed: false }),
    ).toBe("ready");
  });
});

describe("metric cells", () => {
  it("keeps available, locked, insufficient, and error as four states", () => {
    const load = signals([
      signal("response_rate", "locked", null),
      signal("response_time", "not_enough_data", null),
      signal("creator_activity", "available", "High"),
    ]);
    const strength: StrengthLoad = {
      status: "ok",
      metrics: [
        {
          metric: "creator_activity",
          state: "available",
          confidenceLevel: "strong",
          freshnessBand: "past_month",
        },
        {
          metric: "response_rate",
          state: "locked",
          confidenceLevel: null,
          freshnessBand: null,
        },
        {
          metric: "response_time",
          state: "not_enough_data",
          confidenceLevel: null,
          freshnessBand: null,
        },
      ],
    };
    const cells = metricCells({ signals: load, strength });
    const locked = cells.find((cell) => cell.metric === "response_rate");
    const thin = cells.find((cell) => cell.metric === "response_time");
    const open = cells.find((cell) => cell.metric === "creator_activity");
    expect(locked).toMatchObject({
      state: "locked",
      capability: "Hotel response insights",
      plan: "Available on Pro and Max, or with a Destination Pass for this destination.",
    });
    expect(locked && "valueLabel" in locked).toBe(false);
    expect(thin).toMatchObject({ state: "insufficient", label: NOT_ENOUGH_DATA_LABEL });
    expect(open).toMatchObject({
      state: "available",
      valueLabel: "High",
      confidence: "Strong",
      freshness: "Past month",
      sampleBasis: "Based on activity from 6 creators",
    });
  });

  it("does not turn a failed read or a missing row into not enough data or zero", () => {
    const failed = metricCells({
      signals: { status: "error", notice: "down" },
      strength: null,
    });
    expect(failed.map((cell) => cell.state)).toEqual(["error", "error", "error"]);
    expect(failed.every((cell) => cell.state === "error" && cell.notice === "down")).toBe(true);
    expect(JSON.stringify(failed)).not.toContain("0%");
    expect(JSON.stringify(failed)).not.toContain(NOT_ENOUGH_DATA_LABEL);

    const partial = metricCells({
      signals: signals([signal("creator_activity", "available", null)]),
      strength: { status: "error", notice: "strength down" },
    });
    expect(partial.find((cell) => cell.metric === "creator_activity")?.state).toBe("insufficient");
    expect(partial.find((cell) => cell.metric === "response_rate")?.state).toBe("error");
  });
});

describe("ranking panel", () => {
  it("does not render a lock or an error as an empty list", () => {
    const locked: RankingLoad = {
      status: "locked",
      metric: "response_rate",
      title: "Most responsive",
      thresholdRule: THRESHOLD_RULES.response_rate,
    };
    const panel = rankingPanel(locked, "none");
    expect(panel.state).toBe("locked");
    expect(panel).not.toHaveProperty("hotels");

    expect(rankingPanel({ status: "error", notice: "down" }, "none")).toEqual({
      state: "error",
      metric: null,
      title: "Ranking",
      notice: "down",
    });

    const empty: RankingLoad = {
      status: "ok",
      metric: "creator_activity",
      title: "Most active with creators",
      thresholdRule: THRESHOLD_RULES.creator_activity,
      hotels: [],
    };
    expect(
      rankingPanel(empty, "No hotel in this destination has enough confirmed data.").state,
    ).toBe("empty");

    const listed = rankingPanel(
      {
        status: "ok",
        metric: "creator_activity",
        title: "Most active with creators",
        thresholdRule: THRESHOLD_RULES.creator_activity,
        hotels: [
          {
            hotelId: "11111111-1111-4111-8111-111111111111",
            name: "Casa",
            rank: 1,
            valueLabel: "High",
            sampleBasis: "Based on activity from 6 creators",
          },
        ],
      },
      "none",
    );
    expect(listed.state).toBe("list");
    if (listed.state === "list") expect(listed.hotels).toHaveLength(1);
    expect(METRIC_IDS).toHaveLength(3);
  });
});

describe("your next step", () => {
  const pitch = "/app/hotels/11111111-1111-4111-8111-111111111111/pitch";

  it("does not offer Save or Unlock when the relationship could not be read", () => {
    const model = nextStep({
      relationship: { status: "error" },
      contact: "locked",
      balance: 4,
      cost: 1,
      pitchHref: pitch,
      plan: "Pro",
    });
    expect(model.kind).toBe("relationship_unknown");
    expect(model.offerSave).toBe(false);
    expect(model.primaryHref).toBeNull();
    expect(model.primaryLabel).toBe("Retry");
  });

  it("follows the open cycle before the contact lock", () => {
    expect(
      nextStep({
        relationship: { status: "open", stage: "won" },
        contact: "locked",
        balance: 4,
        cost: 1,
        pitchHref: pitch,
        plan: "Pro",
      }).kind,
    ).toBe("manage_collaboration");
    const talking = nextStep({
      relationship: { status: "open", stage: "negotiating" },
      contact: "ready",
      balance: 4,
      cost: 1,
      pitchHref: pitch,
      plan: "Max",
    });
    expect(talking).toMatchObject({
      kind: "open_conversation",
      primaryHref: "#inbox",
      offerViewPipeline: true,
      stageLabel: "Negotiating",
      stageTone: "process",
    });
    expect(pipelineChipLabel("Negotiating")).toBe("Your pipeline · Negotiating");
  });

  it("charges the label only when the balance is known and enough, and never treats unknown as zero", () => {
    expect(CREDITS_CONFIG.chargeOnNotFound).toBe(false);
    expect(CREDITS_CONFIG.unlockCost).toBe(1);
    const ready = nextStep({
      relationship: { status: "none" },
      contact: "locked",
      balance: 4,
      cost: CREDITS_CONFIG.unlockCost,
      pitchHref: pitch,
      plan: "Free",
    });
    expect(ready).toMatchObject({
      kind: "unlock",
      primaryLabel: "Unlock contact · 1 credit",
      primaryHref: "#contact",
      primaryDisabled: false,
      offerSave: true,
      offerAddToTrip: true,
      assurance: "1 credit is charged only after a successful unlock.",
      creditsText: "4 credits available",
      outOfCredits: null,
    });

    const zero = nextStep({
      relationship: { status: "open", stage: "saved" },
      contact: "locked",
      balance: 0,
      cost: 1,
      pitchHref: pitch,
      plan: "Free",
    });
    expect(zero.primaryDisabled).toBe(true);
    expect(zero.primaryHref).toBeNull();
    expect(zero.offerSave).toBe(false);
    expect(zero.outOfCredits).toMatch(/out of credits/i);
    expect(zero.creditsText).toBe("0 credits available");

    const unknown = nextStep({
      relationship: { status: "none" },
      contact: "locked",
      balance: null,
      cost: 1,
      pitchHref: pitch,
      plan: null,
    });
    expect(unknown.creditsUnknown).toBe(true);
    expect(unknown.creditsText).toBe("Credits unavailable");
    expect(unknown.primaryDisabled).toBe(true);
    expect(unknown.assurance).toBeNull();
    expect(unknown.outOfCredits).toBeNull();
    expect(creditsAvailableLabel(1)).toBe("1 credit available");
  });

  it("makes Generate pitch the primary once contact is open and the cycle is not already in conversation", () => {
    const free = nextStep({
      relationship: { status: "open", stage: "saved" },
      contact: "ready",
      balance: 3,
      cost: 1,
      pitchHref: pitch,
      plan: "Free",
    });
    expect(free).toMatchObject({
      kind: "generate_pitch",
      title: "Generate pitch",
      primaryLabel: "Generate pitch",
      primaryHref: pitch,
      primaryDisabled: false,
      offerSave: false,
    });
    expect(free.note).toMatch(/templates/i);
    expect(free.note).toMatch(/Pro and Max/);

    const pro = nextStep({
      relationship: { status: "none" },
      contact: "empty",
      balance: 128,
      cost: 1,
      pitchHref: pitch,
      plan: "Pro",
    });
    expect(pro.kind).toBe("generate_pitch");
    expect(pro.note).toBeNull();

    const broken = nextStep({
      relationship: { status: "open", stage: "saved" },
      contact: "error",
      balance: 128,
      cost: 1,
      pitchHref: pitch,
      plan: "Pro",
    });
    expect(broken.kind).toBe("contact_error");
    expect(broken.primaryHref).toBeNull();
    expect(broken.note).toMatch(/not an empty file/i);
  });
});
