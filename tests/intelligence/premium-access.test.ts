/**
 * PREMIUM Creator Network Intelligence — entitlement and thresholds, against a
 * real database with real roles (migration 0026, D050, D058).
 *
 * Two things are proven here, and they are different:
 *
 *  1. ACCESS. `hotel_premium_intelligence` is gated inside the database. Every
 *     assertion below runs as an actual Postgres role with an actual JWT `sub`,
 *     so what is tested is the privilege and the policy — not a UI branch that
 *     could be deleted.
 *
 *  2. DISCLOSURE. Every premium metric requires BOTH a sample-size floor and a
 *     distinct-creator floor. Payment moves neither. A metric one busy creator
 *     could have produced alone is not published to anybody.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const U = {
  pro: "d1000000-0000-0000-0000-000000000001",
  pass: "d1000000-0000-0000-0000-000000000002",
  expired: "d1000000-0000-0000-0000-000000000003",
  free: "d1000000-0000-0000-0000-000000000004",
  admin: "d1000000-0000-0000-0000-000000000005",
} as const;

const DEST = {
  /** Parent of `child`; the Pass is bought here. */
  entitled: "d2000000-0000-0000-0000-000000000001",
  /** Descendant of `entitled` — a Pass must cover it (hierarchy rule). */
  child: "d2000000-0000-0000-0000-000000000002",
  /** Unrelated. */
  outside: "d2000000-0000-0000-0000-000000000003",
} as const;

const HOTEL = {
  entitled: "d3000000-0000-0000-0000-000000000001",
  child: "d3000000-0000-0000-0000-000000000002",
  outside: "d3000000-0000-0000-0000-000000000003",
  /** Used by the threshold suite, in the entitled destination. */
  thresholds: "d3000000-0000-0000-0000-000000000004",
} as const;

interface PremiumRow {
  confidence_level: string | null;
  reply_rate: string | null;
  reply_time_band: string | null;
  recent_activity_band: string | null;
  collaboration_types: string[] | null;
  contributor_count: number | null;
}

const PREMIUM_COLUMNS =
  "confidence_level, reply_rate, reply_time_band, recent_activity_band, collaboration_types, contributor_count";

function daysAgo(n: number): string {
  return `now() - interval '${n} days'`;
}

let creatorSeq = 0;

/** A creator profile that exists only for this suite. */
async function makeCreator(): Promise<string> {
  creatorSeq += 1;
  const userId = `d4000000-0000-0000-0000-${creatorSeq.toString().padStart(12, "0")}`;
  await adminQuery("insert into auth.users (id, email) values ($1, $2)", [
    userId,
    `${userId}@test.local`,
  ]);
  const rows = await adminQuery<{ id: string }>(
    "select id from public.creator_profiles where user_id = $1",
    [userId],
  );
  return rows[0]!.id;
}

let cycleSeq = 0;

/**
 * One relationship cycle: a pitch, optionally a reply, optionally a won deal
 * with a collaboration record.
 *
 * Cycles are created `closed` by default so a single creator may hold several
 * against the same hotel — `pipeline_items_single_active_cycle_uidx` allows
 * only one non-closed cycle per (creator, hotel), and the distinct-creator
 * thresholds are exactly what these tests need to vary independently of volume.
 */
