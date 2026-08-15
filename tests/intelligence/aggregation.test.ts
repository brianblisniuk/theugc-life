/**
 * Hotel intelligence aggregation (migration 0022, PRD §12, D008/D009/D012/D044).
 *
 * These are the first numbers theugc.life asserts about someone else's
 * business, so the bar is not "the SQL runs" — it is that the metrics mean
 * exactly what D044 says, that absence never becomes a zero, that a busy single
 * relationship cannot fake market demand, and that the exact values behind the
 * gated projection are unreachable from a client role.
 *
 * Events are inserted directly with fixed timestamps: the point is to pin the
 * aggregator's reading of history, independent of the workflow that wrote it.
 */
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const USER = "71000000-0000-0000-0000-000000000001";
const OTHER_USER = "71000000-0000-0000-0000-000000000002";
const DEST = "72000000-0000-0000-0000-000000000001";
const HOTEL = "73000000-0000-0000-0000-000000000001";
const HOTEL_B = "73000000-0000-0000-0000-000000000002";
const UNKNOWN_HOTEL = "73000000-0000-0000-0000-0000000000ff";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** A timestamp N days before the run, so window boundaries are deterministic. */
function daysAgo(n: number): string {
  return new Date(Date.now() - n * DAY).toISOString();
}
function hoursAfter(iso: string, hours: number): string {
  return new Date(new Date(iso).getTime() + hours * HOUR).toISOString();
}

let cycleSeq = 0;

/**
 * Each cycle gets its own creator by default. That is what the real data looks
 * like — a hotel's intelligence aggregates across many creators — and the
 * database enforces it anyway: one creator may hold only one open cycle per
 * hotel (D023).
 */
let creatorSeq = 0;

async function freshCreator(): Promise<string> {
  creatorSeq += 1;
  const userId = `7a000000-0000-0000-0000-${String(creatorSeq).padStart(12, "0")}`;
  await adminQuery("insert into auth.users (id, email) values ($1,$2)", [
    userId,
    `${userId}@t.local`,
  ]);
  const rows = await adminQuery<{ id: string }>(
    "select id from public.creator_profiles where user_id = $1",
    [userId],
  );
  return rows[0]!.id;
}

interface CycleSpec {
  hotel?: string;
  /** Reuse one creator across cycles, to model a single busy relationship. */
  creator?: string;
  /** Extra pitch events in the same cycle, to prove a cycle counts once. */
  pitchAt?: string[];
  replyAt?: string[];
  classify?: "positive" | "negative" | null;
  /** Classification with no reply_event_id reference, e.g. an admin correction. */
  classifyUnlinked?: "positive" | "negative" | null;
  offerAt?: string;
  followupAt?: string;
  negotiationAt?: string;
  wonAt?: string[];
  lostAt?: string;
  savedAt?: string;
  closedAt?: string;
  status?: string;
}

/** Build one relationship cycle with exactly the history the test needs. */
async function cycle(spec: CycleSpec = {}): Promise<string> {
  const hotel = spec.hotel ?? HOTEL;
  cycleSeq += 1;
  const creatorId = spec.creator ?? (await freshCreator());
  const rows = await adminQuery<{ id: string }>(
    `insert into public.pipeline_items (creator_id, hotel_id, status, cycle_number)
     values ($1, $2, $3, $4) returning id`,
    [creatorId, hotel, spec.status ?? "pitched", cycleSeq],
  );
  const itemId = rows[0]!.id;

  async function event(type: string, at: string, metadata: object = {}, channel?: string) {
    const inserted = await adminQuery<{ id: string }>(
      `insert into public.outreach_events
         (creator_id, hotel_id, pipeline_item_id, event_type, event_at, metadata, channel)
       values ($1,$2,$3,$4,$5,$6,$7) returning id`,
      [creatorId, hotel, itemId, type, at, JSON.stringify(metadata), channel ?? null],
    );
    return inserted[0]!.id;
  }

  if (spec.savedAt) await event("hotel_saved", spec.savedAt);
  for (const at of spec.pitchAt ?? []) await event("pitch_sent", at, {}, "email");
  if (spec.followupAt) await event("followup_sent", spec.followupAt, {}, "email");

  let firstReplyId: string | null = null;
  for (const at of spec.replyAt ?? []) {
    const id = await event("reply_received", at, { sentiment: "positive" });
    firstReplyId ??= id;
  }
  if (spec.classify && firstReplyId) {
    await event(`${spec.classify}_reply`, spec.replyAt![0]!, { reply_event_id: firstReplyId });
  }
  if (spec.classifyUnlinked && spec.replyAt?.[0]) {
    await event(`${spec.classifyUnlinked}_reply`, spec.replyAt[0], {});
  }
  if (spec.offerAt) await event("offer_received", spec.offerAt, { offer_type: "stay" });
  if (spec.negotiationAt) await event("negotiation_started", spec.negotiationAt);
  for (const at of spec.wonAt ?? []) await event("deal_won", at, { collaboration_type: "stay" });
  // A won cycle also creates the collaboration record, exactly as
  // progress_pipeline_deal does. `agreed_at` is the domain instant the
  // collaboration-presence and collaboration-type aggregates are dated by.
  if (spec.wonAt?.[0]) {
    await adminQuery(
      `insert into public.collaborations
         (creator_id, hotel_id, pipeline_item_id, status, collaboration_type, agreed_at)
       values ($1,$2,$3,'agreed','stay',$4)`,
      [creatorId, hotel, itemId, spec.wonAt[0]],
    );
  }
  if (spec.lostAt) await event("deal_lost", spec.lostAt, { reason: "no_reply" });
  if (spec.closedAt) await event("creator_closed_pipeline", spec.closedAt, { reason: "timing" });

  return itemId;
}

async function recompute(hotel = HOTEL): Promise<Record<string, unknown>> {
  const rows = await adminQuery<{ r: Record<string, unknown> }>(
    "select public.recompute_hotel_intelligence($1) as r",
    [hotel],
  );
  return rows[0]!.r;
}

