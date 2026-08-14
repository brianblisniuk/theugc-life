/**
 * The deal path (migration 0021, EVENTS.md §3, DATABASE.md §8, D043).
 *
 *   replied → negotiating → won → a first-class collaboration
 *   negotiating → closed when the negotiation fails
 *
 * Marking a deal won is the first workflow step that writes a second row of
 * proprietary data, so what these prove is mostly that partial states cannot
 * exist: never won without a collaboration, never a collaboration without its
 * deal_won, never two of either — under retries, races, or a hostile client
 * writing to the table directly.
 */
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";
import { FREE_LIMITS } from "@/lib/config";

const d = describe.skipIf(!hasTestDb);
const LIMIT = FREE_LIMITS.activePipelineItems;

const U = {
  free: "b1000000-0000-0000-0000-000000000001",
  other: "b1000000-0000-0000-0000-000000000002",
} as const;

const DEST = "b2000000-0000-0000-0000-000000000001";
const HOTELS = Array.from({ length: 6 }, (_, i) => ({
  id: `b3000000-0000-0000-0000-0000000000${(i + 16).toString(16)}`,
  name: `Zw Hotel ${i + 1}`,
}));

const DAY = 86_400_000;
function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY).toISOString();
}

async function save(userId: string, hotelId: string): Promise<string> {
  const rows = await adminQuery<{ r: Record<string, unknown> }>(
    "select public.save_hotel_to_pipeline($1,$2,$3) as r",
    [userId, hotelId, 50],
  );
  const id = rows[0]!.r.pipeline_item_id;
  if (typeof id !== "string") throw new Error(`save failed: ${JSON.stringify(rows[0]!.r)}`);
  return id;
}

async function transition(
  userId: string,
  itemId: string,
  action: string,
  args: {
    eventAt?: string | null;
    channel?: string | null;
    sentiment?: string | null;
    closeReason?: string | null;
  } = {},
): Promise<Record<string, unknown>> {
  const rows = await adminQuery<{ r: Record<string, unknown> }>(
    "select public.transition_pipeline_item($1,$2,$3,$4,$5,$6,null,$7,$8) as r",
    [
      userId,
      itemId,
      action,
      args.eventAt ?? null,
      args.channel ?? null,
      args.sentiment ?? null,
      args.closeReason ?? null,
      LIMIT,
    ],
  );
  return rows[0]!.r;
}

async function deal(
  userId: string,
  itemId: string,
  action: string,
  args: { agreedAt?: string | null; collaborationType?: string | null } = {},
): Promise<Record<string, unknown>> {
  const rows = await adminQuery<{ r: Record<string, unknown> }>(
    "select public.progress_pipeline_deal($1,$2,$3,$4,$5) as r",
    [userId, itemId, action, args.agreedAt ?? null, args.collaborationType ?? null],
  );
  return rows[0]!.r;
}

async function events(itemId: string) {
  return adminQuery<{ event_type: string; metadata: Record<string, unknown>; event_at: string }>(
    "select event_type, metadata, event_at from public.outreach_events where pipeline_item_id = $1 order by created_at",
    [itemId],
  );
}

async function collaborations(itemId?: string) {
  return adminQuery<{
    id: string;
    creator_id: string;
    hotel_id: string;
    pipeline_item_id: string | null;
    status: string;
    collaboration_type: string | null;
    agreed_at: string | null;
  }>(
    itemId
      ? "select * from public.collaborations where pipeline_item_id = $1"
      : "select * from public.collaborations",
    itemId ? [itemId] : [],
  );
}

async function statusOf(itemId: string): Promise<string> {
  const rows = await adminQuery<{ status: string }>(
    "select status from public.pipeline_items where id = $1",
    [itemId],
  );
  return rows[0]!.status;
}

async function creatorIdFor(userId: string): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    "select id from public.creator_profiles where user_id = $1",
    [userId],
  );
  return rows[0]!.id;
}

