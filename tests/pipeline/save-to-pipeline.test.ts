/**
 * Transactional Save-to-Pipeline (migration 0019, PRD §7.3/§7.4, D023/D042).
 *
 * These run against real Postgres with real roles: the RPC is the security
 * boundary, so the guarantees (atomicity, idempotency, race-safe limits,
 * entitlement resolution, privilege surface) are proven at the database level
 * rather than in a re-implementation.
 */
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";
import { FREE_LIMITS } from "@/lib/config";

const d = describe.skipIf(!hasTestDb);

const U = {
  free: "e1000000-0000-0000-0000-000000000001",
  pro: "e1000000-0000-0000-0000-000000000002",
  dest: "e1000000-0000-0000-0000-000000000003",
  other: "e1000000-0000-0000-0000-000000000004",
} as const;

const DEST = {
  parent: "e2000000-0000-0000-0000-000000000001", // entitled (parent)
  child: "e2000000-0000-0000-0000-000000000002", // descendant of parent
  outside: "e2000000-0000-0000-0000-000000000003", // not entitled
} as const;

/** Enough hotels to exercise the Free limit (10) plus spares. */
const HOTELS = Array.from({ length: 14 }, (_, i) => ({
  id: `e3000000-0000-0000-0000-0000000000${(i + 16).toString(16)}`,
  name: `Zs Hotel ${i + 1}`,
  destination: DEST.outside,
}));
const CHILD_HOTEL = "e3000000-0000-0000-0000-0000000000c1";
const PARENT_HOTEL = "e3000000-0000-0000-0000-0000000000c2";

async function save(userId: string, hotelId: string, limit = FREE_LIMITS.savedHotels) {
  const rows = await adminQuery<{ r: Record<string, unknown> }>(
    "select public.save_hotel_to_pipeline($1,$2,$3) as r",
    [userId, hotelId, limit],
  );
  return rows[0]!.r;
}

async function creatorIdFor(userId: string): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    "select id from public.creator_profiles where user_id = $1",
    [userId],
  );
  return rows[0]!.id;
}

async function counts(userId: string) {
  const creatorId = await creatorIdFor(userId);
  const rows = await adminQuery<{ pipeline: string; events: string }>(
    `select
       (select count(*) from public.pipeline_items where creator_id = $1)::text as pipeline,
       (select count(*) from public.outreach_events
          where creator_id = $1 and event_type = 'hotel_saved')::text as events`,
    [creatorId],
  );
  return { pipeline: Number(rows[0]!.pipeline), events: Number(rows[0]!.events) };
}

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();

  for (const id of Object.values(U)) {
    await adminQuery("insert into auth.users (id, email) values ($1,$2)", [id, `${id}@t.local`]);
  }

  await adminQuery(
    `insert into public.destinations (id, name, slug, type, country_code) values
       ($1,'Zs Parent','zs-parent','island','AE'),
       ($2,'Zs Outside','zs-outside','island','ID')`,
    [DEST.parent, DEST.outside],
  );
  await adminQuery(
    `insert into public.destinations (id, name, slug, type, country_code, parent_destination_id)
       values ($1,'Zs Child','zs-child','area','AE',$2)`,
    [DEST.child, DEST.parent],
  );

  for (const h of HOTELS) {
    await adminQuery(
      "insert into public.hotels (id,name,slug,destination_id) values ($1,$2,$3,$4)",
      [h.id, h.name, h.id, h.destination],
    );
  }
  await adminQuery("insert into public.hotels (id,name,slug,destination_id) values ($1,$2,$3,$4)", [
    CHILD_HOTEL,
    "Zs Child Hotel",
    "zs-child-hotel",
    DEST.child,
  ]);
  await adminQuery("insert into public.hotels (id,name,slug,destination_id) values ($1,$2,$3,$4)", [
    PARENT_HOTEL,
    "Zs Parent Hotel",
    "zs-parent-hotel",
    DEST.parent,
  ]);

  // Entitlements: Pro (worldwide), and a destination pass on the PARENT node.
  await adminQuery(
    `insert into public.access_entitlements (user_id, access_type, status, starts_at)
       values ($1,'pro','active', now() - interval '1 day')`,
    [U.pro],
  );
  await adminQuery(
    `insert into public.access_entitlements (user_id, access_type, destination_id, status, starts_at)
       values ($1,'destination',$2,'active', now() - interval '1 day')`,
    [U.dest, DEST.parent],
  );
}, 120_000);

