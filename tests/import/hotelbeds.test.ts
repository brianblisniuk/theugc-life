/**
 * D106 Hotelbeds import. Pure planning, page parsing, and the local-only
 * apply guard. No API client and no credential read.
 */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { renderMatchesCsv } from "../../scripts/import-hotelbeds/csv";
import {
  needsCategoryReview,
  parseHotel,
  parseHotelsPayload,
  readHotelbedsPages,
  starFromCategory,
  usableCoordinates,
  type RawHotelbedsHotel,
} from "../../scripts/import-hotelbeds/parse";
import {
  buildPatch,
  coordinateFill,
  planHotelbedsImport,
  reviewMatches,
  websiteFill,
  type CanonicalHotel,
  type DestinationHit,
} from "../../scripts/import-hotelbeds/plan";
import { assertHotelbedsApplyIsLocal } from "../../scripts/import-hotelbeds/run";

const bali: DestinationHit = { id: "dest-bali", slug: "bali", countryCode: "ID" };
const destinations = new Map<string, DestinationHit[]>([["bai", [bali]]]);

function raw(overrides: Partial<RawHotelbedsHotel> = {}): RawHotelbedsHotel {
  return {
    code: "100",
    name: "Unique Tower",
    categoryCode: "5EST",
    latitude: 25.2,
    longitude: 55.27,
    destinationCode: "BAI",
    accommodationTypeCode: "H",
    web: "https://tower.example",
    ...overrides,
  };
}

function existing(overrides: Partial<CanonicalHotel> = {}): CanonicalHotel {
  return {
    id: "hotel-1",
    name: "Same Name Hotel",
    latitude: -8.4,
    longitude: 115.2,
    websiteUrl: "https://owner.example",
    starRatingSource: "owner",
    hotelbedsCode: null,
    ...overrides,
  };
}

function north(latitude: number, metres: number): number {
  return latitude + metres / 111_320;
}

describe("Hotelbeds category and outlier flag", () => {
  it("maps only the four reviewed hotel-star codes", () => {
    expect(starFromCategory("4EST")).toBe(4);
    expect(starFromCategory("4LUX")).toBe(4);
    expect(starFromCategory("5EST")).toBe(5);
    expect(starFromCategory("5LUX")).toBe(5);
    expect(starFromCategory("H4_5")).toBeNull();
    expect(starFromCategory("H5_5")).toBeNull();
    expect(starFromCategory("5LL")).toBeNull();
    expect(starFromCategory("3EST")).toBeNull();
    expect(starFromCategory("5EST ")).toBeNull();
    expect(starFromCategory(null)).toBeNull();
  });

  it("flags an apartment, residence, or villa and not a village or a plain hotel", () => {
    expect(needsCategoryReview("The Residences at Example", "H")).toBe(true);
    expect(needsCategoryReview("Example Apartment", "H")).toBe(true);
    expect(needsCategoryReview("Villa Complex Bali", "H")).toBe(true);
    expect(needsCategoryReview("Sunrise", "P")).toBe(true);
    expect(needsCategoryReview("The Village Hotel", "H")).toBe(false);
    expect(needsCategoryReview("Hotel Bali", "H")).toBe(false);
  });

  it("rejects null island and out-of-range coordinates", () => {
    expect(usableCoordinates(0, 0)).toBe(false);
    expect(usableCoordinates(91, 0)).toBe(false);
    expect(usableCoordinates(-8.4, 115.2)).toBe(true);
  });
});

describe("Hotelbeds page parsing", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("copies only the D106 fields and drops a contact email sitting on the record", () => {
    const parsed = parseHotel({
      code: 4242,
      name: { content: "  Kept Name  " },
      categoryCode: "5EST",
      coordinates: { latitude: "1.5", longitude: 2.5 },
      destinationCode: "BAI",
      accommodationTypeCode: "H",
      web: " https://kept.example ",
      email: "hidden-contact@example.com",
      phones: [{ phoneNumber: "+620000" }],
    });
    expect(parsed).toEqual({
      code: "4242",
      name: "Kept Name",
      categoryCode: "5EST",
      latitude: 1.5,
      longitude: 2.5,
      destinationCode: "BAI",
      accommodationTypeCode: "H",
      web: "https://kept.example",
    });
    expect(JSON.stringify(parsed)).not.toContain("hidden-contact@example.com");
    expect(JSON.stringify(parsed)).not.toContain("+620000");
  });

  it("requires a hotels array and does not echo a broken file's contents", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hb01-parse-"));
    dirs.push(dir);
    await writeFile(path.join(dir, "bad.json"), '{ "apiKey": "super-secret-value"');
    await expect(readHotelbedsPages(dir)).rejects.toThrow(/Invalid JSON in bad.json/);
    await expect(readHotelbedsPages(dir)).rejects.not.toThrow(/super-secret-value/);
  });

  it("reads json pages in filename order and ignores a credential file beside them", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "hb01-parse-"));
    dirs.push(dir);
    await writeFile(
      path.join(dir, "credentials.env"),
      "HOTELBEDS_API_KEY=should-not-be-read\nHOTELBEDS_SECRET=also-not-read\n",
    );
    await writeFile(
      path.join(dir, "b.json"),
      JSON.stringify({ hotels: [raw({ code: "2", name: "Second" })] }),
    );
    await writeFile(
      path.join(dir, "a.json"),
      JSON.stringify({ hotels: [raw({ code: "1", name: "First" })] }),
    );
    const hotels = await readHotelbedsPages(dir);
    expect(hotels.map((hotel) => hotel.code)).toEqual(["1", "2"]);
    expect(JSON.stringify(hotels)).not.toContain("should-not-be-read");
    expect(JSON.stringify(hotels)).not.toContain("also-not-read");
    expect(parseHotelsPayload({ hotels: [] }, "empty.json")).toEqual([]);
  });
});

