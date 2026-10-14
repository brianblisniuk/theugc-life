/**
 * Discover applies one H01 metric (D130).
 *
 * Locked premium reads return no hotels and do not query the premium view.
 * Below the floor is not an empty catalog and not a zero. The order is the
 * rank key, then hotel id, never the hotel name.
 */
import { describe, expect, it } from "vitest";

import { parseDiscoverQuery } from "@/lib/hotels/filters";
import type { HotelQueryClient } from "@/lib/hotels/queries";
import { METRIC_TITLES, THRESHOLD_RULES } from "@/lib/metrics/contract";
import { searchRankedHotels } from "@/lib/metrics/discover-rank";

const DEST = "d1300000-0000-4000-8000-000000000001";
const HIGH = "a1300000-0000-4000-8000-000000000001";
const LOW = "a1300000-0000-4000-8000-000000000002";
const ZERO = "a1300000-0000-4000-8000-000000000003";

interface Call {
  table: string;
  eqs: [string, unknown][];
  orders: [string, boolean][];
  ins: [string, unknown][];
  rpcArgs?: Record<string, unknown>;
}

function hotelRow(id: string, name: string) {
  return {
    id,
    name,
    slug: `hotel-${id.slice(-4)}`,
    hotel_type: "hotel",
    star_rating: 5,
    country_code: "ID",
    website_url: null,
    instagram_url: null,
    address: null,
    active_status: "active",
    editorial_verification_status: "unverified",
    editorial_verified_at: null,
    destination_id: DEST,
    latitude: -8.4,
    longitude: 115.1,
    star_rating_source: null,
    star_rating_confidence: null,
    destination: { id: DEST, name: "Bali", slug: "bali", country_code: "ID" },
  };
}

function client(
  calls: Call[],
  resolve: (call: Call) => { data: unknown; error: unknown; count?: number | null },
  rpc: (
    name: string,
    args?: Record<string, unknown>,
  ) => { data: unknown; error: unknown } = () => ({
    data: null,
    error: { code: "unexpected" },
  }),
): HotelQueryClient {
  return {
    from(table: string) {
      const call: Call = { table, eqs: [], orders: [], ins: [] };
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (column: string, value: unknown) => {
          call.eqs.push([column, value]);
          return chain;
        },
        in: (column: string, values: unknown) => {
          call.ins.push([column, values]);
          return chain;
        },
        gte: () => chain,
        lte: () => chain,
        or: () => chain,
        order: (column: string, options?: { ascending?: boolean }) => {
          call.orders.push([column, options?.ascending !== false]);
          return chain;
        },
        limit: () => {
          calls.push(call);
          return Promise.resolve(resolve(call));
        },
        range: () => {
          calls.push(call);
          return Promise.resolve(resolve(call));
        },
      };
      return chain;
    },
    async rpc(name: string, args?: Record<string, unknown>) {
      calls.push({ table: `rpc:${name}`, eqs: [], orders: [], ins: [], rpcArgs: args });
      return rpc(name, args);
    },
  } as unknown as HotelQueryClient;
}

function ranking(metric: "creator_activity" | "response_rate", hotels: unknown[], result = "ok") {
  return {
    result,
    metric,
    title: METRIC_TITLES[metric],
    layer: metric === "creator_activity" ? "public" : "premium",
    scope: "destination_and_descendants",
    threshold_rule: THRESHOLD_RULES[metric],
    ...(result === "ok" ? { hotels } : {}),
  };
}

const creator = {
  status: "authenticated" as const,
  session: { userId: "user-a", email: null, role: "creator" as const },
};

