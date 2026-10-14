/**
 * Parser gates for C02–C05. A forbidden key, a false collaboration, or a
 * locked fit that still lists hotels is an error.
 */
import { describe, expect, it } from "vitest";

import {
  parseCreatorFit,
  parseMetricConfidence,
  parseNetworkAggregate,
  parsePersonalAggregate,
} from "@/lib/intelligence/contract";

const HOTEL = "c2f50000-0000-4000-8000-000000000101";

describe("freshness and fit parsers", () => {
  it("rejects a confidence payload that names a creator", () => {
    const parsed = parseMetricConfidence({
      result: "ok",
      metrics: [
        { metric: "response_rate", state: "locked", confidence_level: null, freshness_band: null, owner_user_id: HOTEL },
        { metric: "response_time", state: "locked", confidence_level: null, freshness_band: null },
        { metric: "creator_activity", state: "available", confidence_level: "emerging", freshness_band: null },
      ],
    });
    expect(parsed.status).toBe("error");
  });

  it("rejects freshness on a weak confidence", () => {
    const parsed = parseMetricConfidence({
      result: "ok",
      metrics: [
        { metric: "response_rate", state: "locked", confidence_level: null, freshness_band: null },
        { metric: "response_time", state: "not_enough_data", confidence_level: null, freshness_band: null },
        { metric: "creator_activity", state: "available", confidence_level: "emerging", freshness_band: "past_month" },
      ],
    });
    expect(parsed.status).toBe("error");
  });

  it("treats an insufficient network row with extra keys as an error", () => {
    expect(parseNetworkAggregate({ result: "insufficient", sample_size: 1 }).status).toBe("error");
    expect(parseNetworkAggregate({ result: "ok", has_observed_collaboration: false }).status).toBe("error");
  });

  it("rejects another creator on a personal aggregate", () => {
    expect(
      parsePersonalAggregate({
        result: "ok",
        manual_events: 1,
        gmail_events: 0,
        last_event_at: null,
        collaboration_types: [],
        creator_id: HOTEL,
      }).status,
    ).toBe("error");
  });

  it("rejects a locked fit that includes hotels and a score", () => {
    expect(parseCreatorFit({ result: "locked", hotels: [] }).status).toBe("error");
    expect(
      parseCreatorFit({
        result: "ok",
        detailed: false,
        prior_applied: false,
        prior_reason: "no_proven_lift",
        hotels: [
          {
            hotel_id: HOTEL,
            activity_label: "High",
            matched_type: "stay",
            score: 9,
          },
        ],
      }).status,
    ).toBe("error");
  });
});
