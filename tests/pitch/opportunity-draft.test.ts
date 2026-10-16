/**
 * A pitch draft belongs to one opportunity.
 * Backfill assigns it only when that hotel has exactly one open row.
 * The guard refuses to move it onto a second opportunity or another creator.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, setupDatabase, teardownDatabase } from "../db/harness";

const migration = readFileSync(
  path.join(process.cwd(), "supabase/migrations/0098_pitch_draft_opportunity.sql"),
  "utf8",
);

describe("pitch draft opportunity migration", () => {
  it("assigns a draft only when one open opportunity exists", () => {
    expect(migration).toMatch(/having count\(\*\) = 1/);
    expect(migration).toMatch(/status <> 'closed'/);
    expect(migration).toMatch(/pitch draft opportunity cannot change/);
    expect(migration).toMatch(/same creator and hotel/);
    expect(migration).not.toMatch(/order by updated_at[\s\S]{0,80}limit 1/i);
  });
});

const d = describe.skipIf(!hasTestDb);

const USER_A = "00980000-0000-4000-8000-00000000000a";
const USER_B = "00980000-0000-4000-8000-00000000000b";
const DEST = "00980000-0000-4000-8000-0000000000d1";
const HOTEL = "00980000-0000-4000-8000-0000000000a1";

const BACKFILL = `
  update public.pitch_drafts as draft
     set pipeline_item_id = only_one.id
    from (
      select pipeline.creator_id,
             pipeline.hotel_id,
             (array_agg(pipeline.id))[1] as id
        from public.pipeline_items as pipeline
       where pipeline.status <> 'closed'
       group by pipeline.creator_id, pipeline.hotel_id
      having count(*) = 1
    ) as only_one
   where draft.creator_id = only_one.creator_id
     and draft.hotel_id = only_one.hotel_id
     and draft.pipeline_item_id is null
`;

d("pitch draft stays on its opportunity", () => {
  let creatorA = "";
  let creatorB = "";

  beforeAll(async () => {
    await setupDatabase();
    await adminQuery("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [
      USER_A,
      "opp-a@test.local",
      USER_B,
      "opp-b@test.local",
    ]);
    await adminQuery(
      `insert into public.destinations (id, name, slug, type) values ($1, 'Opp Bay', 'opp-bay', 'city')`,
      [DEST],
    );
    await adminQuery(
      `insert into public.hotels (id, name, slug, destination_id) values ($1, 'Opp House', 'opp-house', $2)`,
      [HOTEL, DEST],
    );
    const profiles = await adminQuery<{ user_id: string; id: string }>(
      "select user_id, id from public.creator_profiles where user_id = any($1::uuid[])",
      [[USER_A, USER_B]],
    );
    creatorA = profiles.find((row) => row.user_id === USER_A)?.id ?? "";
    creatorB = profiles.find((row) => row.user_id === USER_B)?.id ?? "";
  }, 120_000);

  afterAll(async () => {
    await teardownDatabase();
  });

  it("backfills the single open opportunity and leaves two unassigned", async () => {
    const trip = await adminQuery<{ id: string }>(
      `insert into public.trips (creator_id, destination_id, name, start_date, end_date)
       values ($1, $2, 'One', '2026-11-01', '2026-11-08') returning id`,
      [creatorA, DEST],
    );
    const only = await adminQuery<{ id: string }>(
      `insert into public.pipeline_items (creator_id, hotel_id, trip_id, status)
       values ($1, $2, $3, 'saved') returning id`,
      [creatorA, HOTEL, trip[0]!.id],
    );
    const draft = await adminQuery<{ id: string }>(
      `insert into public.pitch_drafts (creator_id, hotel_id, subject, body)
       values ($1, $2, 'Solo', 'Only one opportunity') returning id`,
      [creatorA, HOTEL],
    );
    await adminQuery(BACKFILL);
    const bound = await adminQuery<{ pipeline_item_id: string | null }>(
      "select pipeline_item_id from public.pitch_drafts where id = $1",
      [draft[0]!.id],
    );
    expect(bound[0]?.pipeline_item_id).toBe(only[0]!.id);

    const secondTrip = await adminQuery<{ id: string }>(
      `insert into public.trips (creator_id, destination_id, name, start_date, end_date)
       values ($1, $2, 'Two', '2026-12-01', '2026-12-08') returning id`,
      [creatorA, DEST],
    );
    const other = await adminQuery<{ id: string }>(
      `insert into public.pipeline_items (creator_id, hotel_id, trip_id, status)
       values ($1, $2, $3, 'planned') returning id`,
      [creatorA, HOTEL, secondTrip[0]!.id],
    );
    const ambiguous = await adminQuery<{ id: string }>(
      `insert into public.pitch_drafts (creator_id, hotel_id, subject, body)
       values ($1, $2, 'Which', 'Do not guess') returning id`,
      [creatorA, HOTEL],
    );
    await adminQuery(BACKFILL);
    const still = await adminQuery<{ pipeline_item_id: string | null }>(
      "select pipeline_item_id from public.pitch_drafts where id = $1",
      [ambiguous[0]!.id],
    );
    expect(still[0]?.pipeline_item_id).toBeNull();

    const moved = adminQuery("update public.pitch_drafts set pipeline_item_id = $2 where id = $1", [
      draft[0]!.id,
      other[0]!.id,
    ]);
    await expect(moved).rejects.toMatchObject({ code: "23514" });
    const kept = await adminQuery<{ pipeline_item_id: string }>(
      "select pipeline_item_id from public.pitch_drafts where id = $1",
      [draft[0]!.id],
    );
    expect(kept[0]?.pipeline_item_id).toBe(only[0]!.id);

    const foreign = await adminQuery<{ id: string }>(
      `insert into public.pipeline_items (creator_id, hotel_id, status)
       values ($1, $2, 'saved') returning id`,
      [creatorB, HOTEL],
    );
    const stolen = adminQuery(
      `insert into public.pitch_drafts (creator_id, hotel_id, pipeline_item_id, subject, body)
       values ($1, $2, $3, 'No', 'Not B')`,
      [creatorA, HOTEL, foreign[0]!.id],
    );
    await expect(stolen).rejects.toMatchObject({ code: "23514" });
  });
});
