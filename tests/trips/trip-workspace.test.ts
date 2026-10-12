/**
 * D01 trip workspace against real Postgres (migration 0046).
 *
 * Proves the Free active-trip allowance, User A/B isolation, cross-tenant
 * linking, summary derivation (unknown is not zero), and that entitlement
 * expiry does not delete trips (D014).
 */
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { FREE_LIMITS } from "@/lib/config";
import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const U = {
  free: "d0100000-0000-0000-0000-000000000001",
  pro: "d0100000-0000-0000-0000-000000000002",
  dest: "d0100000-0000-0000-0000-000000000003",
  other: "d0100000-0000-0000-0000-000000000004",
} as const;

const DEST = {
  parent: "d0120000-0000-0000-0000-000000000001",
  child: "d0120000-0000-0000-0000-000000000002",
  outside: "d0120000-0000-0000-0000-000000000003",
} as const;

const HOTEL = {
  parent: "d0130000-0000-0000-0000-000000000001",
  child: "d0130000-0000-0000-0000-000000000002",
  outside: "d0130000-0000-0000-0000-000000000003",
} as const;

async function call(sql: string, params: unknown[]): Promise<Record<string, unknown>> {
  const rows = await adminQuery<{ r: Record<string, unknown> }>(sql, params);
  return rows[0]!.r;
}

function create(
  userId: string,
  destinationId: string,
  status = "planning",
  limit = FREE_LIMITS.activeTrips,
  start = "2026-11-01",
  end = "2026-11-08",
  name: string | null = null,
) {
  return call("select public.create_trip($1,$2,$3,$4::date,$5::date,$6,$7) as r", [
    userId,
    destinationId,
    name,
    start,
    end,
    status,
    limit,
  ]);
}

function update(
  userId: string,
  tripId: string,
  destinationId: string,
  status: string,
  limit = FREE_LIMITS.activeTrips,
  start = "2026-11-01",
  end = "2026-11-10",
) {
  return call("select public.update_trip($1,$2,$3,$4,$5::date,$6::date,$7,$8) as r", [
    userId,
    tripId,
    destinationId,
    null,
    start,
    end,
    status,
    limit,
  ]);
}

async function creatorId(userId: string): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    "select id from public.creator_profiles where user_id = $1",
    [userId],
  );
  return rows[0]!.id;
}

async function summary(userId: string, tripId: string) {
  return queryAs<{ r: Record<string, unknown> }>(
    { role: "authenticated", sub: userId },
    "select public.trip_workspace_summary($1) as r",
    [tripId],
  );
}

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  for (const id of Object.values(U)) {
    await adminQuery("insert into auth.users (id, email) values ($1,$2)", [id, `${id}@t.local`]);
  }
  await adminQuery(
    `insert into public.destinations (id, name, slug, type, country_code) values
       ($1,'D01 Parent','d01-parent','island','ID'),
       ($2,'D01 Outside','d01-outside','city','AE')`,
    [DEST.parent, DEST.outside],
  );
  await adminQuery(
    `insert into public.destinations (id, name, slug, type, country_code, parent_destination_id)
       values ($1,'D01 Child','d01-child','area','ID',$2)`,
    [DEST.child, DEST.parent],
  );
  await adminQuery(
    `insert into public.hotels (id, name, slug, destination_id) values
       ($1,'D01 Parent Hotel','d01-parent-hotel',$2),
       ($3,'D01 Child Hotel','d01-child-hotel',$4),
       ($5,'D01 Outside Hotel','d01-outside-hotel',$6)`,
    [HOTEL.parent, DEST.parent, HOTEL.child, DEST.child, HOTEL.outside, DEST.outside],
  );
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
  if (!hasTestDb) return;
  await teardownDatabase();
});

beforeEach(async () => {
  if (!hasTestDb) return;
  await adminQuery(
    "delete from public.outreach_events where creator_id in (select id from public.creator_profiles where user_id = any($1::uuid[]))",
    [Object.values(U)],
  );
  await adminQuery(
    "delete from public.collaborations where creator_id in (select id from public.creator_profiles where user_id = any($1::uuid[]))",
    [Object.values(U)],
  );
  await adminQuery(
    "delete from public.pipeline_items where creator_id in (select id from public.creator_profiles where user_id = any($1::uuid[]))",
    [Object.values(U)],
  );
  await adminQuery(
    "delete from public.trips where creator_id in (select id from public.creator_profiles where user_id = any($1::uuid[]))",
    [Object.values(U)],
  );
});

