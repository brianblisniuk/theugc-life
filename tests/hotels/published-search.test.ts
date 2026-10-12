/**
 * searchHotels applies the publication predicate and drops a row that fails
 * it even if the query returned it.
 */
import { describe, expect, it } from "vitest";

import { parseDiscoverQuery } from "@/lib/hotels/filters";
import { searchHotels, type HotelQueryClient } from "@/lib/hotels/queries";

type Call = { table: string; method: string; args: unknown[] };

function client(rows: unknown[], calls: Call[]): HotelQueryClient {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      const record =
        (method: string) =>
        (...args: unknown[]) => {
          calls.push({ table, method, args });
          return chain;
        };
      for (const method of ["select", "or", "eq", "gte", "lte", "neq", "in", "order"]) {
        chain[method] = record(method);
      }
      chain.limit = (...args: unknown[]) => {
        calls.push({ table, method: "limit", args });
        return Promise.resolve({ data: [], error: null, count: 0 });
      };
      chain.range = (...args: unknown[]) => {
        calls.push({ table, method: "range", args });
        return Promise.resolve({ data: rows, error: null, count: rows.length });
      };
      chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
      return chain;
    },
  } as unknown as HotelQueryClient;
}

const published = {
  id: "4a000000-0000-0000-0000-0000000000aa",
  name: "Kept Hotel",
  slug: "kept-hotel",
  hotel_type: "hotel",
  star_rating: 5,
  country_code: "AE",
  website_url: null,
  instagram_url: null,
  address: null,
  active_status: "unknown",
  editorial_verification_status: "unverified",
  editorial_verified_at: null,
  destination_id: "d1",
  latitude: 25.2,
  longitude: 55.2,
  destination: { id: "d1", name: "Dubai", slug: "dubai", country_code: "AE" },
};

const closed = {
  ...published,
  id: "4a000000-0000-0000-0000-0000000000bb",
  name: "Closed Hotel",
  active_status: "closed",
};

const unlocated = {
  ...published,
  id: "4a000000-0000-0000-0000-0000000000cc",
  name: "Unlocated Hotel",
  latitude: null,
  longitude: null,
};

describe("searchHotels publication filter", () => {
  it("always constrains stars, coordinates, and active status", async () => {
    const calls: Call[] = [];
    await searchHotels(parseDiscoverQuery({}), client([], calls));
    const hotelCalls = calls.filter((call) => call.table === "hotels");
    expect(hotelCalls).toContainEqual({
      table: "hotels",
      method: "in",
      args: ["star_rating", [4, 5]],
    });
    expect(hotelCalls).toContainEqual({
      table: "hotels",
      method: "gte",
      args: ["latitude", -90],
    });
    expect(hotelCalls).toContainEqual({
      table: "hotels",
      method: "lte",
      args: ["latitude", 90],
    });
    expect(hotelCalls).toContainEqual({
      table: "hotels",
      method: "in",
      args: ["active_status", ["active", "temporarily_closed", "unknown"]],
    });
    const serialized = JSON.stringify(hotelCalls);
    expect(serialized).not.toContain("reply_rate");
    expect(serialized).not.toContain("email");
  });

  it("does not render a closed or unlocated row, and does not put coordinates on the card", async () => {
    const result = await searchHotels(
      parseDiscoverQuery({}),
      client([published, closed, unlocated], []),
    );
    expect(result.hotels.map((hotel) => hotel.name)).toEqual(["Kept Hotel"]);
    expect(result.hotels[0]).not.toHaveProperty("latitude");
    expect(result.hotels[0]).not.toHaveProperty("longitude");
    expect(result.pins).toEqual([
      {
        id: published.id,
        name: "Kept Hotel",
        latitude: 25.2,
        longitude: 55.2,
      },
    ]);
    expect(JSON.stringify(result.hotels)).not.toContain("Closed Hotel");
    expect(JSON.stringify(result.hotels)).not.toContain("Unlocated Hotel");
  });
});
