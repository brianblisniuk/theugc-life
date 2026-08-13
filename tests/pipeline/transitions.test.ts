/**
 * Creator outreach workflow (migration 0020, EVENTS.md §3/§4/§8, D042/D043).
 *
 * The RPC is the workflow's security and integrity boundary, so the guarantees
 * — transition legality, idempotency, temporal sanity, the race-safe engaged
 * limit, close classification, the privilege surface, and the fact that clients
 * can no longer write these tables at all — are proven against real Postgres
 * with real roles rather than against a re-implementation.
 */
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";
import { FREE_LIMITS } from "@/lib/config";

const d = describe.skipIf(!hasTestDb);
const LIMIT = FREE_LIMITS.activePipelineItems;

const U = {
  free: "c1000000-0000-0000-0000-000000000001",
  pro: "c1000000-0000-0000-0000-000000000002",
  dest: "c1000000-0000-0000-0000-000000000003",
  other: "c1000000-0000-0000-0000-000000000004",
} as const;

const DEST = {
  parent: "c2000000-0000-0000-0000-000000000001",
  child: "c2000000-0000-0000-0000-000000000002",
  outside: "c2000000-0000-0000-0000-000000000003",
} as const;

/** Enough hotels to exercise the engaged limit plus spares. */
const HOTELS = Array.from({ length: 12 }, (_, i) => ({
  id: `c3000000-0000-0000-0000-0000000000${(i + 16).toString(16)}`,
  name: `Zt Hotel ${i + 1}`,
}));
const CHILD_HOTEL = "c3000000-0000-0000-0000-0000000000c1";

const DAY = 86_400_000;
/** A fixed-offset ISO timestamp; the DB clock is the only "now" that matters. */
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

interface TransitionArgs {
  eventAt?: string | null;
  channel?: string | null;
  sentiment?: string | null;
  offerType?: string | null;
  closeReason?: string | null;
  limit?: number;
}

async function act(
  userId: string,
  itemId: string,
  action: string,
  args: TransitionArgs = {},
): Promise<Record<string, unknown>> {
  const rows = await adminQuery<{ r: Record<string, unknown> }>(
    "select public.transition_pipeline_item($1,$2,$3,$4,$5,$6,$7,$8,$9) as r",
    [
      userId,
      itemId,
      action,
      args.eventAt ?? null,
      args.channel ?? null,
      args.sentiment ?? null,
      args.offerType ?? null,
      args.closeReason ?? null,
      args.limit ?? LIMIT,
    ],
  );
  return rows[0]!.r;
}

async function events(itemId: string) {
  return adminQuery<{
    event_type: string;
    channel: string | null;
    metadata: Record<string, unknown>;
  }>(
    "select event_type, channel, metadata from public.outreach_events where pipeline_item_id = $1 order by created_at",
    [itemId],
  );
}

async function item(itemId: string) {
  const rows = await adminQuery<{
    status: string;
    first_pitched_at: string | null;
    saved_at: string;
    last_activity_at: string;
    cycle_number: number;
  }>(
    "select status, first_pitched_at, saved_at, last_activity_at, cycle_number from public.pipeline_items where id = $1",
    [itemId],
  );
  return rows[0]!;
}

/** Drive an item to `pitched` so follow-up/reply tests have a valid origin. */
async function pitched(userId: string, hotelId: string, when = daysAgo(3)): Promise<string> {
  const id = await save(userId, hotelId);
  const res = await act(userId, id, "mark_pitched", { eventAt: when, channel: "email" });
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
    `insert into public.destinations (id, name, slug, type, country_code) values
       ($1,'Zt Parent','zt-parent','island','AE'),
       ($2,'Zt Outside','zt-outside','island','ID')`,
    [DEST.parent, DEST.outside],
  );
  await adminQuery(
    `insert into public.destinations (id, name, slug, type, country_code, parent_destination_id)
       values ($1,'Zt Child','zt-child','area','AE',$2)`,
    [DEST.child, DEST.parent],
  );

  for (const h of HOTELS) {
    await adminQuery(
      "insert into public.hotels (id,name,slug,destination_id) values ($1,$2,$3,$4)",
      [h.id, h.name, h.id, DEST.outside],
    );
  }
  await adminQuery("insert into public.hotels (id,name,slug,destination_id) values ($1,$2,$3,$4)", [
    CHILD_HOTEL,
    "Zt Child Hotel",
    "zt-child-hotel",
    DEST.child,
  ]);

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

/* ------------------------------------------------------------------ */