/** Drive a fresh cycle all the way to `replied`. */
async function replied(userId: string, hotelId: string): Promise<string> {
  const id = await save(userId, hotelId);
  expect(
    (await transition(userId, id, "mark_pitched", { eventAt: daysAgo(6), channel: "email" }))
      .result,
  ).toBe("applied");
  expect(
    (await transition(userId, id, "mark_replied", { eventAt: daysAgo(3), sentiment: "positive" }))
      .result,
  ).toBe("applied");
  return id;
}

/** …and on to `negotiating`. */
async function negotiating(userId: string, hotelId: string): Promise<string> {
  const id = await replied(userId, hotelId);
  expect((await deal(userId, id, "start_negotiation")).result).toBe("applied");
  return id;
}

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();

  for (const id of Object.values(U)) {
    await adminQuery("insert into auth.users (id, email) values ($1,$2)", [id, `${id}@t.local`]);
  }
  await adminQuery(
    "insert into public.destinations (id,name,slug,type,country_code) values ($1,'Zw Dest','zw-dest','city','AE')",
    [DEST],
  );
  for (const h of HOTELS) {
    await adminQuery(
      "insert into public.hotels (id,name,slug,destination_id) values ($1,$2,$3,$4)",
      [h.id, h.name, h.id, DEST],
    );
  }
}, 120_000);

afterAll(async () => {
  await teardownDatabase();
});

beforeEach(async () => {
  if (!hasTestDb) return;
  await adminQuery("delete from public.collaborations");
  await adminQuery("delete from public.outreach_events");
  await adminQuery("delete from public.pipeline_items");
});

/* ------------------------------------------------------------------ */

d("A/B/C/D — start negotiation", () => {
  it("moves replied → negotiating with exactly one negotiation_started", async () => {
    const id = await replied(U.free, HOTELS[0]!.id);
    const res = await deal(U.free, id, "start_negotiation");

    expect(res.result).toBe("applied");
    expect(res.status).toBe("negotiating");
    expect(await statusOf(id)).toBe("negotiating");
    expect((await events(id)).filter((e) => e.event_type === "negotiation_started")).toHaveLength(
      1,
    );
  });

  it("a repeat start is already_applied and writes no second event", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);
    const retry = await deal(U.free, id, "start_negotiation");
    const third = await deal(U.free, id, "start_negotiation");

    expect(retry.result).toBe("already_applied");
    expect(third.result).toBe("already_applied");
    expect((await events(id)).filter((e) => e.event_type === "negotiation_started")).toHaveLength(
      1,
    );
  });

  it("concurrent starts produce exactly one event", async () => {
    const id = await replied(U.free, HOTELS[0]!.id);
    const a = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    const b = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await a.connect();
    await b.connect();
    try {
      const sql = "select public.progress_pipeline_deal($1,$2,'start_negotiation',null,null) as r";
      const [ra, rb] = await Promise.all([a.query(sql, [U.free, id]), b.query(sql, [U.free, id])]);
      expect([ra.rows[0].r.result, rb.rows[0].r.result].sort()).toEqual([
        "already_applied",
        "applied",
      ]);
      expect((await events(id)).filter((e) => e.event_type === "negotiation_started")).toHaveLength(
        1,
      );
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("rejects every origin except replied", async () => {
    const saved = await save(U.free, HOTELS[1]!.id);
    expect((await deal(U.free, saved, "start_negotiation")).result).toBe("invalid_transition");

    const planned = await save(U.free, HOTELS[2]!.id);
    await transition(U.free, planned, "plan");
    expect((await deal(U.free, planned, "start_negotiation")).result).toBe("invalid_transition");

    const pitched = await save(U.free, HOTELS[3]!.id);
    await transition(U.free, pitched, "mark_pitched", { eventAt: daysAgo(2), channel: "email" });
    expect((await deal(U.free, pitched, "start_negotiation")).result).toBe("invalid_transition");

    const closed = await save(U.free, HOTELS[4]!.id);
    await transition(U.free, closed, "close", { closeReason: "timing" });
    expect((await deal(U.free, closed, "start_negotiation")).result).toBe("invalid_transition");

    for (const id of [saved, planned, pitched, closed]) {
      expect((await events(id)).map((e) => e.event_type)).not.toContain("negotiation_started");
    }
  });

  it("rejects an unknown action", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);
    for (const action of ["mark_lost", "", "deal_won", "close"]) {
      expect((await deal(U.free, id, action)).result).toBe("invalid_input");
    }
    expect(await statusOf(id)).toBe("negotiating");
  });
});