async function seedCycle(spec: {
  hotel: string;
  creator: string;
  pitchDaysAgo: number;
  replyHoursAfter?: number;
  collaborationType?: string;
}): Promise<void> {
  cycleSeq += 1;
  const item = await adminQuery<{ id: string }>(
    `insert into public.pipeline_items (creator_id, hotel_id, status, cycle_number)
     values ($1, $2, 'closed', $3) returning id`,
    [spec.creator, spec.hotel, cycleSeq],
  );
  const itemId = item[0]!.id;

  const pitchAt = daysAgo(spec.pitchDaysAgo);
  await adminQuery(
    `insert into public.outreach_events
       (creator_id, hotel_id, pipeline_item_id, event_type, event_at)
     values ($1,$2,$3,'pitch_sent', ${pitchAt})`,
    [spec.creator, spec.hotel, itemId],
  );

  if (spec.replyHoursAfter !== undefined) {
    await adminQuery(
      `insert into public.outreach_events
         (creator_id, hotel_id, pipeline_item_id, event_type, event_at)
       values ($1,$2,$3,'reply_received', ${pitchAt} + interval '${spec.replyHoursAfter} hours')`,
      [spec.creator, spec.hotel, itemId],
    );
  }

  if (spec.collaborationType) {
    await adminQuery(
      `insert into public.outreach_events
         (creator_id, hotel_id, pipeline_item_id, event_type, event_at)
       values ($1,$2,$3,'deal_won', ${pitchAt} + interval '48 hours')`,
      [spec.creator, spec.hotel, itemId],
    );
    await adminQuery(
      `insert into public.collaborations
         (creator_id, hotel_id, pipeline_item_id, status, collaboration_type, agreed_at)
       values ($1,$2,$3,'completed',$4, ${pitchAt} + interval '48 hours')`,
      [spec.creator, spec.hotel, itemId, spec.collaborationType],
    );
  }
}

async function recompute(hotel: string): Promise<void> {
  await adminQuery("select public.recompute_hotel_intelligence($1)", [hotel]);
}

async function premiumAs(userId: string | null, hotel: string, role: "anon" | "authenticated") {
  return queryAs<PremiumRow>(
    { role, sub: userId },
    `select ${PREMIUM_COLUMNS} from public.hotel_premium_intelligence where hotel_id = $1`,
    [hotel],
  );
}