d("A — plan", () => {
  it("moves saved → planned and writes no domain event", async () => {
    const id = await save(U.free, HOTELS[0]!.id);
    await adminQuery("delete from public.outreach_events"); // ignore hotel_saved

    const res = await act(U.free, id, "plan");
    expect(res.result).toBe("applied");
    expect(res.status).toBe("planned");
    expect((await item(id)).status).toBe("planned");
    // `planned` is CRM state; EVENTS.md defines no canonical planned event.
    expect(await events(id)).toHaveLength(0);
  });

  it("a repeat plan is already_applied, not an error", async () => {
    const id = await save(U.free, HOTELS[0]!.id);
    await act(U.free, id, "plan");
    const retry = await act(U.free, id, "plan");
    expect(retry.result).toBe("already_applied");
    expect(retry.status).toBe("planned");
  });
});

d("B — mark pitched", () => {
  it("moves saved → pitched with exactly one pitch_sent and the right side effects", async () => {
    const id = await save(U.free, HOTELS[0]!.id);
    const before = await item(id);
    const when = daysAgo(2);

    const res = await act(U.free, id, "mark_pitched", { eventAt: when, channel: "instagram" });
    expect(res.result).toBe("applied");

    const after = await item(id);
    expect(after.status).toBe("pitched");
    expect(new Date(after.first_pitched_at!).toISOString()).toBe(when);
    expect(new Date(after.last_activity_at).getTime()).toBeGreaterThanOrEqual(
      new Date(before.last_activity_at).getTime(),
    );

    const pitchEvents = (await events(id)).filter((e) => e.event_type === "pitch_sent");
    expect(pitchEvents).toHaveLength(1);
    expect(pitchEvents[0]!.channel).toBe("instagram");
  });

  it("moves planned → pitched", async () => {
    const id = await save(U.free, HOTELS[1]!.id);
    await act(U.free, id, "plan");
    const res = await act(U.free, id, "mark_pitched", { eventAt: daysAgo(1), channel: "email" });
    expect(res.result).toBe("applied");
    expect((await item(id)).status).toBe("pitched");
  });

  it("records the historical pitch date without rewriting it to now()", async () => {
    const when = daysAgo(30);
    const id = await pitched(U.free, HOTELS[2]!.id, when);
    const rows = await adminQuery<{ event_at: string }>(
      "select event_at from public.outreach_events where pipeline_item_id=$1 and event_type='pitch_sent'",
      [id],
    );
    expect(new Date(rows[0]!.event_at).toISOString()).toBe(when);
    // Backfilling outreach that predates the save is explicitly allowed.
    expect(new Date(when).getTime()).toBeLessThan(new Date((await item(id)).saved_at).getTime());
  });
});

d("C — retries never duplicate a pitch", () => {
  it("a second mark_pitched is already_applied and writes no second event", async () => {
    const id = await pitched(U.free, HOTELS[0]!.id);
    const retry = await act(U.free, id, "mark_pitched", { eventAt: daysAgo(1), channel: "email" });
    const third = await act(U.free, id, "mark_pitched", { eventAt: daysAgo(1), channel: "other" });

    expect(retry.result).toBe("already_applied");
    expect(third.result).toBe("already_applied");
    expect((await events(id)).filter((e) => e.event_type === "pitch_sent")).toHaveLength(1);
  });

  it("concurrent duplicate pitches produce exactly one pitch_sent", async () => {
    const id = await save(U.free, HOTELS[0]!.id);
    const a = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    const b = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await a.connect();
    await b.connect();
    try {
      const sql = "select public.transition_pipeline_item($1,$2,$3,$4,$5,null,null,null,$6) as r";
      const params = [U.free, id, "mark_pitched", daysAgo(1), "email", LIMIT];
      const [ra, rb] = await Promise.all([a.query(sql, params), b.query(sql, params)]);
      const results = [ra.rows[0].r.result, rb.rows[0].r.result].sort();
      expect(results).toEqual(["already_applied", "applied"]);
      expect((await events(id)).filter((e) => e.event_type === "pitch_sent")).toHaveLength(1);
    } finally {
      await a.end();
      await b.end();
    }
  });
});

