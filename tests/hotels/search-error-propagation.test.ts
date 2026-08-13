/**
 * F3 — a destination-lookup failure is not "no hotels match".
 *
 * `searchHotels` resolves matching destinations before filtering hotels. If
 * that preliminary query fails and its error is ignored, the search silently
 * degrades into a hotel-name-only search and Discover reports "No hotels match
 * these filters" — a false statement about the catalog.
 *
 * These tests drive the real `searchHotels` with an injected stand-in client,
 * so they verify the shipped code path rather than a re-implementation.
 */
import { describe, expect, it } from "vitest";

import { parseDiscoverQuery } from "@/lib/hotels/filters";
import { searchHotels, type HotelQueryClient } from "@/lib/hotels/queries";

type Outcome = { data: unknown; error: unknown; count?: number | null };

/**
 * Minimal stand-in for the chainable PostgREST builder. Every filter method
 * returns `this`; awaiting the builder resolves the configured outcome.
 */
function builder(outcome: Outcome, executed: string[], table: string) {
  // Only record when the query is actually EXECUTED (awaited), not when the
  // builder is constructed — searchHotels builds the hotels query up front.
  const run = () => {
    executed.push(table);
    return Promise.resolve(outcome);
  };
  const chain: Record<string, unknown> = {
    select: () => chain,
    or: () => chain,
    eq: () => chain,
    gte: () => chain,
    order: () => chain,
    limit: () => run(),
    range: () => run(),
    maybeSingle: () => run(),
    then: (resolve: (v: Outcome) => unknown) => run().then(resolve),
  };
  return chain;
}

function fakeClient(outcomes: Record<string, Outcome>, executed: string[]): HotelQueryClient {
  return {
    from: (table: string) =>
      builder(outcomes[table] ?? { data: [], error: null, count: 0 }, executed, table),
  } as unknown as HotelQueryClient;
}

const OK_HOTELS: Outcome = { data: [], error: null, count: 0 };

describe("F3 — destination lookup errors propagate", () => {
  it("throws a sanitized search failure when the destination lookup fails", async () => {
    const calls: string[] = [];
    const client = fakeClient(
      {
        destinations: { data: null, error: { code: "57014", message: "statement timeout" } },
        hotels: OK_HOTELS,
      },
      calls,
    );

    await expect(searchHotels(parseDiscoverQuery({ q: "dubai" }), client)).rejects.toThrow(
      /hotel_search_failed:destination_lookup/,
    );
  });

  it("does NOT silently continue as a hotel-name-only search", async () => {
    const calls: string[] = [];
    const client = fakeClient(
      {
        destinations: { data: null, error: { message: "boom" } },
        // If the failure were ignored, this would resolve to zero rows and the
        // caller would render "No hotels match these filters".
        hotels: OK_HOTELS,
      },
      calls,
    );

    await expect(searchHotels(parseDiscoverQuery({ q: "dubai" }), client)).rejects.toBeInstanceOf(
      Error,
    );
    // The hotels query must never have been EXECUTED after the lookup failed.
    expect(calls).toContain("destinations");
    expect(calls).not.toContain("hotels");
  });

  it("never leaks the raw database error to the caller", async () => {
    const client = fakeClient(
      {
        destinations: {
          data: null,
          error: { message: 'relation "destinations" does not exist at 10.1.2.3:5432' },
        },
        hotels: OK_HOTELS,
      },
      [],
    );

    try {
      await searchHotels(parseDiscoverQuery({ q: "dubai" }), client);
      throw new Error("expected a search failure");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toBe("hotel_search_failed:destination_lookup");
      expect(message).not.toContain("10.1.2.3");
      expect(message).not.toContain("does not exist");
    }
  });

  it("a successful destination lookup still searches hotels normally", async () => {
    const calls: string[] = [];
    const client = fakeClient(
      {
        destinations: { data: [{ id: "d0000000-0000-0000-0000-0000000000aa" }], error: null },
        hotels: { data: [], error: null, count: 0 },
      },
      calls,
    );

    const result = await searchHotels(parseDiscoverQuery({ q: "dubai" }), client);
    expect(calls).toContain("destinations");
    expect(calls).toContain("hotels");
    expect(result.hotels).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("a search with no term skips the destination lookup entirely", async () => {
    const calls: string[] = [];
    const client = fakeClient({ hotels: { data: [], error: null, count: 0 } }, calls);

    await searchHotels(parseDiscoverQuery({}), client);
    expect(calls).not.toContain("destinations");
    expect(calls).toContain("hotels");
  });

  it("propagates a failure of the main hotels query too", async () => {
    const client = fakeClient(
      { hotels: { data: null, error: { code: "42501" }, count: null } },
      [],
    );
    await expect(searchHotels(parseDiscoverQuery({}), client)).rejects.toThrow(
      /hotel_search_failed/,
    );
  });
});
