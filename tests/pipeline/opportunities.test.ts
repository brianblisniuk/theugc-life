/**
 * V2-D1 opportunity model (migration 0097, D182–D187).
 *
 * Real Postgres. Proves the overlap rule, per-creator display ids, trip
 * nights, Gmail suggestions that do not write dates, outreach shortlist
 * copy, revision_requested, tenant isolation, and account erasure.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { coverNights } from "@/lib/trips/nights";
import {
  adminQuery,
  commitAs,
  hasTestDb,
  queryAs,
  setupDatabase,
  teardownDatabase,
} from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const U = {
  a: "d2d10000-0000-0000-0000-000000000001",
  b: "d2d10000-0000-0000-0000-000000000002",
} as const;

const DEST = "d2d12000-0000-0000-0000-000000000001";
const HOTEL = Array.from({ length: 6 }, (_, i) => `d2d13000-0000-0000-0000-00000000000${i + 1}`);
const MAIL = {
  a: "d2d14000-0000-0000-0000-000000000001",
  b: "d2d14000-0000-0000-0000-000000000002",
} as const;

async function call(sql: string, params: unknown[] = []): Promise<Record<string, unknown>> {
  const rows = await adminQuery<{ r: Record<string, unknown> }>(sql, params);
  return rows[0]!.r;
}

async function creatorId(userId: string): Promise<string> {
  const rows = await adminQuery<{ id: string }>(
    "select id from public.creator_profiles where user_id = $1",
    [userId],
  );
  return rows[0]!.id;
}

function save(userId: string, hotelId: string, limit = 50) {
  return call("select public.save_hotel_to_pipeline($1,$2,$3) as r", [userId, hotelId, limit]);
}

function openOpp(
  userId: string,
  hotelId: string,
  tripId: string | null,
  start: string | null,
  end: string | null,
  initiative: string | null = null,
  limit = 50,
) {
  return call("select public.open_pipeline_opportunity($1,$2,$3,$4::date,$5::date,$6,$7) as r", [
    userId,
    hotelId,
    tripId,
    start,
    end,
    initiative,
    limit,
  ]);
}

function createTrip(userId: string, start: string, end: string) {
  return call("select public.create_trip($1,$2,$3,$4::date,$5::date,$6,$7) as r", [
    userId,
    DEST,
    null,
    start,
    end,
    "planning",
    20,
  ]);
}

async function clean(): Promise<void> {
  const ids = await adminQuery<{ id: string }>(
    "select id from public.creator_profiles where user_id = any($1::uuid[])",
    [[U.a, U.b]],
  );
  const creators = ids.map((row) => row.id);
  if (creators.length === 0) return;
  await adminQuery("delete from public.stay_date_suggestions where creator_id = any($1::uuid[])", [
    creators,
  ]);
  await adminQuery(
    "delete from public.collaboration_deliverables where creator_id = any($1::uuid[])",
    [creators],
  );
  await adminQuery(
    "delete from public.collaboration_compensation_suggestions where creator_id = any($1::uuid[])",
    [creators],
  );
  await adminQuery(
    "delete from public.collaboration_agreed_compensations where creator_id = any($1::uuid[])",
    [creators],
  );
  await adminQuery("delete from public.collaborations where creator_id = any($1::uuid[])", [
    creators,
  ]);
  await adminQuery("delete from public.outreach_events where creator_id = any($1::uuid[])", [
    creators,
  ]);
  await adminQuery("delete from public.outreach_initiatives where creator_id = any($1::uuid[])", [
    creators,
  ]);
  await adminQuery("delete from public.pipeline_items where creator_id = any($1::uuid[])", [
    creators,
  ]);
  await adminQuery("delete from public.trips where creator_id = any($1::uuid[])", [creators]);
  await adminQuery(
    "delete from public.pipeline_opportunity_counters where creator_id = any($1::uuid[])",
    [creators],
  );
}

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  for (const id of Object.values(U)) {
    await adminQuery("insert into auth.users (id, email) values ($1, $2)", [id, `${id}@t.local`]);
  }
  await adminQuery(
    `insert into public.destinations (id, name, slug, type, country_code)
     values ($1, 'V2 Island', 'v2-island', 'island', 'ID')`,
    [DEST],
  );
  for (const [index, id] of HOTEL.entries()) {
    await adminQuery(
      "insert into public.hotels (id, name, slug, destination_id) values ($1, $2, $3, $4)",
      [id, `V2 Hotel ${index + 1}`, id, DEST],
    );
  }
  for (const [userId, id] of [
    [U.a, MAIL.a],
    [U.b, MAIL.b],
  ] as const) {
    await adminQuery(
      `insert into public.mail_accounts
         (id, user_id, provider, provider_account_subject, email_address, connection_state)
       values ($1, $2, 'gmail', $3, $4, 'pending_authorization')`,
      [id, userId, `subject-${id}`, `${id}@mail.t.local`],
    );
  }
}, 120_000);

afterAll(async () => {
  await teardownDatabase();
});

beforeEach(async () => {
  if (!hasTestDb) return;
  await clean();
});

d("D182 — overlap, display ids, and the Free slot", () => {
  it("rejects a second undated no-trip row and allows a different trip", async () => {
    const first = await save(U.a, HOTEL[0]!);
    expect(first.result).toBe("created");
    expect(first.display_ref).toBe("OP-1001");

    const repeat = await openOpp(U.a, HOTEL[0]!, null, null, null);
    expect(repeat.result).toBe("already_open");
    expect(repeat.pipeline_item_id).toBe(first.pipeline_item_id);

    const dated = await openOpp(U.a, HOTEL[0]!, null, "2026-11-12", "2026-11-15");
    expect(dated.result).toBe("overlap");

    const creator = await creatorId(U.a);
    await expect(
      adminQuery(
        `insert into public.pipeline_items (creator_id, hotel_id, status)
         values ($1, $2, 'saved')`,
        [creator, HOTEL[0]],
      ),
    ).rejects.toMatchObject({ code: "23P01" });

    const trip = await createTrip(U.a, "2026-11-12", "2026-11-19");
    expect(trip.result).toBe("created");
    const otherTrip = await openOpp(U.a, HOTEL[0]!, String(trip.trip_id), null, null);
    expect(otherTrip.result).toBe("created");
    expect(otherTrip.display_ref).toBe("OP-1002");

    const again = await save(U.a, HOTEL[0]!);
    expect(again.result).toBe("already_saved");
    expect(again.pipeline_item_id).toBe(first.pipeline_item_id);
    expect(again.display_ref).toBe("OP-1001");
  });

  it("allows back-to-back stays on one trip and rejects an overlap", async () => {
    const trip = await createTrip(U.a, "2026-11-12", "2026-11-19");
    const tripId = String(trip.trip_id);
    const first = await openOpp(U.a, HOTEL[1]!, tripId, "2026-11-12", "2026-11-15");
    expect(first.result).toBe("created");
    const next = await openOpp(U.a, HOTEL[1]!, tripId, "2026-11-15", "2026-11-19");
    expect(next.result).toBe("created");
    const overlap = await openOpp(U.a, HOTEL[1]!, tripId, "2026-11-14", "2026-11-16");
    expect(overlap.result).toBe("overlap");
    expect(overlap.pipeline_item_id).toBe(first.pipeline_item_id);

    const rows = await adminQuery<{ n: number }>(
      `select count(*)::int as n
         from public.pipeline_items pi
         join public.creator_profiles cp on cp.id = pi.creator_id
        where cp.user_id = $1 and pi.hotel_id = $2 and pi.status <> 'closed'`,
      [U.a, HOTEL[1]],
    );
    expect(rows[0]!.n).toBe(2);
  });

  it("lets a closed row be followed by a new undated opportunity", async () => {
    const first = await save(U.a, HOTEL[2]!);
    await adminQuery("update public.pipeline_items set status = 'closed' where id = $1", [
      first.pipeline_item_id,
    ]);
    const next = await openOpp(U.a, HOTEL[2]!, null, null, null);
    expect(next.result).toBe("created");
    expect(next.display_ref).toBe("OP-1002");
    expect(next.pipeline_item_id).not.toBe(first.pipeline_item_id);
  });

  it("assigns OP-1001 per creator and freezes the id", async () => {
    const a = await save(U.a, HOTEL[3]!);
    const b = await save(U.b, HOTEL[3]!);
    expect(a.display_ref).toBe("OP-1001");
    expect(b.display_ref).toBe("OP-1001");
    await expect(
      adminQuery("update public.pipeline_items set display_ref = 'OP-9999' where id = $1", [
        a.pipeline_item_id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
    const still = await adminQuery<{ display_ref: string }>(
      "select display_ref from public.pipeline_items where id = $1",
      [a.pipeline_item_id],
    );
    expect(still[0]!.display_ref).toBe("OP-1001");
  });

  it("does not spend a second Free slot on another opportunity for the same hotel", async () => {
    const first = await save(U.a, HOTEL[4]!, 1);
    expect(first.result).toBe("created");
    const trip = await createTrip(U.a, "2026-12-01", "2026-12-08");
    const second = await openOpp(
      U.a,
      HOTEL[4]!,
      String(trip.trip_id),
      "2026-12-01",
      "2026-12-04",
      null,
      1,
    );
    expect(second.result).toBe("created");
    const blocked = await save(U.a, HOTEL[5]!, 1);
    expect(blocked.result).toBe("limit_reached");
  });
});

d("D183 — nights and Gmail suggestions", () => {
  it("counts confirmed nights once and leaves pending nights out of confirmed", async () => {
    const trip = await createTrip(U.a, "2026-11-12", "2026-11-19");
    const tripId = String(trip.trip_id);
    expect(
      (await call("select public.add_trip_hotel($1,$2,$3) as r", [U.a, tripId, HOTEL[0]])).result,
    ).toBe("added");
    expect(
      (await call("select public.add_trip_hotel($1,$2,$3) as r", [U.a, tripId, HOTEL[1]])).result,
    ).toBe("added");
    expect(
      (
        await call("select public.set_trip_hotel_stay($1,$2,$3,$4::date,$5::date,$6) as r", [
          U.a,
          tripId,
          HOTEL[0],
          "2026-11-12",
          "2026-11-15",
          "confirmed",
        ])
      ).result,
    ).toBe("updated");
    expect(
      (
        await call("select public.set_trip_hotel_stay($1,$2,$3,$4::date,$5::date,$6) as r", [
          U.a,
          tripId,
          HOTEL[1],
          "2026-11-14",
          "2026-11-17",
          "pending",
        ])
      ).result,
    ).toBe("updated");

    const coverage = await call("select public.trip_night_coverage($1) as r", [tripId]);
    expect(coverage).toMatchObject({
      result: "ok",
      trip_nights: 7,
      confirmed_nights: 3,
      pending_nights: 2,
      gap_nights: 2,
    });
    const calendar = coverNights("2026-11-12", "2026-11-19", [
      { checkIn: "2026-11-12", checkOut: "2026-11-15", nightStatus: "confirmed" },
      { checkIn: "2026-11-14", checkOut: "2026-11-17", nightStatus: "pending" },
    ]);
    expect(calendar.tripNights).toBe(coverage.trip_nights);
    expect(calendar.confirmedNights).toBe(coverage.confirmed_nights);
    expect(calendar.pendingNights).toBe(coverage.pending_nights);
    expect(calendar.gapNights).toBe(coverage.gap_nights);
    expect(calendar.nights.map((night) => night.mark)).toEqual([
      "confirmed",
      "confirmed",
      "confirmed",
      "pending",
      "pending",
      "gap",
      "gap",
    ]);

    const sameDay = await createTrip(U.a, "2026-11-12", "2026-11-12");
    const zero = await call("select public.trip_night_coverage($1) as r", [sameDay.trip_id]);
    expect(zero).toMatchObject({
      result: "ok",
      trip_nights: 0,
      confirmed_nights: 0,
      pending_nights: 0,
      gap_nights: 0,
    });
  });

  it("stores a suggestion without changing dates, then accepts or rejects", async () => {
    const trip = await createTrip(U.a, "2026-11-12", "2026-11-19");
    const tripId = String(trip.trip_id);
    await call("select public.add_trip_hotel($1,$2,$3) as r", [U.a, tripId, HOTEL[0]]);
    const stay = await call(
      "select public.set_trip_hotel_stay($1,$2,$3,$4::date,$5::date,$6) as r",
      [U.a, tripId, HOTEL[0], "2026-11-12", "2026-11-15", "pending"],
    );
    const tripHotelId = String(stay.trip_hotel_id);

    const same = await call(
      "select public.propose_stay_date_suggestion($1,$2,null,$3::date,$4::date,$5,null) as r",
      [U.a, tripHotelId, "2026-11-12", "2026-11-15", MAIL.a],
    );
    expect(same.result).toBe("same_dates");

    const proposed = await call(
      "select public.propose_stay_date_suggestion($1,$2,null,$3::date,$4::date,$5,'gmail-ref') as r",
      [U.a, tripHotelId, "2026-11-15", "2026-11-19", MAIL.a],
    );
    expect(proposed.result).toBe("suggested");
    const unchanged = await adminQuery<{
      check_in: string;
      check_out: string;
      night_status: string;
    }>(
      "select check_in::text, check_out::text, night_status from public.trip_hotels where id = $1",
      [tripHotelId],
    );
    expect(unchanged[0]).toEqual({
      check_in: "2026-11-12",
      check_out: "2026-11-15",
      night_status: "pending",
    });

    const duplicate = await call(
      "select public.propose_stay_date_suggestion($1,$2,null,$3::date,$4::date,$5,null) as r",
      [U.a, tripHotelId, "2026-11-15", "2026-11-19", MAIL.a],
    );
    expect(duplicate.result).toBe("already_pending");

    const foreign = await call(
      "select public.propose_stay_date_suggestion($1,$2,null,$3::date,$4::date,$5,null) as r",
      [U.a, tripHotelId, "2026-11-16", "2026-11-18", MAIL.b],
    );
    expect(foreign.result).toBe("not_found");

    const accepted = await call("select public.accept_stay_date_suggestion($1,$2) as r", [
      U.a,
      proposed.suggestion_id,
    ]);
    expect(accepted).toMatchObject({ result: "accepted", night_status: "pending" });
    const after = await adminQuery<{ check_in: string; check_out: string }>(
      "select check_in::text, check_out::text from public.trip_hotels where id = $1",
      [tripHotelId],
    );
    expect(after[0]).toEqual({ check_in: "2026-11-15", check_out: "2026-11-19" });

    const later = await call(
      "select public.propose_stay_date_suggestion($1,$2,null,$3::date,$4::date,$5,null) as r",
      [U.a, tripHotelId, "2026-11-16", "2026-11-20", MAIL.a],
    );
    expect(later.result).toBe("suggested");
    const rejected = await call("select public.reject_stay_date_suggestion($1,$2) as r", [
      U.a,
      later.suggestion_id,
    ]);
    expect(rejected.result).toBe("rejected");
    const held = await adminQuery<{ check_in: string; check_out: string; status: string }>(
      `select th.check_in::text, th.check_out::text, s.status
         from public.trip_hotels th
         join public.stay_date_suggestions s on s.id = $2
        where th.id = $1`,
      [tripHotelId, later.suggestion_id],
    );
    expect(held[0]).toEqual({
      check_in: "2026-11-15",
      check_out: "2026-11-19",
      status: "rejected",
    });

    const stolen = await call("select public.accept_stay_date_suggestion($1,$2) as r", [
      U.b,
      proposed.suggestion_id,
    ]);
    expect(stolen.result).toBe("not_found");
    const hidden = await queryAs(
      { role: "authenticated", sub: U.b },
      "select id from public.stay_date_suggestions where id = $1",
      [proposed.suggestion_id],
    );
    expect(hidden.error).toBeNull();
    expect(hidden.rows).toEqual([]);
  });

  it("leaves an overlapping accept pending", async () => {
    const trip = await createTrip(U.a, "2026-11-12", "2026-11-19");
    const tripId = String(trip.trip_id);
    const first = await openOpp(U.a, HOTEL[2]!, tripId, "2026-11-12", "2026-11-15");
    const second = await openOpp(U.a, HOTEL[2]!, tripId, "2026-11-15", "2026-11-19");
    const proposed = await call(
      "select public.propose_stay_date_suggestion($1,null,$2,$3::date,$4::date,$5,null) as r",
      [U.a, second.pipeline_item_id, "2026-11-14", "2026-11-18", MAIL.a],
    );
    expect(proposed.result).toBe("suggested");
    const accepted = await call("select public.accept_stay_date_suggestion($1,$2) as r", [
      U.a,
      proposed.suggestion_id,
    ]);
    expect(accepted.result).toBe("overlap");
    const row = await adminQuery<{ stay_start: string; stay_end: string; status: string }>(
      `select pi.stay_start::text, pi.stay_end::text, s.status
         from public.pipeline_items pi
         join public.stay_date_suggestions s on s.id = $2
        where pi.id = $1`,
      [second.pipeline_item_id, proposed.suggestion_id],
    );
    expect(row[0]).toEqual({
      stay_start: "2026-11-15",
      stay_end: "2026-11-19",
      status: "pending",
    });
    expect(first.result).toBe("created");
  });
});

d("D184 — outreach campaigns", () => {
  it("copies a trip shortlist once and imports a hotel added later", async () => {
    const trip = await createTrip(U.a, "2026-11-12", "2026-11-19");
    const tripId = String(trip.trip_id);
    await call("select public.add_trip_hotel($1,$2,$3) as r", [U.a, tripId, HOTEL[0]]);
    await call("select public.add_trip_hotel($1,$2,$3) as r", [U.a, tripId, HOTEL[1]]);
    const opp = await openOpp(U.a, HOTEL[0]!, tripId, "2026-11-12", "2026-11-15");
    const created = await call("select public.create_outreach_initiative($1,$2,$3,null) as r", [
      U.a,
      "  November pitches  ",
      tripId,
    ]);
    expect(created.result).toBe("created");
    expect(created.hotel_count).toBe(2);
    const hiddenCampaign = await queryAs(
      { role: "authenticated", sub: U.b },
      "select id from public.outreach_initiatives where id = $1",
      [created.initiative_id],
    );
    expect(hiddenCampaign.error).toBeNull();
    expect(hiddenCampaign.rows).toEqual([]);
    const hiddenHotels = await queryAs(
      { role: "authenticated", sub: U.b },
      "select id from public.outreach_initiative_hotels where initiative_id = $1",
      [created.initiative_id],
    );
    expect(hiddenHotels.error).toBeNull();
    expect(hiddenHotels.rows).toEqual([]);

    const linked = await adminQuery<{ pipeline_item_id: string | null; source: string }>(
      `select pipeline_item_id, source
         from public.outreach_initiative_hotels
        where initiative_id = $1 and hotel_id = $2`,
      [created.initiative_id, HOTEL[0]],
    );
    expect(linked[0]).toEqual({ pipeline_item_id: opp.pipeline_item_id, source: "trip_shortlist" });

    await call("select public.add_trip_hotel($1,$2,$3) as r", [U.a, tripId, HOTEL[2]]);
    const still = await adminQuery<{ n: number }>(
      "select count(*)::int as n from public.outreach_initiative_hotels where initiative_id = $1",
      [created.initiative_id],
    );
    expect(still[0]!.n).toBe(2);

    const imported = await call("select public.import_outreach_shortlist($1,$2) as r", [
      U.a,
      created.initiative_id,
    ]);
    expect(imported).toMatchObject({ result: "imported", hotel_count: 1 });
    const added = await adminQuery<{ source: string }>(
      `select source from public.outreach_initiative_hotels
        where initiative_id = $1 and hotel_id = $2`,
      [created.initiative_id, HOTEL[2]],
    );
    expect(added[0]!.source).toBe("imported");

    const loose = await call("select public.create_outreach_initiative($1,$2,null,$3) as r", [
      U.a,
      "No trip",
      DEST,
    ]);
    expect(loose).toMatchObject({ result: "created", hotel_count: 0 });
    const before = await adminQuery<{ n: number }>(
      `select count(*)::int as n
         from public.pipeline_items pi
         join public.creator_profiles cp on cp.id = pi.creator_id
        where cp.user_id = $1`,
      [U.a],
    );
    const manual = await call("select public.add_outreach_hotel($1,$2,$3) as r", [
      U.a,
      loose.initiative_id,
      HOTEL[3],
    ]);
    expect(manual.result).toBe("added");
    const after = await adminQuery<{ n: number }>(
      `select count(*)::int as n
         from public.pipeline_items pi
         join public.creator_profiles cp on cp.id = pi.creator_id
        where cp.user_id = $1`,
      [U.a],
    );
    expect(after[0]!.n).toBe(before[0]!.n);

    const removed = await call("select public.delete_outreach_initiative($1,$2) as r", [
      U.a,
      created.initiative_id,
    ]);
    expect(removed.result).toBe("deleted");
    const kept = await adminQuery<{ outreach_initiative_id: string | null }>(
      "select outreach_initiative_id from public.pipeline_items where id = $1",
      [opp.pipeline_item_id],
    );
    expect(kept[0]!.outreach_initiative_id).toBeNull();

    await adminQuery("update public.pipeline_items set outreach_initiative_id = $2 where id = $1", [
      opp.pipeline_item_id,
      loose.initiative_id,
    ]);
    const otherTrip = await createTrip(U.a, "2026-12-01", "2026-12-08");
    const mismatched = await call("select public.create_outreach_initiative($1,$2,$3,null) as r", [
      U.a,
      "Other trip",
      otherTrip.trip_id,
    ]);
    await expect(
      adminQuery("update public.pipeline_items set outreach_initiative_id = $2 where id = $1", [
        opp.pipeline_item_id,
        mismatched.initiative_id,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});

d("D186 — revision requested", () => {
  it("stores revision_requested and leaves it off the deadline list", async () => {
    const saved = await save(U.a, HOTEL[0]!);
    const itemId = String(saved.pipeline_item_id);
    const yesterday = new Date(Date.now() - 86_400_000).toISOString();
    expect(
      (
        await call(
          "select public.transition_pipeline_item($1,$2,$3,$4,$5,null,null,null,50) as r",
          [U.a, itemId, "mark_pitched", yesterday, "email"],
        )
      ).result,
    ).toBe("applied");
    expect(
      (
        await call(
          "select public.transition_pipeline_item($1,$2,$3,$4,null,$5,null,null,50) as r",
          [U.a, itemId, "mark_replied", yesterday, "positive"],
        )
      ).result,
    ).toBe("applied");
    expect(
      (
        await call(
          "select public.progress_pipeline_deal($1,$2,'start_negotiation',null,null) as r",
          [U.a, itemId],
        )
      ).result,
    ).toBe("applied");
    expect(
      (
        await call("select public.progress_pipeline_deal($1,$2,'mark_won',$3,$4) as r", [
          U.a,
          itemId,
          yesterday,
          "stay",
        ])
      ).result,
    ).toBe("applied");

    const savedRow = await call(
      `select public.upsert_collaboration_deliverable(
         $1, $2, null, 'reel', 1, null, '2026-11-20'::date, 'revision_requested', null, null
       ) as r`,
      [U.a, itemId],
    );
    expect(savedRow.result).toBe("saved");
    const status = await adminQuery<{ status: string }>(
      "select status from public.collaboration_deliverables where id = $1",
      [savedRow.deliverable_id],
    );
    expect(status[0]!.status).toBe("revision_requested");

    const deadlines = await queryAs<{ r: { result: string; deliverables: { id: string }[] } }>(
      { role: "authenticated", sub: U.a },
      "select public.list_own_deliverable_deadlines(80) as r",
    );
    expect(deadlines.error).toBeNull();
    expect(deadlines.rows[0]!.r.result).toBe("ok");
    expect(deadlines.rows[0]!.r.deliverables.map((row) => row.id)).not.toContain(
      savedRow.deliverable_id,
    );
  });
});

d("D182 — client roles cannot write", () => {
  it("denies anon and authenticated execute, and hides the counter", async () => {
    const denied = await queryAs(
      { role: "anon" },
      "select public.open_pipeline_opportunity($1,$2,null,null,null,null,10)",
      [U.a, HOTEL[0]],
    );
    expect(denied.error?.message ?? "").toMatch(/permission denied/i);

    const authDenied = await queryAs(
      { role: "authenticated", sub: U.a },
      "select public.open_pipeline_opportunity($1,$2,null,null,null,null,10)",
      [U.a, HOTEL[0]],
    );
    expect(authDenied.error?.message ?? "").toMatch(/permission denied/i);

    const table = await queryAs({ role: "anon" }, "select id from public.stay_date_suggestions");
    expect(table.error?.message ?? "").toMatch(/permission denied/i);

    const counter = await queryAs(
      { role: "authenticated", sub: U.a },
      "select creator_id from public.pipeline_opportunity_counters",
    );
    expect(counter.error?.message ?? "").toMatch(/permission denied/i);

    const label = await queryAs<{ stage: string | null; kind: string }>(
      { role: "authenticated", sub: U.a },
      `select public.pipeline_stage_label('pitched') as stage,
              public.pipeline_status_kind('follow_up') as kind`,
    );
    expect(label.error).toBeNull();
    expect(label.rows[0]).toEqual({ stage: "Sent", kind: "event" });
  });
});

d("DEC-DEL — new creator rows die with the account", () => {
  it("erases A's opportunities, campaign, and suggestion and leaves B", async () => {
    const erase = "d2d15000-0000-0000-0000-000000000001";
    const keep = "d2d15000-0000-0000-0000-000000000002";
    await adminQuery("delete from auth.users where id = any($1::uuid[])", [[erase, keep]]);
    await adminQuery("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [
      erase,
      "erase-v2@t.local",
      keep,
      "keep-v2@t.local",
    ]);
    const mail = "d2d16000-0000-0000-0000-000000000001";
    await adminQuery(
      `insert into public.mail_accounts
         (id, user_id, provider, provider_account_subject, email_address, connection_state)
       values ($1, $2, 'gmail', $3, $4, 'pending_authorization')`,
      [mail, erase, `subject-${mail}`, "erase-v2@mail.t.local"],
    );

    const saved = await save(erase, HOTEL[0]!);
    const trip = await createTrip(erase, "2026-11-12", "2026-11-19");
    await call("select public.add_trip_hotel($1,$2,$3) as r", [erase, trip.trip_id, HOTEL[0]]);
    const stay = await call(
      "select public.set_trip_hotel_stay($1,$2,$3,$4::date,$5::date,$6) as r",
      [erase, trip.trip_id, HOTEL[0], "2026-11-12", "2026-11-15", "pending"],
    );
    await call(
      "select public.propose_stay_date_suggestion($1,$2,null,$3::date,$4::date,$5,null) as r",
      [erase, stay.trip_hotel_id, "2026-11-16", "2026-11-19", mail],
    );
    await call("select public.create_outreach_initiative($1,$2,$3,null) as r", [
      erase,
      "Erase me",
      trip.trip_id,
    ]);
    const kept = await save(keep, HOTEL[1]!);
    expect(kept.display_ref).toBe("OP-1001");

    const committed = await commitAs<{ r: { result: string } }>(
      { role: "authenticated", sub: erase },
      "select public.request_own_account_deletion('DELETE') as r",
    );
    expect(committed.rows[0]!.r.result).toBe("scheduled");
    await adminQuery(
      `update public.users
          set deletion_requested_at = now() - interval '30 days',
              delete_after = now() - interval '1 second'
        where id = $1`,
      [erase],
    );
    const erased = await call("select public.erase_creator_account($1) as r", [erase]);
    expect(erased.result).toBe("erased");

    const left = await adminQuery<{ n: number }>(
      `select (
         (select count(*) from public.users where id = $1)
         + (select count(*) from public.creator_profiles where user_id = $1)
         + (select count(*) from public.stay_date_suggestions where owner_user_id = $1)
         + (select count(*) from public.mail_accounts where user_id = $1)
       )::int as n`,
      [erase],
    );
    expect(left[0]!.n).toBe(0);
    const survivor = await adminQuery<{ display_ref: string }>(
      "select display_ref from public.pipeline_items where id = $1",
      [kept.pipeline_item_id],
    );
    expect(survivor[0]!.display_ref).toBe("OP-1001");
    expect(saved.result).toBe("created");
  });
});