d("D01 — Free active-trip allowance", () => {
  it("allows one counting trip and rejects the next", async () => {
    const first = await create(U.free, DEST.outside, "planning");
    expect(first.result).toBe("created");
    const second = await create(U.free, DEST.outside, "upcoming");
    expect(second.result).toBe("limit_reached");
    expect(second.limit).toBe(FREE_LIMITS.activeTrips);
    expect(second.active_count).toBe(1);

    const rows = await adminQuery<{ n: string }>(
      `select count(*)::text as n from public.trips t
         join public.creator_profiles cp on cp.id = t.creator_id
        where cp.user_id = $1`,
      [U.free],
    );
    expect(rows[0]!.n).toBe("1");
  });

  it("does not count completed or cancelled trips, and re-checks on reactivation", async () => {
    const history = await create(U.free, DEST.outside, "completed");
    expect(history.result).toBe("created");
    const current = await create(U.free, DEST.outside, "active");
    expect(current.result).toBe("created");

    const reactivated = await update(U.free, String(history.trip_id), DEST.outside, "planning");
    expect(reactivated.result).toBe("limit_reached");

    const cancelled = await update(U.free, String(current.trip_id), DEST.outside, "cancelled");
    expect(cancelled.result).toBe("updated");
    const nowPlanning = await update(U.free, String(history.trip_id), DEST.outside, "planning");
    expect(nowPlanning.result).toBe("updated");
  });

  it("lets a Free user retarget their single counting trip and still blocks a second", async () => {
    const created = await create(U.free, DEST.outside, "planning");
    expect(created.result).toBe("created");

    const moved = await update(U.free, String(created.trip_id), DEST.parent, "upcoming");
    expect(moved.result).toBe("updated");
    const rows = await adminQuery<{ destination_id: string; status: string }>(
      "select destination_id, status from public.trips where id = $1",
      [created.trip_id],
    );
    expect(rows[0]).toMatchObject({ destination_id: DEST.parent, status: "upcoming" });

    const second = await create(U.free, DEST.outside, "planning");
    expect(second.result).toBe("limit_reached");
    expect(
      (
        await adminQuery<{ n: string }>(
          `select count(*)::text as n from public.trips t
             join public.creator_profiles cp on cp.id = t.creator_id
            where cp.user_id = $1`,
          [U.free],
        )
      )[0]!.n,
    ).toBe("1");
  });

  it("still lets the owner edit the one active trip", async () => {
    const created = await create(
      U.free,
      DEST.outside,
      "planning",
      FREE_LIMITS.activeTrips,
      "2026-11-01",
      "2026-11-08",
      "Week",
    );
    const edited = await update(U.free, String(created.trip_id), DEST.outside, "upcoming");
    expect(edited.result).toBe("updated");
    const rows = await adminQuery<{ status: string; visibility: string; name: string }>(
      "select status, visibility, name from public.trips where id = $1",
      [created.trip_id],
    );
    expect(rows[0]).toMatchObject({ status: "upcoming", visibility: "private" });
  });

  it("keeps visibility untouched when details change", async () => {
    const created = await create(U.free, DEST.outside);
    await adminQuery("update public.trips set visibility = 'public' where id = $1", [
      created.trip_id,
    ]);
    await update(U.free, String(created.trip_id), DEST.outside, "planning");
    const rows = await adminQuery<{ visibility: string }>(
      "select visibility from public.trips where id = $1",
      [created.trip_id],
    );
    expect(rows[0]!.visibility).toBe("public");
  });

  it("rejects a reversed date range in the database", async () => {
    const res = await create(
      U.free,
      DEST.outside,
      "planning",
      FREE_LIMITS.activeTrips,
      "2026-12-10",
      "2026-12-01",
    );
    expect(res.result).toBe("invalid_input");
  });

  it("concurrent creates cannot both take the single Free slot", async () => {
    const a = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    const b = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await a.connect();
    await b.connect();
    try {
      const sql = "select public.create_trip($1,$2,$3,$4::date,$5::date,$6,$7) as r";
      const args = [
        U.free,
        DEST.outside,
        null,
        "2026-11-01",
        "2026-11-08",
        "planning",
        FREE_LIMITS.activeTrips,
      ];
      const [ra, rb] = await Promise.all([a.query(sql, args), b.query(sql, args)]);
      const results = [ra.rows[0].r.result, rb.rows[0].r.result].sort();
      expect(results).toEqual(["created", "limit_reached"]);
    } finally {
      await a.end();
      await b.end();
    }
  });
});

