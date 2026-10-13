/**
 * Destination chips are catalog matches. Search does not invent a place.
 */
import { describe, expect, it } from "vitest";

import {
  filterDestinations,
  isDestinationId,
  nearbyDestinations,
  suggestedChips,
  type DestinationChoice,
} from "@/lib/onboarding/destination";

const CATALOG: DestinationChoice[] = [
  { id: "11111111-1111-4111-8111-111111111111", name: "Riviera Maya", slug: "riviera", countryCode: "MX" },
  { id: "22222222-2222-4222-8222-222222222222", name: "México", slug: "mexico", countryCode: "MX" },
  { id: "33333333-3333-4333-8333-333333333333", name: "Bali", slug: "bali", countryCode: "ID" },
  { id: "44444444-4444-4444-8444-444444444444", name: "Japón", slug: "japon", countryCode: "JP" },
  { id: "55555555-5555-4555-8555-555555555555", name: "Oaxaca", slug: "oaxaca", countryCode: "MX" },
];

describe("destination question", () => {
  it("offers Bali, México, and Japón in that order and skips other catalog names", () => {
    expect(suggestedChips(CATALOG).map((row) => row.slug)).toEqual(["bali", "mexico", "japon"]);
    expect(suggestedChips([{ ...CATALOG[0]! }])).toEqual([]);
  });

  it("search only narrows names that already exist", () => {
    expect(filterDestinations(CATALOG, "jap").map((row) => row.slug)).toEqual(["japon"]);
    expect(filterDestinations(CATALOG, "Méx").map((row) => row.slug)).toEqual(["mexico"]);
    expect(filterDestinations(CATALOG, "atlantis")).toEqual([]);
  });

  it("nearby stays in the same country when the catalog knows one", () => {
    const mexico = CATALOG[1]!;
    expect(nearbyDestinations(CATALOG, mexico.id).map((row) => row.slug)).toEqual([
      "riviera",
      "oaxaca",
    ]);
    expect(nearbyDestinations(CATALOG, null).length).toBeLessThanOrEqual(6);
  });

  it("rejects a destination id that is not a uuid", () => {
    expect(isDestinationId("bali")).toBe(false);
    expect(isDestinationId(CATALOG[2]!.id)).toBe(true);
  });
});
