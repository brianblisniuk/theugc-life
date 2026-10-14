import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  METRIC_READ_NOTICE,
  parseHotelSignals,
  parseRanking,
  THRESHOLD_RULES,
} from "@/lib/metrics/contract";

const ROOT = path.resolve(import.meta.dirname, "../..");

describe("metric ranking contract", () => {
  it("treats a failed read as a notice, not an empty ranking", () => {
    expect(parseHotelSignals(null)).toEqual({ status: "error", notice: METRIC_READ_NOTICE });
    expect(parseRanking(null, "response_rate")).toEqual({
      status: "error",
      notice: METRIC_READ_NOTICE,
    });
    expect(parseRanking({ result: "ok", hotels: [] }, "response_rate").status).toBe("error");
  });

  it("keeps a real empty ranking and rejects a locked payload that lists hotels", () => {
    const empty = parseRanking(
      {
        result: "ok",
        metric: "response_rate",
        title: "Most responsive",
        layer: "premium",
        scope: "destination_and_descendants",
        threshold_rule: THRESHOLD_RULES.response_rate,
        hotels: [],
      },
      "response_rate",
    );
    expect(empty).toMatchObject({ status: "ok", hotels: [] });

    const locked = parseRanking(
      {
        result: "locked",
        metric: "response_rate",
        title: "Most responsive",
        layer: "premium",
        scope: "destination_and_descendants",
        threshold_rule: THRESHOLD_RULES.response_rate,
      },
      "response_rate",
    );
    expect(locked.status).toBe("locked");

    const leaked = parseRanking(
      {
        result: "locked",
        metric: "response_rate",
        title: "Most responsive",
        layer: "premium",
        scope: "destination_and_descendants",
        threshold_rule: THRESHOLD_RULES.response_rate,
        hotels: [],
      },
      "response_rate",
    );
    expect(leaked.status).toBe("error");
  });

  it("rejects creator identity, a small sample, a raw hour count, and a zero below the floor", () => {
    const base = {
      metric: "response_rate",
      title: "Most responsive",
      layer: "premium",
      state: "available",
      value_label: "0%",
      sample_basis: "Based on activity from 5 creators",
      threshold_rule: THRESHOLD_RULES.response_rate,
    };
    expect(
      parseHotelSignals({
        result: "ok",
        metrics: [
          base,
          {
            metric: "response_time",
            title: "Fastest replying",
            layer: "premium",
            state: "not_enough_data",
            value_label: null,
            sample_basis: null,
            threshold_rule: THRESHOLD_RULES.response_time,
          },
          {
            metric: "creator_activity",
            title: "Most active with creators",
            layer: "public",
            state: "not_enough_data",
            value_label: null,
            sample_basis: null,
            threshold_rule: THRESHOLD_RULES.creator_activity,
          },
        ],
      }).status,
    ).toBe("ok");

    expect(
      parseHotelSignals({
        result: "ok",
        owner_user_id: "h0110000-0000-4000-8000-000000000001",
        metrics: [],
      }).status,
    ).toBe("error");
    expect(
      parseHotelSignals({
        result: "ok",
        metrics: [{ ...base, sample_basis: "Based on activity from 3 creators" }],
      }).status,
    ).toBe("error");
    expect(
      parseHotelSignals({
        result: "ok",
        metrics: [
          {
            metric: "response_time",
            title: "Fastest replying",
            layer: "premium",
            state: "available",
            value_label: "2 hours",
            sample_basis: null,
            threshold_rule: THRESHOLD_RULES.response_time,
          },
        ],
      }).status,
    ).toBe("error");
    expect(
      parseHotelSignals({
        result: "ok",
        metrics: [{ ...base, state: "not_enough_data", value_label: "0%" }],
      }).status,
    ).toBe("error");
  });

  it("does not change Discover, Pipeline, or Home ordering", () => {
    const files = [
      "src/lib/hotels/queries.ts",
      "src/lib/pipeline/queries.ts",
      "src/app/(app)/app/discover/page.tsx",
      "src/app/(app)/app/pipeline/page.tsx",
      "src/lib/home/next-actions.ts",
      "src/lib/home/queries.ts",
    ];
    for (const file of files) {
      const text = readFileSync(path.join(ROOT, file), "utf8");
      expect(text, file).not.toContain("read_destination_metric_ranking");
      expect(text, file).not.toContain("hotel_metric_signal");
      expect(text, file).not.toContain("@/lib/metrics");
    }
  });
});
