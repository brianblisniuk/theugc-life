/**
 * Collaboration lifecycle (migration 0023, EVENTS.md §3, D043/D045).
 *
 *   won + agreed → scheduled? → active → completed | cancelled → cycle closed
 *
 * Two things matter most here. First, a won cycle must eventually END, or a
 * creator is billed a Free slot forever and can never work with that hotel
 * again. Second, a cancelled collaboration must never be rewritten into a lost
 * deal: `deal_won` happened, and erasing it to express a later cancellation
 * would corrupt the funnel and destroy a distinction Experience Intelligence
 * will need.
 */
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";
import { FREE_LIMITS } from "@/lib/config";

const d = describe.skipIf(!hasTestDb);
const LIMIT = FREE_LIMITS.activePipelineItems;

const U = {
  free: "d1000000-0000-0000-0000-000000000001",
  other: "d1000000-0000-0000-0000-000000000002",
} as const;

const DEST = "d2000000-0000-0000-0000-000000000001";
const HOTELS = Array.from({ length: 10 }, (_, i) => ({
  id: `d3000000-0000-0000-0000-0000000000${(i + 16).toString(16)}`,
  name: `Zc Hotel ${i + 1}`,
}));

const DAY = 86_400_000;
function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY).toISOString();
}
function dayOf(iso: string): string {
  return iso.slice(0, 10);
}
function inDays(n: number): string {
  return dayOf(new Date(Date.now() + n * DAY).toISOString());
}

