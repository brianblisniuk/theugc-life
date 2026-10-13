/**
 * D106 against Postgres: provenance checks, the backfill, unchanged RLS,
 * and an idempotent import that does not merge a nearby hotel.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFile } from "node:fs/promises";

import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PUBLISHED_CANONICAL_HOTEL_WHERE } from "@/lib/hotels/publication";
import { runHotelbedsImport } from "../../scripts/import-hotelbeds/run";
import { adminQuery, hasTestDb, queryAs, setupDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const DEST = "b1060000-0000-4000-8000-000000000001";
const EXISTING = "b1060000-0000-4000-8000-000000000002";
const PLAIN = "b1060000-0000-4000-8000-000000000003";

let client: Client | null = null;
let dir: string | null = null;

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  client = new Client({ connectionString: process.env.TEST_DATABASE_URL });
  await client.connect();
  dir = await mkdtemp(path.join(tmpdir(), "hb01-db-"));
  await client.query(
    `insert into public.destinations (id, name, slug, type, country_code, country_name)
     values ($1, 'HB01 Bali', 'hb01-bali', 'island', 'ID', 'Indonesia')`,
    [DEST],
  );
  await client.query(
    `insert into public.destination_aliases
       (destination_id, alias, normalized_alias, country_code, source)
     values ($1, 'BAI', 'bai', 'ID', 'hotelbeds')`,
    [DEST],
  );
  await client.query(
    `insert into public.hotels
       (id, name, slug, destination_id, country_code, latitude, longitude,
        website_url, star_rating, star_rating_source, star_rating_confidence, active_status)
     values ($1, 'Same Name Hotel', 'hb01-same-name', $2, 'ID', -8.4, 115.2,
             'https://owner.example', 5, 'owner', 'confirmed', 'active')`,
    [EXISTING, DEST],
  );
}, 120_000);

afterAll(async () => {
  if (client) {
    await client.query(`delete from public.hotels where destination_id = $1 or id = $2`, [
      DEST,
      PLAIN,
    ]);
    await client.query(`delete from public.destination_aliases where destination_id = $1`, [DEST]);
    await client.query(`delete from public.destinations where id = $1`, [DEST]);
    await client.end();
  }
  if (dir) await rm(dir, { recursive: true, force: true });
});

function db(): Client {
  if (!client || !dir) throw new Error("database suite was not set up");
  return client;
}

d("star rating provenance", () => {
  it("rejects a provenance pair D106 does not name", async () => {
    await expect(
      db().query(
        `insert into public.hotels (name, slug, destination_id, star_rating_source)
         values ('Bad Source', 'hb01-bad-source', $1, 'booking')`,
        [DEST],
      ),
    ).rejects.toThrow(/hotels_star_rating_source_check|hotels_star_rating_provenance_pair_check/);
    await expect(
      db().query(
        `insert into public.hotels
           (name, slug, destination_id, star_rating_source, star_rating_confidence)
         values ('Bad Pair', 'hb01-bad-pair', $1, 'hotelbeds', 'confirmed')`,
        [DEST],
      ),
    ).rejects.toThrow(/hotels_star_rating_provenance_pair_check/);
  });

  it("defaults needs_category_review to false", async () => {
    await db().query(
      `insert into public.hotels (id, name, slug, destination_id)
       values ($1, 'Plain Hotel', 'hb01-plain', $2)`,
      [PLAIN, DEST],
    );
    const [row] = (
      await db().query<{ needs_category_review: boolean }>(
        `select needs_category_review from public.hotels where id = $1`,
        [PLAIN],
      )
    ).rows;
    expect(row!.needs_category_review).toBe(false);
  });

  it("backfills an existing classification and leaves the other rows alone", async () => {
    const sql = await readFile(
      path.resolve("supabase/migrations/0059_star_rating_provenance.sql"),
      "utf8",
    );
    const update = sql.slice(sql.lastIndexOf("update public.hotels"));
    expect(update.startsWith("update public.hotels")).toBe(true);

    await db().query(
      `insert into public.hotels (name, slug, destination_id, star_rating)
       values ('Legacy Stars', 'hb01-legacy-stars', $1, 4)`,
      [DEST],
    );
    await db().query(
      `insert into public.hotels (name, slug, destination_id)
       values ('No Stars', 'hb01-no-stars', $1)`,
      [DEST],
    );
    await db().query(
      `insert into public.hotels
         (name, slug, destination_id, star_rating, star_rating_source, star_rating_confidence,
          hotelbeds_code)
       values ('Already Provisional', 'hb01-provisional', $1, 5, 'hotelbeds', 'provisional', 'hb01-keep')`,
      [DEST],
    );
    await db().query(update);

    const rows = await db().query<{
      slug: string;
      star_rating_source: string | null;
      star_rating_confidence: string | null;
    }>(
      `select slug, star_rating_source, star_rating_confidence
         from public.hotels
        where slug in ('hb01-legacy-stars', 'hb01-no-stars', 'hb01-provisional')
        order by slug`,
    );
    expect(rows.rows).toEqual([
      {
        slug: "hb01-legacy-stars",
        star_rating_source: "owner",
        star_rating_confidence: "confirmed",
      },
      { slug: "hb01-no-stars", star_rating_source: null, star_rating_confidence: null },
      {
        slug: "hb01-provisional",
        star_rating_source: "hotelbeds",
        star_rating_confidence: "provisional",
      },
    ]);
  });

  it("leaves hotels RLS policies and anon select in place", async () => {
    const policies = await adminQuery<{ policyname: string }>(
      `select policyname from pg_policies
        where schemaname = 'public' and tablename = 'hotels'
        order by policyname`,
    );
    expect(policies.map((policy) => policy.policyname)).toEqual(["hotels_select", "hotels_write"]);
    const visible = await queryAs(
      { role: "anon" },
      `select star_rating_source, star_rating_confidence, needs_category_review
         from public.hotels where id = $1`,
      [EXISTING],
    );
    expect(visible.error).toBeNull();
    expect(visible.rows).toHaveLength(1);
  });
});

d("Hotelbeds import apply", () => {
  it("does not merge a nearby namesake, inserts a new visible hotel, and is idempotent", async () => {
    const page = {
      hotels: [
        {
          code: 9001,
          name: { content: "Same Name Hotel" },
          categoryCode: "5EST",
          coordinates: { latitude: -8.4 + 400 / 111_320, longitude: 115.2 },
          destinationCode: "BAI",
          accommodationTypeCode: "H",
          web: "https://should-not-merge.example",
        },
        {
          code: 9002,
          name: { content: "Unique Residences Tower" },
          categoryCode: "4LUX",
          coordinates: { latitude: 25.2, longitude: 55.27 },
          destinationCode: "BAI",
          accommodationTypeCode: "H",
          web: "https://unique.example",
        },
        {
          code: 9003,
          name: { content: "Aparthotel Skip" },
          categoryCode: "5EST",
          coordinates: { latitude: 25.2, longitude: 55.3 },
          destinationCode: "BAI",
          accommodationTypeCode: "P",
          web: "https://skip.example",
        },
      ],
    };
    const rawDir = dir!;
    const matchesOut = path.join(rawDir, "matches.csv");
    await writeFile(path.join(rawDir, "page.json"), JSON.stringify(page));

    const dry = await runHotelbedsImport({
      client: db(),
      rawDir,
      apply: false,
      matchesOut,
    });
    expect(dry.apply).toBe(false);
    expect(dry.inserts).toBe(1);
    expect(dry.reviews).toBe(1);
    expect(dry.matches).toBe(1);
    const before = await db().query(`select id from public.hotels where hotelbeds_code = '9002'`);
    expect(before.rows).toHaveLength(0);
    const csv = await readFile(matchesOut, "utf8");
    expect(csv).toContain("9001");
    expect(csv).toContain(EXISTING);
    expect(csv).not.toContain("9002");

    const applied = await runHotelbedsImport({
      client: db(),
      rawDir,
      apply: true,
      matchesOut,
    });
    expect(applied.inserts).toBe(1);
    const inserted = await db().query<{
      name: string;
      star_rating: number;
      star_rating_source: string;
      star_rating_confidence: string;
      website_url: string;
      needs_category_review: boolean;
      hotel_type: string;
      active_status: string;
      country_code: string;
      hotelbeds_code: string;
    }>(
      `select name, star_rating::float8 as star_rating, star_rating_source, star_rating_confidence,
              website_url, needs_category_review, hotel_type, active_status, country_code,
              hotelbeds_code
         from public.hotels where hotelbeds_code = '9002'`,
    );
    expect(inserted.rows).toEqual([
      {
        name: "Unique Residences Tower",
        star_rating: 4,
        star_rating_source: "hotelbeds",
        star_rating_confidence: "provisional",
        website_url: "https://unique.example",
        needs_category_review: true,
        hotel_type: "hotel",
        active_status: "unknown",
        country_code: "ID",
        hotelbeds_code: "9002",
      },
    ]);
    const published = await db().query<{ name: string }>(
      `select name from public.hotels
        where hotelbeds_code = '9002' and ${PUBLISHED_CANONICAL_HOTEL_WHERE}`,
    );
    expect(published.rows.map((row) => row.name)).toEqual(["Unique Residences Tower"]);

    const namesake = await db().query<{
      hotelbeds_code: string | null;
      website_url: string;
      latitude: number;
    }>(
      `select hotelbeds_code, website_url, latitude::float8 as latitude
         from public.hotels where id = $1`,
      [EXISTING],
    );
    expect(namesake.rows[0]).toMatchObject({
      hotelbeds_code: null,
      website_url: "https://owner.example",
    });
    expect(namesake.rows[0]!.latitude).toBeCloseTo(-8.4, 5);
    const skipped = await db().query(
      `select id from public.hotels where name in ('Aparthotel Skip', 'Same Name Hotel') and hotelbeds_code is not null`,
    );
    expect(skipped.rows).toHaveLength(0);

    const again = await runHotelbedsImport({
      client: db(),
      rawDir,
      apply: true,
      matchesOut,
    });
    expect(again.upserts).toBe(1);
    expect(again.inserts).toBe(0);
    const stillOne = await db().query(`select id from public.hotels where hotelbeds_code = '9002'`);
    expect(stillOne.rows).toHaveLength(1);

    await db().query(
      `update public.hotels
          set latitude = 1, longitude = 2, website_url = 'https://owner-kept.example',
              star_rating = 4, star_rating_source = 'owner', star_rating_confidence = 'confirmed',
              name = 'Owner Renamed Tower'
        where hotelbeds_code = '9002'`,
    );
    page.hotels[1] = {
      ...page.hotels[1]!,
      categoryCode: "5EST",
      coordinates: { latitude: 9, longitude: 9 },
      web: "https://hotelbeds-should-not-win.example",
      name: { content: "Hotelbeds Rename" },
    };
    await writeFile(path.join(rawDir, "page.json"), JSON.stringify(page));
    await runHotelbedsImport({ client: db(), rawDir, apply: true, matchesOut });
    const owned = await db().query<{
      name: string;
      latitude: number;
      longitude: number;
      website_url: string;
      star_rating: number;
      star_rating_source: string;
    }>(
      `select name, latitude::float8 as latitude, longitude::float8 as longitude, website_url,
              star_rating::float8 as star_rating, star_rating_source
         from public.hotels where hotelbeds_code = '9002'`,
    );
    expect(owned.rows[0]).toEqual({
      name: "Owner Renamed Tower",
      latitude: 1,
      longitude: 2,
      website_url: "https://owner-kept.example",
      star_rating: 4,
      star_rating_source: "owner",
    });

    await db().query(
      `update public.hotels
          set latitude = null, longitude = null, website_url = null,
              star_rating_source = 'hotelbeds', star_rating_confidence = 'provisional'
        where hotelbeds_code = '9002'`,
    );
    await runHotelbedsImport({ client: db(), rawDir, apply: true, matchesOut });
    const filled = await db().query<{
      latitude: number;
      longitude: number;
      website_url: string;
      star_rating: number;
      name: string;
    }>(
      `select latitude::float8 as latitude, longitude::float8 as longitude, website_url,
              star_rating::float8 as star_rating, name
         from public.hotels where hotelbeds_code = '9002'`,
    );
    expect(filled.rows[0]).toEqual({
      latitude: 9,
      longitude: 9,
      website_url: "https://hotelbeds-should-not-win.example",
      star_rating: 5,
      name: "Hotelbeds Rename",
    });
  });
});
