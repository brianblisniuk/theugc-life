/**
 * F03 order (D130). One metric. rank_key descending, then hotel id.
 * A second field does not move a row. A zero that cleared the floor stays.
 * A null rank key is below the floor and is omitted by the caller, not sorted last.
 */
import { describe, expect, it } from "vitest";

import { compareHotelId, orderByRankKey, parseMetricRank } from "@/lib/metrics/order";

describe("orderByRankKey", () => {
  it("orders one metric by rank key descending, then hotel id", () => {
    const rows = [
      { hotelId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", rankKey: 2, name: "Alpha" },
      { hotelId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1", rankKey: 2, name: "Zulu" },
      { hotelId: "cccccccc-cccc-4ccc-8ccc-ccccccccccc3", rankKey: 5, name: "Middle" },
      { hotelId: "dddddddd-dddd-4ddd-8ddd-ddddddddddd4", rankKey: 0, valueLabel: "0%" },
    ];
    expect(orderByRankKey(rows).map((row) => row.hotelId)).toEqual([
      "cccccccc-cccc-4ccc-8ccc-ccccccccccc3",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
      "dddddddd-dddd-4ddd-8ddd-ddddddddddd4",
    ]);
  });

  it("ignores a name, a timestamp, and a second metric", () => {
    const slow = {
      hotelId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
      rankKey: 5,
      name: "Zebra",
      createdAt: "2020-01-01",
      responseRate: 1,
    };
    const fast = {
      hotelId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
      rankKey: 1,
      name: "Alpha",
      createdAt: "2026-01-01",
      responseRate: 99,
    };
    expect(orderByRankKey([fast, slow]).map((row) => row.hotelId)).toEqual([
      slow.hotelId,
      fast.hotelId,
    ]);
    expect(compareHotelId(fast.hotelId, slow.hotelId)).toBeLessThan(0);
  });

  it("drops a composite or unknown rank param", () => {
    expect(parseMetricRank("response_rate")).toBe("response_rate");
    expect(parseMetricRank("response_rate,creator_activity")).toBeNull();
    expect(parseMetricRank("score")).toBeNull();
    expect(parseMetricRank(["creator_activity", "response_time"])).toBe("creator_activity");
    expect(parseMetricRank(undefined)).toBeNull();
  });
});