d("D — follow-up", () => {
  it("moves pitched → follow_up with one followup_sent", async () => {
    const id = await pitched(U.free, HOTELS[0]!.id);
    const res = await act(U.free, id, "mark_followup_sent", {
      eventAt: daysAgo(1),
      channel: "whatsapp",
    });
    expect(res.result).toBe("applied");
    expect((await item(id)).status).toBe("follow_up");

    const followups = (await events(id)).filter((e) => e.event_type === "followup_sent");
    expect(followups).toHaveLength(1);
    expect(followups[0]!.channel).toBe("whatsapp");
  });

  it("accepts a follow-up with no channel recorded", async () => {
    const id = await pitched(U.free, HOTELS[1]!.id);
    const res = await act(U.free, id, "mark_followup_sent", { eventAt: daysAgo(1) });
    expect(res.result).toBe("applied");
    expect((await events(id)).find((e) => e.event_type === "followup_sent")!.channel).toBeNull();
  });

  it("rejects an unknown channel", async () => {
    const id = await pitched(U.free, HOTELS[2]!.id);
    const res = await act(U.free, id, "mark_followup_sent", {
      eventAt: daysAgo(1),
      channel: "carrier_pigeon",
    });
    expect(res.result).toBe("invalid_input");
    expect((await item(id)).status).toBe("pitched");
  });

  it("a repeat follow-up is already_applied and writes no second event", async () => {
    const id = await pitched(U.free, HOTELS[3]!.id);
    await act(U.free, id, "mark_followup_sent", { eventAt: daysAgo(1) });
    const retry = await act(U.free, id, "mark_followup_sent", { eventAt: daysAgo(1) });
    expect(retry.result).toBe("already_applied");
    expect((await events(id)).filter((e) => e.event_type === "followup_sent")).toHaveLength(1);
  });
});

d("E/F/G/H — reply", () => {
  it("unclear creates reply_received only", async () => {
    const id = await pitched(U.free, HOTELS[0]!.id);
    const res = await act(U.free, id, "mark_replied", {
      eventAt: daysAgo(1),
      sentiment: "unclear",
    });
    expect(res.result).toBe("applied");
    expect((await item(id)).status).toBe("replied");

    const all = await events(id);
    const reply = all.filter((e) => e.event_type === "reply_received");
    expect(reply).toHaveLength(1);
    expect(reply[0]!.metadata.sentiment).toBe("unclear");
    expect(all.map((e) => e.event_type)).not.toContain("positive_reply");
    expect(all.map((e) => e.event_type)).not.toContain("negative_reply");
  });

  it("positive also creates positive_reply referencing the reply", async () => {
    const id = await pitched(U.free, HOTELS[1]!.id);
    const res = await act(U.free, id, "mark_replied", {
      eventAt: daysAgo(1),
      sentiment: "positive",
    });
    const all = await events(id);
    const reply = all.find((e) => e.event_type === "reply_received")!;
    const positive = all.filter((e) => e.event_type === "positive_reply");

    expect(positive).toHaveLength(1);
    expect(positive[0]!.metadata.reply_event_id).toBe(res.reply_event_id);
    expect(reply.metadata.sentiment).toBe("positive");
    expect(all.map((e) => e.event_type)).not.toContain("negative_reply");
  });

  it("negative also creates negative_reply", async () => {
    const id = await pitched(U.free, HOTELS[2]!.id);
    const res = await act(U.free, id, "mark_replied", {
      eventAt: daysAgo(1),
      sentiment: "negative",
    });
    const negative = (await events(id)).filter((e) => e.event_type === "negative_reply");
    expect(negative).toHaveLength(1);
    expect(negative[0]!.metadata.reply_event_id).toBe(res.reply_event_id);
  });

  it("an offer creates offer_received carrying the offer type and reply id", async () => {
    const id = await pitched(U.free, HOTELS[3]!.id);
    const res = await act(U.free, id, "mark_replied", {
      eventAt: daysAgo(1),
      sentiment: "positive",
      offerType: "stay_plus_paid",
    });
    const offers = (await events(id)).filter((e) => e.event_type === "offer_received");
    expect(offers).toHaveLength(1);
    expect(offers[0]!.metadata).toMatchObject({
      offer_type: "stay_plus_paid",
      reply_event_id: res.reply_event_id,
    });
  });

  it("moves follow_up → replied", async () => {
    const id = await pitched(U.free, HOTELS[4]!.id);
    await act(U.free, id, "mark_followup_sent", { eventAt: daysAgo(2) });
    const res = await act(U.free, id, "mark_replied", {
      eventAt: daysAgo(1),
      sentiment: "positive",
    });
    expect(res.result).toBe("applied");
    expect((await item(id)).status).toBe("replied");
  });

  it("rejects a missing or unknown sentiment, and an unknown offer type", async () => {
    const id = await pitched(U.free, HOTELS[5]!.id);
    expect((await act(U.free, id, "mark_replied", { eventAt: daysAgo(1) })).result).toBe(
      "invalid_input",
    );
    expect(
      (await act(U.free, id, "mark_replied", { eventAt: daysAgo(1), sentiment: "delighted" }))
        .result,
    ).toBe("invalid_input");
    expect(
      (
        await act(U.free, id, "mark_replied", {
          eventAt: daysAgo(1),
          sentiment: "positive",
          offerType: "equity",
        })
      ).result,
    ).toBe("invalid_input");
    expect((await item(id)).status).toBe("pitched");
    // Only the save and the pitch: no rejected attempt left a trace.
    expect((await events(id)).map((e) => e.event_type)).toEqual(["hotel_saved", "pitch_sent"]);
  });

  it("a repeat reply writes no second reply/classification/offer event", async () => {
    const id = await pitched(U.free, HOTELS[6]!.id);
    await act(U.free, id, "mark_replied", {
      eventAt: daysAgo(1),
      sentiment: "positive",
      offerType: "stay",
    });
    const retry = await act(U.free, id, "mark_replied", {
      eventAt: daysAgo(1),
      sentiment: "negative",
      offerType: "paid",
    });
    expect(retry.result).toBe("already_applied");

    const types = (await events(id)).map((e) => e.event_type);
    expect(types.filter((t) => t === "reply_received")).toHaveLength(1);
    expect(types.filter((t) => t === "positive_reply")).toHaveLength(1);
    expect(types.filter((t) => t === "offer_received")).toHaveLength(1);
    expect(types).not.toContain("negative_reply");
  });
});

