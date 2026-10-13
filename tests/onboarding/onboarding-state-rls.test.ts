/**
 * D095. creator_onboarding_state is owner-only. User A cannot read or write
 * User B's destination. Anon has no privilege. Updating the dismissal does
 * not clear the destination.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { adminQuery, hasTestDb, queryAs, setupDatabase, teardownDatabase } from "../db/harness";

const d = describe.skipIf(!hasTestDb);

const USER_A = "a0950000-0000-4000-8000-000000000001";
const USER_B = "a0950000-0000-4000-8000-000000000002";
const DEST = "a0950000-0000-4000-8000-0000000000d1";

let creatorA = "";
let creatorB = "";

beforeAll(async () => {
  if (!hasTestDb) return;
  await setupDatabase();
  await adminQuery("insert into auth.users (id, email) values ($1, $2), ($3, $4)", [
    USER_A,
    "onboard-a@test.local",
    USER_B,
    "onboard-b@test.local",
  ]);
  await adminQuery(
    `insert into public.destinations (id, name, slug, type) values ($1, 'Ada Bay', 'ada-bay', 'city')`,
    [DEST],
  );
  const rows = await adminQuery<{ user_id: string; id: string }>(
    "select user_id, id from public.creator_profiles where user_id = any($1::uuid[])",
    [[USER_A, USER_B]],
  );
  creatorA = rows.find((row) => row.user_id === USER_A)?.id ?? "";
  creatorB = rows.find((row) => row.user_id === USER_B)?.id ?? "";
  expect(creatorA).not.toBe("");
  expect(creatorB).not.toBe("");
  await adminQuery(
    `insert into public.creator_onboarding_state (creator_id, destination_id)
     values ($1, $2), ($3, null)`,
    [creatorA, DEST, creatorB],
  );
}, 120_000);

afterAll(async () => {
  await teardownDatabase();
});

d("creator_onboarding_state", () => {
  it("A reads A's destination and not B's", async () => {
    const rows = await queryAs<{ creator_id: string; destination_id: string | null }>(
      { role: "authenticated", sub: USER_A },
      "select creator_id, destination_id from public.creator_onboarding_state",
    );
    expect(rows.error).toBeNull();
    expect(rows.rows.map((row) => row.creator_id)).toEqual([creatorA]);
    expect(rows.rows[0]?.destination_id).toBe(DEST);
  });

  it("anon cannot read the table", async () => {
    const rows = await queryAs(
      { role: "anon" },
      "select creator_id from public.creator_onboarding_state",
    );
    expect(rows.error).not.toBeNull();
    expect(rows.rows).toEqual([]);
  });

  it("A cannot insert a row for B", async () => {
    const rows = await queryAs(
      { role: "authenticated", sub: USER_A },
      `insert into public.creator_onboarding_state (creator_id, destination_id)
       values ($1, $2)`,
      [creatorB, DEST],
    );
    expect(rows.error).not.toBeNull();
  });

  it("setting the dismissal leaves the destination in place", async () => {
    const rows = await queryAs<{ destination_id: string | null; checklist_dismissed_at: string | null }>(
      { role: "authenticated", sub: USER_A },
      `update public.creator_onboarding_state
          set checklist_dismissed_at = now()
        where creator_id = $1
        returning destination_id, checklist_dismissed_at`,
      [creatorA],
    );
    expect(rows.error).toBeNull();
    expect(rows.rows[0]?.destination_id).toBe(DEST);
    expect(rows.rows[0]?.checklist_dismissed_at).not.toBeNull();
  });
});