d("premium intelligence — entitlement", () => {
  beforeAll(async () => {
    await setupDatabase();

    for (const id of Object.values(U)) {
      await adminQuery("insert into auth.users (id, email) values ($1, $2)", [
        id,
        `${id}@test.local`,
      ]);
    }
    await adminQuery("update public.users set role = 'admin' where id = $1", [U.admin]);

    await adminQuery(
      `insert into public.destinations (id, name, slug, type) values
         ($1,'Entitled','entitled','island'), ($2,'Outside','outside','island')`,
      [DEST.entitled, DEST.outside],
    );
    await adminQuery(
      `insert into public.destinations (id, name, slug, type, parent_destination_id)
         values ($1,'Child','child','area',$2)`,
      [DEST.child, DEST.entitled],
    );
    await adminQuery(
      `insert into public.hotels (id, name, slug, destination_id) values
         ($1,'Entitled Hotel','entitled-hotel',$5),
         ($2,'Child Hotel','child-hotel',$6),
         ($3,'Outside Hotel','outside-hotel',$7),
         ($4,'Threshold Hotel','threshold-hotel',$5)`,
      [
        HOTEL.entitled,
        HOTEL.child,
        HOTEL.outside,
        HOTEL.thresholds,
        DEST.entitled,
        DEST.child,
        DEST.outside,
      ],
    );

    await adminQuery(
      `insert into public.access_entitlements (user_id, access_type, status, starts_at)
         values ($1,'pro','active', now() - interval '1 day')`,
      [U.pro],
    );
    await adminQuery(
      `insert into public.access_entitlements
         (user_id, access_type, destination_id, status, starts_at, expires_at)
       values ($1,'destination',$2,'active', now() - interval '1 day', now() + interval '29 days')`,
      [U.pass, DEST.entitled],
    );
    await adminQuery(
      `insert into public.access_entitlements
         (user_id, access_type, destination_id, status, starts_at, expires_at)
       values ($1,'destination',$2,'active', now() - interval '60 days', now() - interval '30 days')`,
      [U.expired, DEST.entitled],
    );

    // Enough qualifying history on both entitled hotels for every premium
    // metric to clear its floors: 15 pitched cycles across 8 creators, 10 of
    // them replied across 6 creators, 3 recent creators, 3 creators per type.
    for (const hotel of [HOTEL.entitled, HOTEL.child, HOTEL.outside]) {
      const creators: string[] = [];
      for (let i = 0; i < 8; i++) creators.push(await makeCreator());

      for (let i = 0; i < 15; i++) {
        const creator = creators[i % creators.length]!;
        await seedCycle({
          hotel,
          creator,
          // Six cycles inside 30 days spread across six distinct creators.
          pitchDaysAgo: i < 6 ? 5 + i : 100 + i,
          replyHoursAfter: i < 10 ? 100 : undefined,
          collaborationType: i < 3 ? "stay" : i < 6 ? "paid" : undefined,
        });
      }
      await recompute(hotel);
    }
  }, 240_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  it("Pro reads premium intelligence worldwide", async () => {
    for (const hotel of Object.values(HOTEL).filter((h) => h !== HOTEL.thresholds)) {
      const res = await premiumAs(U.pro, hotel, "authenticated");
      expect(res.error, hotel).toBeNull();
      expect(res.rows, hotel).toHaveLength(1);
    }
  });

  it("a Destination Pass reads premium inside its destination AND its descendants", async () => {
    for (const hotel of [HOTEL.entitled, HOTEL.child]) {
      const res = await premiumAs(U.pass, hotel, "authenticated");
      expect(res.error, hotel).toBeNull();
      expect(res.rows, hotel).toHaveLength(1);
      expect(Number(res.rows[0]!.reply_rate)).toBeGreaterThan(0);
    }
  });

  it("the same Pass reads NOTHING outside its destination", async () => {
    const res = await premiumAs(U.pass, HOTEL.outside, "authenticated");
    // Not an error — the query is permitted; the row is simply not there.
    expect(res.error).toBeNull();
    expect(res.rows).toEqual([]);
  });

  it("an EXPIRED Pass reads nothing, even in the destination it once covered", async () => {
    const res = await premiumAs(U.expired, HOTEL.entitled, "authenticated");
    expect(res.error).toBeNull();
    expect(res.rows).toEqual([]);
  });

  it("a Free creator reads no premium row anywhere", async () => {
    for (const hotel of [HOTEL.entitled, HOTEL.child, HOTEL.outside]) {
      const res = await premiumAs(U.free, hotel, "authenticated");
      expect(res.error, hotel).toBeNull();
      expect(res.rows, hotel).toEqual([]);
    }
  });

  it("an admin reads premium intelligence, per the existing operational rule", async () => {
    const res = await premiumAs(U.admin, HOTEL.entitled, "authenticated");
    expect(res.error).toBeNull();
    expect(res.rows).toHaveLength(1);
  });

  it("anon is refused at the PRIVILEGE layer, not merely filtered", async () => {
    const res = await premiumAs(null, HOTEL.entitled, "anon");
    expect(res.error).not.toBeNull();
    expect(res.error?.code).toBe("42501");
  });

  /* ---------------------------------------------------------------- */
  /* Privacy invariant (D050)                                          */
  /* ---------------------------------------------------------------- */

  it("the PUBLIC layer is byte-identical for Free and for Pro", async () => {
    const columns = "activity_level, confidence_level, has_confirmed_collaboration, recency_band";
    const asFree = await queryAs(
      { role: "authenticated", sub: U.free },
      `select ${columns} from public.hotel_public_intelligence where hotel_id = $1`,
      [HOTEL.entitled],
    );
    const asPro = await queryAs(
      { role: "authenticated", sub: U.pro },
      `select ${columns} from public.hotel_public_intelligence where hotel_id = $1`,
      [HOTEL.entitled],
    );
    const asAnon = await queryAs(
      { role: "anon" },
      `select ${columns} from public.hotel_public_intelligence where hotel_id = $1`,
      [HOTEL.entitled],
    );
    expect(asFree.rows).toEqual(asPro.rows);
    expect(asAnon.rows).toEqual(asPro.rows);
    // Paying adds a second projection; it does not widen the first one.
    expect(asPro.rows).toHaveLength(1);
  });

  it("no browser role can reach the base tables, on any plan", async () => {
    for (const [userId, label] of [
      [U.pro, "pro"],
      [U.pass, "pass"],
      [U.admin, "admin"],
      [U.free, "free"],
    ] as const) {
      for (const table of [
        "hotel_intelligence",
        "destination_intelligence",
        "outreach_events",
        "collaborations",
      ]) {
        const res = await queryAs(
          { role: "authenticated", sub: userId },
          `select * from public.${table} limit 1`,
        );
        if (table === "hotel_intelligence" || table === "destination_intelligence") {
          // No privilege at all — a Pro subscription does not create one.
          expect(res.error, `${label}/${table}`).not.toBeNull();
        } else {
          // SELECT is permitted, but RLS restricts it to the caller's own rows,
          // and these creators own none of this seeded history.
          expect(res.rows, `${label}/${table}`).toEqual([]);
        }
      }
    }
  });

  it("the premium row exposes no identifier, count or timestamp", async () => {
    const cols = await adminQuery<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='hotel_premium_intelligence'`,
    );
    const names = cols.map((c) => c.column_name).sort();
    expect(names).toEqual([
      "collaboration_types",
      "confidence_level",
      "contributor_count",
      "hotel_id",
      "hotel_slug",
      "recent_activity_band",
      "reply_rate",
      "reply_time_band",
    ]);
    for (const forbidden of [
      "creator_id",
      "pipeline_item_id",
      "pitch_count",
      "reply_count",
      "pitched_cycles_365d",
      "replied_cycles_365d",
      "median_reply_hours_365d",
      "last_creator_activity_at",
      "private_value_amount",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("the seeded hotel discloses the metrics the contract promises", async () => {
    const res = await premiumAs(U.pro, HOTEL.entitled, "authenticated");
    const row = res.rows[0]!;
    // 10 replies over 15 pitched cycles.
    expect(Number(row.reply_rate)).toBeCloseTo(0.6667, 3);
    // 100 hours ⇒ the 3–7 day band.
    expect(row.reply_time_band).toBe("3_7_days");
    // Three creators pitched within 7 days (days 5, 6 and 7), so the tightest
    // band clears its contributor floor.
    expect(row.recent_activity_band).toBe("within_7_days");
    expect(row.collaboration_types?.sort()).toEqual(["paid", "stay"]);
    expect(row.contributor_count).toBe(8);
  });
});

/* ------------------------------------------------------------------ */
/* Thresholds                                                          */
/* ------------------------------------------------------------------ */

d("premium intelligence — thresholds", () => {
  const HOTEL_T = "d5000000-0000-0000-0000-000000000001";
  const DEST_T = "d5000000-0000-0000-0000-0000000000f1";
  const PRO = "d5000000-0000-0000-0000-0000000000a1";

  async function reset(): Promise<void> {
    await adminQuery("delete from public.collaborations where hotel_id = $1", [HOTEL_T]);
    await adminQuery("delete from public.outreach_events where hotel_id = $1", [HOTEL_T]);
    await adminQuery("delete from public.pipeline_items where hotel_id = $1", [HOTEL_T]);
    await adminQuery("delete from public.hotel_intelligence where hotel_id = $1", [HOTEL_T]);
  }

  async function view(): Promise<PremiumRow | null> {
    const res = await queryAs<PremiumRow>(
      { role: "authenticated", sub: PRO },
      `select ${PREMIUM_COLUMNS} from public.hotel_premium_intelligence where hotel_id = $1`,
      [HOTEL_T],
    );
    expect(res.error).toBeNull();
    return res.rows[0] ?? null;
  }

  /** `cycles` pitched cycles spread over `creators` distinct creators. */
  async function seed(opts: {
    cycles: number;
    creators: number;
    replied?: number;
    repliedCreators?: number;
    replyHours?: number;
    pitchDaysAgo?: number;
  }): Promise<void> {
    const pool: string[] = [];
    for (let i = 0; i < opts.creators; i++) pool.push(await makeCreator());
    const repliedCreators = opts.repliedCreators ?? opts.creators;

    for (let i = 0; i < opts.cycles; i++) {
      const replies = opts.replied ?? 0;
      // Replied cycles are drawn from the first `repliedCreators` creators, so
      // reply diversity can be varied independently of pitch diversity.
      const creator = i < replies ? pool[i % repliedCreators]! : pool[i % pool.length]!;
      await seedCycle({
        hotel: HOTEL_T,
        creator,
        pitchDaysAgo: opts.pitchDaysAgo ?? 200 + i,
        replyHoursAfter: i < replies ? (opts.replyHours ?? 100) : undefined,
      });
    }
    await recompute(HOTEL_T);
  }

  beforeAll(async () => {
    await setupDatabase();
    await adminQuery("insert into auth.users (id, email) values ($1, $2)", [
      PRO,
      `${PRO}@test.local`,
    ]);
    await adminQuery(
      `insert into public.access_entitlements (user_id, access_type, status, starts_at)
         values ($1,'pro','active', now() - interval '1 day')`,
      [PRO],
    );
    await adminQuery(
      "insert into public.destinations (id, name, slug, type) values ($1,'Thresholds','thresholds','city')",
      [DEST_T],
    );
    await adminQuery(
      "insert into public.hotels (id, name, slug, destination_id) values ($1,'T Hotel','t-hotel',$2)",
      [HOTEL_T, DEST_T],
    );
  }, 120_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  it("reply rate needs 15 cycles: 14 is suppressed, 15 publishes", async () => {
    await reset();
    await seed({ cycles: 14, creators: 7, replied: 7 });
    expect((await view())!.reply_rate).toBeNull();

    await reset();
    await seed({ cycles: 15, creators: 7, replied: 7 });
    expect(Number((await view())!.reply_rate)).toBeCloseTo(7 / 15, 3);
  });

  it("reply rate needs 5 distinct creators, however many cycles there are", async () => {
    await reset();
    // 20 cycles, but only 4 creators — one small group cannot speak for a hotel.
    await seed({ cycles: 20, creators: 4, replied: 10 });
    expect((await view())!.reply_rate).toBeNull();
  });

  it("a suppressed reply rate is NULL, never 0%", async () => {
    await reset();
    // 14 cycles, zero replies: the rate is genuinely 0, and still withheld.
    await seed({ cycles: 14, creators: 7 });
    const row = (await view())!;
    expect(row.reply_rate).toBeNull();
    expect(row.reply_rate).not.toBe("0");
    expect(row.reply_rate).not.toBe(0);
  });

  it("a measured zero IS published once both floors are met", async () => {
    await reset();
    await seed({ cycles: 15, creators: 7 });
    // "Measured, and nobody replied" is a real finding — unlike "we withheld it".
    expect(Number((await view())!.reply_rate)).toBe(0);
  });

  it("typical reply time needs 10 replied cycles: 9 is suppressed, 10 publishes", async () => {
    await reset();
    await seed({ cycles: 20, creators: 10, replied: 9, repliedCreators: 6 });
    expect((await view())!.reply_time_band).toBeNull();

    await reset();
    await seed({ cycles: 20, creators: 10, replied: 10, repliedCreators: 6 });
    expect((await view())!.reply_time_band).toBe("3_7_days");
  });

  it("typical reply time needs 5 distinct creators who received a reply", async () => {
    await reset();
    // Twelve replies, but only four creators received them.
    await seed({ cycles: 20, creators: 10, replied: 12, repliedCreators: 4 });
    const row = (await view())!;
    expect(row.reply_time_band).toBeNull();
    // The reply RATE still publishes — different metric, different sample.
    expect(row.reply_rate).not.toBeNull();
  });

  it("maps median hours onto the approved bands, never an hour count", async () => {
    const cases: [number, string][] = [
      [6, "under_24h"],
      [48, "1_3_days"],
      [100, "3_7_days"],
      [240, "1_2_weeks"],
      [800, "2_plus_weeks"],
    ];
    for (const [hours, band] of cases) {
      await reset();
      await seed({ cycles: 20, creators: 10, replied: 10, repliedCreators: 6, replyHours: hours });
      const row = (await view())!;
      expect(row.reply_time_band, `${hours}h`).toBe(band);
      expect(String(row.reply_time_band)).not.toMatch(/\d+\.\d/);
    }
  });

  it("the recent-activity band needs 3 distinct creators", async () => {
    await reset();
    // Two recent creators — the tightest band they could support is withheld.
    await seed({ cycles: 2, creators: 2, pitchDaysAgo: 3 });
    expect((await view())!.recent_activity_band).toBeNull();

    await reset();
    await seed({ cycles: 3, creators: 3, pitchDaysAgo: 3 });
    expect((await view())!.recent_activity_band).toBe("within_7_days");
  });

  it("falls back to a wider band when the tighter one lacks contributors", async () => {
    await reset();
    const creators: string[] = [];
    for (let i = 0; i < 3; i++) creators.push(await makeCreator());
    // One creator this week; all three within the month.
    await seedCycle({ hotel: HOTEL_T, creator: creators[0]!, pitchDaysAgo: 2 });
    await seedCycle({ hotel: HOTEL_T, creator: creators[1]!, pitchDaysAgo: 20 });
    await seedCycle({ hotel: HOTEL_T, creator: creators[2]!, pitchDaysAgo: 25 });
    await recompute(HOTEL_T);

    expect((await view())!.recent_activity_band).toBe("within_30_days");
  });

  it("a collaboration type needs 3 distinct creators to be named", async () => {
    await reset();
    const creators: string[] = [];
    for (let i = 0; i < 4; i++) creators.push(await makeCreator());

    // One creator, three PAID collaborations — repetition is not diversity.
    for (let i = 0; i < 3; i++) {
      await seedCycle({
        hotel: HOTEL_T,
        creator: creators[0]!,
        pitchDaysAgo: 40 + i,
        collaborationType: "paid",
      });
    }
    // Three different creators, one STAY each.
    for (let i = 1; i < 4; i++) {
      await seedCycle({
        hotel: HOTEL_T,
        creator: creators[i]!,
        pitchDaysAgo: 60 + i,
        collaborationType: "stay",
      });
    }
    await recompute(HOTEL_T);

    const row = (await view())!;
    expect(row.collaboration_types).toEqual(["stay"]);
    // The single creator's three paid deals never become "this hotel pays".
    expect(row.collaboration_types).not.toContain("paid");
  });

  it("the contributor sample is withheld below 5 creators", async () => {
    await reset();
    await seed({ cycles: 4, creators: 4, pitchDaysAgo: 10 });
    expect((await view())!.contributor_count).toBeNull();

    await reset();
    await seed({ cycles: 5, creators: 5, pitchDaysAgo: 10 });
    expect((await view())!.contributor_count).toBe(5);
  });

  it("a hotel with activity but nothing publishable yields a row with every metric NULL", async () => {
    await reset();
    await seed({ cycles: 2, creators: 2, pitchDaysAgo: 200 });
    const row = (await view())!;
    expect(row.reply_rate).toBeNull();
    expect(row.reply_time_band).toBeNull();
    expect(row.recent_activity_band).toBeNull();
    expect(row.collaboration_types).toBeNull();
    expect(row.contributor_count).toBeNull();
    // The confidence vocabulary survives internally; the UI turns this into the
    // building state rather than showing statistical jargon.
    expect(row.confidence_level).toBe("insufficient");
  });

  it("events older than the 365-day window do not feed the reply rate", async () => {
    await reset();
    await seed({ cycles: 20, creators: 8, replied: 12, pitchDaysAgo: 400 });
    const row = (await view())!;
    expect(row.reply_rate).toBeNull();
    expect(row.reply_time_band).toBeNull();
  });
});