interface IntelRow {
  hotel_id: string;
  pitch_count: number;
  reply_count: number;
  positive_reply_count: number;
  negative_reply_count: number;
  collaboration_count: number;
  reply_rate: string | null;
  median_reply_hours: string | null;
  interaction_count_30d: number;
  interaction_count_90d: number;
  interaction_count_365d: number;
  last_creator_activity_at: Date | null;
  last_reply_at: Date | null;
  last_collaboration_at: Date | null;
  activity_level: string | null;
  confidence_level: string | null;
  calculated_at: Date;
}

async function intel(hotel = HOTEL): Promise<IntelRow | null> {
  const rows = await adminQuery<IntelRow>(
    "select * from public.hotel_intelligence where hotel_id = $1",
    [hotel],
  );
  return rows[0] ?? null;
}

interface PublicRow {
  activity_level: string | null;
  confidence_level: string | null;
  has_observed_collaboration: boolean | null;
  recency_band: string | null;
}

async function publicView(hotel = HOTEL): Promise<PublicRow | null> {
  const rows = await adminQuery<PublicRow>(
    "select activity_level, confidence_level, has_observed_collaboration, recency_band from public.hotel_public_intelligence where hotel_id = $1",
    [hotel],
  );
  return rows[0] ?? null;
}

/** N pitched cycles, each on its own day, to drive the confidence bands. */
async function pitchedCycles(n: number, opts: { replies?: number } = {}) {
  const replies = opts.replies ?? 0;
  for (let i = 0; i < n; i++) {
    const pitchAt = daysAgo(200 + i);
    await cycle({
      pitchAt: [pitchAt],
      replyAt: i < replies ? [hoursAfter(pitchAt, 24)] : [],
    });
  }
}

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();

  for (const id of [USER, OTHER_USER]) {
    await adminQuery("insert into auth.users (id, email) values ($1,$2)", [id, `${id}@t.local`]);
  }
  await adminQuery(
    "insert into public.destinations (id,name,slug,type,country_code) values ($1,'Zi Dest','zi-dest','city','AE')",
    [DEST],
  );
  await adminQuery(
    `insert into public.hotels (id,name,slug,destination_id) values
       ($1,'Zi Hotel A','zi-hotel-a',$3), ($2,'Zi Hotel B','zi-hotel-b',$3)`,
    [HOTEL, HOTEL_B, DEST],
  );
}, 120_000);

afterAll(async () => {
  await teardownDatabase();
});

beforeEach(async () => {
  if (!hasTestDb) return;
  await adminQuery("delete from public.hotel_intelligence");
  await adminQuery("delete from public.outreach_events");
  await adminQuery("delete from public.collaborations");
  await adminQuery("delete from public.pipeline_items");
  await adminQuery("delete from public.editorial_evidence");
  // The per-cycle creators too, so ids stay deterministic across tests.
  await adminQuery("delete from auth.users where id::text like '7a000000-%'");
  cycleSeq = 0;
});

/* ------------------------------------------------------------------ */

d("A/B/C — absence is not a zero", () => {
  it("a hotel with no events gets no intelligence row", async () => {
    const res = await recompute();
    expect(res.result).toBe("no_data");
    expect(await intel()).toBeNull();
    expect(await publicView()).toBeNull();
  });

  it("hotel_saved alone is creator intent, not hotel interaction", async () => {
    await cycle({ savedAt: daysAgo(3), status: "saved" });
    expect((await recompute()).result).toBe("no_data");
    expect(await intel()).toBeNull();
  });

  it("closing before any outreach creates no intelligence", async () => {
    await cycle({ savedAt: daysAgo(5), closedAt: daysAgo(3), status: "closed" });
    expect((await recompute()).result).toBe("no_data");
    expect(await intel()).toBeNull();
  });

  it("an unknown hotel is reported, not invented", async () => {
    expect((await recompute(UNKNOWN_HOTEL)).result).toBe("hotel_not_found");
    expect((await recompute(null as unknown as string)).result).toBe("invalid_input");
  });
});

d("D/E — a relationship cycle counts once", () => {
  it("one pitch yields pitch_count 1 at insufficient confidence", async () => {
    await cycle({ pitchAt: [daysAgo(10)] });
    expect((await recompute()).result).toBe("recomputed");

    const row = (await intel())!;
    expect(row.pitch_count).toBe(1);
    expect(row.reply_count).toBe(0);
    expect(row.confidence_level).toBe("insufficient");
    // A pitched hotel that nobody answered has a MEASURED rate of 0. That is a
    // real finding; NULL is reserved for "no denominator at all".
    expect(row.reply_rate).toBe("0.0000");
  });

  it("extra pitches in the SAME cycle do not inflate the count", async () => {
    await cycle({ pitchAt: [daysAgo(10), daysAgo(9), daysAgo(8)] });
    await recompute();
    expect((await intel())!.pitch_count).toBe(1);
  });

  it("distinct cycles for the same hotel each count", async () => {
    await cycle({ pitchAt: [daysAgo(10)] });
    await cycle({ pitchAt: [daysAgo(9)] });
    await recompute();
    expect((await intel())!.pitch_count).toBe(2);
  });
});

d("F/G/H — confidence bands follow pitched cycles", () => {
  it("5 pitched cycles reach emerging", async () => {
    await pitchedCycles(5);
    await recompute();
    const row = (await intel())!;
    expect(row.pitch_count).toBe(5);
    expect(row.confidence_level).toBe("emerging");
  });

  it("4 pitched cycles are still insufficient", async () => {
    await pitchedCycles(4);
    await recompute();
    expect((await intel())!.confidence_level).toBe("insufficient");
  });

  it("15 pitched cycles reach moderate", async () => {
    await pitchedCycles(15);
    await recompute();
    expect((await intel())!.confidence_level).toBe("moderate");
  });

  it("50 pitched cycles reach strong", async () => {
    await pitchedCycles(50);
    await recompute();
    const row = (await intel())!;
    expect(row.pitch_count).toBe(50);
    expect(row.confidence_level).toBe("strong");
  });
});

