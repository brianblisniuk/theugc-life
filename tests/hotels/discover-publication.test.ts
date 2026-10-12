/**
 * Real Postgres: the publication predicate hides inactive and non-publishable
 * rows, and pipeline / trip badges are not readable across creators.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PUBLISHED_CANONICAL_HOTEL_WHERE } from "@/lib/hotels/publication";
import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";
import { USERS, seed } from "../rls/seed";

const d = describe.skipIf(!hasTestDb);

const DEST = "e1000000-0000-0000-0000-000000000001";
const PUBLISHED = "e1000000-0000-0000-0000-0000000000a1";
const UNKNOWN = "e1000000-0000-0000-0000-0000000000a2";
const TEMPORARY = "e1000000-0000-0000-0000-0000000000a3";
const CLOSED = "e1000000-0000-0000-0000-0000000000b1";
const THREE_STAR = "e1000000-0000-0000-0000-0000000000b2";
const FRACTIONAL = "e1000000-0000-0000-0000-0000000000b3";
const NO_COORDS = "e1000000-0000-0000-0000-0000000000b4";
const BAD_LAT = "e1000000-0000-0000-0000-0000000000b5";
const TRIP = "e1000000-0000-0000-0000-0000000000c1";

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  const creators = await seed();

  await adminQuery(
    `insert into public.destinations (id, name, slug, type, country_code, country_name)
     values ($1, 'E01 Place', 'e01-place', 'city', 'AE', 'United Arab Emirates')`,
    [DEST],
  );

  const rows: Array<[string, string, number | null, number | null, number | null, string]> = [
    [PUBLISHED, "e01-published", 5, 25.2, 55.2, "active"],
    [UNKNOWN, "e01-unknown-closure", 4, 25.2, 55.2, "unknown"],
    [TEMPORARY, "e01-temporary", 5, 25.2, 55.2, "temporarily_closed"],
    [CLOSED, "e01-closed", 5, 25.2, 55.2, "closed"],
    [THREE_STAR, "e01-three", 3, 25.2, 55.2, "active"],
    [FRACTIONAL, "e01-fraction", 4.5, 25.2, 55.2, "active"],
    [NO_COORDS, "e01-nocoord", 5, null, null, "active"],
    [BAD_LAT, "e01-badlat", 5, 120, 55.2, "active"],
  ];
  for (const [id, slug, stars, lat, lon, status] of rows) {
    await adminQuery(
      `insert into public.hotels
         (id, name, slug, destination_id, country_code, hotel_type, star_rating,
          latitude, longitude, active_status)
       values ($1, $2, $3, $4, 'AE', 'hotel', $5, $6, $7, $8)`,
      [id, slug, slug, DEST, stars, lat, lon, status],
    );
  }

  await adminQuery(
    `insert into public.pipeline_items (creator_id, hotel_id, status) values
       ($1, $3, 'pitched'),
       ($2, $3, 'saved')`,
    [creators.free, creators.pro, PUBLISHED],
  );
  await adminQuery(
    `insert into public.trips (id, creator_id, destination_id, start_date, end_date)
     values ($1, $2, $3, '2026-11-01', '2026-11-08')`,
    [TRIP, creators.free, DEST],
  );
  await adminQuery(`insert into public.trip_hotels (trip_id, hotel_id) values ($1, $2)`, [
    TRIP,
    PUBLISHED,
  ]);
}, 120_000);

afterAll(async () => {
  await teardownDatabase();
});

d("discover publication predicate", () => {
  it("renders published rows and never a closed, 3-star, fractional, or unlocated hotel", async () => {
    const res = await queryAs<{ name: string }>(
      { role: "authenticated", sub: USERS.free },
      `select name from public.hotels
        where destination_id = $1
          and ${PUBLISHED_CANONICAL_HOTEL_WHERE}
        order by name`,
      [DEST],
    );
    expect(res.error).toBeNull();
    expect(res.rows.map((row) => row.name)).toEqual([
      "e01-published",
      "e01-temporary",
      "e01-unknown-closure",
    ]);
  });

  it("anonymous sees the same published set and no premium contact column", async () => {
    const res = await queryAs<{ name: string }>(
      { role: "anon" },
      `select name from public.hotels
        where destination_id = $1
          and ${PUBLISHED_CANONICAL_HOTEL_WHERE}
        order by name`,
      [DEST],
    );
    expect(res.error).toBeNull();
    expect(res.rows.map((row) => row.name)).toEqual([
      "e01-published",
      "e01-temporary",
      "e01-unknown-closure",
    ]);
  });
});

d("discover badges — creator A cannot read creator B", () => {
  it("each creator sees only their own pipeline status", async () => {
    const free = await queryAs<{ status: string }>(
      { role: "authenticated", sub: USERS.free },
      `select status from public.pipeline_items where hotel_id = $1 and status <> 'closed'`,
      [PUBLISHED],
    );
    const pro = await queryAs<{ status: string }>(
      { role: "authenticated", sub: USERS.pro },
      `select status from public.pipeline_items where hotel_id = $1 and status <> 'closed'`,
      [PUBLISHED],
    );
    expect(free.rows.map((row) => row.status)).toEqual(["pitched"]);
    expect(pro.rows.map((row) => row.status)).toEqual(["saved"]);
  });

  it("a trip shortlist is invisible to the other creator and to anon", async () => {
    const free = await queryAs<{ trip_id: string }>(
      { role: "authenticated", sub: USERS.free },
      `select trip_id from public.trip_hotels where hotel_id = $1`,
      [PUBLISHED],
    );
    const pro = await queryAs<{ trip_id: string }>(
      { role: "authenticated", sub: USERS.pro },
      `select trip_id from public.trip_hotels where hotel_id = $1`,
      [PUBLISHED],
    );
    const anon = await queryAs(
      { role: "anon" },
      `select trip_id from public.trip_hotels where hotel_id = $1`,
      [PUBLISHED],
    );
    expect(free.rows.map((row) => row.trip_id)).toEqual([TRIP]);
    expect(pro.rows).toHaveLength(0);
    expect(anon.error !== null || anon.rows.length === 0).toBe(true);
  });
});
