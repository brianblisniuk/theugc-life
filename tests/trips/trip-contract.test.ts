/**
 * Trip form parsing and summary display. No database.
 *
 * Unknown must render as the word Unknown. A real zero renders as 0.
 * A summary payload that is missing a figure is an error, not a zero.
 */
import { describe, expect, it } from "vitest";

import { formatTripMetric, tripLimitMessage } from "@/lib/trips/display";
import { parseTripForm } from "@/lib/trips/input";
import { mapTripSummary, mapTripWriteResult } from "@/lib/trips/types";

const DEST = "d0100000-0000-0000-0000-0000000000aa";

describe("parseTripForm", () => {
  it("accepts a private-by-omission trip and drops a blank name", () => {
    const parsed = parseTripForm({
      destinationId: DEST,
      name: "   ",
      startDate: "2026-11-01",
      endDate: "2026-11-08",
      status: "planning",
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.name).toBeNull();
    expect(parsed.value.status).toBe("planning");
  });

  it("rejects an end date before the start date", () => {
    const parsed = parseTripForm({
      destinationId: DEST,
      name: "Bali",
      startDate: "2026-11-08",
      endDate: "2026-11-01",
      status: "upcoming",
    });
    expect(parsed.ok).toBe(false);
  });

  it("rejects a name past the technical bound and a non-catalog status", () => {
    const longName = "a".repeat(121);
    expect(
      parseTripForm({
        destinationId: DEST,
        name: longName,
        startDate: "2026-11-01",
        endDate: "2026-11-08",
        status: "planning",
      }).ok,
    ).toBe(false);
    expect(
      parseTripForm({
        destinationId: DEST,
        startDate: "2026-11-01",
        endDate: "2026-11-08",
        status: "secret",
      }).ok,
    ).toBe(false);
    expect(
      parseTripForm({
        destinationId: "not-a-uuid",
        startDate: "2026-02-31",
        endDate: "2026-11-08",
        status: "planning",
      }).ok,
    ).toBe(false);
  });
});

describe("summary display", () => {
  it("does not render unknown as zero", () => {
    expect(formatTripMetric(null)).toBe("Unknown");
    expect(formatTripMetric(null)).not.toBe("0");
    expect(formatTripMetric(0)).toBe("0");
    expect(formatTripMetric(2)).toBe("2");
  });

  it("states the configured allowance without hardcoding a second number", () => {
    expect(tripLimitMessage(1)).toContain("1 active trip");
    expect(tripLimitMessage(1)).not.toContain("0");
  });
});

describe("mapTripSummary", () => {
  it("preserves nulls and integers", () => {
    const mapped = mapTripSummary({
      result: "ok",
      target_hotels: null,
      pitched: null,
      replies: null,
      negotiations: null,
      confirmed_collaborations: null,
      followups_due: null,
    });
    expect(mapped.status).toBe("ok");
    if (mapped.status !== "ok") return;
    expect(mapped.metrics.targetHotels).toBeNull();
    expect(mapped.metrics.pitched).toBeNull();
  });

  it("refuses to coerce a missing or string figure into zero", () => {
    expect(
      mapTripSummary({
        result: "ok",
        target_hotels: "0",
        pitched: 0,
        replies: 0,
        negotiations: 0,
        confirmed_collaborations: 0,
        followups_due: 0,
      }).status,
    ).toBe("error");
    expect(mapTripSummary({ result: "ok", target_hotels: 0 }).status).toBe("error");
    expect(mapTripWriteResult({ result: "limit_reached", limit: "1", active_count: 1 })).toEqual({
      result: "error",
    });
  });
});