d("I/J/K/L/M — replies", () => {
  it("a reply with no qualifying pitch is excluded from the funnel", async () => {
    // A reply recorded in a cycle that was never pitched.
    await cycle({ replyAt: [daysAgo(5)], status: "replied" });
    // …plus a real pitched cycle so a row exists at all.
    await cycle({ pitchAt: [daysAgo(10)] });
    await recompute();

    const row = (await intel())!;
    expect(row.pitch_count).toBe(1);
    expect(row.reply_count).toBe(0);
    // Measured zero, because a pitch WAS sent — just not answered.
    expect(row.reply_rate).toBe("0.0000");
  });

  it("a reply BEFORE its own pitch does not qualify", async () => {
    const pitchAt = daysAgo(10);
    await cycle({ pitchAt: [pitchAt], replyAt: [daysAgo(12)] });
    await recompute();

    const row = (await intel())!;
    expect(row.pitch_count).toBe(1);
    expect(row.reply_count).toBe(0);
    expect(row.median_reply_hours).toBeNull();
  });

  it("pitch + reply is one qualifying reply", async () => {
    const pitchAt = daysAgo(10);
    await cycle({ pitchAt: [pitchAt], replyAt: [hoursAfter(pitchAt, 12)] });
    await recompute();

    const row = (await intel())!;
    expect(row.reply_count).toBe(1);
    expect(row.reply_rate).toBe("1.0000");
  });

  it("multiple replies in one cycle are still one replied cycle", async () => {
    const pitchAt = daysAgo(10);
    await cycle({
      pitchAt: [pitchAt],
      replyAt: [hoursAfter(pitchAt, 6), hoursAfter(pitchAt, 30), hoursAfter(pitchAt, 60)],
    });
    await recompute();
    expect((await intel())!.reply_count).toBe(1);
  });

  it("a positive classification referencing the qualifying reply counts once", async () => {
    const pitchAt = daysAgo(10);
    await cycle({
      pitchAt: [pitchAt],
      replyAt: [hoursAfter(pitchAt, 6)],
      classify: "positive",
    });
    await recompute();

    const row = (await intel())!;
    expect(row.reply_count).toBe(1);
    expect(row.positive_reply_count).toBe(1);
    expect(row.negative_reply_count).toBe(0);
  });

  it("a negative classification likewise", async () => {
    const pitchAt = daysAgo(10);
    await cycle({ pitchAt: [pitchAt], replyAt: [hoursAfter(pitchAt, 6)], classify: "negative" });
    await recompute();

    const row = (await intel())!;
    expect(row.negative_reply_count).toBe(1);
    expect(row.positive_reply_count).toBe(0);
  });

  it("a classification carrying no reference still counts in its own cycle", async () => {
    const pitchAt = daysAgo(10);
    await cycle({
      pitchAt: [pitchAt],
      replyAt: [hoursAfter(pitchAt, 6)],
      classifyUnlinked: "positive",
    });
    await recompute();
    expect((await intel())!.positive_reply_count).toBe(1);
  });
});

d("N/O/P — only primary moments count as interactions", () => {
  it("classifications and offers do not inflate the interaction count", async () => {
    const pitchAt = daysAgo(10);
    await cycle({
      savedAt: daysAgo(11),
      pitchAt: [pitchAt],
      replyAt: [hoursAfter(pitchAt, 6)],
      classify: "positive",
      offerAt: hoursAfter(pitchAt, 6),
    });
    await recompute();

    // pitch + reply only: hotel_saved, positive_reply and offer_received are
    // all excluded.
    expect((await intel())!.interaction_count_30d).toBe(2);
  });

  it("a follow-up IS a primary interaction", async () => {
    const pitchAt = daysAgo(10);
    await cycle({ pitchAt: [pitchAt], followupAt: hoursAfter(pitchAt, 48) });
    await recompute();
    expect((await intel())!.interaction_count_30d).toBe(2);
  });

  it("negotiation, won and lost all count as interactions", async () => {
    const pitchAt = daysAgo(10);
    await cycle({
      pitchAt: [pitchAt],
      replyAt: [hoursAfter(pitchAt, 4)],
      negotiationAt: hoursAfter(pitchAt, 24),
      wonAt: [hoursAfter(pitchAt, 48)],
    });
    await cycle({ pitchAt: [daysAgo(9)], lostAt: daysAgo(8) });
    await recompute();
    expect((await intel())!.interaction_count_30d).toBe(6);
  });

  it("a closed-before-pitch event is not an interaction", async () => {
    await cycle({ pitchAt: [daysAgo(10)] });
    await cycle({ savedAt: daysAgo(9), closedAt: daysAgo(8), status: "closed" });
    await recompute();
    expect((await intel())!.interaction_count_30d).toBe(1);
  });
});

d("Q/R — collaborations", () => {
  it("deal_won marks one collaborating cycle", async () => {
    const pitchAt = daysAgo(10);
    await cycle({ pitchAt: [pitchAt], wonAt: [hoursAfter(pitchAt, 48)] });
    await recompute();
    expect((await intel())!.collaboration_count).toBe(1);
  });

  it("multiple deal_won events in one cycle still count once", async () => {
    const pitchAt = daysAgo(10);
    await cycle({
      pitchAt: [pitchAt],
      wonAt: [hoursAfter(pitchAt, 48), hoursAfter(pitchAt, 72)],
    });
    await recompute();
    expect((await intel())!.collaboration_count).toBe(1);
  });

  it("distinct won cycles each count", async () => {
    await cycle({ pitchAt: [daysAgo(20)], wonAt: [daysAgo(18)] });
    await cycle({ pitchAt: [daysAgo(15)], wonAt: [daysAgo(12)] });
    await recompute();
    expect((await intel())!.collaboration_count).toBe(2);
  });
});

