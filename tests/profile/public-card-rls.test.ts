/**
 * D096–D097. read_public_creator_card is null when the profile is missing
 * or private. A public card has counts and no hotel name, contact, or amount.
 * User B's rows do not change User A's counts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const USER_A = "a0960000-0000-4000-8000-000000000001";
const USER_B = "a0960000-0000-4000-8000-000000000002";
const DEST = "a0960000-0000-4000-8000-0000000000d1";
const HOTEL_A = "a0960000-0000-4000-8000-0000000000a1";
const HOTEL_B = "a0960000-0000-4000-8000-0000000000b1";

let creatorA = "";
let creatorB = "";

async function card(username: string) {
  return queryAs<{ r: Record<string, unknown> | null }>(
    { role: "anon" },
    "select public.read_public_creator_card($1) as r",
    [username],
  );
}

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  await adminQuery("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [
    USER_A,
    "card-secret-a@test.local",
    USER_B,
    "card-secret-b@test.local",
  ]);
  await adminQuery(
    `insert into public.destinations (id, name, slug, type) values ($1, 'Card Bay', 'card-bay', 'city')`,
    [DEST],
  );
  await adminQuery(
    `insert into public.hotels (id, name, slug, destination_id) values
       ($1, 'Casa Secreta A', 'casa-secreta-a', $3),
       ($2, 'Casa Secreta B', 'casa-secreta-b', $3)`,
    [HOTEL_A, HOTEL_B, DEST],
  );
  await adminQuery(
    `insert into public.hotel_contacts (hotel_id, first_name, email) values
       ($1, 'Ana', 'secreta-a@hotel.example'),
       ($2, 'Bea', 'secreta-b@hotel.example')`,
    [HOTEL_A, HOTEL_B],
  );
  const profiles = await adminQuery<{ user_id: string; id: string }>(
    "select user_id, id from public.creator_profiles where user_id = any($1::uuid[])",
    [[USER_A, USER_B]],
  );
  creatorA = profiles.find((row) => row.user_id === USER_A)?.id ?? "";
  creatorB = profiles.find((row) => row.user_id === USER_B)?.id ?? "";
  expect(creatorA).not.toBe("");
  expect(creatorB).not.toBe("");

  await adminQuery(
    `update public.creator_profiles
        set username = 'ada_public',
            display_name = 'Ada Public',
            bio = 'Travel notes',
            public_profile_enabled = false
      where id = $1`,
    [creatorA],
  );
  await adminQuery(
    `update public.creator_profiles
        set username = 'bea_public',
            display_name = 'Bea Hidden',
            public_profile_enabled = true
      where id = $1`,
    [creatorB],
  );

  const itemA = (
    await adminQuery<{ id: string }>(
      `insert into public.pipeline_items (creator_id, hotel_id, private_notes)
       values ($1, $2, 'nota privada A') returning id`,
      [creatorA, HOTEL_A],
    )
  )[0]!.id;
  const itemB = (
    await adminQuery<{ id: string }>(
      `insert into public.pipeline_items (creator_id, hotel_id, private_notes)
       values ($1, $2, 'nota privada B') returning id`,
      [creatorB, HOTEL_B],
    )
  )[0]!.id;

  await adminQuery(
    `insert into public.outreach_events
       (creator_id, hotel_id, pipeline_item_id, event_type, event_at, source)
     values
       ($1, $2, $3, 'pitch_sent', now(), 'manual_creator'),
       ($1, $2, $3, 'reply_received', now(), 'manual_creator'),
       ($4, $5, $6, 'pitch_sent', now(), 'manual_creator'),
       ($4, $5, $6, 'reply_received', now(), 'manual_creator')`,
    [creatorA, HOTEL_A, itemA, creatorB, HOTEL_B, itemB],
  );

  const collA = (
    await adminQuery<{ id: string }>(
      `insert into public.collaborations
         (creator_id, hotel_id, pipeline_item_id, status, collaboration_type, end_date,
          terms_matched, private_value_amount, private_value_currency)
       values ($1, $2, $3, 'completed', 'stay', '2026-04-02', 'unknown', 99999, 'USD')
       returning id`,
      [creatorA, HOTEL_A, itemA],
    )
  )[0]!.id;
  await adminQuery(
    `insert into public.collaborations
       (creator_id, hotel_id, pipeline_item_id, status, collaboration_type, end_date, terms_matched)
     values ($1, $2, $3, 'completed', 'stay', '2026-05-02', 'unknown')`,
    [creatorB, HOTEL_B, itemB],
  );
  await adminQuery(
    `insert into public.collaboration_deliverables
       (creator_id, collaboration_id, pipeline_item_id, deliverable_type, quantity, status)
     values ($1, $2, $3, 'reel', 1, 'approved')`,
    [creatorA, collA, itemA],
  );
}, 120_000);

afterAll(async () => {
  await teardownDatabase();
});

d("read_public_creator_card", () => {
  it("is null for a private profile and for a username that does not exist", async () => {
    const privateCard = await card("ada_public");
    expect(privateCard.error).toBeNull();
    expect(privateCard.rows[0]?.r).toBeNull();

    const missing = await card("nobody_here");
    expect(missing.error).toBeNull();
    expect(missing.rows[0]?.r).toBeNull();

    const short = await card("ab");
    expect(short.rows[0]?.r).toBeNull();
  });

  it("a public card has A's counts and no hotel, contact, amount, or B's name", async () => {
    await adminQuery(
      "update public.creator_profiles set public_profile_enabled = true where id = $1",
      [creatorA],
    );
    const loaded = await card("Ada_Public");
    expect(loaded.error).toBeNull();
    const body = loaded.rows[0]?.r;
    expect(body).not.toBeNull();
    expect(body?.username).toBe("ada_public");
    expect(body?.outreach).toBe(1);
    expect(body?.replies).toBe(1);
    expect(body?.agreements).toBe(1);
    expect(body?.completed_collaborations).toBe(1);
    expect(body?.deliverables_done).toBe(1);
    const packed = JSON.stringify(body);
    expect(packed).not.toContain("Casa Secreta");
    expect(packed).not.toContain("secreta-");
    expect(packed).not.toContain("99999");
    expect(packed).not.toContain("nota privada");
    expect(packed).not.toContain("Bea Hidden");
    expect(packed).not.toContain("card-secret");
    expect(packed).not.toContain("%");
    expect(packed).not.toContain("past_collaboration");
  });

  it("another signed-in creator gets the same public card and not the private notes", async () => {
    const asB = await queryAs<{ r: Record<string, unknown> | null }>(
      { role: "authenticated", sub: USER_B },
      "select public.read_public_creator_card($1) as r",
      ["ada_public"],
    );
    expect(asB.error).toBeNull();
    expect(asB.rows[0]?.r?.outreach).toBe(1);
    expect(JSON.stringify(asB.rows[0]?.r)).not.toContain("nota privada");
  });
});
