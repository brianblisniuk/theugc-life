/**
 * PUBLIC Creator Network Intelligence — contributor-diversity floors (D050,
 * D058), against a real database.
 *
 * Every PUBLIC behavioural signal is a claim about a hotel, and a claim about a
 * hotel needs a population behind it. Confidence counts pitched CYCLES, and
 * cycles can all belong to one creator — so confidence alone would let one busy
 * creator publish "Activity: high" and "creator collaboration observed" about a
 * hotel, to anonymous visitors, describing nobody but themselves.
 *
 * Three floors, all enforced in the view:
 *
 *   activity_level              confidence gate AND >= 3 distinct creators / 90d
 *   recency_band (recent only)  confidence gate AND >= 3 distinct creators / 90d
 *   has_observed_collaboration  >= 3 distinct collaborating creators / 365d
 *
 * Suppression is NULL. Never `low`. Never `false`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const DEST = "e5000000-0000-0000-0000-000000000001";
const HOTEL = "e5000000-0000-0000-0000-000000000002";

const VIEWER = {
  free: "e6000000-0000-0000-0000-000000000001",
  pass: "e6000000-0000-0000-0000-000000000002",
  pro: "e6000000-0000-0000-0000-000000000003",
} as const;

interface PublicRow {
  activity_level: string | null;
  confidence_level: string | null;
  has_observed_collaboration: boolean | null;
  recency_band: string | null;
}

const PUBLIC_COLUMNS = "activity_level, confidence_level, has_observed_collaboration, recency_band";

let creatorSeq = 0;
let cycleSeq = 0;

async function makeCreator(): Promise<string> {
  creatorSeq += 1;
  const userId = `e7000000-0000-0000-0000-${creatorSeq.toString().padStart(12, "0")}`;
  await adminQuery("insert into auth.users (id, email) values ($1,$2)", [
    userId,
    `${userId}@test.local`,
  ]);
  const rows = await adminQuery<{ id: string }>(
    "select id from public.creator_profiles where user_id = $1",
    [userId],
  );
  return rows[0]!.id;
}

/** A closed historical cycle, so one creator may hold many against one hotel. */
async function seedCycle(creator: string, daysAgo: number, collaborate = false): Promise<void> {
  cycleSeq += 1;
  const rows = await adminQuery<{ id: string }>(
    `insert into public.pipeline_items (creator_id, hotel_id, status, cycle_number)
     values ($1,$2,'closed',$3) returning id`,
    [creator, HOTEL, cycleSeq],
  );
  const itemId = rows[0]!.id;
  const at = `now() - interval '${daysAgo} days'`;

  await adminQuery(
    `insert into public.outreach_events (creator_id, hotel_id, pipeline_item_id, event_type, event_at)
     values ($1,$2,$3,'pitch_sent', ${at})`,
    [creator, HOTEL, itemId],
  );

  if (collaborate) {
    await adminQuery(
      `insert into public.outreach_events (creator_id, hotel_id, pipeline_item_id, event_type, event_at)
       values ($1,$2,$3,'deal_won', ${at} + interval '2 days')`,
      [creator, HOTEL, itemId],
    );
    await adminQuery(
      `insert into public.collaborations
         (creator_id, hotel_id, pipeline_item_id, status, collaboration_type, agreed_at)
       values ($1,$2,$3,'agreed','stay', ${at} + interval '2 days')`,
      [creator, HOTEL, itemId],
    );
  }
}

async function reset(): Promise<void> {
  await adminQuery("delete from public.collaborations where hotel_id = $1", [HOTEL]);
  await adminQuery("delete from public.outreach_events where hotel_id = $1", [HOTEL]);
  await adminQuery("delete from public.pipeline_items where hotel_id = $1", [HOTEL]);
  await adminQuery("delete from public.hotel_intelligence where hotel_id = $1", [HOTEL]);
}

async function recompute(): Promise<void> {
  await adminQuery("select public.recompute_hotel_intelligence($1)", [HOTEL]);
}