d("S/T — median reply hours", () => {
  it("measures from the INITIAL pitch to the FIRST qualifying reply", async () => {
    const pitchAt = daysAgo(30);
    await cycle({
      // A later pitch in the same cycle must not become the baseline…
      pitchAt: [pitchAt, hoursAfter(pitchAt, 20)],
      // …and a later reply must not become the qualifying one.
      replyAt: [hoursAfter(pitchAt, 10), hoursAfter(pitchAt, 100)],
    });
    await recompute();
    expect(Number((await intel())!.median_reply_hours)).toBeCloseTo(10, 5);
  });

  it("is the median across cycles for an odd sample", async () => {
    for (const hours of [4, 10, 40]) {
      const pitchAt = daysAgo(50);
      await cycle({ pitchAt: [pitchAt], replyAt: [hoursAfter(pitchAt, hours)] });
    }
    await recompute();
    expect(Number((await intel())!.median_reply_hours)).toBeCloseTo(10, 5);
  });

  it("is the midpoint for an even sample", async () => {
    for (const hours of [4, 10, 20, 50]) {
      const pitchAt = daysAgo(50);
      await cycle({ pitchAt: [pitchAt], replyAt: [hoursAfter(pitchAt, hours)] });
    }
    await recompute();
    // (10 + 20) / 2
    expect(Number((await intel())!.median_reply_hours)).toBeCloseTo(15, 5);
  });

  it("is null when nothing qualifies", async () => {
    await cycle({ pitchAt: [daysAgo(10)] });
    await recompute();
    expect((await intel())!.median_reply_hours).toBeNull();
  });
});

d("U/V — rolling windows use event_at, not created_at", () => {
  it("an old event inserted today does not count as recent", async () => {
    // created_at is now(); event_at is a year and a half ago.
    await cycle({ pitchAt: [daysAgo(500)] });
    await recompute();

    const row = (await intel())!;
    expect(row.interaction_count_30d).toBe(0);
    expect(row.interaction_count_90d).toBe(0);
    expect(row.interaction_count_365d).toBe(0);
    // The cycle still counts for the funnel — it happened, just not recently.
    expect(row.pitch_count).toBe(1);
  });

  it("counts fall into the right windows", async () => {
    await cycle({ pitchAt: [daysAgo(5)] }); // 30d, 90d, 365d
    await cycle({ pitchAt: [daysAgo(60)] }); // 90d, 365d
    await cycle({ pitchAt: [daysAgo(200)] }); // 365d
    await cycle({ pitchAt: [daysAgo(400)] }); // none
    await recompute();

    const row = (await intel())!;
    expect(row.interaction_count_30d).toBe(1);
    expect(row.interaction_count_90d).toBe(2);
    expect(row.interaction_count_365d).toBe(3);
    expect(row.pitch_count).toBe(4);
  });

  it("respects the window edges", async () => {
    await cycle({ pitchAt: [daysAgo(29)] });
    await cycle({ pitchAt: [daysAgo(31)] });
    await cycle({ pitchAt: [daysAgo(89)] });
    await cycle({ pitchAt: [daysAgo(91)] });
    await recompute();

    const row = (await intel())!;
    expect(row.interaction_count_30d).toBe(1);
    expect(row.interaction_count_90d).toBe(3);
  });
});

d("W/X — activity level counts cycles, not enthusiasm", () => {
  it("one recently active cycle is emerging", async () => {
    await cycle({ pitchAt: [daysAgo(10)] });
    await recompute();
    expect((await intel())!.activity_level).toBe("emerging");
  });

  it("2–4 cycles is low, 5–9 medium, 10+ high", async () => {
    const expectations: [number, string][] = [
      [2, "low"],
      [4, "low"],
      [5, "medium"],
      [9, "medium"],
      [10, "high"],
    ];
    for (const [count, expected] of expectations) {
      await adminQuery("delete from public.outreach_events");
      await adminQuery("delete from public.pipeline_items");
      for (let i = 0; i < count; i++) await cycle({ pitchAt: [daysAgo(10 + i)] });
      await recompute();
      expect((await intel())!.activity_level).toBe(expected);
    }
  });

  it("ONE busy relationship cannot make a hotel look popular", async () => {
    // 20 primary events, all in a single cycle.
    const pitchAt = daysAgo(20);
    await cycle({
      pitchAt: [pitchAt],
      followupAt: hoursAfter(pitchAt, 24),
      replyAt: [
        hoursAfter(pitchAt, 30),
        hoursAfter(pitchAt, 40),
        hoursAfter(pitchAt, 50),
        hoursAfter(pitchAt, 60),
      ],
      negotiationAt: hoursAfter(pitchAt, 70),
      wonAt: [hoursAfter(pitchAt, 80)],
    });
    await recompute();

    const row = (await intel())!;
    expect(row.interaction_count_90d).toBeGreaterThan(5);
    // …but only one distinct cycle was active.
    expect(row.activity_level).toBe("emerging");
    expect(row.activity_level).not.toBe("high");
  });

  it("activity is NULL when nothing happened in 90 days — never 'low'", async () => {
    await cycle({ pitchAt: [daysAgo(200)] });
    await recompute();

    const row = (await intel())!;
    expect(row.activity_level).toBeNull();
    expect(row.activity_level).not.toBe("low");
  });
});

d("Y — recency timestamps", () => {
  it("tracks the last activity, reply and collaboration", async () => {
    const pitchAt = daysAgo(30);
    const replyAt = hoursAfter(pitchAt, 24);
    const wonAt = hoursAfter(pitchAt, 100);
    await cycle({
      savedAt: daysAgo(31),
      pitchAt: [pitchAt],
      replyAt: [replyAt],
      wonAt: [wonAt],
      offerAt: daysAgo(1), // excluded: must not become "last activity"
    });
    await recompute();

    const row = (await intel())!;
    expect(new Date(row.last_creator_activity_at!).toISOString()).toBe(wonAt);
    expect(new Date(row.last_reply_at!).toISOString()).toBe(replyAt);
    expect(new Date(row.last_collaboration_at!).toISOString()).toBe(wonAt);
  });

  it("leaves reply and collaboration timestamps null when there are none", async () => {
    await cycle({ pitchAt: [daysAgo(10)] });
    await recompute();

    const row = (await intel())!;
    expect(row.last_reply_at).toBeNull();
    expect(row.last_collaboration_at).toBeNull();
    expect(row.last_creator_activity_at).not.toBeNull();
  });
});