afterAll(async () => {
  await teardownDatabase();
});

beforeEach(async () => {
  if (!hasTestDb) return;
  await adminQuery("delete from public.outreach_events");
  await adminQuery("delete from public.pipeline_items");
});

d("A — a new save is atomic and complete", () => {
  it("creates exactly one saved pipeline item and one hotel_saved event", async () => {
    const res = (await save(U.free, HOTELS[0]!.id)) as Record<string, unknown>;
    expect(res.result).toBe("created");
    expect(res.status).toBe("saved");
    expect(res.cycle_number).toBe(1);

    const c = await counts(U.free);
    expect(c).toEqual({ pipeline: 1, events: 1 });
  });

  it("links creator, hotel and pipeline item correctly on the event", async () => {
    const res = (await save(U.free, HOTELS[0]!.id)) as Record<string, unknown>;
    const creatorId = await creatorIdFor(U.free);
    const rows = await adminQuery<{
      creator_id: string;
      hotel_id: string;
      pipeline_item_id: string;
      source: string;
      event_at: string;
    }>(
      "select creator_id, hotel_id, pipeline_item_id, source, event_at from public.outreach_events where event_type='hotel_saved'",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.creator_id).toBe(creatorId);
    expect(rows[0]!.hotel_id).toBe(HOTELS[0]!.id);
    expect(rows[0]!.pipeline_item_id).toBe(res.pipeline_item_id);
    expect(rows[0]!.source).toBe("manual_creator");
    expect(rows[0]!.event_at).not.toBeNull();
  });

  it("rejects an unknown hotel and a user with no creator profile", async () => {
    expect(
      ((await save(U.free, "e3000000-0000-0000-0000-0000000000ff")) as Record<string, unknown>)
        .result,
    ).toBe("hotel_not_found");
    expect(
      (
        (await save("e1000000-0000-0000-0000-0000000000ff", HOTELS[0]!.id)) as Record<
          string,
          unknown
        >
      ).result,
    ).toBe("creator_profile_missing");
    expect(await counts(U.free)).toEqual({ pipeline: 0, events: 0 });
  });
});

d("B — retries are idempotent", () => {
  it("a repeat save returns already_saved with the same id and emits no second event", async () => {
    const first = (await save(U.free, HOTELS[0]!.id)) as Record<string, unknown>;
    const second = (await save(U.free, HOTELS[0]!.id)) as Record<string, unknown>;
    const third = (await save(U.free, HOTELS[0]!.id)) as Record<string, unknown>;

    expect(second.result).toBe("already_saved");
    expect(third.result).toBe("already_saved");
    expect(second.pipeline_item_id).toBe(first.pipeline_item_id);
    expect(await counts(U.free)).toEqual({ pipeline: 1, events: 1 });
  });
});

d("C — concurrent saves of the same hotel produce one cycle", () => {
  it("only one open cycle and one event survive a concurrent double-save", async () => {
    // Two independent connections racing the same (creator, hotel).
    const a = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    const b = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await a.connect();
    await b.connect();
    try {
      const sql = "select public.save_hotel_to_pipeline($1,$2,$3) as r";
      const params = [U.free, HOTELS[1]!.id, FREE_LIMITS.savedHotels];
      const [ra, rb] = await Promise.all([a.query(sql, params), b.query(sql, params)]);

      const results = [ra.rows[0].r.result, rb.rows[0].r.result].sort();
      expect(results).toEqual(["already_saved", "created"]);
      expect(await counts(U.free)).toEqual({ pipeline: 1, events: 1 });
    } finally {
      await a.end();
      await b.end();
    }
  });
});

d("D — a closed cycle permits a new one", () => {
  it("increments cycle_number and emits a fresh event for the new cycle", async () => {
    const first = (await save(U.free, HOTELS[2]!.id)) as Record<string, unknown>;
    expect(first.cycle_number).toBe(1);

    await adminQuery("update public.pipeline_items set status='closed' where id=$1", [
      first.pipeline_item_id,
    ]);

    const second = (await save(U.free, HOTELS[2]!.id)) as Record<string, unknown>;
    expect(second.result).toBe("created");
    expect(second.cycle_number).toBe(2);
    expect(second.pipeline_item_id).not.toBe(first.pipeline_item_id);

    // One event per cycle: two cycles → two events.
    expect(await counts(U.free)).toEqual({ pipeline: 2, events: 2 });
  });

  it("closed cycles do not consume the Free open-relationship allowance", async () => {
    for (let i = 0; i < FREE_LIMITS.savedHotels; i++) {
      await save(U.free, HOTELS[i]!.id);
    }
    await adminQuery("update public.pipeline_items set status='closed' where hotel_id=$1", [
      HOTELS[0]!.id,
    ]);
    const res = (await save(U.free, HOTELS[FREE_LIMITS.savedHotels]!.id)) as Record<
      string,
      unknown
    >;
    expect(res.result).toBe("created");
  });
});

