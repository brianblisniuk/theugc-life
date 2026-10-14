/**
 * F03 reads the H01 views in rank_key order (D130). No new migration.
 * A payment row does not move the order. A locked reply ranking has no hotels.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const CREATORS = [
  "f0310000-0000-4000-8000-000000000001",
  "f0310000-0000-4000-8000-000000000002",
  "f0310000-0000-4000-8000-000000000003",
] as const;
const FREE = "f0310000-0000-4000-8000-00000000000a";
const PAYER = "f0310000-0000-4000-8000-00000000000b";
const DEST = "f0320000-0000-4000-8000-000000000001";
const MED_A = "f0330000-0000-4000-8000-000000000010";
const MED_B = "f0330000-0000-4000-8000-000000000020";
const LOW = "f0330000-0000-4000-8000-000000000030";
const THIN = "f0330000-0000-4000-8000-000000000040";

async function samples(hotelId: string, count: number) {
  for (let index = 0; index < count; index += 1) {
    const owner = CREATORS[index % CREATORS.length]!;
    await adminQuery(
      `insert into private.intelligence_facts (
         owner_user_id, fact_type, provenance_class, source_family,
         canonical_hotel_id, evidence_kind, evidence_id, event_at,
         network_eligible, counts_as_sample
       ) values (
         $1, 'pitch_sent', 'creator_confirmed', 'manual',
         $2, 'outreach_event', gen_random_uuid(), now(),
         true, true
       )`,
      [owner, hotelId],
    );
  }
}

d("F03 metric order", () => {
  beforeAll(async () => {
    await setupDatabase();
    for (const id of [...CREATORS, FREE, PAYER]) {
      await adminQuery("insert into auth.users (id, email) values ($1, $2)", [
        id,
        `${id}@test.local`,
      ]);
    }
    await adminQuery(
      `insert into public.destinations (id, name, slug, type) values ($1, 'F03 Bali', 'f03-bali', 'island')`,
      [DEST],
    );
    for (const [id, name] of [
      [MED_A, "Med A"],
      [MED_B, "Med B"],
      [LOW, "Low"],
      [THIN, "Thin"],
    ] as const) {
      await adminQuery(
        `insert into public.hotels
           (id, name, slug, destination_id, star_rating, latitude, longitude, active_status)
         values ($1, $2, $3, $4, 5, -8.4, 115.1, 'active')`,
        [id, name, `f03-${id.slice(-4)}`, DEST],
      );
    }
    await samples(MED_A, 15);
    await samples(MED_B, 15);
    await samples(LOW, 5);
    await samples(THIN, 4);
  }, 180_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  it("orders the public view by rank_key desc, hotel_id and omits the floor", async () => {
    const rows = await adminQuery<{ hotel_id: string; rank_key: number; value_label: string }>(
      `select hotel_id, rank_key, value_label
         from public.hotel_metric_signal_public
        where metric = 'creator_activity'
          and hotel_id = any($1::uuid[])
        order by rank_key desc, hotel_id`,
      [[MED_A, MED_B, LOW, THIN]],
    );
    expect(rows.map((row) => row.hotel_id)).toEqual([MED_A, MED_B, LOW]);
    expect(rows.map((row) => Number(row.rank_key))).toEqual([2, 2, 1]);
    expect(rows.map((row) => row.value_label)).toEqual(["Medium", "Medium", "Emerging"]);
    expect(rows.some((row) => row.hotel_id === THIN)).toBe(false);
  });

  it("does not move that order when a payment row is added", async () => {
    await adminQuery(
      `insert into public.access_entitlements (user_id, access_type, status, starts_at)
       values ($1, 'pro', 'active', now())`,
      [PAYER],
    );
    const rows = await adminQuery<{ hotel_id: string }>(
      `select hotel_id
         from public.hotel_metric_signal_public
        where metric = 'creator_activity'
          and hotel_id = any($1::uuid[])
        order by rank_key desc, hotel_id`,
      [[MED_A, MED_B, LOW, THIN]],
    );
    expect(rows.map((row) => row.hotel_id)).toEqual([MED_A, MED_B, LOW]);
  });

  it("gives a free caller no premium rows and no reply-rate hotels", async () => {
    const view = await queryAs(
      { role: "authenticated", sub: FREE },
      "select hotel_id, metric from public.hotel_metric_signal_premium",
    );
    expect(view.error).toBeNull();
    expect(view.rows).toEqual([]);

    const anon = await queryAs(
      { role: "anon", sub: null },
      "select hotel_id from public.hotel_metric_signal_premium",
    );
    expect(anon.error).not.toBeNull();

    const ranking = await queryAs<{ body: { result: string; hotels?: unknown } }>(
      { role: "authenticated", sub: FREE },
      "select public.read_destination_metric_ranking($1, 'response_rate') as body",
      [DEST],
    );
    expect(ranking.error).toBeNull();
    expect(ranking.rows[0]?.body.result).toBe("locked");
    expect(ranking.rows[0]?.body.hotels).toBeUndefined();
    expect(JSON.stringify(ranking.rows[0]?.body)).not.toContain(MED_A);
  });
});