d("Z/AA — recomputation is deterministic and follows source truth", () => {
  it("recomputing unchanged facts changes nothing but calculated_at", async () => {
    const pitchAt = daysAgo(20);
    await cycle({ pitchAt: [pitchAt], replyAt: [hoursAfter(pitchAt, 12)], wonAt: [daysAgo(15)] });
    await recompute();
    const first = (await intel())!;

    await recompute();
    const second = (await intel())!;

    const strip = (row: IntelRow) => {
      const { calculated_at: _ignored, ...rest } = row;
      return rest;
    };
    expect(strip(second)).toEqual(strip(first));
    expect(new Date(second.calculated_at).getTime()).toBeGreaterThanOrEqual(
      new Date(first.calculated_at).getTime(),
    );
  });

  it("correcting source events updates the derived row", async () => {
    await pitchedCycles(5);
    await recompute();
    expect((await intel())!.confidence_level).toBe("emerging");

    // An admin correction removes two cycles' pitches.
    await adminQuery(
      `delete from public.outreach_events
        where event_type = 'pitch_sent'
          and pipeline_item_id in (
            select id from public.pipeline_items where hotel_id = $1 order by cycle_number limit 2
          )`,
      [HOTEL],
    );
    await recompute();

    const row = (await intel())!;
    expect(row.pitch_count).toBe(3);
    expect(row.confidence_level).toBe("insufficient");
  });

  it("removing all qualifying events deletes the derived row", async () => {
    await cycle({ pitchAt: [daysAgo(10)] });
    await recompute();
    expect(await intel()).not.toBeNull();

    await adminQuery("delete from public.outreach_events where hotel_id = $1", [HOTEL]);
    expect((await recompute()).result).toBe("no_data");
    expect(await intel()).toBeNull();
  });
});

d("AB/AC — full rebuild", () => {
  it("produces the same result as recomputing each hotel", async () => {
    const pitchAt = daysAgo(20);
    await cycle({ pitchAt: [pitchAt], replyAt: [hoursAfter(pitchAt, 8)] });
    await cycle({ hotel: HOTEL_B, pitchAt: [daysAgo(40)], wonAt: [daysAgo(35)] });

    await recompute(HOTEL);
    await recompute(HOTEL_B);
    const individual = [(await intel(HOTEL))!, (await intel(HOTEL_B))!];

    await adminQuery("delete from public.hotel_intelligence");
    const rebuild = await adminQuery<{ r: Record<string, unknown> }>(
      "select public.recompute_all_hotel_intelligence() as r",
    );
    expect(rebuild[0]!.r.result).toBe("rebuilt");
    expect(rebuild[0]!.r.recomputed).toBe(2);

    const rebuilt = [(await intel(HOTEL))!, (await intel(HOTEL_B))!];
    const strip = (row: IntelRow) => {
      const { calculated_at: _ignored, ...rest } = row;
      return rest;
    };
    expect(rebuilt.map(strip)).toEqual(individual.map(strip));
  });

  it("removes stale derived rows whose source data no longer qualifies", async () => {
    await cycle({ pitchAt: [daysAgo(10)] });
    await recompute();
    expect(await intel()).not.toBeNull();

    await adminQuery("delete from public.outreach_events");
    const rebuild = await adminQuery<{ r: Record<string, unknown> }>(
      "select public.recompute_all_hotel_intelligence() as r",
    );
    expect(rebuild[0]!.r.removed).toBe(1);
    expect(await intel()).toBeNull();
  });

  it("counts removals exactly, even when the rebuild also adds rows", async () => {
    // Hotel A has a stale derived row whose source events are gone…
    await cycle({ pitchAt: [daysAgo(10)] });
    await recompute(HOTEL);
    await adminQuery("delete from public.outreach_events where hotel_id = $1", [HOTEL]);

    // …while Hotel B has new activity and no row yet.
    await cycle({ hotel: HOTEL_B, pitchAt: [daysAgo(5)] });
    await cycle({ hotel: HOTEL_B, pitchAt: [daysAgo(4)] });

    const before = await adminQuery<{ n: string }>(
      "select count(*)::text n from public.hotel_intelligence",
    );
    expect(Number(before[0]!.n)).toBe(1);

    const rebuild = await adminQuery<{ r: Record<string, unknown> }>(
      "select public.recompute_all_hotel_intelligence() as r",
    );

    // The net row count is unchanged (1 → 1), so a before/after difference
    // would report zero removals. One row really was removed.
    const after = await adminQuery<{ n: string }>(
      "select count(*)::text n from public.hotel_intelligence",
    );
    expect(Number(after[0]!.n)).toBe(1);
    expect(rebuild[0]!.r.removed).toBe(1);
    expect(rebuild[0]!.r.recomputed).toBe(1);

    expect(await intel(HOTEL)).toBeNull();
    expect((await intel(HOTEL_B))!.pitch_count).toBe(2);
  });

  it("reports zero removals when nothing was stale", async () => {
    await cycle({ pitchAt: [daysAgo(10)] });
    const rebuild = await adminQuery<{ r: Record<string, unknown> }>(
      "select public.recompute_all_hotel_intelligence() as r",
    );
    expect(rebuild[0]!.r).toEqual({ result: "rebuilt", recomputed: 1, removed: 0 });
  });

  it("leaves hotels without creator activity with no row at all", async () => {
    await cycle({ pitchAt: [daysAgo(10)] });
    await adminQuery("select public.recompute_all_hotel_intelligence()");

    expect(await intel(HOTEL)).not.toBeNull();
    expect(await intel(HOTEL_B)).toBeNull();
  });
});