d("E — the Free open-relationship limit is enforced server-side", () => {
  it(`allows exactly ${FREE_LIMITS.savedHotels} and rejects the next`, async () => {
    for (let i = 0; i < FREE_LIMITS.savedHotels; i++) {
      const res = (await save(U.free, HOTELS[i]!.id)) as Record<string, unknown>;
      expect(res.result).toBe("created");
    }
    const overflow = (await save(U.free, HOTELS[FREE_LIMITS.savedHotels]!.id)) as Record<
      string,
      unknown
    >;
    expect(overflow.result).toBe("limit_reached");
    expect(overflow.limit).toBe(FREE_LIMITS.savedHotels);
    expect(overflow.open_count).toBe(FREE_LIMITS.savedHotels);

    const c = await counts(U.free);
    expect(c.pipeline).toBe(FREE_LIMITS.savedHotels);
    expect(c.events).toBe(FREE_LIMITS.savedHotels);
  });

  it("concurrent saves of DIFFERENT hotels cannot race past the limit", async () => {
    // Fill to one below the limit, then race two different hotels.
    for (let i = 0; i < FREE_LIMITS.savedHotels - 1; i++) {
      await save(U.free, HOTELS[i]!.id);
    }

    const a = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    const b = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await a.connect();
    await b.connect();
    try {
      const sql = "select public.save_hotel_to_pipeline($1,$2,$3) as r";
      const [ra, rb] = await Promise.all([
        a.query(sql, [U.free, HOTELS[10]!.id, FREE_LIMITS.savedHotels]),
        b.query(sql, [U.free, HOTELS[11]!.id, FREE_LIMITS.savedHotels]),
      ]);
      const results = [ra.rows[0].r.result, rb.rows[0].r.result].sort();
      // Exactly one may win the last slot.
      expect(results).toEqual(["created", "limit_reached"]);
      expect((await counts(U.free)).pipeline).toBe(FREE_LIMITS.savedHotels);
    } finally {
      await a.end();
      await b.end();
    }
  });
});

d("F/G — entitlement exempts a creator from the Free limit", () => {
  it("an active Pro is not blocked by the Free saved limit", async () => {
    for (const h of HOTELS.slice(0, FREE_LIMITS.savedHotels + 2)) {
      const res = (await save(U.pro, h.id)) as Record<string, unknown>;
      expect(res.result).toBe("created");
    }
    expect((await counts(U.pro)).pipeline).toBe(FREE_LIMITS.savedHotels + 2);
  });

  it("a destination pass covers the entitled node and its descendants", async () => {
    expect(((await save(U.dest, PARENT_HOTEL)) as Record<string, unknown>).result).toBe("created");
    expect(((await save(U.dest, CHILD_HOTEL)) as Record<string, unknown>).result).toBe("created");
  });

  it("a destination creator acting OUTSIDE the entitlement falls back to Free behavior", async () => {
    // All HOTELS live in the non-entitled destination.
    for (let i = 0; i < FREE_LIMITS.savedHotels; i++) {
      expect(((await save(U.dest, HOTELS[i]!.id)) as Record<string, unknown>).result).toBe(
        "created",
      );
    }
    const overflow = (await save(U.dest, HOTELS[FREE_LIMITS.savedHotels]!.id)) as Record<
      string,
      unknown
    >;
    expect(overflow.result).toBe("limit_reached");
  });
});