d("I — invalid transitions are rejected without mutating anything", () => {
  it("rejects steps that skip or reverse the workflow", async () => {
    const saved = await save(U.free, HOTELS[0]!.id);
    // saved → replied skips the pitch entirely.
    expect(
      (await act(U.free, saved, "mark_replied", { eventAt: daysAgo(1), sentiment: "positive" }))
        .result,
    ).toBe("invalid_transition");
    // saved → follow_up likewise.
    expect((await act(U.free, saved, "mark_followup_sent", { eventAt: daysAgo(1) })).result).toBe(
      "invalid_transition",
    );
    expect((await item(saved)).status).toBe("saved");
    expect(await events(saved)).toHaveLength(1); // hotel_saved only

    const replied = await pitched(U.free, HOTELS[1]!.id);
    await act(U.free, replied, "mark_replied", { eventAt: daysAgo(1), sentiment: "positive" });
    // replied → pitched is a backwards correction, not a workflow step.
    expect(
      (await act(U.free, replied, "mark_pitched", { eventAt: daysAgo(1), channel: "email" }))
        .result,
    ).toBe("invalid_transition");
    // replied → plan likewise.
    expect((await act(U.free, replied, "plan")).result).toBe("invalid_transition");
    expect((await item(replied)).status).toBe("replied");
  });

  it("a closed cycle accepts no workflow action", async () => {
    const id = await save(U.free, HOTELS[2]!.id);
    await act(U.free, id, "close", { closeReason: "timing" });
    const before = await events(id);

    for (const attempt of [
      act(U.free, id, "plan"),
      act(U.free, id, "mark_pitched", { eventAt: daysAgo(1), channel: "email" }),
      act(U.free, id, "mark_followup_sent", { eventAt: daysAgo(1) }),
      act(U.free, id, "mark_replied", { eventAt: daysAgo(1), sentiment: "positive" }),
    ]) {
      expect((await attempt).result).toBe("invalid_transition");
    }
    expect((await item(id)).status).toBe("closed");
    expect(await events(id)).toHaveLength(before.length);
  });

  it("rejects an unknown action", async () => {
    const id = await save(U.free, HOTELS[3]!.id);
    for (const action of ["mark_won", "negotiation_started", "", "DROP TABLE"]) {
      expect((await act(U.free, id, action)).result).toBe("invalid_input");
    }
    expect((await item(id)).status).toBe("saved");
  });
});

d("J — temporal validation", () => {
  it("rejects a future event", async () => {
    const id = await save(U.free, HOTELS[0]!.id);
    const tomorrow = new Date(Date.now() + DAY).toISOString();
    expect(
      (await act(U.free, id, "mark_pitched", { eventAt: tomorrow, channel: "email" })).result,
    ).toBe("invalid_event_time");
    expect((await item(id)).status).toBe("saved");
  });

  it("rejects a reply dated before the pitch", async () => {
    const id = await pitched(U.free, HOTELS[1]!.id, daysAgo(5));
    const res = await act(U.free, id, "mark_replied", {
      eventAt: daysAgo(9),
      sentiment: "positive",
    });
    expect(res.result).toBe("invalid_event_time");
    expect((await item(id)).status).toBe("pitched");
  });

  it("rejects a follow-up dated before the pitch", async () => {
    const id = await pitched(U.free, HOTELS[2]!.id, daysAgo(5));
    expect((await act(U.free, id, "mark_followup_sent", { eventAt: daysAgo(9) })).result).toBe(
      "invalid_event_time",
    );
    expect((await item(id)).status).toBe("pitched");
  });

  it("accepts a pitch that predates the save (backfilled outreach)", async () => {
    const id = await save(U.free, HOTELS[3]!.id);
    const res = await act(U.free, id, "mark_pitched", {
      eventAt: daysAgo(60),
      channel: "email",
    });
    expect(res.result).toBe("applied");
  });

  it("requires the fields each event type needs", async () => {
    const id = await save(U.free, HOTELS[4]!.id);
    expect((await act(U.free, id, "mark_pitched", { channel: "email" })).result).toBe(
      "invalid_input",
    );
    expect((await act(U.free, id, "mark_pitched", { eventAt: daysAgo(1) })).result).toBe(
      "invalid_input",
    );
    expect((await act(U.free, id, "close")).result).toBe("invalid_input");
    expect((await act(U.free, id, "close", { closeReason: "bored" })).result).toBe("invalid_input");
    expect((await item(id)).status).toBe("saved");
  });
});