describe("Hotelbeds plan", () => {
  it("inserts a new type-H 4/5 hotel and skips everything else", () => {
    const plan = planHotelbedsImport(
      [
        raw({ code: "1", categoryCode: "4LUX" }),
        raw({ code: "2", accommodationTypeCode: "W" }),
        raw({ code: "3", categoryCode: "H4_5" }),
        raw({ code: "4", categoryCode: "5LL" }),
        raw({ code: "5", latitude: 0, longitude: 0 }),
        raw({ code: "6", name: null }),
        raw({ code: null }),
        raw({ code: "7", destinationCode: "NOPE" }),
      ],
      [],
      destinations,
    );
    const inserts = plan.items.filter((item) => item.kind === "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      kind: "insert",
      eligible: { code: "1", starRating: 4, websiteUrl: "https://tower.example" },
    });
    expect(plan.items.filter((item) => item.kind === "skip").map((item) => item.reason)).toEqual([
      "missing_code",
      "not_hotel_type",
      "not_v1_category",
      "not_v1_category",
      "unusable_coordinates",
      "missing_name",
      "unresolved_destination",
    ]);
  });

  it("exports a similar name within 1 km and does not insert it", () => {
    const near = raw({
      code: "50",
      name: "Same Name Hotel",
      latitude: north(-8.4, 400),
      longitude: 115.2,
    });
    const plan = planHotelbedsImport([near], [existing()], destinations);
    expect(plan.items.map((item) => item.kind)).toEqual(["review"]);
    const matches = reviewMatches(plan);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      hotelbedsCode: "50",
      existingHotelId: "hotel-1",
    });
    expect(matches[0]!.distanceMetres).toBeLessThanOrEqual(1000);
    expect(matches[0]!.nameSimilarity).toBe(1);
  });

  it("inserts the same name beyond 1 km and a different name inside 1 km", () => {
    const far = raw({
      code: "51",
      name: "Same Name Hotel",
      latitude: north(-8.4, 2500),
      longitude: 115.2,
    });
    const different = raw({
      code: "52",
      name: "Completely Different Xyz",
      latitude: north(-8.4, 100),
      longitude: 115.2,
    });
    const plan = planHotelbedsImport([far, different], [existing()], destinations);
    expect(
      plan.items.filter((item) => item.kind === "insert").map((item) => item.eligible.code),
    ).toEqual(["51", "52"]);
    expect(reviewMatches(plan)).toEqual([]);
  });

  it("does not merge into the matched hotel and does not attach the Hotelbeds code", () => {
    const plan = planHotelbedsImport(
      [raw({ code: "50", name: "Same Name Hotel", latitude: north(-8.4, 400), longitude: 115.2 })],
      [existing()],
      destinations,
    );
    expect(plan.items.some((item) => item.kind === "upsert" || item.kind === "insert")).toBe(false);
  });

  it("upserts the same Hotelbeds code instead of inserting again", () => {
    const owned = existing({
      id: "owned",
      name: "Unique Tower",
      hotelbedsCode: "100",
      starRatingSource: "hotelbeds",
      latitude: null,
      longitude: null,
      websiteUrl: null,
    });
    const plan = planHotelbedsImport([raw()], [owned], destinations);
    expect(plan.items).toEqual([
      expect.objectContaining({ kind: "upsert", existingHotelId: "owned" }),
    ]);
    expect(reviewMatches(plan)).toEqual([]);
  });

  it("keeps the last copy of a duplicate code", () => {
    const plan = planHotelbedsImport(
      [raw({ code: "100", name: "First Name" }), raw({ code: "100", name: "Second Name" })],
      [],
      destinations,
    );
    const inserts = plan.items.filter((item) => item.kind === "insert");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ eligible: { name: "Second Name" } });
    expect(
      plan.items.some(
        (item) => item.kind === "skip" && item.reason === "duplicate_code_superseded",
      ),
    ).toBe(true);
  });

  it("refuses an ambiguous destination and accepts two aliases of one destination", () => {
    const ambiguous = new Map<string, DestinationHit[]>([
      ["bai", [bali, { id: "other", slug: "other", countryCode: "ID" }]],
    ]);
    const refused = planHotelbedsImport([raw()], [], ambiguous);
    expect(refused.items[0]).toMatchObject({ kind: "skip", reason: "ambiguous_destination" });

    const duplicated = new Map<string, DestinationHit[]>([["bai", [bali, { ...bali }]]]);
    const accepted = planHotelbedsImport([raw()], [], duplicated);
    expect(accepted.items[0]).toMatchObject({ kind: "insert" });
  });

  it("sets the outlier flag on an inserted residence and still inserts it", () => {
    const plan = planHotelbedsImport([raw({ name: "Unique Residences Tower" })], [], destinations);
    expect(plan.items[0]).toMatchObject({
      kind: "insert",
      eligible: { needsCategoryReview: true },
    });
  });
});