d("D01 — entitlement exemption and expiry retention", () => {
  it("Pro can hold more than one active trip", async () => {
    for (const status of ["planning", "upcoming", "active"]) {
      expect((await create(U.pro, DEST.outside, status)).result).toBe("created");
    }
  });

  it("a destination pass is exempt inside the entitled hierarchy and keeps one Free trip outside", async () => {
    expect((await create(U.dest, DEST.parent)).result).toBe("created");
    expect((await create(U.dest, DEST.child, "upcoming")).result).toBe("created");
    // Covered trips do not consume the outside Free allowance (D056).
    const outside = await create(U.dest, DEST.outside, "planning");
    expect(outside.result).toBe("created");
    const secondOutside = await create(U.dest, DEST.outside, "active");
    expect(secondOutside.result).toBe("limit_reached");
    expect(secondOutside.limit).toBe(FREE_LIMITS.activeTrips);
    expect(secondOutside.active_count).toBe(1);
  });

  it("moves one inside trip outside on the Free allowance and refuses a second", async () => {
    const first = await create(U.dest, DEST.parent, "planning");
    const second = await create(U.dest, DEST.child, "active");
    expect(first.result).toBe("created");
    expect(second.result).toBe("created");

    const moved = await update(U.dest, String(first.trip_id), DEST.outside, "planning");
    expect(moved.result).toBe("updated");
    const stayed = await adminQuery<{ destination_id: string; status: string }>(
      "select destination_id, status from public.trips where id = $1",
      [first.trip_id],
    );
    expect(stayed[0]).toMatchObject({ destination_id: DEST.outside, status: "planning" });

    const alsoMoved = await update(U.dest, String(second.trip_id), DEST.outside, "upcoming");
    expect(alsoMoved.result).toBe("limit_reached");
    expect(alsoMoved.limit).toBe(FREE_LIMITS.activeTrips);
    const secondRow = await adminQuery<{ destination_id: string }>(
      "select destination_id from public.trips where id = $1",
      [second.trip_id],
    );
    expect(secondRow[0]!.destination_id).toBe(DEST.child);
  });

  it("lets a pass holder retarget their only counting trip outside the pass", async () => {
    const only = await create(U.dest, DEST.parent, "planning");
    expect(only.result).toBe("created");
    const moved = await update(U.dest, String(only.trip_id), DEST.outside, "upcoming");
    expect(moved.result).toBe("updated");
    const row = await adminQuery<{ destination_id: string }>(
      "select destination_id from public.trips where id = $1",
      [only.trip_id],
    );
    expect(row[0]!.destination_id).toBe(DEST.outside);
  });

  it("re-checks reactivation onto an outside destination against outside trips only", async () => {
    const current = await create(U.dest, DEST.parent, "active");
    const history = await create(U.dest, DEST.child, "completed");
    expect(current.result).toBe("created");
    expect(history.result).toBe("created");

    const reactivated = await update(U.dest, String(history.trip_id), DEST.outside, "planning");
    expect(reactivated.result).toBe("updated");

    const older = await create(U.dest, DEST.child, "completed");
    expect(older.result).toBe("created");
    const blocked = await update(U.dest, String(older.trip_id), DEST.outside, "planning");
    expect(blocked.result).toBe("limit_reached");
    const row = await adminQuery<{ destination_id: string; status: string }>(
      "select destination_id, status from public.trips where id = $1",
      [older.trip_id],
    );
    expect(row[0]).toMatchObject({ destination_id: DEST.child, status: "completed" });
  });

  it("keeps an already-counting trip editable after the pass is revoked", async () => {
    const inside = await create(U.dest, DEST.parent, "planning");
    const alsoInside = await create(U.dest, DEST.child, "active");
    expect(inside.result).toBe("created");
    expect(alsoInside.result).toBe("created");

    await adminQuery(
      "update public.access_entitlements set status = 'revoked' where user_id = $1 and access_type = 'destination'",
      [U.dest],
    );
    try {
      const edited = await update(U.dest, String(inside.trip_id), DEST.parent, "upcoming");
      expect(edited.result).toBe("updated");
      const moved = await update(U.dest, String(inside.trip_id), DEST.outside, "upcoming");
      expect(moved.result).toBe("updated");
    } finally {
      await adminQuery(
        "update public.access_entitlements set status = 'active' where user_id = $1 and access_type = 'destination'",
        [U.dest],
      );
    }
  });

  it("a pass does not remove the Free slot when no trip exists yet", async () => {
    expect((await create(U.dest, DEST.outside)).result).toBe("created");
    expect((await create(U.dest, DEST.parent)).result).toBe("created");
  });

  it("revoking Pro does not delete trips and blocks only a new counting trip", async () => {
    const first = await create(U.pro, DEST.outside, "planning");
    const second = await create(U.pro, DEST.parent, "active");
    expect(first.result).toBe("created");
    expect(second.result).toBe("created");

    await adminQuery(
      "update public.access_entitlements set status = 'revoked' where user_id = $1 and access_type = 'pro'",
      [U.pro],
    );
    try {
      const still = await adminQuery<{ n: string }>(
        "select count(*)::text as n from public.trips where id = any($1::uuid[])",
        [[first.trip_id, second.trip_id]],
      );
      expect(still[0]!.n).toBe("2");

      const third = await create(U.pro, DEST.outside, "planning");
      expect(third.result).toBe("limit_reached");

      const edited = await update(U.pro, String(first.trip_id), DEST.outside, "upcoming");
      expect(edited.result).toBe("updated");
      expect(
        (await adminQuery("select id from public.trips where id = $1", [second.trip_id])).length,
      ).toBe(1);
    } finally {
      await adminQuery(
        "update public.access_entitlements set status = 'active' where user_id = $1 and access_type = 'pro'",
        [U.pro],
      );
    }
  });
});

