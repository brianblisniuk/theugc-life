/**
 * D115 on real Postgres. User A cannot read or change User B's deliverable
 * deadline, and anon cannot read the table or the function.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const USER_A = "a0211111-1111-4111-8111-111111111111";
const USER_B = "b0222222-2222-4222-8222-222222222222";
const DEST = "c0233333-3333-4333-8333-333333333333";
const HOTEL_A = "d0244444-4444-4444-8444-444444444441";
const HOTEL_B = "d0244444-4444-4444-8444-444444444442";
const HOTEL_C = "d0244444-4444-4444-8444-444444444443";

async function call(sql: string, params: unknown[] = []): Promise<Record<string, unknown>> {
  const rows = await adminQuery<{ r: Record<string, unknown> }>(sql, params);
  return rows[0]!.r;
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

async function win(userId: string, hotelId: string): Promise<string> {
  const saved = await call("select public.save_hotel_to_pipeline($1,$2,50) as r", [
    userId,
    hotelId,
  ]);
  expect(saved.result).toBe("created");
  const itemId = saved.pipeline_item_id as string;
  expect(
    (
      await call(
        "select public.transition_pipeline_item($1,$2,'mark_pitched',$3,'email',null,null,null,50) as r",
        [userId, itemId, daysAgo(4)],
      )
    ).result,
  ).toBe("applied");
  expect(
    (
      await call(
        "select public.transition_pipeline_item($1,$2,'mark_replied',$3,null,'positive',null,null,50) as r",
        [userId, itemId, daysAgo(3)],
      )
    ).result,
  ).toBe("applied");
  expect(
    (
      await call("select public.progress_pipeline_deal($1,$2,'start_negotiation',null,null) as r", [
        userId,
        itemId,
      ])
    ).result,
  ).toBe("applied");
  expect(
    (
      await call("select public.progress_pipeline_deal($1,$2,'mark_won',$3,'stay') as r", [
        userId,
        itemId,
        daysAgo(1),
      ])
    ).result,
  ).toBe("applied");
  return itemId;
}

function addDeliverable(userId: string, itemId: string, status: string, dueOn: string | null) {
  return call(
    `select public.upsert_collaboration_deliverable($1,$2,null,'reel',1,null,$3,$4,null,null) as r`,
    [userId, itemId, dueOn, status],
  );
}

async function list(userId: string, limit = 80) {
  return queryAs<{ r: Record<string, unknown> }>(
    { role: "authenticated", sub: userId },
    "select public.list_own_deliverable_deadlines($1) as r",
    [limit],
  );
}

function idsOf(payload: Record<string, unknown> | undefined): string[] {
  const rows = payload?.deliverables;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => String((row as { id?: unknown }).id));
}

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  for (const id of [USER_A, USER_B]) {
    await adminQuery("insert into auth.users (id, email) values ($1,$2)", [id, `${id}@g02.test`]);
  }
  await adminQuery(
    "insert into public.destinations (id, name, slug, type) values ($1,'G02 Town','g02-town','city')",
    [DEST],
  );
  for (const [id, name, slug] of [
    [HOTEL_A, "G02 Hotel A", "g02-hotel-a"],
    [HOTEL_B, "G02 Hotel B", "g02-hotel-b"],
    [HOTEL_C, "G02 Hotel C", "g02-hotel-c"],
  ] as const) {
    await adminQuery(
      "insert into public.hotels (id, name, slug, destination_id) values ($1,$2,$3,$4)",
      [id, name, slug, DEST],
    );
  }
}, 120_000);

afterAll(async () => {
  await teardownDatabase();
});

d("deliverable deadline isolation", () => {
  it("returns only the caller's dated pending and rejected rows, as calendar days", async () => {
    const itemA = await win(USER_A, HOTEL_A);
    const itemB = await win(USER_B, HOTEL_B);
    const overdue = await addDeliverable(USER_A, itemA, "pending", "2026-10-01");
    const today = await addDeliverable(USER_A, itemA, "rejected", "2026-10-13");
    const upcoming = await addDeliverable(USER_A, itemA, "pending", "2026-12-01");
    const submitted = await addDeliverable(USER_A, itemA, "submitted", "2026-01-01");
    const undated = await addDeliverable(USER_A, itemA, "pending", null);
    const foreign = await addDeliverable(USER_B, itemB, "pending", "2026-10-01");
    expect(overdue.result).toBe("saved");
    expect(today.result).toBe("saved");
    expect(upcoming.result).toBe("saved");
    expect(submitted.result).toBe("saved");
    expect(undated.result).toBe("saved");
    expect(foreign.result).toBe("saved");

    const own = await list(USER_A);
    expect(own.error).toBeNull();
    expect(own.rows[0]!.r.result).toBe("ok");
    expect(own.rows[0]!.r.truncated).toBe(false);
    const ownIds = idsOf(own.rows[0]!.r);
    expect(ownIds).toEqual([overdue.deliverable_id, today.deliverable_id, upcoming.deliverable_id]);
    expect(ownIds).not.toContain(submitted.deliverable_id);
    expect(ownIds).not.toContain(undated.deliverable_id);
    expect(ownIds).not.toContain(foreign.deliverable_id);
    const rows = own.rows[0]!.r.deliverables as { due_on: string; status: string }[];
    expect(rows.map((row) => row.due_on)).toEqual(["2026-10-01", "2026-10-13", "2026-12-01"]);
    expect(rows.map((row) => row.status)).toEqual(["pending", "rejected", "pending"]);

    const other = await list(USER_B);
    expect(other.error).toBeNull();
    expect(idsOf(other.rows[0]!.r)).toEqual([foreign.deliverable_id]);
    expect(JSON.stringify(other.rows)).not.toContain(String(overdue.deliverable_id));
  });

  it("refuses anon and a limit outside 1..80", async () => {
    const anon = await queryAs(
      { role: "anon", sub: null },
      "select public.list_own_deliverable_deadlines(80)",
    );
    expect(anon.error).not.toBeNull();
    const anonTable = await queryAs(
      { role: "anon", sub: null },
      "select id from public.collaboration_deliverables",
    );
    expect(anonTable.error).not.toBeNull();

    const low = await list(USER_A, 0);
    expect(low.error).toBeNull();
    expect(low.rows[0]!.r.result).toBe("invalid_input");
    const high = await list(USER_A, 81);
    expect(high.rows[0]!.r.result).toBe("invalid_input");
    const missing = await queryAs<{ r: { result: string } }>(
      { role: "authenticated", sub: USER_A },
      "select public.list_own_deliverable_deadlines(null) as r",
    );
    expect(missing.rows[0]!.r.result).toBe("invalid_input");

    const grants = await adminQuery<{
      prosecdef: boolean;
      cfg: string | null;
      anon: boolean;
      auth: boolean;
      public_exec: boolean;
    }>(
      `select p.prosecdef,
              array_to_string(p.proconfig, ',') as cfg,
              has_function_privilege('anon', p.oid, 'EXECUTE') as anon,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth,
              has_function_privilege('public', p.oid, 'EXECUTE') as public_exec
         from pg_proc p
         join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'list_own_deliverable_deadlines'`,
    );
    expect(grants[0]).toMatchObject({
      prosecdef: false,
      anon: false,
      auth: true,
      public_exec: false,
    });
    expect(grants[0]!.cfg).toContain("search_path=");
  });

  it("does not let User A insert, update, or delete User B's deadline", async () => {
    const foreign = await adminQuery<{ id: string; due_on: string }>(
      `select d.id, d.due_on::text as due_on
         from public.collaboration_deliverables d
         join public.creator_profiles cp on cp.id = d.creator_id
        where cp.user_id = $1`,
      [USER_B],
    );
    const target = foreign[0]!;
    const item = await adminQuery<{ pipeline_item_id: string }>(
      "select pipeline_item_id from public.collaboration_deliverables where id = $1",
      [target.id],
    );

    const read = await queryAs(
      { role: "authenticated", sub: USER_A },
      "select id, due_on::text as due_on from public.collaboration_deliverables where id = $1",
      [target.id],
    );
    expect(read.error).toBeNull();
    expect(read.rows).toEqual([]);

    const updated = await queryAs(
      { role: "authenticated", sub: USER_A },
      "update public.collaboration_deliverables set due_on = '1999-01-01' where id = $1",
      [target.id],
    );
    expect(updated.error).not.toBeNull();

    const removed = await queryAs(
      { role: "authenticated", sub: USER_A },
      "delete from public.collaboration_deliverables where id = $1",
      [target.id],
    );
    expect(removed.error).not.toBeNull();

    const creatorB = await adminQuery<{ id: string }>(
      "select id from public.creator_profiles where user_id = $1",
      [USER_B],
    );
    const inserted = await queryAs(
      { role: "authenticated", sub: USER_A },
      `insert into public.collaboration_deliverables
         (creator_id, collaboration_id, pipeline_item_id, deliverable_type, quantity, due_on, status)
       select creator_id, collaboration_id, pipeline_item_id, 'reel', 1, '1999-01-01', 'pending'
         from public.collaboration_deliverables where id = $1`,
      [target.id],
    );
    expect(inserted.error).not.toBeNull();
    expect(creatorB[0]!.id).toBeTruthy();

    const rpc = await call(
      `select public.upsert_collaboration_deliverable($1,$2,$3,'reel',1,null,'1999-01-01','pending',null,null) as r`,
      [USER_A, item[0]!.pipeline_item_id, target.id],
    );
    expect(rpc.result).toBe("not_found");

    const still = await adminQuery<{ due_on: string; n: string }>(
      `select due_on::text as due_on,
              (select count(*)::text from public.collaboration_deliverables where creator_id = $2) as n
         from public.collaboration_deliverables where id = $1`,
      [target.id, creatorB[0]!.id],
    );
    expect(still[0]!.due_on).toBe(target.due_on);
    expect(still[0]!.n).toBe(String(foreign.length));
  });

  it("caps the read at 80 and says the list is truncated", async () => {
    const item = await win(USER_A, HOTEL_C);
    const creator = await adminQuery<{ id: string; collaboration_id: string }>(
      `select d.id, c.id as collaboration_id
         from public.collaborations c
         join public.creator_profiles d on d.id = c.creator_id
        where c.pipeline_item_id = $1`,
      [item],
    );
    await adminQuery(
      `insert into public.collaboration_deliverables
         (creator_id, collaboration_id, pipeline_item_id, deliverable_type, quantity, due_on, status)
       select $1, $2, $3, 'reel', 1, ('2027-01-01'::date + g.i), 'pending'
         from generate_series(0, 80) as g(i)`,
      [creator[0]!.id, creator[0]!.collaboration_id, item],
    );
    const listed = await list(USER_A);
    expect(listed.error).toBeNull();
    expect(listed.rows[0]!.r.result).toBe("ok");
    expect(listed.rows[0]!.r.truncated).toBe(true);
    expect(idsOf(listed.rows[0]!.r)).toHaveLength(80);
    const dates = (listed.rows[0]!.r.deliverables as { due_on: string }[]).map((row) => row.due_on);
    expect(dates[0]! < dates[dates.length - 1]!).toBe(true);
    expect(dates).not.toContain("2027-03-23");
  });
});