describe("searchRankedHotels", () => {
  it("keeps the destination ranking order and does not sort by name", async () => {
    const calls: Call[] = [];
    const db = client(
      calls,
      (call) => {
        if (call.table === "destinations") {
          return {
            data: [{ id: DEST, slug: "bali", parent_destination_id: null }],
            error: null,
          };
        }
        const ids = (call.ins.find(([column]) => column === "id")?.[1] as string[]) ?? [];
        return {
          data: ids.map((id) => hotelRow(id, id === HIGH ? "Zulu" : "Alpha")),
          error: null,
        };
      },
      () => ({
        data: ranking("creator_activity", [
          {
            hotel_id: HIGH,
            rank: 1,
            value_label: "High",
            sample_basis: "Based on activity from 5 creators",
          },
          { hotel_id: LOW, rank: 2, value_label: "Emerging", sample_basis: null },
        ]),
        error: null,
      }),
    );

    const result = await searchRankedHotels(
      parseDiscoverQuery({ destination: "bali", rank: "creator_activity" }),
      {
        client: db,
      },
    );
    expect(result.kind).toBe("list");
    if (result.kind !== "list") return;
    expect(result.result.hotels.map((hotel) => hotel.id)).toEqual([HIGH, LOW]);
    expect(result.result.hotels.map((hotel) => hotel.name)).toEqual(["Zulu", "Alpha"]);
    expect(result.lines.get(HIGH)?.rank).toBe(1);
    expect(calls.some((call) => call.table === "hotel_metric_signal_public")).toBe(false);
    expect(calls.some((call) => call.table === "hotel_metric_signal_premium")).toBe(false);
    const rpc = calls.find((call) => call.table === "rpc:read_destination_metric_ranking");
    expect(rpc?.rpcArgs).toEqual({ p_destination_id: DEST, p_metric: "creator_activity" });
  });

  it("returns a locked premium ranking with no hotels and no premium read", async () => {
    const calls: Call[] = [];
    const db = client(
      calls,
      (call) => {
        if (call.table === "destinations") {
          return {
            data: [{ id: DEST, slug: "bali", parent_destination_id: null }],
            error: null,
          };
        }
        return { data: [hotelRow(HIGH, "Hidden")], error: null };
      },
      () => ({
        data: ranking("response_rate", [], "locked"),
        error: null,
      }),
    );
    const result = await searchRankedHotels(
      parseDiscoverQuery({ destination: "bali", rank: "response_rate" }),
      { client: db },
    );
    expect(result.kind).toBe("locked");
    expect(JSON.stringify(result)).not.toContain(HIGH);
    expect(JSON.stringify(result)).not.toContain("Hidden");
    expect(calls.some((call) => call.table === "hotels")).toBe(false);
    expect(calls.some((call) => call.table === "hotel_metric_signal_premium")).toBe(false);
  });

  it("treats an empty destination ranking as not enough data, not a catalog", async () => {
    const calls: Call[] = [];
    const db = client(
      calls,
      () => ({
        data: [{ id: DEST, slug: "bali", parent_destination_id: null }],
        error: null,
      }),
      () => ({ data: ranking("creator_activity", []), error: null }),
    );
    const result = await searchRankedHotels(
      parseDiscoverQuery({ destination: "bali", rank: "creator_activity" }),
      { client: db },
    );
    expect(result.kind).toBe("below_floor");
    expect(calls.some((call) => call.table === "hotels")).toBe(false);
  });

  it("does not query reply rate for a caller with no Pass or Pro", async () => {
    const calls: Call[] = [];
    const db = client(
      calls,
      () => ({ data: [hotelRow(HIGH, "Hidden")], error: null }),
      (name) => {
        if (name === "has_active_pro") return { data: false, error: null };
        return { data: null, error: { code: "unexpected" } };
      },
    );
    const result = await searchRankedHotels(parseDiscoverQuery({ rank: "response_rate" }), {
      client: db,
      session: creator,
      billing: { status: "ok", entitlements: [] },
    });
    expect(result.kind).toBe("locked");
    expect(JSON.stringify(result)).not.toContain("Hidden");
    expect(calls.map((call) => call.table)).toEqual(["rpc:has_active_pro"]);
  });

  it("orders the public view by rank key then hotel id, and keeps a measured zero", async () => {
    const calls: Call[] = [];
    const signals = [
      {
        hotel_id: LOW,
        metric: "response_rate",
        rank_key: 10,
        value_label: "10%",
        sample_basis: null,
      },
      {
        hotel_id: ZERO,
        metric: "response_rate",
        rank_key: 0,
        value_label: "0%",
        sample_basis: null,
      },
      {
        hotel_id: HIGH,
        metric: "response_rate",
        rank_key: 80,
        value_label: "80%",
        sample_basis: null,
      },
    ];
    const db = client(
      calls,
      (call) => {
        if (call.table === "hotel_metric_signal_premium") {
          return { data: signals, error: null, count: signals.length };
        }
        const ids = (call.ins.find(([column]) => column === "id")?.[1] as string[]) ?? [];
        return { data: ids.map((id) => hotelRow(id, id)), error: null };
      },
      (name) =>
        name === "has_active_pro" ? { data: true, error: null } : { data: null, error: null },
    );
    const result = await searchRankedHotels(parseDiscoverQuery({ rank: "response_rate" }), {
      client: db,
      session: creator,
    });
    expect(result.kind).toBe("list");
    if (result.kind !== "list") return;
    expect(result.result.hotels.map((hotel) => hotel.id)).toEqual([HIGH, LOW, ZERO]);
    expect(result.lines.get(ZERO)?.valueLabel).toBe("0%");
    const view = calls.find((call) => call.table === "hotel_metric_signal_premium");
    expect(view?.orders).toEqual([
      ["rank_key", false],
      ["hotel_id", true],
    ]);
    expect(view?.eqs).toEqual([["metric", "response_rate"]]);
    expect(view?.orders.some(([column]) => column !== "rank_key" && column !== "hotel_id")).toBe(
      false,
    );
  });

  it("fails a malformed metric row instead of publishing an empty ranking", async () => {
    const db = client([], () => ({
      data: [
        {
          hotel_id: HIGH,
          metric: "creator_activity",
          rank_key: 1,
          value_label: "composite",
          sample_basis: null,
        },
      ],
      error: null,
      count: 1,
    }));
    await expect(
      searchRankedHotels(parseDiscoverQuery({ rank: "creator_activity" }), { client: db }),
    ).rejects.toThrow("hotel_search_failed:metric_rank");
  });
});