/** The public row exactly as an anonymous visitor sees it. */
async function publicRow(): Promise<PublicRow | null> {
  const res = await queryAs<PublicRow>(
    { role: "anon" },
    `select ${PUBLIC_COLUMNS} from public.hotel_public_intelligence where hotel_id = $1`,
    [HOTEL],
  );
  expect(res.error).toBeNull();
  return res.rows[0] ?? null;
}

/** Enough recent cycles from ONE creator to reach `emerging` confidence. */
async function busyCreatorCycles(n: number, creator: string, startDaysAgo = 3): Promise<void> {
  for (let i = 0; i < n; i++) await seedCycle(creator, startDaysAgo + i);
}

d("public intelligence — contributor diversity", () => {
  beforeAll(async () => {
    await setupDatabase();
    for (const id of Object.values(VIEWER)) {
      await adminQuery("insert into auth.users (id, email) values ($1,$2)", [
        id,
        `${id}@test.local`,
      ]);
    }
    await adminQuery(
      "insert into public.destinations (id, name, slug, type) values ($1,'Pubville','pubville','city')",
      [DEST],
    );
    await adminQuery(
      "insert into public.hotels (id, name, slug, destination_id) values ($1,'Pub Hotel','pub-hotel',$2)",
      [HOTEL, DEST],
    );
    await adminQuery(
      `insert into public.access_entitlements (user_id, access_type, status, starts_at)
         values ($1,'pro','active', now() - interval '1 day')`,
      [VIEWER.pro],
    );
    await adminQuery(
      `insert into public.access_entitlements
         (user_id, access_type, destination_id, status, starts_at, expires_at)
       values ($1,'destination',$2,'active', now() - interval '1 day', now() + interval '29 days')`,
      [VIEWER.pass, DEST],
    );
  }, 120_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  /* ---------------------------------------------------------------- */
  /* 1A — activity level                                               */
  /* ---------------------------------------------------------------- */

  it("many recent cycles from ONE creator publish no public activity", async () => {
    await reset();
    const solo = await makeCreator();
    await busyCreatorCycles(12, solo);
    await recompute();

    const base = await adminQuery<{ activity_level: string | null; confidence: string }>(
      "select activity_level, confidence_level as confidence from public.hotel_intelligence where hotel_id = $1",
      [HOTEL],
    );
    // The derived row computes a level — twelve recent cycles is genuinely busy…
    expect(base[0]!.activity_level).not.toBeNull();
    expect(base[0]!.confidence).toBe("emerging");

    // …and the public projection refuses to publish it, because all twelve
    // belong to one identifiable person.
    const row = (await publicRow())!;
    expect(row.activity_level).toBeNull();
    expect(row.activity_level).not.toBe("low");
    expect(row.recency_band).toBeNull();
  });

  it("recent cycles from TWO creators still publish no public activity", async () => {
    await reset();
    const a = await makeCreator();
    const b = await makeCreator();
    await busyCreatorCycles(6, a);
    await busyCreatorCycles(6, b, 10);
    await recompute();

    const row = (await publicRow())!;
    expect(row.activity_level).toBeNull();
    expect(row.activity_level).not.toBe("low");
  });

  it("THREE distinct recent creators publish the activity band", async () => {
    await reset();
    for (let i = 0; i < 3; i++) {
      const creator = await makeCreator();
      await busyCreatorCycles(2, creator, 3 + i * 2);
    }
    await recompute();

    const row = (await publicRow())!;
    expect(row.activity_level).not.toBeNull();
    // The band itself is the existing calculation, unchanged.
    expect(["high", "medium", "low", "emerging"]).toContain(row.activity_level);
  });

  it("the public row never discloses the creator count that justified the band", async () => {
    const cols = await adminQuery<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='hotel_public_intelligence'`,
    );
    const names = cols.map((c) => c.column_name);
    for (const forbidden of [
      "distinct_creators_7d",
      "distinct_creators_30d",
      "distinct_creators_90d",
      "distinct_creators_365d",
      "distinct_collaboration_creators_365d",
      "contributor_count",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  /* ---------------------------------------------------------------- */
  /* 1B — collaboration presence                                       */
  /* ---------------------------------------------------------------- */

  it("no observed collaboration is NULL, never false", async () => {
    await reset();
    for (let i = 0; i < 6; i++) await seedCycle(await makeCreator(), 20 + i);
    await recompute();

    const row = (await publicRow())!;
    expect(row.has_observed_collaboration).toBeNull();
    // `false` would read as "this hotel does not collaborate with creators",
    // which absence of observed outcomes cannot prove.
    expect(row.has_observed_collaboration).not.toBe(false);
  });

  it("ONE creator with several collaborations publishes nothing", async () => {
    await reset();
    const solo = await makeCreator();
    for (let i = 0; i < 4; i++) await seedCycle(solo, 30 + i * 3, true);
    await recompute();

    const base = await adminQuery<{ n: number; c: number }>(
      `select collaboration_count as n, distinct_collaboration_creators_365d as c
         from public.hotel_intelligence where hotel_id = $1`,
      [HOTEL],
    );
    // Four collaborations recorded…
    expect(Number(base[0]!.n)).toBe(4);
    // …from exactly one creator. Repetition is not diversity.
    expect(Number(base[0]!.c)).toBe(1);

    expect((await publicRow())!.has_observed_collaboration).toBeNull();
  });

  it("TWO distinct collaborating creators remain suppressed", async () => {
    await reset();
    for (let i = 0; i < 2; i++) {
      const creator = await makeCreator();
      await seedCycle(creator, 30 + i, true);
      await seedCycle(creator, 60 + i, true);
    }
    await recompute();

    const row = (await publicRow())!;
    expect(row.has_observed_collaboration).toBeNull();
    expect(row.has_observed_collaboration).not.toBe(false);
  });

  it("THREE distinct collaborating creators publish TRUE", async () => {
    await reset();
    for (let i = 0; i < 3; i++) await seedCycle(await makeCreator(), 30 + i, true);
    await recompute();

    expect((await publicRow())!.has_observed_collaboration).toBe(true);
  });

  it("collaborations older than 365 days do not count toward presence", async () => {
    await reset();
    for (let i = 0; i < 3; i++) await seedCycle(await makeCreator(), 400 + i, true);
    await recompute();

    expect((await publicRow())!.has_observed_collaboration).toBeNull();
  });

  it("collaboration presence derives only from creator outcomes, not editorial evidence", async () => {
    await reset();
    for (let i = 0; i < 3; i++) await seedCycle(await makeCreator(), 30 + i);
    // Editorial evidence claiming the hotel collaborates with creators.
    await adminQuery(
      `insert into public.editorial_evidence
         (subject_type, subject_id, claim_type, source_type, source_url)
       values ('hotel', $1, 'creator_collaboration_evidence', 'official_website',
               'https://example.com')`,
      [HOTEL],
    );
    await recompute();

    // D057: research evidence is a trust layer. It never manufactures a
    // Creator Network fact.
    expect((await publicRow())!.has_observed_collaboration).toBeNull();
  });

  /* ---------------------------------------------------------------- */
  /* Privacy invariance across plans                                   */
  /* ---------------------------------------------------------------- */

  it("the public row is identical for anon, Free, Destination Pass and Pro", async () => {
    await reset();
    for (let i = 0; i < 3; i++) {
      const creator = await makeCreator();
      await seedCycle(creator, 3 + i, true);
      await seedCycle(creator, 40 + i);
    }
    await recompute();

    const read = async (sub: string | null, role: "anon" | "authenticated") =>
      (
        await queryAs<PublicRow>(
          { role, sub },
          `select ${PUBLIC_COLUMNS} from public.hotel_public_intelligence where hotel_id = $1`,
          [HOTEL],
        )
      ).rows;

    const anon = await read(null, "anon");
    expect(anon).toHaveLength(1);
    for (const [sub, label] of [
      [VIEWER.free, "free"],
      [VIEWER.pass, "pass"],
      [VIEWER.pro, "pro"],
    ] as const) {
      expect(await read(sub, "authenticated"), label).toEqual(anon);
    }
    // Paying adds a second projection; it never widens the first one.
    expect(anon[0]!.has_observed_collaboration).toBe(true);
  });
});