d("H — ownership and privilege surface", () => {
  it("client roles cannot EXECUTE the privileged RPC", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      const res = await queryAs(
        { role, sub: role === "authenticated" ? U.free : null },
        "select public.save_hotel_to_pipeline($1,$2,$3)",
        [U.free, HOTELS[0]!.id, FREE_LIMITS.savedHotels],
      );
      expect(res.error).not.toBeNull();
      expect(res.error!.message).toMatch(/permission denied/i);
    }
  });

  it("PUBLIC has no EXECUTE in the function ACL, and service_role does", async () => {
    const rows = await adminQuery<{
      anon: boolean;
      authed: boolean;
      svc: boolean;
      public_exec: boolean;
    }>(
      `select
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed,
         has_function_privilege('service_role', p.oid, 'EXECUTE') as svc,
         aclcontains(coalesce(p.proacl, acldefault('f', p.proowner)),
                     makeaclitem(0::oid, p.proowner, 'EXECUTE', false)) as public_exec
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname='save_hotel_to_pipeline'`,
    );
    expect(rows[0]!.anon).toBe(false);
    expect(rows[0]!.authed).toBe(false);
    expect(rows[0]!.public_exec).toBe(false);
    expect(rows[0]!.svc).toBe(true);
  });

  it("the RPC pins a safe search_path", async () => {
    const rows = await adminQuery<{ cfg: string | null }>(
      `select array_to_string(p.proconfig, ',') as cfg
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname='public' and p.proname='save_hotel_to_pipeline'`,
    );
    expect(rows[0]!.cfg).toContain("search_path=public, pg_temp");
  });

  it("creator A cannot read or modify creator B's relationship", async () => {
    await save(U.free, HOTELS[0]!.id);

    // B cannot see A's row (RLS scopes to current_creator_id()).
    const read = await queryAs(
      { role: "authenticated", sub: U.other },
      "select id from public.pipeline_items",
    );
    expect(read.rows).toHaveLength(0);

    // B cannot update it either.
    const update = await queryAs(
      { role: "authenticated", sub: U.other },
      "update public.pipeline_items set status='won' returning id",
    );
    expect(update.rows).toHaveLength(0);

    const still = await adminQuery<{ status: string }>("select status from public.pipeline_items");
    expect(still[0]!.status).toBe("saved");
  });

  it("a creator cannot forge an event for another creator", async () => {
    await save(U.free, HOTELS[0]!.id);
    const otherCreator = await creatorIdFor(U.other);
    const freeCreator = await creatorIdFor(U.free);
    const item = await adminQuery<{ id: string }>("select id from public.pipeline_items");

    const res = await queryAs(
      { role: "authenticated", sub: U.other },
      `insert into public.outreach_events
         (creator_id, hotel_id, pipeline_item_id, event_type, event_at)
       values ($1,$2,$3,'hotel_saved', now()) returning id`,
      [freeCreator, HOTELS[0]!.id, item[0]!.id],
    );
    expect(res.error).not.toBeNull();
    expect(otherCreator).not.toBe(freeCreator);
  });
});

d("J — the pipeline list reads only the creator's own rows, newest activity first", () => {
  it("orders by last_activity_at desc under RLS and never touches contacts", async () => {
    for (const i of [0, 1, 2]) await save(U.free, HOTELS[i]!.id);
    // Make the middle row the most recently active.
    await adminQuery(
      "update public.pipeline_items set last_activity_at = now() + interval '1 hour' where hotel_id = $1",
      [HOTELS[1]!.id],
    );

    // The SQL shape listPipelineItems() issues, as the authenticated creator.
    const mine = await queryAs<{ hotel_id: string }>(
      { role: "authenticated", sub: U.free },
      `select p.hotel_id
         from public.pipeline_items p
         join public.hotels h on h.id = p.hotel_id
        order by p.last_activity_at desc, p.id asc
        limit 200`,
    );
    expect(mine.error).toBeNull();
    expect(mine.rows).toHaveLength(3);
    expect(mine.rows[0]!.hotel_id).toBe(HOTELS[1]!.id);

    // Another creator sees nothing at all through the same query.
    const theirs = await queryAs(
      { role: "authenticated", sub: U.other },
      "select p.id from public.pipeline_items p",
    );
    expect(theirs.rows).toHaveLength(0);
  });
});

d("I — hotel_saved does not feed intelligence", () => {
  it("creates no hotel_intelligence or destination_intelligence rows", async () => {
    await save(U.free, HOTELS[0]!.id);
    await save(U.free, HOTELS[1]!.id);

    for (const table of ["hotel_intelligence", "destination_intelligence"]) {
      const rows = await adminQuery<{ n: string }>(`select count(*)::text n from public.${table}`);
      expect(Number(rows[0]!.n)).toBe(0);
    }
  });
});