/** `pg` hands back DATE columns as Date objects; compare calendar days. */
function asDay(value: string | Date | null): string | null {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  return [
    value.getFullYear(),
    String(value.getMonth() + 1).padStart(2, "0"),
    String(value.getDate()).padStart(2, "0"),
  ].join("-");
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

interface LifecycleArgs {
  eventAt?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  termsMatched?: string | null;
  wouldWorkAgain?: boolean | null;
  cancelReason?: string | null;
}

async function lifecycle(
  userId: string,
  itemId: string,
  action: string,
  args: LifecycleArgs = {},
): Promise<Record<string, unknown>> {
  const rows = await adminQuery<{ r: Record<string, unknown> }>(
    "select public.progress_collaboration($1,$2,$3,$4,$5,$6,$7,$8,$9) as r",
    [
      userId,
      itemId,
      action,
      args.eventAt ?? null,
      args.startDate ?? null,
      args.endDate ?? null,
      args.termsMatched ?? null,
      args.wouldWorkAgain ?? null,
      args.cancelReason ?? null,
    ],
  );
  return rows[0]!.r;
}

async function events(itemId: string) {
  return adminQuery<{ event_type: string; metadata: Record<string, unknown>; event_at: Date }>(
    "select event_type, metadata, event_at from public.outreach_events where pipeline_item_id = $1 order by created_at",
    [itemId],
  );
}

interface CollabRow {
  id: string;
  status: string;
  collaboration_type: string | null;
  start_date: string | Date | null;
  end_date: string | Date | null;
  terms_matched: string;
  would_work_again: boolean | null;
  private_value_amount: string | null;
  private_value_currency: string | null;
}

async function collab(itemId: string): Promise<CollabRow | null> {
  const rows = await adminQuery<CollabRow>(
    "select * from public.collaborations where pipeline_item_id = $1",
    [itemId],
  );
  return rows[0] ?? null;
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

async function engagedCount(userId: string): Promise<number> {
  const rows = await adminQuery<{ n: string }>(
    `select count(*)::text n from public.pipeline_items
      where creator_id = $1
        and status in ('planned','pitched','replied','follow_up','negotiating','won')`,
    [await creatorIdFor(userId)],
  );
  return Number(rows[0]!.n);
}

/** Drive a fresh cycle all the way to `won` + an `agreed` collaboration. */
async function won(userId: string, hotelId: string, agreedDaysAgo = 10): Promise<string> {
  const id = await save(userId, hotelId);
  await transition(userId, id, "mark_pitched", { eventAt: daysAgo(30), channel: "email" });
  await transition(userId, id, "mark_replied", { eventAt: daysAgo(25), sentiment: "positive" });
  await deal(userId, id, "start_negotiation");
  const res = await deal(userId, id, "mark_won", {
    agreedAt: daysAgo(agreedDaysAgo),
    collaborationType: "stay",
  });
  expect(res.result).toBe("applied");
  return id;
}

/** …and on to an `active` collaboration. */
async function active(userId: string, hotelId: string): Promise<string> {
  const id = await won(userId, hotelId);
  const res = await lifecycle(userId, id, "start", {
    eventAt: daysAgo(8),
    startDate: dayOf(daysAgo(8)),
  });
  expect(res.result).toBe("applied");
  return id;
}

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();

  for (const id of Object.values(U)) {
    await adminQuery("insert into auth.users (id, email) values ($1,$2)", [id, `${id}@t.local`]);
  }
  await adminQuery(
    "insert into public.destinations (id,name,slug,type,country_code) values ($1,'Zc Dest','zc-dest','city','AE')",
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
  await adminQuery("delete from public.hotel_intelligence");
  await adminQuery("delete from public.collaborations");
  await adminQuery("delete from public.outreach_events");
  await adminQuery("delete from public.pipeline_items");
});

/* ------------------------------------------------------------------ */

d("A/B — schedule", () => {
  it("moves agreed → scheduled, stores the dates, and emits no event", async () => {
    const id = await won(U.free, HOTELS[0]!.id);
    const before = await events(id);

    const res = await lifecycle(U.free, id, "schedule", {
      startDate: inDays(5),
      endDate: inDays(9),
    });
    expect(res.result).toBe("applied");
    expect(res.collaboration_status).toBe("scheduled");

    const row = (await collab(id))!;
    expect(row.status).toBe("scheduled");
    expect(asDay(row.start_date)).toBe(inDays(5));
    expect(asDay(row.end_date)).toBe(inDays(9));

    // Planning is not a creator↔hotel interaction.
    expect(await events(id)).toHaveLength(before.length);
    expect(await statusOf(id)).toBe("won");
  });

  it("accepts future dates, because a plan is not an event", async () => {
    const id = await won(U.free, HOTELS[1]!.id);
    expect((await lifecycle(U.free, id, "schedule", { startDate: inDays(200) })).result).toBe(
      "applied",
    );
  });

  it("rejects an end date before the start, changing nothing", async () => {
    const id = await won(U.free, HOTELS[2]!.id);
    const res = await lifecycle(U.free, id, "schedule", {
      startDate: inDays(9),
      endDate: inDays(2),
    });
    expect(res.result).toBe("invalid_input");

    const row = (await collab(id))!;
    expect(row.status).toBe("agreed");
    expect(asDay(row.start_date)).toBeNull();
    expect(asDay(row.end_date)).toBeNull();
  });

  it("requires a start date", async () => {
    const id = await won(U.free, HOTELS[3]!.id);
    expect((await lifecycle(U.free, id, "schedule", {})).result).toBe("invalid_input");
  });

  it("a repeat schedule preserves the ORIGINAL dates", async () => {
    const id = await won(U.free, HOTELS[0]!.id);
    await lifecycle(U.free, id, "schedule", { startDate: inDays(5), endDate: inDays(9) });

    const retry = await lifecycle(U.free, id, "schedule", {
      startDate: inDays(50),
      endDate: inDays(60),
    });
    expect(retry.result).toBe("already_applied");

    const row = (await collab(id))!;
    expect(asDay(row.start_date)).toBe(inDays(5));
    expect(asDay(row.end_date)).toBe(inDays(9));
  });
});

d("C/D/E/F — start", () => {
  it("moves agreed → active with one collaboration_started, cycle still won", async () => {
    const id = await won(U.free, HOTELS[0]!.id);
    const when = daysAgo(3);

    const res = await lifecycle(U.free, id, "start", { eventAt: when, startDate: dayOf(when) });
    expect(res.result).toBe("applied");
    expect(res.collaboration_status).toBe("active");

    const row = (await collab(id))!;
    expect(row.status).toBe("active");
    expect(asDay(row.start_date)).toBe(dayOf(when));

    const started = (await events(id)).filter((e) => e.event_type === "collaboration_started");
    expect(started).toHaveLength(1);
    expect(started[0]!.metadata).toEqual({ collaboration_id: row.id });
    // Winning is still true; the cycle is not finished.
    expect(await statusOf(id)).toBe("won");
  });

  it("moves scheduled → active and preserves the scheduled end date", async () => {
    const id = await won(U.free, HOTELS[1]!.id);
    await lifecycle(U.free, id, "schedule", { startDate: inDays(1), endDate: inDays(20) });

    const when = daysAgo(1);
    expect(
      (await lifecycle(U.free, id, "start", { eventAt: when, startDate: dayOf(when) })).result,
    ).toBe("applied");

    const row = (await collab(id))!;
    expect(row.status).toBe("active");
    expect(asDay(row.start_date)).toBe(dayOf(when));
    expect(asDay(row.end_date)).toBe(inDays(20));
  });

  it("rejects a future start and a start after the scheduled end", async () => {
    const id = await won(U.free, HOTELS[2]!.id);
    const tomorrow = new Date(Date.now() + DAY).toISOString();
    expect(
      (await lifecycle(U.free, id, "start", { eventAt: tomorrow, startDate: dayOf(tomorrow) }))
        .result,
    ).toBe("invalid_event_time");

    await lifecycle(U.free, id, "schedule", { startDate: inDays(1), endDate: inDays(2) });
    expect(
      (await lifecycle(U.free, id, "start", { eventAt: daysAgo(1), startDate: inDays(30) })).result,
    ).toBe("invalid_input");
    expect((await collab(id))!.status).toBe("scheduled");
  });

  it("a repeat start is already_applied and preserves the original date", async () => {
    const id = await active(U.free, HOTELS[0]!.id);
    const original = asDay((await collab(id))!.start_date);

    const retry = await lifecycle(U.free, id, "start", {
      eventAt: daysAgo(1),
      startDate: dayOf(daysAgo(1)),
    });
    expect(retry.result).toBe("already_applied");
    expect(asDay((await collab(id))!.start_date)).toBe(original);
    expect((await events(id)).filter((e) => e.event_type === "collaboration_started")).toHaveLength(
      1,
    );
  });

  it("concurrent starts produce exactly one event", async () => {
    const id = await won(U.free, HOTELS[0]!.id);
    const a = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    const b = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await a.connect();
    await b.connect();
    try {
      const sql =
        "select public.progress_collaboration($1,$2,'start',$3,$4,null,null,null,null) as r";
      const params = [U.free, id, daysAgo(2), dayOf(daysAgo(2))];
      const [ra, rb] = await Promise.all([a.query(sql, params), b.query(sql, params)]);
      expect([ra.rows[0].r.result, rb.rows[0].r.result].sort()).toEqual([
        "already_applied",
        "applied",
      ]);
      expect(
        (await events(id)).filter((e) => e.event_type === "collaboration_started"),
      ).toHaveLength(1);
    } finally {
      await a.end();
      await b.end();
    }
  });
});

d("G/H/I/J/K/L — complete", () => {
  it("completes the collaboration AND closes the cycle", async () => {
    const id = await active(U.free, HOTELS[0]!.id);
    const when = daysAgo(1);

    const res = await lifecycle(U.free, id, "complete", {
      eventAt: when,
      endDate: dayOf(when),
      termsMatched: "partially",
      wouldWorkAgain: true,
    });
    expect(res.result).toBe("applied");
    expect(res.collaboration_status).toBe("completed");
    expect(res.pipeline_status).toBe("closed");

    const row = (await collab(id))!;
    expect(row.status).toBe("completed");
    expect(asDay(row.end_date)).toBe(dayOf(when));
    expect(row.terms_matched).toBe("partially");
    expect(row.would_work_again).toBe(true);

    expect(await statusOf(id)).toBe("closed");
    expect(
      (await events(id)).filter((e) => e.event_type === "collaboration_completed"),
    ).toHaveLength(1);
  });

  it("records the experience answers in the event metadata", async () => {
    const id = await active(U.free, HOTELS[1]!.id);
    const when = daysAgo(1);
    await lifecycle(U.free, id, "complete", {
      eventAt: when,
      endDate: dayOf(when),
      termsMatched: "yes",
      wouldWorkAgain: null,
    });

    const row = (await collab(id))!;
    const done = (await events(id)).find((e) => e.event_type === "collaboration_completed")!;
    expect(done.metadata).toEqual({
      collaboration_id: row.id,
      terms_matched: "yes",
      would_work_again: null,
    });
    // "Not sure" is NULL, never false — we do not invent a negative judgement.
    expect(row.would_work_again).toBeNull();
  });

  it("a repeat completion preserves the original answers and date", async () => {
    const id = await active(U.free, HOTELS[0]!.id);
    const when = daysAgo(2);
    await lifecycle(U.free, id, "complete", {
      eventAt: when,
      endDate: dayOf(when),
      termsMatched: "yes",
      wouldWorkAgain: true,
    });

    const retry = await lifecycle(U.free, id, "complete", {
      eventAt: daysAgo(1),
      endDate: dayOf(daysAgo(1)),
      termsMatched: "no",
      wouldWorkAgain: false,
    });
    expect(retry.result).toBe("already_applied");

    const row = (await collab(id))!;
    expect(asDay(row.end_date)).toBe(dayOf(when));
    expect(row.terms_matched).toBe("yes");
    expect(row.would_work_again).toBe(true);
    expect(
      (await events(id)).filter((e) => e.event_type === "collaboration_completed"),
    ).toHaveLength(1);
  });

  it("concurrent completions produce exactly one event and one closure", async () => {
    const id = await active(U.free, HOTELS[0]!.id);
    const a = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    const b = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await a.connect();
    await b.connect();
    try {
      const sql =
        "select public.progress_collaboration($1,$2,'complete',$3,null,$4,'yes',true,null) as r";
      const params = [U.free, id, daysAgo(1), dayOf(daysAgo(1))];
      const [ra, rb] = await Promise.all([a.query(sql, params), b.query(sql, params)]);
      expect([ra.rows[0].r.result, rb.rows[0].r.result].sort()).toEqual([
        "already_applied",
        "applied",
      ]);
      expect(
        (await events(id)).filter((e) => e.event_type === "collaboration_completed"),
      ).toHaveLength(1);
      expect(await statusOf(id)).toBe("closed");
    } finally {
      await a.end();
      await b.end();
    }
  });

  it("rejects an end date before the start, and a completion before it started", async () => {
    const id = await active(U.free, HOTELS[0]!.id);
    const start = asDay((await collab(id))!.start_date);

    expect(
      (
        await lifecycle(U.free, id, "complete", {
          eventAt: daysAgo(1),
          endDate: dayOf(daysAgo(60)),
          termsMatched: "yes",
        })
      ).result,
    ).toBe("invalid_input");

    expect(
      (
        await lifecycle(U.free, id, "complete", {
          eventAt: daysAgo(30),
          endDate: dayOf(daysAgo(1)),
          termsMatched: "yes",
        })
      ).result,
    ).toBe("invalid_event_time");

    // …and a future completion.
    const tomorrow = new Date(Date.now() + DAY).toISOString();
    expect(
      (
        await lifecycle(U.free, id, "complete", {
          eventAt: tomorrow,
          endDate: dayOf(tomorrow),
          termsMatched: "yes",
        })
      ).result,
    ).toBe("invalid_event_time");

    const row = (await collab(id))!;
    expect(row.status).toBe("active");
    expect(asDay(row.start_date)).toBe(start);
    expect(await statusOf(id)).toBe("won");
  });

  it("requires a known terms_matched value", async () => {
    const id = await active(U.free, HOTELS[0]!.id);
    for (const terms of [null, "sortof", "YES"]) {
      expect(
        (
          await lifecycle(U.free, id, "complete", {
            eventAt: daysAgo(1),
            endDate: dayOf(daysAgo(1)),
            termsMatched: terms,
          })
        ).result,
      ).toBe("invalid_input");
    }
    expect((await collab(id))!.status).toBe("active");
  });

  it("cannot complete a collaboration that never started", async () => {
    const id = await won(U.free, HOTELS[0]!.id);
    expect(
      (
        await lifecycle(U.free, id, "complete", {
          eventAt: daysAgo(1),
          endDate: dayOf(daysAgo(1)),
          termsMatched: "yes",
        })
      ).result,
    ).toBe("invalid_transition");
    expect(await statusOf(id)).toBe("won");
  });
});

d("M/N/O/P/Q/R — cancel", () => {
  it("cancels from agreed, closes the cycle, and NEVER emits deal_lost", async () => {
    const id = await won(U.free, HOTELS[0]!.id);
    const when = daysAgo(1);

    const res = await lifecycle(U.free, id, "cancel", {
      eventAt: when,
      endDate: dayOf(when),
      cancelReason: "hotel_cancelled",
    });
    expect(res.result).toBe("applied");
    expect(res.collaboration_status).toBe("cancelled");

    expect((await collab(id))!.status).toBe("cancelled");
    expect(await statusOf(id)).toBe("closed");

    const types = (await events(id)).map((e) => e.event_type);
    // The deal was won. It stays won.
    expect(types).toContain("deal_won");
    expect(types).not.toContain("deal_lost");
    expect(types.filter((t) => t === "creator_closed_pipeline")).toHaveLength(1);
  });

  it("cancelling before it started leaves end_date alone", async () => {
    const id = await won(U.free, HOTELS[1]!.id);
    await lifecycle(U.free, id, "cancel", {
      eventAt: daysAgo(1),
      endDate: dayOf(daysAgo(1)),
      cancelReason: "mutual",
    });
    // There was no period to end.
    expect(asDay((await collab(id))!.end_date)).toBeNull();
  });

  it("cancels from scheduled, preserving the planned dates", async () => {
    const id = await won(U.free, HOTELS[2]!.id);
    await lifecycle(U.free, id, "schedule", { startDate: inDays(3), endDate: inDays(8) });

    expect(
      (
        await lifecycle(U.free, id, "cancel", {
          eventAt: daysAgo(1),
          endDate: dayOf(daysAgo(1)),
          cancelReason: "creator_cancelled",
        })
      ).result,
    ).toBe("applied");

    const row = (await collab(id))!;
    expect(row.status).toBe("cancelled");
    expect(asDay(row.start_date)).toBe(inDays(3));
    expect(asDay(row.end_date)).toBe(inDays(8));
    expect(await statusOf(id)).toBe("closed");
  });

  it("cancelling an ACTIVE collaboration closes its date range", async () => {
    const id = await active(U.free, HOTELS[0]!.id);
    const when = daysAgo(1);

    await lifecycle(U.free, id, "cancel", {
      eventAt: when,
      endDate: dayOf(when),
      cancelReason: "other",
    });

    const row = (await collab(id))!;
    expect(row.status).toBe("cancelled");
    expect(asDay(row.end_date)).toBe(dayOf(when));
    expect(await statusOf(id)).toBe("closed");
  });

  it("carries exact cancellation metadata", async () => {
    const id = await active(U.free, HOTELS[0]!.id);
    const row = (await collab(id))!;

    await lifecycle(U.free, id, "cancel", {
      eventAt: daysAgo(1),
      endDate: dayOf(daysAgo(1)),
      cancelReason: "hotel_cancelled",
    });

    const closed = (await events(id)).filter((e) => e.event_type === "creator_closed_pipeline");
    expect(closed).toHaveLength(1);
    expect(closed[0]!.metadata).toEqual({
      reason: "collaboration_cancelled",
      cancellation_reason: "hotel_cancelled",
      collaboration_id: row.id,
    });
  });

  it("rejects an unknown reason, a missing reason and a future date", async () => {
    const id = await won(U.free, HOTELS[0]!.id);
    for (const reason of [null, "bored", "CREATOR_CANCELLED"]) {
      expect(
        (await lifecycle(U.free, id, "cancel", { eventAt: daysAgo(1), cancelReason: reason }))
          .result,
      ).toBe("invalid_input");
    }
    const tomorrow = new Date(Date.now() + DAY).toISOString();
    expect(
      (await lifecycle(U.free, id, "cancel", { eventAt: tomorrow, cancelReason: "mutual" })).result,
    ).toBe("invalid_event_time");

    expect((await collab(id))!.status).toBe("agreed");
    expect(await statusOf(id)).toBe("won");
  });

  it("rejects a cancellation dated before an active collaboration started", async () => {
    const id = await active(U.free, HOTELS[0]!.id);
    expect(
      (await lifecycle(U.free, id, "cancel", { eventAt: daysAgo(40), cancelReason: "mutual" }))
        .result,
    ).toBe("invalid_event_time");
    expect((await collab(id))!.status).toBe("active");
  });

  it("a repeat cancellation preserves the original reason and date", async () => {
    const id = await active(U.free, HOTELS[0]!.id);
    const when = daysAgo(2);
    await lifecycle(U.free, id, "cancel", {
      eventAt: when,
      endDate: dayOf(when),
      cancelReason: "mutual",
    });

    const retry = await lifecycle(U.free, id, "cancel", {
      eventAt: daysAgo(1),
      endDate: dayOf(daysAgo(1)),
      cancelReason: "other",
    });
    expect(retry.result).toBe("already_applied");

    const closed = (await events(id)).filter((e) => e.event_type === "creator_closed_pipeline");
    expect(closed).toHaveLength(1);
    expect(closed[0]!.metadata.cancellation_reason).toBe("mutual");
    expect(asDay((await collab(id))!.end_date)).toBe(dayOf(when));
  });

  it("concurrent cancellations produce exactly one event", async () => {
    const id = await active(U.free, HOTELS[0]!.id);
    const a = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    const b = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await a.connect();
    await b.connect();
    try {
      const sql =
        "select public.progress_collaboration($1,$2,'cancel',$3,null,$4,null,null,'mutual') as r";
      const params = [U.free, id, daysAgo(1), dayOf(daysAgo(1))];
      const [ra, rb] = await Promise.all([a.query(sql, params), b.query(sql, params)]);
      expect([ra.rows[0].r.result, rb.rows[0].r.result].sort()).toEqual([
        "already_applied",
        "applied",
      ]);
      expect(
        (await events(id)).filter((e) => e.event_type === "creator_closed_pipeline"),
      ).toHaveLength(1);
    } finally {
      await a.end();
      await b.end();
    }
  });
});

d("F1 — state and lifecycle history must agree", () => {
  /** Snapshot everything a corrupted lifecycle attempt must leave untouched. */
  async function snapshot(itemId: string) {
    return {
      collaboration: await collab(itemId),
      pipeline: await statusOf(itemId),
      events: (await events(itemId)).map((e) => e.event_type),
    };
  }

  async function dropStartEvent(itemId: string) {
    await adminQuery(
      "delete from public.outreach_events where pipeline_item_id = $1 and event_type = 'collaboration_started'",
      [itemId],
    );
  }

  /** Duplicate an existing event of this type, as a botched retry would. */
  async function duplicateEvent(itemId: string, type: string) {
    await adminQuery(
      `insert into public.outreach_events
         (creator_id, hotel_id, pipeline_item_id, event_type, event_at, metadata, source)
       select creator_id, hotel_id, pipeline_item_id, event_type, event_at, metadata, source
         from public.outreach_events
        where pipeline_item_id = $1 and event_type = $2
        limit 1`,
      [itemId, type],
    );
  }

  it("active with NO collaboration_started refuses to complete", async () => {
    const id = await active(U.free, HOTELS[0]!.id);
    await dropStartEvent(id);
    const before = await snapshot(id);

    const res = await lifecycle(U.free, id, "complete", {
      eventAt: daysAgo(1),
      endDate: dayOf(daysAgo(1)),
      termsMatched: "yes",
      wouldWorkAgain: true,
    });

    // Without a start there is nothing to compare against, so the chronology
    // guard would have been skipped and a completion invented.
    expect(res.result).toBe("integrity_error");
    expect(await snapshot(id)).toEqual(before);
    expect((await snapshot(id)).events).not.toContain("collaboration_completed");
    expect(await statusOf(id)).toBe("won");
  });

  it("active with NO collaboration_started refuses to cancel", async () => {
    const id = await active(U.free, HOTELS[1]!.id);
    await dropStartEvent(id);
    const before = await snapshot(id);

    const res = await lifecycle(U.free, id, "cancel", {
      eventAt: daysAgo(1),
      endDate: dayOf(daysAgo(1)),
      cancelReason: "mutual",
    });
    expect(res.result).toBe("integrity_error");
    expect(await snapshot(id)).toEqual(before);
    expect(await statusOf(id)).toBe("won");
  });

  it("active with TWO collaboration_started events refuses to complete or cancel", async () => {
    for (const [i, action] of ["complete", "cancel"].entries()) {
      const id = await active(U.free, HOTELS[i]!.id);
      await duplicateEvent(id, "collaboration_started");
      const before = await snapshot(id);

      const res = await lifecycle(U.free, id, action, {
        eventAt: daysAgo(1),
        endDate: dayOf(daysAgo(1)),
        termsMatched: "yes",
        cancelReason: "mutual",
      });
      expect(res.result).toBe("integrity_error");
      expect(await snapshot(id)).toEqual(before);
    }
  });

  it("active with a duplicate start refuses the start retry too", async () => {
    const id = await active(U.free, HOTELS[0]!.id);
    await duplicateEvent(id, "collaboration_started");

    const res = await lifecycle(U.free, id, "start", {
      eventAt: daysAgo(1),
      startDate: dayOf(daysAgo(1)),
    });
    // Not `already_applied`: we cannot say which start is the real one.
    expect(res.result).toBe("integrity_error");
  });

  it("scheduled with a stray collaboration_started refuses start and cancel", async () => {
    for (const [i, action] of ["start", "cancel"].entries()) {
      const id = await won(U.free, HOTELS[i]!.id);
      await lifecycle(U.free, id, "schedule", { startDate: inDays(2) });
      // A start event with the collaboration still `scheduled` is impossible.
      await adminQuery(
        `insert into public.outreach_events
           (creator_id, hotel_id, pipeline_item_id, event_type, event_at, source)
         select creator_id, hotel_id, id, 'collaboration_started', now() - interval '1 day', 'manual_creator'
           from public.pipeline_items where id = $1`,
        [id],
      );
      const before = await snapshot(id);

      const res = await lifecycle(U.free, id, action, {
        eventAt: daysAgo(1),
        startDate: dayOf(daysAgo(1)),
        endDate: dayOf(daysAgo(1)),
        cancelReason: "mutual",
      });
      expect(res.result).toBe("integrity_error");
      expect(await snapshot(id)).toEqual(before);
    }
  });

  it("agreed or scheduled carrying a terminal event refuses every action", async () => {
    const id = await won(U.free, HOTELS[0]!.id);
    await adminQuery(
      `insert into public.outreach_events
         (creator_id, hotel_id, pipeline_item_id, event_type, event_at, metadata, source)
       select creator_id, hotel_id, id, 'creator_closed_pipeline', now() - interval '1 day',
              jsonb_build_object('reason','collaboration_cancelled'), 'manual_creator'
         from public.pipeline_items where id = $1`,
      [id],
    );
    const before = await snapshot(id);

    for (const action of ["schedule", "start", "cancel"]) {
      const res = await lifecycle(U.free, id, action, {
        eventAt: daysAgo(1),
        startDate: inDays(1),
        endDate: dayOf(daysAgo(1)),
        cancelReason: "mutual",
      });
      expect(res.result).toBe("integrity_error");
    }
    expect(await snapshot(id)).toEqual(before);
  });

  it("a scheduled collaboration in a closed cycle refuses the schedule retry", async () => {
    const id = await won(U.free, HOTELS[0]!.id);
    await lifecycle(U.free, id, "schedule", { startDate: inDays(2) });
    await adminQuery("update public.pipeline_items set status = 'closed' where id = $1", [id]);

    const res = await lifecycle(U.free, id, "schedule", { startDate: inDays(5) });
    expect(res.result).toBe("integrity_error");
    expect(asDay((await collab(id))!.start_date)).toBe(inDays(2));
  });

  it("a completed collaboration with broken history refuses the retry", async () => {
    // Missing start.
    const missing = await active(U.free, HOTELS[0]!.id);
    await lifecycle(U.free, missing, "complete", {
      eventAt: daysAgo(1),
      endDate: dayOf(daysAgo(1)),
      termsMatched: "yes",
    });
    await dropStartEvent(missing);
    expect(
      (
        await lifecycle(U.free, missing, "complete", {
          eventAt: daysAgo(1),
          endDate: dayOf(daysAgo(1)),
          termsMatched: "no",
        })
      ).result,
    ).toBe("integrity_error");

    // Duplicate completion.
    const duplicated = await active(U.free, HOTELS[1]!.id);
    await lifecycle(U.free, duplicated, "complete", {
      eventAt: daysAgo(1),
      endDate: dayOf(daysAgo(1)),
      termsMatched: "yes",
    });
    await duplicateEvent(duplicated, "collaboration_completed");
    expect(
      (
        await lifecycle(U.free, duplicated, "complete", {
          eventAt: daysAgo(1),
          endDate: dayOf(daysAgo(1)),
          termsMatched: "yes",
        })
      ).result,
    ).toBe("integrity_error");

    // A cancellation event alongside a completion.
    const both = await active(U.free, HOTELS[2]!.id);
    await lifecycle(U.free, both, "complete", {
      eventAt: daysAgo(1),
      endDate: dayOf(daysAgo(1)),
      termsMatched: "yes",
    });
    await adminQuery(
      `insert into public.outreach_events
         (creator_id, hotel_id, pipeline_item_id, event_type, event_at, metadata, source)
       select creator_id, hotel_id, id, 'creator_closed_pipeline', now() - interval '1 day',
              jsonb_build_object('reason','collaboration_cancelled'), 'manual_creator'
         from public.pipeline_items where id = $1`,
      [both],
    );
    expect(
      (
        await lifecycle(U.free, both, "complete", {
          eventAt: daysAgo(1),
          endDate: dayOf(daysAgo(1)),
          termsMatched: "yes",
        })
      ).result,
    ).toBe("integrity_error");
  });

  it("a cancelled collaboration with broken history refuses the retry", async () => {
    // Duplicate cancellation.
    const duplicated = await won(U.free, HOTELS[0]!.id);
    await lifecycle(U.free, duplicated, "cancel", { eventAt: daysAgo(1), cancelReason: "mutual" });
    await duplicateEvent(duplicated, "creator_closed_pipeline");
    expect(
      (
        await lifecycle(U.free, duplicated, "cancel", {
          eventAt: daysAgo(1),
          cancelReason: "other",
        })
      ).result,
    ).toBe("integrity_error");

    // A completion event alongside a cancellation.
    const both = await active(U.free, HOTELS[1]!.id);
    await lifecycle(U.free, both, "cancel", {
      eventAt: daysAgo(1),
      endDate: dayOf(daysAgo(1)),
      cancelReason: "mutual",
    });
    await adminQuery(
      `insert into public.outreach_events
         (creator_id, hotel_id, pipeline_item_id, event_type, event_at, source)
       select creator_id, hotel_id, id, 'collaboration_completed', now() - interval '1 day', 'manual_creator'
         from public.pipeline_items where id = $1`,
      [both],
    );
    expect(
      (await lifecycle(U.free, both, "cancel", { eventAt: daysAgo(1), cancelReason: "other" }))
        .result,
    ).toBe("integrity_error");

    // More than one start behind a cancellation.
    const twoStarts = await active(U.free, HOTELS[2]!.id);
    await lifecycle(U.free, twoStarts, "cancel", {
      eventAt: daysAgo(1),
      endDate: dayOf(daysAgo(1)),
      cancelReason: "mutual",
    });
    await duplicateEvent(twoStarts, "collaboration_started");
    expect(
      (await lifecycle(U.free, twoStarts, "cancel", { eventAt: daysAgo(1), cancelReason: "other" }))
        .result,
    ).toBe("integrity_error");
  });

  it("coherent retries still report already_applied", async () => {
    // Completed.
    const completed = await active(U.free, HOTELS[0]!.id);
    await lifecycle(U.free, completed, "complete", {
      eventAt: daysAgo(1),
      endDate: dayOf(daysAgo(1)),
      termsMatched: "yes",
      wouldWorkAgain: true,
    });
    expect(
      (
        await lifecycle(U.free, completed, "complete", {
          eventAt: daysAgo(1),
          endDate: dayOf(daysAgo(1)),
          termsMatched: "no",
        })
      ).result,
    ).toBe("already_applied");

    // Cancelled BEFORE any start: zero start events is coherent.
    const early = await won(U.free, HOTELS[1]!.id);
    await lifecycle(U.free, early, "cancel", { eventAt: daysAgo(1), cancelReason: "mutual" });
    expect(
      (await lifecycle(U.free, early, "cancel", { eventAt: daysAgo(1), cancelReason: "other" }))
        .result,
    ).toBe("already_applied");

    // Cancelled AFTER a start: exactly one start event is coherent too.
    const late = await active(U.free, HOTELS[2]!.id);
    await lifecycle(U.free, late, "cancel", {
      eventAt: daysAgo(1),
      endDate: dayOf(daysAgo(1)),
      cancelReason: "hotel_cancelled",
    });
    const retry = await lifecycle(U.free, late, "cancel", {
      eventAt: daysAgo(1),
      cancelReason: "other",
    });
    expect(retry.result).toBe("already_applied");

    // …and the original cancellation data is preserved.
    const closed = (await events(late)).filter((e) => e.event_type === "creator_closed_pipeline");
    expect(closed).toHaveLength(1);
    expect(closed[0]!.metadata.cancellation_reason).toBe("hotel_cancelled");

    // Scheduled.
    const scheduled = await won(U.free, HOTELS[3]!.id);
    await lifecycle(U.free, scheduled, "schedule", { startDate: inDays(3) });
    expect((await lifecycle(U.free, scheduled, "schedule", { startDate: inDays(9) })).result).toBe(
      "already_applied",
    );

    // Started.
    const started = await active(U.free, HOTELS[4]!.id);
    expect(
      (
        await lifecycle(U.free, started, "start", {
          eventAt: daysAgo(1),
          startDate: dayOf(daysAgo(1)),
        })
      ).result,
    ).toBe("already_applied");
  });
});

d("S — a complete/cancel race has exactly one winner", () => {
  it("never produces contradictory history", async () => {
    const id = await active(U.free, HOTELS[0]!.id);
    const a = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    const b = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await a.connect();
    await b.connect();
    try {
      const [ra, rb] = await Promise.all([
        a.query(
          "select public.progress_collaboration($1,$2,'complete',$3,null,$4,'yes',true,null) as r",
          [U.free, id, daysAgo(1), dayOf(daysAgo(1))],
        ),
        b.query(
          "select public.progress_collaboration($1,$2,'cancel',$3,null,$4,null,null,'mutual') as r",
          [U.free, id, daysAgo(1), dayOf(daysAgo(1))],
        ),
      ]);

      const results = [ra.rows[0].r.result, rb.rows[0].r.result].sort();
      // One applies; the other finds a terminal collaboration and is refused.
      expect(results).toEqual(["applied", "invalid_transition"]);

      const row = (await collab(id))!;
      expect(["completed", "cancelled"]).toContain(row.status);
      expect(await statusOf(id)).toBe("closed");

      const types = (await events(id)).map((e) => e.event_type);
      const completed = types.filter((t) => t === "collaboration_completed").length;
      const cancelled = types.filter((t) => t === "creator_closed_pipeline").length;
      // Exactly one terminal record, matching the collaboration's own status.
      expect(completed + cancelled).toBe(1);
      expect(row.status === "completed" ? completed : cancelled).toBe(1);
      expect(types).not.toContain("deal_lost");
    } finally {
      await a.end();
      await b.end();
    }
  });
});

d("T/U/V/W — guards", () => {
  it("cannot run the lifecycle on a cycle that is not won", async () => {
    const saved = await save(U.free, HOTELS[0]!.id);
    expect((await lifecycle(U.free, saved, "start", { eventAt: daysAgo(1) })).result).toBe(
      "collaboration_not_found",
    );

    const pitched = await save(U.free, HOTELS[1]!.id);
    await transition(U.free, pitched, "mark_pitched", { eventAt: daysAgo(5), channel: "email" });
    expect((await lifecycle(U.free, pitched, "schedule", { startDate: inDays(2) })).result).toBe(
      "collaboration_not_found",
    );
  });

  it("a won cycle with no collaboration is an integrity error, not a normal miss", async () => {
    const id = await won(U.free, HOTELS[0]!.id);
    await adminQuery("delete from public.collaborations where pipeline_item_id = $1", [id]);

    expect((await lifecycle(U.free, id, "schedule", { startDate: inDays(2) })).result).toBe(
      "integrity_error",
    );
    expect(await statusOf(id)).toBe("won");
  });

  it("a won cycle with no deal_won is an integrity error", async () => {
    const id = await won(U.free, HOTELS[0]!.id);
    await adminQuery(
      "delete from public.outreach_events where pipeline_item_id = $1 and event_type = 'deal_won'",
      [id],
    );
    expect(
      (await lifecycle(U.free, id, "start", { eventAt: daysAgo(1), startDate: dayOf(daysAgo(1)) }))
        .result,
    ).toBe("integrity_error");
    expect((await collab(id))!.status).toBe("agreed");
  });

  it("a collaboration belonging to another creator is an integrity error", async () => {
    const id = await won(U.free, HOTELS[0]!.id);
    await adminQuery(
      "update public.collaborations set creator_id = $1 where pipeline_item_id = $2",
      [await creatorIdFor(U.other), id],
    );
    expect((await lifecycle(U.free, id, "schedule", { startDate: inDays(2) })).result).toBe(
      "integrity_error",
    );
  });

  it("creator B cannot progress creator A's collaboration", async () => {
    const id = await active(U.free, HOTELS[0]!.id);

    for (const action of ["schedule", "start", "complete", "cancel"]) {
      const res = await lifecycle(U.other, id, action, {
        eventAt: daysAgo(1),
        startDate: inDays(1),
        endDate: dayOf(daysAgo(1)),
        termsMatched: "yes",
        cancelReason: "mutual",
      });
      expect(res.result).toBe("pipeline_item_not_found");
    }
    expect((await collab(id))!.status).toBe("active");
    expect(await statusOf(id)).toBe("won");
  });

  it("an unknown user and an unknown action are refused", async () => {
    const id = await won(U.free, HOTELS[0]!.id);
    expect(
      (await lifecycle("d1000000-0000-0000-0000-0000000000ff", id, "schedule", {})).result,
    ).toBe("creator_profile_missing");
    for (const action of ["reschedule", "", "finish"]) {
      expect((await lifecycle(U.free, id, action)).result).toBe("invalid_input");
    }
  });
});

d("X/Y/Z — security surface", () => {
  it("client roles cannot EXECUTE the lifecycle RPC", async () => {
    const id = await won(U.free, HOTELS[0]!.id);
    for (const role of ["anon", "authenticated"] as const) {
      const res = await queryAs(
        { role, sub: role === "authenticated" ? U.free : null },
        "select public.progress_collaboration($1,$2,'cancel',now(),null,null,null,null,'mutual')",
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
      where n.nspname='public' and p.proname='progress_collaboration'`,
    );
    expect(rows[0]!.anon).toBe(false);
    expect(rows[0]!.authed).toBe(false);
    expect(rows[0]!.public_exec).toBe(false);
    expect(rows[0]!.svc).toBe(true);
    expect(rows[0]!.secdef).toBe(false);
    expect(rows[0]!.cfg).toContain("search_path=public, pg_temp");
  });

  it("direct client writes to collaborations remain denied (0021)", async () => {
    const id = await active(U.free, HOTELS[0]!.id);

    for (const sql of [
      "update public.collaborations set status = 'completed' returning id",
      "delete from public.collaborations returning id",
    ]) {
      const res = await queryAs({ role: "authenticated", sub: U.free }, sql);
      expect(res.error).not.toBeNull();
      expect(res.error!.message).toMatch(/permission denied/i);
    }
    expect((await collab(id))!.status).toBe("active");
  });

  it("a creator can still read their own collaboration", async () => {
    const id = await active(U.free, HOTELS[0]!.id);
    const res = await queryAs<{ status: string }>(
      { role: "authenticated", sub: U.free },
      "select status from public.collaborations",
    );
    expect(res.error).toBeNull();
    expect(res.rows).toEqual([{ status: "active" }]);

    const theirs = await queryAs(
      { role: "authenticated", sub: U.other },
      "select id from public.collaborations",
    );
    expect(theirs.rows).toHaveLength(0);
    expect(id).toBeTruthy();
  });
});

d("AA/AB/AC — a terminal state frees the relationship", () => {
  it("after completion the same hotel can start a NEW cycle", async () => {
    const first = await active(U.free, HOTELS[0]!.id);
    await lifecycle(U.free, first, "complete", {
      eventAt: daysAgo(1),
      endDate: dayOf(daysAgo(1)),
      termsMatched: "yes",
      wouldWorkAgain: true,
    });

    const second = await save(U.free, HOTELS[0]!.id);
    expect(second).not.toBe(first);

    const rows = await adminQuery<{ id: string; status: string; cycle_number: number }>(
      "select id, status, cycle_number from public.pipeline_items where hotel_id = $1 order by cycle_number",
      [HOTELS[0]!.id],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ id: first, status: "closed", cycle_number: 1 });
    expect(rows[1]).toMatchObject({ id: second, status: "saved", cycle_number: 2 });

    // The old cycle's history and its completed collaboration are untouched.
    expect((await collab(first))!.status).toBe("completed");
    expect((await events(second)).map((e) => e.event_type)).toEqual(["hotel_saved"]);
    expect((await events(first)).map((e) => e.event_type)).toEqual(
      expect.arrayContaining(["deal_won", "collaboration_started", "collaboration_completed"]),
    );
  });

  it("after cancellation the same hotel can start a NEW cycle", async () => {
    const first = await won(U.free, HOTELS[1]!.id);
    await lifecycle(U.free, first, "cancel", {
      eventAt: daysAgo(1),
      endDate: dayOf(daysAgo(1)),
      cancelReason: "hotel_cancelled",
    });

    const second = await save(U.free, HOTELS[1]!.id);
    const rows = await adminQuery<{ status: string; cycle_number: number }>(
      "select status, cycle_number from public.pipeline_items where hotel_id = $1 order by cycle_number",
      [HOTELS[1]!.id],
    );
    expect(rows).toEqual([
      { status: "closed", cycle_number: 1 },
      { status: "saved", cycle_number: 2 },
    ]);
    expect((await collab(first))!.status).toBe("cancelled");
    expect(second).toBeTruthy();
  });

  it("the new cycle gets its own collaboration when it is won again", async () => {
    const first = await active(U.free, HOTELS[0]!.id);
    await lifecycle(U.free, first, "complete", {
      eventAt: daysAgo(1),
      endDate: dayOf(daysAgo(1)),
      termsMatched: "yes",
    });

    const second = await won(U.free, HOTELS[0]!.id, 0);
    expect((await collab(second))!.id).not.toBe((await collab(first))!.id);
    expect((await collab(first))!.status).toBe("completed");
    expect((await collab(second))!.status).toBe("agreed");
  });
});

d("AD/AE — a terminal state frees a Free engaged slot", () => {
  /** Fill the creator to the engaged limit, with one of them a won cycle. */
  async function fillToLimit(): Promise<{ wonItem: string; waiting: string }> {
    const wonItem = await won(U.free, HOTELS[0]!.id);
    for (let i = 1; i < LIMIT; i++) {
      const id = await save(U.free, HOTELS[i]!.id);
      expect((await transition(U.free, id, "plan")).result).toBe("applied");
    }
    expect(await engagedCount(U.free)).toBe(LIMIT);

    const waiting = await save(U.free, HOTELS[LIMIT]!.id);
    expect((await transition(U.free, waiting, "plan")).result).toBe("engaged_limit_reached");
    return { wonItem, waiting };
  }

  it("completing a won collaboration frees the slot", async () => {
    const { wonItem, waiting } = await fillToLimit();

    await lifecycle(U.free, wonItem, "start", {
      eventAt: daysAgo(3),
      startDate: dayOf(daysAgo(3)),
    });
    expect((await transition(U.free, waiting, "plan")).result).toBe("engaged_limit_reached");

    await lifecycle(U.free, wonItem, "complete", {
      eventAt: daysAgo(1),
      endDate: dayOf(daysAgo(1)),
      termsMatched: "yes",
      wouldWorkAgain: true,
    });

    expect(await engagedCount(U.free)).toBe(LIMIT - 1);
    expect((await transition(U.free, waiting, "plan")).result).toBe("applied");
  });

  it("cancelling a won collaboration frees the slot too", async () => {
    const { wonItem, waiting } = await fillToLimit();

    await lifecycle(U.free, wonItem, "cancel", {
      eventAt: daysAgo(1),
      endDate: dayOf(daysAgo(1)),
      cancelReason: "mutual",
    });

    expect(await engagedCount(U.free)).toBe(LIMIT - 1);
    expect((await transition(U.free, waiting, "plan")).result).toBe("applied");
  });
});

d("AF/AG/AH/AI/AJ/AK — intelligence and history integrity", () => {
  async function recompute(hotelId: string) {
    await adminQuery("select public.recompute_hotel_intelligence($1)", [hotelId]);
    const rows = await adminQuery<{
      collaboration_count: number;
      interaction_count_90d: number;
      last_collaboration_at: Date | null;
    }>("select * from public.hotel_intelligence where hotel_id = $1", [hotelId]);
    return rows[0] ?? null;
  }

  it("collaboration_started and completed feed the 0022 aggregation", async () => {
    const id = await active(U.free, HOTELS[0]!.id);
    const afterStart = (await recompute(HOTELS[0]!.id))!;

    await lifecycle(U.free, id, "complete", {
      eventAt: daysAgo(1),
      endDate: dayOf(daysAgo(1)),
      termsMatched: "yes",
    });
    const afterComplete = (await recompute(HOTELS[0]!.id))!;

    // Each lifecycle event is one more qualifying primary interaction.
    expect(afterComplete.interaction_count_90d).toBe(afterStart.interaction_count_90d + 1);
    // The confirmed deal is counted once, by deal_won — not re-counted here.
    expect(afterComplete.collaboration_count).toBe(1);
  });

  it("scheduling changes no intelligence source fact", async () => {
    const id = await won(U.free, HOTELS[0]!.id);
    const before = (await recompute(HOTELS[0]!.id))!;

    await lifecycle(U.free, id, "schedule", { startDate: inDays(2), endDate: inDays(6) });
    const after = (await recompute(HOTELS[0]!.id))!;

    expect(after.interaction_count_90d).toBe(before.interaction_count_90d);
    expect(after.collaboration_count).toBe(before.collaboration_count);
  });

  it("cancelling does not remove the confirmed collaboration from intelligence", async () => {
    const id = await active(U.free, HOTELS[0]!.id);
    await lifecycle(U.free, id, "cancel", {
      eventAt: daysAgo(1),
      endDate: dayOf(daysAgo(1)),
      cancelReason: "hotel_cancelled",
    });

    const row = (await recompute(HOTELS[0]!.id))!;
    // deal_won still happened, so the hotel still has a confirmed collaboration.
    expect(row.collaboration_count).toBe(1);
    expect(row.last_collaboration_at).not.toBeNull();
    expect((await events(id)).map((e) => e.event_type)).not.toContain("deal_lost");
  });

  it("the lifecycle RPC never writes intelligence itself", async () => {
    const id = await active(U.free, HOTELS[0]!.id);
    await adminQuery("delete from public.hotel_intelligence");

    await lifecycle(U.free, id, "complete", {
      eventAt: daysAgo(1),
      endDate: dayOf(daysAgo(1)),
      termsMatched: "yes",
    });

    // Aggregation is a separate, best-effort step invoked by the server layer.
    const rows = await adminQuery<{ n: string }>(
      "select count(*)::text n from public.hotel_intelligence",
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it("private financial fields are never touched", async () => {
    const id = await active(U.free, HOTELS[0]!.id);
    await lifecycle(U.free, id, "complete", {
      eventAt: daysAgo(1),
      endDate: dayOf(daysAgo(1)),
      termsMatched: "partially",
      wouldWorkAgain: false,
    });

    const row = (await collab(id))!;
    expect(row.private_value_amount).toBeNull();
    expect(row.private_value_currency).toBeNull();
  });

  it("the deal_won event survives every lifecycle path unchanged", async () => {
    for (const [i, path] of ["complete", "cancel"].entries()) {
      const id = await active(U.free, HOTELS[i]!.id);
      const before = (await events(id)).find((e) => e.event_type === "deal_won")!;

      await lifecycle(U.free, id, path, {
        eventAt: daysAgo(1),
        endDate: dayOf(daysAgo(1)),
        termsMatched: "yes",
        cancelReason: "mutual",
      });

      const after = (await events(id)).find((e) => e.event_type === "deal_won")!;
      expect(after).toEqual(before);
    }
  });
});