d("E/F/G — mark won", () => {
  it("writes the status, one deal_won and one collaboration together", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);
    const agreed = daysAgo(1);

    const res = await deal(U.free, id, "mark_won", {
      agreedAt: agreed,
      collaborationType: "stay",
    });
    expect(res.result).toBe("applied");
    expect(res.status).toBe("won");
    expect(typeof res.collaboration_id).toBe("string");

    expect(await statusOf(id)).toBe("won");
    expect((await events(id)).filter((e) => e.event_type === "deal_won")).toHaveLength(1);
    expect(await collaborations(id)).toHaveLength(1);
  });

  it("deal_won metadata carries the exact type and collaboration id", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);
    const agreed = daysAgo(1);
    const res = await deal(U.free, id, "mark_won", {
      agreedAt: agreed,
      collaborationType: "stay_plus_paid",
    });

    const won = (await events(id)).find((e) => e.event_type === "deal_won")!;
    expect(won.metadata).toEqual({
      collaboration_type: "stay_plus_paid",
      collaboration_id: res.collaboration_id,
    });
    // The domain date the creator supplied, not "now".
    expect(new Date(won.event_at).toISOString()).toBe(agreed);
    expect(new Date(won.event_at).getTime()).toBeLessThan(Date.now());
  });

  it("the collaboration carries creator, hotel, cycle, status, type and agreed date", async () => {
    const id = await negotiating(U.free, HOTELS[2]!.id);
    const agreed = daysAgo(4);
    await deal(U.free, id, "mark_won", { agreedAt: agreed, collaborationType: "paid" });

    const row = (await collaborations(id))[0]!;
    expect(row.creator_id).toBe(await creatorIdFor(U.free));
    expect(row.hotel_id).toBe(HOTELS[2]!.id);
    expect(row.pipeline_item_id).toBe(id);
    expect(row.status).toBe("agreed");
    expect(row.collaboration_type).toBe("paid");
    expect(new Date(row.agreed_at!).toISOString()).toBe(agreed);
  });

  it("collects no financial or scheduling fields in this slice", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);
    await deal(U.free, id, "mark_won", { agreedAt: daysAgo(1), collaborationType: "other" });

    const rows = await adminQuery<{
      private_value_amount: string | null;
      private_value_currency: string | null;
      start_date: string | null;
      end_date: string | null;
      would_work_again: boolean | null;
      terms_matched: string;
    }>("select * from public.collaborations where pipeline_item_id = $1", [id]);
    expect(rows[0]!.private_value_amount).toBeNull();
    expect(rows[0]!.private_value_currency).toBeNull();
    expect(rows[0]!.start_date).toBeNull();
    expect(rows[0]!.end_date).toBeNull();
    expect(rows[0]!.would_work_again).toBeNull();
    expect(rows[0]!.terms_matched).toBe("unknown");
  });

  it("rejects every origin except negotiating", async () => {
    const rep = await replied(U.free, HOTELS[1]!.id);
    expect(
      (await deal(U.free, rep, "mark_won", { agreedAt: daysAgo(1), collaborationType: "stay" }))
        .result,
    ).toBe("invalid_transition");

    const saved = await save(U.free, HOTELS[3]!.id);
    expect(
      (await deal(U.free, saved, "mark_won", { agreedAt: daysAgo(1), collaborationType: "stay" }))
        .result,
    ).toBe("invalid_transition");

    expect(await collaborations()).toHaveLength(0);
  });
});