d("K/L/M — the Free engaged limit", () => {
  it(`allows exactly ${LIMIT} engaged relationships, then blocks the next`, async () => {
    for (let i = 0; i < LIMIT; i++) {
      const id = await save(U.free, HOTELS[i]!.id);
      expect((await act(U.free, id, "plan")).result).toBe("applied");
    }
    const overflow = await save(U.free, HOTELS[LIMIT]!.id);
    const res = await act(U.free, overflow, "plan");

    expect(res.result).toBe("engaged_limit_reached");
    expect(res.limit).toBe(LIMIT);
    expect(res.engaged_count).toBe(LIMIT);
    // The blocked item stays saved — nothing was half-applied.
    expect((await item(overflow)).status).toBe("saved");
  });

  it("a direct saved → pitched also consumes an engaged slot", async () => {
    for (let i = 0; i < LIMIT; i++) {
      const id = await save(U.free, HOTELS[i]!.id);
      await act(U.free, id, "plan");
    }
    const overflow = await save(U.free, HOTELS[LIMIT]!.id);
    const res = await act(U.free, overflow, "mark_pitched", {
      eventAt: daysAgo(1),
      channel: "email",
    });
    expect(res.result).toBe("engaged_limit_reached");
    expect((await events(overflow)).map((e) => e.event_type)).not.toContain("pitch_sent");
  });

  it("an already-engaged item keeps moving even at the limit", async () => {
    const ids: string[] = [];
    for (let i = 0; i < LIMIT; i++) {
      const id = await save(U.free, HOTELS[i]!.id);
      await act(U.free, id, "plan");
      ids.push(id);
    }
    // planned → pitched → follow_up → replied, all while engaged === LIMIT.
    const first = ids[0]!;
    expect(
      (await act(U.free, first, "mark_pitched", { eventAt: daysAgo(3), channel: "email" })).result,
    ).toBe("applied");
    expect((await act(U.free, first, "mark_followup_sent", { eventAt: daysAgo(2) })).result).toBe(
      "applied",
    );
    expect(
      (await act(U.free, first, "mark_replied", { eventAt: daysAgo(1), sentiment: "positive" }))
        .result,
    ).toBe("applied");
    expect((await item(first)).status).toBe("replied");
  });

  it("saved hotels do not consume the engaged allowance", async () => {
    for (let i = 0; i < 8; i++) await save(U.free, HOTELS[i]!.id);
    const rows = await adminQuery<{ n: string }>(
      "select count(*)::text n from public.pipeline_items where status = 'saved'",
    );
    expect(Number(rows[0]!.n)).toBe(8);
    // With 8 saved and none engaged, the first engagement still succeeds.
    const id = await adminQuery<{ id: string }>(
      "select id from public.pipeline_items where hotel_id = $1",
      [HOTELS[0]!.id],
    );
    expect((await act(U.free, id[0]!.id, "plan")).result).toBe("applied");
  });
});

d("N — the engaged limit is race-safe", () => {
  it("two concurrent saved → planned for DIFFERENT hotels cannot both take the last slot", async () => {
    for (let i = 0; i < LIMIT - 1; i++) {
      const id = await save(U.free, HOTELS[i]!.id);
      await act(U.free, id, "plan");
    }
    const idA = await save(U.free, HOTELS[LIMIT]!.id);
    const idB = await save(U.free, HOTELS[LIMIT + 1]!.id);

    const a = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    const b = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await a.connect();
    await b.connect();
    try {
      const sql =
        "select public.transition_pipeline_item($1,$2,'plan',null,null,null,null,null,$3) as r";
      const [ra, rb] = await Promise.all([
        a.query(sql, [U.free, idA, LIMIT]),
        b.query(sql, [U.free, idB, LIMIT]),
      ]);
      const results = [ra.rows[0].r.result, rb.rows[0].r.result].sort();
      expect(results).toEqual(["applied", "engaged_limit_reached"]);

      const rows = await adminQuery<{ n: string }>(
        `select count(*)::text n from public.pipeline_items
          where creator_id = (select id from public.creator_profiles where user_id = $1)
            and status in ('planned','pitched','replied','follow_up','negotiating','won')`,
        [U.free],
      );
      expect(Number(rows[0]!.n)).toBe(LIMIT);
    } finally {
      await a.end();
      await b.end();
    }
  });
});