describe("owner coordinates and website", () => {
  const incoming = {
    code: "100",
    name: "Renamed By Hotelbeds",
    categoryCode: "5EST",
    starRating: 5 as const,
    latitude: 10,
    longitude: 20,
    destinationCode: "BAI",
    accommodationTypeCode: "H",
    websiteUrl: "https://hotelbeds.example",
    needsCategoryReview: false,
  };

  it("does not replace owner coordinates, stars, or website", () => {
    const patch = buildPatch(
      existing({ starRatingSource: "owner", latitude: 1, longitude: 2 }),
      incoming,
    );
    expect(patch.name).toBeNull();
    expect(patch.starRating).toBeNull();
    expect(patch.setProvenance).toBe(false);
    expect(patch.latitude).toBeNull();
    expect(patch.longitude).toBeNull();
    expect(patch.websiteUrl).toBeNull();
    expect(coordinateFill(1, null, 10, 20)).toBeNull();
    expect(websiteFill("https://owner.example", "https://hotelbeds.example")).toBeNull();
  });

  it("fills null coordinates and a null website on a Hotelbeds-owned row", () => {
    const patch = buildPatch(
      existing({
        starRatingSource: "hotelbeds",
        latitude: null,
        longitude: null,
        websiteUrl: null,
        hotelbedsCode: "100",
      }),
      incoming,
    );
    expect(patch).toMatchObject({
      name: "Renamed By Hotelbeds",
      starRating: 5,
      setProvenance: true,
      latitude: 10,
      longitude: 20,
      websiteUrl: "https://hotelbeds.example",
      hotelType: "hotel",
    });
  });
});

describe("review CSV and apply guard", () => {
  it("quotes fields and neutralises a formula-looking name", () => {
    const csv = renderMatchesCsv([
      {
        hotelbedsCode: "1",
        hotelbedsName: '=HYPERLINK("http://evil.example")',
        categoryCode: "5EST",
        starRating: 5,
        destinationCode: "BAI",
        accommodationTypeCode: "H",
        latitude: 1,
        longitude: 2,
        website: null,
        needsCategoryReview: false,
        existingHotelId: "hotel-1",
        existingHotelName: 'Say "hello"',
        existingLatitude: 1,
        existingLongitude: 2,
        distanceMetres: 10,
        nameSimilarity: 1,
      },
    ]);
    expect(csv.startsWith('"hotelbeds_code"')).toBe(true);
    expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"")"`);
    expect(csv).toContain('"Say ""hello"""');
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/);
  });

  it("refuses a remote apply target and does not echo the password", () => {
    expect(() =>
      assertHotelbedsApplyIsLocal("postgres://postgres:postgres@127.0.0.1:5432/postgres"),
    ).not.toThrow();
    expect(() =>
      assertHotelbedsApplyIsLocal("postgres://app:super-secret-value@db.example.co:5432/postgres"),
    ).toThrow(/No production changes/);
    try {
      assertHotelbedsApplyIsLocal("postgres://app:super-secret-value@db.example.co:5432/postgres");
    } catch (err) {
      expect((err as Error).message).not.toContain("super-secret-value");
    }
  });
});

describe("import script source", () => {
  it("does not reference Hotelbeds credentials, the API host, or fetch", async () => {
    const dir = path.resolve("scripts/import-hotelbeds");
    const files = (await readdir(dir)).filter((name) => name.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    const banned = [
      "HOTELBEDS_API_KEY",
      "HOTELBEDS_SECRET",
      "api.test.hotelbeds",
      "api.hotelbeds.com",
      "fetch(",
      "X-Signature",
    ];
    for (const name of files) {
      const text = await readFile(path.join(dir, name), "utf8");
      for (const token of banned) {
        expect(text, `${name} contains ${token}`).not.toContain(token);
      }
    }
  });

  it("keeps the migration free of RLS and grant changes", async () => {
    const sql = await readFile(
      path.resolve("supabase/migrations/0059_star_rating_provenance.sql"),
      "utf8",
    );
    expect(sql).toContain("needs_category_review boolean not null default false");
    expect(sql).toContain("star_rating_source = 'owner'");
    expect(sql).toContain("star_rating_confidence = 'confirmed'");
    expect(sql).toContain("where star_rating is not null");
    expect(sql).toContain("hotels_hotelbeds_code_uidx");
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/enable row level security/i);
    expect(sql).not.toMatch(/\bgrant\b/i);
    expect(sql).not.toMatch(/\brevoke\b/i);
  });
});