d("H/I/J/K — won is written exactly once", () => {
  it("a repeat mark_won returns the same collaboration and writes nothing new", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);
    const first = await deal(U.free, id, "mark_won", {
      agreedAt: daysAgo(1),
      collaborationType: "stay",
    });
    const retry = await deal(U.free, id, "mark_won", {
      agreedAt: daysAgo(2),
      collaborationType: "paid",
    });

    expect(retry.result).toBe("already_applied");
    expect(retry.collaboration_id).toBe(first.collaboration_id);
    expect((await events(id)).filter((e) => e.event_type === "deal_won")).toHaveLength(1);

    const rows = await collaborations(id);
    expect(rows).toHaveLength(1);
    // The retry's different type/date did NOT overwrite the record.
    expect(rows[0]!.collaboration_type).toBe("stay");
  });

  it("concurrent mark_won converges on one collaboration and one deal_won", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);
    const a = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    const b = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await a.connect();
    await b.connect();
    try {
      const sql = "select public.progress_pipeline_deal($1,$2,'mark_won',$3,$4) as r";
      const [ra, rb] = await Promise.all([
        a.query(sql, [U.free, id, daysAgo(1), "stay"]),
        b.query(sql, [U.free, id, daysAgo(1), "product"]),
      ]);
      const results = [ra.rows[0].r.result, rb.rows[0].r.result].sort();
      expect(results).toEqual(["already_applied", "applied"]);
      // Both callers learn the same collaboration id.
      expect(ra.rows[0].r.collaboration_id).toBe(rb.rows[0].r.collaboration_id);

      expect(await collaborations(id)).toHaveLength(1);
      expect((await events(id)).filter((e) => e.event_type === "deal_won")).toHaveLength(1);
      expect(await statusOf(id)).toBe("won");
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("the database refuses a second collaboration for the same cycle", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);
    await deal(U.free, id, "mark_won", { agreedAt: daysAgo(1), collaborationType: "stay" });

    // Even a superuser cannot bypass the per-cycle backstop.
    await expect(
      adminQuery(
        `insert into public.collaborations (creator_id, hotel_id, pipeline_item_id, status)
         values ($1,$2,$3,'agreed')`,
        [await creatorIdFor(U.free), HOTELS[0]!.id, id],
      ),
    ).rejects.toThrow(/collaborations_one_per_cycle_uidx|duplicate key/i);

    expect(await collaborations(id)).toHaveLength(1);
  });

  it("a NEW cycle for the same hotel may have its own collaboration", async () => {
    const first = await negotiating(U.free, HOTELS[0]!.id);
    await deal(U.free, first, "mark_won", { agreedAt: daysAgo(9), collaborationType: "stay" });
    // Won cannot be closed in this slice, so close the cycle at the DB level to
    // model a historical relationship that has since ended.
    await adminQuery("update public.pipeline_items set status='closed' where id=$1", [first]);

    const second = await negotiating(U.free, HOTELS[0]!.id);
    expect(second).not.toBe(first);
    const res = await deal(U.free, second, "mark_won", {
      agreedAt: daysAgo(1),
      collaborationType: "paid",
    });
    expect(res.result).toBe("applied");

    // Two cycles, two collaborations — the unit is the cycle, not creator+hotel.
    expect(await collaborations()).toHaveLength(2);
    expect((await collaborations(first))[0]!.collaboration_type).toBe("stay");
    expect((await collaborations(second))[0]!.collaboration_type).toBe("paid");
  });
});

d("L/M/N — ownership and input validation", () => {
  it("creator A cannot progress creator B's relationship", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);

    expect((await deal(U.other, id, "start_negotiation")).result).toBe("pipeline_item_not_found");
    expect(
      (await deal(U.other, id, "mark_won", { agreedAt: daysAgo(1), collaborationType: "stay" }))
        .result,
    ).toBe("pipeline_item_not_found");

    expect(await statusOf(id)).toBe("negotiating");
    expect(await collaborations()).toHaveLength(0);
  });

  it("an unknown user has no creator profile", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);
    expect(
      (await deal("b1000000-0000-0000-0000-0000000000ff", id, "start_negotiation")).result,
    ).toBe("creator_profile_missing");
  });

  it("rejects a future agreed date", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);
    const tomorrow = new Date(Date.now() + DAY).toISOString();
    expect(
      (await deal(U.free, id, "mark_won", { agreedAt: tomorrow, collaborationType: "stay" }))
        .result,
    ).toBe("invalid_event_time");

    expect(await statusOf(id)).toBe("negotiating");
    expect(await collaborations()).toHaveLength(0);
  });

  it("accepts an agreed date inside the clock-skew tolerance", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);
    const nearlyNow = new Date(Date.now() + 60_000).toISOString();
    expect(
      (await deal(U.free, id, "mark_won", { agreedAt: nearlyNow, collaborationType: "stay" }))
        .result,
    ).toBe("applied");
  });

  it("rejects a missing or unknown collaboration type", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);
    for (const type of [null, "crypto", "", "STAY"]) {
      expect(
        (await deal(U.free, id, "mark_won", { agreedAt: daysAgo(1), collaborationType: type }))
          .result,
      ).toBe("invalid_input");
    }
    expect((await deal(U.free, id, "mark_won", { collaborationType: "stay" })).result).toBe(
      "invalid_input",
    );

    expect(await statusOf(id)).toBe("negotiating");
    expect(await collaborations()).toHaveLength(0);
  });
});