d("O/P/Q — entitlement exempts a creator from the engaged limit", () => {
  it("an active Pro is not blocked", async () => {
    for (let i = 0; i < LIMIT + 2; i++) {
      const id = await save(U.pro, HOTELS[i]!.id);
      expect((await act(U.pro, id, "plan")).result).toBe("applied");
    }
  });

  it("a destination pass covers hotels inside the entitled hierarchy", async () => {
    for (let i = 0; i < LIMIT; i++) {
      const id = await save(U.dest, HOTELS[i]!.id);
      await act(U.dest, id, "plan");
    }
    // Already at the Free limit, but this hotel is inside the entitlement.
    const covered = await save(U.dest, CHILD_HOTEL);
    expect((await act(U.dest, covered, "plan")).result).toBe("applied");
  });

  it("a destination creator acting OUTSIDE the entitlement falls back to Free", async () => {
    for (let i = 0; i < LIMIT; i++) {
      const id = await save(U.dest, HOTELS[i]!.id);
      await act(U.dest, id, "plan");
    }
    const outside = await save(U.dest, HOTELS[LIMIT]!.id);
    expect((await act(U.dest, outside, "plan")).result).toBe("engaged_limit_reached");
  });
});

d("R/S/T — close classification (D043)", () => {
  it("closing before any pitch emits creator_closed_pipeline", async () => {
    for (const [i, prep] of [
      async (id: string) => id, // saved
      async (id: string) => {
        await act(U.free, id, "plan");
        return id;
      },
    ].entries()) {
      const id = await save(U.free, HOTELS[i]!.id);
      await prep(id);
      const res = await act(U.free, id, "close", { closeReason: "timing" });

      expect(res.result).toBe("applied");
      expect(res.event_type).toBe("creator_closed_pipeline");
      expect((await item(id)).status).toBe("closed");

      const close = (await events(id)).filter((e) => e.event_type === "creator_closed_pipeline");
      expect(close).toHaveLength(1);
      expect(close[0]!.metadata).toEqual({ reason: "timing" });
      expect((await events(id)).map((e) => e.event_type)).not.toContain("deal_lost");
    }
  });

  it("closing after outreach began emits deal_lost with the exact reason", async () => {
    const cases = [
      { hotel: HOTELS[3]!.id, reason: "no_reply", to: "pitched" },
      { hotel: HOTELS[4]!.id, reason: "rejected", to: "follow_up" },
      { hotel: HOTELS[5]!.id, reason: "not_a_fit", to: "replied" },
    ] as const;

    for (const c of cases) {
      const id = await pitched(U.free, c.hotel);
      if (c.to === "follow_up")
        await act(U.free, id, "mark_followup_sent", { eventAt: daysAgo(2) });
      if (c.to === "replied")
        await act(U.free, id, "mark_replied", { eventAt: daysAgo(1), sentiment: "unclear" });

      const res = await act(U.free, id, "close", { closeReason: c.reason });
      expect(res.event_type).toBe("deal_lost");

      const lost = (await events(id)).filter((e) => e.event_type === "deal_lost");
      expect(lost).toHaveLength(1);
      expect(lost[0]!.metadata).toEqual({ reason: c.reason });
      expect((await events(id)).map((e) => e.event_type)).not.toContain("creator_closed_pipeline");
    }
  });

  it("closing frees an engaged slot", async () => {
    const ids: string[] = [];
    for (let i = 0; i < LIMIT; i++) {
      const id = await save(U.free, HOTELS[i]!.id);
      await act(U.free, id, "plan");
      ids.push(id);
    }
    const blocked = await save(U.free, HOTELS[LIMIT]!.id);
    expect((await act(U.free, blocked, "plan")).result).toBe("engaged_limit_reached");

    await act(U.free, ids[0]!, "close", { closeReason: "timing" });
    expect((await act(U.free, blocked, "plan")).result).toBe("applied");
  });

  it("a repeat close writes no second close or loss event", async () => {
    const id = await pitched(U.free, HOTELS[6]!.id);
    await act(U.free, id, "close", { closeReason: "no_reply" });
    const retry = await act(U.free, id, "close", { closeReason: "rejected" });

    expect(retry.result).toBe("already_applied");
    const types = (await events(id)).map((e) => e.event_type);
    expect(types.filter((t) => t === "deal_lost")).toHaveLength(1);
    expect(types).not.toContain("creator_closed_pipeline");
  });
});