d("D01 — shortlist, linking, and cross-tenant fences", () => {
  it("shortlists only a canonical hotel, on the caller's own trip", async () => {
    const trip = await create(U.free, DEST.outside);
    const added = await call("select public.add_trip_hotel($1,$2,$3) as r", [
      U.free,
      trip.trip_id,
      HOTEL.outside,
    ]);
    expect(added.result).toBe("added");
    const again = await call("select public.add_trip_hotel($1,$2,$3) as r", [
      U.free,
      trip.trip_id,
      HOTEL.outside,
    ]);
    expect(again.result).toBe("already_shortlisted");

    const missing = await call("select public.add_trip_hotel($1,$2,$3) as r", [
      U.free,
      trip.trip_id,
      "d0130000-0000-0000-0000-000000000099",
    ]);
    expect(missing.result).toBe("hotel_not_found");

    const otherTrip = await create(U.other, DEST.parent);
    const cross = await call("select public.add_trip_hotel($1,$2,$3) as r", [
      U.free,
      otherTrip.trip_id,
      HOTEL.parent,
    ]);
    expect(cross.result).toBe("not_found");
    const leaked = await adminQuery(
      "select id from public.trip_hotels where trip_id = $1 and hotel_id = $2",
      [otherTrip.trip_id, HOTEL.parent],
    );
    expect(leaked).toHaveLength(0);

    // The same canonical hotel may be shortlisted by both creators.
    expect(
      (
        await call("select public.add_trip_hotel($1,$2,$3) as r", [
          U.other,
          otherTrip.trip_id,
          HOTEL.parent,
        ])
      ).result,
    ).toBe("added");
  });

  it("links only the caller's pipeline item to the caller's trip", async () => {
    const aTrip = await create(U.free, DEST.outside);
    const bTrip = await create(U.other, DEST.parent);
    const aCreator = await creatorId(U.free);
    const bCreator = await creatorId(U.other);
    const [aItem] = await adminQuery<{ id: string }>(
      "insert into public.pipeline_items (creator_id, hotel_id, status) values ($1,$2,'saved') returning id",
      [aCreator, HOTEL.outside],
    );
    const [bItem] = await adminQuery<{ id: string }>(
      "insert into public.pipeline_items (creator_id, hotel_id, status) values ($1,$2,'pitched') returning id",
      [bCreator, HOTEL.parent],
    );

    const linked = await call("select public.link_pipeline_item_to_trip($1,$2,$3) as r", [
      U.free,
      aItem!.id,
      aTrip.trip_id,
    ]);
    expect(linked.result).toBe("linked");

    const stealItem = await call("select public.link_pipeline_item_to_trip($1,$2,$3) as r", [
      U.free,
      bItem!.id,
      aTrip.trip_id,
    ]);
    expect(stealItem.result).toBe("not_found");
    const stealTrip = await call("select public.link_pipeline_item_to_trip($1,$2,$3) as r", [
      U.free,
      aItem!.id,
      bTrip.trip_id,
    ]);
    expect(stealTrip.result).toBe("not_found");

    const aRow = await adminQuery<{ trip_id: string }>(
      "select trip_id from public.pipeline_items where id = $1",
      [aItem!.id],
    );
    const bRow = await adminQuery<{ trip_id: string | null }>(
      "select trip_id from public.pipeline_items where id = $1",
      [bItem!.id],
    );
    expect(aRow[0]!.trip_id).toBe(aTrip.trip_id);
    expect(bRow[0]!.trip_id).toBeNull();

    await expect(
      adminQuery("update public.pipeline_items set trip_id = $1 where id = $2", [
        bTrip.trip_id,
        aItem!.id,
      ]),
    ).rejects.toThrow(/same creator/);
    const after = await adminQuery<{ trip_id: string }>(
      "select trip_id from public.pipeline_items where id = $1",
      [aItem!.id],
    );
    expect(after[0]!.trip_id).toBe(aTrip.trip_id);
  });

  it("rejects a trip creator change that would leave a cross-tenant pipeline link", async () => {
    const trip = await create(U.free, DEST.outside);
    const owner = await creatorId(U.free);
    const other = await creatorId(U.other);
    const [item] = await adminQuery<{ id: string }>(
      "insert into public.pipeline_items (creator_id, hotel_id, trip_id, status) values ($1,$2,$3,'saved') returning id",
      [owner, HOTEL.outside, trip.trip_id],
    );

    await expect(
      adminQuery("update public.trips set creator_id = $1 where id = $2", [other, trip.trip_id]),
    ).rejects.toThrow(/same creator/);

    const tripRow = await adminQuery<{ creator_id: string }>(
      "select creator_id from public.trips where id = $1",
      [trip.trip_id],
    );
    const itemRow = await adminQuery<{ creator_id: string; trip_id: string }>(
      "select creator_id, trip_id from public.pipeline_items where id = $1",
      [item!.id],
    );
    expect(tripRow[0]!.creator_id).toBe(owner);
    expect(itemRow[0]).toMatchObject({ creator_id: owner, trip_id: trip.trip_id });
  });

  it("deleting a trip unlinks pipeline items and does not delete them", async () => {
    const trip = await create(U.free, DEST.outside);
    const creator = await creatorId(U.free);
    const [item] = await adminQuery<{ id: string }>(
      "insert into public.pipeline_items (creator_id, hotel_id, trip_id) values ($1,$2,$3) returning id",
      [creator, HOTEL.outside, trip.trip_id],
    );
    expect(
      (await call("select public.delete_trip($1,$2) as r", [U.free, trip.trip_id])).result,
    ).toBe("deleted");
    const rows = await adminQuery<{ trip_id: string | null }>(
      "select trip_id from public.pipeline_items where id = $1",
      [item!.id],
    );
    expect(rows[0]!.trip_id).toBeNull();
    expect(
      (await call("select public.delete_trip($1,$2) as r", [U.other, trip.trip_id])).result,
    ).toBe("not_found");
  });

  it("anon and the other creator cannot read or write the trip", async () => {
    const trip = await create(U.free, DEST.outside);
    const anon = await queryAs({ role: "anon" }, "select id from public.trips");
    expect(anon.error).not.toBeNull();

    const other = await queryAs(
      { role: "authenticated", sub: U.other },
      "select id from public.trips where id = $1",
      [trip.trip_id],
    );
    expect(other.error).toBeNull();
    expect(other.rows).toHaveLength(0);

    const write = await queryAs(
      { role: "authenticated", sub: U.free },
      "insert into public.trips (creator_id, destination_id, start_date, end_date) values ($1,$2,'2026-01-01','2026-01-02')",
      [await creatorId(U.free), DEST.outside],
    );
    expect(write.error).not.toBeNull();
    expect(write.error!.message).toMatch(/permission denied/i);

    for (const role of ["anon", "authenticated"] as const) {
      const res = await queryAs(
        { role, sub: role === "authenticated" ? U.free : null },
        "select public.create_trip($1,$2,$3,$4::date,$5::date,$6,$7)",
        [U.free, DEST.outside, null, "2026-11-01", "2026-11-08", "planning", 1],
      );
      expect(res.error).not.toBeNull();
      expect(res.error!.message).toMatch(/permission denied/i);
    }
  });
});