d("O/P/Q — closing a negotiation", () => {
  it("moves negotiating → closed with deal_lost and the exact reason", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);
    const res = await transition(U.free, id, "close", { closeReason: "rejected" });

    expect(res.result).toBe("applied");
    expect(res.event_type).toBe("deal_lost");
    expect(await statusOf(id)).toBe("closed");

    const lost = (await events(id)).filter((e) => e.event_type === "deal_lost");
    expect(lost).toHaveLength(1);
    expect(lost[0]!.metadata).toEqual({ reason: "rejected" });
    // Outreach clearly occurred, so this is a loss, not abandonment (D043).
    expect((await events(id)).map((e) => e.event_type)).not.toContain("creator_closed_pipeline");
  });

  it("a repeat close writes no second loss event", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);
    await transition(U.free, id, "close", { closeReason: "no_reply" });
    const retry = await transition(U.free, id, "close", { closeReason: "timing" });

    expect(retry.result).toBe("already_applied");
    expect((await events(id)).filter((e) => e.event_type === "deal_lost")).toHaveLength(1);
  });

  it("closing a negotiation frees the engaged slot", async () => {
    const ids: string[] = [];
    for (let i = 0; i < LIMIT; i++) {
      const id = await save(U.free, HOTELS[i % HOTELS.length]!.id);
      if (i < HOTELS.length) {
        await transition(U.free, id, "plan");
        ids.push(id);
      }
    }
    // Drive one to negotiating, then close it.
    const negotiated = ids[0]!;
    await transition(U.free, negotiated, "mark_pitched", { eventAt: daysAgo(4), channel: "email" });
    await transition(U.free, negotiated, "mark_replied", {
      eventAt: daysAgo(2),
      sentiment: "positive",
    });
    await deal(U.free, negotiated, "start_negotiation");

    const engagedBefore = await adminQuery<{ n: string }>(
      `select count(*)::text n from public.pipeline_items
        where creator_id = $1 and status in ('planned','pitched','replied','follow_up','negotiating','won')`,
      [await creatorIdFor(U.free)],
    );
    await transition(U.free, negotiated, "close", { closeReason: "not_a_fit" });
    const engagedAfter = await adminQuery<{ n: string }>(
      `select count(*)::text n from public.pipeline_items
        where creator_id = $1 and status in ('planned','pitched','replied','follow_up','negotiating','won')`,
      [await creatorIdFor(U.free)],
    );
    expect(Number(engagedAfter[0]!.n)).toBe(Number(engagedBefore[0]!.n) - 1);
  });

  it("a WON cycle cannot be closed in this slice", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);
    await deal(U.free, id, "mark_won", { agreedAt: daysAgo(1), collaborationType: "stay" });

    const res = await transition(U.free, id, "close", { closeReason: "other" });
    expect(res.result).toBe("invalid_transition");
    expect(res.status).toBe("won");
    expect(await statusOf(id)).toBe("won");
    expect((await events(id)).map((e) => e.event_type)).not.toContain("deal_lost");
    expect(await collaborations(id)).toHaveLength(1);
  });
});