d("U — a closed cycle can be replaced by a new one", () => {
  it("saving again starts cycle 2 and preserves the closed cycle", async () => {
    const first = await pitched(U.free, HOTELS[0]!.id);
    await act(U.free, first, "close", { closeReason: "no_reply" });

    const second = await save(U.free, HOTELS[0]!.id);
    expect(second).not.toBe(first);

    const oldCycle = await item(first);
    const newCycle = await item(second);
    expect(oldCycle.status).toBe("closed"); // never reopened
    expect(oldCycle.cycle_number).toBe(1);
    expect(newCycle.status).toBe("saved");
    expect(newCycle.cycle_number).toBe(2);

    // The old cycle's history survives; the new cycle has its own hotel_saved.
    expect((await events(first)).map((e) => e.event_type)).toEqual(
      expect.arrayContaining(["hotel_saved", "pitch_sent", "deal_lost"]),
    );
    expect((await events(second)).map((e) => e.event_type)).toEqual(["hotel_saved"]);
  });
});

d("V/W — ownership and privilege surface", () => {
  it("creator A cannot transition creator B's item", async () => {
    const id = await pitched(U.free, HOTELS[0]!.id);

    for (const action of ["plan", "close", "mark_replied"]) {
      const res = await act(U.other, id, action, {
        eventAt: daysAgo(1),
        sentiment: "positive",
        closeReason: "other",
      });
      // The item does not exist for another creator — not "forbidden", absent.
      expect(res.result).toBe("pipeline_item_not_found");
    }
    expect((await item(id)).status).toBe("pitched");
    expect((await events(id)).map((e) => e.event_type)).toEqual(["hotel_saved", "pitch_sent"]);
  });

  it("an unknown user has no creator profile and cannot act", async () => {
    const id = await save(U.free, HOTELS[1]!.id);
    const res = await act("c1000000-0000-0000-0000-0000000000ff", id, "plan");
    expect(res.result).toBe("creator_profile_missing");
  });

  it("client roles cannot EXECUTE the workflow RPC", async () => {
    const id = await save(U.free, HOTELS[2]!.id);
    for (const role of ["anon", "authenticated"] as const) {
      const res = await queryAs(
        { role, sub: role === "authenticated" ? U.free : null },
        "select public.transition_pipeline_item($1,$2,'plan',null,null,null,null,null,$3)",
        [U.free, id, LIMIT],
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
      where n.nspname='public' and p.proname='transition_pipeline_item'`,
    );
    expect(rows[0]!.anon).toBe(false);
    expect(rows[0]!.authed).toBe(false);
    expect(rows[0]!.public_exec).toBe(false);
    expect(rows[0]!.svc).toBe(true);
    // SECURITY INVOKER on purpose: service_role already has what it needs.
    expect(rows[0]!.secdef).toBe(false);
    expect(rows[0]!.cfg).toContain("search_path=public, pg_temp");
  });
});

d("X — direct client writes are revoked (0020)", () => {
  it("an authenticated creator cannot INSERT, UPDATE or DELETE pipeline_items", async () => {
    const id = await save(U.free, HOTELS[0]!.id);
    const creator = await adminQuery<{ id: string }>(
      "select id from public.creator_profiles where user_id = $1",
      [U.free],
    );

    const attempts = [
      {
        sql: `insert into public.pipeline_items (creator_id, hotel_id, status)
              values ($1, $2, 'won') returning id`,
        params: [creator[0]!.id, HOTELS[1]!.id],
      },
      { sql: "update public.pipeline_items set status = 'won' returning id", params: [] },
      { sql: "delete from public.pipeline_items returning id", params: [] },
    ];

    for (const attempt of attempts) {
      const res = await queryAs(
        { role: "authenticated", sub: U.free },
        attempt.sql,
        attempt.params,
      );
      expect(res.error).not.toBeNull();
      expect(res.error!.message).toMatch(/permission denied/i);
    }

    // Nothing was fabricated or altered.
    expect((await item(id)).status).toBe("saved");
    const rows = await adminQuery<{ n: string }>(
      "select count(*)::text n from public.pipeline_items",
    );
    expect(Number(rows[0]!.n)).toBe(1);
  });

  it("an authenticated creator cannot forge an outreach event", async () => {
    const id = await save(U.free, HOTELS[0]!.id);
    const creator = await adminQuery<{ id: string }>(
      "select id from public.creator_profiles where user_id = $1",
      [U.free],
    );

    for (const type of ["pitch_sent", "reply_received", "deal_won"]) {
      const res = await queryAs(
        { role: "authenticated", sub: U.free },
        `insert into public.outreach_events
           (creator_id, hotel_id, pipeline_item_id, event_type, event_at)
         values ($1,$2,$3,$4, now()) returning id`,
        [creator[0]!.id, HOTELS[0]!.id, id, type],
      );
      expect(res.error).not.toBeNull();
      expect(res.error!.message).toMatch(/permission denied/i);
    }
    expect((await events(id)).map((e) => e.event_type)).toEqual(["hotel_saved"]);
  });

  it("an authenticated creator can still READ their own rows", async () => {
    const id = await pitched(U.free, HOTELS[0]!.id);

    const items = await queryAs<{ id: string }>(
      { role: "authenticated", sub: U.free },
      "select id from public.pipeline_items",
    );
    expect(items.error).toBeNull();
    expect(items.rows.map((r) => r.id)).toEqual([id]);

    const ledger = await queryAs<{ event_type: string }>(
      { role: "authenticated", sub: U.free },
      "select event_type from public.outreach_events order by created_at",
    );
    expect(ledger.error).toBeNull();
    expect(ledger.rows.map((r) => r.event_type)).toEqual(["hotel_saved", "pitch_sent"]);

    // RLS ownership still scopes those reads to the owner.
    const theirs = await queryAs(
      { role: "authenticated", sub: U.other },
      "select id from public.pipeline_items",
    );
    expect(theirs.rows).toHaveLength(0);
  });

  it("service_role retains the table privileges the RPC relies on", async () => {
    const rows = await adminQuery<Record<string, boolean>>(
      `select
         has_table_privilege('authenticated','public.pipeline_items','SELECT') as a_sel,
         has_table_privilege('authenticated','public.pipeline_items','INSERT') as a_ins,
         has_table_privilege('authenticated','public.pipeline_items','UPDATE') as a_upd,
         has_table_privilege('authenticated','public.pipeline_items','DELETE') as a_del,
         has_table_privilege('authenticated','public.outreach_events','SELECT') as e_sel,
         has_table_privilege('authenticated','public.outreach_events','INSERT') as e_ins,
         has_table_privilege('service_role','public.pipeline_items','UPDATE') as s_upd,
         has_table_privilege('service_role','public.outreach_events','INSERT') as s_ins`,
    );
    expect(rows[0]).toEqual({
      a_sel: true,
      a_ins: false,
      a_upd: false,
      a_del: false,
      e_sel: true,
      e_ins: false,
      s_upd: true,
      s_ins: true,
    });
  });

  it("the ownership policies from 0012 are still in place as defence in depth", async () => {
    const rows = await adminQuery<{ policyname: string }>(
      `select policyname from pg_policies
        where schemaname='public' and tablename in ('pipeline_items','outreach_events')
        order by policyname`,
    );
    expect(rows.map((r) => r.policyname)).toEqual([
      "outreach_events_insert",
      "outreach_events_select",
      "pipeline_items_all",
    ]);
  });
});

d("Y — the workflow does not touch intelligence", () => {
  it("a full outreach lifecycle leaves the intelligence base tables empty", async () => {
    const id = await pitched(U.free, HOTELS[0]!.id);
    await act(U.free, id, "mark_followup_sent", { eventAt: daysAgo(2) });
    await act(U.free, id, "mark_replied", {
      eventAt: daysAgo(1),
      sentiment: "positive",
      offerType: "stay",
    });
    await act(U.free, id, "close", { closeReason: "timing" });

    const planned = await save(U.free, HOTELS[1]!.id);
    await act(U.free, planned, "plan");
    await act(U.free, planned, "close", { closeReason: "not_a_fit" });

    // Every Sprint 2C event type is now on the ledger…
    const types = new Set(
      [...(await events(id)), ...(await events(planned))].map((e) => e.event_type),
    );
    for (const expected of [
      "pitch_sent",
      "followup_sent",
      "reply_received",
      "positive_reply",
      "offer_received",
      "deal_lost",
      "creator_closed_pipeline",
    ]) {
      expect(types.has(expected)).toBe(true);
    }

    // …and no aggregate row was written. Aggregation is a separate system.
    for (const table of ["hotel_intelligence", "destination_intelligence"]) {
      const rows = await adminQuery<{ n: string }>(`select count(*)::text n from public.${table}`);
      expect(Number(rows[0]!.n)).toBe(0);
    }
  });
});