d("F1 — recomputes for one hotel serialize", () => {
  /** The exact key the function locks on, derived by the database itself. */
  async function lockKey(hotel: string): Promise<string> {
    const rows = await adminQuery<{ k: string }>(
      "select public.hotel_intelligence_lock_key($1)::text as k",
      [hotel],
    );
    return rows[0]!.k;
  }

  it("a second recompute waits behind the per-hotel lock", async () => {
    await cycle({ pitchAt: [daysAgo(10)] });

    const holder = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    const worker = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await holder.connect();
    await worker.connect();
    try {
      const key = await lockKey(HOTEL);

      // Hold the hotel's lock in an open transaction.
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock($1::bigint)", [key]);

      let done = false;
      const pending = worker
        .query("select public.recompute_hotel_intelligence($1) as r", [HOTEL])
        .then((res) => {
          done = true;
          return res;
        });

      // Give it every chance to finish if it were not blocked.
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(done).toBe(false);
      expect(await intel()).toBeNull(); // nothing written while blocked

      await holder.query("commit");
      const res = await pending;
      expect(done).toBe(true);
      expect(res.rows[0].r.result).toBe("recomputed");
      expect((await intel())!.pitch_count).toBe(1);
    } finally {
      await holder.end();
      await worker.end();
    }
  });

  it("a different hotel is NOT blocked by that lock", async () => {
    await cycle({ pitchAt: [daysAgo(10)] });
    await cycle({ hotel: HOTEL_B, pitchAt: [daysAgo(10)] });

    const holder = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    const worker = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await holder.connect();
    await worker.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock($1::bigint)", [await lockKey(HOTEL)]);

      // Hotel B proceeds immediately: per-hotel keys, not a global lock.
      const res = await worker.query("select public.recompute_hotel_intelligence($1) as r", [
        HOTEL_B,
      ]);
      expect(res.rows[0].r.result).toBe("recomputed");
      expect((await intel(HOTEL_B))!.pitch_count).toBe(1);

      await holder.query("commit");
    } finally {
      await holder.end();
      await worker.end();
    }
  });

  it("the lock key is stable per hotel and distinct between hotels", async () => {
    expect(await lockKey(HOTEL)).toBe(await lockKey(HOTEL));
    expect(await lockKey(HOTEL)).not.toBe(await lockKey(HOTEL_B));
  });

  it("interleaved events and refreshes converge on the deterministic result", async () => {
    // Two creators act on the same hotel, each triggering its own refresh, with
    // the second event landing while the first refresh is in flight.
    await cycle({ pitchAt: [daysAgo(10)] });

    const a = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    const b = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await a.connect();
    await b.connect();
    try {
      const sql = "select public.recompute_hotel_intelligence($1) as r";
      const second = cycle({ pitchAt: [daysAgo(9)] });
      await Promise.all([a.query(sql, [HOTEL]), second.then(() => b.query(sql, [HOTEL]))]);
    } finally {
      await a.end();
      await b.end();
    }

    const raced = (await intel())!;
    // One more deterministic recompute over the same facts must agree with
    // whatever the race left behind: no stale overwrite survived.
    await recompute();
    const settled = (await intel())!;

    const strip = (row: IntelRow) => {
      const { calculated_at: _ignored, ...rest } = row;
      return rest;
    };
    expect(strip(raced)).toEqual(strip(settled));
    expect(settled.pitch_count).toBe(2);
  });
});

d("AD — editorial evidence never becomes creator intelligence", () => {
  it("has zero effect on any derived metric", async () => {
    const pitchAt = daysAgo(20);
    await cycle({ pitchAt: [pitchAt], replyAt: [hoursAfter(pitchAt, 12)] });
    await recompute();
    const before = (await intel())!;

    // Editorial research, including a collaboration CLAIM, about this hotel.
    for (const claim of [
      "property_exists",
      "contact_confirmation",
      "creator_collaboration_evidence",
      "brand_relationship",
    ]) {
      await adminQuery(
        `insert into public.editorial_evidence
           (subject_type, subject_id, claim_type, source_type, verification_status, observed_at)
         values ('hotel', $1, $2, 'official_website', 'verified', now())`,
        [HOTEL, claim],
      );
    }
    await recompute();
    const after = (await intel())!;

    const strip = (row: IntelRow) => {
      const { calculated_at: _ignored, ...rest } = row;
      return rest;
    };
    expect(strip(after)).toEqual(strip(before));
    // Specifically: editorial "collaboration evidence" is not a collaboration.
    expect(after.collaboration_count).toBe(0);
  });

  it("cannot create intelligence for a hotel with no creator activity", async () => {
    await adminQuery(
      `insert into public.editorial_evidence
         (subject_type, subject_id, claim_type, source_type, verification_status)
       values ('hotel', $1, 'creator_collaboration_evidence', 'official_website', 'verified')`,
      [HOTEL_B],
    );
    expect((await recompute(HOTEL_B)).result).toBe("no_data");
    expect(await intel(HOTEL_B)).toBeNull();
  });
});