d("R — privilege surface", () => {
  it("client roles cannot EXECUTE the deal RPC", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);
    for (const role of ["anon", "authenticated"] as const) {
      const res = await queryAs(
        { role, sub: role === "authenticated" ? U.free : null },
        "select public.progress_pipeline_deal($1,$2,'start_negotiation',null,null)",
        [U.free, id],
      );
      expect(res.error).not.toBeNull();
      expect(res.error!.message).toMatch(/permission denied/i);
    }
  });

  it("the ACL grants service_role only, and the function is NOT security definer", async () => {
    const rows = await adminQuery<{
      anon: boolean;
      authed: boolean;
      svc: boolean;
      public_exec: boolean;
      secdef: boolean;
      cfg: string | null;
    }>(
      `select
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed,
         has_function_privilege('service_role', p.oid, 'EXECUTE') as svc,
         aclcontains(coalesce(p.proacl, acldefault('f', p.proowner)),
                     makeaclitem(0::oid, p.proowner, 'EXECUTE', false)) as public_exec,
         p.prosecdef as secdef,
         array_to_string(p.proconfig, ',') as cfg
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname='progress_pipeline_deal'`,
    );
    expect(rows[0]!.anon).toBe(false);
    expect(rows[0]!.authed).toBe(false);
    expect(rows[0]!.public_exec).toBe(false);
    expect(rows[0]!.svc).toBe(true);
    expect(rows[0]!.secdef).toBe(false);
    expect(rows[0]!.cfg).toContain("search_path=public, pg_temp");
  });

  it("the replaced transition function keeps its Sprint 2C privilege surface", async () => {
    const rows = await adminQuery<{ authed: boolean; svc: boolean; secdef: boolean }>(
      `select
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed,
         has_function_privilege('service_role', p.oid, 'EXECUTE') as svc,
         p.prosecdef as secdef
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname='transition_pipeline_item'`,
    );
    expect(rows[0]).toEqual({ authed: false, svc: true, secdef: false });
  });
});

d("S/T/U/V/W — collaboration write hardening (0021)", () => {
  it("an authenticated creator cannot INSERT a collaboration", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);
    const res = await queryAs(
      { role: "authenticated", sub: U.free },
      `insert into public.collaborations (creator_id, hotel_id, pipeline_item_id, status, collaboration_type)
       values ($1,$2,$3,'agreed','paid') returning id`,
      [await creatorIdFor(U.free), HOTELS[0]!.id, id],
    );
    expect(res.error).not.toBeNull();
    expect(res.error!.message).toMatch(/permission denied/i);
    expect(await collaborations()).toHaveLength(0);
  });

  it("an authenticated creator cannot UPDATE their own collaboration", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);
    await deal(U.free, id, "mark_won", { agreedAt: daysAgo(1), collaborationType: "stay" });

    const res = await queryAs(
      { role: "authenticated", sub: U.free },
      "update public.collaborations set collaboration_type = 'paid', status = 'completed' returning id",
    );
    expect(res.error).not.toBeNull();
    expect(res.error!.message).toMatch(/permission denied/i);

    const row = (await collaborations(id))[0]!;
    expect(row.collaboration_type).toBe("stay");
    expect(row.status).toBe("agreed");
  });

  it("an authenticated creator cannot DELETE a collaboration", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);
    await deal(U.free, id, "mark_won", { agreedAt: daysAgo(1), collaborationType: "stay" });

    const res = await queryAs(
      { role: "authenticated", sub: U.free },
      "delete from public.collaborations returning id",
    );
    expect(res.error).not.toBeNull();
    expect(res.error!.message).toMatch(/permission denied/i);
    expect(await collaborations(id)).toHaveLength(1);
  });

  it("an authenticated creator CAN still read their own collaboration", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);
    await deal(U.free, id, "mark_won", { agreedAt: daysAgo(1), collaborationType: "product" });

    const res = await queryAs<{ id: string; collaboration_type: string }>(
      { role: "authenticated", sub: U.free },
      "select id, collaboration_type from public.collaborations",
    );
    expect(res.error).toBeNull();
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.collaboration_type).toBe("product");
  });

  it("creator A cannot read creator B's collaboration", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);
    await deal(U.free, id, "mark_won", { agreedAt: daysAgo(1), collaborationType: "stay" });

    const res = await queryAs(
      { role: "authenticated", sub: U.other },
      "select id from public.collaborations",
    );
    expect(res.rows).toHaveLength(0);
  });

  it("the table privileges and the 0012 ownership policy are exactly as intended", async () => {
    const grants = await adminQuery<Record<string, boolean>>(
      `select
         has_table_privilege('authenticated','public.collaborations','SELECT') as sel,
         has_table_privilege('authenticated','public.collaborations','INSERT') as ins,
         has_table_privilege('authenticated','public.collaborations','UPDATE') as upd,
         has_table_privilege('authenticated','public.collaborations','DELETE') as del,
         has_table_privilege('service_role','public.collaborations','INSERT') as svc_ins`,
    );
    expect(grants[0]).toEqual({ sel: true, ins: false, upd: false, del: false, svc_ins: true });

    const policies = await adminQuery<{ policyname: string }>(
      "select policyname from pg_policies where schemaname='public' and tablename='collaborations'",
    );
    expect(policies.map((p) => p.policyname)).toEqual(["collaborations_all"]);
  });
});