d("D01 — summary derivation", () => {
  it("is unknown when nothing is linked, even if the shortlist has hotels", async () => {
    const trip = await create(U.free, DEST.outside);
    await call("select public.add_trip_hotel($1,$2,$3) as r", [
      U.free,
      trip.trip_id,
      HOTEL.outside,
    ]);
    const res = await summary(U.free, String(trip.trip_id));
    expect(res.error).toBeNull();
    const body = res.rows[0]!.r;
    expect(body.result).toBe("ok");
    expect(body.target_hotels).toBeNull();
    expect(body.pitched).toBeNull();
    expect(body.replies).toBeNull();
    expect(body.negotiations).toBeNull();
    expect(body.confirmed_collaborations).toBeNull();
    expect(body.followups_due).toBeNull();
  });

  it("counts real zeros and does not treat a follow-up as a reply", async () => {
    const trip = await create(U.free, DEST.outside);
    const creator = await creatorId(U.free);
    await adminQuery(
      `insert into public.pipeline_items
         (creator_id, hotel_id, trip_id, status, first_pitched_at, next_followup_at)
       values ($1,$2,$3,'follow_up', now() - interval '2 days', now() + interval '3 days')`,
      [creator, HOTEL.outside, trip.trip_id],
    );
    const body = (await summary(U.free, String(trip.trip_id))).rows[0]!.r;
    expect(body.target_hotels).toBe(1);
    expect(body.pitched).toBe(1);
    expect(body.replies).toBe(0);
    expect(body.negotiations).toBe(0);
    expect(body.confirmed_collaborations).toBe(0);
    expect(body.followups_due).toBe(0);
  });

  it("derives negotiations, replies, confirmed collaborations and due follow-ups", async () => {
    const trip = await create(U.free, DEST.outside);
    const creator = await creatorId(U.free);
    const [negotiating] = await adminQuery<{ id: string }>(
      `insert into public.pipeline_items (creator_id, hotel_id, trip_id, status, first_pitched_at)
       values ($1,$2,$3,'negotiating', now() - interval '4 days') returning id`,
      [creator, HOTEL.outside, trip.trip_id],
    );
    const [won] = await adminQuery<{ id: string }>(
      `insert into public.pipeline_items
         (creator_id, hotel_id, trip_id, status, first_pitched_at, next_followup_at)
       values ($1,$2,$3,'won', now() - interval '9 days', now() - interval '1 hour') returning id`,
      [creator, HOTEL.parent, trip.trip_id],
    );
    await adminQuery(
      `insert into public.outreach_events
         (creator_id, hotel_id, pipeline_item_id, event_type, event_at)
       values ($1,$2,$3,'reply_received', now() - interval '3 days')`,
      [creator, HOTEL.outside, negotiating!.id],
    );
    await adminQuery(
      `insert into public.collaborations (creator_id, hotel_id, pipeline_item_id, status)
       values ($1,$2,$3,'agreed')`,
      [creator, HOTEL.parent, won!.id],
    );

    const body = (await summary(U.free, String(trip.trip_id))).rows[0]!.r;
    expect(body.target_hotels).toBe(2);
    expect(body.pitched).toBe(2);
    expect(body.replies).toBe(2);
    expect(body.negotiations).toBe(1);
    expect(body.confirmed_collaborations).toBe(1);
    expect(body.followups_due).toBe(1);

    await adminQuery(
      "update public.collaborations set status = 'cancelled' where pipeline_item_id = $1",
      [won!.id],
    );
    const after = (await summary(U.free, String(trip.trip_id))).rows[0]!.r;
    expect(after.confirmed_collaborations).toBe(0);
  });

  it("does not return another creator's summary", async () => {
    const trip = await create(U.free, DEST.outside);
    const res = await summary(U.other, String(trip.trip_id));
    expect(res.error).toBeNull();
    expect(res.rows[0]!.r.result).toBe("not_found");

    const anon = await queryAs({ role: "anon" }, "select public.trip_workspace_summary($1)", [
      trip.trip_id,
    ]);
    expect(anon.error).not.toBeNull();
  });
});
