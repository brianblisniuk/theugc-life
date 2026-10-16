/**
 * Discover card copy and per-creator badges.
 *
 * Public signals render only when disclosed. A foreign creator's pipeline
 * status and trip id never become a badge. Unknown pipeline state is not
 * rendered as "not saved".
 */
import { describe, expect, it } from "vitest";

import {
  assembleCreatorBadges,
  hasPublicCardSignal,
  PUBLIC_CARD_INTELLIGENCE_COLUMNS,
  publicCardSignal,
  shouldShowPipelineBadge,
  shouldShowTripBadge,
} from "@/lib/hotels/card-signal";

const VIEWER = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const HOTEL = "cccccccc-cccc-cccc-cccc-cccccccccccc";

describe("public card signal", () => {
  it("renders a disclosed activity and observed collaboration", () => {
    const signal = publicCardSignal({
      activityLevel: "high",
      recencyBand: "past_month",
      hasObservedCollaboration: true,
    });
    expect(signal.activity).toBe("High creator activity");
    expect(signal.recency).toBe("Creator activity in the past month");
    expect(signal.collaborationObserved).toBe(true);
    expect(hasPublicCardSignal(signal)).toBe(true);
  });

  it("does not turn a missing row or a false collaboration into a negative", () => {
    expect(hasPublicCardSignal(publicCardSignal(null))).toBe(false);
    const withheld = publicCardSignal({
      activityLevel: null,
      recencyBand: null,
      hasObservedCollaboration: false,
    });
    expect(withheld.activity).toBeNull();
    expect(withheld.collaborationObserved).toBe(false);
    expect(hasPublicCardSignal(withheld)).toBe(false);
    expect(JSON.stringify(withheld)).not.toMatch(/0%|low|no collaboration/i);
  });

  it("does not select a premium column for the card", () => {
    const columns = PUBLIC_CARD_INTELLIGENCE_COLUMNS.join(",");
    expect(columns).not.toMatch(/reply_rate|reply_time|contributor_count|email|phone/);
  });
});

describe("creator badges — viewer isolation", () => {
  it("shows the viewer's pipeline status and trip, and drops the other creator", () => {
    const badges = assembleCreatorBadges({
      hotelIds: [HOTEL],
      viewerId: VIEWER,
      pipelineRows: [
        { hotelId: HOTEL, creatorId: OTHER, status: "negotiating" },
        { hotelId: HOTEL, creatorId: VIEWER, status: "pitched" },
      ],
      tripRows: [
        { hotelId: HOTEL, creatorId: OTHER, tripId: "trip-other" },
        { hotelId: HOTEL, creatorId: VIEWER, tripId: "trip-viewer" },
      ],
    });
    const badge = badges.get(HOTEL)!;
    expect(badge.pipeline).toEqual({ kind: "status", label: "Sent" });
    expect(badge.tripIds).toEqual(["trip-viewer"]);
    expect(shouldShowPipelineBadge(badge)).toBe(true);
    expect(shouldShowTripBadge(badge)).toBe(true);
    expect(JSON.stringify(badge)).not.toContain("negotiating");
    expect(JSON.stringify(badge)).not.toContain("trip-other");
  });

  it("does not show a closed cycle as saved, and does not label a conflict", () => {
    const closed = assembleCreatorBadges({
      hotelIds: [HOTEL],
      viewerId: VIEWER,
      pipelineRows: [{ hotelId: HOTEL, creatorId: VIEWER, status: "closed" }],
      tripRows: [],
    });
    expect(closed.get(HOTEL)!.pipeline).toEqual({ kind: "none" });
    expect(shouldShowPipelineBadge(closed.get(HOTEL)!)).toBe(false);

    const conflict = assembleCreatorBadges({
      hotelIds: [HOTEL],
      viewerId: VIEWER,
      pipelineRows: [
        { hotelId: HOTEL, creatorId: VIEWER, status: "saved" },
        { hotelId: HOTEL, creatorId: VIEWER, status: "pitched" },
      ],
      tripRows: [],
    });
    expect(conflict.get(HOTEL)!.pipeline).toEqual({ kind: "unknown" });
    expect(shouldShowPipelineBadge(conflict.get(HOTEL)!)).toBe(false);
  });

  it("a null badge is not a claim that the hotel is unsaved", () => {
    expect(shouldShowPipelineBadge(null)).toBe(false);
    expect(shouldShowTripBadge(null)).toBe(false);
  });
});