d("X — the deal path does not touch intelligence", () => {
  it("negotiation_started and deal_won write no aggregate rows", async () => {
    const id = await negotiating(U.free, HOTELS[0]!.id);
    await deal(U.free, id, "mark_won", {
      agreedAt: daysAgo(1),
      collaborationType: "stay_plus_paid",
    });

    const types = (await events(id)).map((e) => e.event_type);
    expect(types).toContain("negotiation_started");
    expect(types).toContain("deal_won");

    for (const table of ["hotel_intelligence", "destination_intelligence"]) {
      const rows = await adminQuery<{ n: string }>(`select count(*)::text n from public.${table}`);
      expect(Number(rows[0]!.n)).toBe(0);
    }
  });
});

d("Y — Sprint 2C transitions still behave after 0021", () => {
  it("the full outreach path is unchanged", async () => {
    const id = await save(U.free, HOTELS[0]!.id);
    expect((await transition(U.free, id, "plan")).result).toBe("applied");
    expect(
      (await transition(U.free, id, "mark_pitched", { eventAt: daysAgo(5), channel: "email" }))
        .result,
    ).toBe("applied");
    expect(
      (await transition(U.free, id, "mark_followup_sent", { eventAt: daysAgo(4) })).result,
    ).toBe("applied");
    expect(
      (await transition(U.free, id, "mark_replied", { eventAt: daysAgo(3), sentiment: "positive" }))
        .result,
    ).toBe("applied");

    expect((await events(id)).map((e) => e.event_type)).toEqual([
      "hotel_saved",
      "pitch_sent",
      "followup_sent",
      "reply_received",
      "positive_reply",
    ]);
  });

  it("close from a pre-negotiation status still classifies under D043", async () => {
    const abandoned = await save(U.free, HOTELS[1]!.id);
    expect(
      (await transition(U.free, abandoned, "close", { closeReason: "timing" })).event_type,
    ).toBe("creator_closed_pipeline");

    const lost = await save(U.free, HOTELS[2]!.id);
    await transition(U.free, lost, "mark_pitched", { eventAt: daysAgo(2), channel: "email" });
    expect((await transition(U.free, lost, "close", { closeReason: "no_reply" })).event_type).toBe(
      "deal_lost",
    );
  });

  it("temporal and idempotency guards still hold", async () => {
    const id = await save(U.free, HOTELS[3]!.id);
    const tomorrow = new Date(Date.now() + DAY).toISOString();
    expect(
      (await transition(U.free, id, "mark_pitched", { eventAt: tomorrow, channel: "email" }))
        .result,
    ).toBe("invalid_event_time");

    await transition(U.free, id, "mark_pitched", { eventAt: daysAgo(2), channel: "email" });
    expect(
      (await transition(U.free, id, "mark_pitched", { eventAt: daysAgo(1), channel: "email" }))
        .result,
    ).toBe("already_applied");
    expect((await events(id)).filter((e) => e.event_type === "pitch_sent")).toHaveLength(1);
  });
});