d("AE/AF/AG/AH — the privacy boundary", () => {
  it("authenticated clients cannot read the hotel_intelligence base table", async () => {
    await cycle({ pitchAt: [daysAgo(10)] });
    await recompute();

    const res = await queryAs(
      { role: "authenticated", sub: USER },
      "select pitch_count, last_creator_activity_at from public.hotel_intelligence",
    );
    expect(res.error).not.toBeNull();
    expect(res.error!.message).toMatch(/permission denied/i);
  });

  it("authenticated clients cannot read destination_intelligence either", async () => {
    const res = await queryAs(
      { role: "authenticated", sub: USER },
      "select * from public.destination_intelligence",
    );
    expect(res.error).not.toBeNull();
    expect(res.error!.message).toMatch(/permission denied/i);
  });

  it("anon cannot read either base table", async () => {
    for (const table of ["hotel_intelligence", "destination_intelligence"]) {
      const res = await queryAs({ role: "anon" }, `select * from public.${table}`);
      expect(res.error).not.toBeNull();
    }
  });

  it("the safe view remains readable by anon and authenticated", async () => {
    await pitchedCycles(15, { replies: 6 });
    await recompute();

    for (const role of ["anon", "authenticated"] as const) {
      const res = await queryAs<PublicRow>(
        { role, sub: role === "authenticated" ? USER : null },
        "select activity_level, confidence_level, has_observed_collaboration, recency_band from public.hotel_public_intelligence",
      );
      expect(res.error).toBeNull();
      expect(res.rows).toHaveLength(1);
      expect(res.rows[0]!.confidence_level).toBe("moderate");
    }
  });

  it("the view exposes no contributor or cycle identifiers at all", async () => {
    await cycle({ pitchAt: [daysAgo(10)] });
    await recompute();

    const cols = await adminQuery<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema='public' and table_name='hotel_public_intelligence'`,
    );
    const names = cols.map((c) => c.column_name).sort();
    expect(names).toEqual([
      "activity_level",
      "confidence_level",
      "has_observed_collaboration",
      "hotel_id",
      "hotel_slug",
      "recency_band",
    ]);
    for (const forbidden of [
      "creator_id",
      "pipeline_item_id",
      "pitch_count",
      "reply_count",
      // Premium since 0026 — the public layer must not project them at all.
      "reply_rate",
      "median_reply_hours",
    ]) {
      expect(names).not.toContain(forbidden);
    }
  });

  it("service_role retains the access aggregation needs", async () => {
    const rows = await adminQuery<Record<string, boolean>>(
      `select
         has_table_privilege('service_role','public.hotel_intelligence','SELECT') as svc_sel,
         has_table_privilege('service_role','public.hotel_intelligence','INSERT') as svc_ins,
         has_table_privilege('service_role','public.hotel_intelligence','DELETE') as svc_del,
         has_table_privilege('authenticated','public.hotel_intelligence','SELECT') as auth_sel,
         has_table_privilege('authenticated','public.destination_intelligence','SELECT') as auth_dest,
         has_table_privilege('anon','public.hotel_public_intelligence','SELECT') as anon_view,
         has_table_privilege('authenticated','public.hotel_public_intelligence','SELECT') as auth_view`,
    );
    expect(rows[0]).toEqual({
      svc_sel: true,
      svc_ins: true,
      svc_del: true,
      auth_sel: false,
      auth_dest: false,
      anon_view: true,
      auth_view: true,
    });
  });

  it("the 0012 RLS policies remain in place as defence in depth", async () => {
    const rows = await adminQuery<{ policyname: string }>(
      `select policyname from pg_policies
        where schemaname='public'
          and tablename in ('hotel_intelligence','destination_intelligence')
        order by policyname`,
    );
    expect(rows.map((r) => r.policyname)).toEqual([
      "destination_intelligence_select",
      "hotel_intelligence_select",
    ]);
  });
});

d("AI/AJ/AK/AL — progressive disclosure, and NULL is not false", () => {
  it("insufficient exposes confidence only — everything else is NULL", async () => {
    // 4 pitched cycles, one of them won and recently active.
    await cycle({ pitchAt: [daysAgo(10)], wonAt: [daysAgo(9)] });
    await cycle({ pitchAt: [daysAgo(9)] });
    await cycle({ pitchAt: [daysAgo(8)] });
    await cycle({ pitchAt: [daysAgo(7)] });
    await recompute();

    // The base row knows the truth…
    const base = (await intel())!;
    expect(base.confidence_level).toBe("insufficient");
    expect(base.collaboration_count).toBe(1);
    expect(base.activity_level).toBe("low");

    // …and the projection withholds all of it.
    const view = (await publicView())!;
    expect(view).toEqual({
      activity_level: null,
      confidence_level: "insufficient",
      has_observed_collaboration: null,
      recency_band: null,
    });
    // The critical invariant: withheld is NULL, never a fabricated `false`.
    expect(view.has_observed_collaboration).not.toBe(false);
  });

  it("a suppressed collaboration is NULL even when there genuinely is none", async () => {
    await cycle({ pitchAt: [daysAgo(10)] });
    await recompute();

    const view = (await publicView())!;
    expect(view.has_observed_collaboration).toBeNull();
    expect(view.has_observed_collaboration).not.toBe(false);
  });

  it("emerging needs THREE recent creators before it publishes activity", async () => {
    await pitchedCycles(5, { replies: 3 });
    // One recent, won cycle: enough for `emerging`, not enough for a population.
    await cycle({ pitchAt: [daysAgo(3)], wonAt: [daysAgo(2)] });
    await recompute();

    const base = (await intel())!;
    expect(base.confidence_level).toBe("emerging");
    // The base row knows the activity level…
    expect(base.activity_level).not.toBeNull();

    const view = (await publicView())!;
    expect(view.confidence_level).toBe("emerging");
    // …and the projection withholds it: one creator is not a hotel's behaviour.
    expect(view.activity_level).toBeNull();
    expect(view.recency_band).toBeNull();

    // Three distinct recent creators, and the band appears.
    for (const days of [4, 5, 6]) await cycle({ pitchAt: [daysAgo(days)] });
    await recompute();
    expect((await publicView())!.activity_level).not.toBeNull();
  });

  it("a withheld activity level is NULL, never 'low'", async () => {
    await pitchedCycles(5, { replies: 3 });
    await cycle({ pitchAt: [daysAgo(3)] });
    await recompute();

    const view = (await publicView())!;
    expect(view.activity_level).toBeNull();
    expect(view.activity_level).not.toBe("low");
    expect(view.activity_level).not.toBe("emerging");
  });

  it("collaboration presence is positive-only: no collaborations reports NULL, never false", async () => {
    await pitchedCycles(6);
    await recompute();

    const view = (await publicView())!;
    expect(view.confidence_level).toBe("emerging");
    // "We have not observed collaborations" is not "this hotel does not
    // collaborate with creators", and `false` would assert the second.
    expect(view.has_observed_collaboration).toBeNull();
    expect(view.has_observed_collaboration).not.toBe(false);
  });

  it("collaboration presence needs THREE distinct collaborating creators", async () => {
    await pitchedCycles(6);

    // One creator, three collaborations — repetition is not diversity.
    const busy = await freshCreator();
    for (let i = 0; i < 3; i++) {
      // `closed`, so one creator may legitimately hold three historical cycles
      // with the same hotel (pipeline_items_single_active_cycle_uidx).
      await cycle({
        creator: busy,
        status: "closed",
        pitchAt: [daysAgo(40 + i)],
        wonAt: [daysAgo(39 + i)],
      });
    }
    await recompute();
    expect((await publicView())!.has_observed_collaboration).toBeNull();

    // A second collaborating creator: still short.
    await cycle({ pitchAt: [daysAgo(30)], wonAt: [daysAgo(29)] });
    await recompute();
    expect((await publicView())!.has_observed_collaboration).toBeNull();

    // A third, and the presence signal publishes.
    await cycle({ pitchAt: [daysAgo(28)], wonAt: [daysAgo(27)] });
    await recompute();
    expect((await publicView())!.has_observed_collaboration).toBe(true);
  });

  it("moderate adds a coarse recency band once THREE creators support it", async () => {
    await pitchedCycles(15, { replies: 5 });
    // Three distinct recent creators: the band describes a population, not one
    // identifiable person's week (0026 contributor floor).
    for (const days of [2, 4, 6]) await cycle({ pitchAt: [daysAgo(days)] });
    await recompute();

    const view = (await publicView())!;
    expect(view.confidence_level).toBe("moderate");
    expect(view.recency_band).toBe("past_month");
  });

  it("two recent creators are not enough to publish a recency band", async () => {
    await pitchedCycles(15, { replies: 5 });
    for (const days of [2, 4]) await cycle({ pitchAt: [daysAgo(days)] });
    await recompute();

    const base = (await intel())!;
    expect(base.confidence_level).toBe("moderate");
    // The base row knows exactly when the last activity was…
    expect(base.last_creator_activity_at).not.toBeNull();
    // …and the projection still refuses to band it.
    expect((await publicView())!.recency_band).toBeNull();
  });

  it("strong confidence STILL does not expose a reply rate publicly (D050)", async () => {
    await pitchedCycles(50, { replies: 25 });
    await recompute();

    const base = (await intel())!;
    expect(base.confidence_level).toBe("strong");
    // The derived truth is computed and stored…
    expect(Number(base.reply_rate)).toBeCloseTo(0.5, 4);

    // …and no public band discloses it. Before 0026, `strong` did.
    const view = (await publicView())!;
    expect(view).not.toHaveProperty("reply_rate");
    expect(view.activity_level).toBeNull(); // all activity is >90 days old
    expect(view.recency_band).toBe("older");
  });

  it("the recency band is coarse, never a raw timestamp", async () => {
    await pitchedCycles(15);
    for (const days of [45, 50, 55]) await cycle({ pitchAt: [daysAgo(days)] });
    await recompute();

    const view = (await publicView())!;
    expect(view.recency_band).toBe("past_quarter");
    expect(["past_month", "past_quarter", "older"]).toContain(view.recency_band);
    // Never the underlying instant, in any form.
    expect(JSON.stringify(view)).not.toMatch(/\d{4}-\d{2}-\d{2}|T\d{2}:/);
  });
});

d("AM — recompute ACL", () => {
  it("client roles cannot execute any aggregation function", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      for (const call of [
        `select public.recompute_hotel_intelligence('${HOTEL}')`,
        "select public.recompute_all_hotel_intelligence()",
      ]) {
        const res = await queryAs({ role, sub: role === "authenticated" ? USER : null }, call);
        expect(res.error).not.toBeNull();
        expect(res.error!.message).toMatch(/permission denied/i);
      }
    }
  });

  it("the ACL grants service_role only, and none is SECURITY DEFINER", async () => {
    const rows = await adminQuery<{
      proname: string;
      anon: boolean;
      authed: boolean;
      svc: boolean;
      public_exec: boolean;
      secdef: boolean;
      cfg: string | null;
    }>(
      `select
         p.proname,
         has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
         has_function_privilege('authenticated', p.oid, 'EXECUTE') as authed,
         has_function_privilege('service_role', p.oid, 'EXECUTE') as svc,
         aclcontains(coalesce(p.proacl, acldefault('f', p.proowner)),
                     makeaclitem(0::oid, p.proowner, 'EXECUTE', false)) as public_exec,
         p.prosecdef as secdef,
         array_to_string(p.proconfig, ',') as cfg
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname='public' and p.proname like 'recompute%'
      order by p.proname`,
    );
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.anon).toBe(false);
      expect(row.authed).toBe(false);
      expect(row.public_exec).toBe(false);
      expect(row.svc).toBe(true);
      expect(row.secdef).toBe(false);
      expect(row.cfg).toContain("search_path=public, pg_temp");
    }
  });
});

d("AN/AO/AP — derivation never edits its source", () => {
  it("recompute leaves events, pipeline items and collaborations byte-identical", async () => {
    const pitchAt = daysAgo(20);
    const itemId = await cycle({
      savedAt: daysAgo(21),
      pitchAt: [pitchAt],
      replyAt: [hoursAfter(pitchAt, 10)],
      classify: "positive",
      wonAt: [daysAgo(15)],
      status: "won",
    });
    const snapshot = async () => ({
      events: await adminQuery(
        "select id, event_type, event_at, metadata, created_at from public.outreach_events order by id",
      ),
      items: await adminQuery(
        "select id, status, saved_at, first_pitched_at, last_activity_at, updated_at from public.pipeline_items order by id",
      ),
      collaborations: await adminQuery(
        "select id, status, collaboration_type, agreed_at, updated_at from public.collaborations order by id",
      ),
    });

    const before = await snapshot();
    await recompute();
    await adminQuery("select public.recompute_all_hotel_intelligence()");
    const after = await snapshot();

    expect(after).toEqual(before);
  });

  it("the pipeline-item wrapper resolves the hotel itself and reports only a status", async () => {
    const itemId = await cycle({ pitchAt: [daysAgo(10)] });

    const rows = await adminQuery<{ r: Record<string, unknown> }>(
      "select public.recompute_hotel_intelligence_for_pipeline_item($1) as r",
      [itemId],
    );
    // A status and nothing else — no aggregate values leak through the hook.
    expect(rows[0]!.r).toEqual({ result: "recomputed" });
    expect((await intel())!.pitch_count).toBe(1);

    const missing = await adminQuery<{ r: Record<string, unknown> }>(
      "select public.recompute_hotel_intelligence_for_pipeline_item($1) as r",
      ["74000000-0000-0000-0000-0000000000ff"],
    );
    expect(missing[0]!.r).toEqual({ result: "pipeline_item_not_found" });
  });
});
